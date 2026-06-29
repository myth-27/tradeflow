/**
 * TradeFlow V3 — Self-Learning Engine (Phase 4)
 *
 * After every 50 closed trades, discovers:
 *   - What is working
 *   - What is failing
 *   - What is improving
 *   - What is degrading
 *
 * Automatically adjusts weights and pattern scores.
 */

import { getDB, type LearningSnapshotRecord, type SignalMemoryRecord } from './db';
import { getAllSignalsWithOutcomes } from './signal-memory';
import { getPatternRankings, getRegimeRankings, getSessionRankings } from './edge-database';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LearningFinding {
  category: 'working' | 'failing' | 'improving' | 'degrading';
  description: string;
  metric: string;
  currentValue: number;
  previousValue: number | null;
  significance: 'high' | 'medium' | 'low';
}

export interface WeightAdjustment {
  feature: string;
  previousWeight: number;
  newWeight: number;
  reason: string;
}

export interface PatternAdjustment {
  pattern: string;
  previousMultiplier: number;
  newMultiplier: number;
  reason: string;
}

export interface PerformanceDelta {
  overallWinRate: { current: number; previous: number };
  overallExpectancy: { current: number; previous: number };
  overallProfitFactor: { current: number; previous: number };
  bestPattern: string;
  worstPattern: string;
  bestRegime: string;
  worstRegime: string;
  bestSession: string;
  worstSession: string;
}

export interface LearningResult {
  findings: LearningFinding[];
  weightAdjustments: WeightAdjustment[];
  patternAdjustments: PatternAdjustment[];
  performanceDelta: PerformanceDelta;
  totalTradesAnalyzed: number;
}

// ─── Learning Engine ──────────────────────────────────────────────────────────

const LEARNING_CYCLE_TRADES = 50;
let _lastLearningTradeCount = 0;

/** Check if a learning cycle should run */
export async function shouldRunLearning(): Promise<boolean> {
  const db = getDB();
  const totalWithOutcomes = await db.signalMemory
    .where('result')
    .notEqual('')
    .count();

  return totalWithOutcomes >= _lastLearningTradeCount + LEARNING_CYCLE_TRADES;
}

/** Run the full learning cycle */
export async function runLearningCycle(
  triggerReason: string = '50_trade_cycle',
): Promise<LearningResult> {
  const signals = await getAllSignalsWithOutcomes();
  const previousSnapshot = await getLastSnapshot();

  // Split into recent and historical for trend detection
  const recentCutoff = signals.length > 100 ? signals.length - 50 : Math.floor(signals.length / 2);
  const recent = signals.slice(recentCutoff);
  const historical = signals.slice(0, recentCutoff);

  const findings: LearningFinding[] = [];
  const weightAdjustments: WeightAdjustment[] = [];
  const patternAdjustments: PatternAdjustment[] = [];

  // ── Analyze patterns ────────────────────────────────────────────
  const patternRankings = await getPatternRankings();
  const regimeRankings = await getRegimeRankings();
  const sessionRankings = await getSessionRankings();

  // Pattern analysis
  for (const ranking of patternRankings) {
    if (ranking.totalTrades < 10) continue;

    const recentPatternSignals = recent.filter(s => s.pattern === ranking.pattern);
    const histPatternSignals = historical.filter(s => s.pattern === ranking.pattern);

    if (recentPatternSignals.length >= 5 && histPatternSignals.length >= 5) {
      const recentWR = calcWinRate(recentPatternSignals);
      const histWR = calcWinRate(histPatternSignals);
      const recentExpectancy = calcExpectancy(recentPatternSignals);
      const histExpectancy = calcExpectancy(histPatternSignals);

      if (recentWR > histWR + 10) {
        findings.push({
          category: 'improving',
          description: `${ranking.pattern} win rate improving: ${histWR.toFixed(0)}% → ${recentWR.toFixed(0)}%`,
          metric: 'winRate',
          currentValue: recentWR,
          previousValue: histWR,
          significance: recentWR - histWR > 20 ? 'high' : 'medium',
        });
      } else if (recentWR < histWR - 10) {
        findings.push({
          category: 'degrading',
          description: `${ranking.pattern} win rate degrading: ${histWR.toFixed(0)}% → ${recentWR.toFixed(0)}%`,
          metric: 'winRate',
          currentValue: recentWR,
          previousValue: histWR,
          significance: histWR - recentWR > 20 ? 'high' : 'medium',
        });
      }

      // Pattern adjustment based on recent performance
      if (recentExpectancy > 0.5 && ranking.profitFactor > 1.5) {
        patternAdjustments.push({
          pattern: ranking.pattern,
          previousMultiplier: 1.0,
          newMultiplier: 1.0 + (recentExpectancy - 0.5) * 0.5,
          reason: `Strong recent performance: expectancy ${recentExpectancy.toFixed(2)}R, PF ${ranking.profitFactor.toFixed(1)}`,
        });
      } else if (recentExpectancy < -0.3 || ranking.profitFactor < 0.8) {
        patternAdjustments.push({
          pattern: ranking.pattern,
          previousMultiplier: 1.0,
          newMultiplier: Math.max(0.3, 1.0 + recentExpectancy * 0.5),
          reason: `Poor recent performance: expectancy ${recentExpectancy.toFixed(2)}R, PF ${ranking.profitFactor.toFixed(1)}`,
        });
      }
    }

    // Absolute performance tracking
    if (ranking.expectancy > 0.3) {
      findings.push({
        category: 'working',
        description: `${ranking.pattern}: ${ranking.winRate.toFixed(0)}% WR, ${ranking.expectancy.toFixed(2)}R expectancy (${ranking.totalTrades} trades)`,
        metric: 'expectancy',
        currentValue: ranking.expectancy,
        previousValue: null,
        significance: ranking.expectancy > 0.5 ? 'high' : 'medium',
      });
    } else if (ranking.expectancy < -0.2 && ranking.totalTrades >= 20) {
      findings.push({
        category: 'failing',
        description: `${ranking.pattern}: ${ranking.winRate.toFixed(0)}% WR, ${ranking.expectancy.toFixed(2)}R expectancy (${ranking.totalTrades} trades)`,
        metric: 'expectancy',
        currentValue: ranking.expectancy,
        previousValue: null,
        significance: ranking.expectancy < -0.5 ? 'high' : 'medium',
      });
    }
  }

  // ── Analyze feature correlations for weight adjustments ────────────
  const featureCorrelations = analyzeFeatureCorrelations(signals);

  for (const [feature, corr] of Object.entries(featureCorrelations)) {
    const defaultWeight = getDefaultWeight(feature);
    // Stronger correlation = higher weight
    const adjustedWeight = defaultWeight * (1 + corr * 2);
    const clampedWeight = Math.max(1, Math.min(30, adjustedWeight));

    if (Math.abs(clampedWeight - defaultWeight) > 2) {
      weightAdjustments.push({
        feature,
        previousWeight: defaultWeight,
        newWeight: Math.round(clampedWeight * 10) / 10,
        reason: `Feature-outcome correlation: ${(corr * 100).toFixed(0)}%`,
      });
    }
  }

  // ── Build performance delta ──────────────────────────────────────
  const recentWR = calcWinRate(recent);
  const histWR = historical.length > 0 ? calcWinRate(historical) : 0;
  const recentExpectancy = calcExpectancy(recent);
  const histExpectancy = historical.length > 0 ? calcExpectancy(historical) : 0;
  const recentPF = calcProfitFactor(recent);
  const histPF = historical.length > 0 ? calcProfitFactor(historical) : 0;

  const performanceDelta: PerformanceDelta = {
    overallWinRate: { current: recentWR, previous: histWR },
    overallExpectancy: { current: recentExpectancy, previous: histExpectancy },
    overallProfitFactor: { current: recentPF, previous: histPF },
    bestPattern: patternRankings[0]?.pattern ?? 'N/A',
    worstPattern: patternRankings[patternRankings.length - 1]?.pattern ?? 'N/A',
    bestRegime: regimeRankings[0]?.regime ?? 'ranging',
    worstRegime: regimeRankings[regimeRankings.length - 1]?.regime ?? 'low_volatility',
    bestSession: sessionRankings[0]?.session ?? 'london',
    worstSession: sessionRankings[sessionRankings.length - 1]?.session ?? 'asia',
  };

  // ── Save snapshot ────────────────────────────────────────────────
  const result: LearningResult = {
    findings,
    weightAdjustments,
    patternAdjustments,
    performanceDelta,
    totalTradesAnalyzed: signals.length,
  };

  await saveSnapshot(result, triggerReason);
  _lastLearningTradeCount = signals.length;

  return result;
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

function calcWinRate(signals: SignalMemoryRecord[]): number {
  const withOutcome = signals.filter(s => s.result !== null);
  if (withOutcome.length === 0) return 0;
  const wins = withOutcome.filter(s => s.rMultiple !== null && s.rMultiple > 0.1);
  return (wins.length / withOutcome.length) * 100;
}

function calcExpectancy(signals: SignalMemoryRecord[]): number {
  const rMultiples = signals.filter(s => s.rMultiple !== null).map(s => s.rMultiple!);
  if (rMultiples.length === 0) return 0;
  return rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length;
}

function calcProfitFactor(signals: SignalMemoryRecord[]): number {
  const rMultiples = signals.filter(s => s.rMultiple !== null).map(s => s.rMultiple!);
  const grossWins = rMultiples.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(rMultiples.filter(r => r < 0).reduce((a, b) => a + b, 0));
  return grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0);
}

/** Analyze correlation between each feature and trade outcome (R-multiple) */
function analyzeFeatureCorrelations(signals: SignalMemoryRecord[]): Record<string, number> {
  const withOutcomes = signals.filter(s => s.rMultiple !== null);
  if (withOutcomes.length < 20) return {};

  const outcomes = withOutcomes.map(s => s.rMultiple!);

  const features: Record<string, number[]> = {
    rsi: withOutcomes.map(s => s.rsi),
    macd: withOutcomes.map(s => s.macd),
    volumeRatio: withOutcomes.map(s => s.volumeRatio),
    atr: withOutcomes.map(s => s.atr),
    edgeScore: withOutcomes.map(s => s.edgeScore),
    patternScore: withOutcomes.map(s => s.patternScore),
  };

  const correlations: Record<string, number> = {};
  for (const [name, values] of Object.entries(features)) {
    correlations[name] = pearsonCorrelation(values, outcomes);
  }

  return correlations;
}

/** Pearson correlation coefficient between two arrays */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] ** 2;
    sumY2 += y[i] ** 2;
  }

  const denom = Math.sqrt((n * sumX2 - sumX ** 2) * (n * sumY2 - sumY ** 2));
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function getDefaultWeight(feature: string): number {
  const defaults: Record<string, number> = {
    volume: 15, rsi: 10, macd: 8, atr: 5,
    openInterest: 12, fundingRate: 8, cvd: 10,
    regime: 20, session: 12,
    edgeScore: 25, patternScore: 15, volumeRatio: 15,
  };
  return defaults[feature] ?? 10;
}

// ─── Snapshot Persistence ─────────────────────────────────────────────────────

async function saveSnapshot(
  result: LearningResult,
  triggerReason: string,
): Promise<void> {
  const db = getDB();
  const record: LearningSnapshotRecord = {
    timestamp: Date.now(),
    totalTradesAnalyzed: result.totalTradesAnalyzed,
    triggerReason,
    findings: JSON.stringify(result.findings),
    weightAdjustments: JSON.stringify(result.weightAdjustments),
    patternAdjustments: JSON.stringify(result.patternAdjustments),
    performanceDelta: JSON.stringify(result.performanceDelta),
    patternsImproved: result.findings.filter(f => f.category === 'improving').length,
    patternsDegraded: result.findings.filter(f => f.category === 'degrading').length,
    weightsChanged: result.weightAdjustments.length,
    overallExpectancyDelta:
      result.performanceDelta.overallExpectancy.current -
      result.performanceDelta.overallExpectancy.previous,
  };
  await db.learningSnapshots.add(record);
}

async function getLastSnapshot(): Promise<LearningSnapshotRecord | null> {
  const db = getDB();
  const snapshots = await db.learningSnapshots
    .orderBy('timestamp')
    .reverse()
    .limit(1)
    .toArray();
  return snapshots[0] ?? null;
}

/** Get all learning snapshots for display */
export async function getLearningHistory(): Promise<LearningSnapshotRecord[]> {
  const db = getDB();
  return await db.learningSnapshots
    .orderBy('timestamp')
    .reverse()
    .toArray();
}

/** Parse a snapshot's findings back to typed objects */
export function parseFindings(snapshot: LearningSnapshotRecord): LearningFinding[] {
  try { return JSON.parse(snapshot.findings) as LearningFinding[]; }
  catch { return []; }
}

export function parseWeightAdjustments(snapshot: LearningSnapshotRecord): WeightAdjustment[] {
  try { return JSON.parse(snapshot.weightAdjustments) as WeightAdjustment[]; }
  catch { return []; }
}

export function parsePerformanceDelta(snapshot: LearningSnapshotRecord): PerformanceDelta | null {
  try { return JSON.parse(snapshot.performanceDelta) as PerformanceDelta; }
  catch { return null; }
}
