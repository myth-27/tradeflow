export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/server/db';

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-control-secret');
  if (!secret || secret !== process.env.CONTROL_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM rl_experience ORDER BY created_at ASC`,
    );

    const format = req.nextUrl.searchParams.get('format') ?? 'json';

    if (format === 'csv') {
      const cols = [
        'id', 'signal_id', 'trade_id', 'symbol', 'timeframe',
        'pattern', 'direction', 'regime', 'edge_score', 'confidence',
        'rsi', 'volume_ratio', 'risk_reward', 'entry', 'stop_loss', 'target',
        'hour_utc', 'day_of_week', 'acted',
        'reward', 'outcome', 'bars_held', 'exit_reason',
        'created_at', 'updated_at',
      ];
      const csv = [
        cols.join(','),
        ...rows.map(r => cols.map(c => r[c] ?? '').join(',')),
      ].join('\n');

      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="rl_experience_${Date.now()}.csv"`,
        },
      });
    }

    return NextResponse.json({
      count: rows.length,
      acted: rows.filter((r: { acted: boolean }) => r.acted).length,
      withOutcome: rows.filter((r: { outcome: string | null }) => r.outcome != null).length,
      data: rows,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
