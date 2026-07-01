import { getPool, getState, setState } from './db';
import { getLivePrice } from './candle-store';

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

async function checkOpenTrades(): Promise<void> {
  const state = await getState();
  if (state['halted'] === 'true') return;

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM paper_trades WHERE status = 'open'`,
  );

  for (const trade of rows) {
    const price = getLivePrice(trade.symbol);
    if (!price) continue;

    const { direction, entry, stop_loss, tp1, tp2, size, id } = trade;
    let exitReason: string | null = null;
    let exitPrice = price;
    let pnlPct = 0;

    if (direction === 'long') {
      if (price <= stop_loss) {
        exitReason = 'stop';
        exitPrice = stop_loss;
      } else if (price >= tp2) {
        exitReason = 'tp2';
        exitPrice = tp2;
      } else if (price >= tp1 && !trade.tp1_hit) {
        // Partial exit at TP1 — move stop to breakeven
        await pool.query(
          `UPDATE paper_trades SET stop_loss = $1, tp1_hit = true WHERE id = $2`,
          [entry, id],
        );
        console.log(`[monitor] ${trade.symbol} TP1 hit — stop moved to breakeven`);
        continue;
      }
    } else {
      if (price >= stop_loss) {
        exitReason = 'stop';
        exitPrice = stop_loss;
      } else if (price <= tp2) {
        exitReason = 'tp2';
        exitPrice = tp2;
      } else if (price <= tp1 && !trade.tp1_hit) {
        await pool.query(
          `UPDATE paper_trades SET stop_loss = $1, tp1_hit = true WHERE id = $2`,
          [entry, id],
        );
        console.log(`[monitor] ${trade.symbol} TP1 hit — stop moved to breakeven`);
        continue;
      }
    }

    if (!exitReason) continue;

    pnlPct = direction === 'long'
      ? ((exitPrice - entry) / entry) * 100
      : ((entry - exitPrice) / entry) * 100;

    const pnlAbs = (pnlPct / 100) * entry * size;
    const now = Date.now();

    await pool.query(
      `UPDATE paper_trades
       SET status = 'closed', closed_at = $1, exit_price = $2,
           exit_reason = $3, pnl_pct = $4
       WHERE id = $5`,
      [now, exitPrice, exitReason, pnlPct, id],
    );

    // Update daily P&L and win/loss counters
    const currentDailyPnl = parseFloat(state['daily_pnl'] ?? '0');
    await setState('daily_pnl', String(currentDailyPnl + pnlAbs));

    if (pnlPct > 0) {
      const wins = parseInt(state['wins'] ?? '0') + 1;
      await setState('wins', String(wins));
    } else {
      const losses = parseInt(state['losses'] ?? '0') + 1;
      await setState('losses', String(losses));
    }

    console.log(`[monitor] ${trade.symbol} closed via ${exitReason} pnl=${pnlPct.toFixed(2)}%`);
  }

  // Reset daily P&L at midnight UTC
  const lastReset = parseInt(state['last_reset'] ?? '0');
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  if (lastReset < startOfDay.getTime()) {
    await setState('daily_pnl', '0');
    await setState('last_reset', String(Date.now()));
  }
}
