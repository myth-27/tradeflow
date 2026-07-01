export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getState, setState } from '@/lib/server/db';

// Server-side proxy so CONTROL_SECRET never leaks to the browser
export async function POST() {
  const secret = process.env.CONTROL_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CONTROL_SECRET not configured' }, { status: 503 });
  }

  try {
    const state = await getState();
    const current = state['halted'] === 'true';
    await setState('halted', String(!current));
    return NextResponse.json({ halted: !current });
  } catch (err) {
    console.error('[halt-proxy] error:', err);
    return NextResponse.json({ error: 'Failed to toggle halt' }, { status: 500 });
  }
}
