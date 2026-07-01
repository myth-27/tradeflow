---
name: trade-management
description: Trade lifecycle and risk-management expert — paper trade state machine (pending/open/partial/closed), TP1/TP2 partial exits with breakeven stop moves, live P&L and R-multiple calculation, trade journal persistence, and trade panel UI. Load this skill whenever working on trade tracking, R:R ratios, position management, partial exits, stop loss/take profit logic, open trades, or trade history.
---

## Role

You are a professional risk manager and systematic trader. You implement position management exactly as real traders do — scaling out at 1:1, letting runners go to 1:2, moving stops to breakeven, tracking live P&L, and keeping a detailed trade journal. Every trade is tracked from entry to exit with full accountability.

---

## Chain: Trade Lifecycle

### Trade States
```
type TradeStatus = 
  'pending'    // Signal fired, waiting for entry price to be hit
  'open'       // Entry hit, trade is live
  'partial'    // Partial position closed at TP1
  'closed'     // Fully closed (stop hit or TP2 hit)
  'expired'    // Signal expired without entry being hit (within 3 candles)
  'cancelled'  // Manually cancelled before entry

type TradeDirection = 'long' | 'short'

interface Trade {
  id: string                    // uuid
  symbol: string                // 'btcusdt'
  direction: TradeDirection
  status: TradeStatus
  
  // Entry
  entryPrice: number            // planned entry
  actualEntry: number | null    // actual fill price
  entryTime: number | null      // unix timestamp
  
  // Risk Management
  stopLoss: number              // initial stop
  currentStop: number           // moving stop (breakeven, trail)
  
  // Targets — real traders use multiple targets
  tp1: number                   // 1:1 R:R — take 50% here
  tp2: number                   // 1:2 R:R — take remaining 50% here
  tp3?: number                  // 1:3 R:R — optional runner target
  
  // Position
  positionSize: number          // units (or % of account)
  remainingSize: number         // after partial exits
  
  // Results
  tp1Hit: boolean
  tp2Hit: boolean
  tp1HitTime: number | null
  tp2HitTime: number | null
  stopHitTime: number | null
  actualExit: number | null
  
  // P&L
  realizedPnlPct: number        // from closed portions
  unrealizedPnlPct: number      // on remaining position
  totalPnlPct: number           // combined
  rMultiple: number             // actual outcome in R (1R = 1x risk)
  
  // Meta
  patternName: string
  confidence: number
  timeframe: string
  signalTime: number
  notes: string
}
```

---

## Chain: Trade Entry Logic

### Entry Management
```
TOOL: managePendingTrade(trade, currentPrice, currentCandle, isClosed)

PENDING → OPEN transition:
  LONG: if currentCandle.high >= trade.entryPrice:
    trade.status = 'open'
    trade.actualEntry = trade.entryPrice  // assume fill at planned price
    trade.entryTime = currentCandle.time
  
  SHORT: if currentCandle.low <= trade.entryPrice:
    trade.status = 'open'
    trade.actualEntry = trade.entryPrice
    trade.entryTime = currentCandle.time

EXPIRY CHECK (on each candle close):
  if isClosed AND trade.status === 'pending':
    candlesSinceSignal = (currentCandle.time - trade.signalTime) / candleWidth
    if candlesSinceSignal > 3:
      trade.status = 'expired'
      log: "Trade expired — price never reached entry"

SLIPPAGE SIMULATION (optional for realism):
  actualEntry = entryPrice * (1 + (direction === 'long' ? 0.001 : -0.001))
  // 0.1% slippage model for crypto
```

### Risk:Reward Target Calculation
```
TOOL: calculateTargets(entry, stopLoss, direction, customRR?)

risk = Math.abs(entry - stopLoss)

FOR LONG:
  tp1 = entry + risk * 1.0   // 1:1 R:R (breakeven secured)
  tp2 = entry + risk * 2.0   // 1:2 R:R (standard target)
  tp3 = entry + risk * 3.0   // 1:3 R:R (runner target)

FOR SHORT:
  tp1 = entry - risk * 1.0
  tp2 = entry - risk * 2.0
  tp3 = entry - risk * 3.0

CUSTOM R:R:
  if customRR provided (e.g. 1.5):
    tp1 = entry ± risk * 1.0
    tp2 = entry ± risk * customRR

DISPLAY FORMAT:
  "Risk: $142 | TP1: 1:1 ($65,862) | TP2: 1:2 ($66,004)"
  Show percentage: "TP1: +0.7% | TP2: +1.4%"

RETURN:
  { tp1, tp2, tp3, risk, riskPct: risk/entry*100 }
```

---

## Chain: Live Trade Monitoring

### Price Check on Every Tick
```
TOOL: monitorOpenTrade(trade, currentPrice, currentCandle)
Run this on EVERY price tick for open trades

STOP LOSS CHECK (immediate — can trigger on any tick):
  LONG: if currentPrice <= trade.currentStop:
    closeTrade(trade, currentPrice, 'stop')
    
  SHORT: if currentPrice >= trade.currentStop:
    closeTrade(trade, currentPrice, 'stop')

TP1 CHECK (on tick):
  if !trade.tp1Hit:
    LONG: if currentPrice >= trade.tp1:
      hitTP1(trade, currentPrice)
    SHORT: if currentPrice <= trade.tp1:
      hitTP1(trade, currentPrice)

TP2 CHECK (on tick):
  if trade.tp1Hit AND !trade.tp2Hit:
    LONG: if currentPrice >= trade.tp2:
      hitTP2(trade, currentPrice)
    SHORT: if currentPrice <= trade.tp2:
      hitTP2(trade, currentPrice)

UPDATE LIVE P&L (every tick):
  if trade.direction === 'long':
    trade.unrealizedPnlPct = 
      ((currentPrice - trade.actualEntry) / trade.actualEntry) * 100 * (trade.remainingSize / trade.positionSize)
  else:
    trade.unrealizedPnlPct = 
      ((trade.actualEntry - currentPrice) / trade.actualEntry) * 100 * (trade.remainingSize / trade.positionSize)
  
  trade.totalPnlPct = trade.realizedPnlPct + trade.unrealizedPnlPct
```

### TP1 Hit — Partial Exit + Move Stop to Breakeven
```
TOOL: hitTP1(trade, price)

This is the most important trade management step.
Real traders ALWAYS move stop to breakeven when TP1 is hit.

trade.tp1Hit = true
trade.tp1HitTime = Date.now()
trade.status = 'partial'

// Close 50% of position at TP1
closedPortion = 0.5
pnlOnClosed = ((price - trade.actualEntry) / trade.actualEntry) * 100 * closedPortion
trade.realizedPnlPct += pnlOnClosed
trade.remainingSize = trade.positionSize * 0.5

// MOVE STOP TO BREAKEVEN — this is critical
// Now the trade is risk-free on remaining 50%
trade.currentStop = trade.actualEntry  
// Add small buffer so stop isn't at exact entry:
if trade.direction === 'long':
  trade.currentStop = trade.actualEntry * 0.9995  // 0.05% below entry
else:
  trade.currentStop = trade.actualEntry * 1.0005  // 0.05% above entry

log event: {
  type: 'TP1_HIT',
  price, trade.tp1,
  message: 'TP1 hit — 50% closed, stop moved to breakeven',
  pnl: pnlOnClosed
}

// Notify user with toast:
showToast(`✅ TP1 Hit! 50% closed at ${price}. Stop moved to breakeven.`, 'success')
```

### TP2 Hit — Full Exit
```
TOOL: hitTP2(trade, price)

trade.tp2Hit = true
trade.tp2HitTime = Date.now()

closedPortion = trade.remainingSize / trade.positionSize
pnlOnClosed = ((price - trade.actualEntry) / trade.actualEntry) * 100 * closedPortion
trade.realizedPnlPct += pnlOnClosed
trade.remainingSize = 0
trade.actualExit = price
trade.status = 'closed'

// Calculate final R multiple
totalRisk = Math.abs(trade.actualEntry - trade.stopLoss) / trade.actualEntry
trade.rMultiple = trade.realizedPnlPct / (totalRisk * 100)

log event: {
  type: 'TP2_HIT',
  message: 'Full target reached — trade closed',
  totalPnl: trade.realizedPnlPct,
  rMultiple: trade.rMultiple
}

showToast(`🎯 Target Hit! Trade closed +${trade.realizedPnlPct.toFixed(2)}% (${trade.rMultiple.toFixed(1)}R)`, 'success')
```

### Stop Hit
```
TOOL: closeTrade(trade, price, reason: 'stop' | 'manual')

// Calculate P&L on remaining position
closedPortion = trade.remainingSize / trade.positionSize
if trade.direction === 'long':
  pnlOnClosed = ((price - trade.actualEntry) / trade.actualEntry) * 100 * closedPortion
else:
  pnlOnClosed = ((trade.actualEntry - price) / trade.actualEntry) * 100 * closedPortion

trade.realizedPnlPct += pnlOnClosed
trade.remainingSize = 0
trade.actualExit = price
trade.stopHitTime = Date.now()
trade.status = 'closed'

totalRisk = Math.abs(trade.actualEntry - trade.stopLoss) / trade.actualEntry
trade.rMultiple = trade.realizedPnlPct / (totalRisk * 100)

if reason === 'stop':
  if trade.tp1Hit:
    // Breakeven stop — no loss, small win from TP1
    showToast(`⚡ Stopped at breakeven. TP1 secured +${trade.realizedPnlPct.toFixed(2)}%`, 'info')
  else:
    // Full loss
    showToast(`🛑 Stop Hit. Loss: ${trade.realizedPnlPct.toFixed(2)}% (${trade.rMultiple.toFixed(1)}R)`, 'error')
```

---

## Chain: Trade Visualization on Chart

### Drawing the Active Trade on Chart
```
TOOL: drawActiveTrade(chart, candleSeries, trade, candles, registry)

ONLY draw if trade.status === 'open' or 'partial'

ENTRY LINE:
  candleSeries.createPriceLine({
    price: trade.actualEntry,
    color: '#ffffff',
    lineWidth: 1,
    lineStyle: LineStyle.Solid,
    axisLabelVisible: true,
    title: `📍 Entry $${trade.actualEntry.toFixed(0)}`,
  })

CURRENT STOP (moves to breakeven after TP1):
  const stopColor = trade.tp1Hit ? '#888888' : '#ef4444'
  const stopTitle = trade.tp1Hit 
    ? `⚡ Breakeven $${trade.currentStop.toFixed(0)}`
    : `🛑 Stop $${trade.currentStop.toFixed(0)}`
  
  candleSeries.createPriceLine({
    price: trade.currentStop,
    color: stopColor,
    lineWidth: 2,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: stopTitle,
  })

TP1 LINE:
  candleSeries.createPriceLine({
    price: trade.tp1,
    color: trade.tp1Hit ? 'rgba(34,197,94,0.4)' : '#22c55e',
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: trade.tp1Hit 
      ? `✅ TP1 Hit $${trade.tp1.toFixed(0)}`
      : `🎯 TP1 (1:1) $${trade.tp1.toFixed(0)}`,
  })

TP2 LINE:
  candleSeries.createPriceLine({
    price: trade.tp2,
    color: '#22c55e',
    lineWidth: 2,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: `🎯 TP2 (1:2) $${trade.tp2.toFixed(0)}`,
  })

RISK ZONE (entry to stop — red fill):
  BaselineSeries with baseValue at entry
  bottomFillColor1: 'rgba(239,68,68,0.15)'  ← risk
  topFillColor1: 'rgba(34,197,94,0.10)'      ← reward

R:R RATIO LABEL on chart:
  Show as a text overlay (absolute positioned div over chart):
    position: absolute, right: 80px, calculated top position
    "Risk: $142 (0.9%)"   in red
    "TP1:  $142 (1:1)"    in green
    "TP2:  $284 (1:2)"    in green
    Small monospace font, dark bg pill

LIVE P&L BADGE:
  Position: absolute, top-left of chart area
  Shows real-time P&L as price moves:
    "+$234 (+1.4%)" in green pill
    "-$89 (-0.5%)" in red pill
  Updates on every tick
  Font: 13px monospace, bold
```

---

## Chain: Trade Journal & History

### Persistence
```
TOOL: TradeStorage

Storage key: 'tradeflow_journal'
Format: Trade[] JSON array

saveTradeJournal(trades: Trade[]):
  localStorage.setItem('tradeflow_journal', JSON.stringify(trades))

loadTradeJournal(): Trade[]:
  const raw = localStorage.getItem('tradeflow_journal')
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }

updateTrade(trade: Trade):
  const journal = loadTradeJournal()
  const idx = journal.findIndex(t => t.id === trade.id)
  if (idx >= 0) journal[idx] = trade
  else journal.push(trade)
  saveTradeJournal(journal)

getSessionStats(): SessionStats:
  const today = trades.filter(t => {
    const tradeDate = new Date(t.signalTime * 1000).toDateString()
    return tradeDate === new Date().toDateString()
  })
  const closed = today.filter(t => t.status === 'closed')
  const wins = closed.filter(t => t.totalPnlPct > 0)
  
  return {
    totalTrades: closed.length,
    wins: wins.length,
    losses: closed.length - wins.length,
    winRate: closed.length > 0 ? wins.length / closed.length * 100 : 0,
    totalPnl: closed.reduce((a,t) => a + t.totalPnlPct, 0),
    avgWin: wins.length > 0 ? wins.reduce((a,t) => a + t.totalPnlPct, 0) / wins.length : 0,
    avgLoss: ...,
    avgRMultiple: closed.reduce((a,t) => a + t.rMultiple, 0) / closed.length,
    bestTrade: ...,
    worstTrade: ...,
  }
```

---

## Chain: Trade Panel UI Component

### ActiveTradePanel Component
```
COMPONENT: ActiveTradePanel
Position: overlaid on bottom-right of chart OR in SignalStrip

WHEN NO OPEN TRADE:
  Small box with muted text: "No active trade"
  "Paper Trade" button → opens trade sizing modal

WHEN TRADE IS PENDING:
  Amber pulsing border
  "⏳ PENDING — Waiting for entry"
  Entry target price
  "Cancel" button

WHEN TRADE IS OPEN:
  Border color: green (long) or red (short)
  
  TOP ROW:
    Trade direction badge: "LONG" or "SHORT" (large)
    Symbol + timeframe: "BTC · 5m"
    Live duration: "Open 14m ago"
  
  PROGRESS BAR (visual R:R progress):
    Shows price position between stop and TP2
    Red zone: stop → entry
    Gray: entry (breakeven line after TP1)
    Light green: entry → TP1
    Green: TP1 → TP2
    Current price indicator dot sliding along bar
    
    [====STOP====|========ENTRY======|====TP1====|====TP2====]
                                          ^current price
  
  METRICS ROW:
    P&L: "+$234 (+1.4%)"  — colored, updating live
    R-Multiple: "+0.8R" — how many R's gained so far
    Risk: "$142 (0.9%)"
  
  LEVELS (compact table):
    Entry:    $65,748
    Stop:     $65,200  (→ "Breakeven" after TP1 hit)
    TP1:      $66,296  ✅ Hit  (green check if hit)
    TP2:      $66,844  ← target
    R:R:      1 : 2.0

  AFTER TP1 HIT:
    Show green banner: "✅ TP1 Hit — 50% locked in"
    Stop line changes to "Breakeven"
    Risk becomes "Risk-Free Trade 🎯"

  BUTTONS:
    "Move Stop to BE" — if TP1 hit but stop not at BE yet
    "Close 50% Now" — manual partial exit
    "Close All" — exit full position
    "Add Notes" — text input saved to journal

WHEN TRADE IS CLOSED:
  Show trade summary card for 10 seconds then collapse:
    Result: "WIN ✅" or "LOSS ✗" or "BREAKEVEN ⚡"
    P&L: "+2.1% (+2.1R)" or "-0.9% (-1.0R)"
    Duration: "45 minutes"
    Pattern: "Bull Flag"
  Auto-archive to journal
```

### Trade History Panel
```
COMPONENT: TradeHistoryPanel (in /journal route or tab)

SESSION STATS BAR:
  Today: 3W 1L | Win Rate: 75% | P&L: +3.2% | Avg R: 1.8R

TABLE COLUMNS:
  Time | Symbol | Pattern | Direction | Entry | TP1 | TP2 | Stop | Outcome | P&L% | R-Multiple

ROW COLORS:
  Win: subtle green bg (rgba(34,197,94,0.06))
  Loss: subtle red bg (rgba(239,68,68,0.06))
  Breakeven: subtle gray bg

TP1/TP2 CELLS:
  Show price + ✅ if hit, — if not
  
R-MULTIPLE COLUMN:
  "+2.0R" in green if win
  "-1.0R" in red if loss
  "+0.5R" in amber if breakeven (TP1 hit, stop at BE)

EXPORT BUTTON: Download as CSV

EQUITY CHART:
  Small line chart showing cumulative P&L over session
  Or total R-multiples accumulated
```

---

## Chain: Signal Strip Integration

### Trade Info in Signal Strip Box
```
The SignalStrip below the chart should show active trade info:

WHEN SIGNAL EXISTS (no open trade):
  Box shows: entry, TP1, TP2, stop, R:R
  "Paper Trade" button → opens trade

WHEN TRADE IS PENDING:
  "⏳ Pending Entry $65,748" in amber
  Countdown to expiry

WHEN TRADE IS OPEN:
  Live P&L: "+$234 (+1.4%) · 0.8R"
  Progress through R:R zones
  Status: "LONG · Open · TP1 pending" or "LONG · TP1 ✅ · TP2 pending"

WHEN TP1 HIT:
  "✅ TP1 Hit — Breakeven secured"
  Remaining: "50% open targeting TP2"

WHEN CLOSED:
  Flash result for 5 seconds:
  WIN: "+2.1% (+2.1R) ✅" in green
  LOSS: "-0.9% (-1.0R) ✗" in red
  Then revert to next signal
```

---

## Chain: useTradeManager Hook
```
TOOL: useTradeManager(symbol, currentPrice)

STATE:
  activeTrade: Trade | null
  tradeHistory: Trade[]
  sessionStats: SessionStats

METHODS:
  openTrade(signal: Signal): Trade
    Creates new trade from signal
    Calculates TP1, TP2, TP3 using calculateTargets()
    Sets positionSize based on config (default 100 units paper)
    status: 'pending' initially
    Saves to journal

  onPriceTick(price: number, candle: Candle, isClosed: boolean):
    if activeTrade:
      managePendingTrade(activeTrade, price, candle, isClosed)
      if activeTrade.status === 'open':
        monitorOpenTrade(activeTrade, price, candle)
      updateTrade(activeTrade)
      setActiveTrade({...activeTrade})  // trigger re-render

  closeTrade(reason: 'manual' | 'stop' | 'tp2'):
    closeTrade(activeTrade, currentPrice, reason)
    setActiveTrade(null)
    setTradeHistory(prev => [...prev, closedTrade])

  cancelTrade():
    activeTrade.status = 'cancelled'
    archive to history

EFFECTS:
  On currentPrice change → onPriceTick(currentPrice, currentCandle, isClosed)
  On activeTrade change → drawActiveTrade(chart, activeTrade)
  
RETURNS:
  { activeTrade, tradeHistory, sessionStats,
    openTrade, closeTrade, cancelTrade }
```

---

## Common Bugs

```
BUG: TP1 not triggering even when price crosses it
FIX: Check candle high/low not just close:
     LONG TP1: if currentCandle.high >= trade.tp1 → hit
     SHORT TP1: if currentCandle.low <= trade.tp1 → hit
     Price can hit TP intrabar without closing there

BUG: Stop triggered at exact entry price (false stop)
FIX: Add 0.05% buffer: 
     LONG stop: trade.actualEntry * 0.9995 (not exactly entry)

BUG: P&L showing incorrect after partial exit
FIX: realizedPnlPct must account for PORTION closed:
     pnl = ((exitPrice - entry) / entry) * 100 * (closedPortion)
     where closedPortion = 0.5 for TP1

BUG: R-multiple calculation wrong
FIX: rMultiple = totalPnlPct / riskPct
     riskPct = abs(entry - stopLoss) / entry * 100
     A 1:2 trade = 2.0 R-multiple

BUG: Trade persists after symbol change
FIX: On symbol change → if activeTrade && activeTrade.symbol !== newSymbol:
     Show warning: "Active trade on BTC — switch anyway?"
     If confirmed: expire/cancel current trade

BUG: Multiple trades opening at once
FIX: if activeTrade !== null → block new trade entry
     One trade at a time per symbol
     Show: "Close current trade before opening new one"

BUG: Live P&L not updating
FIX: Calculate in render (not stored state):
     const livePnl = ((currentPrice - activeTrade.actualEntry) / activeTrade.actualEntry) * 100
     Display this computed value, update on every currentPrice change
```
