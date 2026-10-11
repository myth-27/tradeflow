// Fetch (or extend) Bybit USDT-perp 1-minute candles into data/k1m/<SYMBOL>.json.
//   node research/replay/fetch-candles.cjs [startISO]            (default 2026-08-15)
//   node research/replay/fetch-candles.cjs [startISO] --repair   re-download everything
// Giving an earlier start than the stored data backfills the gap.
// Bybit linear is the same market the live engine prices from.
//
// The minute that is still forming is never stored: Bybit returns it with partial
// high/low/close, and earlier versions saved it at the end of every run and never
// revisited it (found 2026-10-11: 5 corrupted ETH bars, one at each past run's end).
// Each run also re-fetches the last OVERLAP_MIN minutes so a bad tail heals itself.
// --repair re-downloads the full stored range and overwrites every bar.
const fs = require('fs');
const path = require('path');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOGEUSDT', 'ADAUSDT', 'DOTUSDT'];
const OVERLAP_MIN = 5;
const dir = path.join(__dirname, 'data', 'k1m');
fs.mkdirSync(dir, { recursive: true });
const args = process.argv.slice(2);
const repair = args.includes('--repair');
const startArg = args.find(a => !a.startsWith('--'));
const defaultStart = Date.parse((startArg ?? '2026-08-15') + 'T00:00:00Z');

(async () => {
  for (const s of SYMBOLS) {
    const f = path.join(dir, `${s}.json`);
    const existing = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
    const bars = new Map(existing.map(r => [r[0], r]));
    const now = Date.now();
    // Ranges to (re)fetch: missing history before the first stored bar, then from a
    // few minutes before the last stored bar to now — or everything, in repair mode.
    const ranges = [];
    if (!existing.length) ranges.push([defaultStart, now]);
    else if (repair) ranges.push([Math.min(defaultStart, existing[0][0]), now]);
    else {
      if (defaultStart < existing[0][0]) ranges.push([defaultStart, existing[0][0]]);
      ranges.push([existing.at(-1)[0] - OVERLAP_MIN * 60000, now]);
    }
    let replaced = 0;
    for (const [start, end] of ranges) {
      let cur = start;
      while (cur < end) {
        const u = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${s}&interval=1&start=${cur}&end=${cur + 1000 * 60000 - 1}&limit=1000`;
        let j;
        for (let a = 0; a < 4; a++) { try { j = await (await fetch(u)).json(); break; } catch { await new Promise(r => setTimeout(r, 1500)); } }
        for (const k of (j?.result?.list || [])) {
          const t = +k[0];
          if (t + 60000 > now) continue; // still forming — never store it
          const bar = [t, +k[1], +k[2], +k[3], +k[4]];
          const old = bars.get(t);
          if (old && old.some((v, i) => v !== bar[i])) replaced++;
          bars.set(t, bar);
        }
        cur += 1000 * 60000;
        await new Promise(r => setTimeout(r, 150));
      }
    }
    const out = [...bars.values()].sort((a, b) => a[0] - b[0]);
    fs.writeFileSync(f, JSON.stringify(out));
    console.log(s.padEnd(9), out.length, 'bars', new Date(out[0][0]).toISOString(), '→', new Date(out.at(-1)[0]).toISOString(), replaced ? `| corrected ${replaced}` : '');
  }
})();
