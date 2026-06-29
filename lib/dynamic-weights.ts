/**
 * TradeFlow V3 — Dynamic Weights (Phase 5)
 *
 * NO STATIC WEIGHTS. Every 100 trades, recalculate the importance
 * of each feature based on actual correlation with trade outcomes.
 * Weights evolve as the market changes.
 */

import { getDB, type FeatureWeightsRecord } from './db';
import { getAllSignalsWithOutcomes } from './signal-memory';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DynamicWeights {
  volume: number;
  rsi: number;
  macd: number;
  atr: number;
  openInterest: number;
  fundingRate: number;
  cvd: number;
  regime: number;
  session: number;
  historicalSimilarity: number;
  patternQuality: number;
  momentum: number;
  lastUpdated: number;
  tradesSinceUpdate: number;
}

// Default weights — starting point before any learning
const DEFAULT_WEIGHTS: DynamicWeights = {
  volume: 10,
  rsi: 10,
  macd: 8,
  atr: 5,
  openInterest: 12,
  fundingRate: 8,
  cvd: 10,
  regime: 20,
  session: 12,
  historicalSimilarity: 40,
  patternQuality: 10,
  momentum: 5,
  lastUpdated: 0,
  tradesSinceUpdate: 0,
};

const RECALCULATE_INTERVAL = 100; // trades

// ─── Weight Management ────────────────────────────────────────────────────────

/** Get the current dynamic weights */
export async function getCurrentWeights(): Promise<DynamicWeights> {
  const db = getDB();
  const latest = await db.featureWeights
    .orderBy('timestamp')
    .reverse()
    .first();

  if (!latest) return { ...DEFAULT_WEIGHTS };

  return {
    volume: latest.volume,
    rsi: latest.rsi,
    macd: latest.macd,
    atr: latest.atr,
    openInterest: latest.openInterest,
    fundingRate: latest.fundingRate,
    cvd: latest.cvd,
    regime: latest.regime,
    session: latest.session,
    historicalSimilarity: latest.historicalSimilarity,
    patternQuality: latest.patternQuality,
    momentum: latest.momentum,
    lastUpdated: latest.timestamp,
    tradesSinceUpdate: latest.tradesSinceLastUpdate,
  };
}

/** Check if weights need recalculation */
export async function shouldRecalculateWeights(): Promise<boolean> {
  const db = getDB();
  const latest = await db.featureWeights
    .orderBy('timestamp')
    .reverse()
    .first();

  const totalSignals = await db.signalMemory
    .where('result')
    .notEqual('')
    .count();

  if (!latest) return totalSignals >= RECALCULATE_INTERVAL;
  return totalSignals >= latest.tradesSinceLastUpdate + RECALCULATE_INTERVAL;
}

/** Recalculate all weights based on feature-outcome correlations */
export async function recalculateWeights(): Promise<DynamicWeights> {
  const signals = await getAllSignalsWithOutcomes();
  if (signals.length < 30) return { ...DEFAULT_WEIGHTS };

  const outcomes = signals.map(s => s.rMultiple ?? 0);

  // Extract each feature column
  const featureArrays: Record<string, number[]> = {
    volume: signals.map(s => s.volumeRatio),
    rsi: signals.map(s => s.rsi),
    macd: signals.map(s => Math.abs(s.macd)),
    atr: signals.map(s => s.atr),
    edgeScore: signals.map(s => s.edgeScore),
    patternScore: signals.map(s => s.patternScore),
  };

  // Calculate correlation of each feature with R-multiple outcomes
  const correlations: Record<string, number> = {};
  for (const [name, values] of Object.entries(featureArrays)) {
    correlations[name] = Math.abs(pearsonCorrelation(values, outcomes));
  }

  // Normalize correlations to weights (sum to ~140 total)
  const totalCorr = Object.values(correlations).reduce((a, b) => a + b, 0) || 1;
  const scale = 140 / totalCorr;

  const newWeights: DynamicWeights = {
    volume: clampWeight(correlations.volume * scale || DEFAULT_WEIGHTS.volume),
    rsi: clampWeight(correlations.rsi * scale || DEFAULT_WEIGHTS.rsi),
    macd: clampWeight(correlations.macd * scale || DEFAULT_WEIGHTS.macd),
    atr: clampWeight(correlations.atr * scale || DEFAULT_WEIGHTS.atr),
    openInterest: DEFAULT_WEIGHTS.openInterest, // Need OI data to correlate
    fundingRate: DEFAULT_WEIGHTS.fundingRate,
    cvd: DEFAULT_WEIGHTS.cvd,
    regime: DEFAULT_WEIGHTS.regime, // Regime correlation tracked separately
    session: DEFAULT_WEIGHTS.session,
    historicalSimilarity: clampWeight(correlations.edgeScore * scale || DEFAULT_WEIGHTS.historicalSimilarity),
    patternQuality: clampWeight(correlations.patternScore * scale || DEFAULT_WEIGHTS.patternQuality),
    momentum: DEFAULT_WEIGHTS.momentum,
    lastUpdated: Date.now(),
    tradesSinceUpdate: signals.length,
  };

  // Persist to database
  const db = getDB();
  const record: FeatureWeightsRecord = {
    timestamp: Date.now(),
    tradesSinceLastUpdate: signals.length,
    volume: newWeights.volume,
    rsi: newWeights.rsi,
    macd: newWeights.macd,
    atr: newWeights.atr,
    openInterest: newWeights.openInterest,
    fundingRate: newWeights.fundingRate,
    cvd: newWeights.cvd,
    regime: newWeights.regime,
    session: newWeights.session,
    historicalSimilarity: newWeights.historicalSimilarity,
    patternQuality: newWeights.patternQuality,
    momentum: newWeights.momentum,
    reason: `Auto-recalculation at ${signals.length} trades`,
  };
  await db.featureWeights.add(record);

  return newWeights;
}

/** Get the history of weight changes over time */
export async function getWeightHistory(): Promise<FeatureWeightsRecord[]> {
  const db = getDB();
  return await db.featureWeights
    .orderBy('timestamp')
    .toArray();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clampWeight(w: number): number {
  return Math.round(Math.max(1, Math.min(50, w)) * 10) / 10;
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]; sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] ** 2; sumY2 += y[i] ** 2;
  }
  const denom = Math.sqrt((n * sumX2 - sumX ** 2) * (n * sumY2 - sumY ** 2));
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}
