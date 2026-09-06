export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!process.env.DATABASE_URL) {
    console.warn('[instrumentation] DATABASE_URL not set — paper trading engine disabled');
    return;
  }
  if (process.env.ENABLE_ENGINE !== 'true') {
    console.log('[instrumentation] Engine standby (ENABLE_ENGINE not set) — dashboard-only mode');
    return;
  }

  const { initDb } = await import('@/lib/server/db');
  const { startWsManager } = await import('@/lib/server/ws-manager');
  const { startTradeMonitor } = await import('@/lib/server/trade-monitor');

  // Start WebSocket feeds immediately (no DB needed)
  startWsManager();

  // Connect to DB with indefinite retry — private networking may take time to propagate
  // after a Railway deployment. Once connected, start the trade engine.
  let engineStarted = false;
  const tryConnect = async (): Promise<void> => {
    try {
      await initDb();
      console.log('[instrumentation] Database ready');
      if (!engineStarted) {
        engineStarted = true;
        startTradeMonitor();
        console.log('[instrumentation] Paper trading engine started');
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      console.error(`[instrumentation] DB connect failed (${e.code ?? e.message}) — retrying in 30s`);
      setTimeout(tryConnect, 30_000);
    }
  };

  // First attempt immediately, then retry every 30s until connected
  await tryConnect();
}
