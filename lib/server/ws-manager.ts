import WebSocket from 'ws';
import { pushCandle } from './candle-store';
import { processNewCandle, STREAMS } from './signal-processor';

const sockets = new Map<string, WebSocket>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function startWsManager(): void {
  for (const { symbol, tf } of STREAMS) {
    connectStream(symbol, tf);
  }
  console.log(`[ws] WebSocket manager started — ${STREAMS.length} streams`);
}

export function stopWsManager(): void {
  sockets.forEach(ws => ws.terminate());
  sockets.clear();
  reconnectTimers.forEach(t => clearTimeout(t));
  reconnectTimers.clear();
}

function connectStream(symbol: string, tf: string): void {
  const streamKey = `${symbol}:${tf}`;
  const url = `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${tf}`;

  const ws = new WebSocket(url);
  sockets.set(streamKey, ws);

  ws.on('open', async () => {
    console.log(`[ws] connected ${streamKey}`);
    await seedHistoricalCandles(symbol, tf);
  });

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        k: {
          t: number; o: string; h: string; l: string;
          c: string; v: string; x: boolean;
        };
      };
      const k = msg.k;
      const candle = {
        time: k.t / 1000,
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        volume: parseFloat(k.v),
      };

      pushCandle(symbol, tf, candle, k.x);

      if (k.x) {
        processNewCandle(symbol, tf).catch((err: unknown) =>
          console.error(`[signal] error processing ${streamKey}:`, err),
        );
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    console.log(`[ws] disconnected ${streamKey} — reconnecting in 5s`);
    sockets.delete(streamKey);
    const t = setTimeout(() => connectStream(symbol, tf), 5000);
    reconnectTimers.set(streamKey, t);
  });

  ws.on('error', (err: Error) => {
    console.error(`[ws] error ${streamKey}:`, err.message);
    ws.terminate();
  });
}

async function seedHistoricalCandles(symbol: string, tf: string): Promise<void> {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=300`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[ws] seed fetch failed ${symbol} ${tf}: ${res.status}`);
      return;
    }
    const klines = await res.json() as Array<[number, string, string, string, string, string]>;
    for (const k of klines) {
      pushCandle(symbol, tf, {
        time: k[0] / 1000,
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }, true);
    }
    console.log(`[ws] seeded ${klines.length} candles for ${symbol} ${tf}`);
  } catch (err) {
    console.error(`[ws] seed error ${symbol} ${tf}:`, err);
  }
}
