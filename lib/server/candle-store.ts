import type { Candle } from '@/lib/binance-ws';

const MAX_CANDLES = 500;

// key: "BTCUSDT:15m"
const buffers = new Map<string, Candle[]>();
const livePrices = new Map<string, number>();

function key(symbol: string, tf: string): string {
  return `${symbol}:${tf}`;
}

export function pushCandle(symbol: string, tf: string, candle: Candle, closed = false): void {
  const k = key(symbol, tf);
  if (!buffers.has(k)) buffers.set(k, []);
  const buf = buffers.get(k)!;

  if (closed) {
    buf.push(candle);
    if (buf.length > MAX_CANDLES) buf.splice(0, buf.length - MAX_CANDLES);
  }

  // Always track live price
  livePrices.set(symbol, candle.close);
}

export function getCandles(symbol: string, tf: string): Candle[] {
  return buffers.get(key(symbol, tf)) ?? [];
}

export function getLivePrice(symbol: string): number | undefined {
  return livePrices.get(symbol);
}

export function getLivePrices(): Record<string, number> {
  return Object.fromEntries(livePrices);
}
