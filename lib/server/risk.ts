import { setState } from './db';

/** Auto-halt when equity falls this far below its peak. Restart is manual (clear `halted`). */
export const MAX_DRAWDOWN_PCT = 0.10;

/**
 * Track the equity high-water mark and halt the engine once equity sits
 * MAX_DRAWDOWN_PCT below it. The account fell 30% between 8 Sep and 4 Oct with no
 * circuit breaker; this stops a run at -10% and waits for a human.
 *
 * Returns true if the engine is (now) halted for drawdown.
 */
export async function enforceDrawdownHalt(state: Record<string, string>, equity: number): Promise<boolean> {
  const storedPeak = parseFloat(state['equity_hwm'] ?? '') || 0;
  const peak = Math.max(storedPeak, equity);
  if (peak > storedPeak) await setState('equity_hwm', String(peak));

  if (equity > peak * (1 - MAX_DRAWDOWN_PCT)) return false;

  if (state['halted'] !== 'true') {
    await setState('halted', 'true');
    await setState('halt_reason',
      `drawdown: equity ${equity.toFixed(0)} is ${(100 * (1 - equity / peak)).toFixed(1)}% below peak ${peak.toFixed(0)}`);
    console.warn(`[risk] HALTED — equity ${equity.toFixed(0)} vs peak ${peak.toFixed(0)}`);
  }
  return true;
}
