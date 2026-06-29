import { LineSeries, BaselineSeries, LineStyle } from 'lightweight-charts';
import type {
  IChartApi, ISeriesApi, IPriceLine, Time, SeriesMarker, ISeriesMarkersPluginApi,
} from 'lightweight-charts';
import type { Candle } from './binance-ws';
import type { ActiveSignal, SignalHistoryEntry } from '@/hooks/usePatternDetection';
import type { Trade } from './trade-manager';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySeries = ISeriesApi<any>;
type TrendlinePoint = { time: number; value: number };
type TrendlineInfo = { supportTrendline: [TrendlinePoint, TrendlinePoint]; resistanceTrendline: [TrendlinePoint, TrendlinePoint] } | null;

const INTERVAL_SECS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400,
};

/** A value is "plausible" if it's within half-to-double the reference price — guards against
 *  drawing stale cross-symbol levels during the brief window after a symbol switch. */
export function isPlausible(price: number, refPrice: number): boolean {
  return refPrice > 0 && price / refPrice > 0.5 && price / refPrice < 2;
}

// ─── Drawing Registry ───────────────────────────────────────────────────────

export class DrawingRegistry {
  private series = new Map<string, AnySeries[]>();
  private priceLines = new Map<string, IPriceLine[]>();

  register(group: string, series: AnySeries) {
    if (!this.series.has(group)) this.series.set(group, []);
    this.series.get(group)!.push(series);
  }

  registerPriceLine(group: string, line: IPriceLine) {
    if (!this.priceLines.has(group)) this.priceLines.set(group, []);
    this.priceLines.get(group)!.push(line);
  }

  clear(chart: IChartApi, candleSeries: AnySeries, group: string) {
    this.series.get(group)?.forEach(s => { try { chart.removeSeries(s); } catch { /* ignore */ } });
    this.series.set(group, []);
    this.priceLines.get(group)?.forEach(l => { try { candleSeries.removePriceLine(l); } catch { /* ignore */ } });
    this.priceLines.set(group, []);
  }

  clearAll(chart: IChartApi, candleSeries: AnySeries) {
    const groups = new Set([...Array.from(this.series.keys()), ...Array.from(this.priceLines.keys())]);
    groups.forEach(g => this.clear(chart, candleSeries, g));
  }
}

// ─── Support / Resistance Zones ─────────────────────────────────────────────

export function drawSRZones(
  chart: IChartApi, candleSeries: AnySeries,
  support: number[], resistance: number[],
  currentPrice: number, atr: number, candles: Candle[],
  registry: DrawingRegistry,
) {
  registry.clear(chart, candleSeries, 'srZones');
  if (candles.length < 2) return;

  const ft = candles[0].time as Time;
  const lt = candles[candles.length - 1].time as Time;
  const zoneWidth = Math.max(atr * 0.2, currentPrice * 0.001);

  const addZone = (level: number, isSupport: boolean, index: number) => {
    const half = zoneWidth / 2;
    let zoneTop = level + half;
    let zoneBottom = level - half;
    if (isSupport) zoneTop = Math.min(zoneTop, currentPrice * 0.999);
    else zoneBottom = Math.max(zoneBottom, currentPrice * 1.001);
    if (zoneTop <= zoneBottom) return;

    const color = isSupport ? '59,130,246' : '239,68,68';
    const upperBorder = chart.addSeries(LineSeries, {
      color: `rgba(${color},0.5)`, lineWidth: 1, lineStyle: LineStyle.Dashed,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null,
    });
    upperBorder.setData([{ time: ft, value: zoneTop }, { time: lt, value: zoneTop }]);

    const lowerBorder = chart.addSeries(LineSeries, {
      color: `rgba(${color},0.2)`, lineWidth: 1, lineStyle: LineStyle.Dotted,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null,
    });
    lowerBorder.setData([{ time: ft, value: zoneBottom }, { time: lt, value: zoneBottom }]);

    const fill = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: zoneTop },
      topLineColor: 'rgba(0,0,0,0)', topFillColor1: 'rgba(0,0,0,0)', topFillColor2: 'rgba(0,0,0,0)',
      bottomLineColor: 'rgba(0,0,0,0)',
      bottomFillColor1: `rgba(${color},0.08)`, bottomFillColor2: `rgba(${color},0.02)`,
      lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null,
    } as Parameters<typeof chart.addSeries>[1]);
    fill.setData([{ time: ft, value: zoneBottom }, { time: lt, value: zoneBottom }]);

    const label = candleSeries.createPriceLine({
      price: level, color: isSupport ? '#3b82f6' : '#ef4444',
      lineVisible: false, axisLabelVisible: true,
      title: `${isSupport ? 'S' : 'R'}${index + 1} $${level.toFixed(0)}`,
    });

    registry.register('srZones', upperBorder);
    registry.register('srZones', lowerBorder);
    registry.register('srZones', fill);
    registry.registerPriceLine('srZones', label);
  };

  support.filter(s => isPlausible(s, currentPrice)).slice(0, 2).forEach((lvl, i) => addZone(lvl, true, i));
  resistance.filter(r => isPlausible(r, currentPrice)).slice(0, 2).forEach((lvl, i) => addZone(lvl, false, i));
}

// ─── Trendlines ──────────────────────────────────────────────────────────────

export function drawTrendlines(
  chart: IChartApi, candleSeries: AnySeries, candles: Candle[],
  currentPrice: number, trendlinePoints: TrendlineInfo, interval: string,
  registry: DrawingRegistry,
) {
  registry.clear(chart, candleSeries, 'trendlines');
  if (!trendlinePoints || !candles.length) return;

  const ivSec = INTERVAL_SECS[interval] ?? 300;
  const futureTime = (candles[candles.length - 1].time + 40 * ivSec) as Time;

  const drawLine = ([p1, p2]: [TrendlinePoint, TrendlinePoint], color: string) => {
    if (!isPlausible(p1.value, currentPrice) || !isPlausible(p2.value, currentPrice)) return;
    const slope = (p2.value - p1.value) / (p2.time - p1.time);
    const extValue = p2.value + slope * ((futureTime as number) - p2.time);
    const clamped = Math.max(currentPrice * 0.5, Math.min(currentPrice * 1.5, extValue));
    const series = chart.addSeries(LineSeries, {
      color, lineWidth: 1, lineStyle: LineStyle.Dashed,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null,
    });
    series.setData([
      { time: p1.time as Time, value: p1.value },
      { time: futureTime, value: clamped },
    ]);
    registry.register('trendlines', series);
  };

  drawLine(trendlinePoints.supportTrendline, 'rgba(245,158,11,0.7)');
  drawLine(trendlinePoints.resistanceTrendline, 'rgba(239,68,68,0.6)');
}

// ─── Signal Lines (Entry / Stop / Target) ───────────────────────────────────

export type SignalLineRefs = {
  entry: { current: IPriceLine | null };
  stop: { current: IPriceLine | null };
  target: { current: IPriceLine | null };
};

export function drawSignalLines(candleSeries: AnySeries, signal: ActiveSignal | null, refs: SignalLineRefs) {
  for (const ref of [refs.entry, refs.stop, refs.target]) {
    if (ref.current) {
      try { candleSeries.removePriceLine(ref.current); } catch { /* ignore */ }
      ref.current = null;
    }
  }
  if (!signal) return;

  refs.entry.current = candleSeries.createPriceLine({
    price: signal.entry, color: '#ffffff', lineWidth: 1, lineStyle: LineStyle.Solid,
    axisLabelVisible: true, title: '⚡ Entry',
  });

  const stopPct = (Math.abs(signal.stop - signal.entry) / signal.entry * 100).toFixed(1);
  refs.stop.current = candleSeries.createPriceLine({
    price: signal.stop, color: '#ef4444', lineWidth: 2, lineStyle: LineStyle.Dashed,
    axisLabelVisible: true, title: `🛑 Stop ${stopPct}%`,
  });

  const tpPct = (Math.abs(signal.target - signal.entry) / signal.entry * 100).toFixed(1);
  refs.target.current = candleSeries.createPriceLine({
    price: signal.target, color: '#22c55e', lineWidth: 2, lineStyle: LineStyle.Dashed,
    axisLabelVisible: true, title: `🎯 Target +${tpPct}%`,
  });
}

// ─── Risk/Reward Visualization (stop & target shading + risk/reward bands) ─

export function drawRiskRewardZone(
  chart: IChartApi, signal: ActiveSignal | null, candles: Candle[],
  registry: DrawingRegistry, candleSeries: AnySeries, currentPrice: number,
) {
  registry.clear(chart, candleSeries, 'riskReward');
  if (!signal || candles.length < 2) return;

  const isLong = signal.direction === 'LONG';
  const ft = candles[0].time as Time;
  const lt = candles[candles.length - 1].time as Time;

  // Cap the reward zone's far edge at 5% from current price — a real target much further out
  // shouldn't stretch the green fill across most of the chart and bury the candles.
  const cappedExtreme = isLong
    ? Math.min(signal.target, currentPrice * 1.05)
    : Math.max(signal.target, currentPrice * 0.95);

  const addBand = (lower: number, upper: number, topFill: string) => {
    if (!(upper > lower)) return;
    const band = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: lower },
      topFillColor1: topFill, topFillColor2: topFill, topLineColor: 'rgba(0,0,0,0)',
      bottomFillColor1: 'rgba(0,0,0,0)', bottomFillColor2: 'rgba(0,0,0,0)', bottomLineColor: 'rgba(0,0,0,0)',
      lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null,
    } as Parameters<typeof chart.addSeries>[1]);
    band.setData([{ time: ft, value: upper }, { time: lt, value: upper }]);
    registry.register('riskReward', band);
  };

  if (isLong) {
    addBand(signal.stop * 0.98, signal.stop, 'rgba(239,68,68,0.06)');
    addBand(cappedExtreme, cappedExtreme * 1.02, 'rgba(34,197,94,0.06)');
  } else {
    addBand(signal.stop, signal.stop * 1.02, 'rgba(239,68,68,0.06)');
    addBand(cappedExtreme * 0.98, cappedExtreme, 'rgba(34,197,94,0.06)');
  }
  addBand(Math.min(signal.entry, signal.stop), Math.max(signal.entry, signal.stop), 'rgba(239,68,68,0.04)');
  addBand(Math.min(signal.entry, cappedExtreme), Math.max(signal.entry, cappedExtreme), 'rgba(34,197,94,0.04)');
}

// ─── Signal Box (entry candle bounding box) ─────────────────────────────────

export function drawSignalBox(chart: IChartApi, signal: ActiveSignal | null, interval: string, registry: DrawingRegistry, candleSeries: AnySeries) {
  registry.clear(chart, candleSeries, 'signalBox');
  if (!signal) return;

  const support = signal.pattern.support;
  const resistance = signal.pattern.resistance;
  if (!(resistance > support)) return;

  const isLong = signal.direction === 'LONG';
  const color = isLong ? '#22c55e' : '#ef4444';
  const ivSec = INTERVAL_SECS[interval] ?? 300;
  const t0 = signal.candleTime;
  const t1 = t0 + 3 * ivSec;

  const addEdge = (p1: [number, number], p2: [number, number]) => {
    const line = chart.addSeries(LineSeries, {
      color, lineWidth: 2, lineStyle: LineStyle.Solid,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null,
    });
    line.setData([{ time: p1[0] as Time, value: p1[1] }, { time: p2[0] as Time, value: p2[1] }]);
    registry.register('signalBox', line);
  };

  addEdge([t0, support], [t1, support]);
  addEdge([t0, resistance], [t1, resistance]);
  // Vertical edges: lightweight-charts requires strictly increasing time per series, so a true
  // vertical line isn't directly expressible — offset by 1s (negligible vs. candle width) instead.
  addEdge([t0, support], [t0 + 1, resistance]);
  addEdge([t1 - 1, support], [t1, resistance]);

  const fill = chart.addSeries(BaselineSeries, {
    baseValue: { type: 'price', price: support },
    topFillColor1: isLong ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
    topFillColor2: isLong ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
    topLineColor: 'rgba(0,0,0,0)',
    bottomFillColor1: 'rgba(0,0,0,0)', bottomFillColor2: 'rgba(0,0,0,0)', bottomLineColor: 'rgba(0,0,0,0)',
    lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    autoscaleInfoProvider: () => null,
  } as Parameters<typeof chart.addSeries>[1]);
  fill.setData([{ time: t0 as Time, value: resistance }, { time: t1 as Time, value: resistance }]);
  registry.register('signalBox', fill);
}

// ─── Pattern Shape (neckline / peaks / triangle-flag boundary for the active signal) ─

export function drawPatternShape(
  chart: IChartApi, candleSeries: AnySeries, signal: ActiveSignal | null,
  candles: Candle[], registry: DrawingRegistry,
) {
  registry.clear(chart, candleSeries, 'patternShape');
  if (!signal || candles.length < 30) return;

  const name = signal.pattern.name;
  const isLong = signal.direction === 'LONG';
  const ft = candles[Math.max(0, candles.length - 30)].time as Time;
  const lt = candles[candles.length - 1].time as Time;

  if (name.includes('Double') || name.includes('Head')) {
    registry.registerPriceLine('patternShape', candleSeries.createPriceLine({
      price: signal.pattern.support, color: '#f59e0b', lineWidth: 1, lineStyle: LineStyle.Dashed,
      axisLabelVisible: true, title: '— Neckline',
    }));
    registry.registerPriceLine('patternShape', candleSeries.createPriceLine({
      price: signal.target, color: '#8b5cf6', lineWidth: 1, lineStyle: LineStyle.Dotted,
      axisLabelVisible: true, title: '🎯 Pattern Target',
    }));
  }

  if (name.includes('Triangle') || name.includes('Flag')) {
    const top = chart.addSeries(LineSeries, {
      color: 'rgba(239,68,68,0.7)', lineWidth: 1, lineStyle: LineStyle.Dashed,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null,
    });
    top.setData([{ time: ft, value: signal.pattern.resistance }, { time: lt, value: signal.pattern.resistance }]);
    registry.register('patternShape', top);

    const bottom = chart.addSeries(LineSeries, {
      color: 'rgba(59,130,246,0.7)', lineWidth: 1, lineStyle: LineStyle.Dashed,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null,
    });
    bottom.setData([{ time: ft, value: signal.pattern.support }, { time: lt, value: signal.pattern.support }]);
    registry.register('patternShape', bottom);

    const fill = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: signal.pattern.resistance },
      topLineColor: 'rgba(0,0,0,0)', topFillColor1: 'rgba(0,0,0,0)', topFillColor2: 'rgba(0,0,0,0)',
      bottomLineColor: 'rgba(0,0,0,0)',
      bottomFillColor1: 'rgba(245,158,11,0.04)', bottomFillColor2: 'rgba(245,158,11,0.01)',
      lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null,
    } as Parameters<typeof chart.addSeries>[1]);
    fill.setData([{ time: ft, value: signal.pattern.support }, { time: lt, value: signal.pattern.support }]);
    registry.register('patternShape', fill);

    if (name.includes('Flag')) {
      const pole = chart.addSeries(LineSeries, {
        color: isLong ? 'rgba(34,197,94,0.6)' : 'rgba(239,68,68,0.6)', lineWidth: 3,
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => null,
      });
      const poleStart = candles[Math.max(0, candles.length - 15)].time as Time;
      pole.setData([
        { time: poleStart, value: isLong ? signal.pattern.support : signal.pattern.resistance },
        { time: ft, value: isLong ? signal.pattern.resistance : signal.pattern.support },
      ]);
      registry.register('patternShape', pole);
    }
  }
}

// ─── Markers (swing dots + signal history + active signal arrow) ───────────

export function buildSwingMarkers(candles: Candle[]): SeriesMarker<Time>[] {
  const markers: SeriesMarker<Time>[] = [];
  const recent = candles.slice(-10);
  const offset = candles.length - recent.length;
  for (let i = 2; i < recent.length - 2; i++) {
    const c = recent[i];
    const idx = offset + i;
    const isHigh = c.high > recent[i - 1].high && c.high > recent[i - 2].high &&
      c.high > recent[i + 1].high && c.high > recent[i + 2].high;
    const isLow = c.low < recent[i - 1].low && c.low < recent[i - 2].low &&
      c.low < recent[i + 1].low && c.low < recent[i + 2].low;
    if (isHigh) {
      markers.push({ time: c.time as Time, position: 'aboveBar', shape: 'circle', color: 'rgba(239,68,68,0.5)', size: 0, text: '' });
    }
    if (isLow) {
      markers.push({ time: c.time as Time, position: 'belowBar', shape: 'circle', color: 'rgba(59,130,246,0.5)', size: 0, text: '' });
    }
    void idx;
  }
  return markers;
}

export function buildSignalMarkers(
  signal: ActiveSignal | null, signalHistory: SignalHistoryEntry[],
  symbol: string, interval: string, currentPrice: number, lastTime: number,
): SeriesMarker<Time>[] {
  const markers: SeriesMarker<Time>[] = [];

  for (const h of signalHistory) {
    if (h.symbol !== symbol || h.interval !== interval) continue;
    if (!isPlausible(h.entry, currentPrice)) continue;
    markers.push({
      time: h.candleTime as Time,
      position: h.direction === 'LONG' ? 'belowBar' : 'aboveBar',
      color: h.direction === 'LONG' ? '#22c55e' : '#ef4444',
      shape: h.direction === 'LONG' ? 'arrowUp' : 'arrowDown',
      text: h.outcome === 'target_hit' ? '✅ Win' : h.outcome === 'stop_hit' ? '❌ Loss' : '⏳ Pending',
    });
  }

  if (signal) {
    const isLong = signal.direction === 'LONG';
    markers.push({
      time: lastTime as Time,
      position: isLong ? 'belowBar' : 'aboveBar',
      color: isLong ? '#22c55e' : '#ef4444',
      shape: isLong ? 'arrowUp' : 'arrowDown',
      text: `${signal.pattern.name} ${isLong ? 'LONG' : 'SHORT'} ${signal.confidence}%`,
    });
  }

  return markers;
}

export function applyMarkers(markersPlugin: ISeriesMarkersPluginApi<Time> | null, ...arrays: SeriesMarker<Time>[][]) {
  if (!markersPlugin) return;
  const all = arrays.flat().sort((a, b) => (a.time as number) - (b.time as number));
  markersPlugin.setMarkers(all);
}

// ─── Active Trade Visualization ─────────────────────────────────────────────

export function drawActiveTrade(chart: IChartApi, candleSeries: AnySeries, trade: Trade | null, candles: Candle[], registry: DrawingRegistry) {
  registry.clear(chart, candleSeries, 'activeTrade');
  if (!trade || trade.status === 'expired' || trade.status === 'cancelled' || trade.status === 'closed') return;

  const entryPrice = trade.actualEntry ?? trade.entryPrice;

  registry.registerPriceLine('activeTrade', candleSeries.createPriceLine({
    price: entryPrice, color: '#ffffff', lineWidth: 2, lineStyle: LineStyle.Solid,
    axisLabelVisible: true, title: trade.status === 'pending' ? '📍 Planned Entry' : '📍 Entry',
  }));

  // Translucent band over the recent candles makes the entry level pop visually, beyond
  // what a 1-2px price line alone can do. 4 is the max lineWidth lightweight-charts allows.
  if (candles.length >= 2) {
    const span = candles.slice(-20);
    const highlight = chart.addSeries(LineSeries, {
      color: 'rgba(255,255,255,0.4)', lineWidth: 4,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null,
    });
    highlight.setData([
      { time: span[0].time as Time, value: entryPrice },
      { time: span[span.length - 1].time as Time, value: entryPrice },
    ]);
    registry.register('activeTrade', highlight);
  }

  const stopColor = trade.tp1Hit ? '#888888' : '#ef4444';
  const stopTitle = trade.tp1Hit
    ? `⚡ Breakeven $${trade.currentStop.toFixed(0)}`
    : `🛑 Stop $${trade.currentStop.toFixed(0)}`;
  registry.registerPriceLine('activeTrade', candleSeries.createPriceLine({
    price: trade.currentStop, color: stopColor, lineWidth: 2, lineStyle: LineStyle.Dashed,
    axisLabelVisible: true, title: stopTitle,
  }));

  // Once breakeven, give the stop the same translucent band treatment as entry so it's
  // obvious at a glance the trade is now risk-free.
  if (trade.tp1Hit && candles.length >= 2) {
    const span = candles.slice(-20);
    const beHighlight = chart.addSeries(LineSeries, {
      color: 'rgba(136,136,136,0.4)', lineWidth: 4,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null,
    });
    beHighlight.setData([
      { time: span[0].time as Time, value: trade.currentStop },
      { time: span[span.length - 1].time as Time, value: trade.currentStop },
    ]);
    registry.register('activeTrade', beHighlight);
  }

  registry.registerPriceLine('activeTrade', candleSeries.createPriceLine({
    price: trade.tp1, lineWidth: 2, color: trade.tp1Hit ? 'rgba(34,197,94,0.6)' : '#22c55e',
    lineStyle: trade.tp1Hit ? LineStyle.Solid : LineStyle.Dashed, axisLabelVisible: true,
    title: trade.tp1Hit ? `✅ TP1 Hit $${trade.tp1.toFixed(0)}` : `🎯 TP1 (1:1) $${trade.tp1.toFixed(0)}`,
  }));

  registry.registerPriceLine('activeTrade', candleSeries.createPriceLine({
    price: trade.tp2, color: '#22c55e', lineWidth: 2, lineStyle: LineStyle.Dashed,
    axisLabelVisible: true, title: `🎯 TP2 (1:2) $${trade.tp2.toFixed(0)}`,
  }));
}


import { getDB, type DrawingMemoryRecord } from './db';

export async function savePersistentDrawing(record: Omit<DrawingMemoryRecord, 'id' | 'createdAt'>) {
  const db = getDB();
  await db.drawingMemory.add({ ...record, createdAt: Date.now() });
}

export async function loadActiveDrawings(symbol: string, timeframe: string) {
  const db = getDB();
  return await db.drawingMemory.where('[symbol+timeframe]').equals([symbol, timeframe]).filter(d => d.status === 'active').toArray();
}

export async function updateDrawingStatus(drawingId: string, status: DrawingMemoryRecord['status']) {
  const db = getDB();
  const records = await db.drawingMemory.where('drawingId').equals(drawingId).toArray();
  if (records.length) {
    await db.drawingMemory.update(records[0].id!, { status });
  }
}

