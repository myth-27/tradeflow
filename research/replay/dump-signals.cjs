// Export signal_log, paper_trades and system_state to data/db.json.
//   DBURL=postgres://... node research/replay/dump-signals.cjs
// Uses the Railway Postgres public URL. Read-only queries.
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
if (!process.env.DBURL) { console.error('Set DBURL to the Postgres connection string.'); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DBURL, ssl: { rejectUnauthorized: false } });
(async () => {
  const q = async s => (await pool.query(s)).rows;
  const out = {
    trades: await q('SELECT * FROM paper_trades ORDER BY opened_at'),
    signals: await q('SELECT * FROM signal_log ORDER BY detected_at'),
    state: await q('SELECT * FROM system_state'),
  };
  const dir = path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(out));
  console.log(`trades ${out.trades.length}, signals ${out.signals.length}`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
