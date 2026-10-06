import type { Candle } from '@/lib/binance-ws';

const MAX_CANDLES = 500;

// key: "BTCUSDT:15m"
const buffers = new Map<string, Candle[]>();
const livePrices = new Map<string, number>();

function key(symbol: string, tf: string): string {
  return `${symbol}:${tf}`;
}

/**
 * Store a closed bar, keeping each buffer sorted and unique by bar time.
 *
 * Every WebSocket reconnect (the 90s watchdog makes these routine) re-seeds up to
 * 500 historical bars into a buffer that already holds them. Appending blindly left
 * duplicate and out-of-order bars, which the pattern engine, ATR and dataset
 * features all read. Newer bars append; a known bar is replaced in place; an older
 * missing bar is inserted in order.
 */
export function pushCandle(
  symbol: string, tf: string, candle: Candle, closed = false,
  /** REST seed bars: stored, but never treated as the current price. */
  historical = false,
): void {
  const k = key(symbol, tf);
  if (!buffers.has(k)) buffers.set(k, []);
  const buf = buffers.get(k)!;

  if (closed) {
    const last = buf[buf.length - 1];
    if (!last || candle.time > last.time) {
      buf.push(candle);
    } else {
      let lo = 0, hi = buf.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (buf[m].time < candle.time) lo = m + 1; else hi = m; }
      if (buf[lo] && buf[lo].time === candle.time) buf[lo] = candle;
      else buf.splice(lo, 0, candle);
    }
    if (buf.length > MAX_CANDLES) buf.splice(0, buf.length - MAX_CANDLES);
  }

  // Re-seeding on reconnect pushes old closes; they must not hand the trade
  // monitor a stale price. Only live stream updates set the current price.
  if (!historical) livePrices.set(symbol, candle.close);
}

export function getCandles(symbol: string, tf: string): Candle[] {
  return buffers.get(key(symbol, tf)) ?? [];
}

export function calcATR(symbol: string, tf: string, period = 14): number {
  const candles = getCandles(symbol, tf);
  if (candles.length < period + 1) return 0;
  const trs = candles.slice(1).map((c, i) => Math.max(
    c.high - c.low,
    Math.abs(c.high - candles[i].close),
    Math.abs(c.low - candles[i].close),
  ));
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

export function getLivePrice(symbol: string): number | undefined {
  return livePrices.get(symbol);
}

export function getLivePrices(): Record<string, number> {
  return Object.fromEntries(livePrices);
}
