export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { initDb, getPool } from '@/lib/server/db';

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-control-secret');
  if (!secret || secret !== process.env.CONTROL_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await initDb();

    // Optional edge_stats table for future use
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS edge_stats (
        id          SERIAL PRIMARY KEY,
        pattern     TEXT NOT NULL,
        regime      TEXT NOT NULL,
        direction   TEXT NOT NULL,
        win_rate    DOUBLE PRECISION,
        avg_rr      DOUBLE PRECISION,
        sample_size INTEGER,
        updated_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
      );
    `);

    return NextResponse.json({ ok: true, message: 'Tables initialized' });
  } catch (err) {
    console.error('[setup] error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
