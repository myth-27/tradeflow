export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server';
import { generateQuickSuggestion } from '@/lib/openai';

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { symbol, pattern, rsi, price, timeframe } = body;

  if (!symbol || !pattern || rsi === undefined || price === undefined || !timeframe) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  try {
    const result = await generateQuickSuggestion({
      symbol: symbol as string,
      pattern: pattern as { name: string; type: string },
      rsi: rsi as number,
      price: price as number,
      timeframe: timeframe as string,
    });
    return NextResponse.json(result);
  } catch (e) {
    console.error('Suggest error:', e);
    return NextResponse.json({ error: 'Suggestion failed' }, { status: 500 });
  }
}
