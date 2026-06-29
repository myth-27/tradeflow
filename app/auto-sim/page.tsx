'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  runAutoSimBatch, getAutoSimHistory, defaultAutoSimConfig, TRAINING_DATE_RANGES,
  type AutoSimConfig, type AutoSimRunResult, type DateRange,
} from '@/lib/auto-simulator';
import type { AutoSimRunRecord } from '@/lib/db';

type Phase = 'config' | 'running' | 'results';

const ALL_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT', 'XRPUSDT'];
const ALL_TIMEFRAMES = ['5m', '15m', '1h', '4h'];

function fmtPct(n: number) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-[#f5f5f5] cursor-pointer">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="accent-[#3b82f6]" />
      {label}
    </label>
  );
}

export default function AutoSimPage() {
  const [phase, setPhase] = useState<Phase>('config');
  const [config, setConfig] = useState<AutoSimConfig>(defaultAutoSimConfig());
  const [progress, setProgress] = useState<{ msg: string; pct: number }>({ msg: '', pct: 0 });
  const [log, setLog] = useState<string[]>([]);
  const [results, setResults] = useState<AutoSimRunResult[]>([]);
  const [history, setHistory] = useState<AutoSimRunRecord[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const loadHistory = async () => setHistory(await getAutoSimHistory(20));
  useEffect(() => { loadHistory(); }, []);

  const toggleSymbol = (s: string) => setConfig(c => ({
    ...c,
    symbols: c.symbols.includes(s) ? c.symbols.filter(x => x !== s) : [...c.symbols, s],
  }));
  const toggleTimeframe = (tf: string) => setConfig(c => ({
    ...c,
    timeframes: c.timeframes.includes(tf) ? c.timeframes.filter(x => x !== tf) : [...c.timeframes, tf],
  }));
  const toggleDateRange = (dr: DateRange) => setConfig(c => ({
    ...c,
    dateRanges: c.dateRanges.some(d => d.label === dr.label) ? c.dateRanges.filter(d => d.label !== dr.label) : [...c.dateRanges, dr],
  }));

  const start = async () => {
    if (config.symbols.length === 0 || config.timeframes.length === 0) return;
    if (!config.useRandomDateRanges && config.dateRanges.length === 0) return;
    setResults([]);
    setLog([]);
    setProgress({ msg: 'Starting…', pct: 0 });
    setPhase('running');
    const controller = new AbortController();
    abortRef.current = controller;

    await runAutoSimBatch(
      config,
      (msg, pct) => {
        setProgress({ msg, pct });
        setLog(l => [...l.slice(-49), msg]);
      },
      (result) => setResults(r => [...r, result]),
      controller.signal,
    );

    await loadHistory();
    setPhase('results');
  };

  const stop = () => abortRef.current?.abort();

  const profitable = results.filter(r => r.totalReturn > 0);
  const avgReturn = results.length ? results.reduce((a, r) => a + r.totalReturn, 0) / results.length : 0;

  const winConditions: Record<string, number> = {};
  const avoidConditions: Record<string, number> = {};
  results.forEach(r => {
    r.winningPatterns.forEach(p => { winConditions[p] = (winConditions[p] ?? 0) + 1; });
    r.losingPatterns.forEach(p => { avoidConditions[p] = (avoidConditions[p] ?? 0) + 1; });
  });

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f5f5f5]">
      <div className="max-w-[1100px] mx-auto px-6 py-8">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black">TradeFlow Self-Learning Engine</h1>
            <p className="text-[13px] text-[#888888] mt-1">Runs simulations automatically, learns from every win and loss via the real edge registry, improves over time</p>
          </div>
          <Link href="/intelligence" className="text-[12px] text-[#3b82f6] hover:underline flex-shrink-0">View Intelligence Report →</Link>
        </header>

        {phase === 'config' && (
          <div className="space-y-6">
            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6 space-y-5">
              <div className="text-[14px] font-semibold">Auto-Sim Settings</div>

              <div>
                <div className="text-[10px] text-[#666] uppercase tracking-wider mb-2">Symbols</div>
                <div className="flex gap-4 flex-wrap">
                  {ALL_SYMBOLS.map(s => <Checkbox key={s} checked={config.symbols.includes(s)} onChange={() => toggleSymbol(s)} label={s} />)}
                </div>
              </div>

              <div>
                <div className="text-[10px] text-[#666] uppercase tracking-wider mb-2">Timeframes</div>
                <div className="flex gap-4 flex-wrap">
                  {ALL_TIMEFRAMES.map(tf => <Checkbox key={tf} checked={config.timeframes.includes(tf)} onChange={() => toggleTimeframe(tf)} label={tf} />)}
                </div>
              </div>

              <div className="flex items-center justify-between bg-[#1a1a1a] rounded-lg p-3">
                <div>
                  <div className="text-[12px] text-[#f5f5f5]">Use random date ranges (held-out validation)</div>
                  <div className="text-[10px] text-[#666]">Generates a fresh, genuinely random window each run instead of the hand-picked quarters below — no selection bias from already knowing what happened in them</div>
                </div>
                <Checkbox checked={!!config.useRandomDateRanges} onChange={v => setConfig(c => ({ ...c, useRandomDateRanges: v }))} label={`Last ${config.randomDateRangeYearsBack ?? 10}y`} />
              </div>

              <div className={config.useRandomDateRanges ? 'opacity-40 pointer-events-none' : ''}>
                <div className="text-[10px] text-[#666] uppercase tracking-wider mb-2">Date Ranges</div>
                <div className="grid grid-cols-3 gap-2">
                  {TRAINING_DATE_RANGES.map(dr => (
                    <Checkbox key={dr.label} checked={config.dateRanges.some(d => d.label === dr.label)} onChange={() => toggleDateRange(dr)} label={dr.label} />
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-6">
                <div>
                  <label className="block text-[10px] text-[#666] mb-1.5">Batch size: {config.batchSize} runs before learning</label>
                  <input type="range" min={2} max={10} value={config.batchSize} onChange={e => setConfig(c => ({ ...c, batchSize: Number(e.target.value) }))} className="w-full" />
                </div>
                <div>
                  <label className="block text-[10px] text-[#666] mb-1.5">Max runs: {config.maxIterations}</label>
                  <input type="range" min={5} max={50} value={config.maxIterations} onChange={e => setConfig(c => ({ ...c, maxIterations: Number(e.target.value) }))} className="w-full" />
                </div>
                <div>
                  <label className="block text-[10px] text-[#666] mb-1.5">Target PF: {config.targetProfitFactor.toFixed(1)} (stop when achieved)</label>
                  <input type="range" min={1.2} max={5} step={0.1} value={config.targetProfitFactor} onChange={e => setConfig(c => ({ ...c, targetProfitFactor: Number(e.target.value) }))} className="w-full" />
                </div>
              </div>

              <div>
                <div className="text-[10px] text-[#666] uppercase tracking-wider mb-2">Advanced: SimConfig overrides (JSON, optional)</div>
                <textarea
                  className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-2 text-[11px] font-mono text-[#ccc]"
                  rows={2}
                  placeholder='e.g. {"allowedPatterns": ["Hammer", "Morning Star"], "minRR": 1.2}'
                  onChange={e => {
                    try {
                      const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : undefined;
                      setConfig(c => ({ ...c, simConfigOverrides: parsed }));
                    } catch { /* ignore until valid JSON */ }
                  }}
                />
              </div>
            </div>

            <button onClick={start} disabled={config.symbols.length === 0 || config.timeframes.length === 0 || (!config.useRandomDateRanges && config.dateRanges.length === 0)}
              className="w-full py-3.5 rounded-lg text-[15px] font-bold text-white bg-gradient-to-r from-[#22c55e] to-[#16a34a] hover:opacity-90 transition-opacity disabled:opacity-40">
              ▶ Start Auto-Learning
            </button>
            <p className="text-center text-[10px] text-[#666]">~{Math.ceil(config.maxIterations * 1.5)}-{config.maxIterations * 4} minutes for {config.maxIterations} runs, depending on date range size</p>
          </div>
        )}

        {phase === 'running' && (
          <div className="space-y-6">
            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6">
              <div className="text-[13px] text-[#f5f5f5] mb-3">{progress.msg}</div>
              <div className="h-2 bg-[#1a1a1a] rounded-full overflow-hidden mb-4">
                <div className="h-full bg-[#22c55e] transition-all duration-300" style={{ width: `${Math.min(100, progress.pct)}%` }} />
              </div>
              <div className="grid grid-cols-4 gap-4 mb-4">
                <div className="bg-[#1a1a1a] rounded-lg p-3"><div className="text-[9px] text-[#666] uppercase">Runs Complete</div><div className="text-[16px] font-mono font-bold">{results.length}/{config.maxIterations}</div></div>
                <div className="bg-[#1a1a1a] rounded-lg p-3"><div className="text-[9px] text-[#666] uppercase">Profitable</div><div className="text-[16px] font-mono font-bold text-[#22c55e]">{profitable.length} ({results.length ? ((profitable.length / results.length) * 100).toFixed(0) : 0}%)</div></div>
                <div className="bg-[#1a1a1a] rounded-lg p-3"><div className="text-[9px] text-[#666] uppercase">Avg Return</div><div className={`text-[16px] font-mono font-bold ${avgReturn >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>{fmtPct(avgReturn)}</div></div>
                <div className="bg-[#1a1a1a] rounded-lg p-3"><div className="text-[9px] text-[#666] uppercase">Last Run PF</div><div className="text-[16px] font-mono font-bold">{results.at(-1)?.profitFactor.toFixed(2) ?? '—'}</div></div>
              </div>

              <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1.5">Recent Runs</div>
              <div className="space-y-1 mb-4">
                {results.slice(-5).reverse().map(r => (
                  <div key={r.runId} className="flex items-center justify-between text-[11px] bg-[#1a1a1a] rounded px-3 py-1.5">
                    <span>{r.symbol.replace('USDT', '')} {r.timeframe} {r.dateRange.label}</span>
                    <span className={r.totalReturn >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}>{fmtPct(r.totalReturn)} {r.totalReturn >= 0 ? '✓' : '✗'}</span>
                  </div>
                ))}
              </div>

              <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1.5">Learning Events Log</div>
              <div className="bg-[#0d0d0d] border border-[#1f1f1f] rounded-lg p-3 h-32 overflow-y-auto text-[11px] text-[#888888] font-mono space-y-0.5">
                {log.map((l, i) => <div key={i}>{l}</div>)}
              </div>

              <button onClick={stop} className="mt-4 px-4 py-2 rounded-lg border border-[#ef4444] text-[#ef4444] text-[12px] hover:bg-[#ef4444]/10">■ Stop</button>
            </div>
          </div>
        )}

        {phase === 'results' && (
          <div className="space-y-6">
            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
              <div className="text-[14px] font-semibold mb-1">What the system learned from {results.length} runs</div>
              <div className="text-[12px] text-[#888888]">{profitable.length}/{results.length} profitable ({results.length ? ((profitable.length / results.length) * 100).toFixed(0) : 0}%) — avg return {fmtPct(avgReturn)}</div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
                <div className="text-[13px] font-semibold mb-3 text-[#22c55e]">✓ What Works</div>
                <div className="space-y-2">
                  {Object.entries(winConditions).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([cond, count]) => (
                    <div key={cond} className="bg-[#22c55e]/10 border border-[#22c55e]/30 rounded-lg px-3 py-2 text-[11px] text-[#f5f5f5]">{cond} — seen in {count} run(s)</div>
                  ))}
                  {Object.keys(winConditions).length === 0 && <p className="text-[11px] text-[#666]">No consistent winning patterns found this batch.</p>}
                </div>
              </div>
              <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
                <div className="text-[13px] font-semibold mb-3 text-[#ef4444]">✗ What to Avoid</div>
                <div className="space-y-2">
                  {Object.entries(avoidConditions).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([cond, count]) => (
                    <div key={cond} className="bg-[#ef4444]/10 border border-[#ef4444]/30 rounded-lg px-3 py-2 text-[11px] text-[#f5f5f5]">{cond} — seen in {count} run(s)</div>
                  ))}
                  {Object.keys(avoidConditions).length === 0 && <p className="text-[11px] text-[#666]">No consistent losing patterns found this batch.</p>}
                </div>
              </div>
            </div>

            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
              <div className="text-[14px] font-semibold mb-3">Per-Run Diagnosis</div>
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {results.map(r => (
                  <div key={r.runId} className="border-b border-[#1f1f1f] pb-2">
                    <div className="flex items-center justify-between text-[12px] mb-1">
                      <span className="font-semibold">{r.symbol} {r.timeframe} — {r.dateRange.label}</span>
                      <span className={r.totalReturn >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}>{fmtPct(r.totalReturn)} · WR {r.winRate.toFixed(0)}% · PF {r.profitFactor.toFixed(2)}</span>
                    </div>
                    {r.diagnosis.map((d, i) => <div key={i} className="text-[10px] text-[#888888]">{d}</div>)}
                  </div>
                ))}
              </div>
            </div>

            <button onClick={() => setPhase('config')} className="w-full py-3 rounded-lg text-[13px] font-semibold bg-[#1a1a1a] border border-[#222] hover:border-[#3b82f6]">
              Run Another Batch
            </button>
          </div>
        )}

        <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5 mt-6">
          <div className="text-[14px] font-semibold mb-3">History (last 20 runs)</div>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[9px] text-[#666] uppercase text-left border-b border-[#1f1f1f]">
                <th className="py-1.5">Symbol</th><th>TF</th><th>Period</th><th>Trades</th><th>Win Rate</th><th>PF</th><th>Return</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={i} className="border-b border-[rgba(26,26,26,0.5)]">
                  <td className="py-1.5">{h.symbol}</td>
                  <td className="font-mono">{h.timeframe}</td>
                  <td>{h.dateRangeLabel}</td>
                  <td className="font-mono">{h.trades}</td>
                  <td className="font-mono">{h.winRate.toFixed(0)}%</td>
                  <td className="font-mono">{h.profitFactor.toFixed(2)}</td>
                  <td className={`font-mono ${h.totalReturn >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>{fmtPct(h.totalReturn)}</td>
                </tr>
              ))}
              {history.length === 0 && <tr><td colSpan={7} className="py-4 text-center text-[#555]">No auto-sim runs yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
