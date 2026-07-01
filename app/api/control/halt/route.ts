export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { getState, setState } from '@/lib/server/db';

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-control-secret');
  if (!secret || secret !== process.env.CONTROL_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const state = await getState();
    const current = state['halted'] === 'true';
    await setState('halted', String(!current));
    return NextResponse.json({ halted: !current });
  } catch (err) {
    console.error('[control/halt] error:', err);
    return NextResponse.json({ error: 'Failed to toggle halt' }, { status: 500 });
  }
}
