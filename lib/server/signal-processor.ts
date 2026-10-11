import { v4 as uuidv4 } from 'uuid';
import { runAllPatterns, calcRSI, calcVolumeProfile } from '@/lib/pattern-engine';
import { classifyRegime } from '@/lib/simulator';
import { quickEdgeEstimate } from '@/lib/edge-score';
import { getPool, getState, incState } from './db';
import { enforceDrawdownHalt } from './risk';
import { bufferIsMixed, getCandles, getLivePrice } from './candle-store';
import { MAKER_FEE, MIN_STOP_PCT, STOP_SLIPPAGE, TAKER_FEE, netRiskReward } from './costs';
import { FEATURE_VERSION, mtfTrend } from '@/lib/features';

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
 * Every setup that passes the stop and R:R rules is followed as a shadow trade in
 * ALL modes, so its net-of-cost result is recorded.
 * 'log_only' (default): shadows only, no paper trades.
 * 'paper': additionally open paper trades for PAPER_SETUPS (validated + forward test).
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
 * UNVALIDATED forward tests, by Nitin's explicit decision (PLAN_HISTORY 2026-10-11 (2)).
 * These have NOT passed validation: Double Top short was the best shadow result
 * (+18.7R over 34 trades) but is the best of 12 setups on small samples, and was
 * negative in the 25,000-signal replay. Paper-traded at the normal 0.25% risk under
 * the -10% drawdown halt, and labelled 'forward test (unvalidated)' on every trade.
 */
const FORWARD_TEST_SETUPS = new Set<string>(['Double Top|short']);

/**
 * Setups that may paper-trade: validated ∪ forward test. The ALLOWED_SETUPS env var
 * can only NARROW this list (e.g. pause one setup); anything else it names is ignored.
 */
const CODE_PAPER_SETUPS = new Set<string>([...Array.from(VALIDATED_SETUPS), ...Array.from(FORWARD_TEST_SETUPS)]);
const PAPER_SETUPS = new Set(
  (process.env.ALLOWED_SETUPS ?? Array.from(CODE_PAPER_SETUPS).join(','))
    .split(',').map(s => s.trim()).filter(s => s && CODE_PAPER_SETUPS.has(s)),
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
  `[config] mode=${TRADING_MODE} paperSetups=[${Array.from(PAPER_SETUPS).join(', ')}] forwardTest=[${Array.from(FORWARD_TEST_SETUPS).filter(s => PAPER_SETUPS.has(s)).join(', ')}] ` +
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
  // Halts, the drawdown breaker and the daily limit block PAPER entries only (checked
  // where a paper trade would open). Signal logging and shadows always continue.
  // Risk and the daily limit scale with current equity, not starting capital
  const equity = parseFloat(state['capital'] ?? String(CAPITAL));
  const dailyLossLimit = equity * MAX_DAILY_LOSS_PCT;
  const dailyPnl = parseFloat(state['daily_pnl'] ?? '0');

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

  // Dataset features from closed bars only (buffers hold confirmed candles).
  // Non-critical: a feature failure must never block signal handling.
  try {
    const f = mtfTrend(getCandles(symbol, '15m'), htfCandles);
    // 'live_mixed' when any bar behind these features came from the Binance US seed
    // fallback: such rows don't match the pure-Bybit backfill and should be excluded
    // from training (PLAN_HISTORY 2026-10-06 (4)).
    const featureSource = bufferIsMixed(symbol, '15m') || bufferIsMixed(symbol, '1h') ? 'live_mixed' : 'live';
    await pool.query(
      `INSERT INTO signal_features
       (signal_id, feature_version, source, trend_15m_slope, trend_15m_pos,
        trend_1h_slope, trend_1h_pos, trend_4h_slope, trend_4h_pos, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (signal_id) DO NOTHING`,
      [signalId, FEATURE_VERSION, featureSource, f.trend_15m_slope, f.trend_15m_pos,
       f.trend_1h_slope, f.trend_1h_pos, f.trend_4h_slope, f.trend_4h_pos, now],
    );
  } catch (err) {
    console.error('[signal] feature write failed:', (err as Error).message);
  }

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

  // --- Shadow: EVERY qualifying setup, in every mode. ---
  // Shadows are the evidence base; they continue regardless of paper trading, halts
  // or the daily limit, so the dataset never has gaps that depend on the account.
  const { rows: openShadow } = await pool.query(
    `SELECT 1 FROM shadow_trades
     WHERE status = 'open' AND symbol = $1 AND timeframe = $2 AND pattern = $3 AND direction = $4`,
    [symbol, tf, best.name, direction]);
  const shadowed = openShadow.length === 0;
  if (shadowed) {
    await pool.query(
      `INSERT INTO shadow_trades
       (id, signal_id, symbol, timeframe, direction, entry, stop_loss, tp1, tp2, size,
        pattern, edge_score, tier, opened_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'open')`,
      [uuidv4(), signalId, symbol, tf, direction, entry, stopLoss, tp1, tp2, size,
       best.name, estimatedEdge, tier, now],
    );
    console.log(`[signal] shadow ${symbol} ${tf} ${direction} ${best.name} netRR=${riskReward.toFixed(2)}`);
  }
  let reason = shadowed ? 'shadowed' : 'same setup already being shadowed';

  // --- Paper trade: paper mode only, and only for validated or forward-test setups. ---
  let tradeId: string | null = null;
  if (TRADING_MODE === 'paper') {
    let blocked: string | null = null;
    if (!PAPER_SETUPS.has(setup)) blocked = 'setup not allowed';
    else if (state['halted'] === 'true') blocked = 'halted';
    else if (await enforceDrawdownHalt(state, equity)) blocked = 'drawdown halt';
    else if (dailyPnl <= -dailyLossLimit) blocked = 'daily loss limit';
    else {
      const { rows: openTrades } = await pool.query(`SELECT symbol FROM paper_trades WHERE status = 'open'`);
      if (openTrades.some((t: { symbol: string }) => t.symbol === symbol)) blocked = 'already in trade';
      else if (openTrades.length >= MAX_OPEN_TRADES) blocked = `max open trades (${MAX_OPEN_TRADES})`;
      // Daily limit counts open risk too, otherwise several trades opened just under the limit all lose
      else if (dailyPnl - openTrades.length * riskAmt - riskAmt < -dailyLossLimit) blocked = 'daily loss limit incl. open risk';
    }

    if (blocked) {
      reason += `; paper: ${blocked}`;
    } else {
      tradeId = uuidv4();
      const validated = VALIDATED_SETUPS.has(setup);
      // The label lives on the trade row itself so the dashboard and any P&L query can
      // separate forward-test trades from validated ones without joining signal_log.
      await pool.query(
        `INSERT INTO paper_trades
         (id, symbol, timeframe, direction, entry, stop_loss, tp1, tp2, size,
          pattern, edge_score, tier, opened_at, status, validation_status, signal_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'open',$14,$15)`,
        [tradeId, symbol, tf, direction, entry, stopLoss, tp1, tp2, size,
         best.name, estimatedEdge, tier, now,
         validated ? 'validated' : 'forward_test_unvalidated', signalId],
      );
      await incState('total_trades', 1);
      const kind = validated ? 'validated' : 'forward test (unvalidated)';
      reason += `; paper: opened (${kind})`;
      console.log(`[signal] PAPER ${symbol} ${tf} ${direction} ${best.name} netRR=${riskReward.toFixed(2)} — ${kind}`);
    }
  }

  await pool.query(`UPDATE signal_log SET reason = $1, acted = $2 WHERE id = $3`, [reason, tradeId !== null, signalId]);
  await rl(tradeId, tradeId !== null);
  if (shadowed || tradeId) lastSignalTime.set(ck, now);
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
