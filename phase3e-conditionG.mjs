// Phase 3E — Condition G: exclude 'ranging' regime (floor stays at 60)
// 36 runs: 6 windows × 3 symbols × 2 timeframes
// allowedRegimes: strong_uptrend, weak_uptrend, strong_downtrend, weak_downtrend
import pkg from './node_modules/playwright/index.js';
const { chromium } = pkg;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, '..', '.playwright-profile');
const OUT_FILE = path.join(__dirname, 'training-exports', 'phase3e-conditionG-results.json');
const BASE_URL = 'http://localhost:3000';

const WINDOWS = [
  { windowId: 1, windowLabel: 'Bull: Oct 2020 - Mar 2021', handPickedRegime: 'bull', start: '2020-10-01', end: '2021-03-31' },
  { windowId: 2, windowLabel: 'Bull: Oct 2023 - Mar 2024', handPickedRegime: 'bull', start: '2023-10-01', end: '2024-03-31' },
  { windowId: 3, windowLabel: 'Bear: May 2021 - Oct 2021', handPickedRegime: 'bear', start: '2021-05-01', end: '2021-10-31' },
  { windowId: 4, windowLabel: 'Bear: Apr 2022 - Sep 2022', handPickedRegime: 'bear', start: '2022-04-01', end: '2022-09-30' },
  { windowId: 5, windowLabel: 'Choppy: Jul 2023 - Dec 2023', handPickedRegime: 'choppy', start: '2023-07-01', end: '2023-12-31' },
  { windowId: 6, windowLabel: 'Choppy: Apr 2024 - Sep 2024', handPickedRegime: 'choppy', start: '2024-04-01', end: '2024-09-30' },
];

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const TIMEFRAMES = ['15m', '1h'];
const SCORE_FLOOR = 60;
const CONDITION = 'G';

const RUNS = [];
for (const win of WINDOWS) {
  for (const symbol of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      RUNS.push({ ...win, symbol, timeframe: tf });
    }
  }
}

async function setRangeValue(page, nthRange, value) {
  await page.locator('input[type="range"]').nth(nthRange).evaluate((el, val) => {
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, String(value));
  await page.waitForTimeout(100);
}

async function clickPillByText(page, text) {
  await page.getByRole('button', { name: text, exact: true }).first().click();
  await page.waitForTimeout(100);
}

async function runSim(page, run) {
  const symbolShort = run.symbol.replace('USDT', '') + '/USDT';

  console.log(`  → ${run.symbol} ${run.timeframe} [${run.start} → ${run.end}]`);

  await page.goto(`${BASE_URL}/simulate`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(800);

  // Set symbol
  await clickPillByText(page, symbolShort);

  // Set timeframe
  await clickPillByText(page, run.timeframe);

  // Set date range
  const dateInputs = page.locator('input[type="date"]');
  await dateInputs.nth(0).fill(run.start);
  await page.waitForTimeout(100);
  await dateInputs.nth(1).fill(run.end);
  await page.waitForTimeout(100);

  // Score floor stays at 60 (default page scoreFloor from the page's defaultConfig is what matters)
  // defaultConfig in page.tsx doesn't set scoreFloor explicitly so it comes from defaultSimConfig()
  // which is 50. But the phase3-floor60 baseline used 60. Set to 60 explicitly.
  await setRangeValue(page, 2, SCORE_FLOOR);

  // Exclude 'ranging' regime
  // The regime filter is ON by default. The Ranging pill is currently ACTIVE.
  // Clicking it once will deactivate it (remove from allowedRegimes).
  // Pill text = "Ranging" (from REGIME_LABELS)
  await clickPillByText(page, 'Ranging');

  // Verify ranging is excluded: the Ranging pill should now be inactive
  // (We'll trust the click worked; any mismatch shows in the regimeBreakdown results)

  // Click Run
  await page.getByRole('button', { name: '▶ Run Simulation' }).click();

  // Wait for result (up to 8 minutes — 15m data blocks main thread for 3-4 min)
  await page.waitForFunction(() => {
    const w = window;
    return w.__lastSimResult !== undefined && w.__lastSimResult !== null;
  }, null, { timeout: 480000 });

  const result = await page.evaluate(() => {
    const r = window.__lastSimResult;
    return {
      totalTrades: r.totalTrades,
      totalSignals: r.totalSignals,
      winRate: r.winRate,
      profitFactor: r.profitFactor,
      totalReturn: r.totalReturn,
      finalCapital: r.finalCapital,
      startingCapital: r.startingCapital,
      maxDrawdown: r.maxDrawdown,
      sharpeRatio: r.sharpeRatio,
      expectancy: r.expectancy,
      regimeBreakdown: r.regimeBreakdown,
      rejections: r.rejections,
      totalCandles: r.totalCandles,
    };
  });

  return {
    windowId: run.windowId,
    windowLabel: run.windowLabel,
    handPickedRegime: run.handPickedRegime,
    start: run.start,
    end: run.end,
    symbol: run.symbol,
    timeframe: run.timeframe,
    scoreFloor: SCORE_FLOOR,
    allowedRegimes: ['strong_uptrend', 'weak_uptrend', 'strong_downtrend', 'weak_downtrend'],
    condition: CONDITION,
    ...result,
  };
}

async function main() {
  const existing = fs.existsSync(OUT_FILE)
    ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'))
    : [];

  const completed = new Set(existing.map(r => `${r.windowId}|${r.symbol}|${r.timeframe}`));
  const remaining = RUNS.filter(r => !completed.has(`${r.windowId}|${r.symbol}|${r.timeframe}`));

  console.log(`Phase 3E Condition G — Exclude Ranging Regime (floor: ${SCORE_FLOOR})`);
  console.log(`Total runs: ${RUNS.length}, Completed: ${existing.length}, Remaining: ${remaining.length}`);

  if (remaining.length === 0) {
    console.log('All runs already completed.');
    return;
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--no-sandbox'],
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  const results = [...existing];

  for (let i = 0; i < remaining.length; i++) {
    const run = remaining[i];
    const runKey = `Window ${run.windowId} (${run.windowLabel}) | ${run.symbol} ${run.timeframe}`;
    console.log(`\n[${i + 1}/${remaining.length}] ${runKey}`);

    try {
      const result = await runSim(page, run);
      results.push(result);
      fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
      console.log(`  ✓ WR: ${result.winRate.toFixed(1)}% | PF: ${result.profitFactor.toFixed(2)} | Return: ${result.totalReturn.toFixed(1)}% | Trades: ${result.totalTrades} | Ranging trades excluded`);
    } catch (err) {
      console.error(`  ✗ FAILED: ${err.message}`);
      fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
    }
  }

  await context.close();

  console.log(`\n✅ Phase 3E Condition G complete. ${results.length}/${RUNS.length} runs saved to ${OUT_FILE}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
