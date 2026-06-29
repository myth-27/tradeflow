/**
 * TradeFlow V3 — Feature Importance Model (Phase 6)
 *
 * Determines WHICH variables actually predict profitability.
 * Uses permutation importance: shuffle each feature, measure
 * prediction degradation.
 */

import { getDB, type FeatureImportanceRecord, type SignalMemoryRecord } from './db';
import { getAllSignalsWithOutcomes } from './signal-memory';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FeatureRanking {
  feature: string;
  importance: number;    // 0-100 percentage
  correlation: number;   // raw correlation with outcome
  description: string;   // human-readable label
}

// ─── Feature Importance Calculation ───────────────────────────────────────────

/** Calculate feature importance rankings */
export async function calculateFeatureImportance(): Promise<FeatureRanking[]> {
  const signals = await getAllSignalsWithOutcomes();
  if (signals.length < 30) return getDefaultRankings();

  const outcomes = signals.map(s => s.rMultiple ?? 0);

  // Define extractable features
  const featureExtractors: Record<string, { extract: (s: SignalMemoryRecord) => number; label: string }> = {
    regime: { extract: s => regimeToNum(s.regime), label: 'Market Regime' },
    edgeScore: { extract: s => s.edgeScore, label: 'Edge Score' },
    volumeRatio: { extract: s => s.volumeRatio, label: 'Volume' },
    patternScore: { extract: s => s.patternScore, label: 'Pattern Quality' },
    rsi: { extract: s => s.rsi, label: 'RSI' },
    macd: { extract: s => Math.abs(s.macd), label: 'MACD' },
    atr: { extract: s => s.atr, label: 'ATR' },
    tradeScore: { extract: s => s.tradeScore, label: 'Trade Score' },
    session: { extract: s => sessionToNum(s.session), label: 'Session' },
  };

  // Add order flow features if we have data
  const hasOI = signals.some(s => s.openInterest !== null);
  if (hasOI) {
    featureExtractors.openInterest = { extract: s => s.openInterest ?? 0, label: 'Open Interest' };
    featureExtractors.fundingRate = { extract: s => s.fundingRate ?? 0, label: 'Funding Rate' };
    featureExtractors.cvd = { extract: s => s.cvd ?? 0, label: 'CVD' };
  }

  // Calculate absolute correlation for each feature
  const rankings: FeatureRanking[] = [];
  let totalImportance = 0;

  for (const [name, { extract, label }] of Object.entries(featureExtractors)) {
    const values = signals.map(extract);
    const corr = Math.abs(pearsonCorrelation(values, outcomes));

    // Also calculate permutation importance
    const baseAccuracy = simpleAccuracy(signals.map(extract), outcomes);
    const shuffled = shuffle([...values]);
    const permutedAccuracy = simpleAccuracy(shuffled, outcomes);
    const importanceDrop = Math.max(0, baseAccuracy - permutedAccuracy);

    // Combined importance: correlation + permutation importance
    const rawImportance = (corr * 0.6 + importanceDrop * 0.4) * 100;
    totalImportance += rawImportance;

    rankings.push({
      feature: name,
      importance: rawImportance,
      correlation: corr,
      description: label,
    });
  }

  // Normalize to percentages summing to 100
  if (totalImportance > 0) {
    for (const r of rankings) {
      r.importance = Math.round((r.importance / totalImportance) * 100);
    }
  }

  // Sort by importance descending
  rankings.sort((a, b) => b.importance - a.importance);

  // Persist
  const db = getDB();
  const record: FeatureImportanceRecord = {
    timestamp: Date.now(),
    rankings: JSON.stringify(rankings),
    totalSamplesUsed: signals.length,
    method: 'permutation_correlation',
  };
  await db.featureImportance.add(record);

  return rankings;
}

/** Get the latest feature importance rankings */
export async function getLatestImportance(): Promise<FeatureRanking[]> {
  const db = getDB();
  const latest = await db.featureImportance
    .orderBy('timestamp')
    .reverse()
    .first();

  if (!latest) return getDefaultRankings();

  try { return JSON.parse(latest.rankings) as FeatureRanking[]; }
  catch { return getDefaultRankings(); }
}

/** Get importance history for trend analysis */
export async function getImportanceHistory(): Promise<FeatureImportanceRecord[]> {
  return await getDB().featureImportance
    .orderBy('timestamp')
    .toArray();
}

// ─── Default Rankings ─────────────────────────────────────────────────────────

function getDefaultRankings(): FeatureRanking[] {
  return [
    { feature: 'regime', importance: 28, correlation: 0, description: 'Market Regime' },
    { feature: 'openInterest', importance: 24, correlation: 0, description: 'Open Interest' },
    { feature: 'volumeRatio', importance: 18, correlation: 0, description: 'Volume' },
    { feature: 'edgeScore', importance: 15, correlation: 0, description: 'Historical Similarity' },
    { feature: 'fundingRate', importance: 8, correlation: 0, description: 'Funding Rate' },
    { feature: 'rsi', importance: 4, correlation: 0, description: 'RSI' },
    { feature: 'macd', importance: 3, correlation: 0, description: 'MACD' },
  ];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function regimeToNum(regime: string): number {
  const map: Record<string, number> = {
    strong_uptrend: 5, weak_uptrend: 4, ranging: 3,
    low_volatility: 2, weak_downtrend: 1, strong_downtrend: 0,
  };
  return map[regime] ?? 3;
}

function sessionToNum(session: string): number {
  const map: Record<string, number> = {
    overlap: 4, new_york: 3, london: 2, asia: 1,
  };
  return map[session] ?? 2;
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

/** Simple "accuracy" measure: correlation between raw feature and direction of outcome */
function simpleAccuracy(features: number[], outcomes: number[]): number {
  let correct = 0;
  const medianF = median(features);
  for (let i = 0; i < features.length; i++) {
    const highFeature = features[i] > medianF;
    const goodOutcome = outcomes[i] > 0;
    if (highFeature === goodOutcome) correct++;
  }
  return features.length > 0 ? correct / features.length : 0.5;
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
