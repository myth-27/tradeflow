export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get('symbol') ?? 'BTCUSDT').toUpperCase();
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '80'), 300);
  const tf = searchParams.get('tf') ?? '15'; // Bybit interval: 15, 60, etc.

  const headers = { 'User-Agent': 'TradeFlow/1.0 paper-trading-engine' };

  // 1. Try Bybit v5 linear futures
  try {
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${tf}&limit=${limit}`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const json = await res.json() as { result: { list: string[][] } };
      const candles = [...(json.result?.list ?? [])].reverse().map(k => ({
        t: parseInt(k[0]), o: parseFloat(k[1]), h: parseFloat(k[2]),
        l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]),
      }));
      return NextResponse.json(candles);
    }
  } catch { /* fall through */ }

  // 2. Fallback: Binance US
  try {
    const binanceTf = tf === '15' ? '15m' : tf === '60' ? '1h' : tf === '240' ? '4h' : '15m';
    const url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${binanceTf}&limit=${limit}`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const raw = await res.json() as string[][];
      const candles = raw.map(k => ({
        t: parseInt(k[0]), o: parseFloat(k[1]), h: parseFloat(k[2]),
        l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]),
      }));
      return NextResponse.json(candles);
    }
  } catch { /* fall through */ }

  return NextResponse.json({ error: 'candle data unavailable' }, { status: 503 });
}
