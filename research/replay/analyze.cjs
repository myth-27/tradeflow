// Every logged signal, deduped, replayed under several stop rules, gross vs net of costs.
const { simulate, atrAt } = require('./sim.cjs');
const d = require('./data/db.json');
// Optional: 1h regime per signal id (only used for the with/against-trend split)
let H = {}; try { H = require('./data/htf.json'); } catch { /* no trend labels */ }

// Periods. P5 is everything after the current rules went live — data the replay never saw.
const P = [
  ['P1 Sep08-09', '2026-09-08', '2026-09-10'],
  ['P2 Sep10-11', '2026-09-10', '2026-09-12'],
  ['P3 Sep26-29', '2026-09-26', '2026-09-30'],
  ['P4 Sep30-Oct2', '2026-09-30', '2026-10-02T15:28'],
  ['P5 Oct2-now (OOS)', '2026-10-02T15:28', '2026-10-05'],
].map(([n, a, b]) => [n, Date.parse(a + (a.length === 10 ? 'T00:00Z' : 'Z')), Date.parse(b + (b.length === 10 ? 'T00:00Z' : 'Z'))]);
const period = t => P.findIndex(p => t >= p[1] && t < p[2]);

const raw = d.signals.map(s => ({ ...s, detected_at: +s.detected_at, entry: +s.entry, stop_loss: +s.stop_loss, target: +s.target, htf: H[s.id] || 'na' }))
  .sort((a, b) => a.detected_at - b.detected_at);
// The engine re-detects the same setup every candle; count it once per 30 minutes.
const last = {}; const S = [];
for (const s of raw) { const k = s.symbol + s.timeframe + s.pattern + s.direction; if (last[k] && s.detected_at - last[k] < 30 * 6e4) continue; last[k] = s.detected_at; s.p = period(s.detected_at); if (s.p >= 0) S.push(s); }
console.log(`signals ${raw.length} → unique setups ${S.length}; per period ${P.map((p, i) => S.filter(s => s.p === i).length).join(' / ')}\n`);

const tighter = (s, alt) => s.direction === 'long' ? Math.max(s.stop_loss, alt) : Math.min(s.stop_loss, alt);
const atrOf = s => atrAt(s.symbol, s.timeframe === '15m' ? 15 : 5, s.detected_at);
const atrStop = k => s => { const a = atrOf(s); return a > 0 ? (s.direction === 'long' ? s.entry - k * a : s.entry + k * a) : NaN; };
const STOPS = {
  'LIVE  tightest(pattern,1.5ATR,1%)': s => { let x = s.stop_loss; const a = atrOf(s); if (a > 0) x = tighter({ ...s, stop_loss: x }, s.direction === 'long' ? s.entry - 1.5 * a : s.entry + 1.5 * a); return tighter({ ...s, stop_loss: x }, s.direction === 'long' ? s.entry * 0.99 : s.entry * 1.01); },
  'PATTERN stop as detected':          s => s.stop_loss,
  'ATR x2 (ignore pattern stop)':      atrStop(2),
  'ATR x3 (ignore pattern stop)':      atrStop(3),
};

const results = {};
for (const [name, fn] of Object.entries(STOPS)) {
  results[name] = S.map(s => ({ s, r: simulate(s, { stop: fn }) })).filter(x => x.r);
}

const stat = a => {
  if (!a.length) return null;
  const g = a.reduce((x, y) => x + y.r.gross, 0), n = a.reduce((x, y) => x + y.r.net, 0);
  return { n: a.length, wr: a.filter(x => x.r.net > 0).length / a.length, gAvg: g / a.length, nAvg: n / a.length, nTot: n, cost: a.reduce((x, y) => x + y.r.cost, 0) / a.length };
};
const line = (label, st) => st ? `${label.padEnd(30)} n${String(st.n).padStart(5)}  WR${String(Math.round(st.wr * 100)).padStart(3)}%  gross ${st.gAvg >= 0 ? '+' : ''}${st.gAvg.toFixed(3)}R  cost ${st.cost.toFixed(3)}R  NET ${st.nAvg >= 0 ? '+' : ''}${st.nAvg.toFixed(3)}R/trade  (total ${st.nTot.toFixed(0)}R)` : `${label.padEnd(30)} n0`;

console.log('=== 1. ALL SETUPS, by stop rule ===');
for (const [name, a] of Object.entries(results)) console.log(line(name, stat(a)));

console.log('\n=== 2. By pattern+direction, LIVE stop rule ===');
const keys = [...new Set(S.map(s => s.pattern + '|' + s.direction))];
const L = results['LIVE  tightest(pattern,1.5ATR,1%)'];
for (const k of keys.sort()) console.log(line(k, stat(L.filter(x => x.s.pattern + '|' + x.s.direction === k))));

console.log('\n=== 3. By pattern+direction, best-case stop (ATR x3) ===');
const A3 = results['ATR x3 (ignore pattern stop)'];
for (const k of keys.sort()) console.log(line(k, stat(A3.filter(x => x.s.pattern + '|' + x.s.direction === k))));

console.log('\n=== 4. The two setups the current rules trade, period by period (LIVE stop) ===');
for (const k of ['Head & Shoulders|short', 'Bearish Engulfing|short', 'Double Top|short']) {
  console.log(`  ${k}`);
  for (let i = 0; i < P.length; i++) console.log('    ' + line(P[i][0], stat(L.filter(x => x.s.p === i && x.s.pattern + '|' + x.s.direction === k))));
}

console.log('\n=== 5. Timeframe, LIVE stop vs ATR x3 ===');
for (const tf of ['5m', '15m']) {
  console.log(line(`${tf} LIVE`, stat(L.filter(x => x.s.timeframe === tf))));
  console.log(line(`${tf} ATRx3`, stat(A3.filter(x => x.s.timeframe === tf))));
}

console.log('\n=== 6. With vs against the 1h trend (LIVE stop) ===');
const up = s => /uptrend/.test(s.htf), dn = s => /downtrend/.test(s.htf);
console.log(line('with 1h trend', stat(L.filter(x => (x.s.direction === 'long' && up(x.s)) || (x.s.direction === 'short' && dn(x.s))))));
console.log(line('against 1h trend', stat(L.filter(x => (x.s.direction === 'long' && dn(x.s)) || (x.s.direction === 'short' && up(x.s))))));
console.log(line('1h neutral/unknown', stat(L.filter(x => !up(x.s) && !dn(x.s)))));

console.log('\n=== 7. Where the LIVE stop sits relative to market noise ===');
const ratio = L.map(x => Math.abs(x.s.entry - STOPS['LIVE  tightest(pattern,1.5ATR,1%)'](x.s)) / atrOf(x.s)).filter(Number.isFinite).sort((a, b) => a - b);
const q = p => ratio[Math.floor(p * ratio.length)].toFixed(2);
console.log(`  stop distance in ATRs — p10 ${q(0.1)}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  p90 ${q(0.9)}`);
const fast = L.filter(x => x.r.exit === 'stop' && !x.r.hit1);
console.log(`  full stop-outs: ${fast.length}/${L.length}; within 15 min: ${Math.round(100 * fast.filter(x => x.r.min < 15).length / fast.length)}%`);

module.exports = { S, P, STOPS, results };
