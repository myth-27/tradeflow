/**
 * TradeFlow — Market Sentiment Intelligence (Phase 15)
 *
 * Real-time Fear & Greed + funding rate + open interest, combined into a single sentiment
 * score that can modify signal confidence.
 *
 * News/GPT classification was deliberately left out: CryptoPanic's RSS feed has no
 * Access-Control-Allow-Origin header (verified — a browser fetch to it always fails with a
 * CORS error, silently returning no headlines), and routing an OpenAI key through a client-side
 * fetch would expose it in the browser. This app keeps OPENAI_API_KEY server-only (see
 * lib/openai.ts + app/api/analyze/route.ts) — if news sentiment is wanted later, it needs a
 * server API route, not a direct browser call.
 */

import { getDB, type SentimentRecord } from './db';

export interface SentimentData {
  timestamp: number;

  fearGreedScore: number;
  fearGreedLabel: 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed';
  fearGreedPrev: number;
  fearGreedChange: number;

  fundingRate: number;
  fundingLabel: string;
  fundingSignal: 'bullish' | 'bearish' | 'neutral';

  openInterest: number;
  openInterestChange: number;
  oiTrend: 'rising' | 'falling' | 'flat';
  oiSignal: 'bullish' | 'bearish' | 'neutral';

  overallScore: number;
  overallLabel: string;
  tradingBias: 'strongly_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strongly_bearish';

  longModifier: number;
  shortModifier: number;

  symbol: string;
  cachedAt: number;
}

// ─── Fetch functions (all verified CORS-OK for direct browser fetch) ─────────

async function fetchFearGreed(): Promise<{ score: number; prev: number }> {
  const res = await fetch('https://api.alternative.me/fng/?limit=2', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Fear & Greed API error: ${res.status}`);
  const data = await res.json();
  return {
    score: parseInt(data.data[0].value, 10),
    prev: parseInt(data.data[1].value, 10),
  };
}

async function fetchFundingRate(symbol: string): Promise<number> {
  const res = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`);
  if (!res.ok) throw new Error(`Funding rate API error: ${res.status}`);
  const data = await res.json();
  return parseFloat(data[0]?.fundingRate ?? '0');
}

async function fetchOpenInterest(symbol: string): Promise<{ current: number; prev: number }> {
  const [curr, hist] = await Promise.all([
    fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`).then(r => r.json()),
    fetch(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=2`).then(r => r.json()),
  ]);
  const current = parseFloat(curr.openInterest ?? '0');
  const prevHour = parseFloat(hist[0]?.sumOpenInterest ?? '0');
  return { current, prev: prevHour };
}

// ─── Combined score ───────────────────────────────────────────────────────

function calcOverallSentiment(params: {
  fearGreed: number;
  funding: number;
  oiSignal: 'bullish' | 'bearish' | 'neutral';
}): {
  score: number;
  label: string;
  tradingBias: SentimentData['tradingBias'];
  longModifier: number;
  shortModifier: number;
} {
  // Weights re-derived from the original 40/25/20/15 (FG/funding/OI/news) split with news
  // dropped and its weight redistributed proportionally across the other three.
  const fgComponent = params.fearGreed;
  const fundingNorm = 50 - params.funding * 100 * 1000;
  const fundingComponent = Math.max(0, Math.min(100, fundingNorm));
  const oiComponent = params.oiSignal === 'bullish' ? 70 : params.oiSignal === 'bearish' ? 30 : 50;

  const score = Math.round(fgComponent * 0.47 + fundingComponent * 0.29 + oiComponent * 0.24);

  let label: string;
  let tradingBias: SentimentData['tradingBias'];
  let longModifier: number;
  let shortModifier: number;

  if (score <= 15) {
    label = 'Extreme Fear'; tradingBias = 'strongly_bearish';
    longModifier = 1.3; shortModifier = 0.7; // contrarian: fear = buy zone
  } else if (score <= 30) {
    label = 'Fear'; tradingBias = 'bearish';
    longModifier = 0.8; shortModifier = 1.2;
  } else if (score <= 55) {
    label = 'Neutral'; tradingBias = 'neutral';
    longModifier = 1.0; shortModifier = 1.0;
  } else if (score <= 75) {
    label = 'Greed'; tradingBias = 'bullish';
    longModifier = 1.2; shortModifier = 0.8;
  } else {
    label = 'Extreme Greed'; tradingBias = 'strongly_bullish';
    longModifier = 0.7; shortModifier = 1.3; // contrarian: greed = sell zone
  }

  return { score, label, tradingBias, longModifier, shortModifier };
}

// ─── Main export ────────────────────────────────────────────────────────

let sentimentCache: SentimentData | null = null;
let sentimentCacheSymbol: string | null = null;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

export async function fetchSentiment(symbol = 'BTCUSDT'): Promise<SentimentData> {
  if (sentimentCache && sentimentCacheSymbol === symbol && Date.now() - sentimentCache.cachedAt < CACHE_DURATION) {
    return sentimentCache;
  }

  const [fgResult, fundingResult, oiResult] = await Promise.allSettled([
    fetchFearGreed(),
    fetchFundingRate(symbol),
    fetchOpenInterest(symbol),
  ]);

  const fg = fgResult.status === 'fulfilled' ? fgResult.value : { score: 50, prev: 50 };
  const funding = fundingResult.status === 'fulfilled' ? fundingResult.value : 0;
  const oi = oiResult.status === 'fulfilled' ? oiResult.value : { current: 0, prev: 0 };

  const oiChange = oi.prev > 0 ? ((oi.current - oi.prev) / oi.prev) * 100 : 0;
  const oiTrend: SentimentData['oiTrend'] = oiChange > 1 ? 'rising' : oiChange < -1 ? 'falling' : 'flat';

  // Need price direction to interpret OI correctly; Fear & Greed's own day-over-day change is
  // used as a coarse proxy here since this module doesn't otherwise track price.
  const priceGoingUp = fg.score > fg.prev;
  const oiSignal: 'bullish' | 'bearish' | 'neutral' =
    oiTrend === 'rising' && priceGoingUp ? 'bullish'
      : oiTrend === 'rising' && !priceGoingUp ? 'bearish'
        : 'neutral';

  const fundingSignal: SentimentData['fundingSignal'] =
    funding > 0.0002 ? 'bearish' : funding < -0.0002 ? 'bullish' : 'neutral';

  const combined = calcOverallSentiment({ fearGreed: fg.score, funding, oiSignal });

  const sentimentData: SentimentData = {
    timestamp: Date.now(),
    fearGreedScore: fg.score,
    fearGreedLabel: fg.score <= 25 ? 'Extreme Fear' : fg.score <= 40 ? 'Fear' : fg.score <= 60 ? 'Neutral' : fg.score <= 75 ? 'Greed' : 'Extreme Greed',
    fearGreedPrev: fg.prev,
    fearGreedChange: fg.score - fg.prev,
    fundingRate: funding,
    fundingLabel: funding > 0 ? 'Longs paying' : 'Shorts paying',
    fundingSignal,
    openInterest: oi.current,
    openInterestChange: oiChange,
    oiTrend,
    oiSignal,
    overallScore: combined.score,
    overallLabel: combined.label,
    tradingBias: combined.tradingBias,
    longModifier: combined.longModifier,
    shortModifier: combined.shortModifier,
    symbol,
    cachedAt: Date.now(),
  };

  sentimentCache = sentimentData;
  sentimentCacheSymbol = symbol;

  try {
    const db = getDB();
    await db.sentimentHistory.add(sentimentData as SentimentRecord);
  } catch (err) {
    console.error('Failed to store sentiment history:', err);
  }

  return sentimentData;
}

export async function getSentimentHistory(limit = 50): Promise<SentimentRecord[]> {
  const db = getDB();
  return db.sentimentHistory.orderBy('timestamp').reverse().limit(limit).toArray();
}

// ─── Signal modifier ────────────────────────────────────────────────────

export function applySentimentToSignal(
  edgeScore: number,
  signalType: 'bullish' | 'bearish',
  sentiment: SentimentData,
): { adjustedScore: number; modifier: number; reason: string } {
  let modifier = signalType === 'bullish' ? sentiment.longModifier : sentiment.shortModifier;
  let reason = '';

  if (sentiment.fearGreedScore <= 10 && signalType === 'bullish') {
    modifier *= 1.4;
    reason = '😱 Extreme Fear (contrarian long boost)';
  } else if (sentiment.fearGreedScore >= 90 && signalType === 'bearish') {
    modifier *= 1.4;
    reason = '🤑 Extreme Greed (contrarian short boost)';
  }

  if (Math.abs(sentiment.fundingRate) > 0.0005) {
    if (sentiment.fundingRate > 0 && signalType === 'bullish') {
      modifier *= 0.8;
      reason += (reason ? ' | ' : '') + 'Extreme positive funding — longs crowded';
    } else if (sentiment.fundingRate < 0 && signalType === 'bearish') {
      modifier *= 0.8;
      reason += (reason ? ' | ' : '') + 'Extreme negative funding — shorts crowded';
    }
  }

  const adjustedScore = Math.max(0, Math.min(100, Math.round(edgeScore * modifier)));

  return {
    adjustedScore,
    modifier: Math.round(modifier * 100) / 100,
    reason: reason || 'Sentiment neutral — no adjustment',
  };
}
