'use client';

import { useMemo, useState } from 'react';
import type { Trade, SessionStats } from '@/lib/trade-manager';

type Props = {
  tradeHistory: Trade[];
  sessionStats: SessionStats;
  currentPrice: number;
  symbol: string; // the symbol currently on screen — only its trades have a live price to compare against
  onClear: () => void;
};

// 'btcusdt' -> 'BTC' — live price is only available for whichever symbol is currently displayed,
// so every other row needs its own label to make sense sitting next to it.
function symbolLabel(raw: string) {
  return raw.toUpperCase().replace(/USDT$/, '');
}

function fmtClock(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDateTime(ms: number) {
  return new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' });
}

function fmtP(n: number) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtUsd(n: number) {
  return `${n >= 0 ? '+' : ''}$${Math.abs(n).toFixed(0)}`;
}

type RowStatus = 'WIN' | 'LOSS' | 'BE' | 'OPEN' | 'TP1_OPEN' | 'PENDING' | 'CANCELLED' | 'EXPIRED';

function getStatus(t: Trade): RowStatus {
  if (t.status === 'closed') {
    if (Math.abs(t.rMultiple) < 0.1) return 'BE';
    return t.totalPnlPct > 0 ? 'WIN' : 'LOSS';
  }
  if (t.status === 'open' || t.status === 'partial') return t.tp1Hit ? 'TP1_OPEN' : 'OPEN';
  if (t.status === 'pending') return 'PENDING';
  if (t.status === 'cancelled') return 'CANCELLED';
  return 'EXPIRED';
}

const EXIT_REASON_LABEL: Record<NonNullable<Trade['exitReason']>, string> = {
  target: 'Target',
  stop: 'Stop',
  breakeven_stop: 'BE Stop after TP1',
  manual: 'Manual',
};

// The label answers "why did it exit" directly — no need to cross-reference exitReason separately.
function statusLabel(t: Trade, status: RowStatus): string {
  const reason = t.exitReason ? EXIT_REASON_LABEL[t.exitReason] : 'Unknown';
  if (status === 'WIN') return `WIN · ${reason}`;
  if (status === 'LOSS') return `LOSS · ${reason}`;
  if (status === 'BE') return `BE · ${reason}`;
  if (status === 'TP1_OPEN') return 'TP1 ✓ · Open';
  if (status === 'OPEN') return 'OPEN';
  if (status === 'PENDING') return 'PENDING';
  if (status === 'CANCELLED') return 'CANCELLED';
  return 'EXPIRED';
}

const STATUS_COLOR: Record<RowStatus, string> = {
  WIN: '#22c55e',
  LOSS: '#ef4444',
  BE: '#888888',
  OPEN: '#f59e0b',
  TP1_OPEN: '#22c55e',
  PENDING: '#888888',
  CANCELLED: '#555555',
  EXPIRED: '#555555',
};

function rowBg(status: RowStatus) {
  if (status === 'WIN' || status === 'TP1_OPEN') return 'rgba(34,197,94,0.04)';
  if (status === 'LOSS') return 'rgba(239,68,68,0.04)';
  if (status === 'OPEN' || status === 'PENDING') return 'rgba(245,158,11,0.04)';
  return 'transparent';
}

const COLS = '64px 56px 100px 64px 110px 130px 110px 64px 150px';

function EquityCurve({ trades }: { trades: Trade[] }) {
  const closed = useMemo(
    () => [...trades].filter(t => t.status === 'closed').sort((a, b) => a.signalTime - b.signalTime),
    [trades]
  );
  if (closed.length < 4) return null;

  let cum = 0;
  const points = closed.map(t => { cum += t.totalPnlPct; return cum; });
  const w = 300, h = 40;
  const min = Math.min(0, ...points);
  const max = Math.max(0, ...points);
  const range = max - min || 1;
  const path = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const positive = points[points.length - 1] >= 0;

  return (
    <div className="h-10 flex-shrink-0 border-t border-[#1a1a1a] px-3 py-1">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-full">
        <path d={path} fill="none" stroke={positive ? '#22c55e' : '#ef4444'} strokeWidth={1.5} />
      </svg>
    </div>
  );
}

export default function TradeLog({ tradeHistory, sessionStats, currentPrice, symbol, onClear }: Props) {
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(() => [...tradeHistory].sort((a, b) => b.signalTime - a.signalTime), [tradeHistory]);
  const visible = showAll ? sorted : sorted.slice(0, 20);
  const hasMore = sorted.length > 20;

  return (
    <div className="h-[200px] flex-shrink-0 bg-[#0d0d0d] border-t border-[#1a1a1a] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="h-8 flex-shrink-0 flex items-center justify-between px-4 border-b border-[#1a1a1a] bg-[#111111]">
        <span className="text-[9px] text-[#666] uppercase tracking-wider flex-shrink-0">Trade Log · $10,000 per trade</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#22c55e]/15 text-[#22c55e]">{sessionStats.wins}W</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#ef4444]/15 text-[#ef4444]">{sessionStats.losses}L</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#1f1f1f] text-[#f5f5f5]">Win {sessionStats.winRate.toFixed(0)}%</span>
          <span className={`text-[9px] px-1.5 py-0.5 rounded bg-[#1f1f1f] ${sessionStats.totalPnl >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
            P&L {fmtUsd(sessionStats.totalPnlUsd)} ({sessionStats.totalPnl >= 0 ? '+' : ''}{sessionStats.totalPnl.toFixed(1)}%)
          </span>
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#1f1f1f] text-[#f59e0b]">Avg {sessionStats.avgRMultiple.toFixed(1)}R</span>
        </div>
        <button onClick={onClear} className="text-[10px] text-[#666] hover:text-[#f5f5f5] flex-shrink-0">Clear</button>
      </div>

      {/* Table — min-h-0 is required so this flex child actually shrinks to the remaining
          space and scrolls; without it a flex item won't shrink below its content size, so
          extra rows would just get silently clipped by the parent's overflow-hidden instead. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <span className="text-[12px] text-[#555]">No trades this session</span>
          </div>
        ) : (
          <>
            <div
              className="h-6 flex-shrink-0 grid items-center px-3 border-b border-[#1a1a1a] sticky top-0 bg-[#0d0d0d] z-10"
              style={{ gridTemplateColumns: COLS }}
            >
              {['OPENED', 'SYM', 'PATTERN', 'DIR', 'ENTRY', 'EXIT', 'P&L', 'R', 'STATUS / WHY'].map(h => (
                <span key={h} className="text-[8px] text-[#555] uppercase">{h}</span>
              ))}
            </div>
            {visible.map(t => {
              const status = getStatus(t);
              const color = STATUS_COLOR[status];
              const isLong = t.direction === 'long';
              const isOpenish = t.status === 'open' || t.status === 'partial';
              // currentPrice only ever reflects the symbol currently on screen — the app feeds
              // one live price stream at a time. Using it for a different symbol's open trade
              // (e.g. pricing a BTC position against SOL's price) produces a nonsense ~-99% swing.
              const isLiveSymbol = isOpenish && t.symbol === symbol;
              const livePnlPct = isLiveSymbol && t.actualEntry
                ? t.realizedPnlPct + ((currentPrice - t.actualEntry) / t.actualEntry) * 100 * (isLong ? 1 : -1) * t.remainingSize
                : null;
              const pnlPct = t.status === 'closed' ? t.totalPnlPct : (isLiveSymbol ? livePnlPct : (t.tp1Hit ? t.realizedPnlPct : null));
              const pnlUsd = pnlPct != null ? (pnlPct / 100) * t.positionSizeUsd : null;
              const rMult = t.status === 'closed' ? t.rMultiple : null;
              const exitTime = t.tp2HitTime ?? t.stopHitTime;

              return (
                <div
                  key={t.id}
                  className="h-11 grid items-center px-3 border-b border-[rgba(26,26,26,0.5)] hover:bg-white/[0.02]"
                  style={{ gridTemplateColumns: COLS, background: rowBg(status) }}
                  title={t.events.map(e => `${fmtDateTime(e.time)} — ${e.message}`).join('\n')}
                >
                  <span className="text-[10px] font-mono text-[#888888]">{fmtClock(t.signalTime * 1000)}</span>
                  <span className="text-[10px] font-bold text-[#8b5cf6]">{symbolLabel(t.symbol)}</span>
                  <span className="text-[11px] text-[#f5f5f5] truncate" title={t.patternName}>
                    {t.patternName.length > 12 ? `${t.patternName.slice(0, 12)}…` : t.patternName}
                  </span>
                  <span>
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${isLong ? 'bg-[#22c55e]/15 text-[#22c55e]' : 'bg-[#ef4444]/15 text-[#ef4444]'}`}>
                      {isLong ? 'LONG' : 'SHORT'}
                    </span>
                  </span>
                  <div className="flex flex-col leading-tight">
                    <span className="text-[11px] font-mono text-[#f5f5f5]">{t.actualEntry ? fmtP(t.actualEntry) : '—'}</span>
                    {t.entryTime && <span className="text-[9px] text-[#666]">{fmtClock(t.entryTime)}</span>}
                    {t.tp1Hit && (
                      <span className="text-[9px] text-[#22c55e]" title={`TP1 filled at $${t.tp1.toFixed(2)}`}>
                        ½ @ TP1 {t.tp1HitTime ? fmtClock(t.tp1HitTime) : ''}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col leading-tight">
                    <span className={`text-[11px] font-mono ${isOpenish ? 'text-[#f59e0b]' : 'text-[#f5f5f5]'}`}>
                      {t.status === 'closed' && t.actualExit ? fmtP(t.actualExit) : isOpenish ? 'Active' : '—'}
                    </span>
                    {exitTime && <span className="text-[9px] text-[#666]">{fmtClock(exitTime)}</span>}
                    {isOpenish && !isLiveSymbol && (
                      <span className="text-[9px] text-[#666]" title="Live price only available while this symbol is on screen">
                        view {symbolLabel(t.symbol)} for live
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col leading-tight">
                    <span className={`text-[12px] font-mono font-bold ${pnlUsd == null ? 'text-[#555]' : pnlUsd >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'} ${isOpenish ? 'italic' : ''}`}>
                      {pnlUsd == null ? '—' : fmtUsd(pnlUsd)}
                    </span>
                    {pnlPct != null && <span className="text-[9px] text-[#666]">{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</span>}
                  </div>
                  <span className={`text-[12px] font-mono ${rMult == null ? 'text-[#555]' : Math.abs(rMult) < 0.1 ? 'text-[#f59e0b]' : rMult > 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                    {rMult == null ? '—' : Math.abs(rMult) < 0.1 ? 'BE' : `${rMult >= 0 ? '+' : ''}${rMult.toFixed(1)}R`}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${status === 'OPEN' ? 'live-dot' : ''}`} style={{ background: color }} />
                    <span className="text-[10px] truncate" style={{ color }}>{statusLabel(t, status)}</span>
                  </span>
                </div>
              );
            })}
            {hasMore && !showAll && (
              <button onClick={() => setShowAll(true)} className="w-full py-1.5 text-[10px] text-[#888888] hover:text-[#f5f5f5]">
                Show {sorted.length - 20} older trades
              </button>
            )}
          </>
        )}
      </div>

      <EquityCurve trades={tradeHistory} />
    </div>
  );
}
