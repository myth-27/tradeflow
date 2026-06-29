import type { ActiveSignal } from '@/hooks/usePatternDetection';

export type TradeStatus = 'pending' | 'open' | 'partial' | 'closed' | 'expired' | 'cancelled';
export type TradeDirection = 'long' | 'short';
export type ExitReason = 'target' | 'stop' | 'breakeven_stop' | 'manual' | null;

// Fixed notional per paper trade — every % figure also has a real dollar amount next to it,
// so "what actually happened" never requires mental math.
export const POSITION_NOTIONAL_USD = 10000;

export type TradeEventType =
  | 'OPENED' | 'ENTRY_HIT' | 'TP1_HIT' | 'TP2_HIT' | 'STOP_HIT'
  | 'BREAKEVEN_STOP_HIT' | 'MANUAL_CLOSE' | 'EXPIRED' | 'CANCELLED';

export type TradeEvent = {
  type: TradeEventType;
  time: number; // ms epoch
  price: number | null;
  message: string;
};

export type Trade = {
  id: string;
  signalId?: number;
  symbol: string;
  direction: TradeDirection;
  status: TradeStatus;

  entryPrice: number;
  actualEntry: number | null;
  entryTime: number | null;

  stopLoss: number;
  currentStop: number;

  tp1: number;
  tp2: number;
  tp3: number;

  positionSize: number;
  remainingSize: number;
  positionSizeUsd: number; // fixed $10,000 notional — see POSITION_NOTIONAL_USD

  tp1Hit: boolean;
  tp2Hit: boolean;
  tp1HitTime: number | null;
  tp2HitTime: number | null;
  stopHitTime: number | null;
  actualExit: number | null;
  exitReason: ExitReason; // WHY the trade closed — answers "did it hit the SL?" directly

  realizedPnlPct: number;
  unrealizedPnlPct: number;
  totalPnlPct: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  rMultiple: number;

  patternName: string;
  confidence: number;
  timeframe: string;
  signalTime: number; // candle time in seconds — used for expiry math
  notes: string;
  events: TradeEvent[]; // full audit trail — every state transition, in order
};

export type SessionStats = {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  totalPnlUsd: number;
  avgRMultiple: number;
};

const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400,
};

function dir(direction: TradeDirection) {
  return direction === 'long' ? 1 : -1;
}

function usd(pct: number) {
  return (pct / 100) * POSITION_NOTIONAL_USD;
}

function logEvent(trade: Trade, type: TradeEventType, price: number | null, message: string): TradeEvent[] {
  return [...trade.events, { type, time: Date.now(), price, message }];
}

export function calculateTargets(entry: number, stopLoss: number, direction: TradeDirection) {
  const risk = Math.abs(entry - stopLoss);
  const mult = dir(direction);
  return {
    tp1: entry + risk * 1.0 * mult,
    tp2: entry + risk * 2.0 * mult,
    tp3: entry + risk * 3.0 * mult,
    risk,
    riskPct: entry > 0 ? (risk / entry) * 100 : 0,
  };
}

export function createTrade(signal: ActiveSignal, symbol: string, timeframe: string): Trade {
  const direction: TradeDirection = signal.direction === 'LONG' ? 'long' : 'short';
  const targets = calculateTargets(signal.entry, signal.stop, direction);
  const trade: Trade = {
    id: crypto.randomUUID(),
    signalId: (signal as any).signalId,
    symbol,
    direction,
    status: 'pending',
    entryPrice: signal.entry,
    actualEntry: null,
    entryTime: null,
    stopLoss: signal.stop,
    currentStop: signal.stop,
    tp1: targets.tp1,
    tp2: targets.tp2,
    tp3: targets.tp3,
    positionSize: 1.0,
    remainingSize: 1.0,
    positionSizeUsd: POSITION_NOTIONAL_USD,
    tp1Hit: false,
    tp2Hit: false,
    tp1HitTime: null,
    tp2HitTime: null,
    stopHitTime: null,
    actualExit: null,
    exitReason: null,
    realizedPnlPct: 0,
    unrealizedPnlPct: 0,
    totalPnlPct: 0,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalPnlUsd: 0,
    rMultiple: 0,
    patternName: signal.pattern.name,
    confidence: signal.confidence,
    timeframe,
    signalTime: signal.candleTime,
    notes: '',
    events: [],
  };
  trade.events = logEvent(trade, 'OPENED', signal.entry,
    `Paper trade opened on ${signal.pattern.name} (${signal.confidence}% confidence) — waiting for entry at $${signal.entry.toFixed(2)}`);
  return trade;
}

export function managePendingTrade(
  trade: Trade,
  currentPrice: number,
  currentCandleTime: number,
  isClosed: boolean
): Trade {
  if (trade.status !== 'pending') return trade;

  const entryHit = trade.direction === 'long'
    ? currentPrice >= trade.entryPrice
    : currentPrice <= trade.entryPrice;

  if (entryHit) {
    const updated: Trade = { ...trade, status: 'open', actualEntry: trade.entryPrice, entryTime: Date.now() };
    updated.events = logEvent(updated, 'ENTRY_HIT', trade.entryPrice, `Entry filled at $${trade.entryPrice.toFixed(2)}`);
    return updated;
  }

  if (isClosed) {
    const candleWidth = INTERVAL_SECONDS[trade.timeframe] ?? 300;
    const candlesSince = (currentCandleTime - trade.signalTime) / candleWidth;
    if (candlesSince > 3) {
      const updated: Trade = { ...trade, status: 'expired' };
      updated.events = logEvent(updated, 'EXPIRED', currentPrice,
        `Entry never reached within 3 candles — price was $${currentPrice.toFixed(2)} vs planned entry $${trade.entryPrice.toFixed(2)}`);
      return updated;
    }
  }

  return trade;
}

export function hitTP1(trade: Trade, price: number): Trade {
  const closedPnlPct = ((price - trade.actualEntry!) / trade.actualEntry!) * 100 * 0.5 * dir(trade.direction);
  const beStop = trade.direction === 'long'
    ? trade.actualEntry! * 0.9995
    : trade.actualEntry! * 1.0005;
  const realizedPnlPct = trade.realizedPnlPct + closedPnlPct;
  const updated: Trade = {
    ...trade,
    tp1Hit: true,
    tp1HitTime: Date.now(),
    status: 'partial',
    realizedPnlPct,
    realizedPnlUsd: usd(realizedPnlPct),
    remainingSize: 0.5,
    currentStop: beStop,
  };
  updated.events = logEvent(updated, 'TP1_HIT', price,
    `TP1 hit at $${price.toFixed(2)} — 50% closed for ${usd(closedPnlPct) >= 0 ? '+' : ''}$${usd(closedPnlPct).toFixed(0)} (${closedPnlPct >= 0 ? '+' : ''}${closedPnlPct.toFixed(2)}%), stop moved to breakeven $${beStop.toFixed(2)}`);
  return updated;
}

export function hitTP2(trade: Trade, price: number): Trade {
  const closedPnlPct = ((price - trade.actualEntry!) / trade.actualEntry!) * 100 * trade.remainingSize * dir(trade.direction);
  const totalPnl = trade.realizedPnlPct + closedPnlPct;
  const riskPct = (Math.abs(trade.actualEntry! - trade.stopLoss) / trade.actualEntry!) * 100;
  const updated: Trade = {
    ...trade,
    tp2Hit: true,
    tp2HitTime: Date.now(),
    status: 'closed',
    realizedPnlPct: totalPnl,
    realizedPnlUsd: usd(totalPnl),
    remainingSize: 0,
    actualExit: price,
    exitReason: 'target',
    totalPnlPct: totalPnl,
    totalPnlUsd: usd(totalPnl),
    rMultiple: riskPct > 0 ? totalPnl / riskPct : 0,
  };
  updated.events = logEvent(updated, 'TP2_HIT', price,
    `TP2 target reached at $${price.toFixed(2)} — trade closed. Total ${usd(totalPnl) >= 0 ? '+' : ''}$${usd(totalPnl).toFixed(0)} (${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%, ${updated.rMultiple.toFixed(1)}R)`);
  return updated;
}

export function closeTrade(trade: Trade, price: number, reason: 'stop' | 'manual'): Trade {
  const closedPnlPct = ((price - trade.actualEntry!) / trade.actualEntry!) * 100 * trade.remainingSize * dir(trade.direction);
  const totalPnl = trade.realizedPnlPct + closedPnlPct;
  const riskPct = (Math.abs(trade.actualEntry! - trade.stopLoss) / trade.actualEntry!) * 100;
  const exitReason: ExitReason = reason === 'manual' ? 'manual' : (trade.tp1Hit ? 'breakeven_stop' : 'stop');
  const updated: Trade = {
    ...trade,
    status: 'closed',
    actualExit: price,
    exitReason,
    realizedPnlPct: totalPnl,
    realizedPnlUsd: usd(totalPnl),
    remainingSize: 0,
    totalPnlPct: totalPnl,
    totalPnlUsd: usd(totalPnl),
    rMultiple: riskPct > 0 ? totalPnl / riskPct : 0,
    stopHitTime: reason === 'stop' ? Date.now() : trade.stopHitTime,
  };

  if (reason === 'manual') {
    updated.events = logEvent(updated, 'MANUAL_CLOSE', price,
      `Manually closed at $${price.toFixed(2)} — ${usd(totalPnl) >= 0 ? '+' : ''}$${usd(totalPnl).toFixed(0)} (${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%)`);
  } else if (exitReason === 'breakeven_stop') {
    updated.events = logEvent(updated, 'BREAKEVEN_STOP_HIT', price,
      `Stopped at breakeven $${price.toFixed(2)} after TP1 — remaining 50% closed flat. Total ${usd(totalPnl) >= 0 ? '+' : ''}$${usd(totalPnl).toFixed(0)} (${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%) from the TP1 partial`);
  } else {
    updated.events = logEvent(updated, 'STOP_HIT', price,
      `Stop loss hit at $${price.toFixed(2)} — full loss. ${usd(totalPnl) >= 0 ? '+' : ''}$${usd(totalPnl).toFixed(0)} (${totalPnl.toFixed(2)}%, ${updated.rMultiple.toFixed(1)}R)`);
  }
  return updated;
}

export function cancelPendingTrade(trade: Trade): Trade {
  const updated: Trade = { ...trade, status: 'cancelled' };
  updated.events = logEvent(updated, 'CANCELLED', null, 'Trade cancelled manually before entry was hit');
  return updated;
}

export function monitorOpenTrade(
  trade: Trade,
  currentPrice: number,
  candleHigh: number,
  candleLow: number
): Trade {
  if (trade.status !== 'open' && trade.status !== 'partial') return trade;
  let t = trade;

  const stopTriggered = t.direction === 'long'
    ? currentPrice <= t.currentStop
    : currentPrice >= t.currentStop;
  if (stopTriggered) {
    return closeTrade(t, currentPrice, 'stop');
  }

  if (!t.tp1Hit) {
    const tp1Triggered = t.direction === 'long' ? candleHigh >= t.tp1 : candleLow <= t.tp1;
    if (tp1Triggered) t = hitTP1(t, t.tp1);
  }

  if (t.tp1Hit && !t.tp2Hit) {
    const tp2Triggered = t.direction === 'long' ? candleHigh >= t.tp2 : candleLow <= t.tp2;
    if (tp2Triggered) t = hitTP2(t, t.tp2);
  }

  if (t.status === 'open' || t.status === 'partial') {
    const unrealizedPct = ((currentPrice - t.actualEntry!) / t.actualEntry!) * 100 * dir(t.direction) * t.remainingSize;
    const totalPct = t.realizedPnlPct + unrealizedPct;
    t = {
      ...t,
      unrealizedPnlPct: unrealizedPct,
      unrealizedPnlUsd: usd(unrealizedPct),
      totalPnlPct: totalPct,
      totalPnlUsd: usd(totalPct),
    };
  }

  return t;
}

export function getSessionStats(trades: Trade[]): SessionStats {
  const today = new Date().toDateString();
  const todayClosed = trades.filter(
    t => t.status === 'closed' && new Date(t.signalTime * 1000).toDateString() === today
  );
  const wins = todayClosed.filter(t => t.totalPnlPct > 0);
  const losses = todayClosed.filter(t => t.totalPnlPct <= 0);
  const totalPnl = todayClosed.reduce((a, t) => a + t.totalPnlPct, 0);
  return {
    totalTrades: todayClosed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: todayClosed.length > 0 ? (wins.length / todayClosed.length) * 100 : 0,
    totalPnl,
    totalPnlUsd: todayClosed.reduce((a, t) => a + t.totalPnlUsd, 0),
    avgRMultiple: todayClosed.length > 0
      ? todayClosed.reduce((a, t) => a + t.rMultiple, 0) / todayClosed.length
      : 0,
  };
}

// Backfills any fields missing from trades persisted by an older schema version (e.g. before
// events/exitReason/usd fields existed) so every consumer can rely on the full Trade shape
// regardless of when the record was saved.
function normalizeTrade(t: Partial<Trade> & Pick<Trade, 'id'>): Trade {
  const realizedPnlPct = t.realizedPnlPct ?? 0;
  const unrealizedPnlPct = t.unrealizedPnlPct ?? 0;
  const totalPnlPct = t.totalPnlPct ?? realizedPnlPct;
  return {
    id: t.id,
    symbol: t.symbol ?? '',
    direction: t.direction ?? 'long',
    status: t.status ?? 'closed',
    entryPrice: t.entryPrice ?? 0,
    actualEntry: t.actualEntry ?? null,
    entryTime: t.entryTime ?? null,
    stopLoss: t.stopLoss ?? 0,
    currentStop: t.currentStop ?? t.stopLoss ?? 0,
    tp1: t.tp1 ?? 0,
    tp2: t.tp2 ?? 0,
    tp3: t.tp3 ?? 0,
    positionSize: t.positionSize ?? 1,
    remainingSize: t.remainingSize ?? 0,
    positionSizeUsd: t.positionSizeUsd ?? POSITION_NOTIONAL_USD,
    tp1Hit: t.tp1Hit ?? false,
    tp2Hit: t.tp2Hit ?? false,
    tp1HitTime: t.tp1HitTime ?? null,
    tp2HitTime: t.tp2HitTime ?? null,
    stopHitTime: t.stopHitTime ?? null,
    actualExit: t.actualExit ?? null,
    exitReason: t.exitReason ?? (t.status === 'closed'
      ? (t.tp2Hit ? 'target' : (t.tp1Hit ? 'breakeven_stop' : 'stop'))
      : null),
    realizedPnlPct,
    unrealizedPnlPct,
    totalPnlPct,
    realizedPnlUsd: t.realizedPnlUsd ?? usd(realizedPnlPct),
    unrealizedPnlUsd: t.unrealizedPnlUsd ?? usd(unrealizedPnlPct),
    totalPnlUsd: t.totalPnlUsd ?? usd(totalPnlPct),
    rMultiple: t.rMultiple ?? 0,
    patternName: t.patternName ?? 'Unknown',
    confidence: t.confidence ?? 0,
    timeframe: t.timeframe ?? '5m',
    signalTime: t.signalTime ?? 0,
    notes: t.notes ?? '',
    events: t.events ?? [],
  };
}

const JOURNAL_KEY = 'tradeflow_journal';

export const TradeStorage = {
  saveTradeJournal(trades: Trade[]) {
    try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(trades.slice(-200))); } catch { /* ignore */ }
  },
  loadTradeJournal(): Trade[] {
    try {
      if (typeof window === 'undefined') return [];
      const raw = localStorage.getItem(JOURNAL_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as (Partial<Trade> & Pick<Trade, 'id'>)[];
      return parsed.map(normalizeTrade);
    } catch { return []; }
  },
  updateTrade(trade: Trade) {
    const all = this.loadTradeJournal();
    const idx = all.findIndex(t => t.id === trade.id);
    const oldTrade = idx >= 0 ? all[idx] : null;

    if (idx >= 0) all[idx] = trade;
    else all.push(trade);
    this.saveTradeJournal(all);

    // TradeFlow V3: Memory & Learning triggers
    if (oldTrade && oldTrade.status !== 'closed' && trade.status === 'closed') {
      const result = trade.rMultiple > 0.1 ? 'win' : trade.rMultiple < -0.1 ? 'loss' : 'breakeven';
      const holdingTime = trade.actualExit && trade.entryTime ? trade.actualExit * 1000 - trade.entryTime : 0;
      
      // 1. Auto-record outcome to SignalMemory
      if (trade.signalId) {
        import('./signal-memory').then(m => m.updateSignalOutcome(trade.signalId!, result, trade.rMultiple, holdingTime))
          .catch(err => console.error('Failed to update signal outcome:', err));
      }

      // 2. Auto-update EdgeDatabase
      import('./edge-database').then(m => {
        // Find corresponding signal memory to get full context (regime, session)
        if (trade.signalId) {
          import('./db').then(db => {
            db.getDB().signalMemory.get(trade.signalId!).then(sig => {
              if (sig) {
                m.updateEdgeAfterOutcome(sig).catch(console.error);
              }
            });
          });
        }
      }).catch(console.error);

      // 3. Trigger learning cycle check
      import('./continuous-improvement').then(m => m.runImprovementCycle())
        .catch(console.error);
    }
  },
};
