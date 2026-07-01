export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!process.env.DATABASE_URL) {
    console.warn('[instrumentation] DATABASE_URL not set — paper trading engine disabled');
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
