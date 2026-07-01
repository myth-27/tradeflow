export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getPool, getState } from '@/lib/server/db';
import { getLivePrices } from '@/lib/server/candle-store';

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'Engine not configured' }, { status: 503 });
  }

  try {
    const pool = getPool();
    const [state, openRes, closedRes, signalsRes] = await Promise.all([
      getState(),
      pool.query(
        `SELECT * FROM paper_trades WHERE status = 'open' ORDER BY opened_at DESC`,
      ),
      pool.query(
        `SELECT * FROM paper_trades WHERE status = 'closed'
         ORDER BY closed_at DESC LIMIT 20`,
      ),
      pool.query(
        `SELECT * FROM signal_log ORDER BY detected_at DESC LIMIT 30`,
      ),
    ]);

    const wins = parseInt(state['wins'] ?? '0');
    const losses = parseInt(state['losses'] ?? '0');
    const total = wins + losses;

    return NextResponse.json({
      halted: state['halted'] === 'true',
      capital: parseFloat(state['capital'] ?? '10000'),
      dailyPnl: parseFloat(state['daily_pnl'] ?? '0'),
      totalTrades: parseInt(state['total_trades'] ?? '0'),
      wins,
      losses,
      winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
      openTrades: openRes.rows,
      closedTrades: closedRes.rows,
      recentSignals: signalsRes.rows,
      livePrices: getLivePrices(),
    });
  } catch (err) {
    console.error('[live/state] error:', err);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
}
