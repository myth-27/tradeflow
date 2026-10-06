/**
 * Self-check for the triple-barrier labeller. Exits non-zero on any failure.
 *   npx tsx research/replay/check-labeller.ts
 *
 * Synthetic 1m paths with ATR = 1 and entry 100, so the expected outcomes can be
 * worked out by hand from the cost model in lib/server/costs.ts.
 */
import { barrier, CONFIGS } from './label-signals';
import { MAKER_FEE, STOP_SLIPPAGE, TAKER_FEE } from '../../lib/server/costs';

type K1 = [number, number, number, number, number];
const c = CONFIGS[0]; // profit 2×ATR, stop 1×ATR, 48 bars
const t0 = Date.UTC(2026, 9, 1, 0, 0);
const sig = (direction: string, detected_at = t0) =>
  ({ id: 'x', symbol: 'T', timeframe: '5m', direction, entry: 100, detected_at, pattern: 'p' });
const path = (bars: number[][]): K1[] => bars.map((b, i) => [t0 + i * 60000, b[0], b[1], b[2], b[3]] as K1);
const flat = (n: number) => Array.from({ length: n }, () => [100, 100.2, 99.8, 100]);

// Hand-computed net R (R = 1 price unit)
const profitR = 2 - (100 * TAKER_FEE + 102 * MAKER_FEE);
const stopPx = 99 * (1 - STOP_SLIPPAGE);
const stopR = (stopPx - 100) - (100 * TAKER_FEE + stopPx * TAKER_FEE);
const gapPx = 97 * (1 - STOP_SLIPPAGE);
const gapR = (gapPx - 100) - (100 * TAKER_FEE + gapPx * TAKER_FEE);
const timeR = 0 - (100 * TAKER_FEE + 100 * TAKER_FEE);

let failed = 0;
function expect(name: string, got: ReturnType<typeof barrier>, label: number | null, r?: number, minutes?: number) {
  const ok = label === null
    ? got === null
    : got !== null && got.label === label &&
      (r === undefined || Math.abs(got.ret_r_net - r) < 1e-9) &&
      (minutes === undefined || got.minutes_to_exit === minutes);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got ? ` → label ${got.label}, ${got.ret_r_net.toFixed(4)}R, ${got.minutes_to_exit}m` : ' → null'}`);
}

expect('long reaches profit barrier', barrier(sig('long'), path([[100, 101, 99.5, 100.8], [100.8, 102.3, 100.5, 102]]), 1, c), 1, profitR);
expect('long hits stop', barrier(sig('long'), path([[100, 100.2, 98.9, 99]]), 1, c), -1, stopR);
expect('stop gapped through fills at the open', barrier(sig('long'), path([[100, 100.1, 99.9, 100], [97, 97.5, 96.5, 97]]), 1, c), -1, gapR);
expect('both barriers in one bar → stop (conservative)', barrier(sig('long'), path([[100, 103, 98, 101]]), 1, c), -1, stopR);
expect('short reaches profit barrier', barrier(sig('short'), path([[100, 100.5, 97.9, 98]]), 1, c), 1,
  2 - (100 * TAKER_FEE + 98 * MAKER_FEE));
expect('time limit = 48 × 5m', barrier(sig('long'), path(flat(300)), 1, c), 0, timeR, 240);
expect('data ends before the limit → unlabelled', barrier(sig('long'), path(flat(100)), 1, c), null);
expect('no candle at signal time → unlabelled', barrier(sig('long', t0 - 10 * 60000), path(flat(10)), 1, c), null);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
