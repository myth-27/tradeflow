/**
 * TradeFlow — Edge Registry (Knowledge Hierarchy)
 *
 * A thin layer on top of lib/edge-database.ts (which owns the actual edgeStats table and
 * update logic) adding:
 *   - getEdgeEstimate(): the knowledge hierarchy — TradeFlow's own data overrides book/reference
 *     stats once there are enough samples, blends in the 20-199 sample range, and falls back to
 *     book stats alone below that.
 *   - getTopEdges / getWorstEdges / getEmergingEdges / getPatternWeightMultiplier — read-side
 *     queries used by the nightly intelligence report and (optionally) signal scoring.
 *
 * This deliberately does NOT introduce a second edge-tracking table — see lib/edge-database.ts
 * for the actual write path (updateEdgeAfterOutcome for live signals, updateEdgeFromSimTrade
 * for simulator trades), both of which write to the same db.edgeStats Dexie table.
 */

import { getDB, type EdgeStatsRecord, type EdgeStatus, type MarketRegime, type TradingSession } from './db';
import { getEdge } from './edge-database';
import { PATTERN_KNOWLEDGE_BASE } from './pattern-knowledge';

// ─── Book Stats — knowledge-base-first, with a general-reference fallback ────
// Patterns with a real historicalWinRate extracted from data_patterns/ (see
// lib/pattern-knowledge.ts) use that number. Patterns the project's own source PDFs didn't
// give numbers for fall back to commonly-cited general pattern-statistics reference figures —
// these are NOT verified against any document in this project, unlike pattern-knowledge.ts's
// numbers, and are clearly labeled as such in the returned source string.

interface BookStats {
  winRate: number; // 0-100
  profitFactor: number;
  avgWin: number;
  source: string;
}

const GENERAL_REFERENCE_STATS: Record<string, Omit<BookStats, 'source'>> = {
  'Double Top': { winRate: 83, profitFactor: 1.8, avgWin: 1.5 },
  'Double Bottom': { winRate: 78, profitFactor: 1.6, avgWin: 1.4 },
  'Inverse Head & Shoulders': { winRate: 83, profitFactor: 1.9, avgWin: 1.6 },
  'Triple Top': { winRate: 85, profitFactor: 2.0, avgWin: 1.7 },
  'Triple Bottom': { winRate: 80, profitFactor: 1.7, avgWin: 1.5 },
  'Descending Triangle': { winRate: 72, profitFactor: 1.5, avgWin: 1.3 },
  'Bull Flag': { winRate: 67, profitFactor: 1.4, avgWin: 1.3 },
  'Bear Flag': { winRate: 67, profitFactor: 1.4, avgWin: 1.3 },
  'Cup and Handle': { winRate: 65, profitFactor: 1.4, avgWin: 1.4 },
  'Rectangle': { winRate: 60, profitFactor: 1.3, avgWin: 1.2 },
  'Wedge Rising': { winRate: 55, profitFactor: 1.1, avgWin: 1.1 },
  'Wedge Falling': { winRate: 55, profitFactor: 1.1, avgWin: 1.1 },
};

function getBookStats(pattern: string): BookStats {
  const knowledge = PATTERN_KNOWLEDGE_BASE[pattern];
  if (knowledge && knowledge.historicalWinRate > 0) {
    return {
      winRate: knowledge.historicalWinRate,
      profitFactor: knowledge.historicalWinRate >= 80 ? 1.8 : knowledge.historicalWinRate >= 70 ? 1.5 : 1.2,
      avgWin: 1.4,
      source: `data_patterns/ extraction (${knowledge.sources[0]})`,
    };
  }
  const general = GENERAL_REFERENCE_STATS[pattern];
  if (general) {
    return { ...general, source: 'General reference stats (not from this project\'s source PDFs)' };
  }
  return { winRate: 55, profitFactor: 1.1, avgWin: 1.1, source: 'Default (no data available)' };
}

// ─── Knowledge Hierarchy ──────────────────────────────────────────────────

export interface EdgeEstimate {
  winRate: number; // 0-1 fraction
  profitFactor: number;
  expectancy: number;
  sampleSize: number;
  source: 'tradeflow' | 'blended' | 'book_with_early_tradeflow' | 'book';
  confidence: 'high' | 'medium' | 'low' | 'book_only';
  status: EdgeStatus;
  bookSource: string;
  earlyTradeFlowWR?: number;
}

export async function getEdgeEstimate(params: {
  pattern: string;
  symbol: string;
  timeframe: string;
  regime: MarketRegime;
  session: TradingSession;
}): Promise<EdgeEstimate> {
  const record = await getEdge(params.pattern, params.symbol, params.timeframe, params.session, params.regime);
  const book = getBookStats(params.pattern);

  if (record && record.totalTrades >= 200) {
    return {
      winRate: record.winRate / 100,
      profitFactor: record.profitFactor,
      expectancy: record.expectancy,
      sampleSize: record.totalTrades,
      source: 'tradeflow',
      confidence: 'high',
      status: record.status ?? 'confident',
      bookSource: book.source,
    };
  }

  if (record && record.totalTrades >= 50) {
    const weight = Math.min(1, record.totalTrades / 200);
    return {
      winRate: (record.winRate / 100) * weight + (book.winRate / 100) * (1 - weight),
      profitFactor: record.profitFactor * weight + book.profitFactor * (1 - weight),
      expectancy: record.expectancy,
      sampleSize: record.totalTrades,
      source: 'blended',
      confidence: 'medium',
      status: record.status ?? 'active',
      bookSource: book.source,
    };
  }

  if (record && record.totalTrades >= 20) {
    return {
      winRate: book.winRate / 100,
      profitFactor: book.profitFactor,
      expectancy: record.expectancy,
      sampleSize: record.totalTrades,
      source: 'book_with_early_tradeflow',
      confidence: 'low',
      status: record.status ?? 'emerging',
      bookSource: book.source,
      earlyTradeFlowWR: record.winRate / 100,
    };
  }

  return {
    winRate: book.winRate / 100,
    profitFactor: book.profitFactor,
    expectancy: (book.winRate / 100) * book.avgWin - (1 - book.winRate / 100) * 1.0,
    sampleSize: record?.totalTrades ?? 0,
    source: 'book',
    confidence: 'book_only',
    status: record?.status ?? 'learning',
    bookSource: book.source,
  };
}

// ─── Read-side Queries ─────────────────────────────────────────────────────

export async function getTopEdges(limit = 10): Promise<EdgeStatsRecord[]> {
  const db = getDB();
  const all = await db.edgeStats
    .filter(r => r.totalTrades >= 20 && r.status !== 'disabled')
    .toArray();
  return all.sort((a, b) => b.profitFactor - a.profitFactor).slice(0, limit);
}

export async function getWorstEdges(limit = 5): Promise<EdgeStatsRecord[]> {
  const db = getDB();
  const all = await db.edgeStats.filter(r => r.totalTrades >= 20).toArray();
  return all.sort((a, b) => a.profitFactor - b.profitFactor).slice(0, limit);
}

/** Edges where the last-20-trade win rate is notably better than the lifetime win rate. */
export async function getEmergingEdges(): Promise<EdgeStatsRecord[]> {
  const db = getDB();
  const all = await db.edgeStats.filter(r => r.totalTrades >= 30).toArray();
  return all.filter(r => {
    const last20 = r.last20WinRate ?? 0;
    const lifetime = r.winRate / 100;
    const recentBetter = last20 > lifetime + 0.15;
    const recentPFEstimate = last20 * 2.0;
    return recentBetter && recentPFEstimate > 1.4;
  });
}

/** Weight multiplier for a pattern+context combination, used by signal scoring. */
export async function getPatternWeightMultiplier(
  pattern: string,
  regime: MarketRegime,
  session: TradingSession,
  symbol: string,
  timeframe: string,
): Promise<number> {
  const record = await getEdge(pattern, symbol, timeframe, session, regime);
  if (!record || record.totalTrades < 20) return 1.0;

  if (record.status === 'disabled') return 0.0;
  if (record.status === 'promoted') return 1.5;
  if (record.status === 'degraded') return 0.6;
  if (record.recentTrend === 'improving') return 1.2;
  if (record.recentTrend === 'degrading') return 0.8;

  if (record.profitFactor > 1.8) return 1.4;
  if (record.profitFactor > 1.4) return 1.2;
  if (record.profitFactor < 0.9) return 0.7;

  return 1.0;
}

export type PatternEdgeHint = { winRate: number; profitFactor: number; sampleSize: number };

function aggregateHint(records: EdgeStatsRecord[]): PatternEdgeHint | null {
  const sampleSize = records.reduce((a, r) => a + r.totalTrades, 0);
  if (sampleSize === 0) return null;
  const totalWins = records.reduce((a, r) => a + r.wins, 0);
  const totalGrossWins = records.reduce((a, r) => a + (r.grossWins ?? 0), 0);
  const totalGrossLosses = records.reduce((a, r) => a + (r.grossLosses ?? 0), 0);
  return {
    winRate: (totalWins / sampleSize) * 100,
    profitFactor: totalGrossLosses > 0 ? totalGrossWins / totalGrossLosses : (totalGrossWins > 0 ? 9.99 : 0),
    sampleSize,
  };
}

/**
 * Aggregates ALL edgeStats records by pattern — the self-learning feedback signal
 * runSimulation() uses to discount patterns whose claimed confidence has empirically not
 * matched their real outcomes (and reward ones that have outperformed), instead of trusting
 * static book/pattern confidence forever.
 *
 * Returns hints at THREE granularities in the same map: a pattern+symbol+timeframe-specific key
 * ("Double Bottom|SOLUSDT|5m"), a pattern+timeframe key ("Double Bottom|5m"), and a cross-symbol
 * cross-timeframe fallback ("Double Bottom"). A pattern can have a very different real track
 * record per symbol (Double Bottom was 10% WR on SOL specifically vs much better blended across
 * BTC/ETH) and per timeframe (1h vs 5m) — blending any of these together dilutes the signal in
 * both directions. The caller should prefer the most specific key with enough samples and fall
 * back progressively coarser otherwise.
 */
export async function getPatternEdgeHints(): Promise<Record<string, PatternEdgeHint>> {
  const db = getDB();
  const all = await db.edgeStats.toArray();

  const byPattern = new Map<string, EdgeStatsRecord[]>();
  const byPatternTimeframe = new Map<string, EdgeStatsRecord[]>();
  const byPatternSymbolTimeframe = new Map<string, EdgeStatsRecord[]>();
  for (const r of all) {
    if (!byPattern.has(r.pattern)) byPattern.set(r.pattern, []);
    byPattern.get(r.pattern)!.push(r);

    const tfKey = `${r.pattern}|${r.timeframe}`;
    if (!byPatternTimeframe.has(tfKey)) byPatternTimeframe.set(tfKey, []);
    byPatternTimeframe.get(tfKey)!.push(r);

    const symTfKey = `${r.pattern}|${r.symbol}|${r.timeframe}`;
    if (!byPatternSymbolTimeframe.has(symTfKey)) byPatternSymbolTimeframe.set(symTfKey, []);
    byPatternSymbolTimeframe.get(symTfKey)!.push(r);
  }

  const hints: Record<string, PatternEdgeHint> = {};
  for (const [pattern, records] of Array.from(byPattern.entries())) {
    const hint = aggregateHint(records);
    if (hint) hints[pattern] = hint;
  }
  for (const [tfKey, records] of Array.from(byPatternTimeframe.entries())) {
    const hint = aggregateHint(records);
    if (hint) hints[tfKey] = hint;
  }
  for (const [symTfKey, records] of Array.from(byPatternSymbolTimeframe.entries())) {
    const hint = aggregateHint(records);
    if (hint) hints[symTfKey] = hint;
  }
  return hints;
}
