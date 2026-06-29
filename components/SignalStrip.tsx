'use client';

import { useEffect, useState } from 'react';
import type { Signal, ActiveSignal, WaitSignal } from '@/hooks/usePatternDetection';
import { POSITION_NOTIONAL_USD, type Trade, type SessionStats } from '@/lib/trade-manager';
import { classifySignalTier } from '@/lib/signal-tiers';

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

function fmtP(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 4 : 2 });
}

function pct(a: number, b: number) {
  const p = ((a - b) / b) * 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
}

// Dollar figures are always against the fixed $10,000 paper notional — never the raw price
// delta, which looks like a dollar amount but isn't one relative to position size.
function notionalUsd(pctChange: number) {
  const v = (pctChange / 100) * POSITION_NOTIONAL_USD;
  return `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(0)}`;
}

type Props = {
  signal: Signal;
  interval: string;
  activeTrade: Trade | null;
  symbol: string;
  currentPrice: number;
  sessionStats: SessionStats;
  onOpenTrade: () => void;
  onCloseTrade: () => void;
  onCancelTrade: () => void;
};

export default function SignalStrip({
  signal, interval, activeTrade, symbol, currentPrice, sessionStats,
  onOpenTrade, onCloseTrade, onCancelTrade,
}: Props) {
  const countdown = useCountdown(interval);
  const s = signal && signal.direction !== 'WAIT' ? (signal as ActiveSignal) : null;
  const wait = signal && signal.direction === 'WAIT' ? (signal as WaitSignal) : null;
  const trade = activeTrade && activeTrade.symbol === symbol ? activeTrade : null;

  const accent = s ? (s.direction === 'LONG' ? '#22c55e' : '#ef4444') : '#f59e0b';
  
  const tierInfo = s?.edgeScore ? classifySignalTier(s.edgeScore.finalEdgeScore) : null;

  return (
    <div className="h-[120px] flex-shrink-0 bg-[#111111] border-t border-[#1a1a1a] flex">

      {/* BOX 1 — Current Signal */}
      <div
        className="flex-[1.5] border-r border-[#1a1a1a] px-4 py-3 flex flex-col gap-1.5 min-w-0"
        style={{ borderLeft: `3px solid ${accent}` }}
      >
        {s ? (
          <>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded"
                  style={{
                    background: s.direction === 'LONG' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                    color: accent,
                    border: `1px solid ${s.direction === 'LONG' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                  }}
                >
                  {s.direction}
                </span>
                {tierInfo && (
                  <span
                    className="text-[10px] font-bold px-2 py-0.5 rounded border"
                    style={{
                      background: `${tierInfo.tierColor}15`,
                      color: tierInfo.tierColor,
                      borderColor: `${tierInfo.tierColor}40`,
                    }}
                  >
                    {tierInfo.tierLabel}
                  </span>
                )}
              </div>
              <span className="text-[11px] text-[#888888] truncate ml-2">{s.pattern.name}</span>
            </div>

            <div className="flex-1 flex flex-col justify-center gap-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-[9px] text-[#666] uppercase tracking-wider w-12 flex-shrink-0">Entry</span>
                <span className="text-[22px] font-mono font-bold text-[#f5f5f5] leading-none">{fmtP(s.entry)}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-[9px] text-[#666] uppercase tracking-wider w-12 flex-shrink-0">Target</span>
                <span className="text-[14px] font-mono text-[#22c55e]">{fmtP(s.target)}</span>
                <span className="text-[11px] text-[#22c55e]">{pct(s.target, s.entry)} ↑ ({notionalUsd(s.targetPct)})</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-[9px] text-[#666] uppercase tracking-wider w-12 flex-shrink-0">Stop</span>
                <span className="text-[14px] font-mono text-[#ef4444]">{fmtP(s.stop)}</span>
                <span className="text-[11px] text-[#ef4444]">{pct(s.stop, s.entry)} ↓ ({notionalUsd(s.stopPct)})</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-[13px] font-mono font-bold text-[#f59e0b]">R:R 1 : {s.riskReward}</span>
              <span className="text-[11px] text-[#888888]">Next: {fmt(countdown)}</span>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-[#f59e0b]/15 text-[#f59e0b] border border-[#f59e0b]/30">
                WAIT
              </span>
            </div>
            <div className="flex-1 flex flex-col justify-center gap-0.5">
              <span className="text-[13px] text-[#f5f5f5]">No Clear Setup</span>
              {wait && <span className="text-[10px] text-[#888888] truncate">{wait.reason}</span>}
            </div>
            <div className="flex items-center justify-end">
              <span className="text-[11px] text-[#888888]">Next: {fmt(countdown)}</span>
            </div>
          </>
        )}
      </div>

      {/* BOX 2 — Paper Trade */}
      <div className="flex-1 border-r border-[#1a1a1a] px-4 py-3 flex flex-col gap-1.5 min-w-0">
        <div className="text-[9px] text-[#666] uppercase tracking-wider">Paper Trade</div>

        {!trade && s && (
          <div className="flex-1 flex flex-col gap-1 justify-center">
            {s.direction === 'LONG' ? (
              <>
                <button
                  onClick={onOpenTrade}
                  className="w-full py-2.5 rounded text-[13px] font-bold border-2 border-[#22c55e] text-[#22c55e] hover:bg-[#22c55e]/10 transition-colors"
                >
                  ▲ Go LONG
                </button>
                <button disabled className="w-full py-1 rounded text-[10px] font-medium border border-[#1f1f1f] text-[#444] cursor-not-allowed">
                  ▼ Go SHORT
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={onOpenTrade}
                  className="w-full py-2.5 rounded text-[13px] font-bold border-2 border-[#ef4444] text-[#ef4444] hover:bg-[#ef4444]/10 transition-colors"
                >
                  ▼ Go SHORT
                </button>
                <button disabled className="w-full py-1 rounded text-[10px] font-medium border border-[#1f1f1f] text-[#444] cursor-not-allowed">
                  ▲ Go LONG
                </button>
              </>
            )}
          </div>
        )}

        {!trade && wait && (
          <div className="flex-1 flex flex-col gap-1 justify-center">
            <button disabled className="w-full py-1.5 rounded text-[11px] font-semibold border border-[#1f1f1f] text-[#444] cursor-not-allowed opacity-50">
              ▲ Go LONG
            </button>
            <button disabled className="w-full py-1.5 rounded text-[11px] font-semibold border border-[#1f1f1f] text-[#444] cursor-not-allowed opacity-50">
              ▼ Go SHORT
            </button>
            <span className="text-[10px] text-[#666] text-center">No signal — wait</span>
          </div>
        )}

        {!trade && !s && !wait && (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-[11px] text-[#555]">No signal to trade</span>
          </div>
        )}

        {trade?.status === 'pending' && (
          <div className="flex-1 flex flex-col gap-1 justify-center">
            <span className="text-[11px] text-[#f59e0b] live-dot">⏳ Pending Entry {fmtP(trade.entryPrice)}</span>
            <button onClick={onCancelTrade} className="text-[10px] text-[#888888] hover:text-[#f5f5f5] self-start underline">
              Cancel
            </button>
          </div>
        )}

        {(trade?.status === 'open' || trade?.status === 'partial') && trade.actualEntry && (
          <div className="flex-1 flex flex-col gap-1 justify-center">
            {(() => {
              const remainingPnlPct = ((currentPrice - trade.actualEntry!) / trade.actualEntry!) * 100 * (trade.direction === 'long' ? 1 : -1) * trade.remainingSize;
              const totalPnlPct = trade.realizedPnlPct + remainingPnlPct;
              const totalPnlUsd = (totalPnlPct / 100) * trade.positionSizeUsd;
              const riskPct = Math.abs(trade.actualEntry! - trade.stopLoss) / trade.actualEntry! * 100;
              const r = riskPct > 0 ? totalPnlPct / riskPct : 0;
              const color = totalPnlPct >= 0 ? '#22c55e' : '#ef4444';
              return (
                <>
                  <div className="flex items-center justify-between">
                    <span className={`text-[10px] font-bold uppercase ${trade.direction === 'long' ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                      {trade.direction.toUpperCase()}
                    </span>
                    <span className="text-[18px] font-mono font-bold" style={{ color }}>
                      {totalPnlUsd >= 0 ? '+' : ''}${Math.abs(totalPnlUsd).toFixed(0)}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono" style={{ color }}>
                    {totalPnlPct >= 0 ? '+' : ''}{totalPnlPct.toFixed(2)}% &middot; {r >= 0 ? '+' : ''}{r.toFixed(1)}R
                  </span>
                  <span className="text-[10px] text-[#888888]">
                    {trade.tp1Hit
                      ? `✅ TP1 filled @ $${trade.tp1.toFixed(0)} (${notionalUsd(trade.realizedPnlPct)} locked) — stop now breakeven`
                      : 'TP1 pending'}
                  </span>
                  <button onClick={onCloseTrade} className="text-[10px] text-[#ef4444] hover:underline self-start">
                    Close All
                  </button>
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* BOX 3 — Risk:Reward Visual */}
      <div className="flex-1 border-r border-[#1a1a1a] px-4 py-3 flex flex-col gap-2 min-w-0">
        <div className="text-[9px] text-[#666] uppercase tracking-wider">Risk : Reward</div>
        {s ? (
          <>
            {(() => {
              const lo = Math.min(s.stop, s.entry, s.target);
              const hi = Math.max(s.stop, s.entry, s.target);
              const range = hi - lo || 1;
              const stopPos = ((s.stop - lo) / range) * 100;
              const entryPos = ((s.entry - lo) / range) * 100;
              const targetPos = ((s.target - lo) / range) * 100;
              const cur = Math.max(0, Math.min(100, ((currentPrice - lo) / range) * 100));
              const riskLo = Math.min(stopPos, entryPos);
              const riskHi = Math.max(stopPos, entryPos);
              const rewardLo = Math.min(entryPos, targetPos);
              const rewardHi = Math.max(entryPos, targetPos);
              return (
                <div className="relative">
                  <div className="relative h-3 rounded-full bg-[#1e1e1e] overflow-hidden">
                    <div className="absolute inset-y-0 bg-[#ef4444]/60" style={{ left: `${riskLo}%`, width: `${riskHi - riskLo}%` }} />
                    <div className="absolute inset-y-0 bg-[#22c55e]/60" style={{ left: `${rewardLo}%`, width: `${rewardHi - rewardLo}%` }} />
                    <div
                      className="absolute top-1/2 w-2.5 h-2.5 rounded-full bg-white -translate-y-1/2 -translate-x-1/2"
                      style={{ left: `${cur}%`, border: '1.5px solid #0a0a0a' }}
                    />
                  </div>
                  <div className="flex justify-between text-[9px] font-mono mt-0.5">
                    <span className="text-[#ef4444]">{fmtP(s.stop)}</span>
                    <span className="text-[#f5f5f5]">{fmtP(s.entry)}</span>
                    <span className="text-[#22c55e]">{fmtP(s.target)}</span>
                  </div>
                  <div className="text-[9px] text-[#f5f5f5] text-center mt-0.5">{fmtP(currentPrice)}</div>
                </div>
              );
            })()}
            <div className="space-y-0.5 text-[10px] font-mono">
              <div className="flex justify-between"><span className="text-[#ef4444]">Risk</span><span className="text-[#ef4444]">{notionalUsd(s.stopPct)} ({Math.abs(s.stopPct).toFixed(1)}%)</span></div>
              <div className="flex justify-between"><span className="text-[#22c55e]">Reward</span><span className="text-[#22c55e]">{notionalUsd(s.targetPct)} (1:{s.riskReward})</span></div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-[11px] text-[#555]">—</span>
          </div>
        )}
      </div>

      {/* BOX 4 — Session */}
      <div className="flex-1 px-4 py-3 flex flex-col gap-1.5 min-w-0">
        <div className="text-[9px] text-[#666] uppercase tracking-wider">Today</div>
        {sessionStats.totalTrades > 0 ? (
          <div className="flex-1 flex flex-col justify-center gap-1">
            <div className="text-[20px] font-bold leading-none">
              <span className="text-[#22c55e]">{sessionStats.wins}W</span>
              <span className="text-[#888888] mx-1 text-[14px]">/</span>
              <span className="text-[#ef4444]">{sessionStats.losses}L</span>
            </div>
            <div className="text-[14px] text-[#f5f5f5]">Win Rate <span className="font-mono">{sessionStats.winRate.toFixed(0)}%</span></div>
            <div className={`text-[14px] font-mono ${sessionStats.totalPnl >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
              P&L {sessionStats.totalPnlUsd >= 0 ? '+' : ''}${Math.abs(sessionStats.totalPnlUsd).toFixed(0)} ({sessionStats.totalPnl >= 0 ? '+' : ''}{sessionStats.totalPnl.toFixed(2)}%)
            </div>
            <div className="text-[12px] text-[#f59e0b] font-mono">Avg R {sessionStats.avgRMultiple.toFixed(1)}R</div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-[11px] text-[#555]">No trades today</span>
          </div>
        )}
      </div>
    </div>
  );
}
