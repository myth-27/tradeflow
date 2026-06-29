'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Candle } from '@/lib/binance-ws';
import type { ActiveSignal } from '@/hooks/usePatternDetection';
import {
  type Trade, type SessionStats,
  createTrade, managePendingTrade, monitorOpenTrade, cancelPendingTrade,
  closeTrade as closeTradeFn, getSessionStats, TradeStorage,
} from '@/lib/trade-manager';
import { canOpenTrade, countTradesToday } from '@/lib/trade-guardrails';

export type ToastFn = (message: string, type: 'success' | 'error' | 'info') => void;

export function useTradeManager(
  currentPrice: number,
  currentCandle: Candle | null,
  symbol: string,
  timeframe: string,
  showToast?: ToastFn,
) {
  const [activeTrade, setActiveTrade] = useState<Trade | null>(null);
  const [tradeHistory, setTradeHistory] = useState<Trade[]>([]);
  const loadedRef = useRef(false);
  // A candle "closes" the moment a new one starts forming — i.e. currentCandle.time advances.
  const prevCandleTimeRef = useRef(0);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    setTradeHistory(TradeStorage.loadTradeJournal());
  }, []);

  const sessionStats: SessionStats = useMemo(() => getSessionStats(tradeHistory), [tradeHistory]);

  const archiveTrade = useCallback((trade: Trade) => {
    setTradeHistory(prev => {
      const updated = [...prev.filter(t => t.id !== trade.id), trade];
      TradeStorage.saveTradeJournal(updated);
      return updated;
    });
    setActiveTrade(null);
  }, []);

  // Price/candle monitoring — only while the active trade matches the symbol currently on screen,
  // since this app only feeds live data for one symbol at a time.
  useEffect(() => {
    if (!currentCandle) return;
    const isClosed = prevCandleTimeRef.current !== 0 && currentCandle.time !== prevCandleTimeRef.current;
    prevCandleTimeRef.current = currentCandle.time;

    if (!activeTrade || activeTrade.symbol !== symbol) return;

    if (activeTrade.status === 'pending') {
      const updated = managePendingTrade(activeTrade, currentPrice, currentCandle.time, isClosed);
      if (updated !== activeTrade) {
        if (updated.status === 'open') showToast?.('🚀 Trade entered!', 'success');
        if (updated.status === 'expired') showToast?.('⏰ Entry expired — price never reached entry', 'info');
        TradeStorage.updateTrade(updated);
        if (updated.status === 'expired') archiveTrade(updated);
        else setActiveTrade(updated);
      }
      return;
    }

    if (activeTrade.status === 'open' || activeTrade.status === 'partial') {
      const prevTp1 = activeTrade.tp1Hit;
      const updated = monitorOpenTrade(activeTrade, currentPrice, currentCandle.high, currentCandle.low);
      if (updated.tp1Hit && !prevTp1) {
        showToast?.(`✅ TP1 Hit at $${updated.tp1.toFixed(2)}! Stop moved to breakeven $${updated.currentStop.toFixed(2)}`, 'success');
      }
      if (updated.status === 'closed' && updated.tp2Hit) {
        showToast?.(`🎯 TP2 Hit at $${updated.actualExit!.toFixed(2)}! +$${updated.realizedPnlUsd.toFixed(0)} (${updated.realizedPnlPct.toFixed(2)}%)`, 'success');
      }
      if (updated.status === 'closed' && !updated.tp2Hit) {
        showToast?.(
          updated.tp1Hit
            ? `⚡ Stopped at breakeven $${updated.actualExit!.toFixed(2)} after TP1. Net +$${updated.realizedPnlUsd.toFixed(0)} (${updated.realizedPnlPct.toFixed(2)}%)`
            : `🛑 Stop Hit at $${updated.actualExit!.toFixed(2)}. -$${Math.abs(updated.realizedPnlUsd).toFixed(0)} (${updated.realizedPnlPct.toFixed(2)}%, ${updated.rMultiple.toFixed(1)}R)`,
          updated.tp1Hit ? 'info' : 'error'
        );
      }
      TradeStorage.updateTrade(updated);
      if (updated.status === 'closed') archiveTrade(updated);
      else setActiveTrade(updated);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPrice, currentCandle, symbol]);

  const openTrade = useCallback((signal: ActiveSignal | null) => {
    if (!signal) return;
    const guard = canOpenTrade(signal, activeTrade, countTradesToday(tradeHistory));
    if (!guard.allowed) {
      showToast?.(`🚫 ${guard.reason}`, 'error');
      return;
    }
    const trade = createTrade(signal, symbol, timeframe);
    setActiveTrade(trade);
    TradeStorage.updateTrade(trade);
    showToast?.(`📊 Trade opened — waiting for entry at $${trade.entryPrice.toFixed(2)} ($${trade.positionSizeUsd.toLocaleString()} notional)`, 'info');
  }, [activeTrade, tradeHistory, symbol, timeframe, showToast]);

  const closeTradeManually = useCallback(() => {
    // Defense in depth: currentPrice only ever reflects the symbol on screen. Even though the
    // UI already hides the close button for a mismatched-symbol trade, never let this fire
    // against the wrong price — that's exactly how a real trade ends up "closed" at a bogus
    // price from a totally different asset.
    if (!activeTrade || activeTrade.symbol !== symbol) return;
    const closed = closeTradeFn(activeTrade, currentPrice, 'manual');
    archiveTrade(closed);
  }, [activeTrade, currentPrice, symbol, archiveTrade]);

  const cancelTrade = useCallback(() => {
    if (!activeTrade) return;
    archiveTrade(cancelPendingTrade(activeTrade));
  }, [activeTrade, archiveTrade]);

  // Includes realized P&L from a TP1 partial close, scaled by the size still open — a naive
  // (currentPrice - entry) calc would overstate P&L once half the position is already banked.
  // Only valid while currentPrice actually reflects this trade's own symbol.
  const livePnl = activeTrade?.actualEntry && activeTrade.symbol === symbol
    ? activeTrade.realizedPnlPct +
      ((currentPrice - activeTrade.actualEntry) / activeTrade.actualEntry) * 100 *
      (activeTrade.direction === 'long' ? 1 : -1) * activeTrade.remainingSize
    : 0;

  return {
    activeTrade, tradeHistory, sessionStats, livePnl,
    openTrade, closeTrade: closeTradeManually, cancelTrade,
  };
}
