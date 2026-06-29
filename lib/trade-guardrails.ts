import type { ActiveSignal } from '@/hooks/usePatternDetection';
import type { Trade } from './trade-manager';

/**
 * Deterministic guardrail checks run before every paper trade is opened. This is the
 * enforcement layer the rest of the app defers to — useTradeManager.openTrade() must call
 * canOpenTrade() and refuse to proceed on rejection, so a bad trade can never enter the
 * journal silently. Every rule has a fixed, explainable reason a user can see in the
 * rejection toast — nothing here is a guess or a model call.
 */

export const GUARDRAILS = {
  MIN_RISK_REWARD: 1.5,
  MAX_TRADES_PER_DAY: 10,
} as const;

export type GuardrailResult = { allowed: true } | { allowed: false; reason: string };

export function canOpenTrade(
  signal: ActiveSignal,
  activeTrade: Trade | null,
  todayTradeCount: number,
): GuardrailResult {
  if (activeTrade) {
    return { allowed: false, reason: 'An active trade already exists for this symbol — close or cancel it before opening another.' };
  }

  if (todayTradeCount >= GUARDRAILS.MAX_TRADES_PER_DAY) {
    return { allowed: false, reason: `Daily trade limit reached (${GUARDRAILS.MAX_TRADES_PER_DAY}) — no more paper trades today.` };
  }

  if (!Number.isFinite(signal.riskReward) || signal.riskReward < GUARDRAILS.MIN_RISK_REWARD) {
    return { allowed: false, reason: `R:R ${signal.riskReward}:1 is below the ${GUARDRAILS.MIN_RISK_REWARD}:1 minimum — not opening.` };
  }

  // Level sanity: stop must be on the losing side, target on the winning side. If the signal
  // itself ever produced an inverted setup, this is the last line of defense before it becomes
  // a real (paper) position.
  if (signal.direction === 'LONG' && (signal.stop >= signal.entry || signal.target <= signal.entry)) {
    return { allowed: false, reason: 'Invalid LONG levels — stop must be below entry and target above entry.' };
  }
  if (signal.direction === 'SHORT' && (signal.stop <= signal.entry || signal.target >= signal.entry)) {
    return { allowed: false, reason: 'Invalid SHORT levels — stop must be above entry and target below entry.' };
  }

  return { allowed: true };
}

export function countTradesToday(history: Trade[]): number {
  const today = new Date().toDateString();
  return history.filter(t => new Date(t.signalTime * 1000).toDateString() === today).length;
}
