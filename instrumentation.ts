export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!process.env.DATABASE_URL) {
    console.warn('[instrumentation] DATABASE_URL not set — paper trading engine disabled');
    return;
  }
  // Vercel is serverless — engine cannot run persistently there.
  // Set ENABLE_ENGINE=true only on Railway (or any always-on server).
  if (process.env.ENABLE_ENGINE !== 'true') {
    console.log('[instrumentation] Engine standby (ENABLE_ENGINE not set) — dashboard-only mode');
    return;
  }

  const { initDb } = await import('@/lib/server/db');
  const { startWsManager } = await import('@/lib/server/ws-manager');
  const { startTradeMonitor } = await import('@/lib/server/trade-monitor');

  // Retry DB init — Postgres may not be ready immediately after container start
  let connected = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await initDb();
      console.log('[instrumentation] Database ready');
      connected = true;
      break;
    } catch (err) {
      const e = err as Error & { code?: string; cause?: Error };
      console.error(`[instrumentation] DB connect attempt ${attempt}/5 failed: ${e.message} (code=${e.code ?? 'none'}) cause=${e.cause?.message ?? 'none'}`);
      if (attempt < 5) await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }

  if (!connected) {
    console.error('[instrumentation] Engine startup failed — could not connect to DB after 5 attempts');
    return;
  }

  startWsManager();
  startTradeMonitor();
  console.log('[instrumentation] Paper trading engine started');
}
