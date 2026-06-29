/**
 * TradeFlow — Candle Snapshot Store (Phase 13)
 *
 * Stores the 100 candles before and after every signal — raw price structure, not just
 * indicators — for future visual ML training (CNN/LSTM pattern recognition).
 */

import { getDB, type CandleSnapshot, type SerializedCandle } from './db';
import type { Candle } from './binance-ws';

const SNAPSHOT_WINDOW = 100;

function serialize(c: Candle): SerializedCandle {
  return { t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume };
}

// ─── Write Path ────────────────────────────────────────────────────────────

/** Called when a signal is detected — stores prev100 immediately; next100 is filled later. */
export async function storeSignalSnapshot(params: {
  signalId: string;
  symbol: string;
  timeframe: string;
  pattern: string;
  direction: string;
  simulationId: string;
  signalTimestamp: number;
  candlesAtSignal: Candle[];
}): Promise<void> {
  const db = getDB();
  const { candlesAtSignal, signalTimestamp } = params;

  const sigIdx = candlesAtSignal.findIndex(c => c.time === signalTimestamp);
  const snapshotIdx = sigIdx >= 0 ? sigIdx : candlesAtSignal.length - 1;

  const prev100 = candlesAtSignal
    .slice(Math.max(0, snapshotIdx - SNAPSHOT_WINDOW), snapshotIdx)
    .map(serialize);

  await db.candleSnapshots.add({
    signalId: params.signalId,
    symbol: params.symbol,
    timeframe: params.timeframe,
    signalTimestamp,
    pattern: params.pattern,
    direction: params.direction,
    outcome: 'pending',
    rMultiple: null,
    prev100,
    next100: [],
    simulationId: params.simulationId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/** Called when the trade closes — fills in next100 and the outcome. */
export async function updateSnapshotOutcome(params: {
  signalId: string;
  outcome: string;
  rMultiple: number;
  candlesAfterSignal: Candle[];
  signalTimestamp: number;
}): Promise<void> {
  const db = getDB();
  const existing = await db.candleSnapshots.where('signalId').equals(params.signalId).first();
  if (!existing) return;

  const startIdx = params.candlesAfterSignal.findIndex(c => c.time > params.signalTimestamp);
  const next100 = (startIdx >= 0 ? params.candlesAfterSignal.slice(startIdx, startIdx + SNAPSHOT_WINDOW) : [])
    .map(serialize);

  await db.candleSnapshots.update(existing.id!, {
    outcome: params.outcome,
    rMultiple: params.rMultiple,
    next100,
    updatedAt: Date.now(),
  });
}

/**
 * Convenience for the simulator path, where prev/next candles and the outcome are all known
 * at once (the trade has already closed by the time recordSimulation runs) — avoids a
 * two-phase write for data that doesn't need it.
 */
export async function storeCompletedSnapshot(params: {
  signalId: string;
  symbol: string;
  timeframe: string;
  pattern: string;
  direction: string;
  simulationId: string;
  signalTimestamp: number;
  outcome: string;
  rMultiple: number;
  prevCandles: Candle[];   // candles up to and including the signal candle
  nextCandles: Candle[];   // candles strictly after the signal candle
}): Promise<void> {
  const db = getDB();
  const prev100 = params.prevCandles.slice(-SNAPSHOT_WINDOW).map(serialize);
  const next100 = params.nextCandles.slice(0, SNAPSHOT_WINDOW).map(serialize);

  await db.candleSnapshots.add({
    signalId: params.signalId,
    symbol: params.symbol,
    timeframe: params.timeframe,
    signalTimestamp: params.signalTimestamp,
    pattern: params.pattern,
    direction: params.direction,
    outcome: params.outcome,
    rMultiple: params.rMultiple,
    prev100,
    next100,
    simulationId: params.simulationId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

// ─── Export ─────────────────────────────────────────────────────────────────

export async function exportSnapshotsAsJSON(symbol?: string, timeframe?: string): Promise<string> {
  const db = getDB();
  const snapshots = await db.candleSnapshots.filter(s => s.outcome !== 'pending').toArray();

  const filtered = snapshots.filter(s => {
    if (symbol && s.symbol !== symbol) return false;
    if (timeframe && s.timeframe !== timeframe) return false;
    return true;
  });

  const wins = filtered.filter(s => s.outcome === 'win');
  const losses = filtered.filter(s => s.outcome === 'loss');

  return JSON.stringify({
    metadata: {
      totalSnapshots: filtered.length,
      wins: wins.length,
      losses: losses.length,
      symbol: symbol ?? 'all',
      timeframe: timeframe ?? 'all',
      exportedAt: new Date().toISOString(),
      note: 'Each snapshot contains up to 100 candles before and after the signal. Use for CNN/LSTM visual pattern training.',
    },
    snapshots: filtered,
  }, null, 2);
}

// ─── Stats ──────────────────────────────────────────────────────────────────

export async function getSnapshotStats(): Promise<{
  total: number;
  withOutcome: number;
  pending: number;
  wins: number;
  losses: number;
  breakevens: number;
  byPattern: Record<string, number>;
  readyForVisualML: boolean;
  recommendation: string;
}> {
  const db = getDB();
  const all = await db.candleSnapshots.toArray();
  const completed = all.filter(s => s.outcome !== 'pending');
  const wins = completed.filter(s => s.outcome === 'win');
  const losses = completed.filter(s => s.outcome === 'loss');

  const byPattern: Record<string, number> = {};
  completed.forEach(s => { byPattern[s.pattern] = (byPattern[s.pattern] ?? 0) + 1; });

  const minForVisualML = 500;
  const readyForVisualML = completed.length >= minForVisualML;

  const recommendation = completed.length < 100
    ? `Need ${100 - completed.length} more completed trades for basic analysis`
    : completed.length < 500
      ? `${completed.length} snapshots — run more simulations. Need ${500 - completed.length} more for visual ML`
      : `${completed.length} snapshots — ready for CNN/LSTM visual pattern training`;

  return {
    total: all.length,
    withOutcome: completed.length,
    pending: all.length - completed.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: completed.filter(s => s.outcome === 'breakeven').length,
    byPattern,
    readyForVisualML,
    recommendation,
  };
}

export async function getSnapshotCount(): Promise<number> {
  return getDB().candleSnapshots.count();
}
