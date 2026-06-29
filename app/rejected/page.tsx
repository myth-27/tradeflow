'use client';

import React, { useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  analyzeRejectedSignals,
  buildAnalysisReport,
  clearAnalysisProgress,
  type RejectionAnalysisReport,
  type RejectedSignalOutcome,
  type DiscoveredEdge,
  type Recommendation,
} from '@/lib/rejected-signal-analyzer';

// ─── Mini components ─────────────────────────────────────────────────────────

function Card({ label, value, sub, color = '#ccc' }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-[#0e0e0e] border border-[#1e1e1e] rounded-lg p-4">
      <div className="text-[10px] text-[#666] mb-1 uppercase tracking-wider">{label}</div>
      <div className="text-2xl font-bold" style={{ color }}>{value}</div>
      {sub && <div className="text-[10px] text-[#555] mt-1">{sub}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#0e0e0e] border border-[#1e1e1e] rounded-lg p-4">
      <h2 className="text-[11px] font-semibold text-[#888] uppercase tracking-wider mb-3">{title}</h2>
      {children}
    </div>
  );
}

function OutcomeTag({ outcome }: { outcome: RejectedSignalOutcome['hypotheticalOutcome'] }) {
  const MAP: Record<string, { label: string; color: string }> = {
    tp2_hit: { label: 'TP2 ✓', color: '#22c55e' },
    tp1_hit: { label: 'TP1 ✓', color: '#86efac' },
    stopped_out: { label: 'Stop ✗', color: '#ef4444' },
    expired: { label: 'Expired', color: '#555' },
    pending: { label: '…', color: '#555' },
  };
  const { label, color } = MAP[outcome] ?? { label: outcome, color: '#888' };
  return <span style={{ color, fontWeight: 600, fontSize: 11 }}>{label}</span>;
}

function BarChart({ data, maxVal }: { data: { label: string; won: number; lost: number; total: number }[]; maxVal: number }) {
  return (
    <div className="space-y-2">
      {data.map(d => (
        <div key={d.label}>
          <div className="flex justify-between text-[10px] text-[#888] mb-0.5">
            <span>{d.label}</span>
            <span>{d.total} signals · {d.total > 0 ? ((d.won / d.total) * 100).toFixed(0) : 0}% would win</span>
          </div>
          <div className="h-4 bg-[#1a1a1a] rounded overflow-hidden flex">
            <div
              className="h-full bg-[#22c55e] transition-all"
              style={{ width: `${maxVal > 0 ? (d.won / maxVal) * 100 : 0}%` }}
            />
            <div
              className="h-full bg-[#ef4444] transition-all"
              style={{ width: `${maxVal > 0 ? (d.lost / maxVal) * 100 : 0}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function RecommendationCard({ rec }: { rec: Recommendation }) {
  const CONF_COLOR: Record<string, string> = { high: '#22c55e', medium: '#f59e0b', low: '#6b7280' };
  const TYPE_ICON: Record<string, string> = {
    lower_score_floor: '📉',
    disable_session_filter: '🕐',
    reduce_htf_strictness: '📊',
    expand_patterns: '🔓',
    review_rr: '⚖️',
    review_expectation: '🧠',
  };
  return (
    <div className="bg-[#0a1a0a] border border-[#1a2a1a] rounded p-3 flex gap-3">
      <div className="text-xl">{TYPE_ICON[rec.type] ?? '💡'}</div>
      <div className="flex-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[11px] text-[#ccc]">{rec.description}</span>
          <span
            className="text-[9px] font-semibold px-1.5 py-0.5 rounded uppercase"
            style={{ color: CONF_COLOR[rec.confidence], border: `1px solid ${CONF_COLOR[rec.confidence]}33` }}
          >
            {rec.confidence} confidence
          </span>
        </div>
        <div className="text-[10px] text-[#555]">{rec.potentialImpact}</div>
      </div>
    </div>
  );
}

function EdgeCard({ edge }: { edge: DiscoveredEdge }) {
  return (
    <div className="bg-[#0a100a] border border-[#1a2a1a] rounded p-3">
      <div className="flex justify-between items-start mb-1">
        <div>
          <span className="text-[12px] font-semibold text-[#22c55e]">{edge.pattern}</span>
          {edge.regime !== 'all' && (
            <span className="ml-2 text-[9px] text-[#555] uppercase">{edge.regime}</span>
          )}
        </div>
        <div className="text-right">
          <div className="text-[14px] font-bold text-[#22c55e]">{edge.hypotheticalWinRate.toFixed(0)}%</div>
          <div className="text-[9px] text-[#555]">{edge.sampleCount} samples</div>
        </div>
      </div>
      <div className="text-[10px] text-[#666]">{edge.recommendation}</div>
      <div className="mt-1 text-[10px] text-[#888]">Avg {edge.avgPnlR.toFixed(2)}R</div>
    </div>
  );
}

// ─── CSV Export ───────────────────────────────────────────────────────────────

function exportCSV(outcomes: RejectedSignalOutcome[]) {
  const headers = [
    'timestamp', 'symbol', 'timeframe', 'pattern', 'direction', 'regime',
    'rejectionReason', 'entry', 'stop', 'tp1', 'tp2', 'edgeScore',
    'hypotheticalOutcome', 'barsToOutcome', 'hypotheticalPnlR', 'wasWrongToReject',
  ];
  const rows = outcomes.map(o => [
    new Date(o.timestamp).toISOString(),
    o.symbol, o.timeframe, o.pattern, o.direction, o.regime,
    o.rejectionReason, o.entry, o.stop, o.tp1, o.tp2, o.edgeScore.toFixed(2),
    o.hypotheticalOutcome, o.barsToOutcome ?? '', o.hypotheticalPnlR, o.wasWrongToReject,
  ].join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rejected-signals-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'running' | 'done';

export default function RejectedSignalPage() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [daysBack, setDaysBack] = useState(7);
  const [progressMsg, setProgressMsg] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [processedCount, setProcessedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [report, setReport] = useState<RejectionAnalysisReport | null>(null);
  const [activeTab, setActiveTab] = useState<'reasons' | 'patterns' | 'signals' | 'avoided'>('reasons');
  const [signalFilter, setSignalFilter] = useState<'all' | 'wrong' | 'correct'>('all');
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async (resume: boolean) => {
    if (!resume) clearAnalysisProgress();
    abortRef.current = new AbortController();
    setPhase('running');
    setProgressPct(0);
    setProcessedCount(0);

    try {
      const result = await analyzeRejectedSignals(
        daysBack,
        (msg, pct, done, total) => {
          setProgressMsg(msg);
          setProgressPct(pct);
          setProcessedCount(done);
          setTotalCount(total);
        },
        resume,
        abortRef.current.signal,
      );
      setReport(result);
      setPhase('done');
    } catch (e) {
      setProgressMsg(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
      setPhase('idle');
    }
  }, [daysBack]);

  const stop = () => {
    abortRef.current?.abort();
    setPhase('idle');
  };

  // ETA calculation
  const eta = totalCount > 0 && processedCount > 0 && phase === 'running'
    ? `~${Math.ceil(((totalCount - processedCount) / processedCount) * (daysBack * 0.5))} sec remaining`
    : null;

  // Filtered signal outcomes for table
  const filteredOutcomes = report ? report.outcomes.filter(o => {
    if (signalFilter === 'wrong') return o.wasWrongToReject;
    if (signalFilter === 'correct') return !o.wasWrongToReject && o.hypotheticalOutcome === 'stopped_out';
    return true;
  }) : [];

  const reasonData = report ? Object.entries(report.byReason)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([label, stat]) => ({
      label,
      won: stat.wouldHaveWon,
      lost: stat.count - stat.wouldHaveWon,
      total: stat.count,
    })) : [];
  const maxReasonVal = Math.max(...reasonData.map(d => d.total), 1);

  return (
    <div className="min-h-screen bg-[#080808] text-[#ccc] font-mono text-sm">
      {/* Top bar */}
      <div className="sticky top-0 z-40 bg-[#080808] border-b border-[#1a1a1a] px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-[#555] hover:text-[#888] text-xs">← Home</Link>
          <span className="text-[#333]">|</span>
          <h1 className="text-[13px] font-semibold text-[#ccc]">Rejected Signal Analyzer</h1>
          {report && (
            <span className="text-[10px] text-[#555]">
              {new Date(report.generatedAt).toLocaleString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {report && (
            <button
              onClick={() => exportCSV(report.outcomes)}
              className="px-3 py-1.5 text-[11px] bg-[#0e0e0e] border border-[#2a2a2a] rounded hover:border-[#444] text-[#888]"
            >
              Export CSV
            </button>
          )}
          {phase === 'running' ? (
            <button
              onClick={stop}
              className="px-4 py-1.5 text-[11px] bg-[#1a0a0a] border border-[#3a1a1a] rounded text-[#ef4444]"
            >
              Stop
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-[#555]">Days:</label>
              <select
                value={daysBack}
                onChange={e => setDaysBack(Number(e.target.value))}
                className="bg-[#0e0e0e] border border-[#2a2a2a] rounded px-2 py-1 text-[11px] text-[#888]"
              >
                {[1, 3, 7, 14, 30].map(d => <option key={d} value={d}>{d}d</option>)}
              </select>
              {report && (
                <button
                  onClick={() => run(true)}
                  className="px-3 py-1.5 text-[11px] bg-[#0a120a] border border-[#1a3a1a] rounded text-[#4ade80]"
                >
                  Resume
                </button>
              )}
              <button
                onClick={() => run(false)}
                className="px-4 py-1.5 text-[11px] bg-[#0a1a0a] border border-[#1a4a1a] rounded text-[#22c55e] font-semibold"
              >
                Run Analysis
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="px-6 py-4 space-y-4">
        {/* Progress */}
        {phase === 'running' && (
          <div className="bg-[#0e0e0e] border border-[#1e1e1e] rounded-lg p-4">
            <div className="flex justify-between text-[11px] mb-2">
              <span className="text-[#888]">{progressMsg}</span>
              <span className="text-[#555]">
                {processedCount}/{totalCount} signals
                {eta && ` · ${eta}`}
              </span>
            </div>
            <div className="h-2 bg-[#1a1a1a] rounded overflow-hidden">
              <div
                className="h-full bg-[#22c55e] transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}

        {/* Idle state */}
        {phase === 'idle' && !report && (
          <div className="bg-[#0e0e0e] border border-[#1e1e1e] rounded-lg p-12 text-center">
            <div className="text-4xl mb-4">🔍</div>
            <div className="text-[14px] text-[#888] mb-2">Rejected Signal Analyzer</div>
            <div className="text-[11px] text-[#555] max-w-md mx-auto mb-6">
              Analyzes every live signal the strategy rejected, fetches forward candles from Binance,
              and surfaces patterns where the system was wrong to skip.
            </div>
            <button
              onClick={() => run(false)}
              className="px-6 py-2 bg-[#0a1a0a] border border-[#1a4a1a] rounded text-[#22c55e] font-semibold text-[12px]"
            >
              Run Analysis ({daysBack}d lookback)
            </button>
          </div>
        )}

        {/* Results */}
        {report && (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-4 gap-3">
              <Card
                label="Total Rejected"
                value={report.totalRejected.toLocaleString()}
                sub={`${report.analyzed} analyzed · ${report.skipped} skipped`}
                color="#888"
              />
              <Card
                label="Would Have Won"
                value={`${report.overallWouldHaveWonPct.toFixed(1)}%`}
                sub="of completed hypothetical trades"
                color={report.overallWouldHaveWonPct >= 50 ? '#f59e0b' : '#6b7280'}
              />
              <Card
                label="Wrong to Reject"
                value={report.wrongToRejectCount.toLocaleString()}
                sub="tunable-reason rejections that would have won"
                color={report.wrongToRejectCount > 0 ? '#ef4444' : '#22c55e'}
              />
              <Card
                label="Avg Hyp. R"
                value={`${report.overallAvgPnlR >= 0 ? '+' : ''}${report.overallAvgPnlR.toFixed(2)}R`}
                sub="across all analyzed signals"
                color={report.overallAvgPnlR > 0 ? '#22c55e' : report.overallAvgPnlR < 0 ? '#ef4444' : '#888'}
              />
            </div>

            {/* Recommendations */}
            {report.recommendations.length > 0 && (
              <Section title={`Recommendations (${report.recommendations.length})`}>
                <div className="space-y-2">
                  {report.recommendations.map((rec, i) => (
                    <RecommendationCard key={i} rec={rec} />
                  ))}
                </div>
              </Section>
            )}

            {/* Discovered Edges */}
            {report.discoveredEdges.length > 0 && (
              <Section title={`Discovered Edges (${report.discoveredEdges.length})`}>
                <div className="grid grid-cols-2 gap-2">
                  {report.discoveredEdges.map((edge, i) => (
                    <EdgeCard key={i} edge={edge} />
                  ))}
                </div>
              </Section>
            )}

            {/* Score Floor Boundary */}
            {report.scoreFloorBoundary.length > 0 && (
              <Section title={`Score Floor Boundary — ${report.scoreFloorBoundary.length} Missed Winners`}>
                <div className="text-[10px] text-[#666] mb-3">
                  These signals were rejected by the score / expected-value filter but would have
                  hit TP1 or TP2. Consider lowering the score floor or reviewing the EV threshold.
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[10px]">
                    <thead>
                      <tr className="text-[#555] border-b border-[#1e1e1e]">
                        {['Date', 'Symbol', 'TF', 'Pattern', 'Direction', 'Edge Score', 'Outcome', 'R'].map(h => (
                          <th key={h} className="text-left py-1.5 pr-3">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {report.scoreFloorBoundary.slice(0, 20).map(o => (
                        <tr key={o.signalId} className="border-b border-[#111] hover:bg-[#0f0f0f]">
                          <td className="py-1.5 pr-3 text-[#555]">{new Date(o.timestamp).toLocaleDateString()}</td>
                          <td className="pr-3 text-[#888]">{o.symbol}</td>
                          <td className="pr-3 text-[#555]">{o.timeframe}</td>
                          <td className="pr-3 text-[#ccc]">{o.pattern}</td>
                          <td className="pr-3">
                            <span style={{ color: o.direction === 'long' ? '#22c55e' : '#ef4444' }}>
                              {o.direction.toUpperCase()}
                            </span>
                          </td>
                          <td className="pr-3 text-[#888]">{o.edgeScore.toFixed(1)}</td>
                          <td className="pr-3"><OutcomeTag outcome={o.hypotheticalOutcome} /></td>
                          <td className="pr-3" style={{ color: o.hypotheticalPnlR > 0 ? '#22c55e' : '#ef4444' }}>
                            {o.hypotheticalPnlR > 0 ? '+' : ''}{o.hypotheticalPnlR.toFixed(1)}R
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {report.scoreFloorBoundary.length > 20 && (
                    <div className="text-[9px] text-[#555] mt-2">…and {report.scoreFloorBoundary.length - 20} more. Export CSV for full list.</div>
                  )}
                </div>
              </Section>
            )}

            {/* Tabs */}
            <div>
              <div className="flex gap-1 mb-3">
                {(['reasons', 'patterns', 'signals', 'avoided'] as const).map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-3 py-1.5 text-[11px] rounded capitalize ${
                      activeTab === tab
                        ? 'bg-[#1a1a1a] text-[#ccc] border border-[#2a2a2a]'
                        : 'text-[#555] hover:text-[#888]'
                    }`}
                  >
                    {tab === 'reasons' && `By Reason (${Object.keys(report.byReason).length})`}
                    {tab === 'patterns' && `By Pattern (${Object.keys(report.byPattern).length})`}
                    {tab === 'signals' && `Signal Log (${report.outcomes.length})`}
                    {tab === 'avoided' && `Correctly Avoided (${report.correctlyAvoided.length})`}
                  </button>
                ))}
              </div>

              {activeTab === 'reasons' && (
                <Section title="Rejection Reason Breakdown">
                  {reasonData.length === 0 ? (
                    <div className="text-[11px] text-[#555]">No data</div>
                  ) : (
                    <div className="space-y-1">
                      <div className="flex text-[9px] text-[#555] mb-2 gap-4">
                        <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-[#22c55e] rounded-sm" /> Would have won</span>
                        <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-[#ef4444] rounded-sm" /> Would have lost/expired</span>
                      </div>
                      <BarChart data={reasonData} maxVal={maxReasonVal} />
                      <div className="mt-4 overflow-x-auto">
                        <table className="w-full text-[10px]">
                          <thead>
                            <tr className="text-[#555] border-b border-[#1e1e1e]">
                              {['Reason', 'Count', 'Would Win', 'Win Rate', 'Avg R'].map(h => (
                                <th key={h} className="text-left py-1.5 pr-4">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(report.byReason)
                              .sort((a, b) => b[1].count - a[1].count)
                              .map(([reason, stat]) => (
                                <tr key={reason} className="border-b border-[#111] hover:bg-[#0f0f0f]">
                                  <td className="py-1.5 pr-4 text-[#ccc]">{reason}</td>
                                  <td className="pr-4 text-[#888]">{stat.count}</td>
                                  <td className="pr-4 text-[#22c55e]">{stat.wouldHaveWon}</td>
                                  <td className="pr-4" style={{ color: stat.winRate >= 50 ? '#f59e0b' : '#555' }}>
                                    {stat.winRate.toFixed(0)}%
                                  </td>
                                  <td className="pr-4" style={{ color: stat.avgPnlR > 0 ? '#22c55e' : '#ef4444' }}>
                                    {stat.avgPnlR >= 0 ? '+' : ''}{stat.avgPnlR.toFixed(2)}R
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </Section>
              )}

              {activeTab === 'patterns' && (
                <Section title="Pattern Analysis">
                  <table className="w-full text-[10px]">
                    <thead>
                      <tr className="text-[#555] border-b border-[#1e1e1e]">
                        {['Pattern', 'Rejected', 'Would Win', 'Win Rate', 'Avg R', 'Verdict'].map(h => (
                          <th key={h} className="text-left py-1.5 pr-4">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(report.byPattern)
                        .sort((a, b) => b[1].winRate - a[1].winRate)
                        .map(([pattern, stat]) => {
                          const verdict =
                            stat.winRate >= 65 ? '⚠ Underfiltered'
                            : stat.winRate <= 30 ? '✓ Rightly blocked'
                            : '~ Mixed';
                          const verdictColor =
                            stat.winRate >= 65 ? '#f59e0b'
                            : stat.winRate <= 30 ? '#22c55e'
                            : '#888';
                          return (
                            <tr key={pattern} className="border-b border-[#111] hover:bg-[#0f0f0f]">
                              <td className="py-1.5 pr-4 text-[#ccc] font-medium">{pattern}</td>
                              <td className="pr-4 text-[#888]">{stat.count}</td>
                              <td className="pr-4 text-[#22c55e]">{stat.wouldHaveWon}</td>
                              <td className="pr-4" style={{ color: stat.winRate >= 50 ? '#f59e0b' : '#6b7280' }}>
                                {stat.winRate.toFixed(0)}%
                              </td>
                              <td className="pr-4" style={{ color: stat.avgPnlR > 0 ? '#22c55e' : '#ef4444' }}>
                                {stat.avgPnlR >= 0 ? '+' : ''}{stat.avgPnlR.toFixed(2)}R
                              </td>
                              <td className="pr-4" style={{ color: verdictColor, fontSize: 10 }}>{verdict}</td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </Section>
              )}

              {activeTab === 'signals' && (
                <Section title="Signal Log">
                  <div className="flex gap-2 mb-3">
                    {(['all', 'wrong', 'correct'] as const).map(f => (
                      <button
                        key={f}
                        onClick={() => setSignalFilter(f)}
                        className={`px-2 py-1 text-[10px] rounded ${
                          signalFilter === f
                            ? 'bg-[#1a1a1a] text-[#ccc] border border-[#2a2a2a]'
                            : 'text-[#555] hover:text-[#888]'
                        }`}
                      >
                        {f === 'all' ? `All (${report.outcomes.length})`
                          : f === 'wrong' ? `Wrong to reject (${report.outcomes.filter(o => o.wasWrongToReject).length})`
                          : `Correctly blocked (${report.correctlyAvoided.length})`}
                      </button>
                    ))}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr className="text-[#555] border-b border-[#1e1e1e]">
                          {['Date', 'Symbol', 'TF', 'Pattern', 'Dir', 'Reason', 'Outcome', 'R', 'Wrong?'].map(h => (
                            <th key={h} className="text-left py-1.5 pr-3">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredOutcomes.slice(0, 100).map(o => (
                          <tr
                            key={o.signalId}
                            className="border-b border-[#111] hover:bg-[#0f0f0f]"
                            style={{
                              background: o.wasWrongToReject ? '#0a0f0a' : undefined,
                            }}
                          >
                            <td className="py-1.5 pr-3 text-[#555]">{new Date(o.timestamp).toLocaleDateString()}</td>
                            <td className="pr-3 text-[#888]">{o.symbol}</td>
                            <td className="pr-3 text-[#555]">{o.timeframe}</td>
                            <td className="pr-3 text-[#ccc]">{o.pattern}</td>
                            <td className="pr-3">
                              <span style={{ color: o.direction === 'long' ? '#22c55e' : '#ef4444' }}>
                                {o.direction === 'long' ? 'L' : 'S'}
                              </span>
                            </td>
                            <td className="pr-3 text-[#666]" style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {o.rejectionReason}
                            </td>
                            <td className="pr-3"><OutcomeTag outcome={o.hypotheticalOutcome} /></td>
                            <td className="pr-3" style={{ color: o.hypotheticalPnlR > 0 ? '#22c55e' : o.hypotheticalPnlR < 0 ? '#ef4444' : '#555' }}>
                              {o.hypotheticalPnlR > 0 ? '+' : ''}{o.hypotheticalPnlR.toFixed(1)}R
                            </td>
                            <td className="pr-3">
                              {o.wasWrongToReject
                                ? <span className="text-[#f59e0b]">⚠ Yes</span>
                                : <span className="text-[#333]">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {filteredOutcomes.length > 100 && (
                      <div className="text-[9px] text-[#555] mt-2">
                        Showing 100 of {filteredOutcomes.length}. Export CSV for full list.
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {activeTab === 'avoided' && (
                <Section title="Correctly Avoided — System Working">
                  <div className="text-[10px] text-[#555] mb-3">
                    These signals were rejected AND would have resulted in a stop-out. The filter system caught these correctly.
                    {report.correctlyAvoided.length > 0 && (
                      <span className="ml-1 text-[#22c55e]">
                        {report.correctlyAvoided.length} losses avoided.
                      </span>
                    )}
                  </div>
                  {report.correctlyAvoided.length === 0 ? (
                    <div className="text-[11px] text-[#555]">No correctly-avoided signals with a confirmed stop-out in this period.</div>
                  ) : (
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr className="text-[#555] border-b border-[#1e1e1e]">
                          {['Date', 'Symbol', 'TF', 'Pattern', 'Dir', 'Reason', 'Bars to Stop'].map(h => (
                            <th key={h} className="text-left py-1.5 pr-3">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {report.correctlyAvoided.slice(0, 50).map(o => (
                          <tr key={o.signalId} className="border-b border-[#111] hover:bg-[#0f0f0f]">
                            <td className="py-1.5 pr-3 text-[#555]">{new Date(o.timestamp).toLocaleDateString()}</td>
                            <td className="pr-3 text-[#888]">{o.symbol}</td>
                            <td className="pr-3 text-[#555]">{o.timeframe}</td>
                            <td className="pr-3 text-[#ccc]">{o.pattern}</td>
                            <td className="pr-3">
                              <span style={{ color: o.direction === 'long' ? '#22c55e' : '#ef4444' }}>
                                {o.direction === 'long' ? 'L' : 'S'}
                              </span>
                            </td>
                            <td className="pr-3 text-[#666]">{o.rejectionReason}</td>
                            <td className="pr-3 text-[#ef4444]">{o.barsToOutcome ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Section>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
