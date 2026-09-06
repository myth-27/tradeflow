export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getPool, getState, initDb } from '@/lib/server/db';
import { getLivePrices } from '@/lib/server/candle-store';

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'Engine not configured — DATABASE_URL missing' }, { status: 503 });
  }

  try {
    await initDb(); // creates tables if they don't exist yet (idempotent)
    const pool = getPool();
    const [state, openRes, closedRes, signalsRes] = await Promise.all([
      getState(),
      pool.query(`SELECT * FROM paper_trades WHERE status = 'open' ORDER BY opened_at DESC`),
      pool.query(
        `SELECT * FROM paper_trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 200`,
      ),
      pool.query(`SELECT * FROM signal_log ORDER BY detected_at DESC LIMIT 50`),
    ]);

    const wins = parseInt(state['wins'] ?? '0');
    const losses = parseInt(state['losses'] ?? '0');
    const completed = wins + losses;
    const capital = parseFloat(state['capital'] ?? '10000');

    // Cumulative P&L in dollars from closed trades
    const allClosed: Array<{ symbol: string; pnl_abs: number; pnl_pct: number; closed_at: number }> =
      closedRes.rows;
    const totalPnlAbs = allClosed.reduce((s, t) => s + (t.pnl_abs ?? 0), 0);

    // Per-symbol breakdown
    const symbolStats: Record<string, { wins: number; losses: number; totalPnl: number; trades: number }> = {};
    for (const t of allClosed) {
      if (!symbolStats[t.symbol]) symbolStats[t.symbol] = { wins: 0, losses: 0, totalPnl: 0, trades: 0 };
      symbolStats[t.symbol].trades++;
      symbolStats[t.symbol].totalPnl += t.pnl_abs ?? 0;
      if ((t.pnl_pct ?? 0) > 0) symbolStats[t.symbol].wins++;
      else if ((t.pnl_pct ?? 0) < 0) symbolStats[t.symbol].losses++;
    }

    // Equity curve points: [{ t: timestamp, v: cumulative_pnl_abs }]
    let running = 0;
    const equityCurve = allClosed
      .slice()
      .reverse()
      .map(t => {
        running += t.pnl_abs ?? 0;
        return { t: t.closed_at, v: parseFloat(running.toFixed(2)) };
      });

    // In-memory prices are populated by Railway engine.
    // On Vercel (dashboard-only), fall back to Bybit ticker API (confirmed accessible from Vercel/AWS).
    let livePrices = getLivePrices();
    if (Object.keys(livePrices).length === 0) {
      try {
        const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
        const headers = { 'User-Agent': 'TradeFlow/1.0 paper-trading-engine' };
        // Fetch all linear tickers in one request, then filter
        const bybitRes = await fetch(
          'https://api.bybit.com/v5/market/tickers?category=linear',
          { headers, next: { revalidate: 0 } },
        );
        if (bybitRes.ok) {
          const bybitData = await bybitRes.json() as { result: { list: Array<{ symbol: string; lastPrice: string }> } };
          const symbolSet = new Set(symbols);
          livePrices = Object.fromEntries(
            (bybitData.result?.list ?? [])
              .filter(t => symbolSet.has(t.symbol))
              .map(t => [t.symbol, parseFloat(t.lastPrice)]),
          );
        }
      } catch { /* non-critical */ }

      // Fallback: Binance US if Bybit also fails
      if (Object.keys(livePrices).length === 0) {
        try {
          const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
          const buRes = await fetch(
            `https://api.binance.us/api/v3/ticker/price?symbols=${JSON.stringify(symbols)}`,
            { next: { revalidate: 0 } },
          );
          if (buRes.ok) {
            const data: Array<{ symbol: string; price: string }> = await buRes.json();
            livePrices = Object.fromEntries(data.map(d => [d.symbol, parseFloat(d.price)]));
          }
        } catch { /* non-critical */ }
      }
    }

    return NextResponse.json({
      halted: state['halted'] === 'true',
      engineEnabled: process.env.ENABLE_ENGINE === 'true',
      capital,
      totalPnlAbs: parseFloat(totalPnlAbs.toFixed(2)),
      totalPnlPct: capital > 0 ? parseFloat(((totalPnlAbs / capital) * 100).toFixed(2)) : 0,
      dailyPnl: parseFloat(state['daily_pnl'] ?? '0'),
      totalTrades: parseInt(state['total_trades'] ?? '0'),
      wins,
      losses,
      winRate: completed > 0 ? Math.round((wins / completed) * 100) : 0,
      openTrades: openRes.rows,
      closedTrades: closedRes.rows,
      recentSignals: signalsRes.rows,
      symbolStats,
      equityCurve,
      livePrices,
    });
  } catch (err) {
    const e = err as Error & { code?: string };
    console.error('[live/state] error:', err);
    // DB unreachable (e.g. Vercel using wrong DATABASE_URL) — return empty state with live prices
    // so the dashboard loads rather than hanging on "Connecting…"
    let fallbackPrices: Record<string, number> = {};
    try {
      const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
      const r = await fetch('https://api.bybit.com/v5/market/tickers?category=linear', {
        headers: { 'User-Agent': 'TradeFlow/1.0' },
        next: { revalidate: 0 },
      });
      if (r.ok) {
        const d = await r.json() as { result: { list: Array<{ symbol: string; lastPrice: string }> } };
        const s = new Set(symbols);
        fallbackPrices = Object.fromEntries(
          (d.result?.list ?? []).filter(t => s.has(t.symbol)).map(t => [t.symbol, parseFloat(t.lastPrice)]),
        );
      }
    } catch { /* non-critical */ }
    return NextResponse.json({
      halted: false, engineEnabled: false, capital: 0,
      totalPnlAbs: 0, totalPnlPct: 0, dailyPnl: 0,
      totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      openTrades: [], closedTrades: [], recentSignals: [],
      symbolStats: {}, equityCurve: [],
      livePrices: fallbackPrices,
      dbError: true,
      dbErrorMsg: `${e.code ?? ''} ${e.message ?? ''}`.trim(),
      dbHost: (() => { try { return new URL(process.env.DATABASE_URL ?? '').hostname; } catch { return 'parse-fail'; } })(),
      dbPort: (() => { try { return new URL(process.env.DATABASE_URL ?? '').port; } catch { return 'parse-fail'; } })(),
    });
  }
}
