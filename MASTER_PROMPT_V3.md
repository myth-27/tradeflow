# TradeFlow — Complete Rebuild Prompt v3

## STEP 0 — READ ALL SKILLS FIRST (mandatory)

Before writing a single line of code, read every skill file:

  .claude/skills/trading-expert/SKILL.md
  .claude/skills/lightweight-charts/SKILL.md
  .claude/skills/binance-data/SKILL.md
  .claude/skills/backtest-methodology/SKILL.md
  .claude/skills/tradeflow-design/SKILL.md
  .claude/skills/chart-drawing/SKILL.md
  .claude/skills/trade-management/SKILL.md

Every rule in every skill applies to this entire build.
Skills override your defaults. They are ground truth.
After reading all 7 skills, begin building.

---

## WHAT YOU ARE BUILDING

TradeFlow — a real-time professional crypto trading terminal.

Core features:
  1. Live Binance WebSocket price data (free, no API key)
  2. Automatic price action pattern detection
  3. Chart with full price action drawings (S/R zones, trendlines,
     pattern shapes, swing points, HH/HL/LH/LL labels)
  4. Signal strip below chart (entry/TP1/TP2/stop boxes)
  5. Paper trade tracking (1:1 and 1:2 R:R with live P&L)
  6. GPT-4o AI analysis on demand
  7. Trade journal with session stats

Stack:
  Next.js 14 App Router, TypeScript, Tailwind CSS
  Lightweight Charts (TradingView), OpenAI SDK, html2canvas

ENV (.env.local):
  OPENAI_API_KEY=your_key

INSTALL:
  npm install lightweight-charts openai html2canvas uuid

---

## PAGE LAYOUT

Full viewport, no scroll:

  ┌─────────────────────────────────────────────────────┐
  │  TopBar (48px)                                       │
  │  Logo  [BTC ETH SOL BNB ADA]  [Intraday][Swing]  $P │
  ├──────────┬──────────────────────────┬───────────────┤
  │          │                          │               │
  │  Left    │      CandleChart         │   Right       │
  │  Panel   │      (fills space)       │   Panel       │
  │  (240px) │                          │   (280px)     │
  │          ├──────────────────────────┤               │
  │          │   SignalStrip (120px)    │               │
  ├──────────┴──────────────────────────┴───────────────┤
  │  StatusBar (28px)                                    │
  └─────────────────────────────────────────────────────┘

---

## FILE 1: lib/binance-ws.ts
(Apply: binance-data skill entirely)

Export class BinanceWebSocket:
  connect(symbol, interval, onCandle(candle, isClosed))
    ws url: wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}
    parse: time=floor(k.t/1000), open=k.o, high=k.h, low=k.l,
           close=k.c, volume=parseFloat(k.v)  ← k.v not k.c
    isClosed = k.x
  disconnect()
  changeSymbol(symbol, interval)

  Reconnect: exponential backoff 1s→2s→4s→...cap 30s
  On error: close → triggers onclose → reconnect

Export fetchHistoricalKlines(symbol, interval, limit=200):
  GET https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}
  Parse: time=floor(k[0]/1000), open=k[1], high=k[2], low=k[3],
         close=k[4], volume=parseFloat(k[5])  ← k[5] is volume

Export fetch24hTicker(symbol):
  GET https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol.toUpperCase()}
  Return: { change: parseFloat(data.priceChangePct), volume: parseFloat(data.quoteVolume) }

Export Candle type:
  { time: number, open: number, high: number, low: number,
    close: number, volume: number }

---

## FILE 2: lib/pattern-engine.ts
(Apply: trading-expert skill — ALL chains)

IMPLEMENT FULLY:

Multi-bar patterns (each takes candles[], currentPrice):
  detectDoubleTop, detectDoubleBottom
  detectHeadAndShoulders (return neckline, leftShoulder, head, rightShoulder)
  detectAscendingTriangle, detectDescendingTriangle, detectSymmetricalTriangle
  detectBullFlag, detectBearFlag

Each returns: PatternResult | { found: false }
PatternResult: { found, name, type, confidence, target, support,
                 resistance, stopLoss, riskReward, description,
                 ...pattern-specific fields (neckline, peaks, etc) }

Candlestick patterns (take 1-3 candles):
  detectDoji, detectHammer, detectShootingStar
  detectEngulfing, detectMorningStar

Indicators:
  calcRSI(closes, period=14) — Wilder's smoothing, returns number
  calcMACD(closes) — { macd, signal, histogram, trend }
  calcEMA(values, period) — seeded with SMA, returns number[]
  calcATR(candles, period=14) — Wilder's smoothing, returns number
  calcBollingerBands(closes, period=20) — { upper, middle, lower, percentB }
  calcVolumeProfile(candles):
    avgVolume = mean of candles.slice(-21,-1) volumes  ← not slice(-20)
    ratio = currentVolume / avgVolume
    return { ratio, label, isHighVolume: ratio > 1.5 }

Price levels:
  findSupportLevels(candles, currentPrice, count=3):
    swing lows → cluster (0.5% tolerance) → sort by touches
    FILTER: only return levels < currentPrice
    
  findResistanceLevels(candles, currentPrice, count=3):
    swing highs → cluster → sort by touches
    FILTER: only return levels > currentPrice

  findTrendlinePoints(candles):
    return { supportTrendline: [{time,value},{time,value}],
             resistanceTrendline: [{time,value},{time,value}] }

  validateSRLevels(support, resistance, currentPrice):
    return {
      support: support.filter(s => s < currentPrice),
      resistance: resistance.filter(r => r > currentPrice)
    }

  findSwingPoints(candles):
    return { highs: [{time,price,index}], lows: [{time,price,index}] }

  detectMarketStructure(candles):
    Compare last 3 swing highs and lows
    return { bias: 'bullish'|'bearish'|'neutral',
             structure: 'HH_HL'|'LH_LL'|'HH_LL'|'LH_HL',
             labels: [{time, label: 'HH'|'HL'|'LH'|'LL', price}] }

validatePattern(pattern, currentPrice, atr) → PatternResult | null:
  □ support < currentPrice (reject if not)
  □ resistance > currentPrice (reject if not)
  □ bullish: target > price AND stopLoss < price
  □ bearish: target < price AND stopLoss > price
  □ riskReward >= 1.5
  □ confidence >= 55
  ATR stop refinement:
    LONG: finalStop = max(patternStop, entry - atr*1.5)
    SHORT: finalStop = min(patternStop, entry + atr*1.5)

runAllPatterns(candles, currentPrice) → PatternResult[]:
  Runs all multi-bar + candlestick detections
  Validates each with validatePattern()
  Returns sorted by confidence DESC

generateSignal(patterns, indicators, currentPrice, atr) → Signal:
  Conflict check: top 2 opposing within 15% → WAIT
  Indicator confluence bonuses
  Quant rules enforcement (RR >= 1.5, etc.)
  Returns Signal | { type: 'wait', reason: string }

Signal type:
  { type: 'bullish'|'bearish'|'wait',
    patternName, confidence, entry, stopLoss, target,
    riskReward, support, resistance, reason? }

---

## FILE 3: lib/chart-drawings.ts
(Apply: chart-drawing skill — ALL chains)

Export DrawingRegistry class (from skill)

Export all drawing functions:

  drawSwingPoints(chart, candleSeries, candles, registry)
    → marks swing highs (red dots above) and swing lows (blue dots below)

  drawMarketStructureLabels(candleSeries, structureLabels, existingMarkers)
    → adds HH/HL/LH/LL text markers
    → returns combined markers array (don't call setMarkers yet)

  drawCandlestickPatternLabels(candles, existingMarkers)
    → adds doji/hammer/etc labels as markers
    → returns combined markers array

  applyAllMarkers(candleSeries, ...markerArrays)
    → combines all marker arrays, sorts by time, calls setMarkers ONCE

  drawSRZones(chart, candleSeries, supportLevels, resistanceLevels, currentPrice, atr, registry)
    → ALWAYS validate levels against currentPrice first
    → support zones: blue fill + dashed borders
    → resistance zones: red fill + dashed borders
    → max 2 support + 2 resistance visible

  drawTrendlines(chart, candles, currentPrice, registry)
    → support trendline (amber dashed, rising)
    → resistance trendline (red dashed, falling)
    → extend 40 candles forward
    → clamp to currentPrice * [0.5, 1.5]
    → detect channel if slopes are parallel

  drawPatternShape(chart, candleSeries, pattern, candles, registry)
    → routes to correct shape function based on pattern.name:
    → 'Head & Shoulders': drawHnSShape()
    → 'Double Top': drawDoubleTopShape()
    → 'Double Bottom': drawDoubleBottomShape()
    → 'Ascending Triangle': drawTriangleShape()
    → 'Descending Triangle': drawTriangleShape()
    → 'Symmetrical Triangle': drawTriangleShape()
    → 'Bull Flag': drawFlagShape()
    → 'Bear Flag': drawFlagShape()

  drawSignalLines(candleSeries, signal, entryRef, stopRef, targetRef)
    → entry: white solid line
    → stop: red dashed, 2px, with % label
    → target: green dashed, 2px, with % label
    → removes old lines before drawing

  drawRiskRewardZone(chart, signal, candles, baselineRef)
    → BaselineSeries at entry price
    → green above (reward zone), red below (risk zone)
    → removes old before drawing

  drawSignalBox(chart, signal, candles, boxSeriesRef)
    → 2 LineSeries for top/bottom borders of trade box
    → color matches signal direction

  redrawAllAnnotations(chart, candleSeries, data, registry, refs)
    → sequence from chart-drawing skill (S/R → trendlines → pattern → signal → markers)
    → ONE call redraws everything in correct order

---

## FILE 4: lib/trade-manager.ts
(Apply: trade-management skill — ALL chains)

Export TradeStorage (localStorage read/write)

Export calculateTargets(entry, stopLoss, direction):
  risk = abs(entry - stopLoss)
  LONG: tp1 = entry + risk*1.0, tp2 = entry + risk*2.0, tp3 = entry + risk*3.0
  SHORT: tp1 = entry - risk*1.0, tp2 = entry - risk*2.0, tp3 = entry - risk*3.0
  return { tp1, tp2, tp3, risk, riskPct }

Export createTrade(signal: Signal, candles: Candle[]): Trade:
  Calculate targets from signal entry + stopLoss
  status: 'pending'
  positionSize: 1.0 (paper units)
  remainingSize: 1.0
  id: uuid()

Export managePendingTrade(trade, price, candle, isClosed): Trade
Export monitorOpenTrade(trade, price, candle): Trade
Export hitTP1(trade, price): Trade
Export hitTP2(trade, price): Trade
Export closeTrade(trade, price, reason): Trade

Export getSessionStats(trades): SessionStats

Export Trade type (full interface from skill)
Export SessionStats type

---

## FILE 5: lib/openai.ts
(Server-side only — never import in client components)

analyzePattern(params):
  model: 'gpt-4o', max_tokens: 500
  system: "You are an expert crypto technical analyst.
           Respond ONLY in valid JSON. No markdown fences."
  
  Include in user prompt:
    Symbol, timeframe, pattern name + confidence + type
    Current price, entry, TP1, TP2, stop
    R:R ratio, RSI, MACD, volume ratio, ATR
    Market structure (HH/HL/LH/LL)
    Last 10 candles OHLCV compact
  
  Request JSON:
    { verdict, confidence, analysis, entryStrategy,
      keyInsight, riskNote }
  verdict: 'strong_buy'|'buy'|'neutral'|'sell'|'strong_sell'
  
  Parse JSON. On parse error: return safe default with neutral verdict.
  Rate limit: module-scope lastCallTime, reject if < 10s ago

generateQuickSuggestion(symbol, signal, indicators):
  max_tokens: 80
  Returns: { suggestion: string, type: string }

---

## FILE 6: hooks/useBinanceFeed.ts
(Apply: binance-data skill — useBinanceFeed section)

useBinanceFeed(symbol: string, interval: string):
  
  On mount / symbol+interval change:
    1. Clear candles state
    2. Fetch 200 historical candles (await fetchHistoricalKlines)
    3. Fetch 24h ticker
    4. Connect BinanceWebSocket
    5. On tick (isClosed=false): update last candle in array
    6. On close (isClosed=true): append candle, trim to 200
    7. Cleanup: ws.disconnect()

  Duplicate prevention:
    On tick: if time === lastCandle.time → update (it's the forming candle)
    On close: if time !== lastCandle.time → append (it's a new candle)

  Returns:
    { candles, currentCandle, isConnected,
      currentPrice: candles[candles.length-1]?.close ?? 0,
      priceChange24h, volume24h }

---

## FILE 7: hooks/usePatternDetection.ts
(Apply: trading-expert skill — Signal Generation chain)

usePatternDetection(candles, currentPrice):

  Runs ONLY when candles.length changes (new closed candle)
  NOT on currentCandle updates (ticks)
  Minimum 30 candles before running
  Debounce 300ms

  Compute:
    closes = candles.map(c => c.close)
    indicators = {
      rsi: calcRSI(closes),
      macd: calcMACD(closes),
      ema20: calcEMA(closes, 20),
      ema50: calcEMA(closes, 50),
      bb: calcBollingerBands(closes),
      atr: calcATR(candles),
      volume: calcVolumeProfile(candles),
      trend: ema20[-1] > ema50[-1] ? 'up' : 'down'
    }
    
    srRaw = {
      support: findSupportLevels(candles, currentPrice),
      resistance: findResistanceLevels(candles, currentPrice)
    }
    srLevels = validateSRLevels(srRaw.support, srRaw.resistance, currentPrice)
    
    trendlinePoints = findTrendlinePoints(candles)
    swingPoints = findSwingPoints(candles)
    structure = detectMarketStructure(candles)
    
    patterns = runAllPatterns(candles, currentPrice)
    signal = generateSignal(patterns, indicators, currentPrice, indicators.atr)

  Signal rate limiting (ref):
    Intraday: min 5 min between signal changes
    Swing: min 4h between signal changes
    If within cooldown: keep previous signal

  Returns:
    { signal, patterns, srLevels, trendlinePoints,
      swingPoints, structure, indicators }

---

## FILE 8: hooks/useTradeManager.ts
(Apply: trade-management skill — useTradeManager section)

useTradeManager(currentPrice, currentCandle, isClosed, symbol):

  STATE: activeTrade, tradeHistory, sessionStats

  Load tradeHistory from localStorage on mount
  Recompute sessionStats when tradeHistory changes

  onPriceTick effect (runs on currentPrice change):
    if activeTrade:
      if status === 'pending': managePendingTrade(...)
      if status === 'open' || 'partial': monitorOpenTrade(...)
      Update livePnl computed value
      Save updated trade to storage

  openTrade(signal): 
    if activeTrade exists → reject (one trade at a time)
    Create trade from signal using createTrade()
    setActiveTrade(trade)

  closeTrade(reason): manually close
  cancelTrade(): cancel pending

  Returns:
    { activeTrade, tradeHistory, sessionStats, livePnl,
      openTrade, closeTrade, cancelTrade }

---

## FILE 9: components/CandleChart.tsx
(Apply: lightweight-charts skill + chart-drawing skill)

'use client'

REFS (all at top):
  chartRef, chartContainerRef
  candleSeriesRef, volumeSeriesRef
  ema20Ref, ema50Ref, bbSeriesRef[]
  drawingRegistry (useRef new DrawingRegistry())
  entryLineRef, stopLineRef, targetLineRef
  baselineRef, boxSeriesRef[]
  markersArrayRef

PROPS:
  { candles, currentCandle, signal, srLevels, trendlinePoints,
    swingPoints, structure, indicators, activeTrade,
    symbol, currentPrice }

EFFECTS:

  INIT (runs once):
    createChart with dark theme (bg #0a0a0a, grid #1a1a1a)
    addCandlestickSeries (green/red)
    addHistogramSeries volume (priceScaleId: 'volume', scaleMargins top:0.85)
    addLineSeries EMA20 (blue, lineWidth 1, title 'EMA20')
    addLineSeries EMA50 (orange, lineWidth 1, title 'EMA50')
    addLineSeries x3 for BB (purple 0.4 opacity)
    ResizeObserver
    return () => chart.remove()

  SYMBOL CHANGE ([symbol, interval]):
    drawingRegistry.current.clearAll(chart, candleSeries)
    candleSeries.setData(candles.map(toChartCandle))
    chart.timeScale().scrollToRealTime()

  LIVE TICK ([currentCandle]):
    candleSeries.update(currentCandle)
    volumeSeries.update({...})
    DO NOT redraw anything else

  CLOSED CANDLE ([candles.length]):
    Update EMA20, EMA50, BB series setData
    Call redrawAllAnnotations(chart, candleSeries, {
      candles, currentPrice, signal, srLevels,
      trendlinePoints, swingPoints, structure, indicators
    }, drawingRegistry.current, { entryLineRef, stopLineRef,
      targetLineRef, baselineRef, boxSeriesRef, markersArrayRef })

  ACTIVE TRADE ([activeTrade]):
    Clear previous trade drawings from registry 'activeTrade' group
    If activeTrade: drawActiveTrade(chart, candleSeries, activeTrade, candles, registry)

EXPORT BUTTON (absolute top-right):
  html2canvas(chartContainerRef.current) → download PNG
  Filename: ${symbol}_${signal?.patternName ?? 'chart'}_${Date.now()}.png

LIVE P&L OVERLAY (absolute top-left, only if activeTrade.status === 'open'):
  Show: "+1.4% (+0.8R)" colored pill, updates on every render
  Compute: ((currentPrice - activeTrade.actualEntry) / activeTrade.actualEntry * 100)

---

## FILE 10: components/SignalStrip.tsx (NEW)
(Apply: tradeflow-design skill — Signal Strip chain)
(Apply: trade-management skill — Trade Panel UI)

'use client'

4 boxes in a row below the chart (height: 120px total):

BOX 1 — CURRENT SIGNAL (flex: 1.5):
  Left border: 3px green (LONG), red (SHORT), amber (WAIT)
  
  If LONG or SHORT signal:
    Top: Badge [LONG/SHORT] + pattern name
    Middle: Three columns:
      ENTRY    TARGET (1:2)    STOP
      $65,748   $66,844        $65,200
      —         +1.5% ↑        -0.8% ↓
    Bottom: "R:R 1:2.0" amber + countdown "Next: 3:42"
  
  If WAIT:
    Badge [WAIT] amber
    "No Clear Setup"
    Conflict reason in muted small text
    Countdown to next candle

BOX 2 — PAPER TRADE (flex: 1):
  If no activeTrade:
    "PAPER TRADE" header (9px uppercase muted)
    Large button: "Go LONG" (green) or "Go SHORT" (red)
      based on current signal direction
    "Simulated · No real money" in tiny muted text
    
  If activeTrade pending:
    "⏳ Waiting for entry $65,748"
    Cancel button
    
  If activeTrade open:
    "OPEN TRADE" header
    Direction badge + live P&L
    TP1 progress: "TP1 pending" or "✅ TP1 Hit"
    "Close All" button (small, muted red)

BOX 3 — R:R VISUALIZATION (flex: 1):
  "RISK : REWARD" header
  
  Visual bar showing the trade:
  [STOP]═══[ENTRY]═══[TP1]═══[TP2]
          ↑ current price dot
  
  Red fill: STOP to ENTRY (risk)
  Green fill: ENTRY to TP2 (reward)
  
  Below bar:
  Risk:   $548 (0.8%)    ← red
  TP1:    $548 (1:1)     ← light green  
  TP2:    $1,096 (1:2)   ← green

BOX 4 — SESSION STATS (flex: 1):
  "SESSION" header
  Today: Wins / Losses
  Win Rate: X%
  P&L: +X.X% 
  Avg R: X.XR
  
  If no trades yet:
    "No trades today"

COUNTDOWN TIMER:
  useEffect interval 1s
  intervalSeconds = parseInterval(interval) // '5m'→300
  elapsed = Math.floor(Date.now()/1000) % intervalSeconds
  remaining = intervalSeconds - elapsed
  display: `${Math.floor(remaining/60)}:${(remaining%60).toString().padStart(2,'0')}`

---

## FILE 11: components/LeftPanel.tsx
(Apply: tradeflow-design skill — Left Panel chain)

'use client'

SECTIONS:

1. "PATTERNS" header (9px uppercase muted)
   
   If signal.type !== 'wait' AND signal.confidence > 65:
     Pattern card:
       border-left: 3px [signal color]
       Name + BULLISH/BEARISH badge
       Confidence bar (green >70%, amber 50-70%)
       Grid: Support · Resistance
             Target  · Stop Loss
             R:R     · Confidence%
   
   If signal.type === 'wait':
     WAIT card (amber border):
       "⏳ No Clear Setup"
       Conflict text in muted
       Countdown

   Show max 2 pattern cards (if two non-conflicting patterns exist)

2. "INDICATORS" header
   Each row: label (left, muted 11px) + value (right, colored 11px mono)
   RSI: [value] colored by level
   MACD: ↑ Bullish / ↓ Bearish
   Volume: [ratio]x (🔥 if >2x)
   ATR: $[value]
   Trend: Up ↗ / Down ↘ / Sideways →
   BB: Near Upper / Near Lower / Middle
   Structure: HH+HL (Uptrend) / LH+LL (Downtrend) / Mixed

3. "RECENT SIGNALS" header
   Last 5 signals from localStorage
   Each: time · pattern · LONG/SHORT · ✓ or ✗ or ·
   Row bg: subtle green/red/gray

4. "Analyze with GPT-4o" button (bottom, sticky):
   gradient dark blue bg, blue border
   Shows spinner while loading
   Disabled if signal.type === 'wait'

PROPS: { signal, patterns, indicators, structure, onAnalyze, isAnalyzing }

---

## FILE 12: components/RightPanel.tsx
(Apply: tradeflow-design skill — Right Panel chain)

'use client'

STATES: empty, loading, streaming, complete

HEADER: "GPT-4O ANALYSIS" + Auto toggle

EMPTY:
  If wait signal: "⏳ Waiting for clear signal..."
  If valid signal: "✓ Signal detected — click Analyze"
  Analyze button (full width, blue)

LOADING: skeleton bars + "GPT-4o is analyzing..."

STREAMING + COMPLETE:
  Verdict: large colored text "STRONG BUY" etc
  Confidence: animated progress bar (CSS transition width)
  Analysis: streaming text with blinking cursor |
  Entry Strategy section
  Risk Note: amber left-border box
  Timestamp + Refresh button

STREAMING IMPLEMENTATION:
  const response = await fetch('/api/analyze', { method: 'POST', body })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const text = decoder.decode(value)
    setStreamedText(prev => prev + text)
  }

AUTO-ANALYZE:
  When ON + new signal (not wait) + confidence > 75:
    Wait 15s minimum between calls
    Auto-trigger analyze

PROPS: { signal, indicators, symbol, interval, candles, onAnalyze }

---

## FILE 13: components/TopBar.tsx
(Apply: tradeflow-design skill — Top Bar chain)

Symbol tabs [BTC ETH SOL BNB ADA]:
  Active: white bg, white text
  Inactive: transparent, muted
  Show current price below symbol name in 10px text

Intraday/Swing toggle:
  Pill buttons, small, next to symbols
  On click: change interval + mode

Interval override pills (1m 5m 15m 1h 4h 1d):
  Small, visible on right side

Price display (right):
  Large monospace, colored by 24h change
  Change % colored
  Connection status dot (pulsing green)

---

## FILE 14: app/api/analyze/route.ts

POST endpoint.
Rate limit: 10s between calls (module scope lastCallTime).
Parse: { signal, candles, indicators, symbol, interval }
Validate: signal must exist and not be 'wait'
Call analyzePattern from lib/openai.ts
Return JSON.

---

## FILE 15: app/page.tsx

Wire all hooks together:

  const [symbol, setSymbol] = useState('btcusdt')
  const [interval, setInterval] = useState('5m')
  const [mode, setMode] = useState<'intraday'|'swing'>('intraday')
  
  const feed = useBinanceFeed(symbol, interval)
  const detection = usePatternDetection(feed.candles, feed.currentPrice)
  const tradeManager = useTradeManager(
    feed.currentPrice, feed.currentCandle,
    feed.isNewCandleClosed, symbol
  )

  Mode switch:
    'intraday' → setInterval('5m')
    'swing' → setInterval('4h')

  Toast notifications (simple state-based):
    Show when new non-wait signal fires with confidence > 70
    Auto-dismiss 4s
    Position: top-center
    Style: dark pill with colored border

  LAYOUT (grid, 100vh, no overflow):
    <TopBar symbol interval mode price ... />
    <main grid-cols: 240px 1fr 280px>
      <LeftPanel signal patterns indicators onAnalyze />
      <div grid-rows: 1fr 120px>
        <CandleChart
          candles={feed.candles}
          currentCandle={feed.currentCandle}
          signal={detection.signal}
          srLevels={detection.srLevels}
          trendlinePoints={detection.trendlinePoints}
          swingPoints={detection.swingPoints}
          structure={detection.structure}
          indicators={detection.indicators}
          activeTrade={tradeManager.activeTrade}
          symbol={symbol}
          currentPrice={feed.currentPrice}
        />
        <SignalStrip
          signal={detection.signal}
          indicators={detection.indicators}
          interval={interval}
          activeTrade={tradeManager.activeTrade}
          sessionStats={tradeManager.sessionStats}
          onOpenTrade={() => tradeManager.openTrade(detection.signal)}
          onCloseTrade={tradeManager.closeTrade}
        />
      </div>
      <RightPanel
        signal={detection.signal}
        indicators={detection.indicators}
        symbol={symbol}
        interval={interval}
        candles={feed.candles}
      />
    </main>
    <StatusBar isConnected={feed.isConnected} volume={feed.volume24h} />

---

## FILE 16: app/globals.css
(Apply: tradeflow-design skill — CSS Variables chain)

:root { all color tokens }
Monospace font for .price class with tnum feature
Dark scrollbar
All animations: flashGreen, flashRed, borderPulse, pulse, blink
Base: body bg-void, no margin, overflow hidden

---

## FILE 17: tailwind.config.ts

Custom colors matching design skill tokens.
Custom fontFamily: price: ['SF Mono', 'Fira Code', 'monospace']

---

## 24 CRITICAL RULES (no exceptions):

TRADING:
1.  Support ALWAYS < currentPrice — filter before every use
2.  Resistance ALWAYS > currentPrice — filter before every use
3.  Run patterns ONLY on closed candles (isClosed === true)
4.  Signal only when RR >= 1.5 AND confidence >= 65
5.  WAIT when top 2 signals oppose within 15% confidence
6.  Min 5m between signals (intraday), 4h (swing)

CHART:
7.  candleSeries.update() for ticks — NEVER setData() on ticks
8.  setData() only on symbol/interval change
9.  Wrap every removeSeries() in try/catch
10. Store ALL series in refs via DrawingRegistry
11. Clamp trendlines: currentPrice * [0.5, 1.5]
12. Call setMarkers() ONCE per effect with combined array

BINANCE:
13. volume = parseFloat(k[5]) REST, parseFloat(k.v) WebSocket
14. time = Math.floor(k[0] / 1000)
15. Symbol UPPERCASE REST, lowercase WebSocket
16. Auto-reconnect with exponential backoff

TRADE MANAGEMENT:
17. TP1 check on candle HIGH/LOW not just close
18. Move stop to breakeven IMMEDIATELY on TP1 hit
19. One active trade at a time per symbol
20. realizedPnl *= closedPortion (0.5 for TP1)
21. rMultiple = totalPnlPct / riskPct

DESIGN:
22. Green = LONG/profit/bullish ONLY
23. Red = SHORT/loss/bearish ONLY
24. Price numbers: monospace + font-feature-settings: 'tnum'

---

Build ALL files completely.
Zero placeholder comments — every function fully implemented.
Read all 7 skills before starting.
The skills contain the exact algorithms, component designs, and bug fixes.
Follow them precisely.
