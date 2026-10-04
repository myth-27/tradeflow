// How often does "positive in all 4 periods" pass by pure chance?
// Rebuild the same kind of rule grid the 2 Oct replay searched, count the combos that pass,
// then destroy any real relationship between rule features and outcomes by shuffling the
// outcomes WITHIN each period (so every period keeps its own overall drift) and count again.
const { S, results } = require('./analyze.cjs');
const L = results['LIVE  tightest(pattern,1.5ATR,1%)'].filter(x => x.s.p >= 0 && x.s.p <= 3); // P1-P4 only, as the replay used

const up = s => /uptrend/.test(s.htf), dn = s => /downtrend/.test(s.htf);
const TR = { any: () => true, with: s => (s.direction === 'long' && up(s)) || (s.direction === 'short' && dn(s)), against: s => (s.direction === 'long' && dn(s)) || (s.direction === 'short' && up(s)) };
const TF = { any: () => true, '5m': s => s.timeframe === '5m', '15m': s => s.timeframe === '15m' };
const MAJ = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT']);
const SY = { all: () => true, majors: s => MAJ.has(s.symbol), alts: s => !MAJ.has(s.symbol) };
const PAT = [...new Set(L.map(x => x.s.pattern + '|' + x.s.direction)), 'ALL|short', 'ALL|long', 'ALL|any'];

// Precompute membership of every combo once.
const combos = [];
for (const pd of PAT) for (const tf_ of Object.values(TR)) for (const ff of Object.values(TF)) for (const yf of Object.values(SY)) {
  const [p, dir] = pd.split('|');
  const members = [];
  L.forEach((x, i) => { const s = x.s; if ((p === 'ALL' || s.pattern === p) && (dir === 'any' || s.direction === dir) && tf_(s) && ff(s) && yf(s)) members.push(i); });
  if (members.length >= 40) combos.push(members);
}

function countPassing(R) {
  let pass = 0;
  for (const m of combos) {
    const tot = [0, 0, 0, 0], n = [0, 0, 0, 0];
    for (const i of m) { tot[L[i].s.p] += R[i]; n[L[i].s.p]++; }
    if (n.every(v => v >= 5) && tot.every(v => v > 0)) pass++;
  }
  return pass;
}

const gross = L.map(x => x.r.gross), net = L.map(x => x.r.net);
console.log(`rule combos searched (n>=40): ${combos.length}`);
console.log(`"positive in all 4 periods" — GROSS (as the replay did): ${countPassing(gross)}`);
console.log(`"positive in all 4 periods" — NET of costs:              ${countPassing(net)}`);

// Null: shuffle gross outcomes within each period.
const byP = [0, 1, 2, 3].map(p => L.map((x, i) => x.s.p === p ? i : -1).filter(i => i >= 0));
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const nulls = [];
for (let k = 0; k < 300; k++) {
  const R = new Array(L.length);
  for (const idxs of byP) {
    const vals = idxs.map(i => gross[i]);
    for (let j = vals.length - 1; j > 0; j--) { const r = Math.floor(rnd() * (j + 1)); [vals[j], vals[r]] = [vals[r], vals[j]]; }
    idxs.forEach((i, j) => { R[i] = vals[j]; });
  }
  nulls.push(countPassing(R));
}
nulls.sort((a, b) => a - b);
const obs = countPassing(gross);
console.log(`\nSHUFFLED (no real signal), 300 runs: median ${nulls[150]}, 5th–95th pct ${nulls[15]}–${nulls[285]}, max ${nulls.at(-1)}`);
console.log(`share of shuffled runs with at least as many passing combos as the real data: ${Math.round(100 * nulls.filter(v => v >= obs).length / nulls.length)}%`);
