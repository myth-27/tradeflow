import { getPool, getState, setState } from './db';
import { getLivePrice, getCandles } from './candle-store';

function calcATR(symbol: string, tf: string, period = 14): number {
  const candles = getCandles(symbol, tf);
  if (candles.length < period + 1) return 0;
  const trs = candles.slice(1).map((c, i) => Math.max(
    c.high - c.low,
    Math.abs(c.high - candles[i].close),
    Math.abs(c.low - candles[i].close),
  ));
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

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
  const { rows } = await pool.query(`SELECT * FROM paper_trades WHERE status = 'open'`);

  for (const trade of rows) {
    const price = getLivePrice(trade.symbol);
    if (!price) continue;

    const { direction, entry, stop_loss, tp1, tp2, size, id, tp1_hit, opened_at } = trade;
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
      } else if (!tp1_hit && price >= tp1) {
        // TP1 hit: move SL to breakeven, start trailing
        await pool.query(
          `UPDATE paper_trades SET stop_loss = $1, tp1_hit = true WHERE id = $2`,
          [entry, id],
        );
        console.log(`[monitor] ${trade.symbol} TP1 hit — SL moved to breakeven, trailing active`);
        continue;
      } else if (tp1_hit) {
        // Trailing SL: 1.5× ATR below current price, never lower than breakeven
        const atr = calcATR(trade.symbol, trade.timeframe);
        if (atr > 0) {
          const trailSL = Math.max(price - atr * 1.5, entry);
          if (trailSL > stop_loss) {
            await pool.query(`UPDATE paper_trades SET stop_loss = $1 WHERE id = $2`, [trailSL, id]);
          }
        }
      }
    } else {
      if (price >= stop_loss) {
        exitReason = 'stop';
        exitPrice = stop_loss;
      } else if (price <= tp2) {
        exitReason = 'tp2';
        exitPrice = tp2;
      } else if (!tp1_hit && price <= tp1) {
        // TP1 hit: move SL to breakeven, start trailing
        await pool.query(
          `UPDATE paper_trades SET stop_loss = $1, tp1_hit = true WHERE id = $2`,
          [entry, id],
        );
        console.log(`[monitor] ${trade.symbol} TP1 hit — SL moved to breakeven, trailing active`);
        continue;
      } else if (tp1_hit) {
        // Trailing SL: 1.5× ATR above current price, never higher than breakeven
        const atr = calcATR(trade.symbol, trade.timeframe);
        if (atr > 0) {
          const trailSL = Math.min(price + atr * 1.5, entry);
          if (trailSL < stop_loss) {
            await pool.query(`UPDATE paper_trades SET stop_loss = $1 WHERE id = $2`, [trailSL, id]);
          }
        }
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
           exit_reason = $3, pnl_pct = $4, pnl_abs = $5
       WHERE id = $6`,
      [now, exitPrice, exitReason, pnlPct, pnlAbs, id],
    );

    // Update system counters
    const currentDailyPnl = parseFloat(state['daily_pnl'] ?? '0');
    await setState('daily_pnl', String(currentDailyPnl + pnlAbs));

    if (pnlPct > 0) {
      await setState('wins', String(parseInt(state['wins'] ?? '0') + 1));
    } else {
      await setState('losses', String(parseInt(state['losses'] ?? '0') + 1));
    }

    // Update RL experience with outcome
    const barsHeld = Math.round((now - parseInt(opened_at)) / (15 * 60 * 1000));
    await pool.query(
      `UPDATE rl_experience
       SET reward = $1, outcome = $2, bars_held = $3, exit_reason = $4, updated_at = $5
       WHERE trade_id = $6`,
      [
        pnlPct,
        pnlPct > 0 ? 'win' : pnlPct < 0 ? 'loss' : 'breakeven',
        barsHeld,
        exitReason,
        now,
        id,
      ],
    );

    console.log(`[monitor] ${trade.symbol} closed via ${exitReason} pnl=${pnlPct.toFixed(2)}% ($${pnlAbs.toFixed(2)})`);
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
