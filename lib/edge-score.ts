/**
 * TradeFlow V3 — Edge Score Engine (Phase 8)
 *
 * REPLACES CONFIDENCE. Confidence is misleading.
 *
 * Edge Score Components:
 *   Historical Similarity  40%
 *   Regime Alignment       20%
 *   Order Flow             15%
 *   Volume                 10%
 *   Pattern Quality        10%
 *   Momentum                5%
 *
 * Only trade when Expected Value > 0
 */

import { getCurrentWeights, type DynamicWeights } from './dynamic-weights';
import { getSimilarSetupStats, type SimilarSetupStats } from './rag-memory';
import { getEdge } from './edge-database';
import { generateFeatureVector, detectSession } from './signal-memory';
import type { MarketRegime, TradingSession } from './db';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EdgeScoreComponents {
  historicalSimilarity: number;  // 0-100
  regimeAlignment: number;       // 0-100
  orderFlow: number;             // 0-100
  volume: number;                // 0-100
  patternQuality: number;        // 0-100
  momentum: number;              // 0-100
}

export interface EdgeScoreResult {
  patternScore: number;          // 0-100
  tradeScore: number;            // 0-100
  historicalEdge: number;        // 0-100
  finalEdgeScore: number;        // 0-100

  components: EdgeScoreComponents;

  expectedWinRate: number;       // 0-100
  expectedRR: number;
  expectedValue: number;         // (winRate * avgWin) - (lossRate * avgLoss)

  tier: 'A+' | 'A' | 'B' | 'C';
  similarSetups: SimilarSetupStats;
  weightsUsed: DynamicWeights;
}

export interface EdgeScoreContext {
  symbol: string;
  timeframe: string;
  pattern: string;
  patternConfidence: number;
  direction: 'long' | 'short';
  regime: MarketRegime;
  rsi: number;
  macd: number;
  macdHistogram: number;
  atr: number;
  atrPercent: number;
  volumeRatio: number;
  riskReward: number;
  trendDirection: 'up' | 'down' | 'sideways';
  // Order flow (optional)
  openInterest?: number | null;
  fundingRate?: number | null;
  cvd?: number | null;
  // Multi-TF (optional)
  htfBias?: 'bullish' | 'bearish' | 'neutral' | null;
}

// ─── Edge Score Calculation ───────────────────────────────────────────────────

/**
 * Calculate the full Edge Score for a signal.
 * This is the central intelligence function of the platform.
 */
export async function calculateEdgeScore(
  ctx: EdgeScoreContext,
): Promise<EdgeScoreResult> {
  const weights = await getCurrentWeights();
  const session = detectSession(Date.now());

  // ── 1. Historical Similarity (RAG lookup) ──────────────────────
  const featureVector = generateFeatureVector({
    pattern: ctx.pattern,
    direction: ctx.direction,
    regime: ctx.regime,
    session,
    rsi: ctx.rsi,
    macd: ctx.macd,
    atr: ctx.atrPercent,
    volumeRatio: ctx.volumeRatio,
    openInterest: ctx.openInterest,
    fundingRate: ctx.fundingRate,
    cvd: ctx.cvd,
  });

  const similarSetups = await getSimilarSetupStats(featureVector, 100);

  // Historical similarity score based on match count and win rate
  let historicalSimilarity = 50; // neutral default
  if (similarSetups.matchCount >= 5) {
    historicalSimilarity = Math.min(100, Math.max(0,
      similarSetups.historicalWinRate * 0.6 +
      (similarSetups.matchCount >= 50 ? 20 : similarSetups.matchCount * 0.4) +
      (similarSetups.profitFactor > 1.5 ? 15 : similarSetups.profitFactor > 1 ? 5 : -10)
    ));
  }

  // ── 2. Regime Alignment ────────────────────────────────────────
  let regimeAlignment = 50;
  const isBullish = ctx.direction === 'long';

  if (isBullish) {
    if (ctx.regime === 'strong_uptrend') regimeAlignment = 95;
    else if (ctx.regime === 'weak_uptrend') regimeAlignment = 75;
    else if (ctx.regime === 'ranging') regimeAlignment = 50;
    else if (ctx.regime === 'weak_downtrend') regimeAlignment = 25;
    else if (ctx.regime === 'strong_downtrend') regimeAlignment = 10;
    else regimeAlignment = 30; // low_volatility
  } else {
    if (ctx.regime === 'strong_downtrend') regimeAlignment = 95;
    else if (ctx.regime === 'weak_downtrend') regimeAlignment = 75;
    else if (ctx.regime === 'ranging') regimeAlignment = 50;
    else if (ctx.regime === 'weak_uptrend') regimeAlignment = 25;
    else if (ctx.regime === 'strong_uptrend') regimeAlignment = 10;
    else regimeAlignment = 30;
  }

  // Check edge database for regime-specific performance
  const edgeRecord = await getEdge(ctx.pattern, ctx.symbol, ctx.timeframe, session, ctx.regime);
  if (edgeRecord && edgeRecord.totalTrades >= 10) {
    // Blend historical edge data with regime alignment
    regimeAlignment = Math.round(regimeAlignment * 0.5 + edgeRecord.winRate * 0.5);
  }

  // HTF bias bonus/penalty
  if (ctx.htfBias) {
    if ((isBullish && ctx.htfBias === 'bullish') || (!isBullish && ctx.htfBias === 'bearish')) {
      regimeAlignment = Math.min(100, regimeAlignment + 15);
    } else if ((isBullish && ctx.htfBias === 'bearish') || (!isBullish && ctx.htfBias === 'bullish')) {
      regimeAlignment = Math.max(0, regimeAlignment - 20);
    }
  }

  // ── 3. Order Flow ──────────────────────────────────────────────
  let orderFlow = 50; // neutral default when no data
  if (ctx.openInterest !== null && ctx.openInterest !== undefined) {
    // Price Up + OI Up = +15 (new positions)
    // Price Up + OI Down = -20 (weak rally / short squeeze)
    const priceDirection = isBullish ? 1 : -1;
    const oiDirection = ctx.openInterest > 0 ? 1 : -1;
    orderFlow += (priceDirection === oiDirection) ? 15 : -20;
  }
  if (ctx.fundingRate !== null && ctx.fundingRate !== undefined) {
    const extreme = Math.abs(ctx.fundingRate) > 0.01;
    if (extreme) {
      // Extreme positive funding: overleveraged longs → bearish
      // Extreme negative funding: overleveraged shorts → bullish
      if (ctx.fundingRate > 0.01 && !isBullish) orderFlow += 10;
      else if (ctx.fundingRate < -0.01 && isBullish) orderFlow += 10;
      else orderFlow -= 10;
    }
  }
  if (ctx.cvd !== null && ctx.cvd !== undefined) {
    if ((isBullish && ctx.cvd > 0) || (!isBullish && ctx.cvd < 0)) {
      orderFlow += 15; // CVD confirming direction
    }
  }
  orderFlow = Math.max(0, Math.min(100, orderFlow));

  // ── 4. Volume ──────────────────────────────────────────────────
  let volumeScore = 50;
  if (ctx.volumeRatio >= 2.5) volumeScore = 95;
  else if (ctx.volumeRatio >= 2.0) volumeScore = 85;
  else if (ctx.volumeRatio >= 1.5) volumeScore = 70;
  else if (ctx.volumeRatio >= 1.0) volumeScore = 55;
  else if (ctx.volumeRatio >= 0.7) volumeScore = 35;
  else volumeScore = 15;

  // ── 5. Pattern Quality ─────────────────────────────────────────
  let patternQuality = Math.min(100, Math.max(0, ctx.patternConfidence));

  // Boost for counter-trend patterns with extreme confidence
  if (ctx.trendDirection === 'down' && isBullish && ctx.patternConfidence >= 85) {
    patternQuality += 5;
  }

  // ── 6. Momentum ────────────────────────────────────────────────
  let momentum = 50;
  if (isBullish) {
    if (ctx.macdHistogram > 0) momentum += 15;
    if (ctx.rsi >= 40 && ctx.rsi <= 65) momentum += 15; // sweet spot
    if (ctx.rsi > 70) momentum -= 20; // overbought
    if (ctx.rsi < 30) momentum += 10; // oversold recovery potential
  } else {
    if (ctx.macdHistogram < 0) momentum += 15;
    if (ctx.rsi >= 35 && ctx.rsi <= 60) momentum += 15;
    if (ctx.rsi < 30) momentum -= 20; // oversold
    if (ctx.rsi > 70) momentum += 10; // overbought reversal
  }
  momentum = Math.max(0, Math.min(100, momentum));

  // ── Composite Edge Score ───────────────────────────────────────
  // Use dynamic weights (normalized to percentages)
  const totalWeight =
    weights.historicalSimilarity +
    weights.regime +
    weights.openInterest + // proxied to order flow
    weights.volume +
    weights.patternQuality +
    weights.momentum;

  const components: EdgeScoreComponents = {
    historicalSimilarity,
    regimeAlignment,
    orderFlow,
    volume: volumeScore,
    patternQuality,
    momentum,
  };

  const rawEdge = totalWeight > 0 ? (
    (historicalSimilarity * weights.historicalSimilarity +
     regimeAlignment * weights.regime +
     orderFlow * weights.openInterest +
     volumeScore * weights.volume +
     patternQuality * weights.patternQuality +
     momentum * weights.momentum
    ) / totalWeight
  ) : 50;

  const finalEdgeScore = Math.round(Math.max(0, Math.min(100, rawEdge)));

  // ── Pattern Score & Trade Score (sub-scores) ───────────────────
  const patternScore = Math.round(patternQuality);
  const tradeScore = Math.round((regimeAlignment + volumeScore + momentum) / 3);
  const historicalEdge = Math.round(historicalSimilarity);

  // ── Expected Value ─────────────────────────────────────────────
  const expectedWinRate = similarSetups.matchCount >= 10
    ? similarSetups.historicalWinRate
    : (finalEdgeScore * 0.8 + 10); // rough approximation
  const expectedRR = similarSetups.matchCount >= 10
    ? similarSetups.avgRR
    : ctx.riskReward;
  const winProb = expectedWinRate / 100;
  const expectedValue = winProb * expectedRR - (1 - winProb) * 1.0;

  // ── Tier Classification ────────────────────────────────────────
  let tier: 'A+' | 'A' | 'B' | 'C' = 'C';
  if (finalEdgeScore >= 90) tier = 'A+';
  else if (finalEdgeScore >= 85) tier = 'A';
  else if (finalEdgeScore >= 75) tier = 'B';

  return {
    patternScore,
    tradeScore,
    historicalEdge,
    finalEdgeScore,
    components,
    expectedWinRate,
    expectedRR,
    expectedValue,
    tier,
    similarSetups,
    weightsUsed: weights,
  };
}

/**
 * Quick edge check — returns just the edge score and tier.
 * Used for filtering without the full calculation overhead.
 */
export function quickEdgeEstimate(
  patternConfidence: number,
  regime: MarketRegime,
  direction: 'long' | 'short',
  volumeRatio: number,
  rsi: number,
): { estimatedEdge: number; tier: 'A+' | 'A' | 'B' | 'C' } {
  let score = patternConfidence * 0.3;
  const isBullish = direction === 'long';

  // Regime
  if ((isBullish && (regime === 'strong_uptrend' || regime === 'weak_uptrend')) ||
      (!isBullish && (regime === 'strong_downtrend' || regime === 'weak_downtrend'))) {
    score += 25;
  } else if (regime === 'ranging') {
    score += 10;
  }

  // Volume
  if (volumeRatio >= 1.5) score += 15;
  else if (volumeRatio >= 1.0) score += 8;

  // RSI
  if ((isBullish && rsi >= 40 && rsi <= 60) || (!isBullish && rsi >= 40 && rsi <= 60)) {
    score += 10;
  }

  const estimatedEdge = Math.round(Math.max(0, Math.min(100, score)));
  let tier: 'A+' | 'A' | 'B' | 'C' = 'C';
  if (estimatedEdge >= 90) tier = 'A+';
  else if (estimatedEdge >= 85) tier = 'A';
  else if (estimatedEdge >= 75) tier = 'B';

  return { estimatedEdge, tier };
}
