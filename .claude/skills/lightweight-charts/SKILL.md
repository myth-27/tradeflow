---
name: lightweight-charts
description: Lightweight Charts (TradingView open-source) API expert — chart initialization, series management (candlestick, volume, EMA, Bollinger), price lines, ref-based cleanup patterns, and common rendering/memory-leak gotchas. Load this skill whenever working with lightweight-charts, CandleChart.tsx, chart drawing, price lines, or series management.
---

## Role

You are a Lightweight Charts (TradingView open-source) expert. You know every API quirk, memory leak pattern, and rendering gotcha. You write chart code that persists correctly, cleans up perfectly, and never causes stale series errors.

---

## Chain: Chart Initialization

### Step 1 — Create Chart
```
TOOL: initChart(containerRef, options)
ALWAYS inside useEffect with containerRef.current check:

  const chart = createChart(containerRef.current, {
    width: containerRef.current.clientWidth,
    height: containerHeight,
    layout: {
      background: { type: ColorType.Solid, color: '#0a0a0a' },
      textColor: '#888888',
    },
    grid: {
      vertLines: { color: '#1a1a1a' },
      horzLines: { color: '#1a1a1a' },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: '#333333', labelBackgroundColor: '#222222' },
      horzLine: { color: '#333333', labelBackgroundColor: '#222222' },
    },
    rightPriceScale: {
      borderColor: '#1f1f1f',
      textColor: '#888888',
    },
    timeScale: {
      borderColor: '#1f1f1f',
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 12,
    },
    handleScroll: true,
    handleScale: true,
  })
  chartRef.current = chart

CLEANUP (always in useEffect return):
  return () => {
    chart.remove()
    chartRef.current = null
  }
```

### Step 2 — Responsive Resize
```
TOOL: setupResizeObserver(containerRef, chart)
  const observer = new ResizeObserver(entries => {
    const { width } = entries[0].contentRect
    chart.applyOptions({ width })
  })
  observer.observe(containerRef.current)

CLEANUP:
  observer.disconnect()
```

---

## Chain: Series Management

### Candlestick Series
```
TOOL: createCandleSeries(chart)
  const series = chart.addCandlestickSeries({
    upColor: '#22c55e',
    downColor: '#ef4444',
    borderUpColor: '#22c55e',
    borderDownColor: '#ef4444',
    wickUpColor: '#22c55e',
    wickDownColor: '#ef4444',
  })
  candleSeriesRef.current = series

INITIAL LOAD:
  series.setData(candles.map(c => ({
    time: c.time as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  })))
  chart.timeScale().scrollToRealTime()

LIVE TICK UPDATE (DO NOT use setData for ticks):
  series.update({
    time: currentCandle.time as UTCTimestamp,
    open: currentCandle.open,
    high: currentCandle.high,
    low: currentCandle.low,
    close: currentCandle.close,
  })

RULE: setData() only on symbol/interval change
RULE: update() on every tick for the forming candle
RULE: On new closed candle: setData() with full array OR update() with closed candle
```

### Volume Series (Separate Pane)
```
TOOL: createVolumeSeries(chart)
  const volumeSeries = chart.addHistogramSeries({
    color: '#22c55e',
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
  })
  chart.priceScale('volume').applyOptions({
    scaleMargins: { top: 0.8, bottom: 0 },
  })

  volumeSeries.setData(candles.map(c => ({
    time: c.time as UTCTimestamp,
    value: c.volume,
    color: c.close >= c.open ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)',
  })))
```

### EMA Lines
```
TOOL: createEMALines(chart, ema20Data, ema50Data)
  const ema20 = chart.addLineSeries({
    color: '#3b82f6',
    lineWidth: 1,
    lastValueVisible: true,
    title: 'EMA20',
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  })
  ema20.setData(ema20Data)

  const ema50 = chart.addLineSeries({
    color: '#f59e0b',
    lineWidth: 1,
    lastValueVisible: true,
    title: 'EMA50',
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  })
  ema50.setData(ema50Data)

  ema20Ref.current = ema20
  ema50Ref.current = ema50
```

### Bollinger Bands
```
TOOL: createBollingerBands(chart, bbData)
  [upper, middle, lower].forEach((data, idx) => {
    const series = chart.addLineSeries({
      color: 'rgba(139,92,246,0.4)',
      lineWidth: 1,
      lineStyle: idx === 1 ? LineStyle.Dashed : LineStyle.Solid,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    })
    series.setData(data)
    bbSeriesRef.current.push(series)
  })
```

---

## Chain: Price Lines (S/R, Entry, Stop, Target)

### Support & Resistance Price Lines
```
TOOL: drawSRPriceLines(candleSeries, support[], resistance[], currentPrice)

CRITICAL PRE-CHECK:
  support = support.filter(s => s < currentPrice)      // MUST be below
  resistance = resistance.filter(r => r > currentPrice) // MUST be above

REMOVE OLD LINES FIRST:
  srPriceLinesRef.current.forEach(line => {
    try { candleSeries.removePriceLine(line) } catch(e) {}
  })
  srPriceLinesRef.current = []

DRAW SUPPORT:
  support.slice(0,2).forEach((level, i) => {
    const line = candleSeries.createPriceLine({
      price: level,
      color: '#3b82f6',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `S${i+1} $${level.toFixed(0)}`,
    })
    srPriceLinesRef.current.push(line)
  })

DRAW RESISTANCE:
  resistance.slice(0,2).forEach((level, i) => {
    const line = candleSeries.createPriceLine({
      price: level,
      color: '#ef4444',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `R${i+1} $${level.toFixed(0)}`,
    })
    srPriceLinesRef.current.push(line)
  })
```

### Signal Lines (Entry / Stop / Target)
```
TOOL: drawSignalLines(candleSeries, signal)

REMOVE OLD SIGNAL LINES:
  [entryLineRef, stopLineRef, targetLineRef].forEach(ref => {
    if (ref.current) {
      try { candleSeries.removePriceLine(ref.current) } catch(e) {}
      ref.current = null
    }
  })

IF signal exists AND signal.type !== 'wait':

  entryLineRef.current = candleSeries.createPriceLine({
    price: signal.entry,
    color: '#ffffff',
    lineWidth: 1,
    lineStyle: LineStyle.Solid,
    axisLabelVisible: true,
    title: '⚡ Entry',
  })

  stopLineRef.current = candleSeries.createPriceLine({
    price: signal.stopLoss,
    color: '#ef4444',
    lineWidth: 2,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: `🛑 Stop  ${((Math.abs(signal.stopLoss - signal.entry) / signal.entry) * 100).toFixed(1)}%`,
  })

  targetLineRef.current = candleSeries.createPriceLine({
    price: signal.target,
    color: '#22c55e',
    lineWidth: 2,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: `🎯 Target +${((Math.abs(signal.target - signal.entry) / signal.entry) * 100).toFixed(1)}%`,
  })
```

### Baseline Zone (Risk/Reward Visualization)
```
TOOL: drawRiskRewardZone(chart, signal, candles)

REMOVE OLD:
  if (baselineRef.current) {
    try { chart.removeSeries(baselineRef.current) } catch(e) {}
    baselineRef.current = null
  }

IF signal AND signal.type !== 'wait':
  const baseline = chart.addBaselineSeries({
    baseValue: { type: 'price', price: signal.entry },
    topLineColor: 'rgba(34,197,94,0.0)',
    topFillColor1: 'rgba(34,197,94,0.18)',
    topFillColor2: 'rgba(34,197,94,0.04)',
    bottomLineColor: 'rgba(239,68,68,0.0)',
    bottomFillColor1: 'rgba(239,68,68,0.04)',
    bottomFillColor2: 'rgba(239,68,68,0.18)',
    lineWidth: 0,
    crosshairMarkerVisible: false,
    lastValueVisible: false,
    priceLineVisible: false,
  })

  // Value is the FAR extreme (target for long, stop for short)
  const extremeValue = signal.type === 'bullish' ? signal.target : signal.stopLoss
  baseline.setData(candles.map(c => ({
    time: c.time as UTCTimestamp,
    value: extremeValue,
  })))
  baselineRef.current = baseline

NOTE: BaselineSeries fills:
  green above entry (reward zone)
  red below entry (risk zone)
  automatically based on baseValue
```

---

## Chain: Trendlines

### Drawing Extending Trendlines
```
TOOL: drawTrendlines(chart, trendlinePoints, candles)

REMOVE OLD:
  trendlineSeriesRef.current.forEach(s => {
    try { chart.removeSeries(s) } catch(e) {}
  })
  trendlineSeriesRef.current = []

FOR EACH trendline in [support, resistance]:
  const [p1, p2] = trendline
  const candleWidth = candles[1].time - candles[0].time
  const futureTime = candles[candles.length-1].time + (candleWidth * 30)
  
  // Calculate extended endpoint
  const slope = (p2.value - p1.value) / (p2.time - p1.time)
  const extValue = p2.value + slope * (futureTime - p2.time)
  
  // SAFETY: clamp to realistic range
  const currentPrice = candles[candles.length-1].close
  const clampedValue = Math.max(
    Math.min(extValue, currentPrice * 1.5),
    currentPrice * 0.5
  )
  
  const series = chart.addLineSeries({
    color: '#f59e0b',
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  })
  series.setData([
    { time: p1.time as UTCTimestamp, value: p1.value },
    { time: futureTime as UTCTimestamp, value: clampedValue },
  ])
  trendlineSeriesRef.current.push(series)

RECALCULATE: on every closed candle (useEffect dependency on candles.length)
```

### Signal Box Rectangle
```
TOOL: drawSignalBox(chart, signal, candles)
DRAWS 2 horizontal lines forming top/bottom of box
(vertical sides not supported natively — use markers instead)

REMOVE OLD:
  boxSeriesRef.current.forEach(s => {
    try { chart.removeSeries(s) } catch(e) {}
  })
  boxSeriesRef.current = []

IF signal AND signal.type !== 'wait':
  const color = signal.type === 'bullish' ? '#22c55e' : '#ef4444'
  const boxStartIndex = candles.length - 8
  const boxEndIndex = candles.length - 1
  const boxStart = candles[Math.max(0, boxStartIndex)].time
  const boxEnd = candles[boxEndIndex].time + (candles[1].time - candles[0].time) * 8

  // Top border
  const topLine = chart.addLineSeries({
    color,
    lineWidth: 1,
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  })
  topLine.setData([
    { time: boxStart as UTCTimestamp, value: signal.resistance },
    { time: boxEnd as UTCTimestamp, value: signal.resistance },
  ])

  // Bottom border
  const bottomLine = chart.addLineSeries({
    color,
    lineWidth: 1,
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  })
  bottomLine.setData([
    { time: boxStart as UTCTimestamp, value: signal.support },
    { time: boxEnd as UTCTimestamp, value: signal.support },
  ])

  boxSeriesRef.current = [topLine, bottomLine]
```

### Signal Arrow Marker
```
TOOL: drawSignalMarker(candleSeries, signal, candles)
  if (!signal || signal.type === 'wait') {
    candleSeries.setMarkers([])
    return
  }

  const signalCandle = candles[candles.length - 1]
  candleSeries.setMarkers([{
    time: signalCandle.time as UTCTimestamp,
    position: signal.type === 'bullish' ? 'belowBar' : 'aboveBar',
    color: signal.type === 'bullish' ? '#22c55e' : '#ef4444',
    shape: signal.type === 'bullish' ? 'arrowUp' : 'arrowDown',
    text: `${signal.type === 'bullish' ? 'LONG' : 'SHORT'} ${signal.confidence}%`,
    size: 2,
  }])
```

---

## Chain: Refs Management

### Complete Refs Setup
```
DECLARE ALL REFS AT TOP OF COMPONENT:
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const ema20Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema50Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const bbSeriesRef = useRef<ISeriesApi<'Line'>[]>([])
  const trendlineSeriesRef = useRef<ISeriesApi<'Line'>[]>([])
  const boxSeriesRef = useRef<ISeriesApi<'Line'>[]>([])
  const baselineRef = useRef<ISeriesApi<'Baseline'> | null>(null)
  const srPriceLinesRef = useRef<IPriceLine[]>([])
  const entryLineRef = useRef<IPriceLine | null>(null)
  const stopLineRef = useRef<IPriceLine | null>(null)
  const targetLineRef = useRef<IPriceLine | null>(null)

INIT EFFECT (runs once):
  useEffect(() => {
    initChart() → create chart, candle, volume, ema series
    return () => { chart.remove() }
  }, [])

SYMBOL/INTERVAL CHANGE EFFECT:
  useEffect(() => {
    if (!candleSeriesRef.current) return
    // Clear all drawings
    clearAllDrawings()
    // Reload data
    candleSeriesRef.current.setData(candles.map(...))
    chart.timeScale().scrollToRealTime()
  }, [symbol, interval])

CANDLE UPDATE EFFECT (live tick):
  useEffect(() => {
    if (!candleSeriesRef.current || !currentCandle) return
    candleSeriesRef.current.update({ ...currentCandle })
    volumeSeriesRef.current?.update({ ...volumeCandle })
  }, [currentCandle])

SIGNAL DRAWING EFFECT (on closed candle):
  useEffect(() => {
    if (!chartRef.current || candles.length < 30) return
    drawSRPriceLines(...)
    drawTrendlines(...)
    drawSignalLines(...)
    drawRiskRewardZone(...)
    drawSignalBox(...)
    drawSignalMarker(...)
  }, [signal, candles.length])  // candles.length = new closed candle

CLEANUP FUNCTION:
  function clearAllDrawings() {
    [...trendlineSeriesRef.current, ...boxSeriesRef.current].forEach(s => {
      try { chartRef.current?.removeSeries(s) } catch(e) {}
    })
    trendlineSeriesRef.current = []
    boxSeriesRef.current = []
    if (baselineRef.current) {
      try { chartRef.current?.removeSeries(baselineRef.current) } catch(e) {}
      baselineRef.current = null
    }
    srPriceLinesRef.current.forEach(l => {
      try { candleSeriesRef.current?.removePriceLine(l) } catch(e) {}
    })
    srPriceLinesRef.current = []
  }
```

---

## Common Errors

```
ERROR: "Cannot read property 'removeSeries' of null"
FIX: Always check chartRef.current !== null before removeSeries
     Wrap in try/catch

ERROR: Series data timestamp must be in ascending order
FIX: Sort candles by time before setData()
     candles.sort((a,b) => a.time - b.time)

ERROR: BaselineSeries not available
FIX: Import from 'lightweight-charts' v4+
     import { createChart, BaselineSeriesOptions } from 'lightweight-charts'

ERROR: Price lines not showing on axis
FIX: axisLabelVisible: true in createPriceLine options

ERROR: Chart not filling container width
FIX: Use ResizeObserver, not window resize event
     Set width: containerRef.current.clientWidth on init

ERROR: Trendline appears as single point
FIX: LineSeries needs minimum 2 data points with different time values

ERROR: Markers disappearing on candle update
FIX: setMarkers() must be called AFTER setData() or update()
     Re-apply markers in the candle update effect

ERROR: Volume bars same color
FIX: Pass color per data point in histogram setData()
     { time, value, color: close >= open ? green : red }
```
