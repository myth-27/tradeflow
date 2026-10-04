// Does sim2 reproduce the live paper trades? Replay each real trade with its real
// entry, initial stop, TP1 and TP2, then compare outcome and R.
const { simulate } = require('./sim.cjs');
const S = require('./data/state.json');

const rows = [];
for (const t of S.closedTrades) {
  const long = t.direction === 'long', dir = long ? 1 : -1;
  const R = Math.abs(t.tp1 - t.entry) / 1.5;            // TP1 is always entry ± 1.5R
  const initialStop = t.entry - dir * R;               // stored stop may have been moved to BE/trail
  const sig = { ...t, detected_at: +t.opened_at, stop_loss: initialStop, target: t.tp2 };
  const r = simulate(sig, { stop: () => initialStop, tp2: () => t.tp2 });
  const liveR = t.pnl_abs / (t.size * R);
  rows.push({ t, r, liveR });
}
const ok = rows.filter(x => x.r);
const agree = ok.filter(x => Math.sign(x.r.gross) === Math.sign(x.liveR) || (Math.abs(x.r.gross) < 0.05 && Math.abs(x.liveR) < 0.05)).length;
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
console.log(`replayable ${ok.length}/${rows.length}`);
console.log(`direction of outcome agrees: ${agree}/${ok.length} (${Math.round(100 * agree / ok.length)}%)`);
console.log(`total R  live ${sum(ok, x => x.liveR).toFixed(1)}  |  sim gross ${sum(ok, x => x.r.gross).toFixed(1)}  |  sim net of costs ${sum(ok, x => x.r.net).toFixed(1)}`);
console.log(`avg cost per trade: ${(sum(ok, x => x.r.cost) / ok.length).toFixed(3)}R   (median ${[...ok.map(x => x.r.cost)].sort((a, b) => a - b)[ok.length >> 1].toFixed(3)}R)`);
const mism = ok.filter(x => Math.sign(x.r.gross) !== Math.sign(x.liveR) && !(Math.abs(x.r.gross) < 0.05 && Math.abs(x.liveR) < 0.05));
console.log(`\nmismatches (${mism.length}), first 10:`);
for (const x of mism.slice(0, 10)) console.log(`  ${x.t.symbol} ${x.t.direction} ${x.t.pattern.padEnd(18)} live ${x.liveR.toFixed(2)}R (${x.t.exit_reason}) vs sim ${x.r.gross.toFixed(2)}R (${x.r.exit})`);
