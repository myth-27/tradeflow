import type { Candle } from './binance-ws';
import {
  runAllPatterns, calcRSI, calcMACD, calcATR, calcVolumeProfile, calcEMA, calcBollingerBands,
  findSupportLevels, findResistanceLevels,
  type PatternResult,
} from './pattern-engine';

// ─── Types ───────────────────────────────────────────────────────────────

export type EntryType = 'limit' | 'stop' | 'market';
export type MarketRegime = 'strong_uptrend' | 'weak_uptrend' | 'strong_downtrend' | 'weak_downtrend' | 'ranging' | 'low_volatility';
export type ConvictionLevel = 'low' | 'normal' | 'high' | 'very_high';
export type TrailingStopMode = 'fixed' | 'atr1' | 'atr1.5';
export type EntryTypeMode = 'auto' | 'limit_only' | 'stop_only' | 'market_only';

export const ALL_REGIMES: MarketRegime[] = ['strong_uptrend', 'weak_uptrend', 'strong_downtrend', 'weak_downtrend', 'ranging', 'low_volatility'];

export type SimConfig = {
  symbol: string;
  interval: string;
  startDate: string;
  endDate: string;
  startingCapital: number;
  riskPerTrade: number;
  minRR: number;
  minConfidence: number;
  maxOpenTime: number;
  allowedPatterns: string[];
  regimeFilter: boolean;
  partialExit: boolean;

  // ── Everything below is optional and defaulted inside runSimulation() via
  // defaultSimConfig(), so existing callers (e.g. the API route) that only build the
  // original field set keep working unchanged. ──

  // Entry discipline (RULE SET 1)
  entryTypeMode?: EntryTypeMode;
  maxWaitCandles?: number;
  entrySlippageBuffer?: number; // e.g. 0.001 = 0.1%

  // Session filter
  sessionFilter?: boolean;
  sessionStartHour?: number;
  sessionEndHour?: number;

  // Scaling (RULE SET 3)
  allowConvictionScaling?: boolean;
  lowConvictionMultiplier?: number;
  highConvictionMultiplier?: number;
  veryHighConvictionMultiplier?: number;
  allowPyramiding?: boolean;

  // Capital protection (RULE SET 6)
  dailyLossLimitPct?: number;
  weeklyLossLimitPct?: number;
  maxConsecutiveLosses?: number;
  drawdownHaltPct?: number;

  // Final post-adjustment signal score floor — hard reject below this regardless of conviction.
  // Was a hardcoded module constant (SCORE_FLOOR = 50); made configurable, defaulting to the
  // same 50, so every existing caller that doesn't set it keeps today's exact behavior.
  scoreFloor?: number;

  // Regime-conditional position sizing — multiplies effectiveRiskPct by the entry's classified
  // regime (looked up at the same point classifyRegime() already runs). Undefined/missing key
  // means 1.0x (no change), so every existing caller that doesn't set this keeps today's exact
  // sizing behavior. Composes multiplicatively with the existing capital-protection tiers below,
  // not in place of them.
  regimeSizeMultipliers?: Partial<Record<MarketRegime, number>>;

  // Stop trailing (RULE SET 2)
  trailingStopMode?: TrailingStopMode;

  // Regime filter (RULE SET 5)
  allowedRegimes?: MarketRegime[];

  // Higher-timeframe confirmation — only take a signal when a higher timeframe's own trend
  // regime agrees with the signal's direction. Empirically this is what separates 1h (which
  // has real edge on its own) from 5m (which doesn't) — gate 5m/15m entries on 1h agreement.
  htfConfirmation?: boolean;
  htfTimeframe?: string;
};

// The fully-resolved config used internally once defaults have been merged in.
type ResolvedSimConfig = Required<SimConfig>;

export type SimExitReason = 'tp1_then_be' | 'tp2' | 'tp3' | 'stop' | 'expired' | 'entry_expired' | 'end_of_data';
export type SimStatus = 'waiting_entry' | 'open' | 'partial' | 'closed';

export type SimTrade = {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  patternName: string;
  confidence: number;
  status: SimStatus;

  // Entry discipline
  entryType: EntryType;
  limitPrice: number;
  signalCandle: number;     // candle where the signal was generated/scored
  entryExpiryCandle: number; // signalCandle + maxWaitCandles — give up waiting after this
  waitedCandles: number;    // candles waited before fill (0 for market)
  entrySlippage: number;    // limitPrice vs actual fill price

  entryCandle: number;      // fill candle (== signalCandle for market entries)
  entryTime: number;
  entryPrice: number;

  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number | null;

  positionSize: number;
  capitalAtRisk: number;
  positionValue: number;

  exitCandle: number | null;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: SimExitReason;

  tp1Hit: boolean;
  tp1HitCandle: number | null;
  tp2Hit: boolean;
  tp2HitCandle: number | null;
  tp3Hit: boolean;
  tp3HitCandle: number | null;
  stopMovedToBreakeven: boolean;
  remainingPositionPct: number; // 100 -> 0 as partial exits happen
  partialExitPnl: number; // $ already banked from TP1/TP2 partial closes, added into the final close's total

  // Signal quality
  signalScore: number;
  scoreReasons: string[];
  convictionLevel: ConvictionLevel;
  convictionMultiplier: number;

  // Pyramiding
  pyramidEntry: number | null;
  pyramidSize: number | null;
  blendedEntry: number | null;

  // Market context
  regime: MarketRegime;
  sessionHour: number;

  // Capital protection
  capitalProtectionMode: boolean;
  reducedSizing: boolean;

  // Stop details
  stopFillSlippage: number;
  stopWasTrailed: boolean;

  pnlDollars: number;
  pnlPercent: number;
  accountPnlPercent: number;
  rMultiple: number;

  capitalBefore: number;
  capitalAfter: number;

  rsiAtEntry: number;
  macdAtEntry: 'bullish' | 'bearish';
  volumeRatioAtEntry: number;
  atrAtEntry: number;
  trendAtEntry: 'up' | 'down' | 'sideways';

  // ── ML feature context (captured at signal time for the training dataset) ──
  // "HTF" here is a same-timeframe proxy (EMA50 vs EMA200) rather than a true higher-timeframe
  // fetch — fetching a second candle series mid-simulation would meaningfully slow every run.
  htfBias: 'bullish' | 'bearish' | 'neutral';
  htfStrength: number;
  htfEmaSeparation: number;
  htfStructure: 'HH_HL' | 'LH_LL' | 'mixed';
  bbLowerAtEntry: number;
  bbUpperAtEntry: number;
  ema20VsEma50AtEntry: number;
  priceVsEma20AtEntry: number;
  distToSupportPct: number;
  distToResistancePct: number;
  macdHistPrevAtEntry: number;
  volumeRatioPrevAtEntry: number;
  winStreakBeforeEntry: number;
  lossStreakBeforeEntry: number;
  drawdownPctAtEntry: number;
};

export type PatternStat = {
  signals: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgRMultiple: number;
  totalPnl: number;
  best: number;
  worst: number;
};

export type HourStat = { trades: number; wins: number; pnl: number };
export type RegimeStats = { candles: number; tradesAllowed: number; tradesBlocked: number; winRate: number };

export type EquityPoint = { time: number; value: number; drawdown: number; tradeId: string | null };

export type RejectionStats = {
  tradesRejectedByEntry: number;
  tradesRejectedByRR: number;
  tradesRejectedByVolume: number;
  tradesRejectedBySession: number;
  tradesRejectedByLossStreak: number;
  tradesRejectedByDailyLimit: number;
  tradesRejectedByWeeklyLimit: number;
  tradesRejectedByRegime: number;
  tradesRejectedByATR: number;
  tradesRejectedByScore: number;
  tradesRejectedByValidation: number;
  tradesRejectedByPatternLogic: number;
  tradesRejectedByMinConfidence: number;
  tradesRejectedByPatternChoice: number;
  tradesRejectedByHtfDisagreement: number;
};

export type SimResult = {
  config: ResolvedSimConfig;

  startingCapital: number;
  finalCapital: number;
  totalReturn: number;
  totalReturnDollars: number;

  totalSignals: number;
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  expired: number;

  winRate: number;

  avgWinPercent: number;
  avgLossPercent: number;
  avgRMultiple: number;
  profitFactor: number;

  maxDrawdown: number;
  maxDrawdownDollars: number;
  sharpeRatio: number;

  avgTradeLength: number;
  avgWinLength: number;
  avgLossLength: number;

  patternStats: Record<string, PatternStat>;
  hourlyStats: Record<number, HourStat>;

  equityCurve: EquityPoint[];
  trades: SimTrade[];

  totalCandles: number;
  signalsFilteredByRegime: number;

  // ── New: guardrail / rules-engine stats ──
  rejections: RejectionStats;
  daysTraded: number;
  daysPaused: number;
  highConvictionTrades: number;
  lowConvictionTrades: number;
  pyramidedTrades: number;
  regimeBreakdown: Record<MarketRegime, RegimeStats>;
  consecutiveWins: number;
  consecutiveLosses: number;
  expectancy: number;
  recoveryFactor: number;
  avgHoldingTime: number;
  bestTrade: SimTrade | null;
  worstTrade: SimTrade | null;
};

export type ProgressCounters = { signals: number; trades: number; capital: number; winRate: number };
export type ProgressFn = (pct: number, msg: string, counters?: ProgressCounters) => void;

export function defaultSimConfig(overrides: Partial<SimConfig> = {}): SimConfig {
  return {
    symbol: 'BTCUSDT', interval: '5m', startDate: '', endDate: '',
    startingCapital: 100000, riskPerTrade: 0.01, minRR: 1.5, minConfidence: 65,
    maxOpenTime: 20, allowedPatterns: [], regimeFilter: true, partialExit: true,
    entryTypeMode: 'auto', maxWaitCandles: 5, entrySlippageBuffer: 0.001,
    sessionFilter: false, sessionStartHour: 7, sessionEndHour: 21,
    allowConvictionScaling: true, lowConvictionMultiplier: 0.5, highConvictionMultiplier: 1.5,
    veryHighConvictionMultiplier: 2.0, allowPyramiding: false,
    dailyLossLimitPct: 0.03, weeklyLossLimitPct: 0.06, maxConsecutiveLosses: 3, drawdownHaltPct: 0.5,
    trailingStopMode: 'fixed',
    allowedRegimes: ALL_REGIMES.filter(r => r !== 'low_volatility'),
    htfConfirmation: true,
    htfTimeframe: '1h',
    scoreFloor: 50,
    ...overrides,
  };
}

/** Timeframes below this benefit from HTF confirmation against htfTimeframe (default 1h). */
const HTF_ELIGIBLE_INTERVALS = new Set(['1m', '5m', '15m']);

export function isHtfEligible(interval: string): boolean {
  return HTF_ELIGIBLE_INTERVALS.has(interval);
}

// ─── Data Fetching ───────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchSimulationData(
  symbol: string,
  interval: string,
  startDate: string,
  endDate: string,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const startTime = new Date(`${startDate}T00:00:00Z`).getTime();
  const endTime = new Date(`${endDate}T23:59:59Z`).getTime();
  const results: Candle[] = [];
  let cursor = startTime;

  const INTERVAL_MS: Record<string, number> = {
    '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
  };
  const stepMs = INTERVAL_MS[interval] ?? 300_000;
  const estimatedTotal = Math.max(1, Math.ceil((endTime - startTime) / stepMs));

  while (cursor < endTime) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&startTime=${cursor}&limit=1000`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Binance API error: ${res.status} ${res.statusText}`);
    const batch = (await res.json()) as [number, string, string, string, string, string, number, string, number, string, string, string][];
    if (!batch.length) break;

    for (const k of batch) {
      const time = Math.floor(k[0] / 1000);
      if (time * 1000 > endTime) break;
      results.push({
        time,
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      });
    }

    const lastCloseTime = batch[batch.length - 1][6];
    cursor = lastCloseTime + 1;

    onProgress(Math.min(50, (results.length / estimatedTotal) * 50), `Fetching candles from Binance... ${results.length.toLocaleString()}`);

    if (batch.length < 1000) break;
    await sleep(100);
  }

  return results.filter(c => c.volume > 0).sort((a, b) => a.time - b.time);
}

// ─── Pure signal generation (ported from hooks/usePatternDetection.ts) ───
// usePatternDetection.ts is a React hook tied to component state and can't run inside a
// plain simulation loop, so the same confluence/trend-filter/ATR-stop logic it uses live is
// reproduced here as a pure function, then layered with the professional rules engine below.

export type SimSignal = {
  type: 'bullish' | 'bearish';
  patternName: string;
  pattern: PatternResult;
  confidence: number;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
};

function generateSimSignal(
  patterns: PatternResult[],
  rsi: number,
  macdHistogram: number,
  volumeRatio: number,
  isHighVolume: boolean,
  atr: number,
  price: number,
  trendDirection: 'up' | 'down' | 'sideways',
): SimSignal | null {
  if (!patterns.length) return null;

  const topBull = patterns.find(p => p.type === 'bullish');
  const topBear = patterns.find(p => p.type === 'bearish');
  const isConflict = !!(topBull && topBear && Math.abs(topBull.confidence - topBear.confidence) <= 15);
  if (isConflict) return null;

  const best = patterns[0];
  if (!best || best.confidence < 65 || best.type === 'neutral') return null;

  const isBullish = best.type === 'bullish';
  const isCounterTrend = (isBullish && trendDirection === 'down') || (!isBullish && trendDirection === 'up');
  if (isCounterTrend && best.confidence <= 80) return null;

  let confluenceBonus = 0;
  const macdBullish = macdHistogram > 0;
  const rsiBullish = rsi < 50;
  if (isBullish) {
    if (macdBullish) confluenceBonus += 5;
    if (rsiBullish) confluenceBonus += 5;
    if (isHighVolume) confluenceBonus += 10;
  } else {
    if (!macdBullish) confluenceBonus += 5;
    if (!rsiBullish) confluenceBonus += 5;
    if (isHighVolume) confluenceBonus += 10;
  }
  const finalConfidence = Math.min(best.confidence + confluenceBonus, 95);

  let finalStop: number;
  if (isBullish) {
    finalStop = Math.max(price - atr * 1.5, best.stopLoss);
  } else {
    finalStop = Math.min(price + atr * 1.5, best.stopLoss);
  }

  const risk = Math.abs(price - finalStop);
  const reward = Math.abs(best.target - price);
  const rr = risk > 0 ? reward / risk : 0;
  if (rr < 1.2) return null; // a looser pre-filter — the real minRR + resistance-aware check happens later

  return {
    type: isBullish ? 'bullish' : 'bearish',
    patternName: best.name,
    pattern: best,
    confidence: Math.round(finalConfidence),
    entry: price,
    stopLoss: finalStop,
    target: best.target,
    riskReward: Math.round(rr * 100) / 100,
  };
}

// ─── RULE SET 5: Market Regime Classification ──────────────────────────────

export function classifyRegime(window: Candle[]): MarketRegime {
  const recent = window.slice(-50);
  const closes = recent.map(c => c.close);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);

  const ema20Arr = calcEMA(closes, 20);
  const ema50Arr = calcEMA(closes, 50);
  const ema20 = ema20Arr[ema20Arr.length - 1];
  const ema50 = ema50Arr[ema50Arr.length - 1];
  const atr = calcATR(window.slice(-20));
  const currentPrice = closes[closes.length - 1];

  if (ema20 === undefined || ema50 === undefined || !currentPrice) return 'ranging';

  const emaDivergence = (Math.abs(ema20 - ema50) / ema50) * 100;
  const atrPct = (atr / currentPrice) * 100;

  const recentHighs = highs.slice(-10);
  const recentLows = lows.slice(-10);
  const hhCount = recentHighs.filter((h, i) => i > 0 && h > recentHighs[i - 1]).length;
  const llCount = recentLows.filter((l, i) => i > 0 && l < recentLows[i - 1]).length;

  if (emaDivergence > 0.5 && ema20 > ema50 && hhCount >= 6) return 'strong_uptrend';
  if (emaDivergence > 0.5 && ema20 < ema50 && llCount >= 6) return 'strong_downtrend';
  if (emaDivergence > 0.2 && ema20 > ema50) return 'weak_uptrend';
  if (emaDivergence > 0.2 && ema20 < ema50) return 'weak_downtrend';
  // Reserved for genuinely dead markets, not just "not trending" — a tighter bar than the
  // original 0.15% kept misclassifying ordinary quiet hours as low_volatility and blocking
  // far more candles than the other 5 regimes combined.
  if (atrPct < 0.06) return 'low_volatility';
  return 'ranging';
}

// ─── ML feature helper: same-timeframe "HTF" proxy (EMA50 vs EMA200) ──────
// A true higher-timeframe read would require fetching a second candle series per signal,
// which would meaningfully slow every simulation — this proxies the same idea using a much
// slower EMA pair on the timeframe already in hand.
function computeHtfProxy(window: Candle[]): {
  bias: 'bullish' | 'bearish' | 'neutral';
  strength: number;
  separation: number;
  structure: 'HH_HL' | 'LH_LL' | 'mixed';
} {
  const closes = window.map(c => c.close);
  const ema50Arr = calcEMA(closes, 50);
  const ema200Arr = calcEMA(closes, Math.min(200, Math.max(50, closes.length - 1)));
  const ema50 = ema50Arr[ema50Arr.length - 1];
  const ema200 = ema200Arr[ema200Arr.length - 1];

  if (ema50 === undefined || ema200 === undefined || !ema200) {
    return { bias: 'neutral', strength: 0, separation: 0, structure: 'mixed' };
  }

  const separation = ((ema50 - ema200) / ema200) * 100;
  const bias: 'bullish' | 'bearish' | 'neutral' =
    separation > 0.15 ? 'bullish' : separation < -0.15 ? 'bearish' : 'neutral';
  const strength = Math.min(100, Math.abs(separation) * 20);

  const recent = window.slice(-20);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const hh = highs.filter((h, i) => i > 0 && h > highs[i - 1]).length;
  const ll = lows.filter((l, i) => i > 0 && l < lows[i - 1]).length;
  const structure: 'HH_HL' | 'LH_LL' | 'mixed' = hh >= 12 ? 'HH_HL' : ll >= 12 ? 'LH_LL' : 'mixed';

  return { bias, strength: Math.round(strength), separation, structure };
}

// ─── RULE SET 7: Signal Quality Scoring ────────────────────────────────────

type Indicators = {
  rsi: number;
  macd: { macd: number; signal: number; histogram: number; momentumBuilding: boolean };
  atr: number;
  volume: { ratio: number };
  bb: { upper: number; middle: number; lower: number };
};

function scoreSignal(
  pattern: PatternResult,
  indicators: Indicators,
  regime: MarketRegime,
  currentPrice: number,
  supportLevels: number[],
  resistanceLevels: number[],
  recentTrades: SimTrade[],
  patternEdgeHints?: Record<string, { winRate: number; profitFactor: number; sampleSize: number }>,
  timeframe?: string,
  symbol?: string,
): { score: number; reasons: string[]; reject: boolean } {
  let score = pattern.confidence;
  const reasons: string[] = [`Pattern confidence: ${pattern.confidence} (base)`];
  let reject = false;

  // Self-learning feedback: claimed pattern confidence is a static, book-derived prior. Once
  // we have a real track record for this pattern (from this or earlier simulations, accumulated
  // in the edge registry), let what ACTUALLY happened override what the pattern claims about
  // itself — this is the only thing that lets the system improve run over run instead of
  // repeating the same overconfident mistakes forever.
  // A pattern's real track record can differ sharply by timeframe (1h vs 5m), so prefer the
  // timeframe-specific hint — but only once IT is also mature (30+ samples), the same bar the
  // broad hint needs to fully kick in below. Using a low threshold here creates a cold-start
  // regression: the moment timeframe-specific data exists, it fully overrides everything the
  // broad cross-timeframe history already learned, even at just 10 thin, noisy samples — which
  // is exactly how a pattern already proven bad gets "forgotten" and let back in on a timeframe
  // it was never actually tested enough on.
  // Most specific first: pattern+symbol+timeframe (e.g. Double Bottom is fine on BTC but a
  // 10%-WR disaster on SOL specifically — a plain pattern or pattern+timeframe blend would
  // mask that). Each tier only overrides the next-coarser one once it's independently mature.
  const symTfHint = (symbol && timeframe) ? patternEdgeHints?.[`${pattern.name}|${symbol}|${timeframe}`] : undefined;
  const tfHint = timeframe ? patternEdgeHints?.[`${pattern.name}|${timeframe}`] : undefined;
  const hint = (symTfHint && symTfHint.sampleSize >= 30) ? symTfHint
    : (tfHint && tfHint.sampleSize >= 30) ? tfHint
    : patternEdgeHints?.[pattern.name];
  if (hint && hint.sampleSize >= 30) {
    if (hint.winRate < 20) { reject = true; reasons.push(`REJECT: Historically poor — only ${hint.winRate.toFixed(0)}% real win rate over ${hint.sampleSize} trades`); }
    else if (hint.winRate < 30) { score -= 25; reasons.push(`Historically weak pattern: ${hint.winRate.toFixed(0)}% real WR over ${hint.sampleSize} trades (-25)`); }
    else if (hint.winRate < 40) { score -= 12; reasons.push(`Below-average real track record: ${hint.winRate.toFixed(0)}% WR (-12)`); }
    else if (hint.winRate > 70) { score += 20; reasons.push(`Historically strong pattern: ${hint.winRate.toFixed(0)}% real WR over ${hint.sampleSize} trades (+20)`); }
    else if (hint.winRate > 60) { score += 12; reasons.push(`Above-average real track record: ${hint.winRate.toFixed(0)}% WR (+12)`); }
  } else if (hint && hint.sampleSize >= 10) {
    if (hint.winRate < 30) { score -= 6; reasons.push(`Early signs of weak performance: ${hint.winRate.toFixed(0)}% WR over ${hint.sampleSize} trades (-6)`); }
    else if (hint.winRate > 60) { score += 6; reasons.push(`Early signs of strong performance: ${hint.winRate.toFixed(0)}% WR over ${hint.sampleSize} trades (+6)`); }
  }

  if (indicators.volume.ratio > 2.0) { score += 15; reasons.push('High volume confirmation (+15)'); }
  else if (indicators.volume.ratio > 1.5) { score += 8; reasons.push('Above average volume (+8)'); }
  else if (indicators.volume.ratio < 0.8) { score -= 15; reasons.push('Low volume warning (-15)'); }

  if (regime === 'strong_uptrend' && pattern.type === 'bullish') { score += 12; reasons.push('Strong uptrend alignment (+12)'); }
  if (regime === 'strong_downtrend' && pattern.type === 'bearish') { score += 12; reasons.push('Strong downtrend alignment (+12)'); }
  if (regime === 'ranging') { score -= 10; reasons.push('Ranging market (-10)'); }

  const macdBullish = indicators.macd.histogram > 0;
  if (macdBullish && pattern.type === 'bullish') { score += 8; reasons.push('MACD confirming bullish (+8)'); }
  if (!macdBullish && pattern.type === 'bearish') { score += 8; reasons.push('MACD confirming bearish (+8)'); }
  if (indicators.macd.momentumBuilding) { score += 5; reasons.push('MACD momentum building (+5)'); }

  if (pattern.type === 'bullish') {
    if (indicators.rsi >= 40 && indicators.rsi <= 60) { score += 10; reasons.push('RSI in ideal zone for long (+10)'); }
    else if (indicators.rsi < 35) { score += 5; reasons.push('RSI oversold recovery (+5)'); }
    if (indicators.rsi > 70) { score -= 20; reasons.push('RSI overbought for long (-20)'); }
  } else if (pattern.type === 'bearish') {
    if (indicators.rsi >= 40 && indicators.rsi <= 60) { score += 10; reasons.push('RSI in ideal zone for short (+10)'); }
    else if (indicators.rsi > 65) { score += 5; reasons.push('RSI overbought reversal (+5)'); }
    if (indicators.rsi < 30) { score -= 20; reasons.push('RSI oversold for short (-20)'); }
  }

  const bandRange = indicators.bb.upper - indicators.bb.lower;
  if (bandRange > 0) {
    const nearLower = Math.abs(currentPrice - indicators.bb.lower) / bandRange < 0.1;
    const nearUpper = Math.abs(currentPrice - indicators.bb.upper) / bandRange < 0.1;
    if (pattern.type === 'bullish' && nearLower) { score += 8; reasons.push('Price at Bollinger lower band (+8)'); }
    if (pattern.type === 'bullish' && nearUpper) { score -= 10; reasons.push('Price at Bollinger upper band (-10)'); }
  }

  const nearSupport = supportLevels.some(s => Math.abs(currentPrice - s) / currentPrice < 0.005);
  const nearResistance = resistanceLevels.some(r => Math.abs(currentPrice - r) / currentPrice < 0.005);
  if (nearSupport) { score += 10; reasons.push('Entry at key support level (+10)'); }
  if (nearResistance && pattern.type === 'bullish') { score -= 10; reasons.push('Resistance blocking entry (-10)'); }

  if (pattern.riskReward >= 3.0) { score += 10; reasons.push('Excellent R:R ratio (+10)'); }
  else if (pattern.riskReward >= 2.0) { score += 5; reasons.push('Good R:R ratio (+5)'); }

  const patternHistory = recentTrades.filter(t => t.patternName === pattern.name && t.status === 'closed').slice(-5);
  if (patternHistory.length >= 3) {
    const recentWinRate = patternHistory.filter(t => t.rMultiple > 0).length / patternHistory.length;
    if (recentWinRate >= 0.7) { score += 8; reasons.push('Pattern on hot streak (+8)'); }
    if (recentWinRate < 0.3) { score -= 10; reasons.push('Pattern on cold streak (-10)'); }
  }

  // Hard rejects — score doesn't matter once these trip
  if (indicators.atr < currentPrice * 0.001) { reject = true; reasons.push('REJECT: Market too quiet (ATR < 0.1%)'); }
  if (pattern.type === 'bullish' && indicators.rsi > 80) { reject = true; reasons.push('REJECT: RSI too overbought (>80) for long'); }
  if (pattern.type === 'bearish' && indicators.rsi < 20) { reject = true; reasons.push('REJECT: RSI too oversold (<20) for short'); }
  if (regime === 'low_volatility') { reject = true; reasons.push('REJECT: Low volatility regime'); }
  if (indicators.volume.ratio < 0.5) { reject = true; reasons.push('REJECT: Volume essentially dead (<0.5x)'); }

  return { score: Math.max(0, Math.min(100, score)), reasons, reject };
}

function convictionFromScore(score: number, config: ResolvedSimConfig): { level: ConvictionLevel; multiplier: number } {
  if (!config.allowConvictionScaling) return { level: 'normal', multiplier: 1 };
  if (score >= 90) return { level: 'very_high', multiplier: config.veryHighConvictionMultiplier };
  if (score >= 85) return { level: 'high', multiplier: config.highConvictionMultiplier };
  if (score < 65) return { level: 'low', multiplier: config.lowConvictionMultiplier };
  return { level: 'normal', multiplier: 1 };
}

// ─── RULE SET 1: Entry type determination ─────────────────────────────────

function determineEntryType(patternName: string, mode: EntryTypeMode, confidence: number, volumeRatio: number): { type: EntryType; needsLimitRetest: boolean } {
  if (mode === 'limit_only') return { type: 'limit', needsLimitRetest: true };
  if (mode === 'stop_only') return { type: 'stop', needsLimitRetest: false };
  if (mode === 'market_only') return { type: 'market', needsLimitRetest: false };

  // auto mode — choose based on pattern family
  if (confidence > 80 && volumeRatio > 1.8) return { type: 'market', needsLimitRetest: false };
  if (/Flag|Ascending Triangle|Double Bottom|Double Top/i.test(patternName)) return { type: 'limit', needsLimitRetest: true };
  if (/Triangle/i.test(patternName)) return { type: 'stop', needsLimitRetest: false };
  return { type: 'stop', needsLimitRetest: false };
}

function calcLimitPrice(pattern: PatternResult, isBullish: boolean, currentPrice: number): number {
  // Limit entries wait for a retest of the level the pattern broke from.
  if (/Flag/i.test(pattern.name)) return isBullish ? pattern.support : pattern.resistance;
  if (/Ascending Triangle/i.test(pattern.name)) return pattern.resistance;
  if (/Descending Triangle/i.test(pattern.name)) return pattern.support;
  if (/Double Bottom/i.test(pattern.name)) return pattern.resistance; // neckline
  if (/Double Top/i.test(pattern.name)) return pattern.support; // neckline
  return currentPrice;
}

// Targets are always expressed as a multiple of risk-per-unit from entry, so they can be
// recomputed against either the signal-time price or (critically) the actual fill price.
function calcTargets(
  entry: number,
  riskPerUnit: number,
  isBullish: boolean,
  convictionLevel: ConvictionLevel,
): { tp1: number; tp2: number; tp3: number | null } {
  const dir = isBullish ? 1 : -1;
  const tp1 = entry + dir * riskPerUnit * 1.0;
  let tp2: number;
  let tp3: number | null = null;
  if (convictionLevel === 'low') {
    tp2 = entry + dir * riskPerUnit * 1.5;
  } else if (convictionLevel === 'high') {
    tp2 = entry + dir * riskPerUnit * 2.5;
    tp3 = entry + dir * riskPerUnit * 3.0;
  } else if (convictionLevel === 'very_high') {
    tp2 = entry + dir * riskPerUnit * 2.0;
    tp3 = entry + dir * riskPerUnit * 3.0;
  } else {
    tp2 = entry + dir * riskPerUnit * 2.0;
  }
  return { tp1, tp2, tp3 };
}

// ─── Simulation Loop ───────────────────────────────────────────────────────

const WARMUP = 100;
const LOSS_STREAK_COOLDOWN_CANDLES = 20; // pause length once maxConsecutiveLosses is hit
const MAX_LEVERAGE = 10; // cap on positionValue/capital — this is a leveraged-perpetual sim, not cash-only spot

export async function runSimulation(
  rawConfig: SimConfig,
  candles: Candle[],
  onProgress: ProgressFn,
  signal?: AbortSignal,
  // Real win rate/profit factor per pattern, aggregated from every previous simulation (and
  // live signal) via lib/edge-registry.ts's getPatternEdgeHints(). Optional and Dexie-free here
  // — the caller fetches it and passes it in, so this module stays free of any IndexedDB
  // dependency and still works wherever it's called from.
  patternEdgeHints?: Record<string, { winRate: number; profitFactor: number; sampleSize: number }>,
  // Higher-timeframe candles (e.g. 1h) covering the same date range, used to gate 5m/15m
  // signals on HTF trend agreement when config.htfConfirmation is on. Fetched by the caller —
  // this module never fetches data itself, it only consumes what it's given.
  htfCandles?: Candle[],
): Promise<SimResult> {
  // Callers (e.g. the API route) may only supply the original field set; merge in defaults for
  // everything the professional rules engine added. TS can't prove the optional fields are
  // resolved by this merge on its own, hence the assertion — the runtime behavior is correct as
  // long as callers omit unset fields rather than passing them as explicit `undefined`.
  const config = { ...defaultSimConfig(), ...rawConfig } as ResolvedSimConfig;
  let capital = config.startingCapital;
  let peakCapital = capital;
  let maxDrawdown = 0;
  let maxDrawdownDollars = 0;
  const trades: SimTrade[] = [];
  const equityCurve: EquityPoint[] = [{ time: candles[WARMUP]?.time ?? 0, value: capital, drawdown: 0, tradeId: null }];
  let activeTrade: SimTrade | null = null;
  let totalSignals = 0;
  let signalsFilteredByRegime = 0;

  const rejections: RejectionStats = {
    tradesRejectedByEntry: 0, tradesRejectedByRR: 0, tradesRejectedByVolume: 0, tradesRejectedBySession: 0,
    tradesRejectedByLossStreak: 0, tradesRejectedByDailyLimit: 0, tradesRejectedByWeeklyLimit: 0, tradesRejectedByRegime: 0, tradesRejectedByATR: 0,
    tradesRejectedByScore: 0, tradesRejectedByValidation: 0,
    tradesRejectedByPatternLogic: 0, tradesRejectedByMinConfidence: 0, tradesRejectedByPatternChoice: 0,
    tradesRejectedByHtfDisagreement: 0,
  };

  const regimeBreakdown: Record<MarketRegime, RegimeStats> = Object.fromEntries(
    ALL_REGIMES.map(r => [r, { candles: 0, tradesAllowed: 0, tradesBlocked: 0, winRate: 0 }]),
  ) as Record<MarketRegime, RegimeStats>;

  // Capital protection bookkeeping
  const dailyPnl = new Map<string, number>();
  const weeklyPnl = new Map<string, number>();
  let consecutiveLossCount = 0;
  let cooldownUntilCandle = -1;
  const dateKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const weekKey = (t: number) => Math.floor(t / (7 * 86400)).toString();
  let tradingHalted = false;

  // ML feature bookkeeping — independent of the cooldown-gate streak above, never reset early
  let mlWinStreak = 0;
  let mlLossStreak = 0;

  // Monotonic pointer into htfCandles — htfPointer always ends up as the count of HTF candles
  // fully closed at or before the current candle's time, so htfCandles.slice(0, htfPointer) is
  // a strictly-past, no-lookahead HTF window.
  let htfPointer = 0;

  for (let i = WARMUP; i < candles.length; i++) {
    const candle = candles[i];
    const window = candles.slice(0, i); // strictly past candles — no lookahead
    const currentPrice = candle.close;

    if (htfCandles) {
      while (htfPointer < htfCandles.length && htfCandles[htfPointer].time <= candle.time) htfPointer++;
    }

    if (i % 200 === 0) {
      const decidedSoFar = trades.filter(t => t.status === 'closed');
      const winsSoFar = decidedSoFar.filter(t => t.rMultiple > 0.1).length;
      onProgress(
        50 + (i / candles.length) * 50,
        `Processing candle ${i.toLocaleString()}/${candles.length.toLocaleString()}...`,
        { signals: totalSignals, trades: trades.length, capital, winRate: decidedSoFar.length > 0 ? (winsSoFar / decidedSoFar.length) * 100 : 0 },
      );
      // Yield back to the event loop periodically so progress actually renders and, when this
      // runs in a browser tab, the UI thread never goes unresponsive during a long simulation.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }

    if (capital < config.startingCapital * (1 - config.drawdownHaltPct)) { tradingHalted = true; }

    // ── Manage the active trade (waiting-for-entry OR live position) ──────
    if (activeTrade) {
      if (activeTrade.status === 'waiting_entry') {
        const isBullish = activeTrade.direction === 'long';
        let filled = false;
        let fillPrice = activeTrade.limitPrice;

        if (activeTrade.entryType === 'limit') {
          filled = isBullish ? candle.low <= activeTrade.limitPrice : candle.high >= activeTrade.limitPrice;
          fillPrice = activeTrade.limitPrice;
        } else if (activeTrade.entryType === 'stop') {
          filled = isBullish ? candle.close >= activeTrade.limitPrice : candle.close <= activeTrade.limitPrice;
          fillPrice = isBullish ? activeTrade.limitPrice * 1.001 : activeTrade.limitPrice * 0.999;
        } else {
          filled = true; // market — fills immediately on the signal candle
          fillPrice = activeTrade.limitPrice;
        }

        // Limit/stop entries can fill far from the signal-time price they were originally
        // sized against (that's the whole point of waiting for a retest) — stopLoss is a
        // fixed price level, so the REAL risk-per-unit at fill time can differ substantially
        // from what was used to size the position. Resize against the actual fill price so a
        // normal stop-out loses the intended $ risk, not some multiple of it. If the drift
        // invalidates the setup entirely (stop distance now out of bounds, or leverage blown
        // past the cap), treat it the same as an entry that never filled.
        let fillInvalidated = false;
        let resizedPositionSize = activeTrade.positionSize;
        let resizedPositionValue = activeTrade.positionValue;
        let filledTargets: { tp1: number; tp2: number; tp3: number | null } | null = null;

        if (filled) {
          const actualRiskPerUnit = Math.abs(fillPrice - activeTrade.stopLoss);
          const actualStopDistPct = actualRiskPerUnit / fillPrice;

          if (actualRiskPerUnit <= 0 || actualStopDistPct < 0.002 || actualStopDistPct > 0.03) {
            fillInvalidated = true;
          } else {
            resizedPositionSize = activeTrade.capitalAtRisk / actualRiskPerUnit;
            resizedPositionValue = resizedPositionSize * fillPrice;
            if (resizedPositionValue > capital * MAX_LEVERAGE) {
              fillInvalidated = true;
            } else {
              filledTargets = calcTargets(fillPrice, actualRiskPerUnit, activeTrade.direction === 'long', activeTrade.convictionLevel);
            }
          }
        }

        if (filled && !fillInvalidated && filledTargets) {
          activeTrade.status = 'open';
          activeTrade.entryCandle = i;
          activeTrade.entryTime = candle.time;
          activeTrade.entryPrice = fillPrice;
          activeTrade.entrySlippage = fillPrice - activeTrade.limitPrice;
          activeTrade.waitedCandles = i - activeTrade.signalCandle;
          activeTrade.capitalBefore = capital;
          activeTrade.positionSize = resizedPositionSize;
          activeTrade.positionValue = resizedPositionValue;
          activeTrade.tp1 = filledTargets.tp1;
          activeTrade.tp2 = filledTargets.tp2;
          activeTrade.tp3 = filledTargets.tp3;
        } else if (fillInvalidated || i > activeTrade.entryExpiryCandle) {
          activeTrade.status = 'closed';
          activeTrade.exitReason = 'entry_expired';
          activeTrade.exitCandle = i;
          activeTrade.exitTime = candle.time;
          activeTrade.waitedCandles = i - activeTrade.signalCandle;
          trades.push(activeTrade);
          if (fillInvalidated) rejections.tradesRejectedByValidation++;
          else rejections.tradesRejectedByEntry++;
          activeTrade = null;
        }
      } else {
        // Live position management
        const atr = activeTrade.atrAtEntry;
        const isLong = activeTrade.direction === 'long';

        const stopTriggered = isLong ? candle.low <= activeTrade.stopLoss : candle.high >= activeTrade.stopLoss;
        const tp1Triggered = !activeTrade.tp1Hit && (isLong ? candle.high >= activeTrade.tp1 : candle.low <= activeTrade.tp1);
        const tp2Triggered = activeTrade.tp1Hit && !activeTrade.tp2Hit && (isLong ? candle.high >= activeTrade.tp2 : candle.low <= activeTrade.tp2);
        const tp3Triggered = activeTrade.tp2Hit && activeTrade.tp3 !== null && (isLong ? candle.high >= activeTrade.tp3 : candle.low <= activeTrade.tp3);
        const candlesOpen = i - activeTrade.entryCandle;
        const expired = candlesOpen > config.maxOpenTime;

        if (tp3Triggered && activeTrade.tp3 !== null) {
          activeTrade.tp3Hit = true;
          activeTrade.tp3HitCandle = i;
          // closeTrade() reads remainingPositionPct to size the $ P&L of THIS close — it must
          // still reflect what's open (25% after tp1+tp2) going in, not what's left after
          // (0%). Zero it only once the close is computed.
          activeTrade = closeTrade(activeTrade, activeTrade.tp3, i, candle.time, 'tp3', capital);
          activeTrade.remainingPositionPct = 0;
          capital = activeTrade.capitalAfter;
          trades.push(activeTrade);
          recordOutcome(activeTrade, dailyPnl, weeklyPnl, dateKey, weekKey);
          if (activeTrade.rMultiple > 0.1) { mlWinStreak++; mlLossStreak = 0; }
          else if (activeTrade.exitReason === 'stop') { mlLossStreak++; mlWinStreak = 0; }
          consecutiveLossCount = isLossForStreak(activeTrade) ? consecutiveLossCount + 1 : 0;
          if (consecutiveLossCount >= config.maxConsecutiveLosses) {
            cooldownUntilCandle = i + LOSS_STREAK_COOLDOWN_CANDLES;
            consecutiveLossCount = 0; // cooldown itself is the penalty; let the streak re-accumulate fresh after it lifts
          }
          activeTrade = null;
        } else if (tp2Triggered) {
          const hasTp3 = activeTrade.tp3 !== null;
          activeTrade.tp2Hit = true;
          activeTrade.tp2HitCandle = i;
          if (hasTp3) {
            // High conviction 3-target plan: bank the 2nd tranche, let the runner continue to tp3
            const mult = isLong ? 1 : -1;
            const closePct = 0.5; // close 50% of the ORIGINAL size at tp2 (25% already closed at tp1)
            const pnl = (activeTrade.tp2 - activeTrade.entryPrice) * (activeTrade.positionSize * closePct) * mult;
            capital += pnl;
            activeTrade.partialExitPnl += pnl;
            activeTrade.remainingPositionPct = 25;
            // Trail the stop on the runner per config
            activeTrade.stopLoss = trailStop(activeTrade, candle, atr, config);
            activeTrade.stopWasTrailed = config.trailingStopMode !== 'fixed';
          } else {
            // Same ordering fix as the tp3 branch above — close first (using the still-open
            // remainingPositionPct), then zero it.
            activeTrade = closeTrade(activeTrade, activeTrade.tp2, i, candle.time, 'tp2', capital);
            activeTrade.remainingPositionPct = 0;
            capital = activeTrade.capitalAfter;
            trades.push(activeTrade);
            recordOutcome(activeTrade, dailyPnl, weeklyPnl, dateKey, weekKey);
          if (activeTrade.rMultiple > 0.1) { mlWinStreak++; mlLossStreak = 0; }
          else if (activeTrade.exitReason === 'stop') { mlLossStreak++; mlWinStreak = 0; }
            consecutiveLossCount = isLossForStreak(activeTrade) ? consecutiveLossCount + 1 : 0;
          if (consecutiveLossCount >= config.maxConsecutiveLosses) {
            cooldownUntilCandle = i + LOSS_STREAK_COOLDOWN_CANDLES;
            consecutiveLossCount = 0; // cooldown itself is the penalty; let the streak re-accumulate fresh after it lifts
          }
            activeTrade = null;
          }
        } else if (tp1Triggered) {
          activeTrade.tp1Hit = true;
          activeTrade.tp1HitCandle = i;
          const beBuffer = atr * 0.1;
          activeTrade.stopLoss = isLong ? activeTrade.entryPrice + beBuffer : activeTrade.entryPrice - beBuffer;
          activeTrade.stopMovedToBreakeven = true;

          const hasTp3 = activeTrade.tp3 !== null;
          const closePct = hasTp3 ? 0.25 : 0.5;
          activeTrade.remainingPositionPct = hasTp3 ? 75 : 50;
          if (config.partialExit) {
            const mult = isLong ? 1 : -1;
            const pnl = (activeTrade.tp1 - activeTrade.entryPrice) * (activeTrade.positionSize * closePct) * mult;
            capital += pnl;
            activeTrade.partialExitPnl += pnl;
          }
        } else if (stopTriggered) {
          // Realistic stop fill: in a fast market the fill can gap slightly past the stop level.
          const gapRisk = atr * 0.1;
          const actualFill = isLong ? activeTrade.stopLoss - gapRisk : activeTrade.stopLoss + gapRisk;
          activeTrade.stopFillSlippage = actualFill - activeTrade.stopLoss;
          const reason: SimExitReason = activeTrade.stopMovedToBreakeven ? 'tp1_then_be' : 'stop';
          activeTrade = closeTrade(activeTrade, actualFill, i, candle.time, reason, capital);
          capital = activeTrade.capitalAfter;
          trades.push(activeTrade);
          recordOutcome(activeTrade, dailyPnl, weeklyPnl, dateKey, weekKey);
          if (activeTrade.rMultiple > 0.1) { mlWinStreak++; mlLossStreak = 0; }
          else if (activeTrade.exitReason === 'stop') { mlLossStreak++; mlWinStreak = 0; }
          consecutiveLossCount = isLossForStreak(activeTrade) ? consecutiveLossCount + 1 : 0;
          if (consecutiveLossCount >= config.maxConsecutiveLosses) {
            cooldownUntilCandle = i + LOSS_STREAK_COOLDOWN_CANDLES;
            consecutiveLossCount = 0; // cooldown itself is the penalty; let the streak re-accumulate fresh after it lifts
          }
          activeTrade = null;
        } else if (expired) {
          activeTrade = closeTrade(activeTrade, currentPrice, i, candle.time, 'expired', capital);
          capital = activeTrade.capitalAfter;
          trades.push(activeTrade);
          recordOutcome(activeTrade, dailyPnl, weeklyPnl, dateKey, weekKey);
          if (activeTrade.rMultiple > 0.1) { mlWinStreak++; mlLossStreak = 0; }
          else if (activeTrade.exitReason === 'stop') { mlLossStreak++; mlWinStreak = 0; }
          consecutiveLossCount = isLossForStreak(activeTrade) ? consecutiveLossCount + 1 : 0;
          if (consecutiveLossCount >= config.maxConsecutiveLosses) {
            cooldownUntilCandle = i + LOSS_STREAK_COOLDOWN_CANDLES;
            consecutiveLossCount = 0; // cooldown itself is the penalty; let the streak re-accumulate fresh after it lifts
          }
          activeTrade = null;
        } else if (config.trailingStopMode !== 'fixed' && activeTrade.tp1Hit) {
          activeTrade.stopLoss = trailStop(activeTrade, candle, atr, config);
          activeTrade.stopWasTrailed = true;
        }
      }

      if (trades.length && trades[trades.length - 1].exitCandle === i && trades[trades.length - 1].status === 'closed') {
        const closedTrade = trades[trades.length - 1];
        if (capital > peakCapital) peakCapital = capital;
        const dd = ((peakCapital - capital) / peakCapital) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;
        maxDrawdownDollars = Math.max(maxDrawdownDollars, peakCapital - capital);
        equityCurve.push({ time: candle.time, value: capital, drawdown: dd, tradeId: closedTrade.id });
      }
    }

    if (tradingHalted) continue;

    // ── Look for a new signal only when fully flat ─────────────────────────
    if (!activeTrade) {
      const regime = classifyRegime(window);
      regimeBreakdown[regime].candles++;

      if (config.regimeFilter && !config.allowedRegimes.includes(regime)) {
        signalsFilteredByRegime++;
        regimeBreakdown[regime].tradesBlocked++;
        continue;
      }

      if (i < cooldownUntilCandle) { rejections.tradesRejectedByLossStreak++; continue; }
      if (window.length < 30) continue;

      const hour = new Date(candle.time * 1000).getUTCHours();
      if (config.sessionFilter && (hour < config.sessionStartHour || hour > config.sessionEndHour)) {
        rejections.tradesRejectedBySession++;
        continue;
      }

      const today = dateKey(candle.time);
      if ((dailyPnl.get(today) ?? 0) < -(capital * config.dailyLossLimitPct)) {
        rejections.tradesRejectedByDailyLimit++;
        continue;
      }
      const thisWeek = weekKey(candle.time);
      if ((weeklyPnl.get(thisWeek) ?? 0) < -(capital * config.weeklyLossLimitPct)) {
        rejections.tradesRejectedByWeeklyLimit++;
        continue;
      }

      const closes = window.map(c => c.close);
      const patterns = runAllPatterns(window);
      const rsi = calcRSI(closes);
      const macd = calcMACD(closes);
      const macdPrev = calcMACD(closes.slice(0, -3));
      const atr = calcATR(window);
      const volumeProfile = calcVolumeProfile(window);
      const bb = calcBollingerBands(closes);
      const ema20 = calcEMA(closes, 20);
      const ema50 = calcEMA(closes, 50);
      const lastEma20 = ema20[ema20.length - 1] ?? 0;
      const lastEma50 = ema50[ema50.length - 1] ?? 0;
      const trendDirection: 'up' | 'down' | 'sideways' =
        lastEma20 > lastEma50 * 1.001 ? 'up' : lastEma20 < lastEma50 * 0.999 ? 'down' : 'sideways';

      if (patterns.length) totalSignals++;
      if (atr < currentPrice * 0.001) { rejections.tradesRejectedByATR++; continue; }

      const signal = generateSimSignal(patterns, rsi, macd.histogram, volumeProfile.volumeRatio, volumeProfile.isHighVolume, atr, currentPrice, trendDirection);
      if (!signal) { rejections.tradesRejectedByPatternLogic++; continue; }
      if (signal.confidence < config.minConfidence) { rejections.tradesRejectedByMinConfidence++; continue; }
      if (config.allowedPatterns.length > 0 && !config.allowedPatterns.includes(signal.patternName)) { rejections.tradesRejectedByPatternChoice++; continue; }

      // HTF confirmation — empirically, 1h trades have real edge on their own while 5m/15m
      // don't; gating lower-timeframe signals on agreement with the HTF's own trend regime is
      // the structural fix, not just another pattern-level scoring tweak.
      if (config.htfConfirmation && htfCandles && htfPointer >= 30) {
        const htfRegime = classifyRegime(htfCandles.slice(0, htfPointer));
        const isBullishSignal = signal.type === 'bullish';
        const htfDisagrees = (isBullishSignal && (htfRegime === 'strong_downtrend' || htfRegime === 'weak_downtrend'))
          || (!isBullishSignal && (htfRegime === 'strong_uptrend' || htfRegime === 'weak_uptrend'));
        if (htfDisagrees) { rejections.tradesRejectedByHtfDisagreement++; continue; }
      }

      const indicators: Indicators = {
        rsi, macd: { ...macd, momentumBuilding: Math.abs(macd.histogram) > Math.abs(macdPrev.histogram) },
        atr, volume: { ratio: volumeProfile.volumeRatio }, bb,
      };
      const supportLevels = findSupportLevels(window, currentPrice);
      const resistanceLevels = findResistanceLevels(window, currentPrice);
      const scored = scoreSignal(signal.pattern, indicators, regime, currentPrice, supportLevels, resistanceLevels, trades, patternEdgeHints, config.interval, config.symbol);

      if (scored.reject) {
        if (scored.reasons.some(r => r.includes('Historically poor'))) rejections.tradesRejectedByScore++;
        else if (scored.reasons.some(r => r.includes('Low volatility') || r.includes('too quiet'))) rejections.tradesRejectedByATR++;
        else if (scored.reasons.some(r => r.includes('RSI'))) rejections.tradesRejectedByScore++;
        else if (scored.reasons.some(r => r.includes('Volume'))) rejections.tradesRejectedByVolume++;
        else rejections.tradesRejectedByRegime++;
        regimeBreakdown[regime].tradesBlocked++;
        continue;
      }
      if (scored.score < (config.scoreFloor ?? 50)) { rejections.tradesRejectedByScore++; regimeBreakdown[regime].tradesBlocked++; continue; }

      // ── R:R enforcement with resistance-aware target adjustment ──────────
      const isBullish = signal.type === 'bullish';
      let riskPerUnit = Math.abs(signal.entry - signal.stopLoss);
      const stopDistancePct = riskPerUnit / signal.entry;
      if (stopDistancePct < 0.002 || stopDistancePct > 0.03) { rejections.tradesRejectedByValidation++; continue; }

      let target = signal.target;
      const between = isBullish
        ? resistanceLevels.filter(r => r > signal.entry && r < target)
        : supportLevels.filter(s => s < signal.entry && s > target);
      if (between.length) {
        const blocker = isBullish ? Math.min(...between) : Math.max(...between);
        const distanceToBlocker = Math.abs(blocker - signal.entry);
        const distanceToTarget = Math.abs(target - signal.entry);
        if (distanceToBlocker < distanceToTarget * 0.5) {
          target = isBullish ? blocker * 0.998 : blocker * 1.002;
        }
      }
      const reward = Math.abs(target - signal.entry);
      const rr = riskPerUnit > 0 ? reward / riskPerUnit : 0;
      if (rr < config.minRR) { rejections.tradesRejectedByRR++; continue; }

      const estimatedSlippage = atr * 0.05;
      const riskAmountBase = capital * config.riskPerTrade;
      if (estimatedSlippage > riskAmountBase * 0.1) { rejections.tradesRejectedByValidation++; continue; }

      // ── Conviction-based sizing + capital protection adjustments ─────────
      const conviction = convictionFromScore(scored.score, config);
      let effectiveRiskPct = config.riskPerTrade;
      let capitalProtectionMode = false;
      let reducedSizing = false;
      const riskBasisCapital = capital >= config.startingCapital * 2 ? config.startingCapital : capital;

      if (capital < config.startingCapital * 0.7) { effectiveRiskPct = 0.0025; capitalProtectionMode = true; reducedSizing = true; }
      else if (capital < config.startingCapital * 0.8) { effectiveRiskPct = 0.005; capitalProtectionMode = true; reducedSizing = true; }
      else if (capital >= config.startingCapital * 1.5) { effectiveRiskPct = config.riskPerTrade * 1.2; }

      const regimeSizeMultiplier = config.regimeSizeMultipliers?.[regime] ?? 1.0;
      effectiveRiskPct *= regimeSizeMultiplier;

      let riskAmount = riskBasisCapital * effectiveRiskPct * conviction.multiplier;
      const maxRiskCap = conviction.level === 'very_high' ? 0.025 : conviction.level === 'high' ? 0.02 : 0.03;
      riskAmount = Math.min(riskAmount, capital * maxRiskCap);

      riskPerUnit = Math.abs(signal.entry - signal.stopLoss);
      if (riskPerUnit <= 0) { rejections.tradesRejectedByValidation++; continue; }
      const positionSize = riskAmount / riskPerUnit;
      let positionValue = positionSize * signal.entry;
      // Risk-based sizing on a tight stop against a high-priced asset (BTC at a 0.2-3% stop)
      // implies real notional far beyond 1x cash — this is a leveraged-perpetual sim, like the
      // live app's fixed-notional paper trading, not a cash-only spot account. Cap leverage
      // instead of capping at 1x capital, which was rejecting nearly every signal outright.
      if (positionValue > capital * MAX_LEVERAGE) { rejections.tradesRejectedByValidation++; continue; }

      const { tp1, tp2, tp3 } = calcTargets(signal.entry, riskPerUnit, isBullish, conviction.level);

      const entryDecision = determineEntryType(signal.patternName, config.entryTypeMode, signal.confidence, volumeProfile.volumeRatio);
      const limitPrice = entryDecision.type === 'market'
        ? signal.entry
        : entryDecision.type === 'limit'
          ? calcLimitPrice(signal.pattern, isBullish, signal.entry)
          : signal.entry * (1 + (isBullish ? 1 : -1) * config.entrySlippageBuffer);

      const intervalCandlesPerWait = config.maxWaitCandles;

      const htf = computeHtfProxy(window);
      const volumeProfilePrev = calcVolumeProfile(window.slice(0, -3));
      const nearestSupport = supportLevels[0];
      const nearestResistance = resistanceLevels[0];

      activeTrade = {
        id: crypto.randomUUID(),
        symbol: config.symbol,
        direction: isBullish ? 'long' : 'short',
        patternName: signal.patternName,
        confidence: signal.confidence,
        status: 'waiting_entry',

        entryType: entryDecision.type,
        limitPrice,
        signalCandle: i,
        entryExpiryCandle: i + intervalCandlesPerWait,
        waitedCandles: 0,
        entrySlippage: 0,

        entryCandle: i,
        entryTime: candle.time,
        entryPrice: signal.entry,

        stopLoss: signal.stopLoss,
        tp1, tp2, tp3,

        positionSize, capitalAtRisk: riskAmount, positionValue,

        exitCandle: null, exitTime: null, exitPrice: null, exitReason: 'end_of_data',

        tp1Hit: false, tp1HitCandle: null, tp2Hit: false, tp2HitCandle: null, tp3Hit: false, tp3HitCandle: null,
        stopMovedToBreakeven: false, remainingPositionPct: 100, partialExitPnl: 0,

        signalScore: scored.score, scoreReasons: scored.reasons,
        convictionLevel: conviction.level, convictionMultiplier: conviction.multiplier,

        pyramidEntry: null, pyramidSize: null, blendedEntry: null,

        regime, sessionHour: hour,
        capitalProtectionMode, reducedSizing,
        stopFillSlippage: 0, stopWasTrailed: false,

        pnlDollars: 0, pnlPercent: 0, accountPnlPercent: 0, rMultiple: 0,
        capitalBefore: capital, capitalAfter: capital,
        rsiAtEntry: rsi, macdAtEntry: macd.histogram > 0 ? 'bullish' : 'bearish',
        volumeRatioAtEntry: volumeProfile.volumeRatio, atrAtEntry: atr, trendAtEntry: trendDirection,

        htfBias: htf.bias, htfStrength: htf.strength, htfEmaSeparation: htf.separation, htfStructure: htf.structure,
        bbLowerAtEntry: bb.lower, bbUpperAtEntry: bb.upper,
        ema20VsEma50AtEntry: lastEma50 !== 0 ? ((lastEma20 - lastEma50) / lastEma50) * 100 : 0,
        priceVsEma20AtEntry: lastEma20 !== 0 ? ((currentPrice - lastEma20) / lastEma20) * 100 : 0,
        distToSupportPct: nearestSupport ? ((currentPrice - nearestSupport) / currentPrice) * 100 : 0,
        distToResistancePct: nearestResistance ? ((nearestResistance - currentPrice) / currentPrice) * 100 : 0,
        macdHistPrevAtEntry: macdPrev.histogram,
        volumeRatioPrevAtEntry: volumeProfilePrev.volumeRatio,
        winStreakBeforeEntry: mlWinStreak, lossStreakBeforeEntry: mlLossStreak,
        drawdownPctAtEntry: peakCapital > 0 ? ((peakCapital - capital) / peakCapital) * 100 : 0,
      };
      regimeBreakdown[regime].tradesAllowed++;
    }
  }

  if (activeTrade) {
    const lastCandle = candles[candles.length - 1];
    if (activeTrade.status === 'waiting_entry') {
      activeTrade.status = 'closed';
      activeTrade.exitReason = 'entry_expired';
      activeTrade.exitCandle = candles.length - 1;
      activeTrade.exitTime = lastCandle.time;
      trades.push(activeTrade);
    } else {
      const closed = closeTrade(activeTrade, lastCandle.close, candles.length - 1, lastCandle.time, 'end_of_data', capital);
      capital = closed.capitalAfter;
      trades.push(closed);
      if (capital > peakCapital) peakCapital = capital;
      const dd = ((peakCapital - capital) / peakCapital) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
      maxDrawdownDollars = Math.max(maxDrawdownDollars, peakCapital - capital);
      equityCurve.push({ time: lastCandle.time, value: capital, drawdown: dd, tradeId: closed.id });
    }
  }

  onProgress(100, 'Computing statistics...');
  return buildSimResult(config, trades, capital, maxDrawdown, maxDrawdownDollars, equityCurve, totalSignals, signalsFilteredByRegime, candles.length, rejections, regimeBreakdown);
}

function trailStop(trade: SimTrade, candle: Candle, atr: number, config: ResolvedSimConfig): number {
  if (config.trailingStopMode === 'fixed') return trade.stopLoss;
  const mult = config.trailingStopMode === 'atr1.5' ? 1.5 : 1.0;
  const isLong = trade.direction === 'long';
  const newTrail = isLong ? candle.close - atr * mult : candle.close + atr * mult;
  if (isLong) return Math.max(trade.stopLoss, newTrail); // ratchet up, never down
  return Math.min(trade.stopLoss, newTrail); // ratchet down, never up (for shorts)
}

// A "real" loss for streak-cooldown purposes — stopped out without ever banking TP1.
// A breakeven-after-TP1 outcome is not a loss (no R was actually lost) and resets the streak.
function isLossForStreak(trade: SimTrade): boolean {
  return trade.exitReason === 'stop' && !trade.tp1Hit;
}

// Updates the daily/weekly P&L ledgers after a trade closes (used to enforce the daily/weekly
// loss-limit guardrails on subsequent entries).
function recordOutcome(
  trade: SimTrade,
  dailyPnl: Map<string, number>,
  weeklyPnl: Map<string, number>,
  dateKey: (t: number) => string,
  weekKey: (t: number) => string,
): void {
  const day = dateKey(trade.exitTime ?? trade.entryTime);
  const week = weekKey(trade.exitTime ?? trade.entryTime);
  dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + trade.pnlDollars);
  weeklyPnl.set(week, (weeklyPnl.get(week) ?? 0) + trade.pnlDollars);
}

function closeTrade(
  trade: SimTrade,
  exitPrice: number,
  exitCandle: number,
  exitTime: number,
  reason: SimExitReason,
  capitalBefore: number,
): SimTrade {
  const mult = trade.direction === 'long' ? 1 : -1;
  const closedPct = trade.remainingPositionPct / 100;
  const finalTranchePnl = (exitPrice - trade.entryPrice) * (trade.positionSize * closedPct) * mult;
  // capitalBefore already reflects any earlier TP1/TP2 partial exits (those added straight to
  // the running capital total when they happened), so capitalAfter must only add THIS tranche
  // — but the trade's own recorded pnl/rMultiple should reflect the FULL realized result
  // (partial + final), not just the last slice, or a profitable partial-then-breakeven trade
  // gets reported and trained on as a ~0 outcome.
  const pnlDollars = finalTranchePnl + trade.partialExitPnl;

  const pnlPercent = trade.positionValue > 0 ? (pnlDollars / trade.positionValue) * 100 : 0;
  const accountPnlPercent = capitalBefore > 0 ? (pnlDollars / capitalBefore) * 100 : 0;
  const rMultiple = trade.capitalAtRisk > 0 ? pnlDollars / trade.capitalAtRisk : 0;
  const capitalAfter = capitalBefore + finalTranchePnl;

  return {
    ...trade,
    status: 'closed',
    exitCandle, exitTime, exitPrice, exitReason: reason,
    pnlDollars, pnlPercent, accountPnlPercent, rMultiple,
    capitalBefore, capitalAfter,
  };
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function buildSimResult(
  config: ResolvedSimConfig,
  trades: SimTrade[],
  finalCapital: number,
  maxDrawdown: number,
  maxDrawdownDollars: number,
  equityCurve: EquityPoint[],
  totalSignals: number,
  signalsFilteredByRegime: number,
  totalCandles: number,
  rejections: RejectionStats,
  regimeBreakdown: Record<MarketRegime, RegimeStats>,
): SimResult {
  // Re-derive the consecutive-loss-driven cooldown counter after the fact isn't possible from
  // trades alone with full fidelity, so consecutive win/loss streaks below are computed purely
  // from the closed trade sequence (the authoritative record), independent of the in-loop streak
  // tracker used to gate new entries during the run.
  const filledTrades = trades.filter(t => t.status === 'closed' && t.exitReason !== 'entry_expired');
  const wins = filledTrades.filter(t => t.rMultiple > 0.1);
  const breakevens = filledTrades.filter(t => t.exitReason === 'tp1_then_be');
  const losses = filledTrades.filter(t => t.exitReason === 'stop' && t.rMultiple <= 0.1);
  const expired = filledTrades.filter(t => t.exitReason === 'expired');
  const decided = filledTrades.filter(t => t.exitReason !== 'end_of_data');

  const grossWins = filledTrades.filter(t => t.pnlDollars > 0).reduce((a, t) => a + t.pnlDollars, 0);
  const grossLosses = Math.abs(filledTrades.filter(t => t.pnlDollars < 0).reduce((a, t) => a + t.pnlDollars, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0);

  const winPcts = wins.map(t => t.accountPnlPercent);
  const lossPcts = losses.map(t => t.accountPnlPercent);

  const returns = filledTrades.map(t => t.accountPnlPercent);
  const meanReturn = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const sd = stdDev(returns);
  const sharpeRatio = sd > 0 ? (meanReturn / sd) * Math.sqrt(252) : 0;

  const tradeLengths = filledTrades.map(t => (t.exitCandle ?? t.entryCandle) - t.entryCandle);
  const winLengths = wins.map(t => (t.exitCandle ?? t.entryCandle) - t.entryCandle);
  const lossLengths = losses.map(t => (t.exitCandle ?? t.entryCandle) - t.entryCandle);
  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  const patternStats: Record<string, PatternStat> = {};
  for (const t of filledTrades) {
    if (!patternStats[t.patternName]) {
      patternStats[t.patternName] = { signals: 0, trades: 0, wins: 0, losses: 0, winRate: 0, avgRMultiple: 0, totalPnl: 0, best: 0, worst: 0 };
    }
    const ps = patternStats[t.patternName];
    ps.trades++;
    if (t.rMultiple > 0.1) ps.wins++; else if (t.exitReason === 'stop') ps.losses++;
    ps.totalPnl += t.pnlDollars;
    ps.best = Math.max(ps.best, t.pnlDollars);
    ps.worst = Math.min(ps.worst, t.pnlDollars);
  }
  for (const name of Object.keys(patternStats)) {
    const ps = patternStats[name];
    ps.winRate = ps.trades > 0 ? (ps.wins / ps.trades) * 100 : 0;
    const patternTrades = filledTrades.filter(t => t.patternName === name);
    ps.avgRMultiple = avg(patternTrades.map(t => t.rMultiple));
  }

  const hourlyStats: Record<number, HourStat> = {};
  for (const t of filledTrades) {
    const hour = new Date(t.entryTime * 1000).getUTCHours();
    if (!hourlyStats[hour]) hourlyStats[hour] = { trades: 0, wins: 0, pnl: 0 };
    hourlyStats[hour].trades++;
    if (t.rMultiple > 0.1) hourlyStats[hour].wins++;
    hourlyStats[hour].pnl += t.pnlDollars;
  }

  for (const regime of ALL_REGIMES) {
    const regimeTrades = filledTrades.filter(t => t.regime === regime);
    regimeBreakdown[regime].winRate = regimeTrades.length > 0
      ? (regimeTrades.filter(t => t.rMultiple > 0.1).length / regimeTrades.length) * 100
      : 0;
  }

  // Consecutive win/loss streaks (max run length) from the closed-trade sequence
  let curWinStreak = 0, maxWinStreak = 0, curLossStreak = 0, maxLossStreak = 0;
  for (const t of filledTrades) {
    if (t.rMultiple > 0.1) { curWinStreak++; maxWinStreak = Math.max(maxWinStreak, curWinStreak); curLossStreak = 0; }
    else if (t.exitReason === 'stop') { curLossStreak++; maxLossStreak = Math.max(maxLossStreak, curLossStreak); curWinStreak = 0; }
  }

  const daysTraded = new Set(filledTrades.map(t => new Date(t.entryTime * 1000).toISOString().slice(0, 10))).size;
  const winRatio = decided.length > 0 ? wins.length / decided.length : 0;
  const lossRatio = 1 - winRatio;
  const avgWinR = avg(wins.map(t => t.rMultiple));
  const avgLossR = avg(losses.map(t => Math.abs(t.rMultiple)));
  const expectancy = winRatio * avgWinR - lossRatio * avgLossR;
  const recoveryFactor = maxDrawdownDollars > 0 ? (finalCapital - config.startingCapital) / maxDrawdownDollars : 0;

  const bestTrade = filledTrades.reduce((b, t) => (!b || t.pnlDollars > b.pnlDollars ? t : b), null as SimTrade | null);
  const worstTrade = filledTrades.reduce((w, t) => (!w || t.pnlDollars < w.pnlDollars ? t : w), null as SimTrade | null);

  const highConvictionTrades = filledTrades.filter(t => t.convictionLevel === 'high' || t.convictionLevel === 'very_high').length;
  const lowConvictionTrades = filledTrades.filter(t => t.convictionLevel === 'low').length;
  const pyramidedTrades = filledTrades.filter(t => t.pyramidEntry !== null).length;

  return {
    config,
    startingCapital: config.startingCapital,
    finalCapital,
    totalReturn: ((finalCapital - config.startingCapital) / config.startingCapital) * 100,
    totalReturnDollars: finalCapital - config.startingCapital,

    totalSignals,
    totalTrades: filledTrades.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: breakevens.length,
    expired: expired.length,

    winRate: decided.length > 0 ? (wins.length / decided.length) * 100 : 0,

    avgWinPercent: avg(winPcts),
    avgLossPercent: avg(lossPcts),
    avgRMultiple: avg(filledTrades.map(t => t.rMultiple)),
    profitFactor,

    maxDrawdown,
    maxDrawdownDollars,
    sharpeRatio,

    avgTradeLength: avg(tradeLengths),
    avgWinLength: avg(winLengths),
    avgLossLength: avg(lossLengths),

    patternStats,
    hourlyStats,

    equityCurve,
    trades,

    totalCandles,
    signalsFilteredByRegime,

    rejections,
    daysTraded,
    daysPaused: 0,
    highConvictionTrades,
    lowConvictionTrades,
    pyramidedTrades,
    regimeBreakdown,
    consecutiveWins: maxWinStreak,
    consecutiveLosses: maxLossStreak,
    expectancy,
    recoveryFactor,
    avgHoldingTime: avg(tradeLengths),
    bestTrade,
    worstTrade,
  };
}

export function formatSimResultSummary(result: SimResult): string {
  const c = result.config;
  const lines = [
    '═══════════════════════════════════════════',
    'TRADEFLOW SIMULATION RESULTS',
    '═══════════════════════════════════════════',
    `Symbol:         ${c.symbol} ${c.interval}`,
    `Period:         ${c.startDate} → ${c.endDate}`,
    `Total Candles:  ${result.totalCandles.toLocaleString()}`,
    '',
    'ACCOUNT',
    `Starting:       $${result.startingCapital.toLocaleString()}`,
    `Final:          $${result.finalCapital.toFixed(2)}`,
    `Return:         ${result.totalReturn >= 0 ? '+' : ''}${result.totalReturn.toFixed(2)}%`,
    `Max Drawdown:   -${result.maxDrawdown.toFixed(2)}%`,
    `Sharpe:         ${result.sharpeRatio.toFixed(2)}`,
    `Expectancy:     ${result.expectancy >= 0 ? '+' : ''}${result.expectancy.toFixed(2)}R per trade`,
    '',
    'TRADES',
    `Signals:        ${result.totalSignals}`,
    `Taken:          ${result.totalTrades}   (${result.totalSignals > 0 ? ((result.totalTrades / result.totalSignals) * 100).toFixed(1) : '0'}% of signals passed filters)`,
    `Wins:           ${result.wins}   (${result.winRate.toFixed(1)}%)`,
    `Losses:         ${result.losses}`,
    `Breakeven:      ${result.breakevens}`,
    `Expired:        ${result.expired}`,
    `High conviction:${result.highConvictionTrades}`,
    '═══════════════════════════════════════════',
  ];
  return lines.join('\n');
}
