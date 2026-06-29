/**
 * TradeFlow V3 — Continuous Improvement Engine (Phase 15)
 *
 * Periodic learning job that updates everything:
 *   - Feature Importance
 *   - Pattern Rankings
 *   - Session Rankings
 *   - Regime Rankings
 *   - Dynamic Weights
 *   - Edge Models
 *   - Pattern Evolution
 *   - Meta Model
 *
 * Generates a "What Changed Today" report.
 */

import { runLearningCycle, type LearningResult } from './self-learning-engine';
import { recalculateWeights, getCurrentWeights } from './dynamic-weights';
import { calculateFeatureImportance, type FeatureRanking } from './feature-importance';
import { evaluatePatternEvolution, type PatternEvolutionState } from './pattern-evolution';
import { rebuildEdgeDatabase } from './edge-database';
import { retrainModel } from './meta-model';
import { getPatternRankings, getRegimeRankings, getSessionRankings } from './edge-database';
import { getMemoryStats } from './db';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImprovementReport {
  timestamp: number;
  durationMs: number;

  // Memory state
  memoryStats: {
    totalSignals: number;
    totalSimulations: number;
    totalEdgeEntries: number;
    totalLearningCycles: number;
  };

  // What changed
  learningResult: LearningResult;
  featureImportance: FeatureRanking[];
  patternEvolution: PatternEvolutionState[];

  // Rankings
  topPatterns: { pattern: string; expectancy: number; winRate: number; trades: number }[];
  topRegimes: { regime: string; expectancy: number; winRate: number }[];
  topSessions: { session: string; expectancy: number; winRate: number }[];

  // Significant changes
  changes: ChangeEntry[];
}

export interface ChangeEntry {
  category: 'pattern' | 'weight' | 'feature' | 'regime' | 'session' | 'model';
  description: string;
  impact: 'positive' | 'negative' | 'neutral';
  magnitude: 'high' | 'medium' | 'low';
}

// ─── Improvement Job ──────────────────────────────────────────────────────────

/**
 * Run the full continuous improvement cycle.
 * This is the "nightly learning job" that updates everything.
 *
 * Can be triggered:
 *   - Automatically when sufficient new data exists (every 50 trades)
 *   - Manually via the UI button
 */
export async function runImprovementCycle(): Promise<ImprovementReport> {
  const startTime = Date.now();
  const changes: ChangeEntry[] = [];

  // 1. Get weights before update for comparison
  const weightsBefore = await getCurrentWeights();

  // 2. Run the core learning cycle
  const learningResult = await runLearningCycle('improvement_cycle');

  // Record learning findings as changes
  for (const finding of learningResult.findings) {
    if (finding.significance === 'high') {
      changes.push({
        category: 'pattern',
        description: finding.description,
        impact: finding.category === 'working' || finding.category === 'improving' ? 'positive' : 'negative',
        magnitude: 'high',
      });
    }
  }

  // 3. Update dynamic weights
  const newWeights = await recalculateWeights();

  // Record weight changes
  const weightFields: (keyof typeof newWeights)[] = [
    'volume', 'rsi', 'macd', 'atr', 'regime', 'session',
  ];
  for (const field of weightFields) {
    const before = weightsBefore[field] as number;
    const after = newWeights[field] as number;
    const delta = after - before;
    if (Math.abs(delta) > 2) {
      changes.push({
        category: 'weight',
        description: `${field} weight: ${before.toFixed(1)} → ${after.toFixed(1)} (${delta > 0 ? '+' : ''}${delta.toFixed(1)})`,
        impact: 'neutral',
        magnitude: Math.abs(delta) > 5 ? 'high' : 'medium',
      });
    }
  }

  // 4. Update feature importance
  const featureImportance = await calculateFeatureImportance();

  // 5. Evaluate pattern evolution
  const patternEvolution = await evaluatePatternEvolution();

  for (const pe of patternEvolution) {
    if (pe.status === 'promoted') {
      changes.push({
        category: 'pattern',
        description: `${pe.pattern} PROMOTED — PF ${pe.profitFactor.toFixed(2)}, ${pe.totalTrades} trades`,
        impact: 'positive',
        magnitude: 'high',
      });
    } else if (pe.status === 'disabled') {
      changes.push({
        category: 'pattern',
        description: `${pe.pattern} DISABLED — PF ${pe.profitFactor.toFixed(2)}, ${pe.totalTrades} trades`,
        impact: 'negative',
        magnitude: 'high',
      });
    } else if (pe.status === 'downgraded') {
      changes.push({
        category: 'pattern',
        description: `${pe.pattern} downgraded — PF ${pe.profitFactor.toFixed(2)}, ${pe.totalTrades} trades`,
        impact: 'negative',
        magnitude: 'medium',
      });
    }
  }

  // 6. Rebuild edge database
  await rebuildEdgeDatabase();

  // 7. Retrain meta model
  await retrainModel();
  changes.push({
    category: 'model',
    description: 'Meta model retrained on latest data',
    impact: 'neutral',
    magnitude: 'low',
  });

  // 8. Get current rankings
  const patternRankings = await getPatternRankings();
  const regimeRankings = await getRegimeRankings();
  const sessionRankings = await getSessionRankings();

  // 9. Get memory stats
  const memStats = await getMemoryStats();

  const report: ImprovementReport = {
    timestamp: Date.now(),
    durationMs: Date.now() - startTime,
    memoryStats: {
      totalSignals: memStats.signals,
      totalSimulations: memStats.simulations,
      totalEdgeEntries: memStats.edgeEntries,
      totalLearningCycles: memStats.learningCycles,
    },
    learningResult,
    featureImportance,
    patternEvolution,
    topPatterns: patternRankings.slice(0, 5).map(p => ({
      pattern: p.pattern,
      expectancy: p.expectancy,
      winRate: p.winRate,
      trades: p.totalTrades,
    })),
    topRegimes: regimeRankings.slice(0, 3).map(r => ({
      regime: r.regime,
      expectancy: r.expectancy,
      winRate: r.winRate,
    })),
    topSessions: sessionRankings.slice(0, 3).map(s => ({
      session: s.session,
      expectancy: s.expectancy,
      winRate: s.winRate,
    })),
    changes,
  };

  return report;
}

/**
 * Generate a human-readable "What Changed" summary.
 */
export function formatImprovementReport(report: ImprovementReport): string {
  const lines: string[] = [
    '═══════════════════════════════════════',
    '  TRADEFLOW LEARNING REPORT',
    `  ${new Date(report.timestamp).toLocaleString()}`,
    '═══════════════════════════════════════',
    '',
    '📊 MEMORY',
    `  Signals stored: ${report.memoryStats.totalSignals.toLocaleString()}`,
    `  Simulations: ${report.memoryStats.totalSimulations}`,
    `  Edge entries: ${report.memoryStats.totalEdgeEntries}`,
    `  Learning cycles: ${report.memoryStats.totalLearningCycles}`,
    '',
  ];

  if (report.changes.length > 0) {
    lines.push('🔄 WHAT CHANGED');
    for (const c of report.changes) {
      const icon = c.impact === 'positive' ? '✅' : c.impact === 'negative' ? '⚠️' : 'ℹ️';
      lines.push(`  ${icon} ${c.description}`);
    }
    lines.push('');
  }

  if (report.topPatterns.length > 0) {
    lines.push('🏆 TOP PATTERNS');
    for (const p of report.topPatterns) {
      lines.push(`  ${p.pattern}: ${p.expectancy.toFixed(2)}R exp, ${p.winRate.toFixed(0)}% WR (${p.trades} trades)`);
    }
    lines.push('');
  }

  if (report.featureImportance.length > 0) {
    lines.push('📈 FEATURE IMPORTANCE');
    for (const f of report.featureImportance.slice(0, 5)) {
      const bar = '█'.repeat(Math.round(f.importance / 5));
      lines.push(`  ${f.description.padEnd(20)} ${bar} ${f.importance}%`);
    }
    lines.push('');
  }

  lines.push(`⏱️ Completed in ${report.durationMs}ms`);
  lines.push('═══════════════════════════════════════');

  return lines.join('\n');
}
