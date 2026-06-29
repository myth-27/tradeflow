/**
 * TradeFlow V3 — Multi-Timeframe Intelligence (Phase 10)
 *
 * 4H → Determine Bias (bullish/bearish/neutral)
 * 1H → Determine Confirmation
 * 5m → Determine Entry
 *
 * Counter-trend trades require Edge Score > 95.
 */

import { calcEMA, calcRSI, calcMACD, calcATR } from './pattern-engine';

// ─── Types ────────────────────────────────────────────────────────────────────

export type HTFBias = 'bullish' | 'bearish' | 'neutral';

export interface MultiTFAnalysis {
  bias4H: HTFBias;
  confirmation1H: boolean;
  biasStrength: number;          // 0-100
  alignedWithEntry: boolean;
  counterTrendRequired: number;  // edge score threshold required
  details: {
    ema20_4h: number;
    ema50_4h: number;
    rsi_4h: number;
    trend_4h: 'up' | 'down' | 'sideways';
    ema20_1h: number;
    ema50_1h: number;
    rsi_1h: number;
    macdHist_1h: number;
  };
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CachedBias {
  symbol: string;
  bias4H: HTFBias;
  confirmation1H: boolean;
  details: MultiTFAnalysis['details'];
  biasStrength: number;
  cachedAt: number;
}

const biasCache = new Map<string, CachedBias>();
const CACHE_DURATION_4H = 4 * 60 * 60 * 1000;  // 4 hours
const CACHE_DURATION_1H = 60 * 60 * 1000;       // 1 hour

// ─── HTF Data Fetching ────────────────────────────────────────────────────────

/** Fetch higher-timeframe candles from Binance REST API */
async function fetchHTFCandles(
  symbol: string,
  interval: string,
  limit = 100,
): Promise<{ time: number; open: number; high: number; low: number; close: number; volume: number }[]> {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data as [number, string, string, string, string, string][]).map(k => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  } catch {
    return [];
  }
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

/** Determine 4H bias */
function analyze4HBias(candles: { close: number; high: number; low: number }[]): {
  bias: HTFBias;
  strength: number;
  ema20: number;
  ema50: number;
  rsi: number;
  trend: 'up' | 'down' | 'sideways';
} {
  if (candles.length < 50) return {
    bias: 'neutral', strength: 50, ema20: 0, ema50: 0, rsi: 50, trend: 'sideways',
  };

  const closes = candles.map(c => c.close);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const rsi = calcRSI(closes);
  const atr = calcATR(candles as { time: number; open: number; high: number; low: number; close: number; volume: number }[]);

  const lastEma20 = ema20[ema20.length - 1] ?? 0;
  const lastEma50 = ema50[ema50.length - 1] ?? 0;
  const currentPrice = closes[closes.length - 1];

  // Trend direction
  const emaSpread = lastEma20 > 0 ? ((lastEma20 - lastEma50) / lastEma50) * 100 : 0;
  const trend: 'up' | 'down' | 'sideways' =
    emaSpread > 0.3 ? 'up' : emaSpread < -0.3 ? 'down' : 'sideways';

  // Price position relative to EMAs
  const priceAboveEma20 = currentPrice > lastEma20;
  const priceAboveEma50 = currentPrice > lastEma50;
  const ema20AboveEma50 = lastEma20 > lastEma50;

  // Bias determination
  let bias: HTFBias = 'neutral';
  let strength = 50;

  if (priceAboveEma20 && priceAboveEma50 && ema20AboveEma50 && rsi > 50) {
    bias = 'bullish';
    strength = 60 + Math.min(40, emaSpread * 20 + (rsi - 50) * 0.5);
  } else if (!priceAboveEma20 && !priceAboveEma50 && !ema20AboveEma50 && rsi < 50) {
    bias = 'bearish';
    strength = 60 + Math.min(40, Math.abs(emaSpread) * 20 + (50 - rsi) * 0.5);
  } else if (ema20AboveEma50 && rsi > 45) {
    bias = 'bullish';
    strength = 55;
  } else if (!ema20AboveEma50 && rsi < 55) {
    bias = 'bearish';
    strength = 55;
  }

  return { bias, strength, ema20: lastEma20, ema50: lastEma50, rsi, trend };
}

/** Check 1H confirmation */
function analyze1HConfirmation(
  candles: { close: number; high: number; low: number; open: number; volume: number; time: number }[],
  bias4H: HTFBias,
): {
  confirmed: boolean;
  ema20: number;
  ema50: number;
  rsi: number;
  macdHist: number;
} {
  if (candles.length < 50) return {
    confirmed: false, ema20: 0, ema50: 0, rsi: 50, macdHist: 0,
  };

  const closes = candles.map(c => c.close);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const rsi = calcRSI(closes);
  const macd = calcMACD(closes);

  const lastEma20 = ema20[ema20.length - 1] ?? 0;
  const lastEma50 = ema50[ema50.length - 1] ?? 0;
  const currentPrice = closes[closes.length - 1];

  let confirmed = false;

  if (bias4H === 'bullish') {
    confirmed = currentPrice > lastEma20 && macd.histogram > 0 && rsi > 45;
  } else if (bias4H === 'bearish') {
    confirmed = currentPrice < lastEma20 && macd.histogram < 0 && rsi < 55;
  } else {
    confirmed = true; // neutral bias = no confirmation needed
  }

  return { confirmed, ema20: lastEma20, ema50: lastEma50, rsi, macdHist: macd.histogram };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get multi-timeframe analysis for a symbol.
 * Caches results to avoid excessive API calls.
 */
export async function getMultiTFAnalysis(
  symbol: string,
  entryDirection: 'long' | 'short',
): Promise<MultiTFAnalysis> {
  const cached = biasCache.get(symbol);
  const now = Date.now();

  // Use cache if fresh enough
  if (cached && now - cached.cachedAt < CACHE_DURATION_1H) {
    const aligned =
      (entryDirection === 'long' && cached.bias4H === 'bullish') ||
      (entryDirection === 'short' && cached.bias4H === 'bearish') ||
      cached.bias4H === 'neutral';

    return {
      bias4H: cached.bias4H,
      confirmation1H: cached.confirmation1H,
      biasStrength: cached.biasStrength,
      alignedWithEntry: aligned,
      counterTrendRequired: aligned ? 0 : 95,
      details: cached.details,
    };
  }

  // Fetch fresh data
  const [candles4H, candles1H] = await Promise.all([
    fetchHTFCandles(symbol, '4h', 100),
    fetchHTFCandles(symbol, '1h', 100),
  ]);

  const analysis4H = analyze4HBias(candles4H);
  const analysis1H = analyze1HConfirmation(candles1H, analysis4H.bias);

  const details: MultiTFAnalysis['details'] = {
    ema20_4h: analysis4H.ema20,
    ema50_4h: analysis4H.ema50,
    rsi_4h: analysis4H.rsi,
    trend_4h: analysis4H.trend,
    ema20_1h: analysis1H.ema20,
    ema50_1h: analysis1H.ema50,
    rsi_1h: analysis1H.rsi,
    macdHist_1h: analysis1H.macdHist,
  };

  // Cache
  biasCache.set(symbol, {
    symbol,
    bias4H: analysis4H.bias,
    confirmation1H: analysis1H.confirmed,
    details,
    biasStrength: analysis4H.strength,
    cachedAt: now,
  });

  const aligned =
    (entryDirection === 'long' && analysis4H.bias === 'bullish') ||
    (entryDirection === 'short' && analysis4H.bias === 'bearish') ||
    analysis4H.bias === 'neutral';

  return {
    bias4H: analysis4H.bias,
    confirmation1H: analysis1H.confirmed,
    biasStrength: analysis4H.strength,
    alignedWithEntry: aligned,
    counterTrendRequired: aligned ? 0 : 95,
    details,
  };
}

/** Force clear the HTF cache (e.g., on symbol change) */
export function clearHTFCache(symbol?: string): void {
  if (symbol) biasCache.delete(symbol);
  else biasCache.clear();
}
