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

  try {
    await initDb();
    console.log('[instrumentation] Database ready');

    startWsManager();
    startTradeMonitor();
    console.log('[instrumentation] Paper trading engine started');
  } catch (err) {
    console.error('[instrumentation] Engine startup failed:', err);
  }
}
