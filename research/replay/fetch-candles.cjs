// Fetch (or extend) Bybit USDT-perp 1-minute candles into data/k1m/<SYMBOL>.json.
//   node research/replay/fetch-candles.cjs [startISO]     (default 2026-09-07)
// Bybit linear is the same market the live engine prices from.
const fs = require('fs');
const path = require('path');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOGEUSDT', 'ADAUSDT', 'DOTUSDT'];
const dir = path.join(__dirname, 'data', 'k1m');
fs.mkdirSync(dir, { recursive: true });
const defaultStart = Date.parse((process.argv[2] ?? '2026-09-07') + 'T00:00:00Z');
(async () => {
  for (const s of SYMBOLS) {
    const f = path.join(dir, `${s}.json`);
    const existing = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
    const bars = new Map(existing.map(r => [r[0], r]));
    let cur = existing.length ? existing.at(-1)[0] + 60000 : defaultStart;
    const end = Date.now();
    while (cur < end) {
      const u = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${s}&interval=1&start=${cur}&end=${cur + 1000 * 60000 - 1}&limit=1000`;
      let j;
      for (let a = 0; a < 4; a++) { try { j = await (await fetch(u)).json(); break; } catch { await new Promise(r => setTimeout(r, 1500)); } }
      for (const k of (j?.result?.list || [])) bars.set(+k[0], [+k[0], +k[1], +k[2], +k[3], +k[4]]);
      cur += 1000 * 60000;
      await new Promise(r => setTimeout(r, 150));
    }
    const out = [...bars.values()].sort((a, b) => a[0] - b[0]);
    fs.writeFileSync(f, JSON.stringify(out));
    console.log(s.padEnd(9), out.length, 'bars →', new Date(out.at(-1)[0]).toISOString());
  }
})();
