// Signal features for the supervised / RL dataset.
//
// ONE implementation, used by both the live engine (at signal time, from its
// closed-candle buffers) and the offline backfill (from Bybit 1m candles
// aggregated to the same timeframes). Both must call these functions with bars
// that CLOSED BEFORE the signal — never the forming bar — so features carry no
// lookahead. Bump FEATURE_VERSION whenever a definition changes; rows record it.

export const FEATURE_VERSION = 1;

/**
 * Bars considered per timeframe. Must fit inside what the LIVE engine holds for
 * every timeframe — the 500-bar 1h buffer yields only ~125 complete 4h bars — so
 * live and offline compute over identical bars and produce identical features.
 */
export const FEATURE_WINDOW = 120;
const EMA_FAST = 20;
const EMA_SLOW = 50;
const ATR_PERIOD = 14;
const SLOPE_LOOKBACK = 5;
const MIN_BARS = EMA_SLOW + SLOPE_LOOKBACK + 5;

export interface Bar { time: number; open: number; high: number; low: number; close: number }

export interface TrendFeatures {
  /** EMA20 change over the last 5 bars, in ATRs of that timeframe. Positive = rising. */
  slope: number | null;
  /** Close minus EMA50, in ATRs. Positive = above the slow average. */
  pos: number | null;
}

export interface MtfTrend {
  trend_15m_slope: number | null; trend_15m_pos: number | null;
  trend_1h_slope: number | null;  trend_1h_pos: number | null;
  trend_4h_slope: number | null;  trend_4h_pos: number | null;
}

/** EMA seeded with the SMA of the first `period` values; entries before that are NaN. */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

/** Wilder ATR over the whole series. */
export function atr(bars: Bar[], period = ATR_PERIOD): number {
  if (bars.length < period + 1) return 0;
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const c = bars[i], p = bars[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}

/** Trend features from closed bars of one timeframe (oldest first). */
export function trendFeatures(allBars: Bar[]): TrendFeatures {
  const bars = allBars.slice(-FEATURE_WINDOW);
  if (bars.length < MIN_BARS) return { slope: null, pos: null };
  const closes = bars.map(b => b.close);
  const fast = ema(closes, EMA_FAST);
  const slow = ema(closes, EMA_SLOW);
  const a = atr(bars);
  const n = bars.length - 1;
  if (!(a > 0)) return { slope: null, pos: null };
  return {
    slope: (fast[n] - fast[n - SLOPE_LOOKBACK]) / a,
    pos: (closes[n] - slow[n]) / a,
  };
}

/**
 * Aggregate closed bars into larger UTC-aligned bars, keeping only COMPLETE groups
 * (e.g. four 1h bars for a 4h bar). `time` is in seconds, bar-open time.
 */
export function aggregate(bars: Bar[], fromSec: number, toSec: number): Bar[] {
  const per = toSec / fromSec;
  const groups = new Map<number, Bar[]>();
  for (const b of bars) {
    const g = Math.floor(b.time / toSec) * toSec;
    const arr = groups.get(g);
    if (arr) arr.push(b); else groups.set(g, [b]);
  }
  const out: Bar[] = [];
  const ordered: Array<[number, Bar[]]> = Array.from(groups.entries()).sort((x, y) => x[0] - y[0]);
  for (const [g, arr] of ordered) {
    if (arr.length !== per) continue;
    arr.sort((x, y) => x.time - y.time);
    out.push({
      time: g,
      open: arr[0].open,
      high: Math.max(...arr.map(x => x.high)),
      low: Math.min(...arr.map(x => x.low)),
      close: arr[arr.length - 1].close,
    });
  }
  return out;
}

/** Multi-timeframe trend from closed 15m and 1h bars; 4h is built from complete 1h groups. */
export function mtfTrend(bars15m: Bar[], bars1h: Bar[]): MtfTrend {
  const t15 = trendFeatures(bars15m);
  const t1h = trendFeatures(bars1h);
  const t4h = trendFeatures(aggregate(bars1h, 3600, 4 * 3600));
  return {
    trend_15m_slope: t15.slope, trend_15m_pos: t15.pos,
    trend_1h_slope: t1h.slope,  trend_1h_pos: t1h.pos,
    trend_4h_slope: t4h.slope,  trend_4h_pos: t4h.pos,
  };
}
