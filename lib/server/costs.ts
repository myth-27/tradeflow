// Trading costs. Every P&L figure the engine records is NET of these.
//
// Replaying all 153 paper trades (8 Sep – 4 Oct) against Bybit 1m candles: the
// engine recorded -31R; the replay, which also fills stops that gap at the price
// actually reached, put it at -37R gross and -79R once fees and stop slippage
// are charged. Costs averaged 0.28R per trade, and 0.60R per trade across all
// logged setups under the old "tightest stop" rule. A strategy that ignores this
// cannot be evaluated, so costs are part of the fill, not an afterthought.

/**
 * Read a numeric env override that may only make the engine MORE conservative.
 * Values below `floor` (or missing / malformed) fall back to `floor`, so a deploy
 * variable can raise fees or the stop floor but never quietly lower them — that
 * takes a reviewed code change (see docs/PLAN_HISTORY.md, 2026-10-04).
 */
function atLeast(name: string, floor: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return floor;
  if (n < floor) {
    console.warn(`[config] ${name}=${raw} is below the reviewed floor ${floor}; using ${floor}`);
    return floor;
  }
  return n;
}

/** Bybit USDT-perp base tier. Market orders (entries, stops, timeouts). */
export const TAKER_FEE = atLeast('TAKER_FEE', 0.00055);
/** Bybit USDT-perp base tier. Resting limit orders (take-profits). */
export const MAKER_FEE = atLeast('MAKER_FEE', 0.0002);
/** Extra adverse slippage applied to every stop fill, as a fraction of price. */
export const STOP_SLIPPAGE = atLeast('STOP_SLIPPAGE', 0.0001);

/**
 * Minimum stop distance as a fraction of entry. Round-trip taker cost is
 * 2 × 0.055% = 0.11% of price; keeping that at or under 0.1R needs a stop of at
 * least 1.1%. Tighter pattern stops are skipped, not widened.
 */
export const MIN_STOP_PCT = atLeast('MIN_STOP_PCT', 0.011);

/** Round-trip cost of a trade that enters at market and exits at market, in price units per unit. */
export function roundTripTakerCost(entry: number, exit: number): number {
  return entry * TAKER_FEE + exit * TAKER_FEE;
}

/**
 * Reward:risk measured the way the trade will actually settle: reward net of an
 * entry taker fee and a maker exit at target, risk including an entry taker fee,
 * a taker stop exit and stop slippage.
 */
export function netRiskReward(entry: number, stop: number, target: number): number {
  const reward = Math.abs(target - entry) - entry * TAKER_FEE - target * MAKER_FEE;
  const risk = Math.abs(entry - stop) + entry * TAKER_FEE + stop * (TAKER_FEE + STOP_SLIPPAGE);
  return risk > 0 ? reward / risk : 0;
}

/** Stop fill price: the stop, or the observed price if it already traded through, minus slippage. */
export function stopFillPrice(direction: 'long' | 'short', stop: number, observed: number): number {
  const through = direction === 'long' ? observed < stop : observed > stop;
  const px = through ? observed : stop;
  return direction === 'long' ? px * (1 - STOP_SLIPPAGE) : px * (1 + STOP_SLIPPAGE);
}
