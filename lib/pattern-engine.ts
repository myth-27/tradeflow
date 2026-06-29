import type { Candle } from './binance-ws';

export type PatternResult = {
  name: string;
  type: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  target: number;
  support: number;
  resistance: number;
  stopLoss: number;
  riskReward: number;
  description: string;
  conflicting?: boolean;
};

type MultiBarResult = {
  found: boolean;
  resistance: number;
  support: number;
  target: number;
  confidence: number;
};

type TrendlinePoint = { time: number; value: number };

// ─── Indicators ────────────────────────────────────────────────────────────

export function calcEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

export function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;

  const changes = closes.slice(1).map((c, i) => c - closes[i]);

  // Initial averages (simple average for first period) — Wilder's method
  let avgGain = changes.slice(0, period)
    .filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
  let avgLoss = Math.abs(changes.slice(0, period)
    .filter(c => c < 0).reduce((a, b) => a + b, 0)) / period;

  // Wilder's smoothing for subsequent periods
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

export function calcMACD(closes: number[]): {
  macd: number;
  signal: number;
  histogram: number;
} {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (!ema12.length || !ema26.length) return { macd: 0, signal: 0, histogram: 0 };
  const len = Math.min(ema12.length, ema26.length);
  const macdLine: number[] = [];
  for (let i = 0; i < len; i++) {
    const idx12 = ema12.length - len + i;
    const idx26 = ema26.length - len + i;
    macdLine.push(ema12[idx12] - ema26[idx26]);
  }
  const signalLine = calcEMA(macdLine, 9);
  const lastMACD = macdLine[macdLine.length - 1];
  const lastSignal = signalLine.length ? signalLine[signalLine.length - 1] : 0;
  return {
    macd: lastMACD,
    signal: lastSignal,
    histogram: lastMACD - lastSignal,
  };
}

export function calcBollingerBands(
  closes: number[],
  period = 20,
  stdDev = 2
): { upper: number; middle: number; lower: number; bandwidth: number; percentB: number } {
  if (closes.length < period) {
    const last = closes[closes.length - 1] || 0;
    return { upper: last, middle: last, lower: last, bandwidth: 0, percentB: 0.5 };
  }
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - middle, 2), 0) / period;
  const std = Math.sqrt(variance);
  const upper = parseFloat((middle + stdDev * std).toFixed(2));
  const lower = parseFloat((middle - stdDev * std).toFixed(2));
  const bandWidth = stdDev * 2 * std;
  return {
    upper,
    middle: parseFloat(middle.toFixed(2)),
    lower,
    bandwidth: parseFloat((bandWidth / middle * 100).toFixed(2)),
    // %B: where is current price within the bands? 0 = lower, 0.5 = middle, 1 = upper
    percentB: bandWidth > 0 ? parseFloat(((closes[closes.length - 1] - lower) / bandWidth).toFixed(2)) : 0.5,
  };
}

export function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;

  const trueRanges = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(
      c.high - c.low,                    // current range
      Math.abs(c.high - prev.close),     // gap up
      Math.abs(c.low - prev.close)       // gap down
    );
  });

  // Wilder's smoothing
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return parseFloat(atr.toFixed(2));
}

export function calcVolumeProfile(candles: Candle[]): {
  avgVolume: number;
  currentVolume: number;
  volumeRatio: number;
  label: string;
  isHighVolume: boolean;
} {
  if (candles.length < 20) return {
    avgVolume: 0, currentVolume: 0,
    volumeRatio: 1, label: '1.0x', isHighVolume: false,
  };

  // Average of last 20 CLOSED candles (not including current forming)
  const closedCandles = candles.slice(-21, -1);
  const avgVolume = closedCandles.reduce((a, c) => a + c.volume, 0) / closedCandles.length;
  const currentVolume = candles[candles.length - 1].volume;

  const ratio = avgVolume > 0 ? currentVolume / avgVolume : 1;

  return {
    avgVolume: parseFloat(avgVolume.toFixed(2)),
    currentVolume: parseFloat(currentVolume.toFixed(2)),
    volumeRatio: parseFloat(ratio.toFixed(2)),
    label: ratio >= 2 ? `🔥 ${ratio.toFixed(1)}x` : `${ratio.toFixed(1)}x`,
    isHighVolume: ratio > 1.5,
  };
}

// ─── Price Level Detection ─────────────────────────────────────────────────

export function findSupportLevels(candles: Candle[], currentPrice: number, count = 3): number[] {
  const lows = candles.map((c) => c.low);
  const swingLows: number[] = [];

  // Step 1: Find swing lows (local minima)
  for (let i = 2; i < lows.length - 2; i++) {
    if (
      lows[i] < lows[i - 1] &&
      lows[i] < lows[i - 2] &&
      lows[i] < lows[i + 1] &&
      lows[i] < lows[i + 2]
    ) {
      swingLows.push(lows[i]);
    }
  }

  // Step 2: Cluster nearby levels (within 0.5% of each other = same zone)
  const clusters: number[][] = [];
  swingLows.forEach(level => {
    const existing = clusters.find(c =>
      Math.abs(c[0] - level) / c[0] < 0.005
    );
    if (existing) existing.push(level);
    else clusters.push([level]);
  });

  // Step 3: Score by cluster size (more touches = stronger level)
  const scored = clusters
    .map(c => ({ price: c.reduce((a, b) => a + b) / c.length, touches: c.length }))
    .sort((a, b) => b.touches - a.touches);

  // Step 4: CRITICAL — only return levels BELOW current price
  return scored
    .filter(s => s.price < currentPrice * 0.999) // must be at least 0.1% below
    .slice(0, count)
    .map(s => s.price);
}

export function findResistanceLevels(candles: Candle[], currentPrice: number, count = 3): number[] {
  const highs = candles.map((c) => c.high);
  const swingHighs: number[] = [];

  for (let i = 2; i < highs.length - 2; i++) {
    if (
      highs[i] > highs[i - 1] &&
      highs[i] > highs[i - 2] &&
      highs[i] > highs[i + 1] &&
      highs[i] > highs[i + 2]
    ) {
      swingHighs.push(highs[i]);
    }
  }

  const clusters: number[][] = [];
  swingHighs.forEach(level => {
    const existing = clusters.find(c =>
      Math.abs(c[0] - level) / c[0] < 0.005
    );
    if (existing) existing.push(level);
    else clusters.push([level]);
  });

  const scored = clusters
    .map(c => ({ price: c.reduce((a, b) => a + b) / c.length, touches: c.length }))
    .sort((a, b) => b.touches - a.touches);

  // CRITICAL — only return levels ABOVE current price
  return scored
    .filter(s => s.price > currentPrice * 1.001) // must be at least 0.1% above
    .slice(0, count)
    .map(s => s.price);
}

// C2: S/R validation — always run before rendering
export function validateSRLevels(
  support: number[],
  resistance: number[],
  currentPrice: number
): { support: number[]; resistance: number[] } {
  return {
    support: support.filter(s => s < currentPrice),
    resistance: resistance.filter(r => r > currentPrice),
  };
}

export function findTrendlinePoints(candles: Candle[]): {
  supportTrendline: [TrendlinePoint, TrendlinePoint];
  resistanceTrendline: [TrendlinePoint, TrendlinePoint];
} {
  const n = candles.length;
  const supportPts: TrendlinePoint[] = [];
  const resistPts: TrendlinePoint[] = [];
  for (let i = 2; i < n - 2; i++) {
    if (
      candles[i].low < candles[i - 1].low &&
      candles[i].low < candles[i + 1].low
    ) {
      supportPts.push({ time: candles[i].time, value: candles[i].low });
    }
    if (
      candles[i].high > candles[i - 1].high &&
      candles[i].high > candles[i + 1].high
    ) {
      resistPts.push({ time: candles[i].time, value: candles[i].high });
    }
  }
  const fallback = (arr: Candle[], key: 'low' | 'high'): [TrendlinePoint, TrendlinePoint] => {
    const first = arr[Math.floor(arr.length * 0.1)];
    const last = arr[arr.length - 1];
    return [
      { time: first.time, value: first[key] },
      { time: last.time, value: last[key] },
    ];
  };
  return {
    supportTrendline:
      supportPts.length >= 2
        ? [supportPts[0], supportPts[supportPts.length - 1]]
        : fallback(candles, 'low'),
    resistanceTrendline:
      resistPts.length >= 2
        ? [resistPts[0], resistPts[resistPts.length - 1]]
        : fallback(candles, 'high'),
  };
}

// ─── Multi-Bar Patterns ────────────────────────────────────────────────────

export function detectDoubleTop(candles: Candle[], currentPrice: number): MultiBarResult {
  const empty: MultiBarResult = { found: false, resistance: 0, support: 0, target: 0, confidence: 0 };
  if (candles.length < 30) return empty;
  const lookback = candles.slice(-50);
  const highs = lookback.map((c) => c.high);

  // Find two peaks — must be separated by at least 5 candles
  let peak1Idx = -1;
  let peak2Idx = -1;
  let peak1Price = 0;

  for (let i = 5; i < highs.length - 5; i++) {
    const isLocalHigh = highs[i] > highs[i - 1] && highs[i] > highs[i - 2] &&
                        highs[i] > highs[i + 1] && highs[i] > highs[i + 2];
    if (isLocalHigh) {
      if (peak1Idx === -1) {
        peak1Idx = i;
        peak1Price = highs[i];
      } else if (i - peak1Idx >= 5) {
        // Second peak must be within 1.5% of first peak
        if (Math.abs(highs[i] - peak1Price) / peak1Price < 0.015) {
          peak2Idx = i;
          break;
        }
      }
    }
  }

  if (peak1Idx === -1 || peak2Idx === -1) return empty;
  const p1 = highs[peak1Idx];
  const p2 = highs[peak2Idx];

  // Neckline = lowest point between the two peaks
  const between = lookback.slice(peak1Idx, peak2Idx);
  const neckline = Math.min(...between.map(c => c.low));

  // Pattern only CONFIRMED when price breaks below neckline
  const patternHeight = ((p1 + p2) / 2) - neckline;
  const target = neckline - patternHeight; // measured move

  const resistance = Math.max(p1, p2);
  const isConfirmed = currentPrice <= neckline * 1.005;

  // Confidence: peak similarity + confirmation bonus
  const peakSimilarity = 1 - (Math.abs(p1 - p2) / p1);
  const baseConfidence = peakSimilarity * 70;
  const confirmBonus = isConfirmed ? 20 : 0;

  return {
    found: true,
    resistance,
    support: neckline,
    target,
    confidence: Math.min(Math.round(baseConfidence + confirmBonus), 95),
  };
}

export function detectDoubleBottom(candles: Candle[], currentPrice: number): MultiBarResult {
  const empty: MultiBarResult = { found: false, resistance: 0, support: 0, target: 0, confidence: 0 };
  if (candles.length < 30) return empty;
  const lookback = candles.slice(-50);
  const lows = lookback.map((c) => c.low);

  let trough1Idx = -1;
  let trough2Idx = -1;
  let trough1Price = 0;

  for (let i = 5; i < lows.length - 5; i++) {
    const isLocalLow = lows[i] < lows[i - 1] && lows[i] < lows[i - 2] &&
                       lows[i] < lows[i + 1] && lows[i] < lows[i + 2];
    if (isLocalLow) {
      if (trough1Idx === -1) {
        trough1Idx = i;
        trough1Price = lows[i];
      } else if (i - trough1Idx >= 5) {
        if (Math.abs(lows[i] - trough1Price) / trough1Price < 0.015) {
          trough2Idx = i;
          break;
        }
      }
    }
  }

  if (trough1Idx === -1 || trough2Idx === -1) return empty;
  const t1 = lows[trough1Idx];
  const t2 = lows[trough2Idx];

  // Neckline = highest point between the two troughs
  const between = lookback.slice(trough1Idx, trough2Idx);
  const neckline = Math.max(...between.map(c => c.high));

  const patternHeight = neckline - ((t1 + t2) / 2);
  const target = neckline + patternHeight;

  const support = Math.min(t1, t2);
  const isConfirmed = currentPrice >= neckline * 0.995;

  const troughSimilarity = 1 - (Math.abs(t1 - t2) / t1);
  const baseConfidence = troughSimilarity * 70;
  const confirmBonus = isConfirmed ? 20 : 0;

  return {
    found: true,
    resistance: neckline,
    support,
    target,
    confidence: Math.min(Math.round(baseConfidence + confirmBonus), 95),
  };
}

export function detectHeadAndShoulders(candles: Candle[], currentPrice: number): MultiBarResult & { neckline?: number } {
  const empty = { found: false, resistance: 0, support: 0, target: 0, confidence: 0 };
  if (candles.length < 30) return empty;
  const lookback = candles.slice(-80);
  const highs = lookback.map((c) => c.high);

  // Find peaks with 3-candle window each side
  const peaks: { index: number; price: number }[] = [];
  for (let i = 3; i < highs.length - 3; i++) {
    const h = highs[i];
    if (h > highs[i - 1] && h > highs[i - 2] && h > highs[i - 3] &&
        h > highs[i + 1] && h > highs[i + 2] && h > highs[i + 3]) {
      peaks.push({ index: i, price: h });
    }
  }
  if (peaks.length < 3) return empty;

  for (let i = 0; i < peaks.length - 2; i++) {
    const left = peaks[i];
    const head = peaks[i + 1];
    const right = peaks[i + 2];

    // Head must be higher than both shoulders
    if (head.price <= left.price || head.price <= right.price) continue;

    // Shoulders must be roughly equal (within 3%)
    if (Math.abs(left.price - right.price) / left.price > 0.03) continue;

    // Minimum separation between peaks: 5 candles
    if (head.index - left.index < 5 || right.index - head.index < 5) continue;

    // Neckline: connect the troughs between L-H and H-R
    const leftTrough = Math.min(...lookback.slice(left.index, head.index).map(c => c.low));
    const rightTrough = Math.min(...lookback.slice(head.index, right.index).map(c => c.low));
    const neckline = (leftTrough + rightTrough) / 2;

    const height = head.price - neckline;
    const target = neckline - height;

    const shoulderResistance = Math.max(left.price, right.price);
    // Neckline must be near or below current price
    if (neckline >= currentPrice * 1.005) continue;

    const shoulderDiff = Math.abs(left.price - right.price) / left.price;
    const confidence = Math.min(88, 65 + (0.03 - shoulderDiff) * 800);

    return {
      found: true,
      resistance: shoulderResistance,
      support: neckline,
      target,
      confidence: Math.round(confidence),
      neckline,
    };
  }
  return empty;
}

export function detectAscendingTriangle(candles: Candle[], currentPrice: number): MultiBarResult {
  const empty: MultiBarResult = { found: false, resistance: 0, support: 0, target: 0, confidence: 0 };
  if (candles.length < 30) return empty;
  const lookback = candles.slice(-60);

  // Resistance: flat top — find a price level touched 3+ times
  const highs = lookback.map((c) => c.high);
  const maxHigh = Math.max(...highs);
  const resistanceTouches = highs.filter(h => h > maxHigh * 0.995).length;

  // Support: rising lows — fit a linear regression to swing lows
  const swingLows: { index: number; price: number }[] = [];
  for (let i = 2; i < lookback.length - 2; i++) {
    if (lookback[i].low < lookback[i - 1].low && lookback[i].low < lookback[i + 1].low) {
      swingLows.push({ index: i, price: lookback[i].low });
    }
  }

  if (swingLows.length < 3) return empty;

  // Linear regression on swing lows to check if rising
  const n = swingLows.length;
  const sumX = swingLows.reduce((a, p) => a + p.index, 0);
  const sumY = swingLows.reduce((a, p) => a + p.price, 0);
  const sumXY = swingLows.reduce((a, p) => a + p.index * p.price, 0);
  const sumX2 = swingLows.reduce((a, p) => a + p.index * p.index, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  // Must have positive slope (rising lows) to be ascending triangle
  if (slope <= 0) return empty;

  const nearestSupport = swingLows[swingLows.length - 1].price;

  // VALIDATE: support must be below current price
  if (nearestSupport >= currentPrice) return empty;
  // VALIDATE: resistance must be above current price
  if (maxHigh <= currentPrice) return empty;

  const patternHeight = maxHigh - nearestSupport;
  const target = maxHigh + patternHeight; // breakout target

  return {
    found: true,
    resistance: maxHigh,
    support: nearestSupport,
    target,
    confidence: Math.min(60 + resistanceTouches * 5, 88),
  };
}

export function detectDescendingTriangle(candles: Candle[]): MultiBarResult {
  const empty: MultiBarResult = { found: false, resistance: 0, support: 0, target: 0, confidence: 0 };
  if (candles.length < 30) return empty;
  const recent = candles.slice(-50);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const minLow = Math.min(...lows);
  const lowVariance = lows.reduce((s, l) => s + Math.abs(l - minLow), 0) / lows.length;
  if (lowVariance / minLow > 0.005) return empty;
  let falling = true;
  for (let i = 1; i < highs.length; i++) {
    if (highs[i] > highs[i - 1] + minLow * 0.003) { falling = false; break; }
  }
  if (!falling) return empty;
  const support = minLow;
  const resistance = highs[0];
  const target = support - (resistance - support);
  return { found: true, resistance, support, target, confidence: 70 };
}

export function detectSymmetricalTriangle(candles: Candle[]): MultiBarResult {
  const empty: MultiBarResult = { found: false, resistance: 0, support: 0, target: 0, confidence: 0 };
  if (candles.length < 30) return empty;
  const recent = candles.slice(-50);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  let highsFalling = true;
  let lowsRising = true;
  for (let i = 1; i < highs.length; i++) {
    if (highs[i] > highs[i - 1] + highs[0] * 0.002) { highsFalling = false; break; }
  }
  for (let i = 1; i < lows.length; i++) {
    if (lows[i] < lows[i - 1] - lows[0] * 0.002) { lowsRising = false; break; }
  }
  if (!highsFalling || !lowsRising) return empty;
  const resistance = highs[0];
  const support = lows[0];
  const midpoint = (resistance + support) / 2;
  const target = midpoint + (resistance - support) * 0.8;
  return { found: true, resistance, support, target, confidence: 65 };
}

export function detectBullFlag(candles: Candle[]): MultiBarResult {
  const empty: MultiBarResult = { found: false, resistance: 0, support: 0, target: 0, confidence: 0 };
  if (candles.length < 30) return empty;
  const pole = candles.slice(-15, -8);
  const flag = candles.slice(-8);
  const poleMove = (pole[pole.length - 1].close - pole[0].open) / pole[0].open;
  if (poleMove < 0.03) return empty;
  const flagMoves = flag.map((c) => (c.close - c.open) / c.open);
  const avgFlagMove = flagMoves.reduce((a, b) => a + b, 0) / flagMoves.length;
  if (avgFlagMove > 0.005 || avgFlagMove < -0.02) return empty;
  const resistance = Math.max(...flag.map((c) => c.high));
  const support = Math.min(...flag.map((c) => c.low));
  const poleHeight = pole[pole.length - 1].close - pole[0].open;
  const target = flag[flag.length - 1].close + poleHeight;
  return { found: true, resistance, support, target, confidence: 75 };
}

export function detectBearFlag(candles: Candle[]): MultiBarResult {
  const empty: MultiBarResult = { found: false, resistance: 0, support: 0, target: 0, confidence: 0 };
  if (candles.length < 30) return empty;
  const pole = candles.slice(-15, -8);
  const flag = candles.slice(-8);
  const poleMove = (pole[0].open - pole[pole.length - 1].close) / pole[0].open;
  if (poleMove < 0.03) return empty;
  const flagMoves = flag.map((c) => (c.close - c.open) / c.open);
  const avgFlagMove = flagMoves.reduce((a, b) => a + b, 0) / flagMoves.length;
  if (avgFlagMove < -0.005 || avgFlagMove > 0.02) return empty;
  const resistance = Math.max(...flag.map((c) => c.high));
  const support = Math.min(...flag.map((c) => c.low));
  const poleHeight = pole[0].open - pole[pole.length - 1].close;
  const target = flag[flag.length - 1].close - poleHeight;
  return { found: true, resistance, support, target, confidence: 73 };
}

// ─── Candlestick Patterns ──────────────────────────────────────────────────

export function detectDoji(candle: Candle): boolean {
  const range = candle.high - candle.low;
  if (range === 0) return false;
  const body = Math.abs(candle.close - candle.open);
  return body / range < 0.1;
}

export function detectHammer(candle: Candle): boolean {
  const range = candle.high - candle.low;
  if (range === 0) return false;
  const body = Math.abs(candle.close - candle.open);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  return lowerWick > 2 * body && upperWick < body * 0.5 && body > 0;
}

export function detectShootingStar(candle: Candle): boolean {
  const range = candle.high - candle.low;
  if (range === 0) return false;
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  return upperWick > 2 * body && lowerWick < body * 0.5 && body > 0;
}

export function detectEngulfing(prev: Candle, curr: Candle): 'bullish' | 'bearish' | null {
  const prevBullish = prev.close > prev.open;
  const currBullish = curr.close > curr.open;
  if (!prevBullish && currBullish) {
    if (curr.open <= prev.close && curr.close >= prev.open) return 'bullish';
  }
  if (prevBullish && !currBullish) {
    if (curr.open >= prev.close && curr.close <= prev.open) return 'bearish';
  }
  return null;
}

export function detectMorningStar(c1: Candle, c2: Candle, c3: Candle): boolean {
  const c1Bearish = c1.close < c1.open;
  const c3Bullish = c3.close > c3.open;
  const c2SmallBody = Math.abs(c2.close - c2.open) < (c1.high - c1.low) * 0.3;
  return c1Bearish && c2SmallBody && c3Bullish && c3.close > (c1.open + c1.close) / 2;
}

// ─── Pattern Validation ────────────────────────────────────────────────────

// C7: Always validate every pattern before showing or acting on it
export function validatePattern(pattern: PatternResult, currentPrice: number): PatternResult | null {
  if (!pattern) return null;

  // Rule 1: Support must be below current price
  if (pattern.support >= currentPrice) {
    pattern.support = currentPrice * 0.98; // fallback: 2% below
  }

  // Rule 2: Resistance must be above current price
  if (pattern.resistance <= currentPrice) {
    pattern.resistance = currentPrice * 1.02; // fallback: 2% above
  }

  // Rule 3: Target must make directional sense
  if (pattern.type === 'bullish' && pattern.target <= currentPrice) return null;
  if (pattern.type === 'bearish' && pattern.target >= currentPrice) return null;

  // Rule 4: Stop loss must be on the LOSING side
  if (pattern.type === 'bullish' && pattern.stopLoss >= currentPrice) return null;
  if (pattern.type === 'bearish' && pattern.stopLoss <= currentPrice) return null;

  // Rule 5: R:R must be at least 1.5 to be worth showing
  const risk = Math.abs(currentPrice - pattern.stopLoss);
  const reward = Math.abs(pattern.target - currentPrice);
  pattern.riskReward = risk > 0 ? parseFloat((reward / risk).toFixed(1)) : 0;
  if (pattern.riskReward < 1.5) return null;

  // Rule 6: Confidence minimum
  if (pattern.confidence < 55) return null;

  return pattern;
}

// ─── Pattern Runner ────────────────────────────────────────────────────────

export function runAllPatterns(candles: Candle[]): PatternResult[] {
  if (candles.length < 30) return [];
  const results: PatternResult[] = [];
  const closes = candles.map((c) => c.close);
  const currentPrice = closes[closes.length - 1];
  const atr = calcATR(candles);

  const addMultiBar = (
    name: string,
    type: 'bullish' | 'bearish' | 'neutral',
    r: MultiBarResult,
    description: string
  ) => {
    if (!r.found) return;
    const stopLoss =
      type === 'bullish' ? r.support - atr : r.resistance + atr;
    const risk = Math.abs(currentPrice - stopLoss);
    const reward = Math.abs(r.target - currentPrice);
    const rr = risk > 0 ? reward / risk : 0;
    results.push({
      name,
      type,
      confidence: Math.round(r.confidence),
      target: r.target,
      support: r.support,
      resistance: r.resistance,
      stopLoss,
      riskReward: Math.round(rr * 10) / 10,
      description,
    });
  };

  addMultiBar(
    'Double Top', 'bearish',
    detectDoubleTop(candles, currentPrice),
    'Two peaks at similar price indicating potential reversal'
  );
  addMultiBar(
    'Double Bottom', 'bullish',
    detectDoubleBottom(candles, currentPrice),
    'Two troughs at similar price signaling potential upside reversal'
  );
  const has = detectHeadAndShoulders(candles, currentPrice);
  addMultiBar('Head & Shoulders', 'bearish', has, 'Classic reversal pattern with neckline breakdown');
  addMultiBar('Ascending Triangle', 'bullish', detectAscendingTriangle(candles, currentPrice), 'Flat resistance with rising lows — bullish breakout expected');
  addMultiBar('Descending Triangle', 'bearish', detectDescendingTriangle(candles), 'Flat support with falling highs — bearish breakdown expected');
  addMultiBar('Symmetrical Triangle', 'neutral', detectSymmetricalTriangle(candles), 'Converging trendlines — breakout direction pending');
  addMultiBar('Bull Flag', 'bullish', detectBullFlag(candles), 'Sharp move up followed by tight consolidation');
  addMultiBar('Bear Flag', 'bearish', detectBearFlag(candles), 'Sharp move down followed by tight consolidation');

  // Candlestick patterns
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];
  const supportLevels = findSupportLevels(candles, currentPrice);
  const resistanceLevels = findResistanceLevels(candles, currentPrice);
  const support = supportLevels[0] || currentPrice * 0.98;
  const resistance = resistanceLevels[0] || currentPrice * 1.02;

  if (detectDoji(last)) {
    results.push({
      name: 'Doji',
      type: 'neutral',
      confidence: 65,
      target: currentPrice * 1.01,
      support,
      resistance,
      stopLoss: currentPrice * 0.99,
      riskReward: 1,
      description: 'Indecision candle — open and close nearly equal',
    });
  }
  if (detectHammer(last)) {
    const target = currentPrice + (currentPrice - support) * 2;
    results.push({
      name: 'Hammer',
      type: 'bullish',
      confidence: 72,
      target,
      support,
      resistance,
      stopLoss: last.low - atr * 0.5,
      riskReward: 2,
      description: 'Bullish reversal — long lower wick shows buying pressure',
    });
  }
  if (detectShootingStar(last)) {
    const target = currentPrice - (resistance - currentPrice) * 2;
    results.push({
      name: 'Shooting Star',
      type: 'bearish',
      confidence: 70,
      target,
      support,
      resistance,
      stopLoss: last.high + atr * 0.5,
      riskReward: 2,
      description: 'Bearish reversal — long upper wick shows selling pressure',
    });
  }
  if (prev && prev2) {
    const engulfing = detectEngulfing(prev, last);
    if (engulfing === 'bullish') {
      results.push({
        name: 'Bullish Engulfing',
        type: 'bullish',
        confidence: 78,
        target: resistance,
        support,
        resistance,
        stopLoss: last.low - atr,
        riskReward: Math.round(((resistance - currentPrice) / (currentPrice - (last.low - atr))) * 10) / 10,
        description: 'Current bullish candle engulfs previous bearish candle',
      });
    }
    if (engulfing === 'bearish') {
      results.push({
        name: 'Bearish Engulfing',
        type: 'bearish',
        confidence: 76,
        target: support,
        support,
        resistance,
        stopLoss: last.high + atr,
        riskReward: Math.round(((currentPrice - support) / (last.high + atr - currentPrice)) * 10) / 10,
        description: 'Current bearish candle engulfs previous bullish candle',
      });
    }
    if (detectMorningStar(prev2, prev, last)) {
      results.push({
        name: 'Morning Star',
        type: 'bullish',
        confidence: 80,
        target: resistance,
        support,
        resistance,
        stopLoss: prev.low - atr,
        riskReward: 2.5,
        description: 'Three-candle bullish reversal at the bottom',
      });
    }
  }

  // Validate all patterns before returning
  const validated = results
    .map(p => validatePattern(p, currentPrice))
    .filter((p): p is PatternResult => p !== null);

  return validated.sort((a, b) => b.confidence - a.confidence);
}

// ─── Time-Series Indicator Arrays ─────────────────────────────────────────

function calcEMASeries(values: number[], period: number): number[] {
  const result = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return result;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

export function calcRSISeries(closes: number[], period = 14): number[] {
  const result = new Array<number>(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  const toRSI = (ag: number, al: number) => al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  result[period] = toRSI(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    result[i] = toRSI(avgGain, avgLoss);
  }
  return result;
}

export function calcMACDSeries(closes: number[]): {
  macd: number[];
  signal: number[];
  histogram: number[];
} {
  const nan = new Array<number>(closes.length).fill(NaN);
  if (closes.length < 35) return { macd: nan, signal: [...nan], histogram: [...nan] };
  const ema12 = calcEMASeries(closes, 12);
  const ema26 = calcEMASeries(closes, 26);
  const macdLine = closes.map((_, i) =>
    isNaN(ema12[i]) || isNaN(ema26[i]) ? NaN : ema12[i] - ema26[i]
  );
  const validIdx: number[] = [];
  const validVals: number[] = [];
  macdLine.forEach((v, i) => { if (!isNaN(v)) { validIdx.push(i); validVals.push(v); } });
  const signalVals = calcEMASeries(validVals, 9);
  const signalLine = new Array<number>(closes.length).fill(NaN);
  validIdx.forEach((origI, k) => { signalLine[origI] = isNaN(signalVals[k]) ? NaN : signalVals[k]; });
  const histogram = macdLine.map((m, i) =>
    isNaN(m) || isNaN(signalLine[i]) ? NaN : m - signalLine[i]
  );
  return { macd: macdLine, signal: signalLine, histogram };
}