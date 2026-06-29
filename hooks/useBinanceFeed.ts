'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { BinanceWebSocket, type Candle } from '@/lib/binance-ws';

type FeedState = {
  candles: Candle[];
  currentPrice: number;
  currentCandle: Candle | null;
  isConnected: boolean;
  volume24h: number;
  priceChange24h: number;
};

export function useBinanceFeed(symbol: string, interval: string): FeedState {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [currentCandle, setCurrentCandle] = useState<Candle | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [volume24h, setVolume24h] = useState<number>(0);
  const [priceChange24h, setPriceChange24h] = useState<number>(0);
  const wsRef = useRef<BinanceWebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);

  const fetchHistoricalCandles = useCallback(async (sym: string, intv: string) => {
    try {
      const res = await fetch(
        `https://api.binance.com/api/v3/klines?symbol=${sym.toUpperCase()}&interval=${intv}&limit=100`
      );
      const data = (await res.json()) as [
        number, string, string, string, string, string, number, string, number, string, string, string
      ][];
      const parsed: Candle[] = data.map((item) => ({
        time: Math.floor(item[0] / 1000),
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4]),
        volume: parseFloat(item[5]),
      }));
      setCandles(parsed);
      if (parsed.length > 0) {
        setCurrentPrice(parsed[parsed.length - 1].close);
        setCurrentCandle(parsed[parsed.length - 1]);
      }
    } catch {
      // keep existing candles on network error
    }
  }, []);

  const fetch24hTicker = useCallback(async (sym: string) => {
    try {
      const res = await fetch(
        `https://api.binance.com/api/v3/ticker/24hr?symbol=${sym.toUpperCase()}`
      );
      const data = (await res.json()) as {
        priceChangePercent: string;
        quoteVolume: string;
      };
      setPriceChange24h(parseFloat(data.priceChangePercent));
      setVolume24h(parseFloat(data.quoteVolume));
    } catch {
      // keep existing values
    }
  }, []);

  useEffect(() => {
    setCandles([]);
    setCurrentPrice(0);
    setCurrentCandle(null);
    setIsConnected(false);
    reconnectAttemptsRef.current = 0;

    fetchHistoricalCandles(symbol, interval);
    fetch24hTicker(symbol);

    if (!wsRef.current) {
      wsRef.current = new BinanceWebSocket();
    }

    wsRef.current.connect(symbol, interval, (candle: Candle, isClosed: boolean) => {
      setIsConnected(true);
      setCurrentPrice(candle.close);
      setCurrentCandle(candle);

      if (isClosed) {
        setCandles((prev) => {
          const next = [...prev.filter((c) => c.time !== candle.time), candle];
          return next.slice(-200);
        });
      } else {
        setCandles((prev) => {
          if (!prev.length) return prev;
          const copy = [...prev];
          if (copy[copy.length - 1].time === candle.time) {
            copy[copy.length - 1] = candle;
          } else {
            copy.push(candle);
          }
          return copy.slice(-200);
        });
      }
    });

    return () => {
      if (wsRef.current) {
        wsRef.current.disconnect();
        wsRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [symbol, interval, fetchHistoricalCandles, fetch24hTicker]);

  return { candles, currentPrice, currentCandle, isConnected, volume24h, priceChange24h };
}
