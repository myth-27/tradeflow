'use client';

import { useEffect, useState, useCallback } from 'react';

interface Trade {
  id: string;
  symbol: string;
  timeframe: string;
  direction: string;
  entry: number;
  stop_loss: number;
  tp1: number;
  tp2: number;
  pattern: string;
  edge_score: number;
  tier: string;
  opened_at: number;
  closed_at?: number;
  exit_price?: number;
  exit_reason?: string;
  pnl_pct?: number;
  status: string;
}

interface Signal {
  id: string;
  symbol: string;
  timeframe: string;
  pattern: string;
  direction: string;
  confidence: number;
  edge_score: number;
  tier: string;
  regime: string;
  entry: number;
  acted: boolean;
  reason?: string;
  detected_at: number;
}

interface LiveState {
  halted: boolean;
  capital: number;
  dailyPnl: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  openTrades: Trade[];
  closedTrades: Trade[];
  recentSignals: Signal[];
  livePrices: Record<string, number>;
}

const POLL_INTERVAL = 10_000;

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

function pnlColor(v: number): string {
  if (v > 0) return 'text-green-400';
  if (v < 0) return 'text-red-400';
  return 'text-gray-400';
}

function tierBadge(tier: string): string {
  const map: Record<string, string> = {
    'A+': 'bg-yellow-500 text-black',
    'A': 'bg-green-600 text-white',
    'B': 'bg-blue-600 text-white',
    'C': 'bg-gray-600 text-white',
  };
  return map[tier] ?? 'bg-gray-700 text-white';
}

export default function LivePage() {
  const [state, setState] = useState<LiveState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/live/state');
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }));
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      setState(await res.json());
      setLastUpdated(new Date());
    } catch {
      setError('Network error — retrying…');
    }
  }, []);

  useEffect(() => {
    fetchState();
    const id = setInterval(fetchState, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchState]);

  const toggleHalt = async () => {
    setToggling(true);
    try {
      const res = await fetch('/api/live/halt-proxy', { method: 'POST' });
      if (res.ok) {
        await fetchState();
      }
    } finally {
      setToggling(false);
    }
  };

  if (error && !state) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-red-400 text-center">
          <div className="text-2xl mb-2">Engine Unavailable</div>
          <div className="text-sm text-gray-500">{error}</div>
          <div className="text-sm text-gray-600 mt-1">DATABASE_URL may not be configured.</div>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-400 animate-pulse">Loading live engine…</div>
      </div>
    );
  }

  const { halted, dailyPnl, totalTrades, wins, losses, winRate,
    openTrades, closedTrades, recentSignals, livePrices } = state;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-4 font-mono text-sm">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">TradeFlow Live Engine</h1>
          {lastUpdated && (
            <div className="text-xs text-gray-500">
              Updated {lastUpdated.toLocaleTimeString()} · auto-refresh 10s
            </div>
          )}
        </div>
        <button
          onClick={toggleHalt}
          disabled={toggling}
          className={`px-4 py-2 rounded font-bold text-sm transition-colors ${
            halted
              ? 'bg-green-700 hover:bg-green-600 text-white'
              : 'bg-red-700 hover:bg-red-600 text-white'
          }`}
        >
          {toggling ? '…' : halted ? 'RESUME ENGINE' : 'HALT ENGINE'}
        </button>
      </div>

      {halted && (
        <div className="mb-4 p-3 rounded bg-red-900/40 border border-red-700 text-red-300 text-xs">
          ENGINE HALTED — no new trades will be opened
        </div>
      )}
      {error && (
        <div className="mb-4 p-2 rounded bg-yellow-900/30 border border-yellow-700 text-yellow-300 text-xs">
          {error}
        </div>
      )}

      {/* Live Prices */}
      <div className="flex flex-wrap gap-3 mb-6">
        {Object.entries(livePrices).map(([sym, price]) => (
          <div key={sym} className="bg-gray-900 rounded px-3 py-2">
            <span className="text-gray-400 mr-2">{sym}</span>
            <span className="text-white font-bold">${fmt(price, price > 100 ? 2 : 4)}</span>
          </div>
        ))}
        {Object.keys(livePrices).length === 0 && (
          <div className="text-gray-600 text-xs">Waiting for price feed…</div>
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Daily P&L" value={`${dailyPnl >= 0 ? '+' : ''}$${fmt(dailyPnl)}`}
          color={dailyPnl >= 0 ? 'text-green-400' : 'text-red-400'} />
        <StatCard label="Total Trades" value={String(totalTrades)} />
        <StatCard label="Win Rate" value={`${winRate}%`}
          sub={`${wins}W / ${losses}L`}
          color={winRate >= 50 ? 'text-green-400' : 'text-red-400'} />
        <StatCard label="Open Positions" value={String(openTrades.length)}
          color={openTrades.length > 0 ? 'text-yellow-400' : 'text-gray-400'} />
      </div>

      {/* Open Trades */}
      <Section title={`Open Positions (${openTrades.length})`}>
        {openTrades.length === 0 ? (
          <div className="text-gray-600 p-3">No open positions</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                {['Symbol', 'TF', 'Dir', 'Entry', 'Stop', 'TP1', 'TP2', 'Pattern', 'Edge', 'Live P&L'].map(h => (
                  <th key={h} className="text-left py-2 px-2">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {openTrades.map(t => {
                const live = livePrices[t.symbol] ?? t.entry;
                const livePnl = t.direction === 'long'
                  ? ((live - t.entry) / t.entry) * 100
                  : ((t.entry - live) / t.entry) * 100;
                return (
                  <tr key={t.id} className="border-b border-gray-800/50 hover:bg-gray-900/30">
                    <td className="py-2 px-2 text-white font-bold">{t.symbol}</td>
                    <td className="py-2 px-2 text-gray-400">{t.timeframe}</td>
                    <td className={`py-2 px-2 font-bold ${t.direction === 'long' ? 'text-green-400' : 'text-red-400'}`}>
                      {t.direction.toUpperCase()}
                    </td>
                    <td className="py-2 px-2">{fmt(t.entry, 4)}</td>
                    <td className="py-2 px-2 text-red-400">{fmt(t.stop_loss, 4)}</td>
                    <td className="py-2 px-2 text-blue-400">{fmt(t.tp1, 4)}</td>
                    <td className="py-2 px-2 text-green-400">{fmt(t.tp2, 4)}</td>
                    <td className="py-2 px-2 text-gray-300">{t.pattern}</td>
                    <td className="py-2 px-2">
                      <span className={`px-1 py-0.5 rounded text-[10px] ${tierBadge(t.tier)}`}>{t.tier}</span>
                      <span className="ml-1 text-gray-400">{t.edge_score.toFixed(0)}</span>
                    </td>
                    <td className={`py-2 px-2 font-bold ${pnlColor(livePnl)}`}>
                      {livePnl >= 0 ? '+' : ''}{livePnl.toFixed(2)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      {/* Recent Signals */}
      <Section title="Recent Signals (last 30)">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-800">
              {['Time', 'Symbol', 'TF', 'Pattern', 'Dir', 'Edge', 'Regime', 'Acted', 'Reason'].map(h => (
                <th key={h} className="text-left py-2 px-2">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recentSignals.map(s => (
              <tr key={s.id} className="border-b border-gray-800/50 hover:bg-gray-900/30">
                <td className="py-2 px-2 text-gray-500">{new Date(s.detected_at).toLocaleTimeString()}</td>
                <td className="py-2 px-2 text-white">{s.symbol}</td>
                <td className="py-2 px-2 text-gray-400">{s.timeframe}</td>
                <td className="py-2 px-2 text-gray-300">{s.pattern}</td>
                <td className={`py-2 px-2 font-bold ${s.direction === 'long' ? 'text-green-400' : 'text-red-400'}`}>
                  {s.direction.toUpperCase()}
                </td>
                <td className="py-2 px-2">
                  <span className={`px-1 py-0.5 rounded text-[10px] ${tierBadge(s.tier)}`}>{s.tier}</span>
                  <span className="ml-1 text-gray-400">{s.edge_score.toFixed(0)}</span>
                </td>
                <td className="py-2 px-2 text-gray-500">{s.regime}</td>
                <td className="py-2 px-2">
                  {s.acted
                    ? <span className="text-green-400">✓ traded</span>
                    : <span className="text-gray-600">skipped</span>}
                </td>
                <td className="py-2 px-2 text-gray-600">{s.reason ?? ''}</td>
              </tr>
            ))}
            {recentSignals.length === 0 && (
              <tr><td colSpan={9} className="py-3 px-2 text-gray-600">No signals yet — waiting for market activity</td></tr>
            )}
          </tbody>
        </table>
      </Section>

      {/* Closed Trades */}
      <Section title="Closed Trades (last 20)">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-800">
              {['Time', 'Symbol', 'TF', 'Pattern', 'Dir', 'Entry', 'Exit', 'Reason', 'P&L'].map(h => (
                <th key={h} className="text-left py-2 px-2">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {closedTrades.map(t => (
              <tr key={t.id}
                className={`border-b border-gray-800/50 ${
                  (t.pnl_pct ?? 0) > 0 ? 'bg-green-950/20' : 'bg-red-950/20'
                }`}>
                <td className="py-2 px-2 text-gray-500">
                  {t.closed_at ? new Date(t.closed_at).toLocaleTimeString() : '—'}
                </td>
                <td className="py-2 px-2 text-white">{t.symbol}</td>
                <td className="py-2 px-2 text-gray-400">{t.timeframe}</td>
                <td className="py-2 px-2 text-gray-300">{t.pattern}</td>
                <td className={`py-2 px-2 font-bold ${t.direction === 'long' ? 'text-green-400' : 'text-red-400'}`}>
                  {t.direction.toUpperCase()}
                </td>
                <td className="py-2 px-2">{fmt(t.entry, 4)}</td>
                <td className="py-2 px-2">{t.exit_price ? fmt(t.exit_price, 4) : '—'}</td>
                <td className="py-2 px-2 text-gray-400">{t.exit_reason ?? '—'}</td>
                <td className={`py-2 px-2 font-bold ${pnlColor(t.pnl_pct ?? 0)}`}>
                  {t.pnl_pct != null ? `${t.pnl_pct >= 0 ? '+' : ''}${t.pnl_pct.toFixed(2)}%` : '—'}
                </td>
              </tr>
            ))}
            {closedTrades.length === 0 && (
              <tr><td colSpan={9} className="py-3 px-2 text-gray-600">No closed trades yet</td></tr>
            )}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

function StatCard({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-gray-900 rounded p-4">
      <div className="text-gray-500 text-xs mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color ?? 'text-white'}`}>{value}</div>
      {sub && <div className="text-gray-500 text-xs mt-1">{sub}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 bg-gray-900 rounded overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800 text-gray-300 font-semibold text-xs uppercase tracking-wider">
        {title}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}
