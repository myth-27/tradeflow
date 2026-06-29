'use client';

import { useState, useEffect, useRef } from 'react';
import type { Candle } from '@/lib/binance-ws';
import {
  runAllPatterns,
  findSupportLevels,
  findResistanceLevels,
  validateSRLevels,
  findTrendlinePoints,
  calcRSI,
  calcMACD,
  calcEMA,
  calcATR,
  calcVolumeProfile,
  type PatternResult,
} from '@/lib/pattern-engine';
import { classifyRegime } from '@/lib/simulator';
import { calculateEdgeScore, type EdgeScoreResult } from '@/lib/edge-score';
import { recordSignal } from '@/lib/signal-memory';
import { fetchOrderFlow } from '@/lib/order-flow';
import { getMultiTFAnalysis } from '@/lib/multi-timeframe';

export type Direction = 'LONG' | 'SHORT' | 'WAIT';

export type ActiveSignal = {
  direction: 'LONG' | 'SHORT';
  pattern: PatternResult;
  entry: number;
  target: number;
  stop: number;
  riskReward: number;
  targetPct: number;
  stopPct: number;
  confidence: number;
  firedAt: number;
  candleTime: number;
  signalId?: number;
  edgeScore?: EdgeScoreResult;
};

export type WaitSignal = {
  direction: 'WAIT';
  reason: string;
  firedAt: number;
  candleTime: number;
};

export type Signal = ActiveSignal | WaitSignal | null;

export type SignalHistoryEntry = {
  id: string;
  timestamp: number;
  patternName: string;
  direction: Direction;
  entry: number;
  target: number;
  stop: number;
  symbol: string;
  interval: string;
  outcome: 'pending' | 'target_hit' | 'stop_hit';
  candleTime: number;
  signalId?: number;
  edgeScoreResult?: EdgeScoreResult;
};

type TrendlinePoint = { time: number; value: number };

export type Indicators = {
  rsi: number;
  macd: { macd: number; signal: number; histogram: number };
  atr: number;
  volumeProfile: { avgVolume: number; currentVolume: number; volumeRatio: number; label: string; isHighVolume: boolean };
  ema20: number[];
  ema50: number[];
  trendDirection: 'up' | 'down' | 'sideways';
};

export type PatternDetectionResult = {
  signal: Signal;
  supportLevels: number[];
  resistanceLevels: number[];
  trendlinePoints: {
    supportTrendline: [TrendlinePoint, TrendlinePoint];
    resistanceTrendline: [TrendlinePoint, TrendlinePoint];
  } | null;
  indicators: Indicators;
  signalHistory: SignalHistoryEntry[];
};

const defaultIndicators: Indicators = {
  rsi: 50,
  macd: { macd: 0, signal: 0, histogram: 0 },
  atr: 0,
  volumeProfile: { avgVolume: 0, currentVolume: 0, volumeRatio: 1, label: '1.0x', isHighVolume: false },
  ema20: [],
  ema50: [],
  trendDirection: 'sideways',
};

function histKey(symbol: string) { return `tf_signals_${symbol}`; }

function loadHistory(symbol: string): SignalHistoryEntry[] {
  try {
    if (typeof window === 'undefined') return [];
    const raw = localStorage.getItem(histKey(symbol));
    return raw ? (JSON.parse(raw) as SignalHistoryEntry[]) : [];
  } catch { return []; }
}

function saveHistory(symbol: string, h: SignalHistoryEntry[]) {
  try { localStorage.setItem(histKey(symbol), JSON.stringify(h.slice(0, 20))); } catch { /* ignore */ }
}

export function usePatternDetection(
  candles: Candle[],
  symbol: string,
  interval: string,
  mode: 'intraday' | 'swing',
): PatternDetectionResult {
  const [result, setResult] = useState<PatternDetectionResult>({
    signal: null,
    supportLevels: [],
    resistanceLevels: [],
    trendlinePoints: null,
    indicators: defaultIndicators,
    signalHistory: [],
  });

  const prevLastTimeRef = useRef<number>(0);
  const historyRef = useRef<SignalHistoryEntry[]>([]);
  const processingRef = useRef<Set<string>>(new Set());

  // Reset detection clock on symbol/interval change so we re-run on next candle
  useEffect(() => {
    prevLastTimeRef.current = 0;
    if (typeof window === 'undefined') return;
    const h = loadHistory(symbol);
    historyRef.current = h;
    setResult(prev => ({ ...prev, signalHistory: h, signal: null }));
  }, [symbol, interval]);

  // Check outcomes of pending signals
  useEffect(() => {
    if (!candles.length || typeof window === 'undefined') return;
    let changed = false;
    const updated = historyRef.current.map(e => {
      if (e.outcome !== 'pending' || e.symbol !== symbol || e.interval !== interval) return e;
      for (const c of candles.filter(c => c.time > e.candleTime)) {
        if (e.direction === 'LONG') {
          if (c.high >= e.target) { changed = true; return { ...e, outcome: 'target_hit' as const }; }
          if (c.low <= e.stop)   { changed = true; return { ...e, outcome: 'stop_hit' as const }; }
        } else if (e.direction === 'SHORT') {
          if (c.low <= e.target)  { changed = true; return { ...e, outcome: 'target_hit' as const }; }
          if (c.high >= e.stop)   { changed = true; return { ...e, outcome: 'stop_hit' as const }; }
        }
      }
      return e;
    });
    if (changed) {
      historyRef.current = updated;
      saveHistory(symbol, updated);
      setResult(prev => ({ ...prev, signalHistory: updated }));
    }
  }, [candles, symbol, interval]);

  // Main detection — fires on EVERY tick so S/R, trendlines, and indicators update in real-time
  useEffect(() => {
    if (candles.length < 10) return;
    const last = candles[candles.length - 1];

    const window = mode === 'intraday' ? 60 : 100;
    const wc = candles.slice(-window);
    const closes = wc.map(c => c.close);
    const price = last.close;

    // Compute indicators first — needed for signal generation
    const rsi = calcRSI(closes);
    const macd = calcMACD(closes);
    const atr = calcATR(wc);
    const volumeProfile = calcVolumeProfile(wc);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);
    const lastE20 = ema20[ema20.length - 1] ?? 0;
    const lastE50 = ema50[ema50.length - 1] ?? 0;
    const trendDirection: 'up' | 'down' | 'sideways' =
      lastE20 > lastE50 * 1.001 ? 'up' :
      lastE20 < lastE50 * 0.999 ? 'down' : 'sideways';

    // Run pattern detection (already validated inside runAllPatterns)
    const allPatterns = runAllPatterns(wc);

    // C10: Conflict check among ALL patterns (not just multi-bar)
    const topBull = allPatterns.find(p => p.type === 'bullish');
    const topBear = allPatterns.find(p => p.type === 'bearish');
    const isConflict = !!(
      topBull && topBear &&
      topBull.type !== 'neutral' && topBear.type !== 'neutral' &&
      Math.abs(topBull.confidence - topBear.confidence) <= 15
    );

    let signal: Signal = null;

    if (isConflict) {
      signal = {
        direction: 'WAIT',
        reason: `${topBull!.name} (${topBull!.confidence}%) vs ${topBear!.name} (${topBear!.confidence}%)`,
        firedAt: Date.now(),
        candleTime: last.time,
      };
    } else {
      const best = allPatterns[0];
      if (best && best.confidence >= 65 && best.type !== 'neutral') {

        // C14: Trend filter — only take LONG when EMA20 > EMA50, SHORT when EMA20 < EMA50
        const isBullish = best.type === 'bullish';
        const isCounterTrend = (
          (isBullish && trendDirection === 'down') ||
          (!isBullish && trendDirection === 'up')
        );

        if (isCounterTrend && best.confidence <= 80) {
          // Skip counter-trend signal with insufficient confidence
        } else {
          let confluenceBonus = 0;
          const macdBullish = macd.histogram > 0;
          const rsiBullish = rsi < 50;

          if (isBullish) {
            if (macdBullish) confluenceBonus += 5;
            if (rsiBullish) confluenceBonus += 5;
            if (volumeProfile.isHighVolume) confluenceBonus += 10;
          } else {
            if (!macdBullish) confluenceBonus += 5;
            if (!rsiBullish) confluenceBonus += 5;
            if (volumeProfile.isHighVolume) confluenceBonus += 10;
          }

          let volumePenalty = 0;
          if (volumeProfile.volumeRatio < 0.8) volumePenalty = -25;

          const finalConfidence = Math.min(best.confidence + confluenceBonus + volumePenalty, 95);

          let finalStop: number;
          if (isBullish) {
            const atrStop = price - (atr * 1.5);
            finalStop = Math.max(atrStop, best.stopLoss); // closer = safer for longs
          } else {
            const atrStop = price + (atr * 1.5);
            finalStop = Math.min(atrStop, best.stopLoss); // closer = safer for shorts
          }

          const risk = Math.abs(price - finalStop);
          const reward = Math.abs(best.target - price);
          const rr = risk > 0 ? parseFloat((reward / risk).toFixed(2)) : 0;

          if (rr >= 1.5 && finalConfidence >= 55) {
            const dir: 'LONG' | 'SHORT' = isBullish ? 'LONG' : 'SHORT';
            signal = {
              direction: dir,
              pattern: best,
              entry: price,
              target: best.target,
              stop: finalStop,
              riskReward: rr,
              targetPct: ((best.target - price) / price) * 100,
              stopPct: ((finalStop - price) / price) * 100,
              confidence: finalConfidence,
              firedAt: Date.now(),
              candleTime: last.time,
            };
          }
        }
      }
    }

    // S/R levels — validated against current price
    const rawSupport = findSupportLevels(wc, price);
    const rawResistance = findResistanceLevels(wc, price);
    const validated = validateSRLevels(rawSupport, rawResistance, price);

    setResult(prev => ({
      ...prev,
      signal, // initial signal without edge score
      supportLevels: validated.support,
      resistanceLevels: validated.resistance,
      trendlinePoints: findTrendlinePoints(wc),
      indicators: { rsi, macd, atr, volumeProfile, ema20, ema50, trendDirection },
    }));

    // TradeFlow V3: Calculate Edge Score Asynchronously and Record Signal
    if (signal && signal.direction !== 'WAIT') {
      const s = signal as ActiveSignal;
      
      // Prevent duplicate signals for the same pattern on the same candle
      const isDuplicate = historyRef.current.some(
        e => e.candleTime === last.time && e.patternName === s.pattern.name && e.outcome === 'pending'
      );
      
      const dedupKey = `${last.time}-${s.pattern.name}`;
      if (!isDuplicate && !processingRef.current.has(dedupKey)) {
        processingRef.current.add(dedupKey);

        (async () => {
          try {
            const regime = classifyRegime(wc);
            const flow = await fetchOrderFlow(symbol).catch(() => null);
            const mtf = await getMultiTFAnalysis(symbol, s.direction === 'LONG' ? 'long' : 'short').catch(() => null);

            const edgeScore = await calculateEdgeScore({
              symbol,
              timeframe: interval,
              pattern: s.pattern.name,
              patternConfidence: s.confidence,
              direction: s.direction === 'LONG' ? 'long' : 'short',
              regime,
              rsi,
              macd: macd.macd,
              macdHistogram: macd.histogram,
              atr,
              atrPercent: atr / price,
              volumeRatio: volumeProfile.volumeRatio,
              riskReward: s.riskReward,
              trendDirection,
              openInterest: flow?.openInterest,
              fundingRate: flow?.fundingRate,
              cvd: flow?.cvd,
              htfBias: mtf?.bias4H,
            });

            const wasTaken = edgeScore.expectedValue > 0;
            const mult = s.direction === 'LONG' ? 1 : -1;
            const risk = Math.abs(s.entry - s.stop);

            const signalId = await recordSignal({
              symbol,
              timeframe: interval,
              pattern: s.pattern.name,
              direction: s.direction === 'LONG' ? 'long' : 'short',
              patternScore: s.confidence,
              tradeScore: s.confidence,
              edgeScore: edgeScore.finalEdgeScore,
              regime,
              rsi,
              macd: macd.macd,
              atr: atr / price,
              volumeRatio: volumeProfile.volumeRatio,
              openInterest: flow?.openInterest,
              fundingRate: flow?.fundingRate,
              cvd: flow?.cvd,
              supportLevels: rawSupport,
              resistanceLevels: rawResistance,
              entry: s.entry,
              stop: s.stop,
              tp1: s.entry + risk * 1 * mult,
              tp2: s.entry + risk * 2 * mult,
              tp3: s.entry + risk * 3 * mult,
              wasTaken,
              rejectionReason: wasTaken ? null : 'Negative Expected Value',
              htfBias: mtf?.bias4H,
              mtfConfirmation: mtf?.confirmation1H,
            });

            const entry: SignalHistoryEntry = {
              id: String(Date.now()),
              timestamp: Date.now(),
              patternName: s.pattern.name,
              direction: s.direction,
              entry: s.entry,
              target: s.target,
              stop: s.stop,
              symbol,
              interval,
              outcome: 'pending',
              candleTime: last.time,
              signalId,
              edgeScoreResult: edgeScore,
            };

            const newHist = [entry, ...historyRef.current].slice(0, 20);
            historyRef.current = newHist;
            saveHistory(symbol, newHist);

            setResult(prev => ({
              ...prev,
              signalHistory: newHist,
              signal: prev.signal && prev.signal.direction !== 'WAIT' && prev.signal.candleTime === s.candleTime
                ? { ...prev.signal, signalId, edgeScore }
                : prev.signal
            }));

          } catch (err) {
            console.error('Failed to generate Edge Score:', err);
          }
        })();
      }
    }

  }, [candles, symbol, interval, mode]);

  return result;
}
