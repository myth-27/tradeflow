import { Pool } from 'pg';

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL ?? '';
    _pool = new Pool({
      connectionString: url,
      max: 5,
      ssl: { rejectUnauthorized: false },
    });
  }
  return _pool;
}

export async function initDb(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS paper_trades (
      id          TEXT PRIMARY KEY,
      symbol      TEXT NOT NULL,
      timeframe   TEXT NOT NULL,
      direction   TEXT NOT NULL,
      entry       DOUBLE PRECISION NOT NULL,
      stop_loss   DOUBLE PRECISION NOT NULL,
      tp1         DOUBLE PRECISION NOT NULL,
      tp2         DOUBLE PRECISION NOT NULL,
      tp1_hit     BOOLEAN NOT NULL DEFAULT false,
      size        DOUBLE PRECISION NOT NULL,
      pattern     TEXT NOT NULL,
      edge_score  DOUBLE PRECISION NOT NULL,
      tier        TEXT NOT NULL,
      opened_at   BIGINT NOT NULL,
      closed_at   BIGINT,
      exit_price  DOUBLE PRECISION,
      exit_reason TEXT,
      pnl_pct     DOUBLE PRECISION,
      pnl_abs     DOUBLE PRECISION,
      status      TEXT NOT NULL DEFAULT 'open'
    );

    CREATE TABLE IF NOT EXISTS signal_log (
      id          TEXT PRIMARY KEY,
      symbol      TEXT NOT NULL,
      timeframe   TEXT NOT NULL,
      pattern     TEXT NOT NULL,
      direction   TEXT NOT NULL,
      confidence  DOUBLE PRECISION NOT NULL,
      edge_score  DOUBLE PRECISION NOT NULL,
      tier        TEXT NOT NULL,
      regime      TEXT NOT NULL,
      entry       DOUBLE PRECISION NOT NULL,
      stop_loss   DOUBLE PRECISION NOT NULL,
      target      DOUBLE PRECISION NOT NULL,
      risk_reward DOUBLE PRECISION NOT NULL,
      acted       BOOLEAN NOT NULL DEFAULT false,
      reason      TEXT,
      detected_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- RL training data: one row per signal (acted or skipped)
    -- Outcome columns filled when the associated trade closes
    CREATE TABLE IF NOT EXISTS rl_experience (
      id           TEXT PRIMARY KEY,
      signal_id    TEXT NOT NULL,
      trade_id     TEXT,
      symbol       TEXT NOT NULL,
      timeframe    TEXT NOT NULL,
      -- State features at signal time
      pattern      TEXT NOT NULL,
      direction    TEXT NOT NULL,
      regime       TEXT NOT NULL,
      edge_score   DOUBLE PRECISION NOT NULL,
      confidence   DOUBLE PRECISION NOT NULL,
      rsi          DOUBLE PRECISION,
      volume_ratio DOUBLE PRECISION,
      risk_reward  DOUBLE PRECISION NOT NULL,
      entry        DOUBLE PRECISION NOT NULL,
      stop_loss    DOUBLE PRECISION NOT NULL,
      target       DOUBLE PRECISION NOT NULL,
      hour_utc     INTEGER NOT NULL,
      day_of_week  INTEGER NOT NULL,
      acted        BOOLEAN NOT NULL DEFAULT false,
      -- Outcome (filled when trade closes)
      reward       DOUBLE PRECISION,
      outcome      TEXT,
      bars_held    INTEGER,
      exit_reason  TEXT,
      created_at   BIGINT NOT NULL,
      updated_at   BIGINT
    );

    INSERT INTO system_state (key, value)
    VALUES
      ('halted', 'false'),
      ('capital', '${process.env.STARTING_CAPITAL ?? "10000"}'),
      ('total_trades', '0'),
      ('wins', '0'),
      ('losses', '0'),
      ('daily_pnl', '0'),
      ('last_reset', '0')
    ON CONFLICT (key) DO NOTHING;

    -- Add columns that might be missing from earlier schema versions
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS tp1_hit BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS pnl_abs DOUBLE PRECISION;
    -- Fees charged on the trade. pnl_abs/pnl_pct are NET of these from 2026-10-04 on;
    -- trades closed before that (fees_abs IS NULL) were recorded gross.
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS fees_abs DOUBLE PRECISION;
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS r_multiple DOUBLE PRECISION;

    -- Log-only mode: every tradeable setup is followed with the same exit rules and
    -- costs as a paper trade, but nothing here touches capital, wins or daily P&L.
    -- This is the evidence a setup must pass before it is allowed to paper-trade.
    CREATE TABLE IF NOT EXISTS shadow_trades (
      id          TEXT PRIMARY KEY,
      signal_id   TEXT NOT NULL,
      symbol      TEXT NOT NULL,
      timeframe   TEXT NOT NULL,
      direction   TEXT NOT NULL,
      entry       DOUBLE PRECISION NOT NULL,
      stop_loss   DOUBLE PRECISION NOT NULL,
      tp1         DOUBLE PRECISION NOT NULL,
      tp2         DOUBLE PRECISION NOT NULL,
      tp1_hit     BOOLEAN NOT NULL DEFAULT false,
      size        DOUBLE PRECISION NOT NULL,
      pattern     TEXT NOT NULL,
      edge_score  DOUBLE PRECISION NOT NULL,
      tier        TEXT NOT NULL,
      opened_at   BIGINT NOT NULL,
      closed_at   BIGINT,
      exit_price  DOUBLE PRECISION,
      exit_reason TEXT,
      pnl_pct     DOUBLE PRECISION,
      pnl_abs     DOUBLE PRECISION,
      fees_abs    DOUBLE PRECISION,
      r_multiple  DOUBLE PRECISION,
      status      TEXT NOT NULL DEFAULT 'open'
    );
    CREATE INDEX IF NOT EXISTS shadow_trades_status ON shadow_trades (status);

    -- Where an rl_experience outcome came from: 'paper' (a real paper trade) or
    -- 'shadow' (log-only follow-through). Kept separate so training data never mixes
    -- them without knowing. Rows with no outcome were never followed through.
    ALTER TABLE rl_experience ADD COLUMN IF NOT EXISTS outcome_source TEXT;
    CREATE INDEX IF NOT EXISTS rl_experience_signal ON rl_experience (signal_id);
    UPDATE rl_experience SET outcome_source = 'paper'
     WHERE outcome IS NOT NULL AND outcome_source IS NULL AND trade_id IS NOT NULL;

    -- Backfill: shadow trades that closed before outcomes were written back
    -- (2026-10-04 → 06). Idempotent — only fills rows that are still unlabelled.
    UPDATE rl_experience r
       SET reward = s.pnl_pct,
           outcome = CASE WHEN s.pnl_abs > 0 THEN 'win' WHEN s.pnl_abs < 0 THEN 'loss' ELSE 'breakeven' END,
           bars_held = ROUND((s.closed_at - s.opened_at)::numeric
                             / (CASE s.timeframe WHEN '5m' THEN 5 WHEN '15m' THEN 15 ELSE 60 END * 60000))::int,
           exit_reason = s.exit_reason,
           updated_at = s.closed_at,
           outcome_source = 'shadow'
      FROM shadow_trades s
     WHERE s.status = 'closed' AND r.signal_id = s.signal_id AND r.outcome IS NULL;
  `);
}

export async function getState(): Promise<Record<string, string>> {
  const { rows } = await getPool().query('SELECT key, value FROM system_state');
  return Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
}

export async function incState(key: string, delta: number): Promise<void> {
  await getPool().query(
    `INSERT INTO system_state (key, value) VALUES ($1, ($2::double precision)::text)
     ON CONFLICT (key) DO UPDATE SET value = (system_state.value::double precision + $2::double precision)::text`,
    [key, delta],
  );
}

export async function setState(key: string, value: string): Promise<void> {
  await getPool().query(
    'INSERT INTO system_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, value],
  );
}
