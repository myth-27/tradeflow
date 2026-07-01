import WebSocket from 'ws';
import { pushCandle } from './candle-store';
import { processNewCandle, STREAMS } from './signal-processor';

const sockets = new Map<string, WebSocket>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Bybit has no geo-restrictions — accessible from any Railway region
const BYBIT_WS = 'wss://stream.bybit.com/v5/public/linear';

// Distinct timeframes across all streams
const TIMEFRAMES = Array.from(new Set(STREAMS.map(s => s.tf)));
const SYMBOLS = Array.from(new Set(STREAMS.map(s => s.symbol)));

// Bybit interval codes
const TF_MAP: Record<string, string> = { '15m': '15', '1h': '60' };

export function startWsManager(): void {
  for (const tf of TIMEFRAMES) {
    connectBybit(tf);
  }
  console.log(`[ws] WebSocket manager started (Bybit) — ${SYMBOLS.length} symbols × ${TIMEFRAMES.length} timeframes`);
}

export function stopWsManager(): void {
  sockets.forEach(ws => ws.terminate());
  sockets.clear();
  reconnectTimers.forEach(t => clearTimeout(t));
  reconnectTimers.clear();
}

function connectBybit(tf: string): void {
  const interval = TF_MAP[tf];
  if (!interval) return;

  const topics = SYMBOLS.map(sym => `kline.${interval}.${sym}`);
  const ws = new WebSocket(BYBIT_WS);
  sockets.set(tf, ws);

  ws.on('open', async () => {
    ws.send(JSON.stringify({ op: 'subscribe', args: topics }));
    console.log(`[ws] subscribed ${topics.length} Bybit kline.${interval} streams`);
    for (const sym of SYMBOLS) {
      await seedHistoricalCandles(sym, tf, interval);
      // stagger REST calls to avoid rate limiting
      await new Promise(r => setTimeout(r, 300));
    }
  });

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        topic?: string;
        data?: Array<{
          start: number; open: string; high: string; low: string;
          close: string; volume: string; confirm: boolean;
        }>;
      };

      if (!msg.topic || !msg.data?.length) return;

      // topic format: "kline.15.BTCUSDT"
      const parts = msg.topic.split('.');
      if (parts.length < 3) return;
      const symbol = parts[2];

      const k = msg.data[0];
      const candle = {
        time: k.start / 1000,
        open: parseFloat(k.open),
        high: parseFloat(k.high),
        low: parseFloat(k.low),
        close: parseFloat(k.close),
        volume: parseFloat(k.volume),
      };

      pushCandle(symbol, tf, candle, k.confirm);

      if (k.confirm) {
        processNewCandle(symbol, tf).catch((err: unknown) =>
          console.error(`[signal] error ${symbol}:${tf}:`, err),
        );
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    console.log(`[ws] disconnected tf=${tf} — reconnecting in 5s`);
    sockets.delete(tf);
    const t = setTimeout(() => connectBybit(tf), 5000);
    reconnectTimers.set(tf, t);
  });

  ws.on('error', (err: Error) => {
    console.error(`[ws] error tf=${tf}:`, err.message);
    ws.terminate();
  });
}

async function seedHistoricalCandles(symbol: string, tf: string, interval: string): Promise<void> {
  const headers = { 'User-Agent': 'TradeFlow/1.0 paper-trading-engine' };

  // 1. Try Bybit v5 linear futures
  try {
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=300`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const data = await res.json() as { result: { list: string[][] } };
      const klines = data.result?.list ?? [];
      for (const k of [...klines].reverse()) {
        pushCandle(symbol, tf, {
          time: parseInt(k[0]) / 1000,
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }, true);
      }
      console.log(`[ws] seeded ${klines.length} candles ${symbol} ${tf} (Bybit)`);
      return;
    }
  } catch { /* fall through */ }

  // 2. Fallback: Binance US (accessible from Railway US datacenters)
  try {
    const binanceTf = tf; // '15m' or '1h' — same format as Binance
    const url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${binanceTf}&limit=300`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const klines = await res.json() as string[][];
      for (const k of klines) {
        pushCandle(symbol, tf, {
          time: parseInt(k[0]) / 1000,
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }, true);
      }
      console.log(`[ws] seeded ${klines.length} candles ${symbol} ${tf} (Binance US)`);
      return;
    }
  } catch { /* fall through */ }

  // 3. Both REST sources unavailable — live WebSocket will warm up over time
  console.warn(`[ws] seed skipped ${symbol} ${tf} — warming up from live stream`);
}
