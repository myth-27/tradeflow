import { NextRequest, NextResponse } from 'next/server';
import { analyzePattern } from '@/lib/openai';

let lastCallTime = 0;

export async function POST(req: NextRequest) {
  const now = Date.now();
  if (now - lastCallTime < 10000) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { symbol, pattern, candles, indicators, timeframe, currentPrice } = body;

  if (!symbol || !pattern || !candles || !indicators || !timeframe || currentPrice === undefined) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  lastCallTime = now;

  try {
    const ind = indicators as {
      rsi: number;
      macd: { macd: number; signal: number; histogram: number };
      atr: number;
    };
    const result = await analyzePattern({
      symbol: symbol as string,
      pattern: pattern as Parameters<typeof analyzePattern>[0]['pattern'],
      candles: candles as Parameters<typeof analyzePattern>[0]['candles'],
      rsi: ind.rsi,
      macd: ind.macd,
      atr: ind.atr,
      support: (pattern as { support: number }).support,
      resistance: (pattern as { resistance: number }).resistance,
      target: (pattern as { target: number }).target,
      stopLoss: (pattern as { stopLoss: number }).stopLoss,
      riskReward: (pattern as { riskReward: number }).riskReward,
      timeframe: timeframe as string,
      currentPrice: currentPrice as number,
    });
    return NextResponse.json(result);
  } catch (e) {
    console.error('Analyze error:', e);
    return NextResponse.json({ error: 'Analysis failed' }, { status: 500 });
  }
}
