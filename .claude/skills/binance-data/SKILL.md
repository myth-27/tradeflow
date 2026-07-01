---
name: binance-data
description: Binance REST and WebSocket API integration expert — exact kline field indices, ticker response parsing, reconnection with exponential backoff, and the full useBinanceFeed hook implementation. Load this skill whenever touching Binance API calls, WebSocket kline/ticker streams, the BinanceWebSocket class, or the useBinanceFeed hook.
---

## Role

You are a Binance API integration expert. You know every field index, WebSocket message format, rate limit, reconnection pattern, and data parsing quirk. You never get the kline array index wrong.

---

## Chain: REST API

### Fetch Historical Klines
```
TOOL: fetchKlines(symbol, interval, limit=100)
ENDPOINT: GET https://api.binance.com/api/v3/klines
PARAMS: { symbol: symbol.toUpperCase(), interval, limit }
EXAMPLE: /api/v3/klines?symbol=BTCUSDT&interval=5m&limit=100

RESPONSE: Array of arrays, each inner array is one kline:
  [0]  openTime       — Unix ms timestamp
  [1]  open           — string "65432.10"
  [2]  high           — string "65500.00"
  [3]  low            — string "65300.00"
  [4]  close          — string "65450.00"
  [5]  volume         — string "123.45"  ← BASE asset volume (BTC)
  [6]  closeTime      — Unix ms
  [7]  quoteVolume    — string (USDT volume) — use for display
  [8]  trades         — number of trades
  [9]  takerBuyBase   — taker buy base volume
  [10] takerBuyQuote  — taker buy quote volume
  [11] ignore         — "0"

PARSE:
  const candles = data.map(k => ({
    time: Math.floor(k[0] / 1000),  // ms → seconds
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),        // ← k[5] NOT k[4]
    quoteVolume: parseFloat(k[7]),   // optional, for USDT display
  }))

COMMON BUG: Using k[4] for volume — that's close price
CORRECT: k[5] is always volume
```

### Fetch 24h Ticker
```
TOOL: fetch24hTicker(symbol)
ENDPOINT: GET https://api.binance.com/api/v3/ticker/24hr
PARAMS: { symbol: symbol.toUpperCase() }

RESPONSE FIELDS:
  priceChange     — string, absolute change
  priceChangePct  — string "1.23" (no % sign, divide by 100 for decimal)
  lastPrice       — current price string
  volume          — 24h base volume
  quoteVolume     — 24h quote volume (USDT)
  highPrice       — 24h high
  lowPrice        — 24h low

PARSE:
  {
    price: parseFloat(data.lastPrice),
    change24h: parseFloat(data.priceChangePct),  // already %
    volume24h: parseFloat(data.quoteVolume),      // in USDT
    high24h: parseFloat(data.highPrice),
    low24h: parseFloat(data.lowPrice),
  }
```

### Paginate Full History
```
TOOL: fetchFullHistory(symbol, interval, startDate, endDate)
LOGIC:
  const results = []
  let startTime = new Date(startDate).getTime()
  const endTime = new Date(endDate).getTime()
  
  while (startTime < endTime) {
    const batch = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=1000`
    ).then(r => r.json())
    
    if (!batch.length) break
    results.push(...batch)
    
    // Next batch starts after last candle's closeTime
    startTime = batch[batch.length-1][6] + 1
    
    // Rate limit: 1200 requests/min = max ~20/sec safely
    await new Promise(r => setTimeout(r, 100))
  }
  
  return results.map(parseKline)

RATE LIMITS:
  Weight 1: /klines (max 1200 weight/min)
  Each klines request = 1-2 weight depending on limit
  Safe: 1 request per 100ms = 600/min (well under limit)
```

---

## Chain: WebSocket

### Kline Stream
```
TOOL: connectKlineStream(symbol, interval, onCandle)
ENDPOINT: wss://stream.binance.com:9443/ws/{symbol}@kline_{interval}
EXAMPLE: wss://stream.binance.com:9443/ws/btcusdt@kline_5m

MESSAGE FORMAT:
  {
    "e": "kline",
    "E": 1638747660000,     // event time
    "s": "BTCUSDT",         // symbol
    "k": {
      "t": 1638747600000,   // kline open time (ms)
      "T": 1638747899999,   // kline close time
      "s": "BTCUSDT",
      "i": "5m",            // interval
      "o": "48000.00",      // open
      "c": "48100.00",      // close (current price)
      "h": "48150.00",      // high
      "l": "47980.00",      // low
      "v": "12.453",        // BASE volume ← parseFloat(k.v)
      "q": "598234.12",     // quote volume (USDT)
      "n": 1234,            // number of trades
      "x": false,           // IS THIS CANDLE CLOSED? ← critical flag
      "V": "6.234",         // taker buy base volume
    }
  }

PARSE:
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.e !== 'kline') return
    
    const k = msg.k
    const candle = {
      time: Math.floor(k.t / 1000),  // ms → seconds
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),        // ← k.v NOT k.c
    }
    const isClosed = k.x  // true = candle finalized
    
    onCandle(candle, isClosed)
  }

CRITICAL: k.x === true means candle is closed
  isClosed = false: update the last candle (live tick)
  isClosed = true: append new candle, run pattern detection
```

### MiniTicker Stream (for ticker bar)
```
TOOL: connectMiniTicker(symbol, onTick)
ENDPOINT: wss://stream.binance.com:9443/ws/{symbol}@miniTicker

MESSAGE:
  {
    "e": "24hrMiniTicker",
    "s": "BTCUSDT",
    "c": "65432.10",   // close/last price
    "o": "64000.00",   // open 24h ago
    "h": "66000.00",   // 24h high
    "l": "63500.00",   // 24h low
    "v": "12345.67",   // base volume
    "q": "800000000",  // quote volume
  }

PARSE:
  const tick = {
    symbol: msg.s,
    price: parseFloat(msg.c),
    change24h: ((parseFloat(msg.c) - parseFloat(msg.o)) / parseFloat(msg.o)) * 100,
  }
```

### Combined Stream (multiple symbols)
```
TOOL: connectCombinedStream(streams[], onMessage)
ENDPOINT: wss://stream.binance.com:9443/stream?streams={stream1}/{stream2}/...
EXAMPLE: wss://stream.binance.com:9443/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker

MESSAGE WRAPPER:
  { "stream": "btcusdt@miniTicker", "data": { ...miniTickerData } }
  Access: msg.data for the actual payload
```

---

## Chain: Reconnection Logic

### Auto-Reconnect with Backoff
```
TOOL: createReconnectingWS(url, onMessage, onOpen, onClose)

class ReconnectingWebSocket {
  private ws: WebSocket | null = null
  private reconnectDelay = 1000
  private maxDelay = 30000
  private intentionalClose = false

  connect(url: string) {
    this.ws = new WebSocket(url)
    
    this.ws.onopen = () => {
      this.reconnectDelay = 1000  // reset on successful connect
      onOpen?.()
    }

    this.ws.onmessage = onMessage

    this.ws.onclose = () => {
      if (this.intentionalClose) return
      onClose?.()
      setTimeout(() => this.connect(url), this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxDelay)
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  disconnect() {
    this.intentionalClose = true
    this.ws?.close()
  }

  send(data: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data)
    }
  }
}
```

---

## Chain: useBinanceFeed Hook

### Complete Hook Implementation
```
TOOL: useBinanceFeed(symbol, interval)

STATE:
  const [candles, setCandles] = useState<Candle[]>([])
  const [currentCandle, setCurrentCandle] = useState<Candle | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [price24h, setPrice24h] = useState({ change: 0, volume: 0 })
  const wsRef = useRef<ReconnectingWebSocket | null>(null)

INIT EFFECT (runs on symbol/interval change):
  useEffect(() => {
    // 1. Fetch historical candles
    fetchKlines(symbol, interval, 200).then(historical => {
      setCandles(historical)
    })

    // 2. Fetch 24h stats
    fetch24hTicker(symbol).then(ticker => {
      setPrice24h(ticker)
    })

    // 3. Connect WebSocket
    const url = `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`
    wsRef.current = new ReconnectingWebSocket()
    wsRef.current.connect(url, (event) => {
      const msg = JSON.parse(event.data)
      if (msg.e !== 'kline') return
      
      const candle = parseKlineMessage(msg.k)
      const isClosed = msg.k.x
      
      setCurrentCandle(candle)
      
      if (isClosed) {
        setCandles(prev => {
          const updated = [...prev, candle]
          return updated.slice(-200)  // keep last 200
        })
      } else {
        // Update forming candle
        setCandles(prev => {
          if (prev.length === 0) return prev
          const updated = [...prev]
          updated[updated.length - 1] = candle
          return updated
        })
      }
    })

    setIsConnected(true)

    return () => {
      wsRef.current?.disconnect()
      setIsConnected(false)
    }
  }, [symbol, interval])

RETURNS:
  { candles, currentCandle, isConnected, 
    currentPrice: candles[candles.length-1]?.close ?? 0,
    priceChange24h: price24h.change,
    volume24h: price24h.volume }
```

---

## Symbol Reference
```
COMMON INSTRUMENT TOKENS:
  BTC/USDT → symbol: "btcusdt"
  ETH/USDT → symbol: "ethusdt"
  SOL/USDT → symbol: "solusdt"
  BNB/USDT → symbol: "bnbusdt"
  ADA/USDT → symbol: "adausdt"

INTERVALS:
  "1m" "3m" "5m" "15m" "30m"
  "1h" "2h" "4h" "6h" "8h" "12h"
  "1d" "3d" "1w" "1M"

INTRADAY MODE: use "5m"
SWING MODE: use "4h"
```

---

## Common Bugs
```
BUG: volume is always 0
FIX: REST → parseFloat(k[5]) not k[4]
     WebSocket → parseFloat(k.v) not k.c

BUG: candles timestamp mismatch
FIX: Divide by 1000: Math.floor(k[0] / 1000)
     Lightweight Charts expects SECONDS not ms

BUG: WebSocket not reconnecting
FIX: Use ReconnectingWebSocket class with exponential backoff
     Never rely on native WebSocket reconnect

BUG: Symbol case error (400 from Binance)
FIX: Always uppercase for REST: symbol.toUpperCase()
     Always lowercase for WebSocket: symbol.toLowerCase()

BUG: Missing candles on startup
FIX: Fetch historical BEFORE connecting WebSocket
     On WS connect, if last historical candle time < WS candle time
     → there's a gap. Fill with another REST call

BUG: Duplicate candles
FIX: Check candle time before pushing to array:
     if (prev[prev.length-1]?.time !== candle.time) push
     Else replace last candle (it's an update to forming candle)
```
