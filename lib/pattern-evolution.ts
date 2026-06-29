/**
 * TradeFlow V3 — Pattern Evolution (Phase 11)
 *
 * Automatically track and adjust pattern performance:
 *   - Trades > 100, PF < 0.9: DOWNGRADE
 *   - Trades > 200, PF < 0.8: DISABLE
 *   - Trades > 100, PF > 1.5: PROMOTE
 */

import { getDB, type PatternEvolutionRecord } from './db';
import { getPatternRankings } from './edge-database';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PatternStatus = 'active' | 'promoted' | 'downgraded' | 'disabled';

export interface PatternEvolutionState {
  pattern: string;
  status: PatternStatus;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  scoreMultiplier: number;
  history: PatternStatusChange[];
}

export interface PatternStatusChange {
  timestamp: number;
  fromStatus: PatternStatus;
  toStatus: PatternStatus;
  reason: string;
  metrics: {
    trades: number;
    winRate: number;
    profitFactor: number;
  };
}

// ─── Pattern Evolution Logic ──────────────────────────────────────────────────

/**
 * Evaluate all patterns and update their evolution status.
 * Called during each learning cycle.
 */
export async function evaluatePatternEvolution(): Promise<PatternEvolutionState[]> {
  const db = getDB();
  const rankings = await getPatternRankings();
  const results: PatternEvolutionState[] = [];

  for (const ranking of rankings) {
    const existing = await db.patternEvolution
      .where('pattern')
      .equals(ranking.pattern)
      .first();

    const currentStatus: PatternStatus = existing?.status ?? 'active';
    const currentMultiplier = existing?.scoreMultiplier ?? 1.0;
    const history: PatternStatusChange[] = existing?.history
      ? JSON.parse(existing.history)
      : [];

    let newStatus: PatternStatus = currentStatus;
    let newMultiplier = currentMultiplier;
    let changeReason = '';

    // ── Evaluation Rules ──────────────────────────────────────────
    if (ranking.totalTrades >= 200 && ranking.profitFactor < 0.8) {
      // DISABLE: 200+ trades, PF < 0.8
      if (currentStatus !== 'disabled') {
        newStatus = 'disabled';
        newMultiplier = 0;
        changeReason = `Disabled: ${ranking.totalTrades} trades, PF ${ranking.profitFactor.toFixed(2)} < 0.8`;
      }
    } else if (ranking.totalTrades >= 100 && ranking.profitFactor < 0.9) {
      // DOWNGRADE: 100+ trades, PF < 0.9
      if (currentStatus !== 'downgraded' && currentStatus !== 'disabled') {
        newStatus = 'downgraded';
        newMultiplier = 0.5;
        changeReason = `Downgraded: ${ranking.totalTrades} trades, PF ${ranking.profitFactor.toFixed(2)} < 0.9`;
      }
    } else if (ranking.totalTrades >= 100 && ranking.profitFactor > 1.5) {
      // PROMOTE: 100+ trades, PF > 1.5
      if (currentStatus !== 'promoted') {
        newStatus = 'promoted';
        newMultiplier = 1.3;
        changeReason = `Promoted: ${ranking.totalTrades} trades, PF ${ranking.profitFactor.toFixed(2)} > 1.5`;
      }
    } else if (ranking.totalTrades >= 50 && ranking.profitFactor > 1.2) {
      // Early promotion signal
      if (currentStatus === 'downgraded') {
        newStatus = 'active';
        newMultiplier = 1.0;
        changeReason = `Restored: performance recovering, PF ${ranking.profitFactor.toFixed(2)}`;
      }
    }

    // Record status change
    if (newStatus !== currentStatus) {
      history.push({
        timestamp: Date.now(),
        fromStatus: currentStatus,
        toStatus: newStatus,
        reason: changeReason,
        metrics: {
          trades: ranking.totalTrades,
          winRate: ranking.winRate,
          profitFactor: ranking.profitFactor,
        },
      });
    }

    // Fine-grained multiplier adjustment based on recent performance
    if (newStatus === 'active' || newStatus === 'promoted') {
      // Continuous adjustment between 0.7 and 1.5
      const perfRatio = ranking.profitFactor > 0 ? Math.min(2, ranking.profitFactor) : 0.5;
      const continuousMultiplier = 0.5 + perfRatio * 0.5;
      newMultiplier = Math.round(continuousMultiplier * 100) / 100;
    }

    // Save
    const state: PatternEvolutionState = {
      pattern: ranking.pattern,
      status: newStatus,
      totalTrades: ranking.totalTrades,
      winRate: ranking.winRate,
      profitFactor: ranking.profitFactor,
      expectancy: ranking.expectancy,
      scoreMultiplier: newMultiplier,
      history,
    };

    if (existing) {
      await db.patternEvolution.update(existing.id!, {
        status: newStatus,
        totalTrades: ranking.totalTrades,
        currentWinRate: ranking.winRate,
        currentProfitFactor: ranking.profitFactor,
        currentExpectancy: ranking.expectancy,
        currentSharpe: 0,
        currentRecoveryFactor: 0,
        scoreMultiplier: newMultiplier,
        lastUpdated: Date.now(),
        history: JSON.stringify(history),
      });
    } else {
      await db.patternEvolution.add({
        pattern: ranking.pattern,
        status: newStatus,
        totalTrades: ranking.totalTrades,
        currentWinRate: ranking.winRate,
        currentProfitFactor: ranking.profitFactor,
        currentExpectancy: ranking.expectancy,
        currentSharpe: 0,
        currentRecoveryFactor: 0,
        scoreMultiplier: newMultiplier,
        lastUpdated: Date.now(),
        history: JSON.stringify(history),
      });
    }

    results.push(state);
  }

  return results;
}

/** Get the current score multiplier for a pattern */
export async function getPatternMultiplier(pattern: string): Promise<number> {
  const db = getDB();
  const record = await db.patternEvolution
    .where('pattern')
    .equals(pattern)
    .first();
  return record?.scoreMultiplier ?? 1.0;
}

/** Get all pattern evolution states */
export async function getAllPatternStates(): Promise<PatternEvolutionState[]> {
  const db = getDB();
  const records = await db.patternEvolution.toArray();
  return records.map(r => ({
    pattern: r.pattern,
    status: r.status as PatternStatus,
    totalTrades: r.totalTrades,
    winRate: r.currentWinRate,
    profitFactor: r.currentProfitFactor,
    expectancy: r.currentExpectancy,
    scoreMultiplier: r.scoreMultiplier,
    history: safeParseHistory(r.history),
  }));
}

/** Check if a pattern is disabled */
export async function isPatternDisabled(pattern: string): Promise<boolean> {
  const db = getDB();
  const record = await db.patternEvolution
    .where('pattern')
    .equals(pattern)
    .first();
  return record?.status === 'disabled';
}

function safeParseHistory(json: string): PatternStatusChange[] {
  try { return JSON.parse(json); }
  catch { return []; }
}
