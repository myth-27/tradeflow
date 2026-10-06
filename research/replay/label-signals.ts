/**
 * Label EVERY logged signal with triple-barrier outcomes, net of costs, and
 * backfill its multi-timeframe trend features. Writes to the Railway DB tables
 * `signal_labels` and `signal_features` (created by the engine's initDb).
 *
 *   npx tsx research/replay/label-signals.ts
 *
 * Connection: DBURL env var, or research/replay/data/.dburl (gitignored).
 * Re-runnable: only signals without a label/feature row are processed, so run it
 * daily to label new signals once their time window has passed.
 *
 * No lookahead: features and ATR use only bars that CLOSED before the signal.
 * Outcomes walk Bybit 1m candles forward from the signal: stop checked before the
 * profit barrier in every bar, a stop gapped through fills at the bar open.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { FEATURE_VERSION, atr, mtfTrend, type Bar } from '../../lib/features';
import { MAKER_FEE, STOP_SLIPPAGE, TAKER_FEE } from '../../lib/server/costs';

const DIR = path.join(__dirname, 'data');

/** Barrier sets. Stored per row, so more can be added later without relabelling. */
export const CONFIGS = [
  { config: 'tb_2x1_48', pt: 2, sl: 1, maxBars: 48 },
  { config: 'tb_3x1.5_48', pt: 3, sl: 1.5, maxBars: 48 },
];
const TF_MIN: Record<string, number> = { '5m': 5, '15m': 15, '1h': 60 };

type K1 = [number, number, number, number, number]; // [openMs, o, h, l, c]

function dbUrl(): string {
  if (process.env.DBURL) return process.env.DBURL;
  const f = path.join(DIR, '.dburl');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  throw new Error('Set DBURL or write the connection string to research/replay/data/.dburl');
}

/** Aggregate 1m bars into complete `min`-minute bars (time in seconds, bar open). */
function aggregate1m(k: K1[], min: number): Bar[] {
  const span = min * 60000;
  const out: Bar[] = [];
  let cur: Bar | null = null, count = 0, curStart = -1;
  for (const [t, o, h, l, c] of k) {
    const g = Math.floor(t / span) * span;
    if (g !== curStart) {
      if (cur && count === min) out.push(cur);
      cur = { time: g / 1000, open: o, high: h, low: l, close: c }; count = 1; curStart = g;
    } else if (cur) {
      cur.high = Math.max(cur.high, h); cur.low = Math.min(cur.low, l); cur.close = c; count++;
    }
  }
  if (cur && count === min) out.push(cur);
  return out;
}

/** Index of the first element whose key >= x. */
function lowerBound(n: number, key: (i: number) => number, x: number): number {
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (key(m) < x) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * The live engine's candle buffer holds the last 500 closed bars per timeframe
 * (lib/server/candle-store.ts). Hand the feature code exactly that, so offline
 * features match live ones — in particular 4h bars, which are built from the
 * 1h buffer (500 × 1h → ~125 complete 4h bars ≥ FEATURE_WINDOW).
 */
const LIVE_BUFFER = 500;

/** The last LIVE_BUFFER bars of `tfMin` that closed at or before time t (ms). */
function closedBefore(bars: Bar[], tfMin: number, tMs: number): Bar[] {
  const end = lowerBound(bars.length, i => bars[i].time * 1000 + tfMin * 60000, tMs + 1);
  return bars.slice(Math.max(0, end - LIVE_BUFFER), end);
}

interface Sig { id: string; symbol: string; timeframe: string; direction: string; entry: number; detected_at: number; pattern: string }

export function barrier(sig: Sig, k: K1[], atrVal: number, c: typeof CONFIGS[number]) {
  const long = sig.direction === 'long', dir = long ? 1 : -1;
  const e = sig.entry;
  const R = c.sl * atrVal;
  const pt = e + dir * c.pt * atrVal;
  const sl = e - dir * R;
  let i = lowerBound(k.length, j => k[j][0], sig.detected_at);
  if (i >= k.length || k[i][0] - sig.detected_at > 3 * 60000) return null; // no candles at signal time
  const deadline = sig.detected_at + c.maxBars * (TF_MIN[sig.timeframe] ?? 15) * 60000;

  const done = (exitPx: number, exitFee: number, label: number, reason: string, t: number) => {
    const gross = (exitPx - e) * dir;
    const fees = e * TAKER_FEE + exitPx * exitFee;
    const net = gross - fees;
    return { label, ret_r_net: net / R, ret_pct_net: (net / e) * 100, exit_reason: reason, minutes_to_exit: (t - sig.detected_at) / 60000 };
  };

  for (; i < k.length && k[i][0] < deadline; i++) {
    const [t, o, h, l] = k[i];
    if (long ? l <= sl : h >= sl) {
      const through = long ? o < sl : o > sl;
      const px = (through ? o : sl) * (1 - dir * STOP_SLIPPAGE);
      return done(px, TAKER_FEE, -1, 'stop', t);
    }
    if (long ? h >= pt : l <= pt) return done(pt, MAKER_FEE, 1, 'profit', t);
  }
  if (i >= k.length) return null; // data ends before the time limit — label on a later run
  const last = k[i - 1];
  return done(last[4], TAKER_FEE, 0, 'time', last[0] + 60000);
}

async function main() {
  console.log('extending Bybit 1m candles…');
  execFileSync(process.execPath, [path.join(__dirname, 'fetch-candles.cjs')], { stdio: 'inherit' });

  const K: Record<string, K1[]> = {};
  const B: Record<string, Record<string, Bar[]>> = {};
  for (const f of fs.readdirSync(path.join(DIR, 'k1m'))) {
    const sym = f.replace('.json', '');
    K[sym] = JSON.parse(fs.readFileSync(path.join(DIR, 'k1m', f), 'utf8'));
    B[sym] = { '5m': aggregate1m(K[sym], 5), '15m': aggregate1m(K[sym], 15), '1h': aggregate1m(K[sym], 60) };
  }

  const pool = new Pool({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false }, max: 3 });
  const exists = async (t: string) => (await pool.query('SELECT to_regclass($1) r', [t])).rows[0].r !== null;
  if (!(await exists('signal_labels')) || !(await exists('signal_features'))) {
    throw new Error('signal_labels / signal_features do not exist yet — deploy the engine first (initDb creates them).');
  }

  const signals: Sig[] = (await pool.query(
    'SELECT id, symbol, timeframe, direction, entry, detected_at, pattern FROM signal_log ORDER BY detected_at',
  )).rows.map((r: Record<string, unknown>) => ({ ...r, entry: Number(r.entry), detected_at: Number(r.detected_at) }) as Sig);
  const haveLabel = new Set((await pool.query('SELECT signal_id, config FROM signal_labels')).rows.map((r: { signal_id: string; config: string }) => r.signal_id + '|' + r.config));
  // A feature row counts as done if the live engine wrote it, or if a backfill filled every
  // value. Backfilled rows with gaps (too little candle history at the time) are recomputed.
  const haveFeat = new Set((await pool.query(
    `SELECT signal_id FROM signal_features
      WHERE source = 'live'
         OR (trend_15m_slope IS NOT NULL AND trend_15m_pos IS NOT NULL AND trend_1h_slope IS NOT NULL
             AND trend_1h_pos IS NOT NULL AND trend_4h_slope IS NOT NULL AND trend_4h_pos IS NOT NULL)`,
  )).rows.map((r: { signal_id: string }) => r.signal_id));
  console.log(`signals ${signals.length} | already labelled ${haveLabel.size} | with complete features ${haveFeat.size}`);

  const labelRows: unknown[][] = [], featRows: unknown[][] = [];
  let noData = 0, pending = 0;
  const now = Date.now();
  for (const s of signals) {
    const k = K[s.symbol]; const bars = B[s.symbol];
    const tfMin = TF_MIN[s.timeframe];
    if (!k || !bars || !tfMin) { noData++; continue; }

    if (!haveFeat.has(s.id)) {
      const f = mtfTrend(closedBefore(bars['15m'], 15, s.detected_at), closedBefore(bars['1h'], 60, s.detected_at));
      featRows.push([s.id, FEATURE_VERSION, 'backfill', f.trend_15m_slope, f.trend_15m_pos, f.trend_1h_slope, f.trend_1h_pos, f.trend_4h_slope, f.trend_4h_pos, now]);
    }

    const tfBars = closedBefore(bars[s.timeframe], tfMin, s.detected_at);
    const a = atr(tfBars);
    if (!(a > 0)) { noData++; continue; }
    for (const c of CONFIGS) {
      if (haveLabel.has(s.id + '|' + c.config)) continue;
      const r = barrier(s, k, a, c);
      if (!r) { pending++; continue; }
      labelRows.push([s.id, c.config, c.pt, c.sl, c.maxBars, a, r.label, r.ret_r_net, r.ret_pct_net, r.exit_reason, r.minutes_to_exit, now]);
    }
  }

  const insert = async (sql: string, rows: unknown[][], width: number) => {
    for (let i = 0; i < rows.length; i += 400) {
      const chunk = rows.slice(i, i + 400);
      const ph = chunk.map((_, r) => '(' + Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(',') + ')').join(',');
      await pool.query(sql.replace('VALUES ?', 'VALUES ' + ph), chunk.flat());
    }
  };
  await insert(`INSERT INTO signal_features (signal_id, feature_version, source, trend_15m_slope, trend_15m_pos, trend_1h_slope, trend_1h_pos, trend_4h_slope, trend_4h_pos, computed_at)
                VALUES ? ON CONFLICT (signal_id) DO UPDATE SET
                  feature_version = EXCLUDED.feature_version,
                  trend_15m_slope = EXCLUDED.trend_15m_slope, trend_15m_pos = EXCLUDED.trend_15m_pos,
                  trend_1h_slope = EXCLUDED.trend_1h_slope, trend_1h_pos = EXCLUDED.trend_1h_pos,
                  trend_4h_slope = EXCLUDED.trend_4h_slope, trend_4h_pos = EXCLUDED.trend_4h_pos,
                  computed_at = EXCLUDED.computed_at
                WHERE signal_features.source = 'backfill'`, featRows, 10);
  await insert(`INSERT INTO signal_labels (signal_id, config, pt_atr, sl_atr, max_bars, atr, label, ret_r_net, ret_pct_net, exit_reason, minutes_to_exit, labelled_at)
                VALUES ? ON CONFLICT (signal_id, config) DO NOTHING`, labelRows, 12);
  console.log(`wrote ${featRows.length} feature rows, ${labelRows.length} label rows | not yet resolvable ${pending} | no candle data ${noData}`);

  // Summary of everything labelled so far
  const sum = await pool.query(`
    SELECT config, COUNT(*)::int n,
           ROUND(AVG(ret_r_net)::numeric, 3) avg_r_net,
           ROUND(100.0 * AVG((label = 1)::int), 1) pct_profit,
           ROUND(100.0 * AVG((label = -1)::int), 1) pct_stop,
           ROUND(100.0 * AVG((label = 0)::int), 1) pct_time
      FROM signal_labels GROUP BY config ORDER BY config`);
  console.table(sum.rows);
  await pool.end();
}

// Run only when invoked directly, so tests can import barrier()
if (require.main === module) main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
