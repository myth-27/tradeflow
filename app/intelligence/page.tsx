'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { generateIntelligenceReport, getLatestReport } from '@/lib/intelligence-report';
import { getSnapshotStats } from '@/lib/candle-snapshot-store';
import { getDB, exportDatabase, type IntelligenceReportRecord, type EdgeStatsRecord } from '@/lib/db';

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function fmtPct(n: number) {
  return `${n.toFixed(0)}%`;
}

function HealthBadge({ score }: { score: number }) {
  const color = score >= 70 ? '#22c55e' : score >= 40 ? '#f59e0b' : '#ef4444';
  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5 flex items-center justify-between">
      <div>
        <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1">Overall Health Score</div>
        <div className="text-[28px] font-mono font-bold" style={{ color }}>{score}/100</div>
      </div>
      <div className="text-[11px] text-[#888888] max-w-[260px] text-right">
        Share of active (20+ sample) edges with a profit factor above 1.0.
      </div>
    </div>
  );
}

function EdgeEntryRow({ e }: { e: IntelligenceReportRecord['topPerforming'][number] }) {
  return (
    <div className="flex items-center justify-between bg-[#1a1a1a] rounded-lg px-3 py-2 text-[12px]">
      <span className="flex items-center gap-2">
        <span>{e.badge}</span>
        <span className="text-[#f5f5f5]">{e.label}</span>
      </span>
      <span className="flex gap-4 font-mono text-[#888888]">
        <span>{e.sampleSize} trades</span>
        <span style={{ color: e.profitFactor >= 1 ? '#22c55e' : '#ef4444' }}>PF {e.profitFactor.toFixed(2)}</span>
        <span>{fmtPct(e.winRate * 100)} WR</span>
      </span>
    </div>
  );
}

export default function IntelligencePage() {
  const [report, setReport] = useState<IntelligenceReportRecord | null>(null);
  const [allEdges, setAllEdges] = useState<EdgeStatsRecord[]>([]);
  const [snapshotStats, setSnapshotStats] = useState<Awaited<ReturnType<typeof getSnapshotStats>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const load = async () => {
    setLoading(true);
    const [latest, edges, snaps] = await Promise.all([
      getLatestReport(),
      getDB().edgeStats.toArray(),
      getSnapshotStats(),
    ]);
    setReport(latest);
    setAllEdges(edges);
    setSnapshotStats(snaps);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleGenerate = async () => {
    setGenerating(true);
    const fresh = await generateIntelligenceReport();
    setReport(fresh as IntelligenceReportRecord);
    const edges = await getDB().edgeStats.toArray();
    setAllEdges(edges);
    setGenerating(false);
  };

  const sortedEdges = useMemo(() => [...allEdges].sort((a, b) => b.totalTrades - a.totalTrades), [allEdges]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f5f5f5]">
      <div className="max-w-[1100px] mx-auto px-6 py-8">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black">🧠 Intelligence Report</h1>
            <p className="text-[13px] text-[#888888] mt-1">Edge registry derived from every live signal and simulated trade — pattern × symbol × timeframe × regime × session.</p>
          </div>
          <Link href="/simulate" className="text-[12px] text-[#3b82f6] hover:underline flex-shrink-0">← Back to Simulator</Link>
        </header>

        {loading && <div className="text-[#888888] text-[13px]">Loading…</div>}

        {!loading && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="text-[12px] text-[#666]">
                {report ? `Last generated ${new Date(report.generatedAt).toLocaleString()}` : 'No report generated yet'}
              </div>
              <div className="flex gap-2">
                <button onClick={async () => downloadFile(JSON.stringify(await exportDatabase(), null, 2), `tradeflow-backup-${Date.now()}.json`, 'application/json')}
                  className="px-4 py-2 rounded-lg bg-[#1a1a1a] border border-[#222] text-[#f5f5f5] text-[13px] font-semibold hover:border-[#3b82f6]">
                  ⬇ Export Full Backup
                </button>
                <button onClick={handleGenerate} disabled={generating}
                  className="px-4 py-2 rounded-lg bg-[#3b82f6] text-white text-[13px] font-semibold disabled:opacity-50">
                  {generating ? 'Generating…' : '↻ Generate Report Now'}
                </button>
              </div>
            </div>

            {!report && (
              <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-8 text-center">
                <p className="text-[14px] text-[#888888]">No intelligence report yet. Run some simulations, then click &quot;Generate Report Now&quot;.</p>
              </div>
            )}

            {report && (
              <>
                <HealthBadge score={report.overallHealthScore} />

                <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
                  <div className="text-[14px] font-semibold mb-3">Insights</div>
                  <ul className="space-y-2">
                    {report.insights.map((line, i) => (
                      <li key={i} className="text-[12px] text-[#cccccc]">{line}</li>
                    ))}
                  </ul>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
                    <div className="text-[14px] font-semibold mb-3">🏆 Top Edges</div>
                    <div className="space-y-2">
                      {report.topPerforming.length === 0 && <p className="text-[12px] text-[#666]">No edges with 20+ samples yet.</p>}
                      {report.topPerforming.map((e, i) => <EdgeEntryRow key={i} e={e} />)}
                    </div>
                  </div>
                  <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
                    <div className="text-[14px] font-semibold mb-3">📉 Worst Edges</div>
                    <div className="space-y-2">
                      {report.worstPerforming.length === 0 && <p className="text-[12px] text-[#666]">No underperforming edges (PF &lt; 1.0) yet.</p>}
                      {report.worstPerforming.map((e, i) => <EdgeEntryRow key={i} e={e} />)}
                    </div>
                  </div>
                </div>

                {report.emergingEdge.length > 0 && (
                  <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
                    <div className="text-[14px] font-semibold mb-3">🚀 Emerging Edges</div>
                    <div className="space-y-2">
                      {report.emergingEdge.map((e, i) => <EdgeEntryRow key={i} e={e} />)}
                    </div>
                  </div>
                )}

                {report.weightAdjustments.length > 0 && (
                  <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
                    <div className="text-[14px] font-semibold mb-3">Weight Adjustments</div>
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="text-[9px] text-[#666] uppercase text-left border-b border-[#1f1f1f]">
                          <th className="py-1.5">Pattern</th><th>Regime</th><th>Session</th><th>Weight</th><th>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.weightAdjustments.map((w, i) => (
                          <tr key={i} className="border-b border-[rgba(26,26,26,0.5)]">
                            <td className="py-1.5">{w.pattern}</td>
                            <td className="font-mono">{w.regime}</td>
                            <td className="font-mono">{w.session}</td>
                            <td className={`font-mono ${w.newWeight > w.previousWeight ? 'text-[#22c55e]' : w.newWeight < w.previousWeight ? 'text-[#ef4444]' : ''}`}>{w.previousWeight.toFixed(1)}x → {w.newWeight.toFixed(1)}x</td>
                            <td className="text-[#888888]">{w.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
              <div className="text-[14px] font-semibold mb-3">All Edge Combinations ({sortedEdges.length})</div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] min-w-[800px]">
                  <thead>
                    <tr className="text-[9px] text-[#666] uppercase text-left border-b border-[#1f1f1f]">
                      <th className="py-1.5">Pattern</th><th>Symbol</th><th>TF</th><th>Regime</th><th>Session</th><th>Trades</th><th>Win Rate</th><th>PF</th><th>Status</th><th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedEdges.slice(0, 50).map((e, i) => (
                      <tr key={i} className="border-b border-[rgba(26,26,26,0.5)]">
                        <td className="py-1.5">{e.pattern}</td>
                        <td className="font-mono">{e.symbol}</td>
                        <td className="font-mono">{e.timeframe}</td>
                        <td className="font-mono">{e.regime}</td>
                        <td className="font-mono">{e.session}</td>
                        <td className="font-mono">{e.totalTrades}</td>
                        <td className="font-mono">{e.winRate.toFixed(0)}%</td>
                        <td className={`font-mono ${e.profitFactor >= 1 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>{e.profitFactor.toFixed(2)}</td>
                        <td className="font-mono">{e.status ?? 'learning'}</td>
                        <td className="font-mono text-[#666]">{e.dataSource ?? '—'}</td>
                      </tr>
                    ))}
                    {sortedEdges.length === 0 && <tr><td colSpan={10} className="py-4 text-center text-[#555]">No edge data yet — run a simulation first.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            {snapshotStats && (
              <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
                <div className="text-[14px] font-semibold mb-3">📸 Candle Snapshot Store</div>
                <div className="grid grid-cols-4 gap-4 text-[12px] mb-3">
                  <div><span className="text-[#666]">Total: </span><span className="font-mono text-[#f5f5f5]">{snapshotStats.total}</span></div>
                  <div><span className="text-[#666]">Completed: </span><span className="font-mono text-[#f5f5f5]">{snapshotStats.withOutcome}</span></div>
                  <div><span className="text-[#666]">Wins: </span><span className="font-mono text-[#22c55e]">{snapshotStats.wins}</span></div>
                  <div><span className="text-[#666]">Losses: </span><span className="font-mono text-[#ef4444]">{snapshotStats.losses}</span></div>
                </div>
                <p className="text-[11px] text-[#888888]">{snapshotStats.recommendation}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
