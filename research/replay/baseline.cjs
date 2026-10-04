// (a) Do pattern entries beat RANDOM entries with the same exit rules?
// (b) Are the only net-positive cells statistically real?
const { simulate, atrAt } = require('./sim.cjs');
const { S, results } = require('./analyze.cjs');

const atrOf = s => atrAt(s.symbol, s.timeframe === '15m' ? 15 : 5, s.detected_at);
const atr3 = s => { const a = atrOf(s); return a > 0 ? (s.direction === 'long' ? s.entry - 3 * a : s.entry + 3 * a) : NaN; };

// Random twin for each real setup: same symbol, timeframe, time of entry, same ATR-3 stop
// and a target at the same R multiple — but a coin-flip direction. If the pattern's chosen
// direction carries information, real setups should beat their random twins.
let seed = 777; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const real = results['ATR x3 (ignore pattern stop)'];
const twins = [];
for (const x of real) {
  const s = x.s;
  const Rreal = Math.abs(s.entry - atr3(s));
  const tgtR = Math.abs(s.target - s.entry) / Rreal;
  const dir = rnd() < 0.5 ? 'long' : 'short';
  const d = dir === 'long' ? 1 : -1;
  const t = { ...s, direction: dir, target: s.entry + d * tgtR * Rreal };
  const r = simulate(t, { stop: atr3 });
  if (r) twins.push(r);
}
const m = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => { const u = m(a); return Math.sqrt(a.reduce((x, y) => x + (y - u) ** 2, 0) / (a.length - 1)); };
const tstat = a => m(a) / (sd(a) / Math.sqrt(a.length));
console.log('=== (a) Real pattern entries vs random-direction twins (ATR x3 stop) ===');
console.log(`real    n${real.length}  gross ${m(real.map(x => x.r.gross)).toFixed(3)}R  net ${m(real.map(x => x.r.net)).toFixed(3)}R`);
console.log(`random  n${twins.length}  gross ${m(twins.map(x => x.gross)).toFixed(3)}R  net ${m(twins.map(x => x.net)).toFixed(3)}R`);

console.log('\n=== (b) t-statistics on per-trade net R (|t| >= 2 needed, before multiple-testing correction) ===');
const cells = [
  ['Bearish Engulfing short, ATR x3', results['ATR x3 (ignore pattern stop)'], 'Bearish Engulfing|short'],
  ['Shooting Star short, ATR x3', results['ATR x3 (ignore pattern stop)'], 'Shooting Star|short'],
  ['H&S short, LIVE stop', results['LIVE  tightest(pattern,1.5ATR,1%)'], 'Head & Shoulders|short'],
  ['Bearish Engulfing short, LIVE stop', results['LIVE  tightest(pattern,1.5ATR,1%)'], 'Bearish Engulfing|short'],
];
for (const [lab, arr, key] of cells) {
  const a = arr.filter(x => x.s.pattern + '|' + x.s.direction === key).map(x => x.r.net);
  console.log(`${lab.padEnd(38)} n${String(a.length).padStart(5)}  mean ${m(a) >= 0 ? '+' : ''}${m(a).toFixed(3)}R  sd ${sd(a).toFixed(2)}  t = ${tstat(a).toFixed(2)}`);
}
console.log('\n48 pattern×stop cells were examined; a Bonferroni-corrected bar for one real winner is |t| ≈ 3.1.');
