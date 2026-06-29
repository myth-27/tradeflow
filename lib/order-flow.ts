/**
 * TradeFlow V3 — Order Flow Intelligence (Phase 9)
 *
 * Open Interest, Funding Rate, CVD, Liquidation Data.
 * Order flow contributes MORE than RSI.
 *
 * Uses Binance Futures API (free, no key required).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrderFlowData {
  openInterest: number;           // total OI in contracts
  openInterestChange: number;     // % change from previous period
  fundingRate: number;            // current funding rate
  fundingRateAnnualized: number;  // annualized for context
  cvd: number;                    // cumulative volume delta (approximated)
  estimatedLiquidations: number;  // rough estimate from price action
  timestamp: number;
}

export interface OrderFlowScore {
  score: number;                  // -50 to +50 contribution
  signals: OrderFlowSignal[];
}

export interface OrderFlowSignal {
  indicator: string;
  condition: string;
  contribution: number;
  interpretation: string;
}

// ─── Fetch Order Flow Data ────────────────────────────────────────────────────

/**
 * Fetch order flow data from Binance Futures API.
 * Called via our API proxy route to avoid CORS.
 */
export async function fetchOrderFlow(symbol: string): Promise<OrderFlowData | null> {
  try {
    const res = await fetch(`/api/order-flow?symbol=${symbol.toUpperCase()}`);
    if (!res.ok) return null;
    return await res.json() as OrderFlowData;
  } catch {
    return null;
  }
}

/**
 * Score order flow data for a given direction.
 * Returns a score from -50 to +50 that's added to the edge score.
 */
export function scoreOrderFlow(
  data: OrderFlowData | null,
  direction: 'long' | 'short',
): OrderFlowScore {
  if (!data) {
    return { score: 0, signals: [] };
  }

  const signals: OrderFlowSignal[] = [];
  let totalScore = 0;
  const isBullish = direction === 'long';

  // ── Open Interest Analysis ────────────────────────────────────
  if (data.openInterestChange !== 0) {
    const oiRising = data.openInterestChange > 0.02;  // >2% change
    const oiFalling = data.openInterestChange < -0.02;

    if (oiRising && isBullish) {
      totalScore += 15;
      signals.push({
        indicator: 'Open Interest',
        condition: `+${(data.openInterestChange * 100).toFixed(1)}% (rising)`,
        contribution: 15,
        interpretation: 'New longs entering — confirms bullish momentum',
      });
    } else if (oiRising && !isBullish) {
      totalScore += 10;
      signals.push({
        indicator: 'Open Interest',
        condition: `+${(data.openInterestChange * 100).toFixed(1)}% (rising)`,
        contribution: 10,
        interpretation: 'New positions opening — potential short squeeze fuel',
      });
    } else if (oiFalling && isBullish) {
      totalScore -= 20;
      signals.push({
        indicator: 'Open Interest',
        condition: `${(data.openInterestChange * 100).toFixed(1)}% (falling)`,
        contribution: -20,
        interpretation: 'Positions closing — weak rally, likely short squeeze',
      });
    } else if (oiFalling && !isBullish) {
      totalScore -= 15;
      signals.push({
        indicator: 'Open Interest',
        condition: `${(data.openInterestChange * 100).toFixed(1)}% (falling)`,
        contribution: -15,
        interpretation: 'Positions unwinding — selling may be exhausting',
      });
    }
  }

  // ── Funding Rate Analysis ─────────────────────────────────────
  const extremePositive = data.fundingRate > 0.01;    // >1% = extreme
  const extremeNegative = data.fundingRate < -0.01;
  const highPositive = data.fundingRate > 0.005;
  const highNegative = data.fundingRate < -0.005;

  if (extremePositive) {
    if (!isBullish) {
      totalScore += 10;
      signals.push({
        indicator: 'Funding Rate',
        condition: `${(data.fundingRate * 100).toFixed(3)}% (extreme +)`,
        contribution: 10,
        interpretation: 'Overleveraged longs paying shorts — mean reversion likely',
      });
    } else {
      totalScore -= 10;
      signals.push({
        indicator: 'Funding Rate',
        condition: `${(data.fundingRate * 100).toFixed(3)}% (extreme +)`,
        contribution: -10,
        interpretation: 'Crowded long — risky to add more longs here',
      });
    }
  } else if (extremeNegative) {
    if (isBullish) {
      totalScore += 10;
      signals.push({
        indicator: 'Funding Rate',
        condition: `${(data.fundingRate * 100).toFixed(3)}% (extreme -)`,
        contribution: 10,
        interpretation: 'Overleveraged shorts paying longs — squeeze potential',
      });
    } else {
      totalScore -= 10;
      signals.push({
        indicator: 'Funding Rate',
        condition: `${(data.fundingRate * 100).toFixed(3)}% (extreme -)`,
        contribution: -10,
        interpretation: 'Crowded short — risky to add more shorts here',
      });
    }
  } else if (highPositive && !isBullish) {
    totalScore += 5;
    signals.push({
      indicator: 'Funding Rate',
      condition: `${(data.fundingRate * 100).toFixed(3)}% (elevated +)`,
      contribution: 5,
      interpretation: 'Longs paying premium — slight bearish edge',
    });
  } else if (highNegative && isBullish) {
    totalScore += 5;
    signals.push({
      indicator: 'Funding Rate',
      condition: `${(data.fundingRate * 100).toFixed(3)}% (elevated -)`,
      contribution: 5,
      interpretation: 'Shorts paying premium — slight bullish edge',
    });
  }

  // ── CVD Analysis ──────────────────────────────────────────────
  if (data.cvd !== 0) {
    const bullishCVD = data.cvd > 0;
    const strongCVD = Math.abs(data.cvd) > 0.5;

    if (strongCVD) {
      if ((bullishCVD && isBullish) || (!bullishCVD && !isBullish)) {
        totalScore += 15;
        signals.push({
          indicator: 'CVD',
          condition: `${data.cvd > 0 ? 'Bullish' : 'Bearish'} (strong)`,
          contribution: 15,
          interpretation: `Active ${data.cvd > 0 ? 'buying' : 'selling'} pressure confirms ${direction}`,
        });
      } else {
        totalScore -= 10;
        signals.push({
          indicator: 'CVD',
          condition: `${data.cvd > 0 ? 'Bullish' : 'Bearish'} divergence`,
          contribution: -10,
          interpretation: `Volume delta opposes ${direction} direction — potential divergence`,
        });
      }
    }
  }

  // ── Liquidation Analysis ──────────────────────────────────────
  if (data.estimatedLiquidations > 0) {
    // High liquidations create volatility opportunities
    if (data.estimatedLiquidations > 1000000) { // >$1M estimated
      totalScore += 5;
      signals.push({
        indicator: 'Liquidations',
        condition: `$${(data.estimatedLiquidations / 1e6).toFixed(1)}M estimated`,
        contribution: 5,
        interpretation: 'Significant liquidations — volatility and momentum opportunity',
      });
    }
  }

  return {
    score: Math.max(-50, Math.min(50, totalScore)),
    signals,
  };
}

/**
 * Approximate CVD from candle data when Futures API is unavailable.
 * Uses a simplified volume-price analysis.
 */
export function approximateCVD(
  candles: { close: number; open: number; volume: number }[],
  lookback = 20,
): number {
  const recent = candles.slice(-lookback);
  let cvd = 0;
  for (const c of recent) {
    const isBullish = c.close > c.open;
    const range = Math.abs(c.close - c.open);
    const totalRange = Math.max(0.0001, range); // avoid division by zero
    // Approximate buy vs sell volume based on candle direction and range
    const buyRatio = isBullish ? 0.6 + (range / totalRange) * 0.2 : 0.4 - (range / totalRange) * 0.2;
    const buyVolume = c.volume * Math.max(0, Math.min(1, buyRatio));
    const sellVolume = c.volume - buyVolume;
    cvd += buyVolume - sellVolume;
  }
  // Normalize
  const avgVol = recent.reduce((a, c) => a + c.volume, 0) / recent.length;
  return avgVol > 0 ? cvd / (avgVol * recent.length) : 0;
}
