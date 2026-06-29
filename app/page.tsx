'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useBinanceFeed } from '@/hooks/useBinanceFeed';
import { usePatternDetection, type ActiveSignal } from '@/hooks/usePatternDetection';
import { useTradeManager, type ToastFn } from '@/hooks/useTradeManager';
import { runAllPatterns, type PatternResult } from '@/lib/pattern-engine';
import SignalCard from '@/components/SignalCard';
import SuggestionPanel from '@/components/SuggestionPanel';
import MemoryPanel from '@/components/MemoryPanel';
import SignalStrip from '@/components/SignalStrip';
import TradeLog from '@/components/TradeLog';
import SentimentBar from '@/components/SentimentBar';
import { fetchSentiment, type SentimentData } from '@/lib/sentiment-engine';

const CandleChart = dynamic(() => import('@/components/CandleChart'), { ssr: false });

type Mode = 'intraday' | 'swing';
type Toast = { msg: string; type: 'success' | 'error' | 'info' };

const SYMBOLS = [
  { key: 'btcusdt', label: 'BTC' },
  { key: 'ethusdt', label: 'ETH' },
  { key: 'solusdt', label: 'SOL' },
  { key: 'bnbusdt', label: 'BNB' },
  { key: 'adausdt', label: 'ADA' },
];

const MODE_INTERVAL: Record<Mode, string> = { intraday: '5m', swing: '4h' };
const MODE_WINDOW: Record<Mode, number> = { intraday: 60, swing: 100 };
const AUTO_ANALYZE_COOLDOWN_MS = 15 * 60 * 1000;
const TOAST_COLORS: Record<Toast['type'], string> = {
  success: '#22c55e', error: '#ef4444', info: '#3b82f6',
};

export default function Page() {
  const [symbol, setSymbol] = useState('btcusdt');
  const [mode, setMode] = useState<Mode>('intraday');
  const [autoAnalyze, setAutoAnalyze] = useState(false); // OFF by default — was firing every minute
  const analyzeTriggerRef = useRef<(() => void) | null>(null);
  const lastAutoAnalyzeAtRef = useRef(0);
  const lastAutoSignalCandleRef = useRef(0);

  const interval = MODE_INTERVAL[mode];

  const { candles, currentCandle, currentPrice, isConnected, priceChange24h } = useBinanceFeed(symbol, interval);
  const { signal, supportLevels, resistanceLevels, trendlinePoints, indicators, signalHistory } =
    usePatternDetection(candles, symbol, interval, mode);

  // Toast notifications — simple state-based, top-center, auto-dismiss
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast: ToastFn = useCallback((msg, type) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ msg, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const tradeManager = useTradeManager(currentPrice, currentCandle, symbol, interval, showToast);

  // Market sentiment — Fear & Greed + funding rate + open interest, refreshed every 30 minutes
  // (and cached internally for the same window so symbol switches don't re-fetch needlessly).
  const [sentiment, setSentiment] = useState<SentimentData | null>(null);
  const [sentimentLoading, setSentimentLoading] = useState(false);

  const refreshSentiment = useCallback(async () => {
    setSentimentLoading(true);
    try {
      const data = await fetchSentiment(symbol.toUpperCase());
      setSentiment(data);
    } catch (err) {
      console.warn('Sentiment fetch failed:', err);
    } finally {
      setSentimentLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    refreshSentiment();
    const id = setInterval(refreshSentiment, 30 * 60 * 1000);
    return () => clearInterval(id);
  }, [refreshSentiment]);

  // Top-2 patterns for the left panel — recomputed on candle close only, independent of the
  // hook's single trade signal (which stays the source of truth for the chart + analysis).
  const [patternState, setPatternState] = useState<{ patterns: PatternResult[]; isOpposing: boolean; conflictText: string }>(
    { patterns: [], isOpposing: false, conflictText: '' }
  );
  const [rightPanelTab, setRightPanelTab] = useState<'analysis' | 'memory'>('analysis');
  const lastPatternCandleRef = useRef(0);

  useEffect(() => {
    lastPatternCandleRef.current = 0;
    setPatternState({ patterns: [], isOpposing: false, conflictText: '' });
  }, [symbol, mode]);

  useEffect(() => {
    if (candles.length < 10) return;
    const last = candles[candles.length - 1];
    if (last.time === lastPatternCandleRef.current) return;
    lastPatternCandleRef.current = last.time;

    const window = MODE_WINDOW[mode];
    const wc = candles.slice(-window);
    const top2 = runAllPatterns(wc)
      .filter(p => p.confidence > 65 && p.type !== 'neutral')
      .slice(0, 2);
    // Only treat as a genuine conflict when confidences are close (same threshold the
    // detection hook itself uses) — a 90% pattern shouldn't be shelved just because a
    // 70% pattern of the opposite type also showed up.
    const opposing = top2.length === 2 && top2[0].type !== top2[1].type &&
      Math.abs(top2[0].confidence - top2[1].confidence) <= 15;

    setPatternState({
      patterns: opposing ? [] : top2,
      isOpposing: opposing,
      conflictText: opposing ? `${top2[0].name} (${top2[0].confidence}%) vs ${top2[1].name} (${top2[1].confidence}%)` : '',
    });
  }, [candles, mode]);

  // Auto-analyze: only on a genuinely new signal, and never more than once per 15 minutes
  useEffect(() => {
    if (!autoAnalyze || !signal || signal.direction === 'WAIT') return;
    const s = signal as ActiveSignal;
    if (s.candleTime === lastAutoSignalCandleRef.current) return;
    const now = Date.now();
    if (now - lastAutoAnalyzeAtRef.current < AUTO_ANALYZE_COOLDOWN_MS) return;
    lastAutoSignalCandleRef.current = s.candleTime;
    lastAutoAnalyzeAtRef.current = now;
    analyzeTriggerRef.current?.();
  }, [signal, autoAnalyze]);

  const hasActiveSignal = !!signal && signal.direction !== 'WAIT';
  const priceColor = priceChange24h >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]';
  const modeLabel: Record<Mode, string> = { intraday: 'Intraday 5m', swing: 'Swing 4h' };

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] overflow-hidden">
      {/* Toast */}
      {toast && (
        <div
          className="fixed top-[60px] left-1/2 -translate-x-1/2 z-[1000] px-4 py-2 rounded-full text-xs text-white bg-[#1a1a1a]"
          style={{ border: `1px solid ${TOAST_COLORS[toast.type]}` }}
        >
          {toast.msg}
        </div>
      )}

      {/* ── Top bar ─────────────────────────────────────────────── */}
      <header className="flex-shrink-0 border-b border-[#1f1f1f] px-4" style={{ height: '68px' }}>
        <div className="flex items-center h-full gap-6">

          {/* Wordmark */}
          <div className="flex-shrink-0">
            <span className="text-sm font-black tracking-tight text-[#f5f5f5]">
              Trade<span className="text-[#8b5cf6]">Flow</span>
            </span>
          </div>

          {/* Center: symbols + mode toggle */}
          <div className="flex flex-col items-center gap-1.5 flex-1">
            <div className="flex items-center gap-1">
              {SYMBOLS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setSymbol(key)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                    symbol === key
                      ? 'bg-[#f5f5f5] text-black'
                      : 'text-[#888888] hover:text-[#f5f5f5]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Intraday / Swing toggle — small pill buttons, not dominant */}
            <div className="flex bg-[#111111] rounded-full p-0.5 border border-[#1f1f1f]">
              {(['intraday', 'swing'] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`px-4 py-1 rounded-full text-[11px] font-semibold transition-all ${
                    mode === m
                      ? 'bg-[#f5f5f5] text-black'
                      : 'text-[#888888] hover:text-[#f5f5f5]'
                  }`}
                >
                  {modeLabel[m]}
                </button>
              ))}
            </div>
          </div>

          {/* Right: price + connection */}
          <div className="flex-shrink-0 flex items-center gap-3">
            <div className="text-right">
              <div className={`price text-base font-black ${priceColor}`}>
                ${currentPrice.toLocaleString(undefined, {
                  minimumFractionDigits: currentPrice < 10 ? 4 : 2,
                  maximumFractionDigits: currentPrice < 10 ? 4 : 2,
                })}
              </div>
              <div className={`text-[10px] font-medium ${priceColor}`}>
                {priceChange24h >= 0 ? '+' : ''}{priceChange24h.toFixed(2)}%
              </div>
            </div>

            <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isConnected ? 'bg-[#22c55e] live-dot' : 'bg-[#ef4444]'}`} />

            <Link href="/simulate" className="text-[11px] text-[#666] hover:text-[#888888] flex-shrink-0">
              📊 Simulator
            </Link>
          </div>
        </div>
      </header>

      <SentimentBar sentiment={sentiment} loading={sentimentLoading} onRefresh={refreshSentiment} />

      {/* ── Main 3-zone layout ───────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left: patterns + indicators (240px) */}
        <div className="w-[240px] flex-shrink-0 overflow-hidden">
          <SignalCard
            patterns={patternState.patterns}
            isOpposing={patternState.isOpposing}
            conflictText={patternState.conflictText}
            indicators={indicators}
            interval={interval}
            signalHistory={signalHistory}
            signal={signal}
            onAnalyze={() => analyzeTriggerRef.current?.()}
          />
        </div>

        {/* Center: chart + signal strip */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <div className="flex-1 min-h-0 overflow-hidden">
            <CandleChart
              candles={candles}
              supportLevels={supportLevels}
              resistanceLevels={resistanceLevels}
              trendlinePoints={trendlinePoints}
              ema20={indicators.ema20}
              ema50={indicators.ema50}
              atr={indicators.atr}
              signal={signal}
              signalHistory={signalHistory}
              patterns={patternState.patterns}
              activeTrade={tradeManager.activeTrade}
              tradeHistory={tradeManager.tradeHistory}
              currentPrice={currentPrice}
              symbol={symbol}
              interval={interval}
            />
          </div>

          <SignalStrip
            signal={signal}
            interval={interval}
            activeTrade={tradeManager.activeTrade}
            symbol={symbol}
            currentPrice={currentPrice}
            sessionStats={tradeManager.sessionStats}
            onOpenTrade={() => tradeManager.openTrade(hasActiveSignal ? (signal as ActiveSignal) : null)}
            onCloseTrade={tradeManager.closeTrade}
            onCancelTrade={tradeManager.cancelTrade}
          />

          <TradeLog
            tradeHistory={tradeManager.tradeHistory}
            sessionStats={tradeManager.sessionStats}
            currentPrice={currentPrice}
            symbol={symbol}
            onClear={() => {
              localStorage.removeItem('tradeflow_journal');
              window.location.reload();
            }}
          />
        </div>

        {/* Right: AI analysis panel (280px) or Memory Panel */}
        <div className="w-[300px] flex-shrink-0 overflow-hidden flex flex-col border-l border-[#1f1f1f]">
          <div className="flex border-b border-[#1f1f1f] flex-shrink-0" style={{ height: '36px' }}>
            <button
              onClick={() => setRightPanelTab('analysis')}
              className={`flex-1 text-[11px] font-semibold transition-colors ${rightPanelTab === 'analysis' ? 'text-white border-b-2 border-[#8b5cf6] bg-[#1a1a1a]' : 'text-[#888888] hover:text-[#f5f5f5]'}`}
            >
              AI Analysis
            </button>
            <button
              onClick={() => setRightPanelTab('memory')}
              className={`flex-1 text-[11px] font-semibold transition-colors ${rightPanelTab === 'memory' ? 'text-white border-b-2 border-[#8b5cf6] bg-[#1a1a1a]' : 'text-[#888888] hover:text-[#f5f5f5]'}`}
            >
              🧠 Memory
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            {rightPanelTab === 'analysis' ? (
              <SuggestionPanel
                symbol={symbol}
                interval={interval}
                signal={signal}
                candles={candles}
                indicators={indicators}
                currentPrice={currentPrice}
                autoAnalyze={autoAnalyze}
                onToggleAuto={setAutoAnalyze}
                triggerRef={analyzeTriggerRef}
              />
            ) : (
              <MemoryPanel />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
