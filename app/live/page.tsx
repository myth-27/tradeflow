'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { CandleChart, type CandleData } from './chart';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Trade {
  id: string;
  symbol: string;
  timeframe: string;
  direction: string;
  entry: number;
  stop_loss: number;
  tp1: number;
  tp2: number;
  tp1_hit: boolean;
  pattern: string;
  edge_score: number;
  tier: string;
  size: number;
  opened_at: number;
  closed_at?: number;
  exit_price?: number;
  exit_reason?: string;
  pnl_pct?: number;
  pnl_abs?: number;
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

interface SymbolStat {
  wins: number;
  losses: number;
  totalPnl: number;
  trades: number;
}

interface EquityPoint { t: number; v: number }

interface LiveState {
  halted: boolean;
  engineEnabled: boolean;
  capital: number;
  totalPnlAbs: number;
  totalPnlPct: number;
  dailyPnl: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  openTrades: Trade[];
  closedTrades: Trade[];
  recentSignals: Signal[];
  symbolStats: Record<string, SymbolStat>;
  equityCurve: EquityPoint[];
  livePrices: Record<string, number>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number, d = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPrice(n: number) { return n > 100 ? fmt(n, 2) : fmt(n, 4); }
function pnlClass(v: number) { return v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-gray-400'; }
function sign(v: number) { return v > 0 ? '+' : ''; }

function tierBadge(tier: string) {
  const map: Record<string, string> = {
    'A+': 'bg-yellow-500 text-black',
    'A': 'bg-green-700 text-white',
    'B': 'bg-blue-700 text-white',
    'C': 'bg-gray-700 text-white',
  };
  return `px-1 py-0.5 rounded text-[10px] font-bold ${map[tier] ?? 'bg-gray-800 text-white'}`;
}

// ─── Equity Curve SVG ─────────────────────────────────────────────────────────

function EquityCurve({ points }: { points: EquityPoint[] }) {
  const W = 600; const H = 100; const PAD = 4;
  if (points.length < 2) {
    return (
      <div className="h-[100px] flex items-center justify-center text-gray-700 text-xs">
        Waiting for closed trades…
      </div>
    );
  }
  const values = points.map(p => p.v);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const pts = points.map((p, i) => {
    const x = PAD + ((i / (points.length - 1)) * (W - PAD * 2));
    const y = H - PAD - ((p.v - min) / range) * (H - PAD * 2);
    return `${x},${y}`;
  });
  const last = points[points.length - 1].v;
  const color = last >= 0 ? '#22c55e' : '#ef4444';
  const zeroY = H - PAD - ((0 - min) / range) * (H - PAD * 2);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[100px]" preserveAspectRatio="none">
      {/* Zero line */}
      <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke="#374151" strokeWidth="1" strokeDasharray="4 2" />
      {/* Fill under curve */}
      <polyline
        points={[`${PAD},${H - PAD}`, ...pts, `${W - PAD},${H - PAD}`].join(' ')}
        fill={color} fillOpacity="0.08" stroke="none"
      />
      {/* Curve */}
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" />
      {/* Last point dot */}
      {pts.length > 0 && (
        <circle
          cx={parseFloat(pts[pts.length - 1].split(',')[0])}
          cy={parseFloat(pts[pts.length - 1].split(',')[1])}
          r="3" fill={color}
        />
      )}
    </svg>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function LivePage() {
  const [state, setState] = useState<LiveState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [tab, setTab] = useState<'open' | 'signals' | 'closed'>('open');
  const [chartSymbol, setChartSymbol] = useState('BTCUSDT');
  const [chartTf, setChartTf] = useState<'15' | '60'>('15');
  const [rawCandles, setRawCandles] = useState<Record<string, CandleData[]>>({});

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/live/state');
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
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
    const id = setInterval(fetchState, 5_000);
    return () => clearInterval(id);
  }, [fetchState]);

  // Candle data: fetch selected symbol on mount and when symbol/tf changes; refresh every 60s
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`/api/live/candles?symbol=${chartSymbol}&tf=${chartTf}&limit=80`);
        if (res.ok) {
          const data: CandleData[] = await res.json();
          setRawCandles(prev => ({ ...prev, [`${chartSymbol}:${chartTf}`]: data }));
        }
      } catch { /* non-critical */ }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [chartSymbol, chartTf]);

  const toggleHalt = async () => {
    setToggling(true);
    try {
      const res = await fetch('/api/live/halt-proxy', { method: 'POST' });
      if (res.ok) await fetchState();
    } finally {
      setToggling(false);
    }
  };

  // Live unrealized P&L for open trades
  const openWithLivePnl = useMemo(() => {
    if (!state) return [];
    return state.openTrades.map(t => {
      const live = state.livePrices[t.symbol] ?? t.entry;
      const pnl = t.direction === 'long'
        ? ((live - t.entry) / t.entry) * 100
        : ((t.entry - live) / t.entry) * 100;
      const pnlAbs = (pnl / 100) * t.entry * t.size;
      return { ...t, livePnl: pnl, livePnlAbs: pnlAbs };
    });
  }, [state]);

  const unrealizedAbs = useMemo(
    () => openWithLivePnl.reduce((s, t) => s + t.livePnlAbs, 0),
    [openWithLivePnl],
  );

  // Inject current live price into the last (forming) candle so chart feels real-time
  const liveCandles = useMemo((): CandleData[] => {
    const key = `${chartSymbol}:${chartTf}`;
    const arr = rawCandles[key];
    if (!arr?.length) return [];
    const lp = state?.livePrices?.[chartSymbol];
    if (!lp) return arr;
    const last = arr[arr.length - 1];
    return [
      ...arr.slice(0, -1),
      { ...last, c: lp, h: Math.max(last.h, lp), l: Math.min(last.l, lp) },
    ];
  }, [rawCandles, chartSymbol, chartTf, state?.livePrices]);

  // ── Error state ────────────────────────────────────────────────────────────
  if (error && !state) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center text-center">
        <div>
          <div className="text-red-400 text-xl mb-2">Engine Unavailable</div>
          <div className="text-gray-500 text-sm">{error}</div>
          <div className="text-gray-600 text-xs mt-1">DATABASE_URL may not be configured on this deployment.</div>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-500 animate-pulse">Connecting to live engine…</div>
      </div>
    );
  }

  const { halted, engineEnabled, capital, totalPnlAbs, totalPnlPct, dailyPnl,
    totalTrades, wins, losses, winRate, recentSignals, closedTrades,
    symbolStats, equityCurve, livePrices } = state;

  const totalWithUnrealized = totalPnlAbs + unrealizedAbs;
  const symbols = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-mono text-sm">
      {/* ── Header ── */}
      <div className="border-b border-gray-800 px-4 py-3 flex items-center justify-between">
        <div>
          <span className="text-white font-bold text-base">TradeFlow</span>
          <span className="text-gray-600 ml-2 text-xs">Live Paper Engine</span>
          {!engineEnabled && (
            <span className="ml-3 px-2 py-0.5 bg-yellow-900/60 text-yellow-400 rounded text-[10px] border border-yellow-700">
              DASHBOARD ONLY — engine on Railway
            </span>
          )}
          {halted && (
            <span className="ml-3 px-2 py-0.5 bg-red-900/60 text-red-400 rounded text-[10px] border border-red-700">
              HALTED
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-gray-600 text-[10px]">
              {lastUpdated.toLocaleTimeString()} · 5s refresh
            </span>
          )}
          {error && <span className="text-yellow-500 text-xs">{error}</span>}
          <button
            onClick={toggleHalt}
            disabled={toggling}
            className={`px-3 py-1.5 rounded text-xs font-bold transition-colors ${
              halted ? 'bg-green-700 hover:bg-green-600' : 'bg-red-800 hover:bg-red-700'
            }`}
          >
            {toggling ? '…' : halted ? 'RESUME' : 'HALT'}
          </button>
        </div>
      </div>

      {/* ── Price strip ── */}
      <div className="border-b border-gray-800/60 bg-gray-900/30 px-4 py-2 flex flex-wrap gap-x-6 gap-y-1">
        {symbols.map(sym => {
          const price = livePrices[`${sym}USDT`];
          return (
            <span key={sym} className="text-xs">
              <span className="text-gray-500">{sym} </span>
              <span className="text-white font-bold">
                {price ? `$${fmtPrice(price)}` : '—'}
              </span>
            </span>
          );
        })}
        {Object.keys(livePrices).length === 0 && (
          <span className="text-gray-700 text-xs">Waiting for price feed…</span>
        )}
      </div>

      <div className="p-4 space-y-4">
        {/* ── Stats row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard
            label="Total P&L"
            value={`${sign(totalWithUnrealized)}$${fmt(Math.abs(totalWithUnrealized))}`}
            sub={`${sign(totalPnlPct)}${fmt(Math.abs(totalPnlPct))}% of capital`}
            color={pnlClass(totalWithUnrealized)}
          />
          <StatCard
            label="Realized P&L"
            value={`${sign(totalPnlAbs)}$${fmt(Math.abs(totalPnlAbs))}`}
            color={pnlClass(totalPnlAbs)}
          />
          <StatCard
            label="Unrealized"
            value={`${sign(unrealizedAbs)}$${fmt(Math.abs(unrealizedAbs))}`}
            sub={`${openWithLivePnl.length} open`}
            color={pnlClass(unrealizedAbs)}
          />
          <StatCard
            label="Daily P&L"
            value={`${sign(dailyPnl)}$${fmt(Math.abs(dailyPnl))}`}
            color={pnlClass(dailyPnl)}
          />
          <StatCard
            label="Win Rate"
            value={`${winRate}%`}
            sub={`${wins}W / ${losses}L / ${totalTrades} total`}
            color={winRate >= 55 ? 'text-green-400' : winRate >= 45 ? 'text-yellow-400' : 'text-red-400'}
          />
          <StatCard
            label="Capital"
            value={`$${fmt(capital)}`}
            sub="starting"
          />
        </div>

        {/* ── Live Charts ── */}
        <div className="bg-gray-900 rounded overflow-hidden">
          {/* Chart header */}
          <div className="px-4 py-2 border-b border-gray-800 flex flex-wrap items-center justify-between gap-2">
            <span className="text-gray-400 text-xs uppercase tracking-wider">Live Chart</span>
            <div className="flex items-center gap-2">
              {/* Timeframe selector */}
              <div className="flex gap-1">
                {(['15', '60'] as const).map(tf => (
                  <button
                    key={tf}
                    onClick={() => setChartTf(tf)}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${
                      chartTf === tf ? 'bg-blue-700 text-white' : 'text-gray-600 hover:text-gray-300'
                    }`}
                  >
                    {tf === '15' ? '15m' : '1h'}
                  </button>
                ))}
              </div>
              {/* Symbol selector */}
              <div className="flex gap-1">
                {['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'].map(sym => {
                  const short = sym.replace('USDT', '');
                  const price = livePrices[sym];
                  const hasOpenTrade = openWithLivePnl.some(t => t.symbol === sym);
                  return (
                    <button
                      key={sym}
                      onClick={() => setChartSymbol(sym)}
                      className={`px-2 py-0.5 rounded text-[10px] font-bold transition-colors flex items-center gap-1 ${
                        chartSymbol === sym
                          ? 'bg-blue-700 text-white'
                          : 'text-gray-500 hover:text-gray-200'
                      }`}
                    >
                      {short}
                      {hasOpenTrade && <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />}
                    </button>
                  );
                })}
              </div>
              {livePrices[chartSymbol] && (
                <span className="text-yellow-400 text-xs font-bold ml-1">
                  ${fmtPrice(livePrices[chartSymbol])}
                </span>
              )}
            </div>
          </div>

          {/* Chart body */}
          <div className="px-1 pt-1 pb-0">
            <CandleChart
              symbol={chartSymbol}
              candles={liveCandles}
              trade={openWithLivePnl.find(t => t.symbol === chartSymbol) ?? null}
              livePrice={livePrices[chartSymbol]}
            />
          </div>

          {/* No data state */}
          {liveCandles.length === 0 && (
            <div className="py-8 text-center text-gray-700 text-xs">
              Fetching candles for {chartSymbol.replace('USDT', '')}…
            </div>
          )}
        </div>

        {/* ── Equity Curve ── */}
        <div className="bg-gray-900 rounded overflow-hidden">
          <div className="px-4 py-2 flex items-center justify-between border-b border-gray-800">
            <span className="text-gray-400 text-xs uppercase tracking-wider">Equity Curve</span>
            <span className={`text-sm font-bold ${pnlClass(totalPnlAbs)}`}>
              {sign(totalPnlAbs)}${fmt(Math.abs(totalPnlAbs))} realized
            </span>
          </div>
          <div className="px-2 py-1">
            <EquityCurve points={equityCurve} />
          </div>
        </div>

        {/* ── Per-symbol breakdown ── */}
        {Object.keys(symbolStats).length > 0 && (
          <div className="bg-gray-900 rounded overflow-hidden">
            <div className="px-4 py-2 border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
              By Symbol
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-600 border-b border-gray-800">
                    {['Symbol', 'Trades', 'W', 'L', 'Win Rate', 'Total P&L'].map(h => (
                      <th key={h} className="text-left py-2 px-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(symbolStats)
                    .sort((a, b) => b[1].totalPnl - a[1].totalPnl)
                    .map(([sym, s]) => {
                      const wr = s.wins + s.losses > 0
                        ? Math.round((s.wins / (s.wins + s.losses)) * 100)
                        : 0;
                      return (
                        <tr key={sym} className="border-b border-gray-800/40 hover:bg-gray-800/30">
                          <td className="py-2 px-3 text-white font-bold">{sym}</td>
                          <td className="py-2 px-3 text-gray-400">{s.trades}</td>
                          <td className="py-2 px-3 text-green-400">{s.wins}</td>
                          <td className="py-2 px-3 text-red-400">{s.losses}</td>
                          <td className={`py-2 px-3 font-bold ${wr >= 55 ? 'text-green-400' : wr >= 45 ? 'text-yellow-400' : 'text-red-400'}`}>
                            {wr}%
                          </td>
                          <td className={`py-2 px-3 font-bold ${pnlClass(s.totalPnl)}`}>
                            {sign(s.totalPnl)}${fmt(Math.abs(s.totalPnl))}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Tab switcher ── */}
        <div className="bg-gray-900 rounded overflow-hidden">
          <div className="flex border-b border-gray-800">
            {([
              ['open', `Open (${openWithLivePnl.length})`],
              ['signals', `Signals (${recentSignals.length})`],
              ['closed', `Closed (${closedTrades.length})`],
            ] as const).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 text-xs transition-colors ${
                  tab === t
                    ? 'text-white border-b-2 border-blue-500 -mb-px'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto">
            {/* Open positions */}
            {tab === 'open' && (
              openWithLivePnl.length === 0 ? (
                <div className="py-6 text-center text-gray-700 text-xs">No open positions</div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-600 border-b border-gray-800">
                      {['Symbol', 'TF', 'Dir', 'Pattern', 'Entry', 'Stop', 'TP1', 'TP2', 'Edge', 'Live Px', 'Live P&L', 'P&L $'].map(h => (
                        <th key={h} className="text-left py-2 px-2">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {openWithLivePnl.map(t => (
                      <tr key={t.id} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                        <td className="py-2 px-2 font-bold text-white">{t.symbol.replace('USDT', '')}</td>
                        <td className="py-2 px-2 text-gray-500">{t.timeframe}</td>
                        <td className={`py-2 px-2 font-bold ${t.direction === 'long' ? 'text-green-400' : 'text-red-400'}`}>
                          {t.direction === 'long' ? 'L' : 'S'}
                        </td>
                        <td className="py-2 px-2 text-gray-300">{t.pattern}</td>
                        <td className="py-2 px-2">{fmtPrice(t.entry)}</td>
                        <td className="py-2 px-2 text-red-400">
                          {fmtPrice(t.stop_loss)}{t.tp1_hit ? ' ✓BE' : ''}
                        </td>
                        <td className="py-2 px-2 text-blue-400">{fmtPrice(t.tp1)}</td>
                        <td className="py-2 px-2 text-green-400">{fmtPrice(t.tp2)}</td>
                        <td className="py-2 px-2">
                          <span className={tierBadge(t.tier)}>{t.tier}</span>
                          <span className="ml-1 text-gray-500">{t.edge_score.toFixed(0)}</span>
                        </td>
                        <td className="py-2 px-2 text-yellow-300">
                          {fmtPrice(livePrices[t.symbol] ?? t.entry)}
                        </td>
                        <td className={`py-2 px-2 font-bold ${pnlClass(t.livePnl)}`}>
                          {sign(t.livePnl)}{fmt(Math.abs(t.livePnl))}%
                        </td>
                        <td className={`py-2 px-2 font-bold ${pnlClass(t.livePnlAbs)}`}>
                          {sign(t.livePnlAbs)}${fmt(Math.abs(t.livePnlAbs))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}

            {/* Recent signals */}
            {tab === 'signals' && (
              recentSignals.length === 0 ? (
                <div className="py-6 text-center text-gray-700 text-xs">
                  No signals yet — waiting for closed candles
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-600 border-b border-gray-800">
                      {['Time', 'Symbol', 'TF', 'Pattern', 'Dir', 'Edge', 'Regime', 'Traded', 'Reason'].map(h => (
                        <th key={h} className="text-left py-2 px-2">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {recentSignals.map(s => (
                      <tr key={s.id} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                        <td className="py-2 px-2 text-gray-600">
                          {new Date(s.detected_at).toLocaleTimeString()}
                        </td>
                        <td className="py-2 px-2 text-white">{s.symbol.replace('USDT', '')}</td>
                        <td className="py-2 px-2 text-gray-500">{s.timeframe}</td>
                        <td className="py-2 px-2 text-gray-300">{s.pattern}</td>
                        <td className={`py-2 px-2 font-bold ${s.direction === 'long' ? 'text-green-400' : 'text-red-400'}`}>
                          {s.direction === 'long' ? 'LONG' : 'SHORT'}
                        </td>
                        <td className="py-2 px-2">
                          <span className={tierBadge(s.tier)}>{s.tier}</span>
                          <span className="ml-1 text-gray-500">{s.edge_score.toFixed(0)}</span>
                        </td>
                        <td className="py-2 px-2 text-gray-600 text-[10px]">{s.regime}</td>
                        <td className="py-2 px-2">
                          {s.acted
                            ? <span className="text-green-400">✓ traded</span>
                            : <span className="text-gray-700">skipped</span>}
                        </td>
                        <td className="py-2 px-2 text-gray-600">{s.reason ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}

            {/* Closed trades */}
            {tab === 'closed' && (
              closedTrades.length === 0 ? (
                <div className="py-6 text-center text-gray-700 text-xs">No closed trades yet</div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-600 border-b border-gray-800">
                      {['Closed', 'Symbol', 'TF', 'Pattern', 'Dir', 'Entry', 'Exit', 'Via', 'P&L %', 'P&L $'].map(h => (
                        <th key={h} className="text-left py-2 px-2">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {closedTrades.map(t => (
                      <tr
                        key={t.id}
                        className={`border-b border-gray-800/30 ${
                          (t.pnl_pct ?? 0) > 0 ? 'bg-green-950/10' : 'bg-red-950/10'
                        }`}
                      >
                        <td className="py-2 px-2 text-gray-600">
                          {t.closed_at ? new Date(t.closed_at).toLocaleString() : '—'}
                        </td>
                        <td className="py-2 px-2 text-white">{t.symbol.replace('USDT', '')}</td>
                        <td className="py-2 px-2 text-gray-500">{t.timeframe}</td>
                        <td className="py-2 px-2 text-gray-300">{t.pattern}</td>
                        <td className={`py-2 px-2 font-bold ${t.direction === 'long' ? 'text-green-400' : 'text-red-400'}`}>
                          {t.direction === 'long' ? 'L' : 'S'}
                        </td>
                        <td className="py-2 px-2">{fmtPrice(t.entry)}</td>
                        <td className="py-2 px-2">{t.exit_price ? fmtPrice(t.exit_price) : '—'}</td>
                        <td className="py-2 px-2 text-gray-500">{t.exit_reason ?? '—'}</td>
                        <td className={`py-2 px-2 font-bold ${pnlClass(t.pnl_pct ?? 0)}`}>
                          {t.pnl_pct != null ? `${sign(t.pnl_pct)}${fmt(Math.abs(t.pnl_pct))}%` : '—'}
                        </td>
                        <td className={`py-2 px-2 font-bold ${pnlClass(t.pnl_abs ?? 0)}`}>
                          {t.pnl_abs != null ? `${sign(t.pnl_abs)}$${fmt(Math.abs(t.pnl_abs))}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-gray-900 rounded p-3">
      <div className="text-gray-600 text-[10px] uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-lg font-bold leading-tight ${color ?? 'text-white'}`}>{value}</div>
      {sub && <div className="text-gray-600 text-[10px] mt-0.5">{sub}</div>}
    </div>
  );
}
