'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { Signal, ActiveSignal, Indicators } from '@/hooks/usePatternDetection';
import type { Candle } from '@/lib/binance-ws';

type AnalysisResult = {
  verdict: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';
  confidence: number;
  analysis: string;
  entryStrategy: string;
  riskManagement: string;
};

const VERDICT_CONFIG: Record<string, { label: string; bg: string; text: string; border: string }> = {
  strong_buy: { label: 'STRONG BUY', bg: 'bg-[#22c55e]',    text: 'text-white',   border: 'border-[#22c55e]' },
  buy:        { label: 'BUY',        bg: 'bg-[#22c55e]/20', text: 'text-[#22c55e]', border: 'border-[#22c55e]/50' },
  neutral:    { label: 'WAIT',       bg: 'bg-[#f59e0b]/20', text: 'text-[#f59e0b]', border: 'border-[#f59e0b]/50' },
  sell:       { label: 'SELL',       bg: 'bg-[#ef4444]/20', text: 'text-[#ef4444]', border: 'border-[#ef4444]/50' },
  strong_sell:{ label: 'STRONG SELL',bg: 'bg-[#ef4444]',    text: 'text-white',   border: 'border-[#ef4444]' },
};

type Props = {
  symbol: string;
  interval: string;
  signal: Signal;
  candles: Candle[];
  indicators: Indicators;
  currentPrice: number;
  autoAnalyze: boolean;
  onToggleAuto: (v: boolean) => void;
  triggerRef: React.MutableRefObject<(() => void) | null>;
};

function Skeleton() {
  return (
    <div className="space-y-3 animate-pulse px-3 py-3">
      <div className="h-10 bg-[#1a1a1a] rounded-lg" />
      <div className="h-3 bg-[#1a1a1a] rounded w-3/4" />
      <div className="h-16 bg-[#1a1a1a] rounded-lg" />
      <div className="h-3 bg-[#1a1a1a] rounded w-5/6" />
      <div className="h-3 bg-[#1a1a1a] rounded w-2/3" />
    </div>
  );
}

export default function SuggestionPanel({
  symbol, interval, signal, candles, indicators, currentPrice,
  autoAnalyze, onToggleAuto, triggerRef,
}: Props) {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [displayedText, setDisplayedText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAnalyzed, setLastAnalyzed] = useState<Date | null>(null);
  const revealRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startReveal = useCallback((text: string) => {
    if (revealRef.current) clearInterval(revealRef.current);
    let i = 0;
    setDisplayedText('');
    revealRef.current = setInterval(() => {
      i += 4;
      setDisplayedText(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(revealRef.current!);
        setDisplayedText(text);
      }
    }, 12);
  }, []);

  useEffect(() => () => { if (revealRef.current) clearInterval(revealRef.current); }, []);

  const analyze = useCallback(async () => {
    if (isLoading || !signal) return;
    const s = signal.direction !== 'WAIT' ? (signal as ActiveSignal) : null;
    if (!s) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol, pattern: s.pattern, candles: candles.slice(-50),
          indicators, timeframe: interval, currentPrice,
        }),
      });
      if (res.status === 429) { setError('Rate limited — wait 10 seconds'); return; }
      if (!res.ok) throw new Error(res.status === 500 ? 'Analysis failed. Is OPENAI_API_KEY set?' : 'Analysis failed');
      const data = await res.json() as AnalysisResult;
      setAnalysis(data);
      setLastAnalyzed(new Date());
      startReveal(data.analysis);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, signal, symbol, candles, indicators, interval, currentPrice, startReveal]);

  // Auto Trader agent behavior: Trigger analysis automatically when autoAnalyze is on and a new signal fires
  useEffect(() => {
    if (autoAnalyze && signal && signal.direction !== 'WAIT' && !isLoading && !analysis) {
      analyze();
    }
  }, [autoAnalyze, signal, analyze, isLoading, analysis]);

  triggerRef.current = analyze;

  const vc = analysis ? VERDICT_CONFIG[analysis.verdict] : null;

  return (
    <div className="flex flex-col h-full bg-[#111111] border-l border-[#1f1f1f] overflow-y-auto">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-[#1f1f1f] flex items-center justify-between flex-shrink-0">
        <h2 className="text-[10px] font-semibold text-[#888888] uppercase tracking-wider">GPT-4o Analysis</h2>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-[#888888]">Auto</span>
          <button
            onClick={() => onToggleAuto(!autoAnalyze)}
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
              autoAnalyze ? 'bg-[#3b82f6]' : 'bg-[#1f1f1f]'
            }`}
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
              autoAnalyze ? 'translate-x-3.5' : 'translate-x-0.5'
            }`} />
          </button>
        </div>
      </div>

      {/* Analyze button */}
      <div className="px-3 py-2.5 border-b border-[#1f1f1f] flex-shrink-0">
        <button
          onClick={analyze}
          disabled={isLoading || !signal || signal.direction === 'WAIT'}
          className="w-full py-2 bg-[#3b82f6] hover:bg-[#3b82f6]/80 disabled:opacity-30 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg transition-colors"
        >
          {isLoading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Analyzing...
            </span>
          ) : 'Analyze'}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && !analysis && <Skeleton />}

        {error && !isLoading && (
          <div className="px-3 py-3">
            <div className="bg-[#ef4444]/10 border border-[#ef4444]/30 rounded-lg p-3">
              <p className="text-[11px] text-[#ef4444] mb-2">{error}</p>
              <button onClick={analyze} className="text-[10px] text-[#3b82f6] hover:underline">Retry</button>
            </div>
          </div>
        )}

        {analysis && vc && (
          <div className="px-3 py-3 space-y-3">
            {/* Verdict */}
            <div className={`rounded-lg p-3 border ${vc.bg} ${vc.border}`}>
              <div className={`text-base font-black tracking-wider text-center ${vc.text}`}>
                {vc.label}
              </div>
              <div className="mt-2">
                <div className="flex justify-between text-[9px] mb-1">
                  <span className={`${vc.text} opacity-60`}>Confidence</span>
                  <span className={vc.text}>{analysis.confidence}%</span>
                </div>
                <div className="w-full bg-black/20 rounded-full h-1">
                  <div className="h-1 rounded-full bg-white/50" style={{ width: `${analysis.confidence}%` }} />
                </div>
              </div>
            </div>

            {/* Analysis */}
            <div className="bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg p-3">
              <div className="text-[9px] text-[#888888] uppercase tracking-wider mb-1.5">Analysis</div>
              <p className="text-[11px] text-[#f5f5f5] leading-relaxed">
                {displayedText}
                {displayedText !== analysis.analysis && (
                  <span className="animate-pulse text-[#888888]">▋</span>
                )}
              </p>
            </div>

            {/* Entry Strategy */}
            <div className="bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg p-3">
              <div className="text-[9px] text-[#888888] uppercase tracking-wider mb-1.5">Entry Strategy</div>
              <p className="text-[11px] text-[#888888] leading-relaxed">{analysis.entryStrategy}</p>
            </div>

            {/* Risk Management */}
            <div className="bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg p-3">
              <div className="text-[9px] text-[#888888] uppercase tracking-wider mb-1.5">Risk Management</div>
              <p className="text-[11px] text-[#888888] leading-relaxed">{analysis.riskManagement}</p>
            </div>

            {lastAnalyzed && (
              <div className="text-[9px] text-[#555] text-center">
                Analyzed at {lastAnalyzed.toLocaleTimeString()}
              </div>
            )}
          </div>
        )}

        {!analysis && !isLoading && !error && (
          <div className="px-3 py-6 text-center">
            <p className="text-[11px] text-[#888888]">
              {signal && signal.direction !== 'WAIT'
                ? `${(signal as ActiveSignal).pattern.name} detected — click Analyze`
                : 'Waiting for a valid signal...'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
