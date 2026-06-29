/**
 * TradeFlow — Nightly Intelligence Report (Phase 14)
 *
 * Summarizes top/worst/emerging edges from the edgeStats table (fed by both live trading and
 * the simulator — see lib/edge-database.ts) and derives weight adjustments. Saved to the new
 * intelligenceReports table; read back by app/intelligence/page.tsx.
 */

import { getDB, type EdgeStatsRecord, type IntelligenceReportEntry, type IntelligenceReportRecord, type IntelligenceWeightAdjustment } from './db';
import { getTopEdges, getWorstEdges, getEmergingEdges } from './edge-registry';

export type IntelligenceReport = Omit<IntelligenceReportRecord, 'id'>;

function toEntry(r: EdgeStatsRecord, badge: IntelligenceReportEntry['badge']): IntelligenceReportEntry {
  return {
    label: `${r.pattern} · ${r.symbol} · ${r.session}`,
    pattern: r.pattern,
    symbol: r.symbol,
    timeframe: r.timeframe,
    regime: r.regime,
    session: r.session,
    sampleSize: r.totalTrades,
    winRate: r.winRate / 100,
    profitFactor: r.profitFactor,
    expectancy: r.expectancy,
    trend: r.recentTrend ?? 'stable',
    badge,
  };
}

export async function generateIntelligenceReport(): Promise<IntelligenceReport> {
  const db = getDB();

  const [topEdges, worstEdges, emergingEdges] = await Promise.all([
    getTopEdges(5),
    getWorstEdges(5),
    getEmergingEdges(),
  ]);

  const topPerforming = topEdges.map(r => toEntry(r, '🏆'));
  const worstPerforming = worstEdges.filter(r => r.profitFactor < 1.0).map(r => toEntry(r, '📉'));
  const emergingEdge = emergingEdges.map(r => toEntry(r, '🚀'));

  const weightAdjustments: IntelligenceWeightAdjustment[] = [];
  const disabledPatterns: string[] = [];
  const promotedPatterns: string[] = [];

  const allEdges = await db.edgeStats.toArray();

  for (const r of allEdges) {
    if (r.status === 'disabled') {
      disabledPatterns.push(`${r.pattern} (${r.symbol} ${r.regime})`);
      weightAdjustments.push({
        pattern: r.pattern, regime: r.regime, session: r.session,
        previousWeight: 1.0, newWeight: 0.0,
        reason: `Disabled: PF ${r.profitFactor.toFixed(2)} < 0.8 over ${r.totalTrades} trades`,
      });
    } else if (r.status === 'promoted') {
      promotedPatterns.push(`${r.pattern} (${r.symbol} ${r.regime})`);
      weightAdjustments.push({
        pattern: r.pattern, regime: r.regime, session: r.session,
        previousWeight: 1.0, newWeight: 1.5,
        reason: `Promoted: PF ${r.profitFactor.toFixed(2)} > 1.8 over ${r.totalTrades} trades`,
      });
    } else if (r.status === 'degraded') {
      weightAdjustments.push({
        pattern: r.pattern, regime: r.regime, session: r.session,
        previousWeight: 1.0, newWeight: 0.6,
        reason: `Degraded: PF ${r.profitFactor.toFixed(2)} < 0.9`,
      });
    }
  }

  const insights: string[] = [];

  if (topEdges[0]) {
    const t = topEdges[0];
    insights.push(`🏆 Best edge: ${t.pattern} in ${t.regime} during ${t.session} — ${t.winRate.toFixed(0)}% win rate, ${t.profitFactor.toFixed(2)} PF (${t.totalTrades} trades)`);
  }
  if (worstEdges[0] && worstEdges[0].profitFactor < 0.9) {
    const w = worstEdges[0];
    insights.push(`⚠️ Avoid: ${w.pattern} in ${w.regime} during ${w.session} — only ${w.winRate.toFixed(0)}% win rate, PF ${w.profitFactor.toFixed(2)} (${w.totalTrades} trades)`);
  }
  if (emergingEdges[0]) {
    const e = emergingEdges[0];
    insights.push(`🚀 Emerging: ${e.pattern} recent win rate ${((e.last20WinRate ?? 0) * 100).toFixed(0)}% vs lifetime ${e.winRate.toFixed(0)}% — improving`);
  }
  if (disabledPatterns.length > 0) {
    insights.push(`🚫 Auto-disabled ${disabledPatterns.length} underperforming combination(s): ${disabledPatterns.slice(0, 2).join(', ')}`);
  }
  if (insights.length === 0) {
    insights.push('Not enough data yet — run more simulations (need 20+ trades per pattern/regime/session combo for the first insights).');
  }

  const activeEdges = allEdges.filter(r => r.totalTrades >= 20 && r.status !== 'disabled');
  const profitableEdges = activeEdges.filter(r => r.profitFactor > 1.0);
  const overallHealthScore = activeEdges.length > 0
    ? Math.round((profitableEdges.length / activeEdges.length) * 100)
    : 50;

  const report: IntelligenceReport = {
    generatedAt: Date.now(),
    tradesSinceLastReport: allEdges.reduce((a, r) => a + r.totalTrades, 0),
    topPerforming,
    worstPerforming,
    emergingEdge,
    weightAdjustments,
    disabledPatterns,
    promotedPatterns,
    insights,
    overallHealthScore,
  };

  await db.intelligenceReports.add(report as IntelligenceReportRecord);
  return report;
}

export async function getLatestReport(): Promise<IntelligenceReportRecord | null> {
  const db = getDB();
  const reports = await db.intelligenceReports.orderBy('generatedAt').reverse().limit(1).toArray();
  return reports[0] ?? null;
}

export async function getReportHistory(limit = 10): Promise<IntelligenceReportRecord[]> {
  const db = getDB();
  return db.intelligenceReports.orderBy('generatedAt').reverse().limit(limit).toArray();
}
