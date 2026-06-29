/**
 * TradeFlow V3 — Signal Memory Service (Phase 1)
 *
 * Records EVERY signal the system detects — taken, rejected, or ignored.
 * This is the core data layer that feeds the edge database, learning engine,
 * and RAG memory system.
 *
 * THE SYSTEM MUST NEVER FORGET.
 */

import {
  getDB,
  type SignalMemoryRecord,
  type SignalStatus,
  type TradeResult,
  type MarketRegime,
  type TradingSession,
} from './db';

// ─── Session Detection ────────────────────────────────────────────────────────

/** Detect which trading session a timestamp falls into (UTC hours) */
export function detectSession(timestamp: number): TradingSession {
  const hour = new Date(timestamp).getUTCHours();
  // London: 07:00 - 16:00 UTC
  // New York: 13:00 - 22:00 UTC
  // Overlap: 13:00 - 16:00 UTC
  // Asia: 00:00 - 08:00 UTC
  if (hour >= 13 && hour < 16) return 'overlap';
  if (hour >= 7 && hour < 16) return 'london';
  if (hour >= 13 && hour < 22) return 'new_york';
  return 'asia';
}

// ─── Feature Vector Generation ────────────────────────────────────────────────

/** Pattern type encoded as a number for the feature vector */
const PATTERN_ENCODING: Record<string, number> = {
  'Double Top': 0.1, 'Double Bottom': 0.15,
  'Head & Shoulders': 0.2,
  'Ascending Triangle': 0.3, 'Descending Triangle': 0.35, 'Symmetrical Triangle': 0.4,
  'Bull Flag': 0.5, 'Bear Flag': 0.55,
  'Hammer': 0.6, 'Shooting Star': 0.65,
  'Bullish Engulfing': 0.7, 'Bearish Engulfing': 0.75,
  'Morning Star': 0.8, 'Doji': 0.85,
};

const REGIME_ENCODING: Record<string, number> = {
  'strong_uptrend': 1.0, 'weak_uptrend': 0.75,
  'ranging': 0.5, 'low_volatility': 0.4,
  'weak_downtrend': 0.25, 'strong_downtrend': 0.0,
};

const SESSION_ENCODING: Record<string, number> = {
  'london': 0.8, 'new_york': 0.9, 'overlap': 1.0, 'asia': 0.5,
};

/** Generate a normalized feature vector for a signal (used for similarity search) */
export function generateFeatureVector(params: {
  pattern: string;
  direction: 'long' | 'short';
  regime: MarketRegime;
  session: TradingSession;
  rsi: number;
  macd: number;
  atr: number;
  volumeRatio: number;
  openInterest?: number | null;
  fundingRate?: number | null;
  cvd?: number | null;
}): number[] {
  const {
    pattern, direction, regime, session,
    rsi, macd, atr, volumeRatio,
    openInterest, fundingRate, cvd,
  } = params;

  return [
    PATTERN_ENCODING[pattern] ?? 0.5,
    direction === 'long' ? 1.0 : 0.0,
    REGIME_ENCODING[regime] ?? 0.5,
    SESSION_ENCODING[session] ?? 0.5,
    Math.max(0, Math.min(1, rsi / 100)),                       // RSI normalized 0-1
    Math.max(-1, Math.min(1, macd / (Math.abs(macd) + 1))),    // MACD sigmoid-like
    Math.max(0, Math.min(1, atr * 10)),                        // ATR normalized (assuming %ATR)
    Math.max(0, Math.min(1, volumeRatio / 5)),                 // Volume ratio capped at 5x
    openInterest != null ? Math.max(-1, Math.min(1, openInterest)) : 0,
    fundingRate != null ? Math.max(-1, Math.min(1, fundingRate * 100)) : 0,
    cvd != null ? Math.max(-1, Math.min(1, cvd)) : 0,
  ];
}

// ─── Signal Recording ─────────────────────────────────────────────────────────

export interface RecordSignalParams {
  symbol: string;
  timeframe: string;
  pattern: string;
  direction: 'long' | 'short';
  patternScore: number;
  tradeScore: number;
  edgeScore: number;
  regime: MarketRegime;
  rsi: number;
  macd: number;
  atr: number;
  volumeRatio: number;
  openInterest?: number | null;
  fundingRate?: number | null;
  cvd?: number | null;
  liquidations?: number | null;
  supportLevels: number[];
  resistanceLevels: number[];
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  wasTaken: boolean;
  rejectionReason?: string | null;
  simulationId?: string | null;
  htfBias?: 'bullish' | 'bearish' | 'neutral' | null;
  mtfConfirmation?: boolean | null;
}

/** Record a signal to permanent memory. Called for EVERY signal — taken or rejected. */
export async function recordSignal(params: RecordSignalParams): Promise<number> {
  const db = getDB();
  const session = detectSession(Date.now());
  const featureVector = generateFeatureVector({
    pattern: params.pattern,
    direction: params.direction,
    regime: params.regime,
    session,
    rsi: params.rsi,
    macd: params.macd,
    atr: params.atr / params.entry, // convert to percentage ATR
    volumeRatio: params.volumeRatio,
    openInterest: params.openInterest,
    fundingRate: params.fundingRate,
    cvd: params.cvd,
  });

  const record: SignalMemoryRecord = {
    timestamp: Date.now(),
    symbol: params.symbol,
    timeframe: params.timeframe,
    pattern: params.pattern,
    direction: params.direction,
    patternScore: params.patternScore,
    tradeScore: params.tradeScore,
    edgeScore: params.edgeScore,
    regime: params.regime,
    session,
    rsi: params.rsi,
    macd: params.macd,
    atr: params.atr,
    volumeRatio: params.volumeRatio,
    openInterest: params.openInterest ?? null,
    fundingRate: params.fundingRate ?? null,
    cvd: params.cvd ?? null,
    liquidations: params.liquidations ?? null,
    supportLevels: JSON.stringify(params.supportLevels),
    resistanceLevels: JSON.stringify(params.resistanceLevels),
    entry: params.entry,
    stop: params.stop,
    tp1: params.tp1,
    tp2: params.tp2,
    tp3: params.tp3,
    signalStatus: params.wasTaken ? 'detected' : 'invalidated',
    wasTaken: params.wasTaken,
    rejectionReason: params.rejectionReason ?? null,
    result: null,
    rMultiple: null,
    holdingTime: null,
    simulationId: params.simulationId ?? null,
    featureVector: JSON.stringify(featureVector),
    htfBias: params.htfBias ?? null,
    mtfConfirmation: params.mtfConfirmation ?? null,
  };

  return await db.signalMemory.add(record);
}

/** Update a signal's status (e.g., detected → confirmed → active) */
export async function updateSignalStatus(
  id: number,
  status: SignalStatus,
): Promise<void> {
  const db = getDB();
  await db.signalMemory.update(id, { signalStatus: status });
}

/** Update a signal's outcome after the trade closes */
export async function updateSignalOutcome(
  id: number,
  result: TradeResult,
  rMultiple: number,
  holdingTime: number,
): Promise<void> {
  const db = getDB();
  await db.signalMemory.update(id, {
    result,
    rMultiple,
    holdingTime,
    signalStatus: 'expired' as SignalStatus,
  });
}

// ─── Signal Queries ───────────────────────────────────────────────────────────

/** Get signals by pattern, optionally filtered by symbol and timeframe */
export async function getSignalsByPattern(
  pattern: string,
  symbol?: string,
  timeframe?: string,
  limit = 200,
): Promise<SignalMemoryRecord[]> {
  const db = getDB();
  let query = db.signalMemory.where('pattern').equals(pattern);
  const results = await query.reverse().sortBy('timestamp');

  return results
    .filter(r => (!symbol || r.symbol === symbol) && (!timeframe || r.timeframe === timeframe))
    .slice(0, limit);
}

/** Get signals for a specific pattern + regime combination */
export async function getSignalsByPatternAndRegime(
  pattern: string,
  regime: MarketRegime,
  limit = 200,
): Promise<SignalMemoryRecord[]> {
  const db = getDB();
  return await db.signalMemory
    .where('[pattern+regime]')
    .equals([pattern, regime])
    .reverse()
    .sortBy('timestamp')
    .then(results => results.slice(0, limit));
}

/** Get signals for a specific regime */
export async function getSignalsByRegime(
  regime: MarketRegime,
  limit = 200,
): Promise<SignalMemoryRecord[]> {
  const db = getDB();
  return await db.signalMemory
    .where('regime')
    .equals(regime)
    .reverse()
    .sortBy('timestamp')
    .then(results => results.slice(0, limit));
}

/** Get recent signals for a symbol (for UI display) */
export async function getRecentSignals(
  symbol: string,
  count = 20,
): Promise<SignalMemoryRecord[]> {
  const db = getDB();
  return await db.signalMemory
    .where('symbol')
    .equals(symbol)
    .reverse()
    .sortBy('timestamp')
    .then(results => results.slice(0, count));
}

/** Get total signal count */
export async function getSignalCount(): Promise<number> {
  return await getDB().signalMemory.count();
}

/** Get signals with a specific result */
export async function getSignalsByResult(
  result: TradeResult,
  limit = 500,
): Promise<SignalMemoryRecord[]> {
  const db = getDB();
  return await db.signalMemory
    .where('result')
    .equals(result ?? '')
    .reverse()
    .sortBy('timestamp')
    .then(results => results.slice(0, limit));
}

/** Get ALL signals that were taken (trades) — for learning engine */
export async function getAllTakenSignals(): Promise<SignalMemoryRecord[]> {
  const db = getDB();
  return await db.signalMemory
    .where('wasTaken')
    .equals(1)  // Dexie stores booleans as 0/1
    .toArray();
}

/** Get all signals with outcomes — for edge database rebuilding */
export async function getAllSignalsWithOutcomes(): Promise<SignalMemoryRecord[]> {
  const db = getDB();
  return (await db.signalMemory.toArray()).filter(s => s.result !== null);
}

/** Get signals within a time range */
export async function getSignalsInRange(
  startTime: number,
  endTime: number,
): Promise<SignalMemoryRecord[]> {
  const db = getDB();
  return await db.signalMemory
    .where('timestamp')
    .between(startTime, endTime)
    .toArray();
}

/** Get unique patterns that have been recorded */
export async function getRecordedPatterns(): Promise<string[]> {
  const db = getDB();
  const all = await db.signalMemory.orderBy('pattern').uniqueKeys();
  return all as string[];
}

/** Bulk import signals (e.g., from simulation results) */
export async function bulkRecordSignals(
  signals: SignalMemoryRecord[],
): Promise<void> {
  const db = getDB();
  await db.signalMemory.bulkAdd(signals);
}
