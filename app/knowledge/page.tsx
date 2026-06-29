'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PATTERN_KNOWLEDGE_BASE, type PatternKnowledge } from '@/lib/pattern-knowledge';

const RELIABILITY_COLOR: Record<PatternKnowledge['reliability'], string> = {
  high: '#22c55e', medium: '#f59e0b', low: '#ef4444',
};
const DIRECTION_COLOR: Record<PatternKnowledge['direction'], string> = {
  bullish: '#22c55e', bearish: '#ef4444', both: '#3b82f6',
};

function PatternCard({ pattern }: { pattern: PatternKnowledge }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl overflow-hidden">
      <button onClick={() => setExpanded(e => !e)} className="w-full text-left p-4 hover:bg-white/[0.02]">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-[#f5f5f5]">{pattern.name}</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded uppercase font-bold" style={{ color: DIRECTION_COLOR[pattern.direction], background: `${DIRECTION_COLOR[pattern.direction]}1a` }}>
              {pattern.direction}
            </span>
            <span className="text-[9px] px-1.5 py-0.5 rounded uppercase font-bold" style={{ color: RELIABILITY_COLOR[pattern.reliability], background: `${RELIABILITY_COLOR[pattern.reliability]}1a` }}>
              {pattern.reliability}
            </span>
          </div>
          <span className="text-[#666] text-[12px]">{expanded ? '▲' : '▼'}</span>
        </div>
        <div className="flex gap-4 text-[11px] text-[#888888]">
          {pattern.historicalWinRate > 0 ? (
            <span>{pattern.historicalWinRate}% historical win rate</span>
          ) : (
            <span className="text-[#666]">No quantitative win rate in source — qualitative only</span>
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-[#1f1f1f] pt-3 space-y-3 text-[12px]">
          <div>
            <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1">Definition</div>
            <p className="text-[#cccccc] leading-relaxed">{pattern.definition}</p>
          </div>
          <div>
            <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1">Characteristics</div>
            <ul className="space-y-0.5">
              {pattern.characteristics.map((c, i) => <li key={i} className="text-[#aaaaaa]">• {c}</li>)}
            </ul>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1">Target Formula</div>
              <p className="text-[#aaaaaa] font-mono text-[11px]">{pattern.targetFormula}</p>
            </div>
            <div>
              <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1">Stop Placement</div>
              <p className="text-[#aaaaaa]">{pattern.stopPlacement}</p>
            </div>
          </div>
          <div>
            <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1">Confirmation Rules</div>
            <ul className="space-y-0.5">
              {pattern.confirmationRules.map((r, i) => <li key={i} className="text-[#22c55e]">✓ {r}</li>)}
            </ul>
          </div>
          <div>
            <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1">Failure Conditions</div>
            <ul className="space-y-0.5">
              {pattern.failureConditions.map((f, i) => <li key={i} className="text-[#ef4444]">✗ {f}</li>)}
            </ul>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1">Best Conditions</div>
              <p className="text-[#aaaaaa]">{pattern.bestConditions.join(', ') || '—'}</p>
            </div>
            <div>
              <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1">Worst Conditions</div>
              <p className="text-[#aaaaaa]">{pattern.worstConditions.join(', ') || '—'}</p>
            </div>
          </div>
          <div className="flex justify-between text-[10px] text-[#666] pt-2 border-t border-[#1f1f1f]">
            <span>Best timeframes: {pattern.bestTimeframes.join(', ')}</span>
            <span>Sources: {pattern.sources.join('; ')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function KnowledgePage() {
  const patterns = Object.values(PATTERN_KNOWLEDGE_BASE);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f5f5f5]">
      <div className="max-w-[900px] mx-auto px-6 py-8">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black">Pattern Knowledge Base</h1>
            <p className="text-[13px] text-[#888888] mt-1">Rules used by GPT-4o for every analysis — extracted from real chart-pattern reference documents, not generic training knowledge.</p>
          </div>
          <Link href="/" className="text-[12px] text-[#3b82f6] hover:underline flex-shrink-0">← Back to TradeFlow</Link>
        </header>

        <div className="space-y-3">
          {patterns.map(p => <PatternCard key={p.name} pattern={p} />)}
        </div>

        <p className="text-[11px] text-[#555] mt-6 text-center">
          Source documents: GoodCrypto-patterns-presentation.pdf, Idenitfying-Chart-Patterns.pdf, Ondrej_Bucek_Bc_thesis.pdf, Price-Action-Trading-Guide.pdf, Technical-analysis-Price-patterns.pdf
        </p>
      </div>
    </div>
  );
}
