import { NextRequest } from 'next/server';
import { fetchSimulationData, runSimulation, type SimConfig } from '@/lib/simulator';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const VALID_INTERVALS = new Set(['1m', '5m', '15m', '1h', '4h', '1d']);

function validateConfig(body: unknown): { config: SimConfig } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Missing request body' };
  const b = body as Record<string, unknown>;

  if (typeof b.symbol !== 'string' || !/^[A-Z]+USDT$/i.test(b.symbol)) {
    return { error: 'symbol must look like BTCUSDT' };
  }
  if (typeof b.interval !== 'string' || !VALID_INTERVALS.has(b.interval)) {
    return { error: `interval must be one of ${Array.from(VALID_INTERVALS).join(', ')}` };
  }
  if (typeof b.startDate !== 'string' || typeof b.endDate !== 'string') {
    return { error: 'startDate and endDate are required (YYYY-MM-DD)' };
  }
  if (new Date(b.startDate) >= new Date(b.endDate)) {
    return { error: 'startDate must be before endDate' };
  }
  const startingCapital = Number(b.startingCapital);
  if (!Number.isFinite(startingCapital) || startingCapital <= 0) {
    return { error: 'startingCapital must be a positive number' };
  }
  const riskPerTrade = Number(b.riskPerTrade);
  if (!Number.isFinite(riskPerTrade) || riskPerTrade <= 0 || riskPerTrade > 0.1) {
    return { error: 'riskPerTrade must be between 0 and 0.1 (10%)' };
  }

  return {
    config: {
      symbol: (b.symbol as string).toUpperCase(),
      interval: b.interval as string,
      startDate: b.startDate as string,
      endDate: b.endDate as string,
      startingCapital,
      riskPerTrade,
      minRR: Number(b.minRR) || 1.5,
      minConfidence: Number(b.minConfidence) || 65,
      maxOpenTime: Number(b.maxOpenTime) || 20,
      allowedPatterns: Array.isArray(b.allowedPatterns) ? (b.allowedPatterns as string[]) : [],
      regimeFilter: b.regimeFilter !== false,
      partialExit: b.partialExit !== false,
    },
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const validated = validateConfig(body);

  if ('error' in validated) {
    return new Response(JSON.stringify({ type: 'error', message: validated.error }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { config } = validated;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        send({ type: 'progress', pct: 0, msg: 'Starting simulation...' });

        const candles = await fetchSimulationData(
          config.symbol, config.interval, config.startDate, config.endDate,
          (pct, msg) => send({ type: 'progress', pct, msg }),
        );

        if (candles.length < 150) {
          send({ type: 'error', message: `Only ${candles.length} candles fetched — need at least 150 (100 warmup + 50 to trade). Pick a wider date range.` });
          controller.close();
          return;
        }

        send({ type: 'progress', pct: 50, msg: `Fetched ${candles.length.toLocaleString()} candles. Running walk-forward simulation...` });

        const result = await runSimulation(config, candles, (pct, msg, counters) => send({ type: 'progress', pct, msg, counters }));

        send({ type: 'complete', result });
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : 'Simulation failed' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
