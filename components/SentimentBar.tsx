'use client';

import { useState } from 'react';
import type { SentimentData } from '@/lib/sentiment-engine';

type SignalColor = 'bullish' | 'bearish' | 'neutral';

const COLOR: Record<SignalColor, string> = {
  bullish: '#22c55e',
  bearish: '#ef4444',
  neutral: '#888888',
};

function biasColor(bias: SentimentData['tradingBias']): string {
  if (bias === 'strongly_bullish' || bias === 'bullish') return COLOR.bullish;
  if (bias === 'strongly_bearish' || bias === 'bearish') return COLOR.bearish;
  return COLOR.neutral;
}

function biasCopy(bias: SentimentData['tradingBias'], label: string): string {
  if (bias === 'strongly_bearish') return `${label} — Contrarian Buy Zone`;
  if (bias === 'bearish') return `${label} — Cautious on Shorts`;
  if (bias === 'strongly_bullish') return `${label} — Caution on Longs`;
  if (bias === 'bullish') return `${label} — Favors Longs`;
  return `${label} — No Strong Bias`;
}

function fearGreedIcon(label: SentimentData['fearGreedLabel']): string {
  if (label === 'Extreme Fear') return '😱';
  if (label === 'Fear') return '😟';
  if (label === 'Greed') return '😏';
  if (label === 'Extreme Greed') return '🤑';
  return '😐';
}

export default function SentimentBar({
  sentiment,
  loading,
  onRefresh,
}: {
  sentiment: SentimentData | null;
  loading?: boolean;
  onRefresh?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!sentiment) {
    return (
      <div className="flex-shrink-0 h-8 bg-[#0d0d0d] border-b border-[#1a1a1a] flex items-center px-4 text-[11px] font-mono text-[#666]">
        {loading ? 'Loading market sentiment…' : 'Sentiment unavailable'}
      </div>
    );
  }

  const overallColor = biasColor(sentiment.tradingBias);

  return (
    <div className="flex-shrink-0 relative">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full h-8 bg-[#0d0d0d] border-b border-[#1a1a1a] flex items-center px-4 gap-6 text-[11px] font-mono hover:bg-[#111111] transition-colors"
      >
        <span className="flex items-center gap-1.5" style={{ color: sentiment.fearGreedScore <= 40 ? COLOR.bearish : sentiment.fearGreedScore >= 60 ? COLOR.bullish : COLOR.neutral }}>
          <span>{fearGreedIcon(sentiment.fearGreedLabel)}</span>
          <span>{sentiment.fearGreedLabel.toUpperCase()} {sentiment.fearGreedScore}</span>
        </span>

        <span className="flex items-center gap-1.5" style={{ color: COLOR[sentiment.fundingSignal] }}>
          <span>💰</span>
          <span>FUNDING {sentiment.fundingRate >= 0 ? '+' : ''}{(sentiment.fundingRate * 100).toFixed(3)}%</span>
        </span>

        <span className="flex items-center gap-1.5" style={{ color: COLOR[sentiment.oiSignal] }}>
          <span>📊</span>
          <span>OI {sentiment.oiTrend === 'rising' ? '↑' : sentiment.oiTrend === 'falling' ? '↓' : '→'} {sentiment.openInterestChange >= 0 ? '+' : ''}{sentiment.openInterestChange.toFixed(1)}%</span>
        </span>

        <span className="flex-1" />

        <span
          className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold"
          style={{ background: `${overallColor}26`, border: `1px solid ${overallColor}66`, color: overallColor }}
        >
          {biasCopy(sentiment.tradingBias, sentiment.overallLabel.toUpperCase())}
        </span>
        <span className="text-[#555] text-[10px]">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="absolute top-8 left-0 right-0 z-50 bg-[#111111] border border-[#1f1f1f] border-t-0 rounded-b-lg shadow-2xl p-4 grid grid-cols-3 gap-4">
          <div>
            <div className="text-[9px] text-[#666] uppercase tracking-wider mb-2 border-b border-[#1f1f1f] pb-1.5">Fear &amp; Greed</div>
            <div className="text-[20px] font-mono font-bold" style={{ color: sentiment.fearGreedScore <= 40 ? COLOR.bearish : sentiment.fearGreedScore >= 60 ? COLOR.bullish : COLOR.neutral }}>
              {sentiment.fearGreedScore} / 100
            </div>
            <div className="text-[11px] text-[#888888] mt-1">{sentiment.fearGreedLabel}</div>
            <div className="text-[10px] text-[#666] mt-1">
              Yesterday: {sentiment.fearGreedPrev} → Today: {sentiment.fearGreedScore} ({sentiment.fearGreedChange >= 0 ? '↑' : '↓'} {Math.abs(sentiment.fearGreedChange)})
            </div>
            <div className="h-1.5 rounded-full mt-2 overflow-hidden" style={{ background: 'linear-gradient(90deg, #ef4444, #f59e0b, #22c55e)' }}>
              <div className="h-full w-px bg-white relative" style={{ marginLeft: `${sentiment.fearGreedScore}%` }} />
            </div>
          </div>

          <div>
            <div className="text-[9px] text-[#666] uppercase tracking-wider mb-2 border-b border-[#1f1f1f] pb-1.5">Funding Rate ({sentiment.symbol})</div>
            <div className="text-[20px] font-mono font-bold" style={{ color: COLOR[sentiment.fundingSignal] }}>
              {sentiment.fundingRate >= 0 ? '+' : ''}{(sentiment.fundingRate * 100).toFixed(4)}%
            </div>
            <div className="text-[11px] text-[#888888] mt-1">{sentiment.fundingLabel} per 8h</div>
            <div className="text-[10px] text-[#666] mt-1">
              Signal: <span style={{ color: COLOR[sentiment.fundingSignal] }}>{sentiment.fundingSignal}</span> {sentiment.fundingSignal === 'bearish' ? '(crowded longs)' : sentiment.fundingSignal === 'bullish' ? '(crowded shorts)' : ''}
            </div>
          </div>

          <div>
            <div className="text-[9px] text-[#666] uppercase tracking-wider mb-2 border-b border-[#1f1f1f] pb-1.5">Open Interest</div>
            <div className="text-[20px] font-mono font-bold text-[#f5f5f5]">
              {sentiment.openInterest >= 1000 ? `${(sentiment.openInterest / 1000).toFixed(1)}k` : sentiment.openInterest.toFixed(0)}
            </div>
            <div className="text-[11px] text-[#888888] mt-1">
              {sentiment.oiTrend === 'rising' ? '↑' : sentiment.oiTrend === 'falling' ? '↓' : '→'} {sentiment.openInterestChange >= 0 ? '+' : ''}{sentiment.openInterestChange.toFixed(2)}% in last hour
            </div>
            <div className="text-[10px] text-[#666] mt-1">
              Signal: <span style={{ color: COLOR[sentiment.oiSignal] }}>{sentiment.oiSignal}</span>
            </div>
          </div>

          <div className="col-span-3 flex items-center justify-between pt-2 border-t border-[#1f1f1f]">
            <span className="text-[10px] text-[#555]">Updated {new Date(sentiment.cachedAt).toLocaleTimeString()} — cached 30 min</span>
            {onRefresh && (
              <button onClick={onRefresh} className="text-[10px] text-[#3b82f6] hover:underline">↺ Refresh now</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
