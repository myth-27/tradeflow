/**
 * Experiment 001 dataset (see docs/research/001-meta-labeling-prereg.md).
 *   npx tsx research/experiments/001-meta-labeling/build-dataset.ts
 *
 * One row per signal detected before the cutoff, with:
 *  - pure-Bybit trend features computed here with lib/features.ts (amendment A1),
 *    verified to reproduce every existing backfill row exactly;
 *  - net-R labels for both barrier configs, from signal_labels;
 *  - the random-direction TWIN: the same barrier, same ATR, opposite direction;
 *  - a cluster id (same symbol+timeframe+pattern+direction, < 30 min apart).
 * Reads the DB read-only. Writes data/dataset.csv (gitignored).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { mtfTrend } from '../../../lib/features';
import { aggregate1m, barrier, closedBefore, CONFIGS, type K1, type Sig } from '../../replay/label-signals';

const CUTOFF = Date.parse('2026-10-11T11:53:00Z');
const CLUSTER_GAP_MS = 30 * 60000;
const REPLAY = path.join(__dirname, '..', '..', 'replay', 'data');
const OUT = path.join(__dirname, 'data');

async function main() {
  const url = process.env.DBURL || fs.readFileSync(path.join(REPLAY, '.dburl'), 'utf8').trim();
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  await pool.query('SET default_transaction_read_only = on');

  const sigs = (await pool.query(
    `SELECT s.id, s.symbol, s.timeframe, s.pattern, s.direction, s.entry, s.detected_at, s.confidence, s.regime,
            r.rsi, r.volume_ratio
       FROM signal_log s LEFT JOIN rl_experience r ON r.signal_id = s.id
      WHERE s.detected_at < $1 ORDER BY s.detected_at`, [CUTOFF])).rows;
  const labels = new Map<string, Record<string, { r: number; label: number; atr: number }>>();
  for (const l of (await pool.query(`SELECT signal_id, config, ret_r_net, label, atr FROM signal_labels`)).rows) {
    const m = labels.get(l.signal_id) ?? {};
    m[l.config] = { r: Number(l.ret_r_net), label: Number(l.label), atr: Number(l.atr) };
    labels.set(l.signal_id, m);
  }
  const backfill = new Map<string, Record<string, number | null>>();
  for (const f of (await pool.query(`SELECT * FROM signal_features WHERE source = 'backfill'`)).rows) backfill.set(f.signal_id, f);
  await pool.end();
  console.log(`signals before cutoff ${sigs.length} | labelled ${labels.size} | backfill feature rows ${backfill.size}`);

  // Candles, aggregated exactly as the labeller does
  const K: Record<string, K1[]> = {}, B15: Record<string, ReturnType<typeof aggregate1m>> = {}, B60: typeof B15 = {};
  for (const f of fs.readdirSync(path.join(REPLAY, 'k1m'))) {
    const s = f.replace('.json', '');
    K[s] = JSON.parse(fs.readFileSync(path.join(REPLAY, 'k1m', f), 'utf8'));
    B15[s] = aggregate1m(K[s], 15); B60[s] = aggregate1m(K[s], 60);
  }

  const FK = ['trend_15m_slope', 'trend_15m_pos', 'trend_1h_slope', 'trend_1h_pos', 'trend_4h_slope', 'trend_4h_pos'] as const;
  let checked = 0, maxDiff = 0;
  const lastSeen = new Map<string, { t: number; cluster: number }>();
  let nextCluster = 0, skipped = 0;
  const rows: string[] = [];
  const header = ['signal_id', 'detected_at', 'cluster', 'symbol', 'timeframe', 'pattern', 'direction', 'regime',
    'confidence', 'rsi', 'volume_ratio', ...FK,
    'r_3x15', 'label_3x15', 'twin_r_3x15', 'r_2x1', 'label_2x1', 'twin_r_2x1'];
  rows.push(header.join(','));

  for (const s of sigs) {
    const t = Number(s.detected_at);
    // Cluster: chain of detections of the same setup less than 30 min apart
    const ck = `${s.symbol}|${s.timeframe}|${s.pattern}|${s.direction}`;
    const prev = lastSeen.get(ck);
    const cluster = prev && t - prev.t < CLUSTER_GAP_MS ? prev.cluster : nextCluster++;
    lastSeen.set(ck, { t, cluster });

    if (!K[s.symbol]) { skipped++; continue; }
    // Features are checked for EVERY signal with a backfill row, labelled or not,
    // so the A1 reproduction check covers the whole backfill table.
    const f = mtfTrend(closedBefore(B15[s.symbol], 15, t), closedBefore(B60[s.symbol], 60, t));
    const bf = backfill.get(s.id);
    if (bf) {
      for (const k of FK) {
        const a = f[k], b = bf[k] === null ? null : Number(bf[k]);
        const d = a === null || b === null ? (a === b ? 0 : Infinity) : Math.abs(a - b);
        maxDiff = Math.max(maxDiff, d);
      }
      checked++;
    }

    const lab = labels.get(s.id);
    if (!lab?.['tb_3x1.5_48'] || !lab?.['tb_2x1_48']) { skipped++; continue; }

    const sig: Sig = { id: s.id, symbol: s.symbol, timeframe: s.timeframe, pattern: s.pattern, direction: s.direction, entry: Number(s.entry), detected_at: t };
    const twin: Sig = { ...sig, direction: s.direction === 'long' ? 'short' : 'long' };
    const tw = (cfg: string) => {
      const c = CONFIGS.find(x => x.config === cfg)!;
      return barrier(twin, K[s.symbol], lab[cfg].atr, c);
    };
    const t3 = tw('tb_3x1.5_48'), t2 = tw('tb_2x1_48');
    if (!t3 || !t2) { skipped++; continue; }

    const num = (v: unknown) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '' : String(Number(v)));
    rows.push([s.id, t, cluster, s.symbol, s.timeframe, JSON.stringify(s.pattern), s.direction, s.regime,
      num(s.confidence), num(s.rsi), num(s.volume_ratio), ...FK.map(k => num(f[k])),
      lab['tb_3x1.5_48'].r, lab['tb_3x1.5_48'].label, t3.ret_r_net, lab['tb_2x1_48'].r, lab['tb_2x1_48'].label, t2.ret_r_net].join(','));
  }

  // Amendment A1: every backfill row must have been compared, and all must match.
  const expected = sigs.filter(s => backfill.has(s.id) && K[s.symbol]).length;
  console.log(`feature check vs DB backfill: ${checked} of ${expected} rows compared (table holds ${backfill.size}), max abs diff ${maxDiff}`);
  if (checked === 0 || checked !== expected) throw new Error(`A1 check incomplete: compared ${checked}, expected ${expected}.`);
  if (!(maxDiff < 1e-9)) throw new Error('Locally computed features do not reproduce the backfill rows — stopping (amendment A1).');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'dataset.csv'), rows.join('\n'));
  const clusters = new Set(rows.slice(1).map(r => r.split(',')[2])).size;
  console.log(`wrote ${rows.length - 1} rows (${skipped} skipped: unlabelled or twin unresolved), ${clusters} clusters in written rows`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
