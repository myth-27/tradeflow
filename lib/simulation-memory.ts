/**
 * TradeFlow V3 — Simulation Memory Service (Phase 2)
 *
 * Every backtest run becomes a permanent learning dataset.
 * NEVER DELETE SIMULATIONS — each one contributes to future learning.
 */

import {
  getDB,
  type SimulationMemoryRecord,
} from './db';
import type { SimResult, SimConfig, SimTrade } from './simulator';
import type { Candle } from './binance-ws';
import { updateEdgeFromSimTrade } from './edge-database';
import { storeCompletedSnapshot } from './candle-snapshot-store';

// ─── Compact Trade Shape (what compactTrade() actually produces) ─────────────
// Exported so consumers (e.g. lib/ml-dataset.ts) can read stored trades type-safely
// instead of treating extractTrades()'s output as Record<string, unknown>.

export type CompactTrade = {
  id: string;
  dir: SimTrade['direction'];
  pat: string;
  conf: number;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  exit: number | null;
  reason: SimTrade['exitReason'];
  pnl: number;
  pnlPct: number;
  rMult: number;
  score: number;
  conv: SimTrade['convictionLevel'];
  regime: SimTrade['regime'];
  hour: number;
  rsi: number;
  macd: SimTrade['macdAtEntry'];
  vol: number;
  atr: number;
  trend: SimTrade['trendAtEntry'];
  tp1Hit: boolean;
  tp2Hit: boolean;
  candles: number;

  entryType: SimTrade['entryType'];
  waitedCandles: number;
  entrySlippage: number;
  htfBias: SimTrade['htfBias'];
  htfStrength: number;
  htfEmaSeparation: number;
  htfStructure: SimTrade['htfStructure'];
  bbLower: number;
  bbUpper: number;
  ema20VsEma50: number;
  priceVsEma20: number;
  distToSupport: number;
  distToResistance: number;
  macdHistPrev: number;
  volRatioPrev: number;
  winStreakBefore: number;
  lossStreakBefore: number;
  drawdownAtEntry: number;
  entryTime: number;
};

// ─── Recording Simulations ────────────────────────────────────────────────────

/**
 * Store a complete simulation result to permanent memory, and feed every closed trade into
 * the edge database (lib/edge-database.ts) and, when the raw candles are available, the
 * candle snapshot store (lib/candle-snapshot-store.ts) for future visual ML training.
 */
export async function recordSimulation(
  simResult: SimResult,
  candles?: Candle[],
): Promise<string> {
  const db = getDB();
  const config = simResult.config;

  const record: SimulationMemoryRecord = {
    simulationId: crypto.randomUUID(),
    date: Date.now(),
    symbol: config.symbol,
    timeframes: JSON.stringify([config.interval]),
    dateRange: `${config.startDate} to ${config.endDate}`,

    settings: JSON.stringify(config),
    riskPerTrade: config.riskPerTrade,
    filters: JSON.stringify({
      minRR: config.minRR,
      minConfidence: config.minConfidence,
      regimeFilter: config.regimeFilter,
      sessionFilter: config.sessionFilter,
      allowedPatterns: config.allowedPatterns,
      allowedRegimes: config.allowedRegimes,
    }),

    entryRules: JSON.stringify({
      entryTypeMode: config.entryTypeMode,
      maxWaitCandles: config.maxWaitCandles,
      entrySlippageBuffer: config.entrySlippageBuffer,
    }),
    exitRules: JSON.stringify({
      partialExit: config.partialExit,
      trailingStopMode: config.trailingStopMode,
      maxOpenTime: config.maxOpenTime,
    }),
    regimeRules: JSON.stringify({
      regimeFilter: config.regimeFilter,
      allowedRegimes: config.allowedRegimes,
    }),

    totalSignals: simResult.totalSignals,
    signalsTaken: simResult.totalTrades,
    signalsRejected: simResult.totalSignals - simResult.totalTrades,

    winRate: simResult.winRate,
    profitFactor: simResult.profitFactor,
    expectancy: simResult.expectancy,
    maxDrawdown: simResult.maxDrawdown,
    sharpeRatio: simResult.sharpeRatio,
    finalCapital: simResult.finalCapital,
    startingCapital: simResult.startingCapital,
    totalReturn: simResult.totalReturn,

    // Store all trades — this is the full learning dataset
    allTrades: JSON.stringify(
      simResult.trades.map(compactTrade)
    ),

    // Persist per-reason rejection counts for Phase 3E analysis
    rejectionReasons: JSON.stringify(simResult.rejections),

    durationMs: 0, // caller can set this
    totalCandles: simResult.totalCandles,
  };

  const id = await db.simulationMemory.add(record);

  // Feed every closed, filled trade into the edge database and (when candles are available)
  // the candle snapshot store. Sequential, not Promise.all, to avoid hammering IndexedDB with
  // a burst of concurrent writes on large simulations.
  const filledTrades = simResult.trades.filter(t => t.status === 'closed' && t.exitReason !== 'entry_expired');
  for (const trade of filledTrades) {
    const outcome: 'win' | 'loss' | 'breakeven' =
      trade.rMultiple > 0.1 ? 'win' : trade.exitReason === 'stop' ? 'loss' : 'breakeven';
    const holdingCandles = (trade.exitCandle ?? trade.entryCandle) - trade.entryCandle;

    try {
      await updateEdgeFromSimTrade({
        pattern: trade.patternName,
        symbol: trade.symbol,
        timeframe: config.interval,
        regime: trade.regime,
        entryTime: trade.entryTime,
        outcome,
        rMultiple: trade.rMultiple,
        holdingCandles,
      });
    } catch (err) {
      console.error('Failed to update edge database from sim trade:', err);
    }

    if (candles && candles.length > 0) {
      try {
        const signalTime = candles[trade.signalCandle]?.time ?? trade.entryTime;
        await storeCompletedSnapshot({
          signalId: trade.id,
          symbol: trade.symbol,
          timeframe: config.interval,
          pattern: trade.patternName,
          direction: trade.direction,
          simulationId: record.simulationId,
          signalTimestamp: signalTime,
          outcome,
          rMultiple: trade.rMultiple,
          prevCandles: candles.slice(0, trade.signalCandle + 1),
          nextCandles: candles.slice((trade.exitCandle ?? trade.entryCandle) + 1),
        });
      } catch (err) {
        console.error('Failed to store candle snapshot from sim trade:', err);
      }
    }
  }

  void id;
  return record.simulationId;
}

/** Compact a SimTrade for storage — keep only fields needed for learning */
function compactTrade(t: SimTrade): CompactTrade {
  return {
    id: t.id,
    dir: t.direction,
    pat: t.patternName,
    conf: t.confidence,
    entry: t.entryPrice,
    stop: t.stopLoss,
    tp1: t.tp1,
    tp2: t.tp2,
    exit: t.exitPrice,
    reason: t.exitReason,
    pnl: t.pnlDollars,
    pnlPct: t.pnlPercent,
    rMult: t.rMultiple,
    score: t.signalScore,
    conv: t.convictionLevel,
    regime: t.regime,
    hour: t.sessionHour,
    rsi: t.rsiAtEntry,
    macd: t.macdAtEntry,
    vol: t.volumeRatioAtEntry,
    atr: t.atrAtEntry,
    trend: t.trendAtEntry,
    tp1Hit: t.tp1Hit,
    tp2Hit: t.tp2Hit,
    candles: (t.exitCandle ?? t.entryCandle) - t.entryCandle,

    // ML feature context — see lib/ml-dataset.ts for the full feature-engineered training row
    entryType: t.entryType,
    waitedCandles: t.waitedCandles,
    entrySlippage: t.entrySlippage,
    htfBias: t.htfBias,
    htfStrength: t.htfStrength,
    htfEmaSeparation: t.htfEmaSeparation,
    htfStructure: t.htfStructure,
    bbLower: t.bbLowerAtEntry,
    bbUpper: t.bbUpperAtEntry,
    ema20VsEma50: t.ema20VsEma50AtEntry,
    priceVsEma20: t.priceVsEma20AtEntry,
    distToSupport: t.distToSupportPct,
    distToResistance: t.distToResistancePct,
    macdHistPrev: t.macdHistPrevAtEntry,
    volRatioPrev: t.volumeRatioPrevAtEntry,
    winStreakBefore: t.winStreakBeforeEntry,
    lossStreakBefore: t.lossStreakBeforeEntry,
    drawdownAtEntry: t.drawdownPctAtEntry,
    entryTime: t.entryTime,
  };
}

// ─── Query Simulations ────────────────────────────────────────────────────────

/** Get a specific simulation by its ID */
export async function getSimulation(
  simulationId: string,
): Promise<SimulationMemoryRecord | undefined> {
  const db = getDB();
  return await db.simulationMemory
    .where('simulationId')
    .equals(simulationId)
    .first();
}

/** Get all simulations, sorted by date descending */
export async function getAllSimulations(): Promise<SimulationMemoryRecord[]> {
  const db = getDB();
  return await db.simulationMemory
    .orderBy('date')
    .reverse()
    .toArray();
}

/** Get simulations for a specific symbol */
export async function getSimulationsBySymbol(
  symbol: string,
): Promise<SimulationMemoryRecord[]> {
  const db = getDB();
  return await db.simulationMemory
    .where('symbol')
    .equals(symbol)
    .reverse()
    .sortBy('date');
}

/** Get total simulation count */
export async function getSimulationCount(): Promise<number> {
  return await getDB().simulationMemory.count();
}

/** Get aggregate statistics across ALL simulations */
export async function getAggregateStats(): Promise<{
  totalSimulations: number;
  totalTradesSimulated: number;
  avgWinRate: number;
  avgProfitFactor: number;
  avgExpectancy: number;
  bestSimulation: SimulationMemoryRecord | null;
  worstSimulation: SimulationMemoryRecord | null;
  totalCandlesProcessed: number;
}> {
  const db = getDB();
  const sims = await db.simulationMemory.toArray();

  if (sims.length === 0) {
    return {
      totalSimulations: 0,
      totalTradesSimulated: 0,
      avgWinRate: 0,
      avgProfitFactor: 0,
      avgExpectancy: 0,
      bestSimulation: null,
      worstSimulation: null,
      totalCandlesProcessed: 0,
    };
  }

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    totalSimulations: sims.length,
    totalTradesSimulated: sims.reduce((a, s) => a + s.signalsTaken, 0),
    avgWinRate: avg(sims.map(s => s.winRate)),
    avgProfitFactor: avg(sims.filter(s => isFinite(s.profitFactor)).map(s => s.profitFactor)),
    avgExpectancy: avg(sims.map(s => s.expectancy)),
    bestSimulation: sims.reduce((best, s) => !best || s.totalReturn > best.totalReturn ? s : best, null as SimulationMemoryRecord | null),
    worstSimulation: sims.reduce((worst, s) => !worst || s.totalReturn < worst.totalReturn ? s : worst, null as SimulationMemoryRecord | null),
    totalCandlesProcessed: sims.reduce((a, s) => a + s.totalCandles, 0),
  };
}

/** Extract all trades from a simulation record for learning */
export function extractTrades(sim: SimulationMemoryRecord): CompactTrade[] {
  try {
    return JSON.parse(sim.allTrades) as CompactTrade[];
  } catch {
    return [];
  }
}

/** Get recent simulation summaries for display */
export async function getRecentSimulations(
  count = 10,
): Promise<Pick<SimulationMemoryRecord, 'simulationId' | 'date' | 'symbol' | 'winRate' | 'profitFactor' | 'expectancy' | 'totalReturn' | 'signalsTaken'>[]> {
  const db = getDB();
  const sims = await db.simulationMemory
    .orderBy('date')
    .reverse()
    .limit(count)
    .toArray();

  return sims.map(s => ({
    simulationId: s.simulationId,
    date: s.date,
    symbol: s.symbol,
    winRate: s.winRate,
    profitFactor: s.profitFactor,
    expectancy: s.expectancy,
    totalReturn: s.totalReturn,
    signalsTaken: s.signalsTaken,
  }));
}
