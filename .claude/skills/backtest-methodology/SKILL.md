---
name: backtest-methodology
description: Quantitative backtesting methodology for trading strategies — lookahead bias prevention, walk-forward signal detection loops, performance metrics (win rate, profit factor, Sharpe ratio, max drawdown), equity curves, and backtest UI/API design. Load this skill whenever building, debugging, or improving backtesting features — runBacktest, BacktestPanel, equity curve, win rate calculations, or signal history analysis.
---

## Role

You are a quantitative research engineer specializing in systematic trading strategy validation. You know how to build statistically valid backtests, avoid lookahead bias, and produce meaningful performance metrics. You never let a bad methodology slip through.

---

## Chain: Data Preparation

### Step 1 — Fetch Full History
```
TOOL: fetchHistoricalCandles(symbol, interval, startDate, endDate)
SOURCE: Binance REST API (free, no auth)
  GET https://api.binance.com/api/v3/klines
  Paginate 1000 candles per request
  Wait 100ms between requests (rate limit safety)
  Parse: time=k[0]/1000, open=k[1], high=k[2], low=k[3],
         close=k[4], volume=k[5]  ← k[5] not k[4]

VALIDATE:
  Remove candles with volume === 0 (exchange halt)
  Remove candles where high < low (data error)
  Sort by time ASC
  Check no gaps > 3x expected candle width

WARMUP PERIOD:
  First 100 candles = warmup (needed for EMA50, ATR, etc.)
  Start detecting signals at candle index 100
```

### Step 2 — Lookahead Bias Prevention
```
RULE: CRITICAL — the most common backtest bug

At candle index i, you can ONLY access candles[0..i]
NEVER access candles[i+1] or later when generating signal

WRONG:
  const signal = detectPattern(candles)  // uses full array
  
RIGHT:
  for (let i = 100; i < candles.length; i++) {
    const window = candles.slice(0, i)  // only past candles
    const signal = detectPattern(window)
    // then check outcome in candles[i+1 .. i+FORWARD]
  }

ALSO WRONG: Using future volume to confirm a breakout
ALSO WRONG: Using current close to detect a pattern when
            that close hasn't happened yet at bar i
```

---

## Chain: Signal Detection Loop

### Walk-Forward Engine
```
TOOL: runBacktestEngine(candles, config)
CONFIG:
  { minConfidence: 65, forwardWindow: 100, stepSize: 1 }

ALGORITHM:
  signals = []
  i = WARMUP (100)
  
  while i < candles.length - forwardWindow:
    window = candles.slice(0, i)  // only look back
    currentPrice = window[window.length-1].close
    
    // Detect
    patterns = runAllPatterns(window)
    signal = generateSignal(patterns, calcIndicators(window), currentPrice)
    
    // Skip if no valid signal
    if !signal or signal.type === 'wait':
      i += stepSize
      continue
    
    // Skip if below confidence threshold
    if signal.confidence < minConfidence:
      i += stepSize
      continue
    
    // Check outcome in future candles (these are ALLOWED — they're the outcome)
    future = candles.slice(i, i + forwardWindow)
    outcome = checkOutcome(signal, future)
    
    signals.push({ ...signal, ...outcome, signalTime: candles[i].time })
    
    // Jump forward past this trade to avoid overlapping signals
    const skip = Math.max(outcome.exitBar ?? 5, 5)
    i += skip
  
  return signals
```

### Outcome Checker
```
TOOL: checkOutcome(signal, futureCandles)
LOGIC:
  for bar j in futureCandles:
    c = futureCandles[j]
    
    if signal.type === 'bullish':
      if c.high >= signal.target:
        return { outcome: 'win', exitBar: j,
                 pnlPct: (signal.target-signal.entry)/signal.entry*100,
                 maxFavorable: signal.target }
      if c.low <= signal.stopLoss:
        return { outcome: 'loss', exitBar: j,
                 pnlPct: (signal.stopLoss-signal.entry)/signal.entry*100,
                 maxAdverse: signal.stopLoss }
    
    if signal.type === 'bearish':
      if c.low <= signal.target:
        return { outcome: 'win', exitBar: j,
                 pnlPct: (signal.entry-signal.target)/signal.entry*100 }
      if c.high >= signal.stopLoss:
        return { outcome: 'loss', exitBar: j,
                 pnlPct: (signal.entry-signal.stopLoss)/signal.entry*100 }
  
  // No outcome in forwardWindow
  return { outcome: 'expired', exitBar: forwardWindow,
           pnlPct: 0, note: 'neither target nor stop hit' }
```

---

## Chain: Performance Metrics

### Calculate All Stats
```
TOOL: calcBacktestStats(signals)

wins = signals.filter(s => s.outcome === 'win')
losses = signals.filter(s => s.outcome === 'loss')
expired = signals.filter(s => s.outcome === 'expired')
completed = [...wins, ...losses]

METRICS:
  totalSignals: signals.length
  wins: wins.length
  losses: losses.length
  winRate: wins.length / completed.length * 100  (exclude expired)
  
  avgGain: mean(wins.map(s => s.pnlPct))
  avgLoss: mean(losses.map(s => abs(s.pnlPct)))
  
  profitFactor: (wins.length * avgGain) / (losses.length * avgLoss)
    profitFactor > 1.5 = good
    profitFactor > 2.0 = excellent
    profitFactor < 1.0 = losing strategy
  
  avgRR: mean(completed.map(s => abs(s.pnlPct / riskPct)))
  
  maxDrawdown: calcMaxDrawdown(equityCurve)
  
  sharpeRatio: calcSharpe(signals)  // if > 1.0 = good
  
  avgBarsToExit: mean(completed.map(s => s.exitBar))
  
  bestPattern: patternWithHighestWinRate(signals)
  worstPattern: patternWithLowestWinRate(signals)

BY PATTERN BREAKDOWN:
  const byPattern = {}
  signals.forEach(s => {
    if (!byPattern[s.patternName]) byPattern[s.patternName] = []
    byPattern[s.patternName].push(s)
  })
  // For each: winRate, avgGain, count, profitFactor
```

### Equity Curve
```
TOOL: buildEquityCurve(signals, startCapital=10000)
  let equity = startCapital
  const curve = [{ time: signals[0]?.signalTime, value: equity }]
  
  signals.forEach(s => {
    if (s.outcome === 'win') {
      equity *= (1 + s.pnlPct / 100)
    } else if (s.outcome === 'loss') {
      equity *= (1 + s.pnlPct / 100)  // pnlPct is negative for loss
    }
    // expired: no change to equity
    curve.push({ time: s.signalTime, value: parseFloat(equity.toFixed(2)) })
  })
  return curve

DRAWDOWN:
  let peak = startCapital
  const dd = []
  curve.forEach(point => {
    if (point.value > peak) peak = point.value
    dd.push(((point.value - peak) / peak) * 100)
  })
  maxDrawdown = Math.min(...dd)  // most negative = worst drawdown
```

### Sharpe Ratio
```
TOOL: calcSharpe(signals, riskFreeRate=0)
  returns = signals
    .filter(s => s.outcome !== 'expired')
    .map(s => s.pnlPct / 100)
  
  mean = returns.reduce((a,b) => a+b, 0) / returns.length
  std = Math.sqrt(returns.reduce((a,b) => a + Math.pow(b-mean,2), 0) / returns.length)
  
  annualFactor = Math.sqrt(252)  // daily signals
  sharpe = ((mean - riskFreeRate) / std) * annualFactor

  > 2.0 = excellent
  1.0-2.0 = good
  0.5-1.0 = acceptable
  < 0.5 = poor
```

---

## Chain: Backtest UI

### Progress Streaming
```
TOOL: streamBacktestProgress(route handler)
USE: Server-Sent Events for real-time progress

In /api/backtest/route.ts:
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      runBacktestWithProgress(params, (progress) => {
        const data = `data: ${JSON.stringify(progress)}\n\n`
        controller.enqueue(encoder.encode(data))
      }).then(result => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, result })}\n\n`))
        controller.close()
      })
    }
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' }
  })

PROGRESS OBJECT:
  { processed: number, total: number, pct: number, 
    currentSignals: number, latestSignal?: string }
```

### Results Display Requirements
```
SHOW:
  Summary cards row:
    Win Rate %  |  Total Signals  |  Profit Factor  |  Max Drawdown  |  Avg R:R

  Equity curve chart (Line chart, Chart.js):
    x-axis: signal timestamps
    y-axis: portfolio value
    Green line if positive, red if overall negative

  Pattern breakdown table:
    Pattern | Signals | Win Rate | Avg Gain | Profit Factor
    Sorted by profit factor DESC

  Signal log table (paginated, 20 per page):
    Date | Symbol | Pattern | Type | Entry | Target | Stop | R:R | Outcome | P&L%
    Row color: green bg for wins, red bg for losses, gray for expired

  Export CSV button:
    Headers: date,symbol,pattern,type,entry,target,stop,rr,outcome,pnl
    Trigger download with Blob URL
```

---

## Common Bugs
```
BUG: Win rate is 95%+ (unrealistically high)
FIX: Check for lookahead bias — are you using future candles in detection?
     Check: window = candles.slice(0, i) in the loop

BUG: All signals are wins because target always hit
FIX: Check target is not set to a tiny value relative to stop
     Print sample signals to verify RR makes sense

BUG: Backtest runs forever
FIX: Add stepSize jump after each signal: i += max(exitBar, 5)
     Cap total iterations: if signals.length > 10000 break

BUG: Equity curve goes below zero
FIX: Cap loss per trade: equity can't go below equity * 0.98
     (represents stop loss actually being honored)

BUG: profitFactor is Infinity
FIX: Check losses.length === 0 → return 'N/A' not Infinity

BUG: Different results each run
FIX: Ensure no random elements in pattern detection
     Ensure sorted candle array (sort by time before loop)
```
