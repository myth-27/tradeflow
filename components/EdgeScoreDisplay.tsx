'use client';

/**
 * TradeFlow V3 — Edge Score Display Component
 *
 * Visual display of the multi-component edge score breakdown.
 * Shows circular gauge, component bars, and historical similarity data.
 */

import { type EdgeScoreResult } from '@/lib/edge-score';
import { getTierBadgeStyle, type SignalTier } from '@/lib/signal-tiers';

interface Props {
  edgeScore: EdgeScoreResult | null;
  compact?: boolean;
}

export default function EdgeScoreDisplay({ edgeScore, compact = false }: Props) {
  if (!edgeScore) {
    return (
      <div style={{ padding: '8px 10px', color: '#555', fontSize: '11px' }}>
        Calculating edge...
      </div>
    );
  }

  const tier = edgeScore.tier;
  const badge = getTierBadgeStyle(tier);
  const score = edgeScore.finalEdgeScore;

  // Colors based on score
  const scoreColor = score >= 90 ? '#fbbf24' : score >= 85 ? '#22c55e' : score >= 75 ? '#3b82f6' : '#6b7280';

  if (compact) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: '4px 8px', borderRadius: '6px',
        background: badge.bg, border: `1px solid ${badge.border}`,
        boxShadow: badge.glow,
      }}>
        <span style={{
          fontSize: '13px', fontWeight: 800, color: badge.text,
          fontFamily: "'SF Mono', 'Fira Code', monospace",
          fontFeatureSettings: "'tnum'",
        }}>
          {score}
        </span>
        <span style={{
          fontSize: '9px', fontWeight: 700, color: badge.text,
          letterSpacing: '0.5px',
        }}>
          {tier}
        </span>
        {edgeScore.expectedValue > 0 && (
          <span style={{ fontSize: '9px', color: '#22c55e' }}>
            +EV
          </span>
        )}
      </div>
    );
  }

  return (
    <div style={{
      padding: '10px',
      borderTop: '1px solid #1f1f1f',
    }}>
      {/* ── Header with score + tier badge ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <span style={{
            fontSize: '28px', fontWeight: 900, color: scoreColor,
            fontFamily: "'SF Mono', 'Fira Code', monospace",
            fontFeatureSettings: "'tnum'",
            lineHeight: 1,
          }}>
            {score}
          </span>
          <span style={{ fontSize: '10px', color: '#666', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Edge
          </span>
        </div>
        <div style={{
          padding: '3px 10px', borderRadius: '4px',
          background: badge.bg, border: `1px solid ${badge.border}`,
          boxShadow: badge.glow,
          fontSize: '10px', fontWeight: 800, color: badge.text,
          letterSpacing: '1px',
        }}>
          {tier}
        </div>
      </div>

      {/* ── Sub-scores row ── */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
        <ScorePill label="PAT" value={edgeScore.patternScore} />
        <ScorePill label="TRD" value={edgeScore.tradeScore} />
        <ScorePill label="HIST" value={edgeScore.historicalEdge} />
      </div>

      {/* ── Component Breakdown Bars ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '10px' }}>
        <ComponentBar label="Hist. Similarity" value={edgeScore.components.historicalSimilarity} weight="40%" />
        <ComponentBar label="Regime" value={edgeScore.components.regimeAlignment} weight="20%" />
        <ComponentBar label="Order Flow" value={edgeScore.components.orderFlow} weight="15%" />
        <ComponentBar label="Volume" value={edgeScore.components.volume} weight="10%" />
        <ComponentBar label="Pattern" value={edgeScore.components.patternQuality} weight="10%" />
        <ComponentBar label="Momentum" value={edgeScore.components.momentum} weight="5%" />
      </div>

      {/* ── Expected Value ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '6px 8px', borderRadius: '4px',
        background: edgeScore.expectedValue > 0 ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
        border: `1px solid ${edgeScore.expectedValue > 0 ? '#22c55e33' : '#ef444433'}`,
      }}>
        <span style={{ fontSize: '10px', color: '#888' }}>Expected Value</span>
        <span style={{
          fontSize: '12px', fontWeight: 700,
          color: edgeScore.expectedValue > 0 ? '#22c55e' : '#ef4444',
          fontFamily: "'SF Mono', 'Fira Code', monospace",
          fontFeatureSettings: "'tnum'",
        }}>
          {edgeScore.expectedValue >= 0 ? '+' : ''}{edgeScore.expectedValue.toFixed(2)}R
        </span>
      </div>

      {/* ── Historical Similarity Stats ── */}
      {edgeScore.similarSetups.matchCount > 0 && (
        <div style={{
          marginTop: '8px', padding: '6px 8px', borderRadius: '4px',
          background: '#111', border: '1px solid #1f1f1f',
        }}>
          <div style={{ fontSize: '9px', color: '#666', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
            {edgeScore.similarSetups.matchCount} Similar Setups Found
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px' }}>
            <StatRow label="Win Rate" value={`${edgeScore.similarSetups.historicalWinRate.toFixed(0)}%`}
              color={edgeScore.similarSetups.historicalWinRate >= 60 ? '#22c55e' : edgeScore.similarSetups.historicalWinRate >= 50 ? '#f5f5f5' : '#ef4444'} />
            <StatRow label="Avg R" value={`${edgeScore.similarSetups.avgRMultiple.toFixed(2)}`}
              color={edgeScore.similarSetups.avgRMultiple > 0 ? '#22c55e' : '#ef4444'} />
            <StatRow label="PF" value={`${isFinite(edgeScore.similarSetups.profitFactor) ? edgeScore.similarSetups.profitFactor.toFixed(1) : '∞'}`}
              color={edgeScore.similarSetups.profitFactor > 1.5 ? '#22c55e' : '#f5f5f5'} />
            <StatRow label="Max DD" value={`${edgeScore.similarSetups.maxDrawdown.toFixed(1)}R`} color="#ef4444" />
          </div>
          <div style={{
            fontSize: '8px', color: '#555', marginTop: '3px',
            display: 'flex', alignItems: 'center', gap: '4px',
          }}>
            <span style={{
              width: '5px', height: '5px', borderRadius: '50%',
              background: edgeScore.similarSetups.sampleConfidence === 'high' ? '#22c55e'
                : edgeScore.similarSetups.sampleConfidence === 'medium' ? '#f59e0b' : '#ef4444',
            }} />
            {edgeScore.similarSetups.sampleConfidence} confidence
          </div>
        </div>
      )}
    </div>
  );
}

function ScorePill({ label, value }: { label: string; value: number }) {
  const color = value >= 80 ? '#22c55e' : value >= 60 ? '#f5f5f5' : value >= 40 ? '#f59e0b' : '#ef4444';
  return (
    <div style={{
      flex: 1, textAlign: 'center', padding: '4px 0', borderRadius: '4px',
      background: '#111', border: '1px solid #1f1f1f',
    }}>
      <div style={{
        fontSize: '14px', fontWeight: 800, color,
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        fontFeatureSettings: "'tnum'",
      }}>
        {value}
      </div>
      <div style={{ fontSize: '8px', color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {label}
      </div>
    </div>
  );
}

function ComponentBar({ label, value, weight }: { label: string; value: number; weight: string }) {
  const fillColor = value >= 70 ? '#22c55e' : value >= 50 ? '#3b82f6' : value >= 30 ? '#f59e0b' : '#ef4444';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      <span style={{ fontSize: '9px', color: '#666', width: '72px', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <div style={{
        flex: 1, height: '4px', borderRadius: '2px',
        background: '#1a1a1a',
      }}>
        <div style={{
          width: `${value}%`, height: '100%', borderRadius: '2px',
          background: fillColor,
          transition: 'width 0.5s ease',
        }} />
      </div>
      <span style={{
        fontSize: '9px', color: '#555', width: '24px', textAlign: 'right',
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        fontFeatureSettings: "'tnum'",
      }}>
        {weight}
      </span>
    </div>
  );
}

function StatRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ fontSize: '9px', color: '#555' }}>{label}</span>
      <span style={{
        fontSize: '9px', fontWeight: 600, color,
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        fontFeatureSettings: "'tnum'",
      }}>
        {value}
      </span>
    </div>
  );
}
