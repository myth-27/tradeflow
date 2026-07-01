---
name: chart-drawing
description: Price-action chart annotation expert — drawing swing points, trendlines, S/R zones, pattern shapes (Head & Shoulders, double top/bottom, triangles, flags), signal lines/boxes, market-structure (HH/HL/LH/LL) labels, and managing it all through a central DrawingRegistry on Lightweight Charts. Load this skill whenever drawing on a chart — trendlines, S/R zones, pattern shapes, swing points, channels, wedges, or any visual overlay on CandleChart.
---

## Role

You are a professional price action trader who has spent 10 years manually drawing on charts. You know exactly how real traders annotate charts — where lines go, how zones look, what shapes patterns make, and how annotations stay clean without cluttering the price. You implement all drawings using Lightweight Charts primitives and ensure they redraw correctly on every new candle.

---

## Chain: Core Drawing Primitives

### Drawing Registry
```
CONCEPT: Every drawing is registered in a central DrawingRegistry
         so it can be removed, updated, or replaced cleanly.

class DrawingRegistry {
  private series: Map<string, ISeriesApi<any>[]> = new Map()
  private priceLines: Map<string, IPriceLine[]> = new Map()
  private markers: Map<string, SeriesMarker<Time>[]> = new Map()

  // Register a series under a named group
  register(group: string, series: ISeriesApi<any>) {
    if (!this.series.has(group)) this.series.set(group, [])
    this.series.get(group)!.push(series)
  }

  // Remove all drawings in a group
  clear(chart: IChartApi, candleSeries: ISeriesApi<any>, group: string) {
    this.series.get(group)?.forEach(s => {
      try { chart.removeSeries(s) } catch(e) {}
    })
    this.series.set(group, [])

    this.priceLines.get(group)?.forEach(l => {
      try { candleSeries.removePriceLine(l) } catch(e) {}
    })
    this.priceLines.set(group, [])
  }

  // Clear everything
  clearAll(chart: IChartApi, candleSeries: ISeriesApi<any>) {
    const groups = [...this.series.keys(), ...this.priceLines.keys()]
    groups.forEach(g => this.clear(chart, candleSeries, g))
    candleSeries.setMarkers([])
  }
}

// In CandleChart.tsx:
const drawingRegistry = useRef(new DrawingRegistry())
```

---

## Chain: Swing Point Drawing

### Identifying and Marking Swing Points
```
TOOL: drawSwingPoints(chart, candleSeries, candles, registry)

PURPOSE: Mark recent swing highs and lows visually on chart
         Real traders always identify these first before drawing anything

ALGORITHM:
  Find swing highs (last 5 on chart):
    isSwingHigh[i] = candle[i].high > candle[i-1].high
                  && candle[i].high > candle[i-2].high
                  && candle[i].high > candle[i+1].high
                  && candle[i].high > candle[i+2].high
  
  Find swing lows (last 5 on chart):
    isSwingLow[i] = candle[i].low < candle[i-1].low
                 && candle[i].low < candle[i-2].low
                 && candle[i].low < candle[i+1].low
                 && candle[i].low < candle[i+2].low

DRAW as markers on candleSeries:
  Swing HIGH marker:
    position: 'aboveBar'
    shape: 'circle'
    color: 'rgba(239,68,68,0.7)'  ← red dot above bar
    size: 1
    text: ''  ← no text, keep clean

  Swing LOW marker:
    position: 'belowBar'
    shape: 'circle'
    color: 'rgba(59,130,246,0.7)'  ← blue dot below bar
    size: 1
    text: ''

IMPORTANT: setMarkers() replaces ALL markers
  Build full markers array first, then call setMarkers() once
  Include signal arrows + swing dots in same array

REGISTRY:
  registry.current.markers.set('swingPoints', allMarkers)
```

---

## Chain: Trendline Drawing

### Support Trendline (Rising Lows)
```
TOOL: drawSupportTrendline(chart, candles, currentPrice, registry)

STEP 1 — Find swing lows to connect:
  swingLows = findSwingLows(candles)
  
  Need at least 2 swing lows to draw a trendline
  Use the 2 most recent significant swing lows
  
  Significant = not within 0.3% of each other (not the same level)

STEP 2 — Validate direction:
  slope = (low2.price - low1.price) / (low2.time - low1.time)
  
  SUPPORT TRENDLINE RULES:
    Must have positive slope (rising lows = uptrend support)
    OR flat slope (horizontal support)
    Negative slope trendline is a RESISTANCE trendline not support
  
  If slope < 0 AND calling this as support → skip, draw as resistance instead

STEP 3 — Extend the line:
  candleWidth = candles[1].time - candles[0].time
  futureTime = candles[candles.length-1].time + (candleWidth * 40)
  
  extendedValue = low2.price + slope * (futureTime - low2.time)
  
  // Safety clamp — never let trendline go below 60% of current price
  extendedValue = Math.max(extendedValue, currentPrice * 0.6)
  extendedValue = Math.min(extendedValue, currentPrice * 1.4)

STEP 4 — Draw as LineSeries:
  const series = chart.addLineSeries({
    color: 'rgba(245,158,11,0.85)',  ← amber
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
    autoscaleInfoProvider: () => ({
      priceRange: { minValue: Math.min(low1.price, extendedValue),
                    maxValue: Math.max(low1.price, extendedValue) },
      margins: { above: 0.1, below: 0.1 },
    }),
  })
  series.setData([
    { time: low1.time as UTCTimestamp, value: low1.price },
    { time: futureTime as UTCTimestamp, value: extendedValue },
  ])
  
  registry.current.register('trendlines', series)

STEP 5 — Add a small label at the right end:
  // Lightweight Charts doesn't support text on lines natively
  // Use a price line on the series for the label:
  series.createPriceLine({
    price: extendedValue,
    color: 'rgba(245,158,11,0.5)',
    lineWidth: 0,
    axisLabelVisible: true,
    title: 'TL',
  })
```

### Resistance Trendline (Falling Highs)
```
TOOL: drawResistanceTrendline(chart, candles, currentPrice, registry)

Same as support but:
  Use swing HIGHS
  Must have negative slope (falling highs = downtrend resistance)
  color: 'rgba(239,68,68,0.85)'  ← red for resistance trendline
  Extend downward: clamp between currentPrice*0.6 and currentPrice*1.4

CHANNEL DETECTION:
  If support trendline slope ≈ resistance trendline slope (within 15%):
    Draw a CHANNEL — two parallel lines
    Shade the channel interior:
      AreaSeries between the two lines
      topColor: 'rgba(245,158,11,0.04)'
      bottomColor: 'rgba(245,158,11,0.02)'
    Label: "Channel" at midpoint
```

---

## Chain: Support & Resistance Zones

### Zone Drawing (NOT single lines)
```
TOOL: drawSRZones(chart, candleSeries, supportLevels, resistanceLevels, currentPrice, atr, registry)

CRITICAL PRE-CHECK (always):
  supportLevels = supportLevels.filter(s => s < currentPrice)
  resistanceLevels = resistanceLevels.filter(r => r > currentPrice)
  If ANY level fails this → remove it, never draw it

ZONE WIDTH:
  zoneWidth = atr * 0.2  ← adaptive, wider in volatile markets
  Min zone width: currentPrice * 0.001  (0.1%)
  Max zone width: currentPrice * 0.008  (0.8%)

FOR EACH SUPPORT LEVEL:
  zoneTop = level + zoneWidth/2
  zoneBottom = level - zoneWidth/2
  
  BOTH zoneTop and zoneBottom must still be < currentPrice
  If zoneTop >= currentPrice → set zoneTop = currentPrice * 0.999
  
  Draw zone using AreaSeries:
    const zone = chart.addAreaSeries({
      topColor: 'rgba(59,130,246,0.20)',
      bottomColor: 'rgba(59,130,246,0.05)',
      lineColor: 'rgba(59,130,246,0.6)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    })
    
    // Fill from zoneBottom to zoneTop using setData
    // AreaSeries fills from the data line DOWN to bottom
    // So set data at zoneTop, it fills down to the zero line
    // We need to constrain using priceScale
    
    // Better approach: Two LineSeries for borders + shading via CSS overlay
    // Actually for Lightweight Charts, use this pattern:
    
    // Upper border line
    const upperBorder = chart.addLineSeries({
      color: 'rgba(59,130,246,0.5)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    upperBorder.setData(candles.map(c => ({ time: c.time, value: zoneTop })))
    
    // Lower border line  
    const lowerBorder = chart.addLineSeries({
      color: 'rgba(59,130,246,0.3)',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    lowerBorder.setData(candles.map(c => ({ time: c.time, value: zoneBottom })))
    
    // Zone fill: BaselineSeries with base at zone midpoint
    const fill = chart.addBaselineSeries({
      baseValue: { type: 'price', price: zoneTop },
      topLineColor: 'transparent',
      topFillColor1: 'transparent',
      topFillColor2: 'transparent',
      bottomLineColor: 'transparent',
      bottomFillColor1: 'rgba(59,130,246,0.12)',
      bottomFillColor2: 'rgba(59,130,246,0.03)',
      lineWidth: 0,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    fill.setData(candles.map(c => ({ time: c.time, value: zoneBottom })))
    
    // Label on right axis
    candleSeries.createPriceLine({
      price: level,
      color: '#3b82f6',
      lineWidth: 0,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: `S $${level.toFixed(0)}`,
    })
    
    registry.current.register('srZones', upperBorder)
    registry.current.register('srZones', lowerBorder)
    registry.current.register('srZones', fill)

FOR EACH RESISTANCE LEVEL:
  Same but red rgba(239,68,68) and zone must be > currentPrice
  zoneBottom = level - zoneWidth/2
  zoneTop = level + zoneWidth/2
  Both must be > currentPrice * 1.001
  Label: `R $${level.toFixed(0)}` in red
```

---

## Chain: Pattern Shape Drawing

### Head and Shoulders Shape
```
TOOL: drawHnSShape(chart, candleSeries, pattern, candles, registry)

DRAWS:
  1. Neckline: horizontal line at neckline price
     color: '#f59e0b', lineWidth: 1, title: 'Neckline'
  
  2. Three peak markers (L, H, R):
     markers at leftShoulder.time, head.time, rightShoulder.time
     position: 'aboveBar'
     shape: 'circle', size: 2, color: '#ef4444'
     text: 'LS' / 'H' / 'RS'
  
  3. Arch lines connecting peaks (approximate):
     Add 3-point LineSeries connecting L→H→R at peak prices
     color: 'rgba(239,68,68,0.4)', lineWidth: 1, dashed
  
  4. Target projection line:
     Dashed line from neckline break down to target
     color: 'rgba(139,92,246,0.7)', lineWidth: 1
     Vertical dashed line at the break candle
  
  5. Measured move annotation:
     PriceLine at target price: '🎯 H&S Target'

CODE:
  // Neckline
  const neckline = candleSeries.createPriceLine({
    price: pattern.neckline,
    color: '#f59e0b',
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: '— Neckline',
  })
  
  // Peak connection line (L shoulder → Head → R shoulder)
  const peakLine = chart.addLineSeries({
    color: 'rgba(239,68,68,0.5)',
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  })
  peakLine.setData([
    { time: pattern.leftShoulder.time, value: pattern.leftShoulder.price },
    { time: pattern.head.time, value: pattern.head.price },
    { time: pattern.rightShoulder.time, value: pattern.rightShoulder.price },
  ])
  
  registry.current.register('patternShape', peakLine)
```

### Triangle Shape Drawing
```
TOOL: drawTriangleShape(chart, candles, pattern, registry)

ASCENDING TRIANGLE:
  1. Flat resistance line (horizontal):
     LineSeries at resistance price across pattern range
     color: 'rgba(239,68,68,0.7)', lineWidth: 1
  
  2. Rising support trendline:
     LineSeries from firstLow to lastLow, extended to resistance
     color: 'rgba(59,130,246,0.7)', lineWidth: 1
  
  3. Triangle fill (the converging zone):
     AreaSeries between resistance and trendline
     topColor: 'rgba(245,158,11,0.06)'
     bottomColor: 'rgba(245,158,11,0.01)'
  
  4. Breakout projection:
     Dashed line upward from apex at target price
     color: 'rgba(34,197,94,0.6)'

DESCENDING TRIANGLE:
  Same but:
  Flat support line (blue, below price)
  Falling resistance trendline (red, above price)
  Fill same amber tint

SYMMETRICAL TRIANGLE:
  Both lines converge
  Fill amber tint
  Two possible breakout arrows (dashed, one up one down until confirmed)
```

### Double Top/Bottom Shape
```
TOOL: drawDoubleTopShape(chart, candleSeries, pattern, candles, registry)

DOUBLE TOP:
  1. Two peak markers at the two tops:
     markers: shape 'circle', color red, position aboveBar, text '⊤'
  
  2. Horizontal line connecting the two peaks:
     LineSeries from peak1.time to peak2.time at peak price
     color: 'rgba(239,68,68,0.6)', lineWidth: 1
     Extends slightly beyond peak2
  
  3. Neckline (support that got broken):
     Horizontal line at the trough between peaks
     color: 'rgba(245,158,11,0.6)', lineWidth: 1, dashed
     title: 'Neckline / Support'
  
  4. Measured move target:
     priceHeight = peakPrice - neckline
     target = neckline - priceHeight
     createPriceLine at target: color green, '🎯 Target'
  
  5. Breakdown zone highlight:
     Small red zone below neckline (where sell triggers)
     width: atr * 0.3

DOUBLE BOTTOM: Mirror — blue peaks below, resistance neckline, green target above
```

### Bull/Bear Flag Shape
```
TOOL: drawFlagShape(chart, candles, pattern, registry)

BULL FLAG:
  1. Flagpole: thick green vertical line at the pole candles
     LineSeries up from base to top of pole
     color: 'rgba(34,197,94,0.6)', lineWidth: 2
  
  2. Flag body: rectangle around consolidation candles
     Top line: LineSeries at flag high, color red dashed (downsloping)
     Bottom line: LineSeries at flag low, color red dashed (downsloping)
     Fill: rgba(245,158,11,0.05) between the two lines
  
  3. Breakout projection: 
     Dashed green line upward = flagBase + flagpoleHeight
     '🎯 Flag Target' label

BEAR FLAG: Mirror — red pole, upsloping flag channel, red target below
```

---

## Chain: Price Action Drawings

### Real-Time Swing Point Labels
```
TOOL: drawPriceActionLabels(candleSeries, candles, currentPrice)

Mark key price action points that traders look at:

HIGHER HIGH / LOWER HIGH detection:
  Compare last 3 swing highs:
  If swingHigh[n] > swingHigh[n-1] → "HH" label above bar (green text)
  If swingHigh[n] < swingHigh[n-1] → "LH" label above bar (red text)

HIGHER LOW / LOWER LOW detection:
  Compare last 3 swing lows:
  If swingLow[n] > swingLow[n-1] → "HL" label below bar (green text)
  If swingLow[n] < swingLow[n-1] → "LL" label below bar (red text)

These labels are how real price action traders read market structure:
  HH + HL = uptrend (bias: LONG)
  LH + LL = downtrend (bias: SHORT)
  HH + LL = volatile, no clear bias

IMPLEMENT as markers:
  const paMarkers = swingHighs.map((sh, i) => ({
    time: sh.time as UTCTimestamp,
    position: 'aboveBar' as const,
    color: swingHighs[i].price > swingHighs[i-1]?.price ? '#22c55e' : '#ef4444',
    shape: 'text' as const,  ← if supported, else 'circle'
    text: swingHighs[i].price > swingHighs[i-1]?.price ? 'HH' : 'LH',
    size: 1,
  }))
  
  // Combine with all other markers before calling setMarkers()
```

### Candlestick Pattern Labels
```
TOOL: drawCandlestickLabels(candleSeries, candles)

For last 10 candles, detect and mark:
  Doji: '✦' marker (amber, at bar)
  Hammer: '🔨' or 'Ham' below bar (green)
  Shooting Star: '★' above bar (red)
  Engulfing Bullish: '▲' below bar (green)
  Engulfing Bearish: '▼' above bar (red)
  Morning Star: 'MS' below the third bar (green)

Size: 1 (small, not cluttering)
These appear as small annotations, not big icons
```

---

## Chain: Drawing Refresh Strategy

### When to Redraw What
```
REDRAW STRATEGY — performance critical:

ON EVERY TICK (currentCandle changes):
  → DO NOT redraw anything except live candle update
  → No S/R, no trendlines, no patterns on tick

ON CANDLE CLOSE (candles.length increases):
  → Redraw trendlines (they shift as new swing points form)
  → Redraw swing point markers (new swing may have formed)
  → Update S/R zones if a level has been broken
  → Re-evaluate pattern shapes

ON SYMBOL/INTERVAL CHANGE:
  → clearAll() from registry
  → Reload everything fresh

ON SIGNAL CHANGE (topPattern changes):
  → Redraw pattern shape for new pattern
  → Update entry/stop/target lines
  → Redraw risk/reward zone

ON ZOOM/SCROLL:
  → Lightweight Charts handles this automatically
  → Never redraw on zoom — series persist through zoom

USEEFFECT DEPENDENCIES:
  tickEffect: [currentCandle]
  closeEffect: [candles.length]
  signalEffect: [signal?.patternName, signal?.confidence]
  initEffect: [] (once)
  symbolEffect: [symbol, interval]
```

### Full Redraw Function
```
TOOL: redrawAllAnnotations(chart, candleSeries, data, registry)

INPUTS:
  data = { candles, currentPrice, signal, supportLevels,
           resistanceLevels, trendlinePoints, indicators, pattern }

SEQUENCE (order matters for z-index layering):
  1. registry.clearAll()                    ← clean slate
  2. drawSRZones(...)                        ← behind everything
  3. drawTrendlines(...)                     ← above zones
  4. if signal.type !== 'wait':
       drawPatternShape(...)                  ← pattern specific
       drawSignalLines(...)                   ← entry/stop/target
       drawRiskRewardZone(...)               ← green/red fill
       drawSignalBox(...)                     ← bounding box
  5. drawSwingPoints(...)                    ← dots on highs/lows
  6. drawPriceActionLabels(...)              ← HH/HL/LH/LL
  7. drawCandlestickLabels(...)              ← doji, hammer etc
  8. drawSignalMarker(...)                   ← LONG/SHORT arrow

IMPORTANT: buildMarkersArray() before calling setMarkers()
  All markers (swing, PA labels, signal arrow) combined into ONE array
  setMarkers() is called ONCE at the end with the combined array
  Calling setMarkers() multiple times replaces previous markers
```

---

## Chain: Visual Hierarchy Rules

### What Goes on Top of What
```
Z-ORDER (bottom to top):
  1. S/R Zone fills (most transparent, lowest)
  2. Trendline dashed lines
  3. Triangle/pattern fill areas
  4. EMA lines
  5. Bollinger Bands
  6. Entry/Stop/Target price lines
  7. Risk/Reward baseline fill
  8. Candlesticks (always on top of indicators)
  9. Markers (swing dots, pattern labels, signal arrows)
  10. Price line labels on right axis (always topmost)

COLOR OPACITY RULES:
  Zone fills: 0.05-0.15 opacity (very subtle)
  Zone borders: 0.4-0.6 opacity (visible but not loud)
  Trendlines: 0.7-0.85 opacity (clearly visible)
  Signal lines: 0.9-1.0 opacity (fully visible)
  
DENSITY RULE:
  Max 2 support zones visible at once
  Max 2 resistance zones visible at once
  Max 2 trendlines (one support, one resistance)
  Only 1 pattern shape drawn at a time (top pattern only)
  
CLEAN CHART RULE:
  If more than 8 drawings are visible → clear oldest S/R zones
  Charts should look like a pro drew them, not a robot
  When in doubt: less is more
```

---

## Common Bugs

```
BUG: Trendlines disappear on symbol change
FIX: clearAll() before symbol change, then redrawAllAnnotations()
     Trendlines stored in registry must be in 'trendlines' group

BUG: Markers disappear when live candle updates
FIX: Never call setMarkers([]) on tick update
     Only call setMarkers on candle close or signal change
     Store markers in ref: markersRef.current = allMarkers
     Reapply: candleSeries.setMarkers(markersRef.current)

BUG: S/R zone fills not visible
FIX: BaselineSeries needs data spanning full candle range
     Use candles.map(c => ({ time: c.time, value: zoneBottom }))
     Not just 2 data points

BUG: Zone appears above price (support above price)
FIX: Always filter: support.filter(s => s < currentPrice)
     Check zoneTop < currentPrice after calculating zone bounds

BUG: Trendline extends to impossible prices
FIX: Clamp: Math.max(min, Math.min(max, extendedValue))
     min = currentPrice * 0.5, max = currentPrice * 1.5

BUG: All drawings stacked (can't see candles)
FIX: Keep fill opacity <= 0.15
     Zone borders as dashed lines, not solid
     Use lineStyle: LineStyle.Dashed or Dotted

BUG: Pattern shape not matching actual pattern
FIX: Pass actual peak/trough TIME values from detection
     Not index values — Lightweight Charts uses timestamps
     Convert: candles[index].time as UTCTimestamp

BUG: setMarkers called multiple times, markers disappearing
FIX: Build ONE combined markers array, call setMarkers ONCE
     const allMarkers = [...swingMarkers, ...paMarkers, ...signalMarkers]
     allMarkers.sort((a,b) => (a.time as number) - (b.time as number))
     candleSeries.setMarkers(allMarkers)
```
