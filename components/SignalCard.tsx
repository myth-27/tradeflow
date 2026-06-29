'use client';

import { useEffect, useState } from 'react';
import type { Indicators, SignalHistoryEntry, Signal, ActiveSignal } from '@/hooks/usePatternDetection';
import type { PatternResult } from '@/lib/pattern-engine';
import EdgeScoreDisplay from './EdgeScoreDisplay';

const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400,
};

function useCountdown(interval: string) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const update = () => {
      const now = Math.floor(Date.now() / 1000);
      const iv = INTERVAL_SECONDS[interval] ?? 300;
      setSecs(iv - (now % iv));
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [interval]);
  return secs;
}

function fmt(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtP(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function ConfidenceBar({ value }: { value: number }) {
  const color = value >= 75 ? 'bg-[#22c55e]' : value >= 60 ? 'bg-[#f59e0b]' : 'bg-[#ef4444]';
  return (
    <div className="w-full bg-[#1f1f1f] rounded-full h-[3px] mt-1 mb-2">
      <div className={`h-[3px] rounded-full transition-all duration-500 ${color}`} style={{ width: `${value}%` }} />
    </div>
  );
}

function PatternCard({ p }: { p: PatternResult }) {
  const bullish = p.type === 'bullish';
  return (
    <div
      className={`border rounded-lg p-3 ${
        bullish ? 'border-[#22c55e]/30 bg-[#22c55e]/5' : 'border-[#ef4444]/30 bg-[#ef4444]/5'
      }`}
      style={{ borderLeft: `3px solid ${bullish ? '#22c55e' : '#ef4444'}` }}
    >
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-xs font-semibold text-[#f5f5f5]">{p.name}</span>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
          bullish
            ? 'bg-[#22c55e]/15 border-[#22c55e]/40 text-[#22c55e]'
            : 'bg-[#ef4444]/15 border-[#ef4444]/40 text-[#ef4444]'
        }`}>
          {bullish ? 'BULLISH' : 'BEARISH'}
        </span>
      </div>
      <div className="text-[10px] text-[#888888] mb-0.5">{p.confidence}% confidence</div>
      <ConfidenceBar value={p.confidence} />

      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
        <span className="text-[#888888]">Support</span>
        <span className="text-[#3b82f6] text-right font-mono">{fmtP(p.support)}</span>
        <span className="text-[#888888]">Resistance</span>
        <span className="text-[#ef4444] text-right font-mono">{fmtP(p.resistance)}</span>
        <span className="text-[#888888]">Target</span>
        <span className="text-[#22c55e] text-right font-mono">{fmtP(p.target)}</span>
        <span className="text-[#888888]">Stop Loss</span>
        <span className="text-[#f59e0b] text-right font-mono">{fmtP(p.stopLoss)}</span>
        <span className="text-[#888888]">R:R</span>
        <span className="text-[#f5f5f5] text-right font-mono">1:{p.riskReward}</span>
      </div>
    </div>
  );
}

type Props = {
  patterns: PatternResult[];
  isOpposing: boolean;
  conflictText: string;
  indicators: Indicators;
  interval: string;
  signalHistory: SignalHistoryEntry[];
  signal: Signal;
  onAnalyze: () => void;
};

export default function SignalCard({
  patterns, isOpposing, conflictText, indicators, interval, signalHistory, signal, onAnalyze,
}: Props) {
  const countdown = useCountdown(interval);
  const { rsi, macd, atr, volumeProfile, trendDirection } = indicators;

  const rsiColor = rsi < 30 ? 'text-[#22c55e]' : rsi > 70 ? 'text-[#ef4444]' : 'text-[#888888]';
  const rsiLabel = rsi < 30 ? 'Oversold' : rsi > 70 ? 'Overbought' : 'Neutral';
  const trendArrow = trendDirection === 'up' ? '↗' : trendDirection === 'down' ? '↘' : '→';
  const trendColor = trendDirection === 'up' ? 'text-[#22c55e]' : trendDirection === 'down' ? 'text-[#ef4444]' : 'text-[#888888]';

  const showWait = isOpposing || patterns.length === 0;

  return (
    <div className="flex flex-col h-full bg-[#111111] border-r border-[#1f1f1f] overflow-y-auto">
      <div className="px-3 py-2.5 border-b border-[#1f1f1f]">
        <h2 className="text-[10px] font-semibold text-[#888888] uppercase tracking-wider">Patterns</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">

        {showWait && (
          <div className="border border-[#f59e0b]/40 bg-[#f59e0b]/10 rounded-lg p-3" style={{ borderLeft: '3px solid #f59e0b' }}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-bold text-[#f5f5f5]">
                {isOpposing ? 'No Clear Setup' : 'Scanning...'}
              </span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded border border-[#f59e0b]/50 bg-[#f59e0b]/15 text-[#f59e0b]">
                ⏳ WAIT
              </span>
            </div>
            {isOpposing && (
              <p className="text-[10px] text-[#888888] leading-tight mb-1">{conflictText}</p>
            )}
            <div className="flex items-center justify-between text-[10px] text-[#888888] mt-2">
              <span>Next candle in</span>
              <span className="font-mono text-[#f5f5f5]">{fmt(countdown)}</span>
            </div>
          </div>
        )}

        {!showWait && !signal && patterns.slice(0, 2).map(p => <PatternCard key={p.name} p={p} />)}
        
        {signal && signal.direction !== 'WAIT' && (
          <div className="mb-2">
            <EdgeScoreDisplay edgeScore={(signal as ActiveSignal).edgeScore || null} compact />
          </div>
        )}

        {/* Indicators */}
        <div className="pt-1 border-t border-[#1f1f1f]">
          <div className="text-[10px] text-[#888888] uppercase tracking-wider mb-2">Indicators</div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[#888888]">RSI (14)</span>
              <div className="flex items-center gap-1.5">
                <span className={`text-[10px] font-mono ${rsiColor}`}>{rsi.toFixed(1)}</span>
                <span className={`text-[9px] ${rsiColor}`}>{rsiLabel}</span>
              </div>
            </div>
            <div className="w-full bg-[#1f1f1f] rounded-full h-[2px]">
              <div
                className={`h-[2px] rounded-full ${rsi < 30 ? 'bg-[#22c55e]' : rsi > 70 ? 'bg-[#ef4444]' : 'bg-[#f59e0b]'}`}
                style={{ width: `${Math.min(100, rsi)}%` }}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[#888888]">MACD</span>
              <span className={`text-[10px] font-medium ${macd.histogram > 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                {macd.histogram > 0 ? '↑ Bullish' : '↓ Bearish'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[#888888]">ATR</span>
              <span className="text-[10px] font-mono text-[#f5f5f5]">{atr.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[#888888]">Volume</span>
              <span className={`text-[10px] font-medium ${volumeProfile.volumeRatio > 1.5 ? 'text-[#f59e0b]' : 'text-[#f5f5f5]'}`}>
                {volumeProfile.volumeRatio.toFixed(1)}x avg
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[#888888]">Trend</span>
              <span className={`text-[10px] font-medium ${trendColor}`}>{trendArrow} {trendDirection}</span>
            </div>
          </div>
        </div>

        {/* Signal history */}
        {signalHistory.length > 0 && (
          <div className="pt-1 border-t border-[#1f1f1f]">
            <div className="text-[10px] text-[#888888] uppercase tracking-wider mb-2">Recent</div>
            <div className="space-y-1">
              {signalHistory.slice(0, 3).map(e => (
                <div key={e.id} className="flex items-center gap-1.5 text-[9px]">
                  <span className="text-[#555] w-8 flex-shrink-0">{fmtTime(e.timestamp)}</span>
                  <span className="text-[#888888] flex-1 truncate">{e.patternName}</span>
                  <span className={`flex-shrink-0 ${e.direction === 'LONG' ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>{e.direction}</span>
                  <span className={`flex-shrink-0 ${
                    e.outcome === 'target_hit' ? 'text-[#22c55e]' :
                    e.outcome === 'stop_hit' ? 'text-[#ef4444]' : 'text-[#555]'
                  }`}>
                    {e.outcome === 'target_hit' ? '✓' : e.outcome === 'stop_hit' ? '✗' : '·'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Analyze button */}
      <div className="px-3 py-3 border-t border-[#1f1f1f]">
        <button
          onClick={onAnalyze}
          disabled={!signal || signal.direction === 'WAIT'}
          className="w-full py-2 px-3 bg-[#3b82f6] hover:bg-[#3b82f6]/80 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Analyze with GPT-4o
        </button>
      </div>
    </div>
  );
}
