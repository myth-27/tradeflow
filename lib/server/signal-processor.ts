import { v4 as uuidv4 } from 'uuid';
import { runAllPatterns, calcRSI, calcVolumeProfile } from '@/lib/pattern-engine';
import { classifyRegime } from '@/lib/simulator';
import { quickEdgeEstimate } from '@/lib/edge-score';
import { getPool, getState, setState } from './db';
import { getCandles, getLivePrice } from './candle-store';

// 5 cryptos × 2 timeframes — 1h streams feed the HTF regime filter for 15m signals
export const STREAMS: Array<{ symbol: string; tf: string }> = [
  { symbol: 'BTCUSDT', tf: '15m' },
  { symbol: 'ETHUSDT', tf: '15m' },
  { symbol: 'SOLUSDT', tf: '15m' },
  { symbol: 'BNBUSDT', tf: '15m' },
  { symbol: 'XRPUSDT', tf: '15m' },
  { symbol: 'BTCUSDT', tf: '1h' },
  { symbol: 'ETHUSDT', tf: '1h' },
  { symbol: 'SOLUSDT', tf: '1h' },
  { symbol: 'BNBUSDT', tf: '1h' },
  { symbol: 'XRPUSDT', tf: '1h' },
];

// Symbols that fire signals (1h streams are HTF filter only)
const SIGNAL_TIMEFRAMES = new Set(['15m']);

const MIN_CANDLES = 100;
const MIN_EDGE = 60;
const MIN_RR = 1.5;
const CAPITAL = parseFloat(process.env.STARTING_CAPITAL ?? '10000');
const RISK_PER_TRADE = parseFloat(process.env.RISK_PER_TRADE ?? '0.01');
const MAX_DAILY_LOSS_PCT = 0.03;

const lastSignalTime = new Map<string, number>();
const COOLDOWN_MS = 30 * 60 * 1000;

export async function processNewCandle(symbol: string, tf: string): Promise<void> {
  if (!SIGNAL_TIMEFRAMES.has(tf)) return;

  const state = await getState();
  if (state['halted'] === 'true') return;

  const dailyPnl = parseFloat(state['daily_pnl'] ?? '0');
  if (dailyPnl <= -(CAPITAL * MAX_DAILY_LOSS_PCT)) return;

  const ck = `${symbol}:${tf}`;
  const lastFired = lastSignalTime.get(ck) ?? 0;
  if (Date.now() - lastFired < COOLDOWN_MS) return;

  const candles = getCandles(symbol, tf);
  if (candles.length < MIN_CANDLES) return;

  // HTF regime filter — skip if 1h is ranging/low_volatility
  const htfCandles = getCandles(symbol, '1h');
  if (htfCandles.length >= 50) {
    const htfRegime = classifyRegime(htfCandles);
    if (htfRegime === 'ranging' || htfRegime === 'low_volatility') return;
  }

  const regime = classifyRegime(candles);
  const patterns = runAllPatterns(candles);
  if (!patterns.length) return;

  const best = patterns
    .filter(p => p.type !== 'neutral' && !p.conflicting)
    .sort((a, b) => b.confidence - a.confidence)[0];
  if (!best) return;

  if (!best.stopLoss || !best.target) return;
  const stopDist = Math.abs(best.support - best.stopLoss);
  if (stopDist <= 0 || best.riskReward < MIN_RR) return;

  const entry = getLivePrice(symbol) ?? candles[candles.length - 1].close;
  const direction: 'long' | 'short' = best.type === 'bullish' ? 'long' : 'short';

  if (direction === 'long' && (best.stopLoss >= entry || best.target <= entry)) return;
  if (direction === 'short' && (best.stopLoss <= entry || best.target >= entry)) return;

  const closes = candles.map(c => c.close);
  const rsi = calcRSI(closes);
  const volProfile = calcVolumeProfile(candles);
  const { estimatedEdge, tier } = quickEdgeEstimate(
    best.confidence, regime, direction, volProfile.volumeRatio, rsi,
  );

  const riskReward = Math.abs(best.target - entry) / Math.abs(entry - best.stopLoss);
  const now = Date.now();
  const dt = new Date(now);
  const hourUtc = dt.getUTCHours();
  const dayOfWeek = dt.getUTCDay();

  const signalId = uuidv4();
  const pool = getPool();

  await pool.query(
    `INSERT INTO signal_log
     (id, symbol, timeframe, pattern, direction, confidence, edge_score, tier, regime,
      entry, stop_loss, target, risk_reward, acted, reason, detected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [signalId, symbol, tf, best.name, direction,
     best.confidence, estimatedEdge, tier, regime,
     entry, best.stopLoss, best.target, riskReward,
     false, null, now],
  );

  if (estimatedEdge < MIN_EDGE) {
    await pool.query(`UPDATE signal_log SET reason = $1 WHERE id = $2`,
      [`edge too low: ${estimatedEdge}`, signalId]);

    // Still record for RL (negative examples are equally valuable)
    await saveRlExperience(pool, {
      signalId, tradeId: null, symbol, tf, best, direction,
      regime, estimatedEdge, tier, rsi, volumeRatio: volProfile.volumeRatio,
      riskReward, entry, hourUtc, dayOfWeek, acted: false,
    });
    return;
  }

  const { rows: openTrades } = await pool.query(
    `SELECT id FROM paper_trades WHERE symbol = $1 AND status = 'open'`, [symbol]);
  if (openTrades.length > 0) {
    await pool.query(`UPDATE signal_log SET reason = 'already in trade' WHERE id = $1`, [signalId]);
    await saveRlExperience(pool, {
      signalId, tradeId: null, symbol, tf, best, direction,
      regime, estimatedEdge, tier, rsi, volumeRatio: volProfile.volumeRatio,
      riskReward, entry, hourUtc, dayOfWeek, acted: false,
    });
    return;
  }

  const riskAmt = CAPITAL * RISK_PER_TRADE;
  const stopDistPrice = Math.abs(entry - best.stopLoss);
  const size = stopDistPrice > 0 ? riskAmt / stopDistPrice : 0;
  if (size <= 0) return;

  const tp1 = direction === 'long'
    ? entry + (stopDistPrice * 1.5)
    : entry - (stopDistPrice * 1.5);
  const tp2 = best.target;

  const tradeId = uuidv4();
  await pool.query(
    `INSERT INTO paper_trades
     (id, symbol, timeframe, direction, entry, stop_loss, tp1, tp2, size,
      pattern, edge_score, tier, opened_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'open')`,
    [tradeId, symbol, tf, direction, entry, best.stopLoss, tp1, tp2, size,
     best.name, estimatedEdge, tier, now],
  );

  await pool.query(`UPDATE signal_log SET acted = true WHERE id = $1`, [signalId]);

  await saveRlExperience(pool, {
    signalId, tradeId, symbol, tf, best, direction,
    regime, estimatedEdge, tier, rsi, volumeRatio: volProfile.volumeRatio,
    riskReward, entry, hourUtc, dayOfWeek, acted: true,
  });

  const total = parseInt(state['total_trades'] ?? '0') + 1;
  await setState('total_trades', String(total));

  lastSignalTime.set(ck, now);
  console.log(`[signal] ${symbol} ${tf} ${direction} ${best.name} edge=${estimatedEdge} tier=${tier}`);
}

async function saveRlExperience(pool: ReturnType<typeof getPool>, p: {
  signalId: string; tradeId: string | null;
  symbol: string; tf: string;
  best: { name: string; confidence: number; stopLoss: number; target: number };
  direction: string; regime: string; estimatedEdge: number; tier: string;
  rsi: number; volumeRatio: number; riskReward: number; entry: number;
  hourUtc: number; dayOfWeek: number; acted: boolean;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO rl_experience
       (id, signal_id, trade_id, symbol, timeframe, pattern, direction, regime,
        edge_score, confidence, rsi, volume_ratio, risk_reward, entry, stop_loss,
        target, hour_utc, day_of_week, acted, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [uuidv4(), p.signalId, p.tradeId, p.symbol, p.tf, p.best.name, p.direction, p.regime,
       p.estimatedEdge, p.best.confidence, p.rsi, p.volumeRatio, p.riskReward, p.entry,
       p.best.stopLoss, p.best.target, p.hourUtc, p.dayOfWeek, p.acted, Date.now()],
    );
  } catch {
    // Non-critical — don't let RL data failure block trading
  }
}
