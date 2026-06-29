/**
 * TradeFlow V3 — Signal Quality Tiers (Phase 13)
 *
 * A+ (90+): Push notification + Draw automatically
 * A  (85-89): Draw automatically
 * B  (75-84): Watchlist only
 * C  (Below 75): Ignore
 *
 * Goal: Show only top opportunities.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type SignalTier = 'A+' | 'A' | 'B' | 'C';

export interface TieredSignal {
  tier: SignalTier;
  edgeScore: number;
  shouldDraw: boolean;
  shouldNotify: boolean;
  shouldShow: boolean;        // show in signal panel
  shouldAddToWatchlist: boolean;
  tierColor: string;
  tierLabel: string;
  tierDescription: string;
}

// ─── Tier Classification ──────────────────────────────────────────────────────

/** Classify a signal into its quality tier */
export function classifySignalTier(edgeScore: number): TieredSignal {
  if (edgeScore >= 90) {
    return {
      tier: 'A+',
      edgeScore,
      shouldDraw: true,
      shouldNotify: true,
      shouldShow: true,
      shouldAddToWatchlist: true,
      tierColor: '#fbbf24',   // gold
      tierLabel: 'A+ ELITE',
      tierDescription: 'Elite setup — highest edge opportunity',
    };
  }

  if (edgeScore >= 85) {
    return {
      tier: 'A',
      edgeScore,
      shouldDraw: true,
      shouldNotify: false,
      shouldShow: true,
      shouldAddToWatchlist: true,
      tierColor: '#22c55e',   // green
      tierLabel: 'A STRONG',
      tierDescription: 'Strong edge — draw automatically',
    };
  }

  if (edgeScore >= 75) {
    return {
      tier: 'B',
      edgeScore,
      shouldDraw: false,
      shouldNotify: false,
      shouldShow: true,
      shouldAddToWatchlist: true,
      tierColor: '#3b82f6',   // blue
      tierLabel: 'B WATCHLIST',
      tierDescription: 'Watchlist — monitor for improvement',
    };
  }

  return {
    tier: 'C',
    edgeScore,
    shouldDraw: false,
    shouldNotify: false,
    shouldShow: false,
    shouldAddToWatchlist: false,
    tierColor: '#6b7280',     // gray
    tierLabel: 'C IGNORE',
    tierDescription: 'Below threshold — insufficient edge',
  };
}

/** Get tier badge styling */
export function getTierBadgeStyle(tier: SignalTier): {
  bg: string;
  border: string;
  text: string;
  glow: string;
} {
  switch (tier) {
    case 'A+':
      return {
        bg: 'rgba(251, 191, 36, 0.15)',
        border: '#fbbf24',
        text: '#fbbf24',
        glow: '0 0 12px rgba(251, 191, 36, 0.4)',
      };
    case 'A':
      return {
        bg: 'rgba(34, 197, 94, 0.15)',
        border: '#22c55e',
        text: '#22c55e',
        glow: '0 0 8px rgba(34, 197, 94, 0.3)',
      };
    case 'B':
      return {
        bg: 'rgba(59, 130, 246, 0.1)',
        border: '#3b82f6',
        text: '#3b82f6',
        glow: 'none',
      };
    case 'C':
      return {
        bg: 'rgba(107, 114, 128, 0.1)',
        border: '#4b5563',
        text: '#6b7280',
        glow: 'none',
      };
  }
}

/** Filter signals to only show the relevant tiers */
export function filterByTier(
  signals: { edgeScore: number }[],
  minTier: SignalTier = 'B',
): { edgeScore: number }[] {
  const minScore = minTier === 'A+' ? 90 : minTier === 'A' ? 85 : minTier === 'B' ? 75 : 0;
  return signals.filter(s => s.edgeScore >= minScore);
}
