import { getPool, getState, setState, incState } from './db';
import { getLivePrice, calcATR } from './candle-store';
import { MAKER_FEE, TAKER_FEE, stopFillPrice } from './costs';
import { enforceDrawdownHalt } from './risk';

let monitorInterval: ReturnType<typeof setInterval> | null = null;

export function startTradeMonitor(): void {
  if (monitorInterval) return;
  monitorInterval = setInterval(checkOpenTrades, 15_000);
  console.log('[monitor] trade monitor started (15s interval)');
}

export function stopTradeMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

const TF_MINUTES: Record<string, number> = { '5m': 5, '15m': 15, '1h': 60 };

interface OpenTrade {
  id: string; symbol: string; timeframe: string; direction: 'long' | 'short';
  entry: number; stop_loss: number; tp1: number; tp2: number; size: number;
  tp1_hit: boolean; opened_at: string;
}

/**
 * Settle a trade with costs. TP1 (if hit) closed half at a maker limit; the rest
 * exits at `exitPx` paying `exitFee`. Entry was a market order (taker).
 * Returns net P&L, fees and the R multiple of the INITIAL risk.
 */
export function settle(t: OpenTrade, exitPx: number, exitFee: number) {
  const dir = t.direction === 'long' ? 1 : -1;
  // TP1 always sits 1.5R from entry, so the initial risk survives stop moves
  const initialRisk = Math.abs(t.tp1 - t.entry) / 1.5;
  const half = t.size / 2;

  let gross: number, fees: number;
  if (t.tp1_hit) {
    gross = (t.tp1 - t.entry) * dir * half + (exitPx - t.entry) * dir * half;
    fees = t.entry * t.size * TAKER_FEE + t.tp1 * half * MAKER_FEE + exitPx * half * exitFee;
  } else {
    gross = (exitPx - t.entry) * dir * t.size;
    fees = t.entry * t.size * TAKER_FEE + exitPx * t.size * exitFee;
  }
  const net = gross - fees;
  return {
    pnlAbs: net,
    pnlPct: (net / (t.entry * t.size)) * 100,
    fees,
    r: initialRisk > 0 ? net / (initialRisk * t.size) : 0,
  };
}

async function checkOpenTrades(): Promise<void> {
  const state = await getState();
  // A halt stops NEW entries (signal-processor). Open positions must still be
  // managed — previously a halt left them with no stop or target monitoring at all.
  await monitorTable('paper_trades', state);
  await monitorTable('shadow_trades', state);

  // Reset daily P&L at midnight UTC
  const lastReset = parseInt(state['last_reset'] ?? '0');
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  if (lastReset < startOfDay.getTime()) {
    await setState('daily_pnl', '0');
    await setState('last_reset', String(Date.now()));
  }
}

async function monitorTable(table: 'paper_trades' | 'shadow_trades', state: Record<string, string>): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT * FROM ${table} WHERE status = 'open'`);

  for (const trade of rows as OpenTrade[]) {
    const price = getLivePrice(trade.symbol);
    if (!price) continue;

    const { direction, entry, stop_loss, tp1, tp2, id, tp1_hit } = trade;
    const long = direction === 'long';
    let exitReason: string | null = null;
    let exitPrice = price;
    let exitFee = TAKER_FEE;

    if (long ? price <= stop_loss : price >= stop_loss) {
      exitReason = 'stop';
      // Polling every 15s means price can be well past the stop; fill where it actually is
      exitPrice = stopFillPrice(direction, stop_loss, price);
    } else if (long ? price >= tp2 : price <= tp2) {
      exitReason = 'tp2';
      exitPrice = tp2;
      exitFee = MAKER_FEE;
    } else if (!tp1_hit && (long ? price >= tp1 : price <= tp1)) {
      // TP1 hit: half closes at the limit, stop moves to breakeven, trailing starts
      await pool.query(`UPDATE ${table} SET stop_loss = $1, tp1_hit = true WHERE id = $2`, [entry, id]);
      continue;
    } else if (tp1_hit) {
      // Trailing stop: 1.5× ATR behind price, never worse than breakeven
      const atr = calcATR(trade.symbol, trade.timeframe);
      if (atr > 0) {
        const trail = long ? Math.max(price - atr * 1.5, entry) : Math.min(price + atr * 1.5, entry);
        if (long ? trail > stop_loss : trail < stop_loss) {
          await pool.query(`UPDATE ${table} SET stop_loss = $1 WHERE id = $2`, [trail, id]);
        }
      }
    }

    if (!exitReason) continue;

    const { pnlAbs, pnlPct, fees, r } = settle(trade, exitPrice, exitFee);
    const now = Date.now();

    await pool.query(
      `UPDATE ${table}
       SET status = 'closed', closed_at = $1, exit_price = $2, exit_reason = $3,
           pnl_pct = $4, pnl_abs = $5, fees_abs = $6, r_multiple = $7
       WHERE id = $8`,
      [now, exitPrice, exitReason, pnlPct, pnlAbs, fees, r, id],
    );

    if (table === 'shadow_trades') {
      console.log(`[monitor] shadow ${trade.symbol} ${exitReason} ${r.toFixed(2)}R net`);
      continue;
    }

    // Atomic increments: several trades can close in one tick, and `state` is a stale snapshot
    await incState('daily_pnl', pnlAbs);
    await incState('capital', pnlAbs);
    await incState(pnlAbs > 0 ? 'wins' : pnlAbs < 0 ? 'losses' : 'breakevens', 1);

    const tfMin = TF_MINUTES[trade.timeframe] ?? 15;
    const barsHeld = Math.round((now - parseInt(trade.opened_at)) / (tfMin * 60 * 1000));
    // reward stays percent P&L (now net of costs) so the column keeps one unit across history
    await pool.query(
      `UPDATE rl_experience
       SET reward = $1, outcome = $2, bars_held = $3, exit_reason = $4, updated_at = $5
       WHERE trade_id = $6`,
      [pnlPct, pnlAbs > 0 ? 'win' : pnlAbs < 0 ? 'loss' : 'breakeven', barsHeld, exitReason, now, id],
    );

    console.log(`[monitor] ${trade.symbol} closed via ${exitReason} ${r.toFixed(2)}R net ($${pnlAbs.toFixed(2)}, fees $${fees.toFixed(2)})`);

    // Re-check the drawdown breaker against the updated equity
    const fresh = await getState();
    await enforceDrawdownHalt(fresh, parseFloat(fresh['capital'] ?? '0'));
  }
}
