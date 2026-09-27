import { v4 as uuidv4 } from 'uuid';
import { runAllPatterns, calcRSI, calcVolumeProfile } from '@/lib/pattern-engine';
import { classifyRegime } from '@/lib/simulator';
import { quickEdgeEstimate } from '@/lib/edge-score';
import { getPool, getState, incState } from './db';
import { getCandles, getLivePrice } from './candle-store';

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'AVAXUSDT', 'LINKUSDT', 'DOGEUSDT', 'DOTUSDT',
  // ADAUSDT removed: price ~$0.20 causes sub-cent stop distances that noise hits immediately
];

// 10 cryptos × 3 timeframes — 1h is HTF regime filter, 5m + 15m fire signals
export const STREAMS: Array<{ symbol: string; tf: string }> = [
  ...SYMBOLS.map(s => ({ symbol: s, tf: '5m' })),
  ...SYMBOLS.map(s => ({ symbol: s, tf: '15m' })),
  ...SYMBOLS.map(s => ({ symbol: s, tf: '1h' })),
];

// Symbols that fire signals (1h streams are HTF filter only)
const SIGNAL_TIMEFRAMES = new Set(['5m', '15m']);

const MIN_CANDLES = 50;
// Edge < 70 lost money in both live periods (Sep 8-11: -$7.5k, Sep 26-27: -$30.6k)
const MIN_EDGE = 70;
// Correlated alt longs stopped out together; cap simultaneous exposure
const MAX_OPEN_TRADES = 3;
const MIN_RR = 1.5;
const CAPITAL = parseFloat(process.env.STARTING_CAPITAL ?? '10000');
const RISK_PER_TRADE = parseFloat(process.env.RISK_PER_TRADE ?? '0.01');
const MAX_DAILY_LOSS_PCT = 0.03;

const lastSignalTime = new Map<string, number>();

// Shorter cooldown on 5m (more frequent closes) vs 15m
function getCooldownMs(tf: string): number {
  return tf === '5m' ? 15 * 60 * 1000 : 30 * 60 * 1000;
}

// Live results: Shooting Star 0W/5L, Hammer 0W/2L, Ascending Triangle 9W/27L (-$71.5k)
const EXCLUDED_PATTERNS = new Set(['Shooting Star', 'Hammer', 'Ascending Triangle']);

// 5m and 15m candles close together; serialize per symbol so both can't open a trade at once
const symbolQueue = new Map<string, Promise<void>>();

export function processNewCandle(symbol: string, tf: string): Promise<void> {
  if (!SIGNAL_TIMEFRAMES.has(tf)) return Promise.resolve();
  const next = (symbolQueue.get(symbol) ?? Promise.resolve())
    .then(() => evaluateCandle(symbol, tf))
    .catch(err => console.error(`[signal] ${symbol} ${tf} error:`, err));
  symbolQueue.set(symbol, next);
  return next;
}

async function evaluateCandle(symbol: string, tf: string): Promise<void> {

  const state = await getState();
  if (state['halted'] === 'true') return;

  const dailyPnl = parseFloat(state['daily_pnl'] ?? '0');
  if (dailyPnl <= -(CAPITAL * MAX_DAILY_LOSS_PCT)) return;

  const ck = `${symbol}:${tf}`;
  const lastFired = lastSignalTime.get(ck) ?? 0;
  if (Date.now() - lastFired < getCooldownMs(tf)) return;

  const candles = getCandles(symbol, tf);
  if (candles.length < MIN_CANDLES) return;

  const htfCandles = getCandles(symbol, '1h');
  if (htfCandles.length >= 50) {
    const htfRegime = classifyRegime(htfCandles);
    if (htfRegime === 'ranging' || htfRegime === 'low_volatility') return;
  }

  const regime = classifyRegime(candles);
  const patterns = runAllPatterns(candles);
  if (!patterns.length) return;

  const best = patterns
    .filter(p => p.type !== 'neutral' && !p.conflicting && !EXCLUDED_PATTERNS.has(p.name))
    .sort((a, b) => b.confidence - a.confidence)[0];
  if (!best) return;

  if (!best.stopLoss || !best.target) return;
  const stopDist = Math.abs(best.support - best.stopLoss);
  if (stopDist <= 0 || best.riskReward < MIN_RR) return;

  const entry = getLivePrice(symbol) ?? candles[candles.length - 1].close;
  const direction: 'long' | 'short' = best.type === 'bullish' ? 'long' : 'short';

  if (direction === 'long' && (best.stopLoss >= entry || best.target <= entry)) return;
  if (direction === 'short' && (best.stopLoss <= entry || best.target >= entry)) return;

  const stopDistPrice = Math.abs(entry - best.stopLoss);

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
    `SELECT symbol FROM paper_trades WHERE status = 'open'`);
  const riskAmt = CAPITAL * RISK_PER_TRADE;
  let skipReason: string | null = null;
  if (openTrades.some((t: { symbol: string }) => t.symbol === symbol)) skipReason = 'already in trade';
  else if (openTrades.length >= MAX_OPEN_TRADES) skipReason = `max open trades (${MAX_OPEN_TRADES})`;
  // Daily limit counts open risk too, otherwise several trades opened just under the limit all lose
  else if (dailyPnl - openTrades.length * riskAmt - riskAmt < -(CAPITAL * MAX_DAILY_LOSS_PCT)) {
    skipReason = 'daily loss limit incl. open risk';
  }
  if (skipReason) {
    await pool.query(`UPDATE signal_log SET reason = $1 WHERE id = $2`, [skipReason, signalId]);
    await saveRlExperience(pool, {
      signalId, tradeId: null, symbol, tf, best, direction,
      regime, estimatedEdge, tier, rsi, volumeRatio: volProfile.volumeRatio,
      riskReward, entry, hourUtc, dayOfWeek, acted: false,
    });
    return;
  }

  const size = stopDistPrice > 0 ? riskAmt / stopDistPrice : 0;
  if (size <= 0) return;

  const tp1 = direction === 'long'
    ? entry + (stopDistPrice * 1.5)
    : entry - (stopDistPrice * 1.5);

  // TP2 must be at least 2× stop distance from entry — pattern targets are sometimes
  // at or below TP1 (observed: SOLUSDT tp1=100.305, tp2=100.31; DOTUSDT tp2 < tp1).
  // When TP2 ≈ TP1 there is no room for the trailing-stop runner to work.
  const tp2Min = direction === 'long'
    ? entry + stopDistPrice * 2.0
    : entry - stopDistPrice * 2.0;
  const tp2 = direction === 'long'
    ? Math.max(best.target, tp2Min)
    : Math.min(best.target, tp2Min);

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

  await incState('total_trades', 1);

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
