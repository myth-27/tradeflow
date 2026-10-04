// Cost-aware replay of the live exit logic.
// Same mechanics as the earlier sim.js (1m bars, stop checked before target in each bar,
// TP1 50% partial -> stop to breakeven -> 1.5xATR trail, pattern target = TP2, 48h max),
// plus what it left out:
//   * Bybit linear fees: taker 0.055% (market entry, stop, timeout), maker 0.02% (TP limits)
//   * stops that gap: if a bar OPENS beyond the stop, fill at the open, not at the stop
//   * 0.01% extra slippage on every stop fill
const fs = require('fs');
const K = {};
for (const f of fs.readdirSync(__dirname + '/data/k1m')) K[f.replace('.json', '')] = JSON.parse(fs.readFileSync(__dirname + '/data/k1m/' + f));
const LAST = Math.min(...Object.values(K).map(a => a.at(-1)[0]));

const TAKER = 0.00055, MAKER = 0.0002, STOP_SLIP = 0.0001;

const idx = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m][0] < t) lo = m + 1; else hi = m; } return lo; };

const atrCache = new Map();
function atrAt(sym, tfMin, t, period = 14) {
  const key = sym + tfMin + Math.floor(t / (tfMin * 60000));
  if (atrCache.has(key)) return atrCache.get(key);
  const a = K[sym]; const i = idx(a, t); const n = (period + 1) * tfMin;
  if (i < n) return 0;
  const bars = [];
  for (let s = i - n; s < i; s += tfMin) {
    const sl = a.slice(s, s + tfMin);
    bars.push([Math.max(...sl.map(x => x[2])), Math.min(...sl.map(x => x[3])), sl.at(-1)[4]]);
  }
  let tr = 0;
  for (let j = 1; j < bars.length; j++) tr += Math.max(bars[j][0] - bars[j][1], Math.abs(bars[j][0] - bars[j - 1][2]), Math.abs(bars[j][1] - bars[j - 1][2]));
  const v = tr / (bars.length - 1);
  atrCache.set(key, v);
  return v;
}

/**
 * opt.stop(sig) -> stop price; opt.tp1R (default 1.5); opt.tp2(sig,e,R,dir) -> price (default pattern target)
 * opt.partial (default true); opt.maxH (default 48)
 * returns { gross, net, exit, hit1, min } in R units of the INITIAL risk, or null if unresolved/no data.
 */
function simulate(sig, opt = {}) {
  const a = K[sig.symbol]; if (!a) return null;
  const long = sig.direction === 'long', dir = long ? 1 : -1;
  const e = +sig.entry;
  const sl0 = opt.stop ? opt.stop(sig) : +sig.stop_loss;
  const R = Math.abs(e - sl0); if (!(R > 0)) return null;
  if (long ? sl0 >= e : sl0 <= e) return null;
  let i = idx(a, +sig.detected_at);
  if (i >= a.length || a[i][0] - sig.detected_at > 3 * 60000) return null;
  const tfMin = sig.timeframe === '15m' ? 15 : 5;
  const end = +sig.detected_at + (opt.maxH || 48) * 3600e3;
  // If the data runs out before the 48h timeout, only trades that actually hit a stop or
  // target in the available bars are resolved; anything still open is dropped below.
  const dataRunsOut = end > LAST;
  const tp1R = opt.tp1R ?? 1.5;
  const partial = opt.partial !== false;
  const tp1 = e + dir * R * tp1R;
  const tp2 = opt.tp2 ? opt.tp2(sig, e, R, dir) : +sig.target;
  if (long ? tp2 <= e : tp2 >= e) return null;

  let hit1 = false, stop = sl0, lastAtrT = 0, atr = 0;
  // cost in R: fee fraction * price / R
  const feeR = (rate, px) => rate * px / R;
  const entryCost = feeR(TAKER, e);

  const finish = (exitPx, exitRate, exitKind, t) => {
    const legR = (exitPx - e) * dir / R;
    let gross, cost;
    if (hit1 && partial) {
      gross = 0.5 * tp1R + 0.5 * legR;
      cost = entryCost + 0.5 * feeR(MAKER, tp1) + 0.5 * feeR(exitRate, exitPx);
    } else {
      gross = legR;
      cost = entryCost + feeR(exitRate, exitPx);
    }
    return { gross, net: gross - cost, cost, exit: exitKind, hit1, min: (t - sig.detected_at) / 6e4 };
  };

  for (; i < a.length && a[i][0] < end; i++) {
    const [t, o, h, l, c] = a[i];
    const adv = long ? l : h, fav = long ? h : l;
    if (long ? adv <= stop : adv >= stop) {
      // gap through the stop fills at the open; then pay slippage
      let px = (long ? o < stop : o > stop) ? o : stop;
      px = px * (1 - dir * STOP_SLIP);
      return finish(px, TAKER, 'stop', t);
    }
    if (long ? fav >= tp2 : fav <= tp2) return finish(tp2, MAKER, 'tp2', t);
    if (partial && !hit1 && (long ? fav >= tp1 : fav <= tp1)) { hit1 = true; stop = e; continue; }
    if (hit1 && partial) {
      if (t - lastAtrT >= tfMin * 60000) { atr = atrAt(sig.symbol, tfMin, t); lastAtrT = t; }
      if (atr > 0) { const ts = long ? Math.max(c - atr * 1.5, e) : Math.min(c + atr * 1.5, e); if (long ? ts > stop : ts < stop) stop = ts; }
    }
  }
  if (dataRunsOut) return null; // still open when the data ends — outcome unknown
  const c = a[i - 1][4];
  return finish(c, TAKER, 'time', a[i - 1][0]);
}

module.exports = { K, LAST, simulate, atrAt, TAKER, MAKER };
