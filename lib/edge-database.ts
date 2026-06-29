/**
 * TradeFlow V3 — Edge Database (Phase 3)
 *
 * Continuously updated performance tables that track edge by:
 *   Pattern × Symbol × Timeframe × Session × Regime
 *
 * This is where the system learns WHAT works, WHEN it works,
 * and WHERE it works.
 */

import {
  getDB,
  type EdgeStatsRecord,
  type EdgeStatus,
  type MarketRegime,
  type TradingSession,
  type SignalMemoryRecord,
} from './db';
import { getAllSignalsWithOutcomes, detectSession } from './signal-memory';

// ─── Edge Key ─────────────────────────────────────────────────────────────────

export interface EdgeKey {
  pattern: string;
  symbol: string;
  timeframe: string;
  session: TradingSession;
  regime: MarketRegime;
}

// ─── Shared status/trend classification (used by both live and sim update paths) ──

function classifyEdgeStatus(sampleSize: number, profitFactor: number): EdgeStatus {
  if (sampleSize >= 100 && profitFactor < 0.8) return 'disabled';
  if (sampleSize >= 50 && profitFactor < 0.9) return 'degraded';
  if (sampleSize >= 100 && profitFactor > 1.8) return 'promoted';
  if (sampleSize >= 200) return 'confident';
  if (sampleSize >= 50) return 'active';
  if (sampleSize >= 20) return 'emerging';
  return 'learning';
}

function rollingLast20(existingRate: number | undefined, isWin: boolean): number {
  const prev = existingRate ?? (isWin ? 1 : 0);
  return prev * 0.95 + (isWin ? 1 : 0) * 0.05;
}

function classifyTrend(prevLast20: number | undefined, newLast20: number): 'improving' | 'degrading' | 'stable' {
  const prev = prevLast20 ?? newLast20;
  if (newLast20 > prev + 0.05) return 'improving';
  if (newLast20 < prev - 0.05) return 'degrading';
  return 'stable';
}

// ─── Update Edge Stats ────────────────────────────────────────────────────────

/** Update edge stats after a single signal outcome is recorded */
export async function updateEdgeAfterOutcome(signal: SignalMemoryRecord): Promise<void> {
  if (signal.result === null || signal.rMultiple === null) return;

  const db = getDB();
  const key: EdgeKey = {
    pattern: signal.pattern,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    session: signal.session,
    regime: signal.regime,
  };

  // Find existing edge record or create new one
  const existing = await db.edgeStats
    .where('[pattern+symbol+timeframe+session+regime]')
    .equals([key.pattern, key.symbol, key.timeframe, key.session, key.regime])
    .first();

  if (existing) {
    // Incrementally update
    const isWin = signal.rMultiple > 0.1;
    const isLoss = signal.result === 'loss';
    const isBreakeven = signal.result === 'breakeven';

    const newTotal = existing.totalTrades + 1;
    const newWins = existing.wins + (isWin ? 1 : 0);
    const newLosses = existing.losses + (isLoss ? 1 : 0);
    const newBreakevens = existing.breakevens + (isBreakeven ? 1 : 0);
    const newWinRate = newTotal > 0 ? (newWins / newTotal) * 100 : 0;

    // Running average R-multiple
    const newAvgR = ((existing.avgRMultiple * existing.totalTrades) + signal.rMultiple) / newTotal;
    const newBestR = Math.max(existing.bestRMultiple, signal.rMultiple);
    const newWorstR = Math.min(existing.worstRMultiple, signal.rMultiple);

    // Expectancy = (winRate * avgWin) - (lossRate * avgLoss)
    // We approximate this from the running R-multiple average
    const expectancy = newAvgR; // R-multiple is already the expectancy metric per trade

    // Profit factor needs gross wins / gross losses, approximate from rate * avgR
    const avgWinR = newWins > 0 ? Math.max(0.1, newAvgR + Math.abs(newAvgR) * 0.5) : 0;
    const avgLossR = newLosses > 0 ? Math.abs(Math.min(-0.1, newAvgR - Math.abs(newAvgR) * 0.5)) : 0.001;
    const profitFactor = avgLossR > 0 ? (newWins * avgWinR) / (newLosses * avgLossR || 1) : newWins > 0 ? Infinity : 0;

    // Holding time running average
    const newAvgHolding = signal.holdingTime !== null
      ? ((existing.avgHoldingTime * existing.totalTrades) + signal.holdingTime) / newTotal
      : existing.avgHoldingTime;

    const newGrossWins = (existing.grossWins ?? 0) + (isWin ? Math.abs(signal.rMultiple) : 0);
    const newGrossLosses = (existing.grossLosses ?? 0) + (isLoss ? Math.abs(signal.rMultiple) : 0);
    const status = classifyEdgeStatus(newTotal, isFinite(profitFactor) ? profitFactor : 0);
    const newLast20WR = rollingLast20(existing.last20WinRate, isWin);
    const recentTrend = classifyTrend(existing.last20WinRate, newLast20WR);

    await db.edgeStats.update(existing.id!, {
      totalTrades: newTotal,
      wins: newWins,
      losses: newLosses,
      breakevens: newBreakevens,
      winRate: newWinRate,
      profitFactor: isFinite(profitFactor) ? profitFactor : 0,
      expectancy,
      avgRMultiple: newAvgR,
      bestRMultiple: newBestR,
      worstRMultiple: newWorstR,
      avgHoldingTime: newAvgHolding,
      grossWins: newGrossWins,
      grossLosses: newGrossLosses,
      status,
      last20WinRate: newLast20WR,
      last20RMultiple: (existing.last20RMultiple ?? signal.rMultiple) * 0.95 + signal.rMultiple * 0.05,
      recentTrend,
      dataSource: existing.dataSource === 'sim' ? 'mixed' : 'live',
      lastUpdated: Date.now(),
    });
  } else {
    // Create new edge record
    const isWin = signal.rMultiple > 0.1;
    const isLoss = signal.result === 'loss';
    const isBreakeven = signal.result === 'breakeven';

    await db.edgeStats.add({
      ...key,
      totalTrades: 1,
      wins: isWin ? 1 : 0,
      losses: isLoss ? 1 : 0,
      breakevens: isBreakeven ? 1 : 0,
      winRate: isWin ? 100 : 0,
      profitFactor: isWin ? signal.rMultiple : 0,
      expectancy: signal.rMultiple,
      avgRMultiple: signal.rMultiple,
      bestRMultiple: signal.rMultiple,
      worstRMultiple: signal.rMultiple,
      sharpeRatio: 0,
      maxDrawdown: isLoss ? Math.abs(signal.rMultiple) : 0,
      recoveryFactor: 0,
      avgHoldingTime: signal.holdingTime ?? 0,
      grossWins: isWin ? Math.abs(signal.rMultiple) : 0,
      grossLosses: isLoss ? Math.abs(signal.rMultiple) : 0,
      status: 'learning',
      last20WinRate: isWin ? 1 : 0,
      last20RMultiple: signal.rMultiple,
      recentTrend: 'stable',
      firstSeenAt: Date.now(),
      dataSource: 'live',
      lastUpdated: Date.now(),
    });
  }
}

/**
 * Update edge stats after a simulator trade closes — the simulator equivalent of
 * updateEdgeAfterOutcome(), writing to the SAME edgeStats table (not a separate one) so
 * pattern/regime/session rankings reflect both live and simulated trades together.
 */
export async function updateEdgeFromSimTrade(trade: {
  pattern: string;
  symbol: string;
  timeframe: string;
  regime: MarketRegime;
  entryTime: number; // epoch seconds
  outcome: 'win' | 'loss' | 'breakeven';
  rMultiple: number;
  holdingCandles: number;
}): Promise<EdgeStatsRecord> {
  const db = getDB();
  const session = detectSession(trade.entryTime * 1000);
  const isWin = trade.outcome === 'win';
  const isLoss = trade.outcome === 'loss';
  const isBreakeven = trade.outcome === 'breakeven';

  const existing = await db.edgeStats
    .where('[pattern+symbol+timeframe+session+regime]')
    .equals([trade.pattern, trade.symbol, trade.timeframe, session, trade.regime])
    .first();

  if (existing) {
    const newTotal = existing.totalTrades + 1;
    const newWins = existing.wins + (isWin ? 1 : 0);
    const newLosses = existing.losses + (isLoss ? 1 : 0);
    const newBreakevens = existing.breakevens + (isBreakeven ? 1 : 0);
    const newWinRate = newTotal > 0 ? (newWins / newTotal) * 100 : 0;

    const newAvgR = (existing.avgRMultiple * existing.totalTrades + trade.rMultiple) / newTotal;
    const newBestR = Math.max(existing.bestRMultiple, trade.rMultiple);
    const newWorstR = Math.min(existing.worstRMultiple, trade.rMultiple);

    const newGrossWins = (existing.grossWins ?? 0) + (isWin ? Math.abs(trade.rMultiple) : 0);
    const newGrossLosses = (existing.grossLosses ?? 0) + (isLoss ? Math.abs(trade.rMultiple) : 0);
    const newPF = newGrossLosses > 0 ? newGrossWins / newGrossLosses : (newGrossWins > 0 ? 9.99 : 0);

    const avgWin = newWins > 0 ? newGrossWins / newWins : 0;
    const avgLoss = newLosses > 0 ? newGrossLosses / newLosses : 0;
    const newExpectancy = (newWinRate / 100) * avgWin - (1 - newWinRate / 100) * avgLoss;

    const newAvgHolding = (existing.avgHoldingTime * existing.totalTrades + trade.holdingCandles) / newTotal;
    const status = classifyEdgeStatus(newTotal, newPF);
    const newLast20WR = rollingLast20(existing.last20WinRate, isWin);
    const recentTrend = classifyTrend(existing.last20WinRate, newLast20WR);

    const updated: Partial<EdgeStatsRecord> = {
      totalTrades: newTotal,
      wins: newWins,
      losses: newLosses,
      breakevens: newBreakevens,
      winRate: newWinRate,
      profitFactor: newPF,
      expectancy: newExpectancy,
      avgRMultiple: newAvgR,
      bestRMultiple: newBestR,
      worstRMultiple: newWorstR,
      avgHoldingTime: newAvgHolding,
      grossWins: newGrossWins,
      grossLosses: newGrossLosses,
      status,
      last20WinRate: newLast20WR,
      last20RMultiple: (existing.last20RMultiple ?? trade.rMultiple) * 0.95 + trade.rMultiple * 0.05,
      recentTrend,
      dataSource: existing.dataSource === 'live' ? 'mixed' : 'sim',
      lastUpdated: Date.now(),
    };
    await db.edgeStats.update(existing.id!, updated);
    return { ...existing, ...updated } as EdgeStatsRecord;
  }

  const newRecord: EdgeStatsRecord = {
    pattern: trade.pattern,
    symbol: trade.symbol,
    timeframe: trade.timeframe,
    session,
    regime: trade.regime,
    totalTrades: 1,
    wins: isWin ? 1 : 0,
    losses: isLoss ? 1 : 0,
    breakevens: isBreakeven ? 1 : 0,
    winRate: isWin ? 100 : 0,
    profitFactor: isWin ? 9.99 : 0,
    expectancy: isWin ? Math.abs(trade.rMultiple) : -Math.abs(trade.rMultiple),
    avgRMultiple: trade.rMultiple,
    bestRMultiple: trade.rMultiple,
    worstRMultiple: trade.rMultiple,
    sharpeRatio: 0,
    maxDrawdown: isLoss ? Math.abs(trade.rMultiple) : 0,
    recoveryFactor: 0,
    avgHoldingTime: trade.holdingCandles,
    grossWins: isWin ? Math.abs(trade.rMultiple) : 0,
    grossLosses: isLoss ? Math.abs(trade.rMultiple) : 0,
    status: 'learning',
    last20WinRate: isWin ? 1 : 0,
    last20RMultiple: trade.rMultiple,
    recentTrend: 'stable',
    firstSeenAt: Date.now(),
    dataSource: 'sim',
    lastUpdated: Date.now(),
  };
  await db.edgeStats.add(newRecord);
  return newRecord;
}

// ─── Full Rebuild ─────────────────────────────────────────────────────────────

/** Rebuild ALL edge stats from signal memory. Use after import or corruption. */
export async function rebuildEdgeDatabase(): Promise<number> {
  const db = getDB();
  await db.edgeStats.clear();

  const signals = await getAllSignalsWithOutcomes();
  if (signals.length === 0) return 0;

  // Group signals by edge key
  const groups = new Map<string, SignalMemoryRecord[]>();
  for (const s of signals) {
    const key = `${s.pattern}|${s.symbol}|${s.timeframe}|${s.session}|${s.regime}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  // Build edge stats for each group
  const records: EdgeStatsRecord[] = [];
  for (const [, group] of Array.from(groups.entries())) {
    const first = group[0];
    const totalTrades = group.length;
    const wins = group.filter(s => s.rMultiple !== null && s.rMultiple > 0.1).length;
    const losses = group.filter(s => s.result === 'loss').length;
    const breakevens = group.filter(s => s.result === 'breakeven').length;

    const rMultiples = group.filter(s => s.rMultiple !== null).map(s => s.rMultiple!);
    const avgR = rMultiples.length > 0 ? rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length : 0;
    const bestR = rMultiples.length > 0 ? Math.max(...rMultiples) : 0;
    const worstR = rMultiples.length > 0 ? Math.min(...rMultiples) : 0;

    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

    // Profit factor
    const grossWins = rMultiples.filter(r => r > 0).reduce((a, b) => a + b, 0);
    const grossLosses = Math.abs(rMultiples.filter(r => r < 0).reduce((a, b) => a + b, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0);

    // Sharpe (of R-multiples)
    const mean = avgR;
    const variance = rMultiples.length > 1
      ? rMultiples.reduce((s, r) => s + (r - mean) ** 2, 0) / rMultiples.length
      : 0;
    const sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;

    // Max drawdown in R terms
    let peak = 0, maxDD = 0, cumR = 0;
    for (const r of rMultiples) {
      cumR += r;
      if (cumR > peak) peak = cumR;
      const dd = peak - cumR;
      if (dd > maxDD) maxDD = dd;
    }

    const holdingTimes = group.filter(s => s.holdingTime !== null).map(s => s.holdingTime!);
    const avgHolding = holdingTimes.length > 0
      ? holdingTimes.reduce((a, b) => a + b, 0) / holdingTimes.length
      : 0;

    records.push({
      pattern: first.pattern,
      symbol: first.symbol,
      timeframe: first.timeframe,
      session: first.session,
      regime: first.regime,
      totalTrades,
      wins,
      losses,
      breakevens,
      winRate,
      profitFactor: isFinite(profitFactor) ? profitFactor : 0,
      expectancy: avgR,
      avgRMultiple: avgR,
      bestRMultiple: bestR,
      worstRMultiple: worstR,
      sharpeRatio: sharpe,
      maxDrawdown: maxDD,
      recoveryFactor: maxDD > 0 ? cumR / maxDD : 0,
      avgHoldingTime: avgHolding,
      lastUpdated: Date.now(),
    });
  }

  await db.edgeStats.bulkAdd(records);
  return records.length;
}

// ─── Edge Queries ─────────────────────────────────────────────────────────────

/** Get edge for a specific combination */
export async function getEdge(
  pattern: string,
  symbol: string,
  timeframe: string,
  session: TradingSession,
  regime: MarketRegime,
): Promise<EdgeStatsRecord | undefined> {
  const db = getDB();
  return await db.edgeStats
    .where('[pattern+symbol+timeframe+session+regime]')
    .equals([pattern, symbol, timeframe, session, regime])
    .first();
}

/** Get aggregated edge for a pattern across all conditions */
export async function getPatternEdge(pattern: string): Promise<{
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  avgRMultiple: number;
  byRegime: Record<string, { winRate: number; pf: number; trades: number }>;
  bySession: Record<string, { winRate: number; pf: number; trades: number }>;
}> {
  const db = getDB();
  const records = await db.edgeStats
    .where('pattern')
    .equals(pattern)
    .toArray();

  if (records.length === 0) {
    return {
      totalTrades: 0, winRate: 0, profitFactor: 0,
      expectancy: 0, avgRMultiple: 0, byRegime: {}, bySession: {},
    };
  }

  const totalTrades = records.reduce((a, r) => a + r.totalTrades, 0);
  const totalWins = records.reduce((a, r) => a + r.wins, 0);
  const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

  // Weighted average R-multiple
  const avgR = totalTrades > 0
    ? records.reduce((a, r) => a + r.avgRMultiple * r.totalTrades, 0) / totalTrades
    : 0;

  // Aggregate profit factor
  const totalGrossWins = records.reduce((a, r) =>
    a + (r.avgRMultiple > 0 ? r.avgRMultiple * r.wins : 0), 0);
  const totalGrossLosses = records.reduce((a, r) =>
    a + (r.avgRMultiple < 0 ? Math.abs(r.avgRMultiple) * r.losses : r.losses * 1), 0);
  const profitFactor = totalGrossLosses > 0 ? totalGrossWins / totalGrossLosses : 0;

  // By regime
  const byRegime: Record<string, { winRate: number; pf: number; trades: number }> = {};
  for (const r of records) {
    if (!byRegime[r.regime]) byRegime[r.regime] = { winRate: 0, pf: 0, trades: 0 };
    byRegime[r.regime].trades += r.totalTrades;
    byRegime[r.regime].winRate = r.winRate;
    byRegime[r.regime].pf = isFinite(r.profitFactor) ? r.profitFactor : 0;
  }

  // By session
  const bySession: Record<string, { winRate: number; pf: number; trades: number }> = {};
  for (const r of records) {
    if (!bySession[r.session]) bySession[r.session] = { winRate: 0, pf: 0, trades: 0 };
    bySession[r.session].trades += r.totalTrades;
    bySession[r.session].winRate = r.winRate;
    bySession[r.session].pf = isFinite(r.profitFactor) ? r.profitFactor : 0;
  }

  return { totalTrades, winRate, profitFactor, expectancy: avgR, avgRMultiple: avgR, byRegime, bySession };
}

/** Get all patterns ranked by expectancy */
export async function getPatternRankings(): Promise<{
  pattern: string;
  totalTrades: number;
  winRate: number;
  expectancy: number;
  profitFactor: number;
}[]> {
  const db = getDB();
  const all = await db.edgeStats.toArray();

  // Group by pattern
  const grouped = new Map<string, EdgeStatsRecord[]>();
  for (const r of all) {
    if (!grouped.has(r.pattern)) grouped.set(r.pattern, []);
    grouped.get(r.pattern)!.push(r);
  }

  const rankings: { pattern: string; totalTrades: number; winRate: number; expectancy: number; profitFactor: number }[] = [];
  for (const [pattern, records] of Array.from(grouped.entries())) {
    const totalTrades = records.reduce((a, r) => a + r.totalTrades, 0);
    const totalWins = records.reduce((a, r) => a + r.wins, 0);
    const avgR = totalTrades > 0
      ? records.reduce((a, r) => a + r.avgRMultiple * r.totalTrades, 0) / totalTrades
      : 0;
    rankings.push({
      pattern,
      totalTrades,
      winRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
      expectancy: avgR,
      profitFactor: records.reduce((a, r) => a + (isFinite(r.profitFactor) ? r.profitFactor : 0), 0) / records.length,
    });
  }

  return rankings.sort((a, b) => b.expectancy - a.expectancy);
}

/** Get regime rankings — which regimes produce the most edge */
export async function getRegimeRankings(): Promise<{
  regime: MarketRegime;
  totalTrades: number;
  winRate: number;
  expectancy: number;
}[]> {
  const db = getDB();
  const all = await db.edgeStats.toArray();

  const grouped = new Map<MarketRegime, EdgeStatsRecord[]>();
  for (const r of all) {
    if (!grouped.has(r.regime)) grouped.set(r.regime, []);
    grouped.get(r.regime)!.push(r);
  }

  const rankings: { regime: MarketRegime; totalTrades: number; winRate: number; expectancy: number }[] = [];
  for (const [regime, records] of Array.from(grouped.entries())) {
    const totalTrades = records.reduce((a, r) => a + r.totalTrades, 0);
    const totalWins = records.reduce((a, r) => a + r.wins, 0);
    const avgR = totalTrades > 0
      ? records.reduce((a, r) => a + r.avgRMultiple * r.totalTrades, 0) / totalTrades
      : 0;
    rankings.push({
      regime,
      totalTrades,
      winRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
      expectancy: avgR,
    });
  }

  return rankings.sort((a, b) => b.expectancy - a.expectancy);
}

/** Get session rankings */
export async function getSessionRankings(): Promise<{
  session: TradingSession;
  totalTrades: number;
  winRate: number;
  expectancy: number;
}[]> {
  const db = getDB();
  const all = await db.edgeStats.toArray();

  const grouped = new Map<TradingSession, EdgeStatsRecord[]>();
  for (const r of all) {
    if (!grouped.has(r.session)) grouped.set(r.session, []);
    grouped.get(r.session)!.push(r);
  }

  const rankings: { session: TradingSession; totalTrades: number; winRate: number; expectancy: number }[] = [];
  for (const [session, records] of Array.from(grouped.entries())) {
    const totalTrades = records.reduce((a, r) => a + r.totalTrades, 0);
    const totalWins = records.reduce((a, r) => a + r.wins, 0);
    const avgR = totalTrades > 0
      ? records.reduce((a, r) => a + r.avgRMultiple * r.totalTrades, 0) / totalTrades
      : 0;
    rankings.push({
      session,
      totalTrades,
      winRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
      expectancy: avgR,
    });
  }

  return rankings.sort((a, b) => b.expectancy - a.expectancy);
}

/** Get the best setups overall by expected value */
export async function getBestSetups(limit = 10): Promise<EdgeStatsRecord[]> {
  const db = getDB();
  const all = await db.edgeStats.toArray();

  return all
    .filter(r => r.totalTrades >= 5) // minimum sample size
    .sort((a, b) => b.expectancy - a.expectancy)
    .slice(0, limit);
}

/** Get edge count */
export async function getEdgeCount(): Promise<number> {
  return await getDB().edgeStats.count();
}
