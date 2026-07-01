---
name: trading-expert
description: Expert trading analyst for crypto and stock apps. Covers technical analysis, quantitative analysis, price action, S/R logic, pattern detection, signal generation, backtesting, and chart rendering. Load this skill whenever building, debugging, or improving any trading feature — pattern engine, chart drawings, signal logic, backtesting, or indicator calculations.
---

# Trading Expert Skill

You are a senior quantitative trading engineer and technical analyst with 15 years of experience across crypto markets, equities, and derivatives. You have deep expertise in price action trading, algorithmic pattern detection, risk management systems, and trading UI/UX. Every piece of code you write must be mathematically correct, market-aware, and trader-tested.

Before writing any trading logic, run through this checklist internally:
- Is the S/R logic price-aware? (support must be BELOW price, resistance ABOVE)
- Are all prices in the correct units? (paise vs rupees, satoshi vs BTC, raw vs adjusted)
- Does the pattern detection use closed candles only?
- Is the signal confidence calibrated against historical win rates?
- Are position sizes and R:R ratios calculated correctly?
- Will the chart drawing persist as price moves?

---

## PART 1: SUPPORT AND RESISTANCE — THE MOST COMMON BUG

### The Golden Rule
Support is ALWAYS below current price. Resistance is ALWAYS above current price.
If your code ever shows support above the current trading price, it is wrong. Full stop.

### Correct S/R Detection Algorithm

```typescript
function findSupportLevels(candles: Candle[], currentPrice: number, count = 3): number[] {
  // Step 1: Find swing lows (local minima)
  // A swing low is a candle whose low is lower than the 2 candles before AND after it
  const swingLows: number[] = []
  
  for (let i = 2; i < candles.length - 2; i++) {
    const low = candles[i].low
    const isSwingLow = (
      low < candles[i-1].low &&
      low < candles[i-2].low &&
      low < candles[i+1].low &&
      low < candles[i+2].low
    )
    if (isSwingLow) swingLows.push(low)
  }
  
  // Step 2: Cluster nearby levels (within 0.5% of each other = same zone)
  const clusters: number[][] = []
  swingLows.forEach(level => {
    const existing = clusters.find(c => 
      Math.abs(c[0] - level) / c[0] < 0.005
    )
    if (existing) existing.push(level)
    else clusters.push([level])
  })
  
  // Step 3: Score by cluster size (more touches = stronger level)
  const scored = clusters
    .map(c => ({ price: c.reduce((a,b) => a+b) / c.length, touches: c.length }))
    .sort((a,b) => b.touches - a.touches)
  
  // Step 4: CRITICAL — only return levels BELOW current price
  return scored
    .filter(s => s.price < currentPrice * 0.999) // must be at least 0.1% below
    .slice(0, count)
    .map(s => s.price)
}

function findResistanceLevels(candles: Candle[], currentPrice: number, count = 3): number[] {
  // Same logic but with swing HIGHS
  const swingHighs: number[] = []
  
  for (let i = 2; i < candles.length - 2; i++) {
    const high = candles[i].high
    const isSwingHigh = (
      high > candles[i-1].high &&
      high > candles[i-2].high &&
      high > candles[i+1].high &&
      high > candles[i+2].high
    )
    if (isSwingHigh) swingHighs.push(high)
  }
  
  const clusters: number[][] = []
  swingHighs.forEach(level => {
    const existing = clusters.find(c =>
      Math.abs(c[0] - level) / c[0] < 0.005
    )
    if (existing) existing.push(level)
    else clusters.push([level])
  })
  
  const scored = clusters
    .map(c => ({ price: c.reduce((a,b) => a+b) / c.length, touches: c.length }))
    .sort((a,b) => b.touches - a.touches)
  
  // CRITICAL — only return levels ABOVE current price
  return scored
    .filter(s => s.price > currentPrice * 1.001) // must be at least 0.1% above
    .slice(0, count)
    .map(s => s.price)
}
```

### S/R Validation — run this before rendering
```typescript
function validateSRLevels(
  support: number[], 
  resistance: number[], 
  currentPrice: number
): { support: number[], resistance: number[] } {
  return {
    // Nuclear option: filter everything that violates the rule
    support: support.filter(s => s < currentPrice),
    resistance: resistance.filter(r => r > currentPrice)
  }
}
// Always call this before passing S/R to chart or signal card
const validated = validateSRLevels(rawSupport, rawResistance, currentPrice)
```

### S/R Zone Width
Never draw S/R as a single line. Draw as a zone:
- Zone = level ± (ATR * 0.15)  — not a fixed % 
- This makes zones wider in volatile markets, tighter in calm ones
- Upper border of support zone = support + (ATR * 0.15)
- Lower border of support zone = support - (ATR * 0.15)

---

## PART 2: PATTERN DETECTION — MARKET-CORRECT RULES

### Universal Pattern Rules
1. Only run on CLOSED candles — never on the forming candle
2. Minimum candle count before running: 30 candles
3. All patterns need a lookback window — use last 50-100 candles only
4. Never detect the same pattern twice in a row without a reset condition
5. Confidence must account for volume confirmation

### Pattern Definitions with Correct Logic

#### Double Top
```typescript
function detectDoubleTop(candles: Candle[], currentPrice: number) {
  const lookback = candles.slice(-50)
  const highs = lookback.map(c => c.high)
  
  // Find two peaks — must be separated by at least 5 candles
  let peak1Index = -1, peak2Index = -1
  let peak1Price = 0, peak2Price = 0
  
  for (let i = 5; i < lookback.length - 5; i++) {
    const isLocalHigh = highs[i] > highs[i-1] && highs[i] > highs[i-2] &&
                        highs[i] > highs[i+1] && highs[i] > highs[i+2]
    if (isLocalHigh) {
      if (peak1Index === -1) {
        peak1Index = i; peak1Price = highs[i]
      } else if (i - peak1Index >= 5) {
        // Second peak must be within 1.5% of first peak
        if (Math.abs(highs[i] - peak1Price) / peak1Price < 0.015) {
          peak2Index = i; peak2Price = highs[i]
        }
      }
    }
  }
  
  if (peak1Index === -1 || peak2Index === -1) return { found: false }
  
  // Neckline = lowest point between the two peaks
  const between = lookback.slice(peak1Index, peak2Index)
  const neckline = Math.min(...between.map(c => c.low))
  
  // Pattern only CONFIRMED when price breaks below neckline
  const patternHeight = ((peak1Price + peak2Price) / 2) - neckline
  const target = neckline - patternHeight  // measured move
  
  // CRITICAL: resistance is the peak price, support is the neckline
  // Current price must be NEAR or BELOW neckline for this to be valid
  const isConfirmed = currentPrice <= neckline * 1.005
  
  // Confidence based on:
  // - Peak similarity (closer = higher confidence)
  // - Volume on second peak (should be lower than first = bearish)
  // - Whether neckline is broken
  const peakSimilarity = 1 - (Math.abs(peak1Price - peak2Price) / peak1Price)
  const baseConfidence = peakSimilarity * 70
  const confirmBonus = isConfirmed ? 20 : 0
  
  return {
    found: true,
    type: 'bearish',
    resistance: Math.max(peak1Price, peak2Price),
    support: neckline,     // neckline IS the support, below current price
    target,
    stopLoss: Math.max(peak1Price, peak2Price) * 1.002, // just above peaks
    confidence: Math.min(Math.round(baseConfidence + confirmBonus), 95),
    neckline
  }
}
```

#### Ascending Triangle
```typescript
function detectAscendingTriangle(candles: Candle[], currentPrice: number) {
  const lookback = candles.slice(-60)
  
  // Resistance: flat top — find a price level touched 3+ times
  const highs = lookback.map(c => c.high)
  const maxHigh = Math.max(...highs)
  const resistanceTouches = highs.filter(h => h > maxHigh * 0.995).length
  
  // Support: rising lows — fit a linear regression to swing lows
  const swingLows: {index: number, price: number}[] = []
  for (let i = 2; i < lookback.length - 2; i++) {
    if (lookback[i].low < lookback[i-1].low && lookback[i].low < lookback[i+1].low) {
      swingLows.push({ index: i, price: lookback[i].low })
    }
  }
  
  if (swingLows.length < 3) return { found: false }
  
  // Linear regression on swing lows to check if rising
  const n = swingLows.length
  const sumX = swingLows.reduce((a,p) => a + p.index, 0)
  const sumY = swingLows.reduce((a,p) => a + p.price, 0)
  const sumXY = swingLows.reduce((a,p) => a + p.index * p.price, 0)
  const sumX2 = swingLows.reduce((a,p) => a + p.index * p.index, 0)
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
  
  // Must have positive slope (rising lows) to be ascending triangle
  if (slope <= 0) return { found: false }
  
  const nearestSupport = swingLows[swingLows.length - 1].price
  
  // VALIDATE: support must be below current price
  if (nearestSupport >= currentPrice) return { found: false }
  // VALIDATE: resistance must be above current price  
  if (maxHigh <= currentPrice) return { found: false }
  
  const patternHeight = maxHigh - nearestSupport
  const target = maxHigh + patternHeight  // breakout target
  
  return {
    found: true,
    type: 'bullish',
    resistance: maxHigh,
    support: nearestSupport,
    target,
    stopLoss: nearestSupport * 0.995,
    confidence: Math.min(60 + resistanceTouches * 5, 88),
    slope
  }
}
```

#### Head and Shoulders
```typescript
function detectHeadAndShoulders(candles: Candle[], currentPrice: number) {
  const lookback = candles.slice(-80)
  
  // Find 3 peaks where middle is highest
  const peaks: {index: number, price: number}[] = []
  for (let i = 3; i < lookback.length - 3; i++) {
    const h = lookback[i].high
    if (h > lookback[i-1].high && h > lookback[i-2].high && h > lookback[i-3].high &&
        h > lookback[i+1].high && h > lookback[i+2].high && h > lookback[i+3].high) {
      peaks.push({ index: i, price: h })
    }
  }
  
  if (peaks.length < 3) return { found: false }
  
  // Try all combinations of 3 peaks
  for (let i = 0; i < peaks.length - 2; i++) {
    const left = peaks[i]
    const head = peaks[i+1]
    const right = peaks[i+2]
    
    // Head must be higher than both shoulders
    if (head.price <= left.price || head.price <= right.price) continue
    
    // Shoulders must be roughly equal (within 3%)
    if (Math.abs(left.price - right.price) / left.price > 0.03) continue
    
    // Minimum separation between peaks
    if (head.index - left.index < 5 || right.index - head.index < 5) continue
    
    // Neckline: connect the troughs between L-H and H-R
    const leftTrough = Math.min(...lookback.slice(left.index, head.index).map(c => c.low))
    const rightTrough = Math.min(...lookback.slice(head.index, right.index).map(c => c.low))
    const neckline = (leftTrough + rightTrough) / 2
    
    const patternHeight = head.price - neckline
    const target = neckline - patternHeight
    
    // Shoulders are resistance, neckline is support
    // VALIDATE levels against current price
    const shoulderResistance = Math.max(left.price, right.price)
    if (neckline >= currentPrice * 1.005) continue  // neckline must be near or above
    
    return {
      found: true,
      type: 'bearish',
      resistance: shoulderResistance,
      support: neckline,
      target,
      stopLoss: head.price * 1.001,
      neckline,
      confidence: 79,
      leftShoulder: left,
      head,
      rightShoulder: right
    }
  }
  
  return { found: false }
}
```

### Pattern Validation Wrapper — always use this
```typescript
function validatePattern(pattern: PatternResult, currentPrice: number): PatternResult | null {
  if (!pattern || !pattern.found) return null
  
  // Rule 1: Support must be below current price
  if (pattern.support >= currentPrice) {
    pattern.support = currentPrice * 0.98  // fallback: 2% below
  }
  
  // Rule 2: Resistance must be above current price
  if (pattern.resistance <= currentPrice) {
    pattern.resistance = currentPrice * 1.02  // fallback: 2% above
  }
  
  // Rule 3: Target must make directional sense
  if (pattern.type === 'bullish' && pattern.target <= currentPrice) return null
  if (pattern.type === 'bearish' && pattern.target >= currentPrice) return null
  
  // Rule 4: Stop loss must be on the LOSING side
  if (pattern.type === 'bullish' && pattern.stopLoss >= currentPrice) return null
  if (pattern.type === 'bearish' && pattern.stopLoss <= currentPrice) return null
  
  // Rule 5: R:R must be at least 1:1.5 to be worth showing
  const risk = Math.abs(currentPrice - pattern.stopLoss)
  const reward = Math.abs(pattern.target - currentPrice)
  pattern.riskReward = reward / risk
  if (pattern.riskReward < 1.5) return null
  
  // Rule 6: Confidence minimum
  if (pattern.confidence < 55) return null
  
  return pattern
}
```

---

## PART 3: INDICATORS — CORRECT IMPLEMENTATIONS

### RSI
```typescript
function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  
  const changes = closes.slice(1).map((c, i) => c - closes[i])
  
  // Initial averages (simple average for first period)
  let avgGain = changes.slice(0, period)
    .filter(c => c > 0).reduce((a,b) => a+b, 0) / period
  let avgLoss = Math.abs(changes.slice(0, period)
    .filter(c => c < 0).reduce((a,b) => a+b, 0)) / period
  
  // Wilder's smoothing for subsequent periods
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
  }
  
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2))
}

// RSI interpretation for signals
function interpretRSI(rsi: number): { label: string, color: string, signal: string } {
  if (rsi < 30) return { label: 'Oversold', color: '#22c55e', signal: 'bullish' }
  if (rsi < 40) return { label: 'Near Oversold', color: '#86efac', signal: 'mild_bullish' }
  if (rsi > 70) return { label: 'Overbought', color: '#ef4444', signal: 'bearish' }
  if (rsi > 60) return { label: 'Near Overbought', color: '#fca5a5', signal: 'mild_bearish' }
  return { label: 'Neutral', color: '#888888', signal: 'neutral' }
}
```

### MACD
```typescript
function calcMACD(closes: number[]): { 
  macd: number, signal: number, histogram: number, trend: 'bullish' | 'bearish' 
} {
  const ema12 = calcEMA(closes, 12)
  const ema26 = calcEMA(closes, 26)
  
  // MACD line = EMA12 - EMA26
  const macdLine = ema12.map((v, i) => v - ema26[i])
  
  // Signal line = 9-period EMA of MACD line
  const signalLine = calcEMA(macdLine.filter(v => !isNaN(v)), 9)
  
  const lastMACD = macdLine[macdLine.length - 1]
  const lastSignal = signalLine[signalLine.length - 1]
  const histogram = lastMACD - lastSignal
  
  return {
    macd: parseFloat(lastMACD.toFixed(4)),
    signal: parseFloat(lastSignal.toFixed(4)),
    histogram: parseFloat(histogram.toFixed(4)),
    trend: histogram > 0 ? 'bullish' : 'bearish'
  }
}

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const ema: number[] = []
  
  // Seed with SMA of first period values
  const seed = values.slice(0, period).reduce((a,b) => a+b, 0) / period
  ema.push(seed)
  
  for (let i = period; i < values.length; i++) {
    ema.push(values[i] * k + ema[ema.length - 1] * (1 - k))
  }
  
  return ema
}
```

### ATR (Average True Range)
```typescript
function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0
  
  const trueRanges = candles.slice(1).map((c, i) => {
    const prev = candles[i]
    return Math.max(
      c.high - c.low,                    // current range
      Math.abs(c.high - prev.close),     // gap up
      Math.abs(c.low - prev.close)       // gap down
    )
  })
  
  // Wilder's smoothing
  let atr = trueRanges.slice(0, period).reduce((a,b) => a+b, 0) / period
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period
  }
  
  return parseFloat(atr.toFixed(2))
}
// ATR use cases:
// Stop loss = entry - (ATR * 1.5) for long
// Stop loss = entry + (ATR * 1.5) for short
// Zone width = ATR * 0.15
// Volatility check: if ATR > 2% of price = high volatility, reduce position size
```

### Bollinger Bands
```typescript
function calcBollingerBands(closes: number[], period = 20, stdDev = 2) {
  if (closes.length < period) return null
  
  const recent = closes.slice(-period)
  const middle = recent.reduce((a,b) => a+b, 0) / period
  
  const variance = recent.reduce((a,b) => a + Math.pow(b - middle, 2), 0) / period
  const std = Math.sqrt(variance)
  
  return {
    upper: parseFloat((middle + stdDev * std).toFixed(2)),
    middle: parseFloat(middle.toFixed(2)),
    lower: parseFloat((middle - stdDev * std).toFixed(2)),
    bandwidth: parseFloat(((stdDev * 2 * std) / middle * 100).toFixed(2)),
    // %B: where is current price within the bands?
    // 0 = at lower band, 0.5 = at middle, 1 = at upper band
    percentB: parseFloat(((closes[closes.length-1] - (middle - stdDev * std)) / (stdDev * 2 * std)).toFixed(2))
  }
}
```

### Volume Analysis
```typescript
function calcVolumeProfile(candles: Candle[]): {
  avgVolume: number,
  currentVolume: number,
  volumeRatio: number,
  label: string,
  isHighVolume: boolean
} {
  if (candles.length < 20) return { 
    avgVolume: 0, currentVolume: 0, 
    volumeRatio: 1, label: '1.0x', isHighVolume: false 
  }
  
  // Average of last 20 CLOSED candles (not including current forming)
  const closedCandles = candles.slice(-21, -1)
  const avgVolume = closedCandles.reduce((a,c) => a + c.volume, 0) / closedCandles.length
  const currentVolume = candles[candles.length - 1].volume
  
  const ratio = avgVolume > 0 ? currentVolume / avgVolume : 1
  
  return {
    avgVolume: parseFloat(avgVolume.toFixed(2)),
    currentVolume: parseFloat(currentVolume.toFixed(2)),
    volumeRatio: parseFloat(ratio.toFixed(2)),
    label: ratio >= 2 ? `🔥 ${ratio.toFixed(1)}x` : `${ratio.toFixed(1)}x`,
    isHighVolume: ratio > 1.5
  }
}

// Volume confirmation rules:
// Breakout with volumeRatio > 1.5 = CONFIRMED breakout
// Breakout with volumeRatio < 0.8 = FALSE breakout risk — lower confidence by 20%
// Consolidation with declining volume = healthy pattern formation
// Spike to volumeRatio > 3.0 = institutional activity, high significance
```

---

## PART 4: SIGNAL GENERATION — CORRECT LOGIC

### Signal Priority System
```typescript
// Only ONE signal at a time. Priority order:
// 1. Confirmed breakout (price has already broken key level with volume)
// 2. Pattern completion (pattern fully formed, waiting for entry)
// 3. Candlestick reversal at key level (hammer at support, etc.)
// 4. Indicator confluence (RSI + MACD + BB all aligned)

function generateSignal(
  patterns: PatternResult[],
  indicators: Indicators,
  currentPrice: number,
  atr: number
): Signal | null {
  
  // Filter valid patterns
  const valid = patterns
    .map(p => validatePattern(p, currentPrice))
    .filter(Boolean)
    .sort((a,b) => b!.confidence - a!.confidence) as PatternResult[]
  
  if (valid.length === 0) return null
  
  const top = valid[0]
  const second = valid[1]
  
  // CONFLICT CHECK: if top two signals oppose each other within 15% confidence
  if (second && top.type !== second.type && 
      top.type !== 'neutral' && second.type !== 'neutral' &&
      Math.abs(top.confidence - second.confidence) < 15) {
    return { type: 'wait', reason: `${top.name} vs ${second.name}`, confidence: 0 }
  }
  
  // INDICATOR CONFLUENCE: does indicator direction agree with pattern?
  let confluenceBonus = 0
  const macdBullish = indicators.macd.histogram > 0
  const rsiBullish = indicators.rsi < 50
  
  if (top.type === 'bullish') {
    if (macdBullish) confluenceBonus += 5
    if (rsiBullish) confluenceBonus += 5
    if (indicators.volumeProfile.isHighVolume) confluenceBonus += 10
  } else if (top.type === 'bearish') {
    if (!macdBullish) confluenceBonus += 5
    if (!rsiBullish) confluenceBonus += 5
    if (indicators.volumeProfile.isHighVolume) confluenceBonus += 10
  }
  
  // Calculate final entry, stop, target using ATR
  const finalEntry = currentPrice
  let finalStop: number
  let finalTarget: number
  
  if (top.type === 'bullish') {
    // Stop below support or ATR-based, whichever is closer (safer)
    const atrStop = currentPrice - (atr * 1.5)
    const patternStop = top.stopLoss
    finalStop = Math.max(atrStop, patternStop) // take the closer (less risky) stop
    finalTarget = top.target
  } else {
    const atrStop = currentPrice + (atr * 1.5)
    const patternStop = top.stopLoss
    finalStop = Math.min(atrStop, patternStop)
    finalTarget = top.target
  }
  
  const risk = Math.abs(finalEntry - finalStop)
  const reward = Math.abs(finalTarget - finalEntry)
  const rr = parseFloat((reward / risk).toFixed(2))
  
  return {
    type: top.type as 'bullish' | 'bearish',
    patternName: top.name,
    confidence: Math.min(top.confidence + confluenceBonus, 95),
    entry: finalEntry,
    stopLoss: finalStop,
    target: finalTarget,
    riskReward: rr,
    support: top.support,
    resistance: top.resistance
  }
}
```

---

## PART 5: CHART DRAWING — CORRECT LIGHTWEIGHT CHARTS PATTERNS

### S/R Lines that persist
```typescript
// Store refs so we can remove and redraw on each candle close
const srLinesRef = useRef<ISeriesApi<'Line'>[]>([])

function drawSRLevels(chart, candleSeries, support: number[], resistance: number[], currentPrice: number) {
  // ALWAYS validate before drawing
  const validSupport = support.filter(s => s < currentPrice)
  const validResistance = resistance.filter(r => r > currentPrice)
  
  // Remove old lines
  srLinesRef.current.forEach(line => {
    try { chart.removeSeries(line) } catch(e) {}
  })
  srLinesRef.current = []
  
  // Draw support price lines
  validSupport.forEach(level => {
    const line = candleSeries.createPriceLine({
      price: level,
      color: '#3b82f6',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `S $${level.toFixed(0)}`
    })
    // Note: createPriceLine returns IChartApi, not a series
    // Store differently — use a flag and recreate on symbol change
  })
  
  // Draw resistance price lines  
  validResistance.forEach(level => {
    candleSeries.createPriceLine({
      price: level,
      color: '#ef4444',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `R $${level.toFixed(0)}`
    })
  })
}
```

### Trendlines that extend forward
```typescript
function drawTrendlines(chart, trendlinePoints, candles: Candle[]) {
  // Remove existing trendline series
  trendlineSeriesRef.current.forEach(s => {
    try { chart.removeSeries(s) } catch(e) {}
  })
  trendlineSeriesRef.current = []
  
  const { supportTrendline, resistanceTrendline } = trendlinePoints
  const lastTime = candles[candles.length - 1].time
  const candleWidth = candles.length > 1 
    ? candles[1].time - candles[0].time 
    : 300 // 5min in seconds
  
  // Extend 30 candles into future
  const futureTime = lastTime + (candleWidth * 30)
  
  if (supportTrendline && supportTrendline.length === 2) {
    const [p1, p2] = supportTrendline
    const slope = (p2.value - p1.value) / (p2.time - p1.time)
    const extendedValue = p2.value + slope * (futureTime - p2.time)
    
    // Only draw if extended value is a reasonable price (not below 0 or above 10x)
    const currentPrice = candles[candles.length-1].close
    if (extendedValue > currentPrice * 0.5 && extendedValue < currentPrice * 2) {
      const series = chart.addLineSeries({
        color: '#f59e0b',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      })
      series.setData([
        { time: p1.time, value: p1.value },
        { time: futureTime, value: extendedValue }
      ])
      trendlineSeriesRef.current.push(series)
    }
  }
  // Same for resistance trendline
}
```

### Signal Box with Entry/Stop/Target
```typescript
function drawSignalBox(chart, candleSeries, signal: Signal, candles: Candle[]) {
  // Remove previous signal drawings
  signalSeriesRef.current.forEach(s => {
    try { chart.removeSeries(s) } catch(e) {}
  })
  signalSeriesRef.current = []
  
  if (!signal || signal.type === 'wait') return
  
  // 1. Entry line
  const entryLine = candleSeries.createPriceLine({
    price: signal.entry,
    color: '#ffffff',
    lineWidth: 1,
    lineStyle: LineStyle.Solid,
    axisLabelVisible: true,
    title: '⚡ Entry'
  })
  
  // 2. Stop loss line (red, thick)
  const stopLine = candleSeries.createPriceLine({
    price: signal.stopLoss,
    color: '#ef4444',
    lineWidth: 2,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: `🛑 Stop ${signal.type === 'bullish' ? '-' : '+'}${Math.abs(((signal.stopLoss - signal.entry) / signal.entry) * 100).toFixed(1)}%`
  })
  
  // 3. Target line (green, thick)
  const targetLine = candleSeries.createPriceLine({
    price: signal.target,
    color: '#22c55e',
    lineWidth: 2,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: `🎯 Target +${Math.abs(((signal.target - signal.entry) / signal.entry) * 100).toFixed(1)}%`
  })
  
  // 4. Baseline series for green/red zone visualization
  // BaselineSeries fills above/below a base price automatically
  const baseValue = signal.entry
  const baselineSeries = chart.addBaselineSeries({
    baseValue: { type: 'price', price: baseValue },
    topLineColor: 'rgba(34, 197, 94, 0.0)',
    topFillColor1: 'rgba(34, 197, 94, 0.15)',
    topFillColor2: 'rgba(34, 197, 94, 0.03)',
    bottomLineColor: 'rgba(239, 68, 68, 0.0)',
    bottomFillColor1: 'rgba(239, 68, 68, 0.03)',
    bottomFillColor2: 'rgba(239, 68, 68, 0.15)',
    lineWidth: 0,
    crosshairMarkerVisible: false,
    lastValueVisible: false,
    priceLineVisible: false,
  })
  
  // Set baseline data: value is the extreme of the trade
  // For LONG: show from stop (bottom) to target (top)
  // We show a flat line at target to fill the zone up to target
  const extremeValue = signal.type === 'bullish' ? signal.target : signal.stopLoss
  baselineSeries.setData(candles.map(c => ({
    time: c.time,
    value: extremeValue
  })))
  
  signalSeriesRef.current.push(baselineSeries)
  
  // 5. Arrow marker at signal candle
  const signalCandle = candles[candles.length - 1]
  candleSeries.setMarkers([{
    time: signalCandle.time,
    position: signal.type === 'bullish' ? 'belowBar' : 'aboveBar',
    color: signal.type === 'bullish' ? '#22c55e' : '#ef4444',
    shape: signal.type === 'bullish' ? 'arrowUp' : 'arrowDown',
    text: `${signal.type === 'bullish' ? 'LONG' : 'SHORT'} ${signal.confidence}%`,
    size: 2
  }])
}
```

---

## PART 6: BACKTESTING — CORRECT METHODOLOGY

### Walk-Forward Backtest
```typescript
async function runBacktest(params: BacktestParams): Promise<BacktestResult> {
  const candles = await fetchHistoricalCandles(
    params.symbol, params.interval, 
    params.startDate, params.endDate
  )
  
  const signals: SignalResult[] = []
  const WARMUP = 100  // candles needed before detection starts
  const FORWARD_WINDOW = 100  // candles to check for outcome
  
  for (let i = WARMUP; i < candles.length - FORWARD_WINDOW; i++) {
    const window = candles.slice(i - WARMUP, i)
    const currentPrice = window[window.length - 1].close
    
    // Run pattern detection on this window
    const patterns = runAllPatterns(window)
    const signal = generateSignal(patterns, calcIndicators(window), currentPrice, calcATR(window))
    
    if (!signal || signal.type === 'wait') continue
    
    // Check outcome in next FORWARD_WINDOW candles
    const future = candles.slice(i, i + FORWARD_WINDOW)
    let outcome: 'win' | 'loss' | 'pending' = 'pending'
    let exitCandle = -1
    let pnlPercent = 0
    
    for (let j = 0; j < future.length; j++) {
      const c = future[j]
      
      if (signal.type === 'bullish') {
        if (c.high >= signal.target) {
          outcome = 'win'
          pnlPercent = ((signal.target - signal.entry) / signal.entry) * 100
          exitCandle = j
          break
        }
        if (c.low <= signal.stopLoss) {
          outcome = 'loss'
          pnlPercent = ((signal.stopLoss - signal.entry) / signal.entry) * 100
          exitCandle = j
          break
        }
      } else {
        if (c.low <= signal.target) {
          outcome = 'win'
          pnlPercent = ((signal.entry - signal.target) / signal.entry) * 100
          exitCandle = j
          break
        }
        if (c.high >= signal.stopLoss) {
          outcome = 'loss'
          pnlPercent = ((signal.entry - signal.stopLoss) / signal.entry) * 100
          exitCandle = j
          break
        }
      }
    }
    
    signals.push({
      timestamp: candles[i].time,
      pattern: signal.patternName,
      type: signal.type,
      entry: signal.entry,
      target: signal.target,
      stopLoss: signal.stopLoss,
      riskReward: signal.riskReward,
      confidence: signal.confidence,
      outcome,
      pnlPercent: parseFloat(pnlPercent.toFixed(2)),
      candlesToExit: exitCandle
    })
    
    // Skip forward to avoid overlapping signals
    i += Math.max(exitCandle, 5)
  }
  
  const wins = signals.filter(s => s.outcome === 'win')
  const losses = signals.filter(s => s.outcome === 'loss')
  const winRate = signals.length > 0 
    ? (wins.length / signals.length * 100).toFixed(1) 
    : '0'
  
  const avgGain = wins.length > 0
    ? wins.reduce((a,s) => a + s.pnlPercent, 0) / wins.length
    : 0
  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((a,s) => a + s.pnlPercent, 0) / losses.length)
    : 0
  
  const profitFactor = avgLoss > 0 
    ? (wins.length * avgGain) / (losses.length * avgLoss)
    : 0
  
  return {
    totalSignals: signals.length,
    wins: wins.length,
    losses: losses.length,
    winRate: parseFloat(winRate),
    avgGain: parseFloat(avgGain.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    signals,
    equityCurve: buildEquityCurve(signals)
  }
}

function buildEquityCurve(signals: SignalResult[]): number[] {
  let equity = 10000  // start with $10,000 paper
  const curve = [equity]
  
  signals.forEach(s => {
    if (s.outcome === 'win') {
      equity *= (1 + s.pnlPercent / 100)
    } else if (s.outcome === 'loss') {
      equity *= (1 + s.pnlPercent / 100)  // pnlPercent is negative for losses
    }
    curve.push(parseFloat(equity.toFixed(2)))
  })
  
  return curve
}
```

---

## PART 7: COMMON BUGS — CHECK THESE FIRST

When anything in the trading app is wrong, check in this order:

### Bug Checklist
```
□ S/R levels above/below price?
  → Run validateSRLevels() after every detection

□ Volume showing 0.0x or NaN?
  → Check Binance parse: volume is k[5] (REST) or k.v (WebSocket)
  → Make sure parseFloat() is called, not just indexing

□ Trendlines going to $0 or infinity?
  → Add bounds check: value must be within 50% of current price

□ Pattern confidence always 90%?
  → Confidence must vary. Add penalty for:
     - Low volume confirmation (-10 to -20)
     - Imperfect peak/trough match (-5 per 0.5% difference)
     - Counter-trend signal (-10)

□ Signal firing every minute?
  → Check: only run on closed candles (isClosed === true)
  → Add minimum time between signals (5 min intraday, 4h swing)

□ Chart not updating live candle?
  → Use candleSeries.update() not setData() for live ticks
  → setData() only on symbol/interval change

□ Entry, stop, target lines disappearing?
  → createPriceLine() lines persist automatically
  → If disappearing, chart is being recreated — store chart in ref

□ R:R ratio wrong?
  → R:R = reward / risk (not the other way around)
  → Risk = |entry - stopLoss|
  → Reward = |target - entry|
  → A 1:3 R:R means risk 1, gain 3

□ EMA lines not matching price scale?
  → EMA array length must match closes array length
  → Seed EMA with SMA of first {period} values

□ RSI stuck at 50?
  → Need at least period+1 closes (15 for RSI-14)
  → Check avgLoss is not 0 (divide by zero)

□ BaselineSeries not showing zones?  
  → Must import BaselineSeries from lightweight-charts v4+
  → baseValue must be { type: 'price', price: number }
  → Set data with at least 2 points spanning full time range
```

---

## PART 8: QUANTITATIVE RULES — NON-NEGOTIABLE

These rules must be enforced in every signal generated:

```
1. POSITION SIZING
   Never risk more than 2% of account per trade
   Position size = (Account * 0.02) / (entry - stopLoss)

2. MINIMUM R:R
   Never show a signal with R:R < 1.5
   Ideal minimum: 1:2
   High confidence minimum: 1:1.5

3. STOP LOSS PLACEMENT
   Long: below nearest support OR entry - (ATR * 1.5), whichever is smaller distance
   Short: above nearest resistance OR entry + (ATR * 1.5), whichever is smaller distance
   Never place stop at round numbers (they get hunted)
   Add a 0.1-0.3% buffer beyond the level

4. TARGET PLACEMENT
   Use measured move from pattern height
   Or next significant resistance (for longs) / support (for shorts)
   Partial target at 1:1 R:R (take 50% off), let rest run

5. SIGNAL INVALIDATION
   Long signal invalidated if: price closes below stop
   Short signal invalidated if: price closes above stop
   Pattern invalidated if: price moves against pattern before breakout > 2x ATR

6. VOLUME FILTER
   Breakout signals require volumeRatio > 1.2 for minimum confidence
   volumeRatio < 0.8 = reduce confidence by 25%
   
7. TREND FILTER
   Only take LONG signals when EMA20 > EMA50 (uptrend)
   Only take SHORT signals when EMA20 < EMA50 (downtrend)
   Counter-trend trades: require >80% confidence, reduce position size by 50%
```

---

## HOW TO USE THIS SKILL

When building or fixing any trading feature:

1. **For S/R bugs**: Go directly to Part 1 — validateSRLevels() must be called
2. **For pattern logic**: Use Part 2 detection functions with the validation wrapper
3. **For indicator bugs**: Check Part 3 implementations against these exact formulas  
4. **For signal generation**: Use Part 4 — only ONE signal, conflict = WAIT
5. **For chart drawing**: Use Part 5 — all refs stored, cleaned up on change
6. **For backtesting**: Use Part 6 walk-forward methodology
7. **For any bug**: Run the Part 7 checklist first before writing new code
8. **For every signal**: Enforce Part 8 quantitative rules without exception
