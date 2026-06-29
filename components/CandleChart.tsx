'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  LineSeries,
  BaselineSeries,
  HistogramSeries,
  CrosshairMode,
  LineStyle,
} from 'lightweight-charts';
import type {
  IChartApi, ISeriesApi, CandlestickData, LineData, HistogramData,
  ISeriesMarkersPluginApi, IPriceLine, Time, SeriesMarker,
} from 'lightweight-charts';
import type { Candle } from '@/lib/binance-ws';
import type { Signal, ActiveSignal, SignalHistoryEntry } from '@/hooks/usePatternDetection';
import type { PatternResult } from '@/lib/pattern-engine';
import type { Trade } from '@/lib/trade-manager';
import {
  DrawingRegistry, isPlausible,
  drawSRZones, drawTrendlines, drawSignalLines, drawRiskRewardZone,
  drawSignalBox, drawPatternShape, drawActiveTrade,
  buildSwingMarkers, buildSignalMarkers, applyMarkers,
} from '@/lib/chart-drawings';

type TrendlinePoint = { time: number; value: number };
type TrendlineInfo = {
  supportTrendline: [TrendlinePoint, TrendlinePoint];
  resistanceTrendline: [TrendlinePoint, TrendlinePoint];
} | null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySeries = ISeriesApi<any>;

type Props = {
  candles: Candle[];
  supportLevels: number[];
  resistanceLevels: number[];
  trendlinePoints: TrendlineInfo;
  ema20: number[];
  ema50: number[];
  atr: number;
  signal: Signal;
  signalHistory?: SignalHistoryEntry[];
  patterns?: PatternResult[];
  activeTrade?: Trade | null;
  tradeHistory?: Trade[];
  currentPrice: number;
  symbol: string;
  interval: string;
};

export default function CandleChart({
  candles, supportLevels, resistanceLevels, trendlinePoints,
  ema20, ema50, atr, signal, signalHistory = [], patterns = [], activeTrade = null, tradeHistory = [],
  currentPrice, symbol, interval,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<AnySeries | null>(null);
  const ema20Ref = useRef<AnySeries | null>(null);
  const ema50Ref = useRef<AnySeries | null>(null);
  const volumeSeriesRef = useRef<AnySeries | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const registryRef = useRef(new DrawingRegistry());
  const potentialPatternRefs = useRef<AnySeries[]>([]);
  // Two independent marker sources (live signal/swing markers vs. closed-trade history markers)
  // both want to call setMarkers(); merge through one ref each + a shared rebuild so neither wipes
  // the other out.
  const liveMarkersRef = useRef<SeriesMarker<Time>[]>([]);
  const historyMarkersRef = useRef<SeriesMarker<Time>[]>([]);
  const rebuildMarkers = useCallback(() => {
    applyMarkers(markersRef.current, liveMarkersRef.current, historyMarkersRef.current);
  }, []);

  const entryLineRef = useRef<IPriceLine | null>(null);
  const stopLineRef = useRef<IPriceLine | null>(null);
  const targetLineRef = useRef<IPriceLine | null>(null);

  // Toggles
  const [showEMA, setShowEMA] = useState(true);
  const [showSR, setShowSR] = useState(true);
  const [showTrendlines, setShowTrendlines] = useState(true);
  const [showVolume, setShowVolume] = useState(true);

  const initializedRef = useRef(false);
  const [isChartReady, setIsChartReady] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const ema20Data = useMemo((): LineData[] => {
    if (!candles.length || !ema20.length) return [];
    const offset = candles.length - ema20.length;
    return ema20.map((v, i) => ({
      time: candles[offset + i]?.time as LineData['time'],
      value: v,
    })).filter(d => d.time !== undefined);
  }, [candles, ema20]);

  const ema50Data = useMemo((): LineData[] => {
    if (!candles.length || !ema50.length) return [];
    const offset = candles.length - ema50.length;
    return ema50.map((v, i) => ({
      time: candles[offset + i]?.time as LineData['time'],
      value: v,
    })).filter(d => d.time !== undefined);
  }, [candles, ema50]);

  const volumeData = useMemo((): HistogramData[] => {
    return candles.map(c => ({
      time: c.time as HistogramData['time'],
      value: c.volume,
      color: c.close >= c.open ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)',
    }));
  }, [candles]);

  const initChart = useCallback(() => {
    if (!containerRef.current || initializedRef.current) return;
    try {
      const el = containerRef.current;
      const w = el.clientWidth || el.offsetWidth || 900;
      const h = el.clientHeight || el.offsetHeight || 500;

      const chart = createChart(el, {
        width: w,
        height: h,
        layout: { background: { color: '#0a0a0a' }, textColor: '#555' },
        grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#1f1f1f' },
        timeScale: { borderColor: '#1f1f1f', timeVisible: true, secondsVisible: false },
      });
      chartRef.current = chart;

      const cs = chart.addSeries(CandlestickSeries, {
        upColor: '#22c55e', downColor: '#ef4444',
        borderUpColor: '#22c55e', borderDownColor: '#ef4444',
        wickUpColor: '#22c55e', wickDownColor: '#ef4444',
      });
      candleSeriesRef.current = cs;
      markersRef.current = createSeriesMarkers(cs, []);

      ema20Ref.current = chart.addSeries(LineSeries, {
        color: '#3b82f6', lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false,
      });
      ema50Ref.current = chart.addSeries(LineSeries, {
        color: '#f59e0b', lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false,
      });

      const vs = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
        lastValueVisible: false,
        priceLineVisible: false,
      }, 1);
      volumeSeriesRef.current = vs;
      const volPane = chart.panes()[1];
      if (volPane) volPane.setHeight(60);

      initializedRef.current = true;
      setIsChartReady(true);

      const obs = new ResizeObserver(() => {
        if (containerRef.current && chartRef.current) {
          const cw = containerRef.current.clientWidth;
          const ch = containerRef.current.clientHeight;
          if (cw > 0 && ch > 0) chartRef.current.resize(cw, ch);
        }
      });
      obs.observe(el);
      return () => obs.disconnect();
    } catch (e) {
      console.error('[CandleChart] init error', e);
      setHasError(true);
    }
  }, []);

  useEffect(() => {
    const cleanup = initChart();
    return () => {
      cleanup?.();
      if (chartRef.current) {
        markersRef.current?.detach();
        markersRef.current = null;
        chartRef.current.remove();
        chartRef.current = null;
        initializedRef.current = false;
        candleSeriesRef.current = null;
        ema20Ref.current = null;
        ema50Ref.current = null;
        volumeSeriesRef.current = null;
        potentialPatternRefs.current = [];
        setIsChartReady(false);
      }
    };
  }, [initChart]);

  // Full data load — runs on symbol/interval change and whenever candles array reference changes
  useEffect(() => {
    if (!isChartReady || !candleSeriesRef.current || !candles.length) return;

    if (chartRef.current) {
      registryRef.current.clearAll(chartRef.current, candleSeriesRef.current);
      for (const s of potentialPatternRefs.current) {
        try { chartRef.current.removeSeries(s); } catch { /* ignore */ }
      }
      potentialPatternRefs.current = [];
      markersRef.current?.setMarkers([]);
    }

    if (ema20Ref.current) ema20Ref.current.setData([]);
    if (ema50Ref.current) ema50Ref.current.setData([]);

    const data: CandlestickData[] = candles.map(c => ({
      time: c.time as CandlestickData['time'],
      open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    candleSeriesRef.current.setData(data);
    volumeSeriesRef.current?.setData(showVolume ? volumeData : []);
    chartRef.current?.timeScale().fitContent();
  }, [isChartReady, symbol, interval, candles, volumeData, showVolume]);

  // Live tick update
  useEffect(() => {
    if (!isChartReady || !candleSeriesRef.current || !candles.length) return;
    const last = candles[candles.length - 1];
    try {
      candleSeriesRef.current.update({
        time: last.time as CandlestickData['time'],
        open: last.open, high: last.high, low: last.low, close: last.close,
      });
      if (showVolume) {
        volumeSeriesRef.current?.update({
          time: last.time as HistogramData['time'],
          value: last.volume,
          color: last.close >= last.open ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)',
        });
      }
    } catch {
      // ignore update errors during symbol transitions
    }
  }, [isChartReady, currentPrice, candles, showVolume]);

  // EMA lines — filtered against the hook's brief cross-symbol staleness window
  useEffect(() => {
    if (!isChartReady || !ema20Ref.current || !ema50Ref.current) return;
    const ref = candles[candles.length - 1]?.close ?? 0;
    const e20 = showEMA && ema20Data.every(d => isPlausible(d.value, ref)) ? ema20Data : [];
    const e50 = showEMA && ema50Data.every(d => isPlausible(d.value, ref)) ? ema50Data : [];
    ema20Ref.current.setData(e20);
    ema50Ref.current.setData(e50);
  }, [isChartReady, ema20Data, ema50Data, candles, showEMA]);

  // Support / Resistance zones
  useEffect(() => {
    if (!isChartReady || !chartRef.current || !candleSeriesRef.current) return;
    if (!showSR) { registryRef.current.clear(chartRef.current, candleSeriesRef.current, 'srZones'); return; }
    drawSRZones(chartRef.current, candleSeriesRef.current, supportLevels, resistanceLevels, currentPrice, atr, candles, registryRef.current);
  }, [isChartReady, supportLevels, resistanceLevels, currentPrice, atr, candles, showSR]);

  // Trendlines
  useEffect(() => {
    if (!isChartReady || !chartRef.current || !candleSeriesRef.current) return;
    if (!showTrendlines) { registryRef.current.clear(chartRef.current, candleSeriesRef.current, 'trendlines'); return; }
    drawTrendlines(chartRef.current, candleSeriesRef.current, candles, currentPrice, trendlinePoints, interval, registryRef.current);
  }, [isChartReady, trendlinePoints, candles, currentPrice, interval, showTrendlines]);

  // Signal visuals — entry/stop/target lines, risk/reward zones, signal box, pattern shape, markers
  useEffect(() => {
    if (!isChartReady || !chartRef.current || !candleSeriesRef.current || !candles.length) return;
    const chart = chartRef.current;
    const cs = candleSeriesRef.current;

    const ref = candles[candles.length - 1].close;
    const raw = signal && signal.direction !== 'WAIT' ? (signal as ActiveSignal) : null;
    const s = raw && isPlausible(raw.entry, ref) && isPlausible(raw.stop, ref) && isPlausible(raw.target, ref) ? raw : null;

    drawSignalLines(cs, s, { entry: entryLineRef, stop: stopLineRef, target: targetLineRef });
    drawRiskRewardZone(chart, s, candles, registryRef.current, cs, ref);
    drawSignalBox(chart, s, interval, registryRef.current, cs);
    drawPatternShape(chart, cs, s, candles, registryRef.current);

    const lastTime = candles[candles.length - 1].time;
    const swingMarkers = buildSwingMarkers(candles);
    const signalMarkers = buildSignalMarkers(s, signalHistory, symbol, interval, ref, lastTime);
    liveMarkersRef.current = [...swingMarkers, ...signalMarkers];
    rebuildMarkers();
  }, [isChartReady, signal, signalHistory, candles, interval, symbol, rebuildMarkers]);

  // Trade history — markers + dotted TP1 lines for recently closed paper trades on this symbol
  useEffect(() => {
    if (!isChartReady || !chartRef.current || !candleSeriesRef.current) return;
    const chart = chartRef.current;
    const cs = candleSeriesRef.current;
    registryRef.current.clear(chart, cs, 'tradeHistory');

    const recentTrades = tradeHistory
      .filter(t => t.symbol === symbol && t.status === 'closed' && t.actualEntry && t.actualExit)
      .slice(-10);

    const markers: SeriesMarker<Time>[] = [];
    recentTrades.forEach((trade, idx) => {
      const isWin = trade.totalPnlPct > 0;
      const isLong = trade.direction === 'long';

      if (trade.entryTime) {
        markers.push({
          time: Math.floor(trade.entryTime / 1000) as Time,
          position: isLong ? 'belowBar' : 'aboveBar',
          color: isLong ? '#22c55e' : '#ef4444',
          shape: isLong ? 'arrowUp' : 'arrowDown',
          text: `${isLong ? 'L' : 'S'} ${trade.actualEntry!.toFixed(0)}`,
        });
      }

      const exitTime = trade.tp2HitTime ?? trade.stopHitTime;
      if (exitTime) {
        markers.push({
          time: Math.floor(exitTime / 1000) as Time,
          position: isLong ? 'aboveBar' : 'belowBar',
          color: isWin ? '#22c55e' : '#ef4444',
          shape: 'circle',
          text: isWin ? `✓ +${trade.totalPnlPct.toFixed(1)}%` : `✗ ${trade.totalPnlPct.toFixed(1)}%`,
        });
      }

      // Faint TP1 reference line for the last 3 trades only, to avoid cluttering the chart
      if (idx >= recentTrades.length - 3) {
        registryRef.current.registerPriceLine('tradeHistory', cs.createPriceLine({
          price: trade.tp1,
          color: trade.tp1Hit ? 'rgba(34,197,94,0.3)' : 'rgba(34,197,94,0.15)',
          lineWidth: 1, lineStyle: LineStyle.Dotted,
          axisLabelVisible: false, title: '',
        }));
      }
    });

    historyMarkersRef.current = markers;
    rebuildMarkers();
  }, [isChartReady, tradeHistory, symbol, rebuildMarkers]);

  // Active trade — entry/stop/TP1/TP2 lines for the live paper trade
  useEffect(() => {
    if (!isChartReady || !chartRef.current || !candleSeriesRef.current) return;
    const trade = activeTrade && activeTrade.symbol === symbol ? activeTrade : null;
    drawActiveTrade(chartRef.current, candleSeriesRef.current, trade, candles, registryRef.current);
  }, [isChartReady, activeTrade, symbol, candles]);

  // Potential pattern visualization (faint preview boxes for top candidate patterns)
  useEffect(() => {
    if (!isChartReady || !chartRef.current || !patterns.length || !candles.length) return;

    for (const s of potentialPatternRefs.current) {
      try { chartRef.current.removeSeries(s); } catch { /* ignore */ }
    }
    potentialPatternRefs.current = [];

    const INTERVAL_SECS: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
    const ivSec = INTERVAL_SECS[interval] ?? 300;
    const ref = candles[candles.length - 1].close;

    for (const p of patterns) {
      if (p.type === 'neutral' || !isPlausible(p.support, ref) || !isPlausible(p.resistance, ref)) continue;

      const isBullish = p.type === 'bullish';
      const t0 = candles[Math.max(0, candles.length - 20)].time;
      const t1 = candles[candles.length - 1].time + 3 * ivSec;

      const fill = chartRef.current.addSeries(BaselineSeries, {
        baseValue: { type: 'price', price: p.support },
        topFillColor1: isBullish ? 'rgba(34,197,94,0.03)' : 'rgba(239,68,68,0.03)',
        topFillColor2: isBullish ? 'rgba(34,197,94,0.03)' : 'rgba(239,68,68,0.03)',
        topLineColor: isBullish ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)',
        bottomFillColor1: 'rgba(0,0,0,0)', bottomFillColor2: 'rgba(0,0,0,0)',
        bottomLineColor: isBullish ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)',
        lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => null,
      });

      fill.setData([{ time: t0 as Time, value: p.resistance }, { time: t1 as Time, value: p.resistance }]);
      potentialPatternRefs.current.push(fill);
    }
  }, [isChartReady, patterns, candles, interval]);

  const handleExport = async () => {
    if (!containerRef.current || isExporting) return;
    setIsExporting(true);
    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(containerRef.current, { backgroundColor: '#0a0a0a' });
      const link = document.createElement('a');
      link.download = `${symbol}_${Date.now()}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch { /* ignore */ }
    setIsExporting(false);
  };

  const livePnl = useMemo(() => {
    if (!activeTrade || activeTrade.symbol !== symbol || !activeTrade.actualEntry) return null;
    if (activeTrade.status !== 'open' && activeTrade.status !== 'partial') return null;
    // Include any already-realized P&L from a TP1 partial close, scaled by what's still open —
    // otherwise this badge overstates exposure once half the position has already been banked.
    const unrealizedPct = ((currentPrice - activeTrade.actualEntry) / activeTrade.actualEntry) * 100
      * (activeTrade.direction === 'long' ? 1 : -1) * activeTrade.remainingSize;
    const pct = activeTrade.realizedPnlPct + unrealizedPct;
    const usdAmount = (pct / 100) * activeTrade.positionSizeUsd;
    const riskPct = Math.abs(activeTrade.actualEntry - activeTrade.stopLoss) / activeTrade.actualEntry * 100;
    const r = riskPct > 0 ? pct / riskPct : 0;
    return { pct, r, usdAmount };
  }, [activeTrade, symbol, currentPrice]);

  if (hasError) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#0a0a0a] text-[#ef4444] text-sm">
        Chart failed to initialize. Please refresh.
      </div>
    );
  }

  return (
    <div className="relative w-full h-full flex flex-col">
      {/* Toggles Toolbar */}
      <div className="absolute top-2 left-2 z-10 flex gap-1 bg-[#111111]/80 backdrop-blur-md p-1 rounded-lg border border-[#1f1f1f]">
        {[
          { label: 'EMA', state: showEMA, setter: setShowEMA },
          { label: 'S/R', state: showSR, setter: setShowSR },
          { label: 'Lines', state: showTrendlines, setter: setShowTrendlines },
          { label: 'Vol', state: showVolume, setter: setShowVolume },
        ].map(t => (
          <button
            key={t.label}
            onClick={() => t.setter(!t.state)}
            className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
              t.state
                ? 'bg-[#3b82f6]/20 text-[#3b82f6] border border-[#3b82f6]/30'
                : 'bg-transparent text-[#888888] border border-transparent hover:text-[#f5f5f5]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {livePnl && (
        <div
          className="absolute z-10 rounded-md font-mono text-[13px] font-bold backdrop-blur-sm"
          style={{
            top: 12, left: 12, padding: '4px 10px',
            background: 'rgba(0,0,0,0.75)',
            border: `1px solid ${livePnl.pct >= 0 ? '#22c55e33' : '#ef444433'}`,
            color: livePnl.pct >= 0 ? '#22c55e' : '#ef4444',
          }}
        >
          {livePnl.usdAmount >= 0 ? '+' : ''}${Math.abs(livePnl.usdAmount).toFixed(0)}
          &nbsp;({livePnl.pct >= 0 ? '+' : ''}{livePnl.pct.toFixed(2)}%, {livePnl.r >= 0 ? '+' : ''}{livePnl.r.toFixed(1)}R)
        </div>
      )}

      <div ref={containerRef} className="w-full flex-1" />
      <button
        onClick={handleExport}
        disabled={isExporting}
        className="absolute top-2 right-2 z-10 px-2.5 py-1 text-[10px] bg-[#111111] border border-[#1f1f1f] text-[#888888] rounded hover:text-[#f5f5f5] hover:border-[#333] disabled:opacity-30 transition-colors"
      >
        {isExporting ? '...' : 'PNG'}
      </button>
      {!candles.length && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-7 h-7 border-2 border-[#1f1f1f] border-t-[#888888] rounded-full animate-spin" />
            <span className="text-[11px] text-[#888888]">Loading chart data...</span>
          </div>
        </div>
      )}
    </div>
  );
}
