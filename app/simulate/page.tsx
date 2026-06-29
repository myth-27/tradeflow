'use client';

import React, { useMemo, useRef, useState } from 'react';
import type { SimConfig, SimResult, SimTrade, ProgressCounters, MarketRegime, EntryTypeMode, TrailingStopMode } from '@/lib/simulator';
import { defaultSimConfig, ALL_REGIMES, fetchSimulationData, runSimulation as runSimulationEngine, isHtfEligible } from '@/lib/simulator';
import type { Candle } from '@/lib/binance-ws';
import { recordSimulation, getSimulationCount } from '@/lib/simulation-memory';
import { getPatternEdgeHints } from '@/lib/edge-registry';
import Link from 'next/link';
import SimulatorChart from '@/components/SimulatorChart';

type Phase = 'config' | 'running' | 'results';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOTUSDT'];
const INTERVALS: { key: string; note: string }[] = [
  { key: '5m', note: '~26,000 candles/month, fast signals' },
  { key: '15m', note: '~8,600 candles/month, filtered signals' },
  { key: '1h', note: '~720 candles/month, swing signals' },
  { key: '4h', note: '~180 candles/month, major swings' },
];
const ALL_PATTERNS = [
  'Ascending Triangle', 'Descending Triangle', 'Bull Flag', 'Bear Flag',
  'Double Bottom', 'Double Top', 'Head & Shoulders', 'Symmetrical Triangle',
];

const REGIME_LABELS: Record<MarketRegime, string> = {
  strong_uptrend: 'Strong Uptrend', weak_uptrend: 'Weak Uptrend',
  strong_downtrend: 'Strong Downtrend', weak_downtrend: 'Weak Downtrend',
  ranging: 'Ranging', low_volatility: 'Low Volatility',
};

const ENTRY_TYPE_LABELS: Record<EntryTypeMode, string> = {
  auto: 'Auto (pattern-based)', limit_only: 'Limit Only', stop_only: 'Stop Only', market_only: 'Market Only',
};

const REJECTION_LABELS: Record<keyof SimResult['rejections'], string> = {
  tradesRejectedByEntry: 'Entry Never Filled',
  tradesRejectedByRR: 'R:R Too Low',
  tradesRejectedByVolume: 'Low Volume',
  tradesRejectedBySession: 'Outside Session',
  tradesRejectedByLossStreak: 'Loss Streak Cooldown',
  tradesRejectedByDailyLimit: 'Daily Loss Limit',
  tradesRejectedByWeeklyLimit: 'Weekly Loss Limit',
  tradesRejectedByRegime: 'Regime Filtered',
  tradesRejectedByATR: 'Volatility Too Low',
  tradesRejectedByScore: 'Low Conviction Score',
  tradesRejectedByValidation: 'Failed Validation Check',
  tradesRejectedByPatternLogic: 'No Clear Pattern Bias',
  tradesRejectedByMinConfidence: 'Below Min Confidence',
  tradesRejectedByPatternChoice: 'Pattern Not Selected',
  tradesRejectedByHtfDisagreement: 'HTF Trend Disagreement',
};

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

// The page always carries a fully-resolved config (every field set, never undefined) —
// SimConfig itself marks the rules-engine fields optional only so the API route's older,
// smaller config literal still type-checks.
type FullSimConfig = Required<SimConfig>;

function defaultConfig(): FullSimConfig {
  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - 6);
  return {
    ...defaultSimConfig(),
    symbol: 'BTCUSDT',
    interval: '5m',
    startDate: isoDate(start),
    endDate: isoDate(end),
    startingCapital: 100000,
    riskPerTrade: 0.01,
    minRR: 1.5,
    minConfidence: 65,
    maxOpenTime: 20,
    allowedPatterns: [],
    regimeFilter: true,
    partialExit: true,
  } as FullSimConfig;
}

function fmtUsd(n: number, decimals = 0) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals })}`;
}
function fmtPct(n: number, decimals = 1) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`;
}
function fmtDate(t: number) {
  return new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

// ─── Page ───────────────────────────────────────────────────────────────

export default function SimulatePage() {
  const [phase, setPhase] = useState<Phase>('config');
  const [config, setConfig] = useState<FullSimConfig>(defaultConfig());
  const [progress, setProgress] = useState<{ pct: number; msg: string; counters?: ProgressCounters }>({ pct: 0, msg: '' });
  const [result, setResult] = useState<SimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [datasetTotal, setDatasetTotal] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const set = <K extends keyof FullSimConfig>(key: K, value: FullSimConfig[K]) => setConfig(c => ({ ...c, [key]: value }));

  const togglePattern = (name: string) => {
    setConfig(c => {
      const has = c.allowedPatterns.includes(name);
      let next: string[];
      if (c.allowedPatterns.length === 0) {
        // currently "all allowed" — unchecking one means switching to an explicit list
        next = ALL_PATTERNS.filter(p => p !== name);
      } else {
        next = has ? c.allowedPatterns.filter(p => p !== name) : [...c.allowedPatterns, name];
        if (next.length === ALL_PATTERNS.length) next = [];
      }
      return { ...c, allowedPatterns: next };
    });
  };

  const isPatternChecked = (name: string) => config.allowedPatterns.length === 0 || config.allowedPatterns.includes(name);

  const applyPreset = (months: number) => {
    const end = new Date();
    const start = new Date();
    start.setMonth(start.getMonth() - months);
    setConfig(c => ({ ...c, startDate: isoDate(start), endDate: isoDate(end) }));
  };

  const runSimulation = async () => {
    setError(null);
    setPhase('running');
    setProgress({ pct: 0, msg: 'Starting...' });

    const controller = new AbortController();
    abortRef.current = controller;
    const aborted = () => controller.signal.aborted;

    // Runs entirely in the browser (the engine is plain JS, no Node-only APIs) instead of going
    // through /api/simulate — that route only forwards the original ~12 config fields, so every
    // professional-rules-engine setting added above (entry discipline, session filter, scaling,
    // capital protection, trailing stop, regime allowlist) would silently be dropped server-side.
    try {
      const candles = await fetchSimulationData(
        config.symbol, config.interval, config.startDate, config.endDate,
        (pct, msg) => { if (!aborted()) setProgress({ pct, msg }); },
        controller.signal,
      );
      if (aborted()) return;

      if (candles.length < 150) {
        setError(`Only ${candles.length} candles fetched — need at least 150 (100 warmup + 50 to trade). Pick a wider date range.`);
        setPhase('config');
        return;
      }

      setProgress({ pct: 50, msg: `Fetched ${candles.length.toLocaleString()} candles. Running walk-forward simulation...` });

      // Self-learning: pull each pattern's real track record from every simulation (and live
      // signal) recorded so far, so this run can discount patterns that have empirically
      // underperformed their claimed confidence instead of trusting it blindly every time.
      let patternEdgeHints: Awaited<ReturnType<typeof getPatternEdgeHints>> | undefined;
      try {
        patternEdgeHints = await getPatternEdgeHints();
      } catch (err) {
        console.error('Failed to load pattern edge hints:', err);
      }

      // HTF confirmation: 1h has real edge on its own while 5m/15m don't — fetch the higher
      // timeframe's candles over the same date range so 5m/15m signals can be gated on
      // agreement with the 1h trend regime instead of trading against it.
      let htfCandles: Candle[] | undefined;
      if (config.htfConfirmation && isHtfEligible(config.interval)) {
        try {
          htfCandles = await fetchSimulationData(
            config.symbol, config.htfTimeframe, config.startDate, config.endDate,
            () => {}, controller.signal,
          );
        } catch (err) {
          console.error('Failed to fetch HTF candles, continuing without HTF confirmation:', err);
        }
      }
      if (aborted()) return;

      const result = await runSimulationEngine(config, candles, (pct, msg, counters) => {
        if (!aborted()) setProgress({ pct, msg, counters });
      }, controller.signal, patternEdgeHints, htfCandles);
      if (aborted()) return;

      try {
        await recordSimulation(result, candles);
        setDatasetTotal(await getSimulationCount());
      } catch (err) {
        console.error('Failed to record simulation to memory:', err);
      }

      setResult(result);
      setPhase('results');
      // Debug-only: expose the full result (regimeBreakdown, rejections, etc. aren't persisted
      // to Dexie, only summary stats + trades) for scripted retrieval. No behavior change.
      if (typeof window !== 'undefined') (window as unknown as { __lastSimResult?: typeof result }).__lastSimResult = result;
    } catch (e) {
      if (aborted()) {
        setPhase('config');
      } else {
        setError(e instanceof Error ? e.message : 'Simulation failed');
        setPhase('config');
      }
    }
  };

  const cancelSimulation = () => {
    abortRef.current?.abort();
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f5f5f5]">
      <div className="max-w-[1400px] mx-auto px-6 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-black">
            Trade<span className="text-[#8b5cf6]">Flow</span> Simulator
          </h1>
          <p className="text-[13px] text-[#888888] mt-1">Walk-forward backtesting on real Binance data</p>
        </header>

        {error && (
          <div className="mb-6 bg-[#ef4444]/10 border border-[#ef4444]/30 rounded-lg p-3 text-[13px] text-[#ef4444]">
            {error}
          </div>
        )}

        {phase === 'config' && (
          <ConfigPhase
            config={config} set={set} togglePattern={togglePattern} isPatternChecked={isPatternChecked}
            applyPreset={applyPreset} onSubmit={runSimulation}
          />
        )}
        {phase === 'running' && <RunningPhase progress={progress} startingCapital={config.startingCapital} onCancel={cancelSimulation} />}
        {phase === 'results' && result && (
          <ResultsPhase result={result} onRunAgain={() => setPhase('config')} datasetTotal={datasetTotal} />
        )}
      </div>
    </div>
  );
}

// ─── Config Phase ───────────────────────────────────────────────────────

function ConfigPhase({ config, set, togglePattern, isPatternChecked, applyPreset, onSubmit }: {
  config: FullSimConfig;
  set: <K extends keyof FullSimConfig>(key: K, value: FullSimConfig[K]) => void;
  togglePattern: (name: string) => void;
  isPatternChecked: (name: string) => boolean;
  applyPreset: (months: number) => void;
  onSubmit: () => void;
}) {
  const maxLossPerTrade = config.startingCapital * config.riskPerTrade;

  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6 space-y-6">
      <div className="grid grid-cols-2 gap-6">
        {/* Symbol */}
        <Section title="Symbol">
          <div className="flex gap-2 flex-wrap">
            {SYMBOLS.map(s => (
              <Pill key={s} active={config.symbol === s} onClick={() => set('symbol', s)}>
                {s.replace('USDT', '')}/USDT
              </Pill>
            ))}
          </div>
        </Section>

        {/* Timeframe */}
        <Section title="Timeframe">
          <div className="flex gap-2 flex-wrap">
            {INTERVALS.map(iv => (
              <Pill key={iv.key} active={config.interval === iv.key} onClick={() => set('interval', iv.key)}>
                {iv.key}
              </Pill>
            ))}
          </div>
          <p className="text-[10px] text-[#666] mt-1.5">{INTERVALS.find(i => i.key === config.interval)?.note}</p>
        </Section>

        {/* Date Range */}
        <Section title="Date Range">
          <div className="flex gap-2 mb-2">
            <input type="date" value={config.startDate} onChange={e => set('startDate', e.target.value)}
              className="bg-[#1a1a1a] border border-[#222] rounded px-2 py-1.5 text-[12px] text-[#f5f5f5] flex-1" />
            <input type="date" value={config.endDate} onChange={e => set('endDate', e.target.value)}
              className="bg-[#1a1a1a] border border-[#222] rounded px-2 py-1.5 text-[12px] text-[#f5f5f5] flex-1" />
          </div>
          <div className="flex gap-1.5">
            {[{ l: '1 Month', m: 1 }, { l: '3 Months', m: 3 }, { l: '6 Months', m: 6 }, { l: '1 Year', m: 12 }].map(p => (
              <button key={p.l} onClick={() => applyPreset(p.m)}
                className="text-[10px] px-2 py-1 rounded bg-[#1a1a1a] border border-[#222] text-[#888888] hover:text-[#f5f5f5] hover:border-[#333]">
                {p.l}
              </button>
            ))}
          </div>
        </Section>

        {/* Capital */}
        <Section title="Capital">
          <label className="block text-[10px] text-[#666] mb-1">Starting Capital</label>
          <input type="number" value={config.startingCapital} onChange={e => set('startingCapital', Number(e.target.value))}
            className="bg-[#1a1a1a] border border-[#222] rounded px-2 py-1.5 text-[12px] text-[#f5f5f5] w-full mb-3" />

          <label className="block text-[10px] text-[#666] mb-1">Risk Per Trade: {(config.riskPerTrade * 100).toFixed(1)}%</label>
          <input type="range" min={0.005} max={0.03} step={0.0025} value={config.riskPerTrade}
            onChange={e => set('riskPerTrade', Number(e.target.value))} className="w-full" />
          <p className="text-[10px] text-[#f59e0b] mt-1">Max loss per trade: {fmtUsd(maxLossPerTrade)}</p>
        </Section>
      </div>

      {/* Rules */}
      <Section title="Rules">
        <div className="grid grid-cols-4 gap-6">
          <div>
            <label className="block text-[10px] text-[#666] mb-1.5">Min R:R</label>
            <div className="flex gap-1.5">
              {[1.5, 2.0, 2.5].map(rr => (
                <Pill key={rr} active={config.minRR === rr} onClick={() => set('minRR', rr)}>1:{rr.toFixed(1)}</Pill>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[10px] text-[#666] mb-1.5">Min Confidence: {config.minConfidence}%</label>
            <input type="range" min={55} max={85} value={config.minConfidence}
              onChange={e => set('minConfidence', Number(e.target.value))} className="w-full" />
          </div>
          <div>
            <label className="block text-[10px] text-[#666] mb-1.5">Score Floor: {config.scoreFloor}</label>
            <input type="range" min={40} max={80} value={config.scoreFloor}
              onChange={e => set('scoreFloor', Number(e.target.value))} className="w-full" />
          </div>
          <div>
            <label className="block text-[10px] text-[#666] mb-1.5">Max Candles Open: {config.maxOpenTime}</label>
            <input type="range" min={10} max={50} value={config.maxOpenTime}
              onChange={e => set('maxOpenTime', Number(e.target.value))} className="w-full" />
          </div>
        </div>

        <div className="flex items-center justify-between mt-4 bg-[#1a1a1a] rounded-lg p-3">
          <div>
            <div className="text-[12px] text-[#f5f5f5]">Partial Exit at TP1</div>
            <div className="text-[10px] text-[#666]">
              {config.partialExit ? 'Take 50% profit at 1:1, let 50% run to 1:2' : 'Hold full position to 1:2'}
            </div>
          </div>
          <Toggle checked={config.partialExit} onChange={v => set('partialExit', v)} />
        </div>
      </Section>

      {/* Entry Discipline */}
      <Section title="Entry Discipline">
        <div className="grid grid-cols-3 gap-6">
          <div>
            <label className="block text-[10px] text-[#666] mb-1.5">Entry Type</label>
            <div className="flex gap-1.5 flex-wrap">
              {(Object.keys(ENTRY_TYPE_LABELS) as EntryTypeMode[]).map(t => (
                <Pill key={t} active={config.entryTypeMode === t} onClick={() => set('entryTypeMode', t)}>{ENTRY_TYPE_LABELS[t]}</Pill>
              ))}
            </div>
            <p className="text-[10px] text-[#666] mt-1.5">
              {config.entryTypeMode === 'auto' && 'Limit on flags/triangles waiting for retest, stop on breakouts, market on high-confidence high-volume.'}
              {config.entryTypeMode === 'limit_only' && 'Always wait for price to retest the breakout level before entering — never chase.'}
              {config.entryTypeMode === 'stop_only' && 'Always enter on confirmed breakout (stop order) — never wait for a retest.'}
              {config.entryTypeMode === 'market_only' && 'Always enter immediately at the signal candle close.'}
            </p>
          </div>
          <div>
            <label className="block text-[10px] text-[#666] mb-1.5">Max Wait for Fill: {config.maxWaitCandles} candles</label>
            <input type="range" min={1} max={15} value={config.maxWaitCandles}
              onChange={e => set('maxWaitCandles', Number(e.target.value))} className="w-full" />
            <p className="text-[10px] text-[#666] mt-1">Limit/stop orders expire unfilled after this many candles</p>
          </div>
          <div>
            <label className="block text-[10px] text-[#666] mb-1.5">Stop Entry Slippage Buffer: {(config.entrySlippageBuffer * 100).toFixed(2)}%</label>
            <input type="range" min={0.0005} max={0.005} step={0.0005} value={config.entrySlippageBuffer}
              onChange={e => set('entrySlippageBuffer', Number(e.target.value))} className="w-full" />
          </div>
        </div>
      </Section>

      {/* Session Filter */}
      <Section title="Session Filter">
        <div className="flex items-center justify-between bg-[#1a1a1a] rounded-lg p-3 mb-3">
          <div>
            <div className="text-[12px] text-[#f5f5f5]">Only trade during a fixed UTC session window</div>
            <div className="text-[10px] text-[#666]">Skips signals outside the configured hours</div>
          </div>
          <Toggle checked={config.sessionFilter} onChange={v => set('sessionFilter', v)} />
        </div>
        {config.sessionFilter && (
          <div className="grid grid-cols-2 gap-6">
            <div>
              <label className="block text-[10px] text-[#666] mb-1.5">Session Start (UTC): {config.sessionStartHour}:00</label>
              <input type="range" min={0} max={23} value={config.sessionStartHour}
                onChange={e => set('sessionStartHour', Number(e.target.value))} className="w-full" />
            </div>
            <div>
              <label className="block text-[10px] text-[#666] mb-1.5">Session End (UTC): {config.sessionEndHour}:00</label>
              <input type="range" min={0} max={23} value={config.sessionEndHour}
                onChange={e => set('sessionEndHour', Number(e.target.value))} className="w-full" />
            </div>
          </div>
        )}
      </Section>

      {/* Conviction Scaling */}
      <Section title="Conviction-Based Sizing">
        <div className="flex items-center justify-between bg-[#1a1a1a] rounded-lg p-3 mb-3">
          <div>
            <div className="text-[12px] text-[#f5f5f5]">Scale position size by signal quality score</div>
            <div className="text-[10px] text-[#666]">Low-score signals get smaller size instead of being blocked outright</div>
          </div>
          <Toggle checked={config.allowConvictionScaling} onChange={v => set('allowConvictionScaling', v)} />
        </div>
        {config.allowConvictionScaling && (
          <div className="grid grid-cols-4 gap-4">
            <div>
              <label className="block text-[10px] text-[#666] mb-1.5">Low (&lt;65): {config.lowConvictionMultiplier.toFixed(2)}x</label>
              <input type="range" min={0.25} max={1} step={0.25} value={config.lowConvictionMultiplier}
                onChange={e => set('lowConvictionMultiplier', Number(e.target.value))} className="w-full" />
            </div>
            <div>
              <label className="block text-[10px] text-[#666] mb-1.5">High (85+): {config.highConvictionMultiplier.toFixed(2)}x</label>
              <input type="range" min={1} max={2} step={0.25} value={config.highConvictionMultiplier}
                onChange={e => set('highConvictionMultiplier', Number(e.target.value))} className="w-full" />
            </div>
            <div>
              <label className="block text-[10px] text-[#666] mb-1.5">Very High (90+): {config.veryHighConvictionMultiplier.toFixed(2)}x</label>
              <input type="range" min={1} max={2.5} step={0.25} value={config.veryHighConvictionMultiplier}
                onChange={e => set('veryHighConvictionMultiplier', Number(e.target.value))} className="w-full" />
            </div>
            <div className="flex items-center justify-between bg-[#0d0d0d] rounded-lg p-2">
              <span className="text-[10px] text-[#888888]">Pyramiding</span>
              <Toggle checked={config.allowPyramiding} onChange={v => set('allowPyramiding', v)} />
            </div>
          </div>
        )}
      </Section>

      {/* Capital Protection */}
      <Section title="Capital Protection">
        <div className="grid grid-cols-4 gap-4">
          <div>
            <label className="block text-[10px] text-[#666] mb-1.5">Daily Loss Limit: {(config.dailyLossLimitPct * 100).toFixed(1)}%</label>
            <input type="range" min={0.01} max={0.1} step={0.005} value={config.dailyLossLimitPct}
              onChange={e => set('dailyLossLimitPct', Number(e.target.value))} className="w-full" />
          </div>
          <div>
            <label className="block text-[10px] text-[#666] mb-1.5">Weekly Loss Limit: {(config.weeklyLossLimitPct * 100).toFixed(1)}%</label>
            <input type="range" min={0.02} max={0.2} step={0.01} value={config.weeklyLossLimitPct}
              onChange={e => set('weeklyLossLimitPct', Number(e.target.value))} className="w-full" />
          </div>
          <div>
            <label className="block text-[10px] text-[#666] mb-1.5">Loss Streak Cooldown: {config.maxConsecutiveLosses}</label>
            <input type="range" min={2} max={6} value={config.maxConsecutiveLosses}
              onChange={e => set('maxConsecutiveLosses', Number(e.target.value))} className="w-full" />
          </div>
          <div>
            <label className="block text-[10px] text-[#666] mb-1.5">Drawdown Halt: {(config.drawdownHaltPct * 100).toFixed(0)}%</label>
            <input type="range" min={0.2} max={0.6} step={0.05} value={config.drawdownHaltPct}
              onChange={e => set('drawdownHaltPct', Number(e.target.value))} className="w-full" />
          </div>
        </div>
      </Section>

      {/* Trailing Stop */}
      <Section title="Trailing Stop">
        <div className="flex gap-2 flex-wrap">
          {([['fixed', 'Fixed (no trail)'], ['atr1', 'Trail at 1x ATR'], ['atr1.5', 'Trail at 1.5x ATR']] as [TrailingStopMode, string][]).map(([v, l]) => (
            <Pill key={v} active={config.trailingStopMode === v} onClick={() => set('trailingStopMode', v)}>{l}</Pill>
          ))}
        </div>
        <p className="text-[10px] text-[#666] mt-1.5">Applies only after TP1 has been hit and the stop is at/past breakeven.</p>
      </Section>

      {/* Advanced overrides — for controlled experiments that don't have a dedicated control yet */}
      <Section title="Advanced: SimConfig overrides (JSON, optional)">
        <textarea
          className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-2 text-[11px] font-mono text-[#ccc]"
          rows={2}
          placeholder='e.g. {"regimeSizeMultipliers": {"ranging": 0.5, "weak_uptrend": 0.75}}'
          onChange={e => {
            try {
              const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : {};
              set('regimeSizeMultipliers', parsed.regimeSizeMultipliers);
            } catch { /* ignore until valid JSON */ }
          }}
        />
      </Section>

      {/* Regime Filter */}
      <Section title="Regime Filter">
        <div className="flex items-center justify-between bg-[#1a1a1a] rounded-lg p-3 mb-3">
          <div>
            <div className="text-[12px] text-[#f5f5f5]">Only trade in selected market regimes (EMA divergence + ATR% + HH/LL classification)</div>
            <div className="text-[10px] text-[#666]">Skips candles classified into a disallowed regime</div>
          </div>
          <Toggle checked={config.regimeFilter} onChange={v => set('regimeFilter', v)} />
        </div>
        {config.regimeFilter && (
          <div className="flex gap-2 flex-wrap">
            {ALL_REGIMES.map(r => {
              const active = config.allowedRegimes.includes(r);
              return (
                <Pill key={r} active={active} onClick={() => {
                  const next = active ? config.allowedRegimes.filter(x => x !== r) : [...config.allowedRegimes, r];
                  set('allowedRegimes', next);
                }}>
                  {REGIME_LABELS[r]}
                </Pill>
              );
            })}
          </div>
        )}
      </Section>

      {/* HTF Confirmation */}
      {isHtfEligible(config.interval) && (
        <Section title="Higher-Timeframe Confirmation">
          <div className="flex items-center justify-between bg-[#1a1a1a] rounded-lg p-3">
            <div>
              <div className="text-[12px] text-[#f5f5f5]">Only take {config.interval} signals that agree with the {config.htfTimeframe} trend</div>
              <div className="text-[10px] text-[#666]">Rejects a signal if the higher timeframe's own regime is trending against it — empirically, 1h has real edge on its own while 5m/15m don't</div>
            </div>
            <Toggle checked={config.htfConfirmation} onChange={v => set('htfConfirmation', v)} />
          </div>
        </Section>
      )}

      {/* Patterns */}
      <Section title="Patterns to Trade">
        <div className="flex gap-2 mb-2">
          <button onClick={() => set('allowedPatterns', [])} className="text-[10px] text-[#3b82f6] hover:underline">Select All</button>
          <button onClick={() => set('allowedPatterns', ['__none__'])} className="text-[10px] text-[#888888] hover:underline">Deselect All</button>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {ALL_PATTERNS.map(p => (
            <label key={p} className="flex items-center gap-2 text-[12px] text-[#f5f5f5] cursor-pointer">
              <input type="checkbox" checked={isPatternChecked(p) && !config.allowedPatterns.includes('__none__')}
                onChange={() => togglePattern(p)} className="accent-[#3b82f6]" />
              {p}
            </label>
          ))}
        </div>
      </Section>

      <button onClick={onSubmit}
        className="w-full py-3.5 rounded-lg text-[15px] font-bold text-white bg-gradient-to-r from-[#3b82f6] to-[#2563eb] hover:opacity-90 transition-opacity">
        ▶ Run Simulation
      </button>
      <p className="text-center text-[10px] text-[#666]">~2-3 minutes for 6 months of 5m data</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-[#666] uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-[12px] font-semibold transition-colors ${active ? 'bg-[#f5f5f5] text-black' : 'bg-[#1a1a1a] text-[#888888] hover:text-[#f5f5f5] border border-[#222]'}`}>
      {children}
    </button>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${checked ? 'bg-[#3b82f6]' : 'bg-[#1f1f1f]'}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
    </button>
  );
}

// ─── Running Phase ───────────────────────────────────────────────────────

function RunningPhase({ progress, startingCapital, onCancel }: {
  progress: { pct: number; msg: string; counters?: ProgressCounters };
  startingCapital: number;
  onCancel: () => void;
}) {
  const c = progress.counters;
  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-8">
      <div className="text-[14px] text-[#f5f5f5] mb-3">
        {progress.pct < 50 ? 'Fetching historical data...' : 'Running simulation...'}
      </div>
      <div className="h-2 bg-[#1a1a1a] rounded-full overflow-hidden mb-2">
        <div className="h-full bg-[#3b82f6] transition-all duration-300" style={{ width: `${progress.pct}%` }} />
      </div>
      <div className="flex justify-between text-[11px] text-[#888888] mb-6">
        <span>{progress.msg}</span>
        <span>{progress.pct.toFixed(0)}%</span>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <Counter label="Signals Found" value={(c?.signals ?? 0).toLocaleString()} />
        <Counter label="Trades Taken" value={(c?.trades ?? 0).toLocaleString()} />
        <Counter label="Current Capital" value={fmtUsd(c?.capital ?? startingCapital)} color={(c?.capital ?? startingCapital) >= startingCapital ? '#22c55e' : '#ef4444'} />
        <Counter label="Win Rate So Far" value={c ? `${c.winRate.toFixed(1)}%` : '--%'} />
      </div>

      <button onClick={onCancel} className="text-[12px] text-[#ef4444] hover:underline">Cancel</button>
    </div>
  );
}

function Counter({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-[#1a1a1a] rounded-lg p-3">
      <div className="text-[9px] text-[#666] uppercase tracking-wider mb-1">{label}</div>
      <div className="text-[16px] font-mono font-bold" style={{ color: color ?? '#f5f5f5' }}>{value}</div>
    </div>
  );
}

// ─── Results Phase ───────────────────────────────────────────────────────

function ResultsPhase({ result, onRunAgain, datasetTotal }: { result: SimResult; onRunAgain: () => void; datasetTotal: number | null }) {
  return (
    <div className="space-y-6">
      {datasetTotal !== null && (
        <div className="flex items-center justify-between bg-[#111111] border border-[#1f1f1f] rounded-xl px-5 py-3">
          <span className="text-[12px] text-[#888888]">
            📊 This run added {result.trades.filter(t => t.exitReason !== 'entry_expired').length} labeled trades to your ML dataset —{' '}
            <span className="text-[#f5f5f5] font-semibold">{datasetTotal}</span> simulation{datasetTotal === 1 ? '' : 's'} saved so far.
          </span>
          <Link href="/dataset" className="text-[12px] text-[#3b82f6] hover:underline flex-shrink-0">View training dataset →</Link>
        </div>
      )}
      <HeroStats result={result} />
      <EquityCard result={result} />
      <RulesAppliedSection result={result} />
      <RejectionBreakdown result={result} />
      <PatternBreakdown result={result} />
      <TradeLogSection result={result} />
      <HourlyAnalysis result={result} />
      <MonthlyBreakdown result={result} />
      <Insights result={result} />

      <div className="flex justify-center pt-2">
        <button onClick={onRunAgain}
          className="px-6 py-3 rounded-lg text-[13px] font-semibold bg-[#1a1a1a] border border-[#222] text-[#f5f5f5] hover:border-[#3b82f6]">
          Run Again with Different Settings
        </button>
      </div>
    </div>
  );
}

function HeroStats({ result }: { result: SimResult }) {
  const r = result;
  const winRateColor = r.winRate > 60 ? '#22c55e' : r.winRate >= 50 ? '#f59e0b' : '#ef4444';
  const pfColor = r.profitFactor > 2 ? '#22c55e' : r.profitFactor >= 1.5 ? '#f59e0b' : '#ef4444';
  const sharpeColor = r.sharpeRatio > 1.5 ? '#22c55e' : r.sharpeRatio >= 1.0 ? '#f59e0b' : '#ef4444';
  const positive = r.totalReturn >= 0;

  return (
    <div className="grid grid-cols-5 gap-4">
      <HeroCard label="Final Capital" value={fmtUsd(r.finalCapital)} sub={`${fmtUsd(r.totalReturnDollars)} (${fmtPct(r.totalReturn, 1)})`}
        color={positive ? '#22c55e' : '#ef4444'} />
      <HeroCard label="Win Rate" value={`${r.winRate.toFixed(1)}%`} sub={`${r.wins}W / ${r.losses}L / ${r.breakevens}BE`} color={winRateColor} />
      <HeroCard label="Profit Factor" value={r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)} sub="Gross win / gross loss" color={pfColor} />
      <HeroCard label="Max Drawdown" value={`-${r.maxDrawdown.toFixed(1)}%`} sub={fmtUsd(-r.maxDrawdownDollars)} color="#ef4444" />
      <HeroCard label="Sharpe Ratio" value={r.sharpeRatio.toFixed(2)} sub="&gt;1.0 = good" color={sharpeColor} />
    </div>
  );
}

function HeroCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="text-[9px] text-[#666] uppercase tracking-wider mb-1.5">{label}</div>
      <div className="text-[22px] font-mono font-bold leading-tight" style={{ color }}>{value}</div>
      <div className="text-[11px] text-[#888888] mt-1">{sub}</div>
    </div>
  );
}

function EquityCard({ result }: { result: SimResult }) {
  const bestTrade = result.bestTrade ?? result.trades.reduce((b, t) => (t.pnlDollars > (b?.pnlDollars ?? -Infinity) ? t : b), null as SimTrade | null);
  const worstTrade = result.worstTrade ?? result.trades.reduce((w, t) => (t.pnlDollars < (w?.pnlDollars ?? Infinity) ? t : w), null as SimTrade | null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const svgEl = chartRef.current?.querySelector('svg');
      const svgDataUrl = svgEl ? svgToDataUrl(svgEl) : null;
      const html = buildFullReportHtml(result, svgDataUrl);
      downloadFile(html, `tradeflow-sim-report-${result.config.symbol}-${result.config.startDate}-to-${result.config.endDate}.html`, 'text/html');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[14px] font-semibold">
          Equity Curve — {fmtUsd(result.startingCapital)} → {fmtUsd(result.finalCapital)}
        </div>
        <button onClick={handleExport} disabled={exporting}
          className="text-[11px] px-3 py-1.5 rounded bg-[#1a1a1a] border border-[#222] text-[#888888] hover:text-[#f5f5f5] hover:border-[#3b82f6] disabled:opacity-50">
          {exporting ? 'Generating…' : '📄 Export Full Report'}
        </button>
      </div>
      <div ref={chartRef}>
        <SimulatorChart equityCurve={result.equityCurve} trades={result.trades} startingCapital={result.startingCapital} />
      </div>
      <div className="flex gap-6 mt-3 text-[11px]">
        {bestTrade && <span className="text-[#22c55e]">● Best trade: {fmtUsd(bestTrade.pnlDollars)} {bestTrade.patternName}</span>}
        {worstTrade && <span className="text-[#ef4444]">● Worst trade: {fmtUsd(worstTrade.pnlDollars)} {worstTrade.patternName}</span>}
        <span className="text-[#888888]">Max drawdown: -{result.maxDrawdown.toFixed(1)}%</span>
      </div>
    </div>
  );
}

function RulesAppliedSection({ result }: { result: SimResult }) {
  const c = result.config;
  const items: { label: string; value: string }[] = [
    { label: 'Entry Type', value: ENTRY_TYPE_LABELS[c.entryTypeMode] },
    { label: 'Max Wait for Fill', value: `${c.maxWaitCandles} candles` },
    { label: 'Session Filter', value: c.sessionFilter ? `${c.sessionStartHour}:00–${c.sessionEndHour}:00 UTC` : 'Off (24h)' },
    { label: 'Conviction Scaling', value: c.allowConvictionScaling ? `${c.lowConvictionMultiplier}x / 1x / ${c.highConvictionMultiplier}x / ${c.veryHighConvictionMultiplier}x` : 'Off' },
    { label: 'Pyramiding', value: c.allowPyramiding ? 'Enabled' : 'Off' },
    { label: 'Daily / Weekly Loss Limit', value: `${(c.dailyLossLimitPct * 100).toFixed(1)}% / ${(c.weeklyLossLimitPct * 100).toFixed(1)}%` },
    { label: 'Loss Streak Cooldown', value: `${c.maxConsecutiveLosses} losses` },
    { label: 'Drawdown Halt', value: `${(c.drawdownHaltPct * 100).toFixed(0)}%` },
    { label: 'Trailing Stop', value: c.trailingStopMode === 'fixed' ? 'Off' : c.trailingStopMode },
    { label: 'Regime Filter', value: c.regimeFilter ? c.allowedRegimes.map(r => REGIME_LABELS[r]).join(', ') : 'Off (all regimes)' },
    { label: 'HTF Confirmation', value: c.htfConfirmation ? `On (vs ${c.htfTimeframe})` : 'Off' },
  ];
  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
      <div className="text-[14px] font-semibold mb-3">Rules Applied This Run</div>
      <div className="grid grid-cols-2 gap-3">
        {items.map(it => (
          <div key={it.label} className="flex items-center justify-between bg-[#1a1a1a] rounded-lg px-3 py-2">
            <span className="text-[11px] text-[#888888]">{it.label}</span>
            <span className="text-[11px] font-mono text-[#f5f5f5] text-right">{it.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RejectionBreakdown({ result }: { result: SimResult }) {
  const rows = (Object.entries(result.rejections) as [keyof SimResult['rejections'], number][])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((sum, [, count]) => sum + count, 0) + result.signalsFilteredByRegime;
  const maxCount = Math.max(1, ...rows.map(([, c]) => c));

  if (total === 0) {
    return (
      <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
        <div className="text-[14px] font-semibold mb-2">Why Signals Were Rejected</div>
        <p className="text-[12px] text-[#666]">No signals were rejected before becoming trades — every detected signal passed all filters.</p>
      </div>
    );
  }

  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
      <div className="text-[14px] font-semibold mb-3">Why Signals Were Rejected ({total.toLocaleString()} total)</div>
      <div className="space-y-2">
        {rows.map(([key, count]) => (
          <div key={key} className="flex items-center gap-2 text-[11px]">
            <span className="w-44 truncate text-[#888888]">{REJECTION_LABELS[key]}</span>
            <div className="flex-1 h-4 bg-[#1a1a1a] rounded overflow-hidden">
              <div className="h-full bg-[#ef4444]/70" style={{ width: `${(count / maxCount) * 100}%` }} />
            </div>
            <span className="w-16 text-right font-mono text-[#f5f5f5]">{count.toLocaleString()}</span>
            <span className="w-10 text-right font-mono text-[#666]">{((count / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PatternBreakdown({ result }: { result: SimResult }) {
  const rows = Object.entries(result.patternStats).sort((a, b) => b[1].totalPnl - a[1].totalPnl);
  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
      <div className="text-[14px] font-semibold mb-3">Performance by Pattern</div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[9px] text-[#666] uppercase text-left border-b border-[#1f1f1f]">
            <th className="py-1.5">Pattern</th><th>Taken</th><th>Win %</th><th>Avg R</th><th>Total P&L</th><th>Best</th><th>Worst</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, s], i) => (
            <tr key={name} className="border-b border-[rgba(26,26,26,0.5)]" style={{ background: i < 3 ? 'rgba(34,197,94,0.03)' : i >= rows.length - 3 ? 'rgba(239,68,68,0.03)' : 'transparent' }}>
              <td className="py-1.5">{name}</td>
              <td className="font-mono">{s.trades}</td>
              <td className="font-mono">{s.winRate.toFixed(0)}%</td>
              <td className="font-mono">{s.avgRMultiple >= 0 ? '+' : ''}{s.avgRMultiple.toFixed(2)}R</td>
              <td className={`font-mono ${s.totalPnl >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>{fmtUsd(s.totalPnl)}</td>
              <td className="font-mono text-[#22c55e]">{fmtUsd(s.best)}</td>
              <td className="font-mono text-[#ef4444]">{fmtUsd(s.worst)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={7} className="py-4 text-center text-[#555]">No trades taken</td></tr>}
        </tbody>
      </table>
      {rows.length > 0 && (
        <div className="mt-4 space-y-1.5">
          {rows.map(([name, s]) => (
            <div key={name} className="flex items-center gap-2 text-[10px]">
              <span className="w-32 truncate text-[#888888]">{name}</span>
              <div className="flex-1 h-3 bg-[#ef4444]/20 rounded-full overflow-hidden">
                <div className="h-full bg-[#22c55e]/70" style={{ width: `${s.winRate}%` }} />
              </div>
              <span className="w-10 text-right font-mono text-[#888888]">{s.winRate.toFixed(0)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const FILTERS = ['All', 'Wins', 'Losses', 'Breakeven', 'Expired', 'Entry Missed'] as const;

function TradeLogSection({ result }: { result: SimResult }) {
  const [filter, setFilter] = useState<typeof FILTERS[number]>('All');
  const [patternFilter, setPatternFilter] = useState('All');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const pageSize = 20;

  const patterns = useMemo(() => ['All', ...Array.from(new Set(result.trades.map(t => t.patternName)))], [result.trades]);

  const filtered = useMemo(() => {
    return result.trades.filter(t => {
      if (patternFilter !== 'All' && t.patternName !== patternFilter) return false;
      if (filter === 'Wins') return t.rMultiple > 0.1 && t.exitReason !== 'tp1_then_be';
      if (filter === 'Losses') return t.exitReason === 'stop' && t.rMultiple <= 0.1;
      if (filter === 'Breakeven') return t.exitReason === 'tp1_then_be';
      if (filter === 'Expired') return t.exitReason === 'expired';
      if (filter === 'Entry Missed') return t.exitReason === 'entry_expired';
      return true;
    });
  }, [result.trades, filter, patternFilter]);

  const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));

  const exportCsv = () => {
    const headers = ['#', 'Date', 'Pattern', 'Dir', 'Entry', 'Exit', 'TP1', 'TP2', 'Stop', 'ExitReason', 'PnL$', 'PnL%', 'RMult', 'CapitalAfter'];
    const rows = filtered.map((t, i) => [
      i + 1, fmtDate(t.entryTime), t.patternName, t.direction, t.entryPrice, t.exitPrice ?? '', t.tp1, t.tp2, t.stopLoss,
      t.exitReason, t.pnlDollars.toFixed(2), t.pnlPercent.toFixed(2), t.rMultiple.toFixed(2), t.capitalAfter.toFixed(2),
    ]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    downloadFile(csv, 'tradeflow-sim-trades.csv', 'text/csv');
  };

  const exportJson = () => downloadFile(JSON.stringify(filtered, null, 2), 'tradeflow-sim-trades.json', 'application/json');

  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[14px] font-semibold">All Trades ({filtered.length} total)</div>
        <div className="flex gap-2">
          <button onClick={exportCsv} className="text-[10px] px-2 py-1 rounded bg-[#1a1a1a] border border-[#222] text-[#888888] hover:text-[#f5f5f5]">Export CSV</button>
          <button onClick={exportJson} className="text-[10px] px-2 py-1 rounded bg-[#1a1a1a] border border-[#222] text-[#888888] hover:text-[#f5f5f5]">Export JSON</button>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {FILTERS.map(f => (
          <Pill key={f} active={filter === f} onClick={() => { setFilter(f); setPage(0); }}>{f}</Pill>
        ))}
        <select value={patternFilter} onChange={e => { setPatternFilter(e.target.value); setPage(0); }}
          className="bg-[#1a1a1a] border border-[#222] rounded px-2 py-1.5 text-[11px] text-[#f5f5f5]">
          {patterns.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[11px] min-w-[900px]">
          <thead>
            <tr className="text-[9px] text-[#666] uppercase text-left border-b border-[#1f1f1f]">
              <th className="py-1.5">#</th><th>Date</th><th>Pattern</th><th>Dir</th><th>Entry</th><th>Exit</th>
              <th>TP1</th><th>TP2</th><th>Stop</th><th>Reason</th><th>P&L$</th><th>P&L%</th><th>R</th><th>Capital</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((t, i) => (
              <React.Fragment key={t.id}>
                <tr key={t.id} onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                  className="border-b border-[rgba(26,26,26,0.5)] cursor-pointer hover:bg-white/[0.02]"
                  style={{ background: t.pnlDollars > 0 ? 'rgba(34,197,94,0.03)' : t.pnlDollars < 0 ? 'rgba(239,68,68,0.03)' : 'transparent' }}>
                  <td className="py-1.5 text-[#666]">{page * pageSize + i + 1}</td>
                  <td className="text-[#888888] whitespace-nowrap">{fmtDate(t.entryTime)}</td>
                  <td className="truncate max-w-[120px]">{t.patternName}</td>
                  <td><span className={t.direction === 'long' ? 'text-[#22c55e]' : 'text-[#ef4444]'}>{t.direction.toUpperCase()}</span></td>
                  <td className="font-mono">{t.entryPrice.toFixed(2)}</td>
                  <td className="font-mono">{t.exitPrice?.toFixed(2) ?? '—'}</td>
                  <td className="font-mono text-[#22c55e]">{t.tp1.toFixed(2)}</td>
                  <td className="font-mono text-[#22c55e]">{t.tp2.toFixed(2)}</td>
                  <td className="font-mono text-[#ef4444]">{t.stopLoss.toFixed(2)}</td>
                  <td className="text-[#888888]">{t.exitReason}</td>
                  <td className={`font-mono ${t.pnlDollars >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>{fmtUsd(t.pnlDollars)}</td>
                  <td className={`font-mono ${t.pnlPercent >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>{fmtPct(t.pnlPercent)}</td>
                  <td className={`font-mono ${t.rMultiple >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>{t.rMultiple >= 0 ? '+' : ''}{t.rMultiple.toFixed(1)}R</td>
                  <td className="font-mono text-[#888888]">{fmtUsd(t.capitalAfter)}</td>
                </tr>
                {expanded === t.id && (
                  <tr key={`${t.id}-expanded`} className="bg-[#0d0d0d]">
                    <td colSpan={14} className="p-3">
                      <div className="grid grid-cols-5 gap-3 text-[10px] mb-3">
                        <span>RSI at entry: <b className="text-[#f5f5f5]">{t.rsiAtEntry.toFixed(1)}</b></span>
                        <span>MACD: <b className="text-[#f5f5f5]">{t.macdAtEntry}</b></span>
                        <span>Volume ratio: <b className="text-[#f5f5f5]">{t.volumeRatioAtEntry.toFixed(2)}x</b></span>
                        <span>ATR: <b className="text-[#f5f5f5]">{t.atrAtEntry.toFixed(2)}</b></span>
                        <span>Trend: <b className="text-[#f5f5f5]">{t.trendAtEntry}</b></span>
                        <span>Confidence: <b className="text-[#f5f5f5]">{t.confidence}%</b></span>
                        <span>Candles held: <b className="text-[#f5f5f5]">{(t.exitCandle ?? t.entryCandle) - t.entryCandle}</b></span>
                        <span>TP1 / TP2 / TP3 hit: <b className="text-[#f5f5f5]">{t.tp1Hit ? 'Y' : 'N'} / {t.tp2Hit ? 'Y' : 'N'} / {t.tp3Hit ? 'Y' : 'N'}</b></span>
                        <span>Regime: <b className="text-[#f5f5f5]">{REGIME_LABELS[t.regime]}</b></span>
                        <span>Entry type: <b className="text-[#f5f5f5]">{t.entryType}</b> {t.entryType !== 'market' && <span className="text-[#666]">(waited {t.waitedCandles}c, slip {t.entrySlippage.toFixed(2)})</span>}</span>
                        <span>Conviction: <b className="text-[#f5f5f5]">{t.convictionLevel} ({t.convictionMultiplier}x size)</b></span>
                        {t.stopWasTrailed && <span>Stop trailed: <b className="text-[#22c55e]">Yes</b></span>}
                        {t.capitalProtectionMode && <span>Capital protection: <b className="text-[#f59e0b]">Reduced sizing active</b></span>}
                      </div>
                      <div className="border-t border-[#1f1f1f] pt-2">
                        <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1.5">
                          Signal Scorecard — {t.signalScore}/100
                        </div>
                        <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] text-[#aaaaaa]">
                          {t.scoreReasons.map((reason, idx) => (
                            <li key={idx} className={reason.startsWith('REJECT') ? 'text-[#ef4444]' : ''}>· {reason}</li>
                          ))}
                        </ul>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {visible.length === 0 && <tr><td colSpan={14} className="py-4 text-center text-[#555]">No trades match this filter</td></tr>}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-3 text-[11px]">
          <button disabled={page === 0} onClick={() => setPage(p => p - 1)} className="text-[#888888] disabled:text-[#333]">← Prev</button>
          <span className="text-[#666]">Page {page + 1} / {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} className="text-[#888888] disabled:text-[#333]">Next →</button>
        </div>
      )}
    </div>
  );
}

function HourlyAnalysis({ result }: { result: SimResult }) {
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, ...((result.hourlyStats[h]) ?? { trades: 0, wins: 0, pnl: 0 }) }));
  const maxTrades = Math.max(1, ...hours.map(h => h.trades));
  const ranked = [...hours].filter(h => h.trades > 0).sort((a, b) => b.pnl - a.pnl);
  const best = ranked.slice(0, 3);
  const worst = ranked.slice(-3).reverse();

  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
      <div className="text-[14px] font-semibold mb-3">Best Hours to Trade (UTC)</div>
      <div className="flex items-end gap-1 h-24 mb-3">
        {hours.map(h => (
          <div key={h.hour} className="flex-1 flex flex-col items-center gap-1" title={`${h.hour}:00 — ${h.trades} trades, ${fmtUsd(h.pnl)}`}>
            <div className="w-full rounded-t" style={{
              height: `${(h.trades / maxTrades) * 80}px`,
              background: h.trades === 0 ? '#1a1a1a' : h.pnl >= 0 ? '#22c55e' : '#ef4444',
              opacity: h.trades === 0 ? 0.3 : 0.8,
            }} />
            <span className="text-[7px] text-[#555]">{h.hour}</span>
          </div>
        ))}
      </div>
      {best.length > 0 && (
        <p className="text-[11px] text-[#888888]">
          Consider only trading between {best.map(b => `${b.hour}:00`).join(', ')} (UTC) — highest P&L hours.
          {worst.length > 0 && ` Avoid ${worst.map(w => `${w.hour}:00`).join(', ')}.`}
        </p>
      )}
    </div>
  );
}

function MonthlyBreakdown({ result }: { result: SimResult }) {
  const months = useMemo(() => {
    const map = new Map<string, { trades: number; wins: number; pnl: number; pnlPct: number }>();
    for (const t of result.trades) {
      const key = new Date(t.entryTime * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
      if (!map.has(key)) map.set(key, { trades: 0, wins: 0, pnl: 0, pnlPct: 0 });
      const m = map.get(key)!;
      m.trades++;
      if (t.rMultiple > 0.1) m.wins++;
      m.pnl += t.pnlDollars;
      m.pnlPct += t.accountPnlPercent;
    }
    return Array.from(map.entries());
  }, [result.trades]);

  const maxAbsPnl = Math.max(1, ...months.map(([, m]) => Math.abs(m.pnl)));

  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
      <div className="text-[14px] font-semibold mb-3">Monthly Performance</div>
      <table className="w-full text-[12px] mb-4">
        <thead>
          <tr className="text-[9px] text-[#666] uppercase text-left border-b border-[#1f1f1f]">
            <th className="py-1.5">Month</th><th>Trades</th><th>Win Rate</th><th>P&L%</th><th>P&L$</th>
          </tr>
        </thead>
        <tbody>
          {months.map(([month, m]) => (
            <tr key={month} className="border-b border-[rgba(26,26,26,0.5)]" style={{ background: m.pnl >= 0 ? 'rgba(34,197,94,0.03)' : 'rgba(239,68,68,0.03)' }}>
              <td className="py-1.5">{month}</td>
              <td className="font-mono">{m.trades}</td>
              <td className="font-mono">{m.trades > 0 ? ((m.wins / m.trades) * 100).toFixed(0) : 0}%</td>
              <td className={`font-mono ${m.pnlPct >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>{fmtPct(m.pnlPct)}</td>
              <td className={`font-mono ${m.pnl >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>{fmtUsd(m.pnl)}</td>
            </tr>
          ))}
          {months.length === 0 && <tr><td colSpan={5} className="py-4 text-center text-[#555]">No trades taken</td></tr>}
        </tbody>
      </table>
      <div className="space-y-1">
        {months.map(([month, m]) => (
          <div key={month} className="flex items-center gap-2 text-[10px]">
            <span className="w-16 text-[#888888]">{month}</span>
            <div className="flex-1 h-3 flex items-center">
              <div className="h-full rounded" style={{ width: `${(Math.abs(m.pnl) / maxAbsPnl) * 100}%`, background: m.pnl >= 0 ? '#22c55e' : '#ef4444', opacity: 0.7 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Insights({ result }: { result: SimResult }) {
  const insights: string[] = [];
  const patterns = Object.entries(result.patternStats).filter(([, s]) => s.trades >= 3);

  if (patterns.length) {
    const best = patterns.reduce((b, p) => (p[1].totalPnl > b[1].totalPnl ? p : b));
    insights.push(`${best[0]} generated the highest returns (${fmtUsd(best[1].totalPnl)}) with a ${best[1].winRate.toFixed(0)}% win rate across ${best[1].trades} trades.`);

    const worst = patterns.reduce((w, p) => (p[1].totalPnl < w[1].totalPnl ? p : w));
    if (worst[1].totalPnl < 0) {
      insights.push(`${worst[0]} performed poorly (${fmtUsd(worst[1].totalPnl)}) with only ${worst[1].winRate.toFixed(0)}% win rate. Consider excluding this pattern.`);
    }
  }

  if (result.config.regimeFilter) {
    insights.push(`The regime filter skipped ${result.signalsFilteredByRegime} candle(s) of sideways/low-volatility conditions before pattern detection ran.`);
  }

  const hourEntries = Object.entries(result.hourlyStats).filter(([, h]) => h.trades >= 2);
  if (hourEntries.length) {
    const bestHour = hourEntries.reduce((b, h) => ((h[1].wins / h[1].trades) > (b[1].wins / b[1].trades) ? h : b));
    const wr = (bestHour[1].wins / bestHour[1].trades) * 100;
    insights.push(`Trades opened around ${bestHour[0]}:00 UTC had the highest win rate (${wr.toFixed(0)}%) among hours with 2+ trades.`);
  }

  if (result.config.partialExit && result.breakevens > 0) {
    insights.push(`The partial exit at TP1 turned ${result.breakevens} trade(s) that would have risked a full stop-loss into breakeven (or small-win) outcomes instead.`);
  }

  insights.push(`${result.totalTrades} of ${result.totalSignals} signals passed all filters and were actually traded (${result.totalSignals > 0 ? ((result.totalTrades / result.totalSignals) * 100).toFixed(1) : '0'}%).`);

  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
      <div className="text-[14px] font-semibold mb-3">Simulation Insights</div>
      <ul className="space-y-2">
        {insights.map((line, i) => (
          <li key={i} className="text-[12px] text-[#cccccc] leading-relaxed flex gap-2">
            <span className="text-[#3b82f6] flex-shrink-0">▸</span>{line}
          </li>
        ))}
      </ul>
    </div>
  );
}

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function svgToDataUrl(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!clone.getAttribute('width')) clone.setAttribute('width', String(svg.clientWidth || 800));
  if (!clone.getAttribute('height')) clone.setAttribute('height', String(svg.clientHeight || 320));
  const serialized = new XMLSerializer().serializeToString(clone);
  const base64 = typeof window !== 'undefined' ? window.btoa(unescape(encodeURIComponent(serialized))) : '';
  return `data:image/svg+xml;base64,${base64}`;
}

function exitReasonExplanation(t: SimTrade, maxOpenTime: number): string {
  switch (t.exitReason) {
    case 'tp2': return 'Take-profit 2 hit — full target reached.';
    case 'tp3': return 'Take-profit 3 hit — extended runner target reached for a high-conviction trade.';
    case 'tp1_then_be': return 'TP1 was banked, then price came back and stopped the runner at breakeven.';
    case 'stop': return t.tp1Hit ? 'Stop hit after TP1 partial — runner gave back the breakeven buffer.' : 'Stop loss hit — full planned risk taken.';
    case 'expired': return `Held longer than the max ${maxOpenTime}-candle window — closed at market price.`;
    case 'entry_expired': return `Limit/stop entry order never filled within ${t.waitedCandles} candles — no position was ever taken.`;
    case 'end_of_data': return 'Simulation period ended while still open — closed at the final available price.';
    default: return '';
  }
}

function buildFullReportHtml(result: SimResult, svgDataUrl: string | null): string {
  const c = result.config;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const filledTrades = result.trades.filter(t => t.exitReason !== 'end_of_data' || t.status === 'closed');

  const tradeRows = filledTrades.map((t, i) => {
    const taken = t.exitReason !== 'entry_expired';
    const pnlColor = t.pnlDollars > 0 ? '#22c55e' : t.pnlDollars < 0 ? '#ef4444' : '#888';
    return `
      <tr style="border-bottom:1px solid #1f1f1f;${taken ? '' : 'opacity:0.6;'}">
        <td>${i + 1}</td>
        <td>${fmtDate(t.entryTime)}</td>
        <td>${esc(t.patternName)}</td>
        <td>${t.direction.toUpperCase()}</td>
        <td>${taken ? t.entryPrice.toFixed(2) : '—'}</td>
        <td>${t.exitPrice?.toFixed(2) ?? '—'}</td>
        <td>${t.exitReason}</td>
        <td style="color:${pnlColor}">${fmtUsd(t.pnlDollars)}</td>
        <td style="color:${pnlColor}">${t.rMultiple >= 0 ? '+' : ''}${t.rMultiple.toFixed(2)}R</td>
        <td>${t.signalScore}/100 (${t.convictionLevel})</td>
        <td style="font-size:10px;color:#999">${esc(exitReasonExplanation(t, c.maxOpenTime))}<br/>${t.scoreReasons.map(esc).join('; ')}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>TradeFlow Simulation Report — ${c.symbol}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#0a0a0a; color:#f5f5f5; padding:32px; max-width:1200px; margin:0 auto; }
  h1 { font-size:22px; } h2 { font-size:15px; margin-top:32px; border-bottom:1px solid #222; padding-bottom:8px; }
  table { width:100%; border-collapse:collapse; font-size:11px; margin-top:8px; }
  th { text-align:left; color:#888; font-size:9px; text-transform:uppercase; padding:6px 4px; border-bottom:1px solid #333; }
  td { padding:6px 4px; vertical-align:top; }
  .stat-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-top:12px; }
  .stat { background:#111; border:1px solid #1f1f1f; border-radius:8px; padding:12px; }
  .stat .label { font-size:9px; color:#666; text-transform:uppercase; }
  .stat .value { font-size:18px; font-weight:bold; font-family:monospace; margin-top:4px; }
  img.chart { width:100%; background:#111; border-radius:8px; margin-top:12px; }
</style></head>
<body>
  <h1>TradeFlow Simulation Report</h1>
  <p style="color:#888;font-size:13px;">${c.symbol} · ${c.interval} · ${c.startDate} → ${c.endDate} · generated ${new Date().toLocaleString()}</p>

  <div class="stat-grid">
    <div class="stat"><div class="label">Final Capital</div><div class="value">${fmtUsd(result.finalCapital)}</div></div>
    <div class="stat"><div class="label">Total Return</div><div class="value">${fmtPct(result.totalReturn)}</div></div>
    <div class="stat"><div class="label">Win Rate</div><div class="value">${result.winRate.toFixed(1)}%</div></div>
    <div class="stat"><div class="label">Max Drawdown</div><div class="value">-${result.maxDrawdown.toFixed(1)}%</div></div>
  </div>

  ${svgDataUrl ? `<h2>Equity Curve</h2><img class="chart" src="${svgDataUrl}" alt="Equity curve" />` : ''}

  <h2>Rules Applied</h2>
  <table>
    <tr><td>Entry type</td><td>${c.entryTypeMode}</td><td>Max wait for fill</td><td>${c.maxWaitCandles} candles</td></tr>
    <tr><td>Session filter</td><td>${c.sessionFilter ? `${c.sessionStartHour}:00–${c.sessionEndHour}:00 UTC` : 'Off'}</td><td>Conviction scaling</td><td>${c.allowConvictionScaling ? 'On' : 'Off'}</td></tr>
    <tr><td>Daily / weekly loss limit</td><td>${(c.dailyLossLimitPct * 100).toFixed(1)}% / ${(c.weeklyLossLimitPct * 100).toFixed(1)}%</td><td>Loss streak cooldown</td><td>${c.maxConsecutiveLosses}</td></tr>
    <tr><td>Drawdown halt</td><td>${(c.drawdownHaltPct * 100).toFixed(0)}%</td><td>Trailing stop</td><td>${c.trailingStopMode}</td></tr>
    <tr><td>Regime filter</td><td colspan="3">${c.regimeFilter ? c.allowedRegimes.join(', ') : 'Off (all regimes)'}</td></tr>
  </table>

  <h2>Every Trade (${filledTrades.length}) — Entry/Exit and Reason</h2>
  <table>
    <thead><tr><th>#</th><th>Date</th><th>Pattern</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Exit Reason</th><th>P&L$</th><th>R</th><th>Score</th><th>Why</th></tr></thead>
    <tbody>${tradeRows}</tbody>
  </table>
</body></html>`;
}
