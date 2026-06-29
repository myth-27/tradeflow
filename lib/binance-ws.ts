export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type KlineMessage = {
  e: string;
  E: number;
  s: string;
  k: {
    t: number;
    T: number;
    s: string;
    i: string;
    o: string;
    c: string;
    h: string;
    l: string;
    v: string;
    x: boolean;
  };
};

export class BinanceWebSocket {
  private ws: WebSocket | null = null;
  private symbol: string = '';
  private interval: string = '';
  private onCandle: ((candle: Candle, isClosed: boolean) => void) | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectDelay: number = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isDisconnecting: boolean = false;

  connect(
    symbol: string,
    interval: string,
    onCandle: (candle: Candle, isClosed: boolean) => void
  ): void {
    this.symbol = symbol.toLowerCase();
    this.interval = interval;
    this.onCandle = onCandle;
    this.isDisconnecting = false;
    this.openSocket();
  }

  private openSocket(): void {
    const url = `wss://stream.binance.com:9443/ws/${this.symbol}@kline_${this.interval}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg: KlineMessage = JSON.parse(event.data as string);
        const k = msg.k;
        const candle: Candle = {
          time: Math.floor(k.t / 1000),
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
        };
        if (this.onCandle) {
          this.onCandle(candle, k.x);
        }
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onerror = () => {
      // error triggers onclose which handles reconnect
    };

    this.ws.onclose = () => {
      if (!this.isDisconnecting) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      if (!this.isDisconnecting) {
        this.openSocket();
      }
    }, delay);
  }

  disconnect(): void {
    this.isDisconnecting = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
  }

  changeSymbol(symbol: string, interval: string): void {
    this.disconnect();
    this.isDisconnecting = false;
    this.reconnectAttempts = 0;
    if (this.onCandle) {
      this.connect(symbol, interval, this.onCandle);
    }
  }
}
