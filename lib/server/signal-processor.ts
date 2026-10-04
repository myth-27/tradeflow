import { v4 as uuidv4 } from 'uuid';
import { runAllPatterns, calcRSI, calcVolumeProfile } from '@/lib/pattern-engine';
import { classifyRegime } from '@/lib/simulator';
import { quickEdgeEstimate } from '@/lib/edge-score';
import { getPool, getState, incState } from './db';
import { enforceDrawdownHalt } from './risk';
import { getCandles, getLivePrice } from './candle-store';
import { MAKER_FEE, MIN_STOP_PCT, STOP_SLIPPAGE, TAKER_FEE, netRiskReward } from './costs';

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

/**
 * 'log_only' (default): no paper trades. Every setup that passes the stop and
 * R:R rules is followed as a shadow trade so its net-of-cost result is recorded.
 * 'paper': open paper trades, but ONLY for setups listed in ALLOWED_SETUPS.
 *
 * Why log-only: a cost-aware replay of all 11,540 logged signals (8 Sep – 4 Oct)
 * found no setup with positive expectancy net of fees. Gross expectancy was
 * -0.05R/trade and random-direction entries with identical exits did no worse.
 * The two setups traded since 2 Oct were reliably negative under the old stop
 * rule (t = -2.9 and -4.9). Setups must earn their way back with shadow evidence.
 */
const TRADING_MODE: 'log_only' | 'paper' = process.env.TRADING_MODE === 'paper' ? 'paper' : 'log_only';

/**
 * Setups that have passed validation, as "Pattern|direction". A setup belongs here
 * only after its shadow trades beat random-direction entries with identical exits,
 * net of costs, at t >= 3 over at least 300 trades — and it gets here through a
 * reviewed code change with a PLAN_HISTORY entry, never through a deploy variable.
 * Empty: nothing has passed.
 */
const VALIDATED_SETUPS = new Set<string>([]);

/**
 * The ALLOWED_SETUPS env var can only NARROW the validated list (e.g. pause one
 * setup). Anything it names that isn't validated is ignored.
 */
const ALLOWED_SETUPS = new Set(
  (process.env.ALLOWED_SETUPS ?? Array.from(VALIDATED_SETUPS).join(','))
    .split(',').map(s => s.trim()).filter(s => s && VALIDATED_SETUPS.has(s)),
);

const MAX_OPEN_TRADES = 2;            // crypto majors move together; 4 shorts were one bet
const MIN_RR = 1.5;                   // measured on the actual stop, net of costs
const CAPITAL = parseFloat(process.env.STARTING_CAPITAL ?? '10000');
/** 0.25% of equity per trade (decided 2026-10-04). The env var may lower it, never raise it. */
const MAX_RISK_PER_TRADE = 0.0025;
const RISK_PER_TRADE = (() => {
  const n = Number(process.env.RISK_PER_TRADE);
  if (!Number.isFinite(n) || n <= 0) return MAX_RISK_PER_TRADE;
  if (n > MAX_RISK_PER_TRADE) {
    console.warn(`[config] RISK_PER_TRADE=${n} exceeds the reviewed cap ${MAX_RISK_PER_TRADE}; using ${MAX_RISK_PER_TRADE}`);
    return MAX_RISK_PER_TRADE;
  }
  return n;
})();
const MAX_DAILY_LOSS_PCT = 0.03;

// Effective configuration, logged once at startup so a deploy's behaviour is visible in its logs
console.log(
  `[config] mode=${TRADING_MODE} allowedSetups=[${Array.from(ALLOWED_SETUPS).join(', ')}] ` +
  `risk=${RISK_PER_TRADE} maxOpen=${MAX_OPEN_TRADES} minNetRR=${MIN_RR} dailyLoss=${MAX_DAILY_LOSS_PCT} ` +
  `minStop=${MIN_STOP_PCT} taker=${TAKER_FEE} maker=${MAKER_FEE} stopSlip=${STOP_SLIPPAGE}`,
);

const lastSignalTime = new Map<string, number>();

// Shorter cooldown on 5m (more frequent closes) vs 15m
function getCooldownMs(tf: string): number {
  return tf === '5m' ? 15 * 60 * 1000 : 30 * 60 * 1000;
}

// Kept out of best-pattern selection so the logged signal stream stays comparable with replay data
const EXCLUDED_PATTERNS = new Set([
  'Ascending Triangle', 'Shooting Star', 'Hammer', 'Double Bottom', 'Morning Star',
]);

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
  // Risk and the daily limit scale with current equity, not starting capital
  const equity = parseFloat(state['capital'] ?? String(CAPITAL));
  if (TRADING_MODE === 'paper' && await enforceDrawdownHalt(state, equity)) return;
  const dailyLossLimit = equity * MAX_DAILY_LOSS_PCT;
  const dailyPnl = parseFloat(state['daily_pnl'] ?? '0');
  if (TRADING_MODE === 'paper' && dailyPnl <= -dailyLossLimit) return;

  const ck = `${symbol}:${tf}`;
  const lastFired = lastSignalTime.get(ck) ?? 0;
  if (Date.now() - lastFired < getCooldownMs(tf)) return;

  const candles = getCandles(symbol, tf);
  if (candles.length < MIN_CANDLES) return;

  const htfCandles = getCandles(symbol, '1h');
  if (htfCandles.length < 50) return;
  const htfRegime = classifyRegime(htfCandles);
  if (htfRegime === 'ranging' || htfRegime === 'low_volatility') return;

  const regime = classifyRegime(candles);
  const patterns = runAllPatterns(candles);
  if (!patterns.length) return;

  const best = patterns
    .filter(p => p.type !== 'neutral' && !p.conflicting && !EXCLUDED_PATTERNS.has(p.name))
    .sort((a, b) => b.confidence - a.confidence)[0];
  if (!best) return;
  if (!best.stopLoss || !best.target) return;

  const entry = getLivePrice(symbol) ?? candles[candles.length - 1].close;
  const direction: 'long' | 'short' = best.type === 'bullish' ? 'long' : 'short';

  if (direction === 'long' && (best.stopLoss >= entry || best.target <= entry)) return;
  if (direction === 'short' && (best.stopLoss <= entry || best.target >= entry)) return;

  // The pattern's own invalidation level is the stop. The previous rule took the
  // TIGHTEST of pattern stop, 1.5x ATR and 1%, which put the median stop at 1.5 ATR on
  // 5m bars: 40% of stop-outs came within 15 minutes and costs averaged 0.60R/trade.
  const stopLoss = best.stopLoss;
  const stopDistPrice = Math.abs(entry - stopLoss);
  const riskReward = netRiskReward(entry, stopLoss, best.target);

  const closes = candles.map(c => c.close);
  const rsi = calcRSI(closes);
  const volProfile = calcVolumeProfile(candles);
  const { estimatedEdge, tier } = quickEdgeEstimate(
    best.confidence, regime, direction, volProfile.volumeRatio, rsi,
  );

  const now = Date.now();
  const dt = new Date(now);
  const hourUtc = dt.getUTCHours();
  const dayOfWeek = dt.getUTCDay();
  const setup = `${best.name}|${direction}`;

  const signalId = uuidv4();
  const pool = getPool();

  // Every detected setup is logged — including ones the rules below reject — so the
  // signal stream stays complete for replays. risk_reward is net of costs.
  await pool.query(
    `INSERT INTO signal_log
     (id, symbol, timeframe, pattern, direction, confidence, edge_score, tier, regime,
      entry, stop_loss, target, risk_reward, acted, reason, detected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [signalId, symbol, tf, best.name, direction,
     best.confidence, estimatedEdge, tier, regime,
     entry, stopLoss, best.target, riskReward,
     false, null, now],
  );

  const rl = (tradeId: string | null, acted: boolean) => saveRlExperience(pool, {
    signalId, tradeId, symbol, tf, best: { ...best, stopLoss }, direction,
    regime, estimatedEdge, tier, rsi, volumeRatio: volProfile.volumeRatio,
    riskReward, entry, hourUtc, dayOfWeek, acted,
  });
  const reject = async (reason: string) => {
    await pool.query(`UPDATE signal_log SET reason = $1 WHERE id = $2`, [reason, signalId]);
    await rl(null, false);
  };

  // Rules that apply in every mode: a trade we would never take is not worth shadowing.
  if (stopDistPrice < entry * MIN_STOP_PCT) {
    return reject(`stop ${(100 * stopDistPrice / entry).toFixed(2)}% < ${(100 * MIN_STOP_PCT).toFixed(1)}% floor`);
  }
  if (riskReward < MIN_RR) {
    return reject(`net R:R ${riskReward.toFixed(2)} < ${MIN_RR}`);
  }

  const riskAmt = equity * RISK_PER_TRADE;
  const size = riskAmt / stopDistPrice;
  if (!(size > 0)) return;

  // TP1 at 1.5R takes half off and moves the stop to breakeven; TP2 is the pattern target
  const tp1 = direction === 'long' ? entry + stopDistPrice * 1.5 : entry - stopDistPrice * 1.5;
  const tp2 = best.target;

  if (TRADING_MODE === 'log_only') {
    // One open shadow per setup per symbol/timeframe; no capital, no position limits
    const { rows } = await pool.query(
      `SELECT 1 FROM shadow_trades
       WHERE status = 'open' AND symbol = $1 AND timeframe = $2 AND pattern = $3 AND direction = $4`,
      [symbol, tf, best.name, direction]);
    if (rows.length) return reject('log-only: same setup already being shadowed');

    const shadowId = uuidv4();
    await pool.query(
      `INSERT INTO shadow_trades
       (id, signal_id, symbol, timeframe, direction, entry, stop_loss, tp1, tp2, size,
        pattern, edge_score, tier, opened_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'open')`,
      [shadowId, signalId, symbol, tf, direction, entry, stopLoss, tp1, tp2, size,
       best.name, estimatedEdge, tier, now],
    );
    await pool.query(`UPDATE signal_log SET reason = $1 WHERE id = $2`, ['log-only: shadowed', signalId]);
    await rl(null, false);
    lastSignalTime.set(ck, now);
    console.log(`[signal] shadow ${symbol} ${tf} ${direction} ${best.name} netRR=${riskReward.toFixed(2)}`);
    return;
  }

  // --- paper mode ---
  if (!ALLOWED_SETUPS.has(setup)) return reject(`setup not validated: ${best.name} ${direction}`);

  const { rows: openTrades } = await pool.query(
    `SELECT symbol FROM paper_trades WHERE status = 'open'`);
  let skipReason: string | null = null;
  if (openTrades.some((t: { symbol: string }) => t.symbol === symbol)) skipReason = 'already in trade';
  else if (openTrades.length >= MAX_OPEN_TRADES) skipReason = `max open trades (${MAX_OPEN_TRADES})`;
  // Daily limit counts open risk too, otherwise several trades opened just under the limit all lose
  else if (dailyPnl - openTrades.length * riskAmt - riskAmt < -dailyLossLimit) {
    skipReason = 'daily loss limit incl. open risk';
  }
  if (skipReason) return reject(skipReason);

  const tradeId = uuidv4();
  await pool.query(
    `INSERT INTO paper_trades
     (id, symbol, timeframe, direction, entry, stop_loss, tp1, tp2, size,
      pattern, edge_score, tier, opened_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'open')`,
    [tradeId, symbol, tf, direction, entry, stopLoss, tp1, tp2, size,
     best.name, estimatedEdge, tier, now],
  );

  await pool.query(`UPDATE signal_log SET acted = true WHERE id = $1`, [signalId]);
  await rl(tradeId, true);
  await incState('total_trades', 1);

  lastSignalTime.set(ck, now);
  console.log(`[signal] ${symbol} ${tf} ${direction} ${best.name} netRR=${riskReward.toFixed(2)} edge=${estimatedEdge}`);
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
