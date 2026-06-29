/**
 * TradeFlow — Self-Learning Auto-Simulator (Phase 16)
 *
 * Runs simulations automatically across random symbol/timeframe/date combinations and learns
 * from every one. Deliberately thin: it does NOT maintain a second, parallel weight/learning
 * system. Every run goes through the exact same path a manual simulation does —
 * fetchSimulationData → getPatternEdgeHints → runSimulation → recordSimulation — so it feeds,
 * and benefits from, the one real edge registry (lib/edge-registry.ts, db.edgeStats) instead
 * of a duplicate that nothing else reads.
 */

import { getDB, type AutoSimRunRecord } from './db';
import type { Candle } from './binance-ws';
import {
  fetchSimulationData, runSimulation, isHtfEligible, defaultSimConfig,
  type SimResult, type SimConfig,
} from './simulator';
import { recordSimulation } from './simulation-memory';
import { getPatternEdgeHints } from './edge-registry';
import { generateIntelligenceReport } from './intelligence-report';
import { getLightweightRejectionSummary } from './rejected-signal-analyzer';

// ─── Types ──────────────────────────────────────────────────────────────

export interface DateRange {
  start: string;
  end: string;
  label: string;
}

export const TRAINING_DATE_RANGES: DateRange[] = [
  { start: '2024-01-01', end: '2024-03-31', label: 'Q1 2024 Strong Bull' },
  { start: '2024-04-01', end: '2024-06-30', label: 'Q2 2024 Correction' },
  { start: '2024-07-01', end: '2024-09-30', label: 'Q3 2024 Range' },
  { start: '2024-10-01', end: '2024-12-31', label: 'Q4 2024 Bull Run' },
  { start: '2023-01-01', end: '2023-03-31', label: 'Q1 2023 Recovery' },
  { start: '2023-06-01', end: '2023-08-31', label: 'Q3 2023 Sideways' },
  { start: '2023-09-01', end: '2023-11-30', label: 'Q4 2023 Bull Start' },
  { start: '2022-06-01', end: '2022-08-31', label: '2022 Bear Market' },
  { start: '2022-11-01', end: '2023-01-31', label: 'FTX Crash Recovery' },
];

/**
 * A genuinely random date range somewhere in the last `yearsBack` years, with a random span
 * between minDays and maxDays. Used for held-out validation — the fixed TRAINING_DATE_RANGES
 * above are quarters chosen because we already know roughly what happened in them; a random
 * window has no such selection bias. If the random window predates a symbol's Binance listing,
 * fetchSimulationData simply returns few/no candles and the caller skips it — no special
 * handling needed.
 */
export function randomDateRangeInLastYears(yearsBack: number, minDays = 30, maxDays = 90): DateRange {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const spanDays = Math.round(minDays + Math.random() * (maxDays - minDays));
  const spanMs = spanDays * DAY_MS;
  const earliestStart = now - yearsBack * 365 * DAY_MS;
  const latestStart = now - spanMs - DAY_MS; // leave at least a day before "today"
  const start = earliestStart + Math.random() * Math.max(0, latestStart - earliestStart);
  const end = start + spanMs;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const startStr = iso(start);
  const endStr = iso(end);
  return { start: startStr, end: endStr, label: `Random ${startStr} → ${endStr}` };
}

export interface AutoSimConfig {
  symbols: string[];
  timeframes: string[];
  dateRanges: DateRange[];
  batchSize: number;
  maxIterations: number;
  targetProfitFactor: number;
  capitalPerRun: number;
  // When set, every iteration generates a fresh random date range (see
  // randomDateRangeInLastYears) instead of picking from config.dateRanges — for held-out
  // validation against periods that weren't hand-picked.
  useRandomDateRanges?: boolean;
  randomDateRangeYearsBack?: number;
  // Forwarded as-is into each run's SimConfig (spread after the symbol/timeframe/date fields
  // below, so a caller can override allowedPatterns, minRR, minConfidence, etc. for a
  // controlled experiment without touching simulator.ts's defaults for every other caller).
  simConfigOverrides?: Partial<SimConfig>;
}

export function defaultAutoSimConfig(): AutoSimConfig {
  return {
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    timeframes: ['5m', '15m', '1h'],
    dateRanges: TRAINING_DATE_RANGES,
    batchSize: 5,
    maxIterations: 20,
    targetProfitFactor: 1.5,
    capitalPerRun: 100000,
    useRandomDateRanges: false,
    randomDateRangeYearsBack: 10,
  };
}

export interface AutoSimRunResult {
  runId: string;
  batchId: string;
  iteration: number;
  symbol: string;
  timeframe: string;
  dateRange: DateRange;
  simulationId: string;

  finalCapital: number;
  totalReturn: number;
  profitFactor: number;
  winRate: number; // 0-100, matching SimResult's own scale
  trades: number;

  winningPatterns: string[];
  losingPatterns: string[];
  diagnosis: string[];

  timestamp: number;
}

export type AutoSimProgressFn = (msg: string, pct: number) => void;
export type AutoSimResultFn = (result: AutoSimRunResult) => void;

// ─── Diagnosis ──────────────────────────────────────────────────────────
// winRate/totalReturn/maxDrawdown are all 0-100 on SimResult — NOT 0-1 fractions.

function buildDiagnosis(simResult: SimResult, dateRange: DateRange): {
  diagnosis: string[];
  winningPatterns: string[];
  losingPatterns: string[];
} {
  const diagnosis: string[] = [];
  const winningPatterns: string[] = [];
  const losingPatterns: string[] = [];

  Object.entries(simResult.patternStats).forEach(([pattern, stats]) => {
    if (stats.trades < 3) return;
    if (stats.winRate > 60) {
      winningPatterns.push(`${pattern} (${stats.winRate.toFixed(0)}% WR)`);
      diagnosis.push(`✓ ${pattern} worked well: ${stats.winRate.toFixed(0)}% win rate, ${stats.trades} trades`);
    } else if (stats.winRate < 40) {
      losingPatterns.push(`${pattern} (${stats.winRate.toFixed(0)}% WR)`);
      diagnosis.push(`✗ ${pattern} struggled: only ${stats.winRate.toFixed(0)}% win rate in ${dateRange.label} — likely wrong regime fit`);
    }
  });

  if (simResult.totalReturn > 5) {
    diagnosis.unshift(`💰 Profitable run (+${simResult.totalReturn.toFixed(1)}%) — ${dateRange.label} suited this strategy`);
  } else if (simResult.totalReturn < -10) {
    diagnosis.unshift(`📉 Loss run (${simResult.totalReturn.toFixed(1)}%) — ${dateRange.label} conditions didn't suit the current strategy`);
    if (simResult.winRate < 40) {
      diagnosis.push(`⚠ Low win rate (${simResult.winRate.toFixed(0)}%) — pattern detection not suited to this period's regime`);
    }
    if (simResult.maxDrawdown > 15) {
      diagnosis.push(`⚠ High drawdown (${simResult.maxDrawdown.toFixed(1)}%) — consider tightening the regime filter for this market type`);
    }
    if (simResult.totalSignals > 0) {
      const takePct = (simResult.totalTrades / simResult.totalSignals) * 100;
      if (takePct < 3) {
        diagnosis.push(`⚠ Only ${takePct.toFixed(1)}% of signals taken — filters may be too strict for this period`);
      }
    }
  }

  if (diagnosis.length === 0) {
    diagnosis.push(`Result: ${simResult.totalReturn >= 0 ? '+' : ''}${simResult.totalReturn.toFixed(1)}% over ${simResult.totalTrades} trades — no strong pattern-level signal either way`);
  }

  return { diagnosis, winningPatterns, losingPatterns };
}

// ─── Runner ─────────────────────────────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function runAutoSimBatch(
  config: AutoSimConfig,
  onProgress: AutoSimProgressFn,
  onResult: AutoSimResultFn,
  abortSignal?: AbortSignal,
): Promise<void> {
  const db = getDB();
  const batchId = crypto.randomUUID();
  const recentResults: AutoSimRunResult[] = [];

  for (let iteration = 0; iteration < config.maxIterations; iteration++) {
    if (abortSignal?.aborted) {
      onProgress('Stopped by user.', (iteration / config.maxIterations) * 100);
      break;
    }

    const symbol = pick(config.symbols);
    const timeframe = pick(config.timeframes);
    const dateRange = config.useRandomDateRanges
      ? randomDateRangeInLastYears(config.randomDateRangeYearsBack ?? 10)
      : pick(config.dateRanges);
    const basePct = (iteration / config.maxIterations) * 100;

    onProgress(`Run ${iteration + 1}/${config.maxIterations}: ${symbol} ${timeframe} ${dateRange.label}`, basePct);

    try {
      const candles = await fetchSimulationData(
        symbol, timeframe, dateRange.start, dateRange.end,
        (pct, msg) => onProgress(`  ${msg}`, basePct + pct * 0.003),
        abortSignal,
      );
      if (abortSignal?.aborted) break;
      if (candles.length < 150) {
        onProgress(`  Skipped — only ${candles.length} candles available for ${dateRange.label}`, basePct);
        continue;
      }

      let htfCandles: Candle[] | undefined;
      if (isHtfEligible(timeframe)) {
        try {
          htfCandles = await fetchSimulationData(symbol, '1h', dateRange.start, dateRange.end, () => {}, abortSignal);
        } catch (err) {
          console.warn('HTF candle fetch failed, continuing without HTF confirmation:', err);
        }
      }

      let patternEdgeHints: Awaited<ReturnType<typeof getPatternEdgeHints>> | undefined;
      try {
        patternEdgeHints = await getPatternEdgeHints();
      } catch (err) {
        console.warn('Failed to load pattern edge hints:', err);
      }

      const simConfig: SimConfig = {
        ...defaultSimConfig(),
        symbol,
        interval: timeframe,
        startDate: dateRange.start,
        endDate: dateRange.end,
        startingCapital: config.capitalPerRun,
        ...config.simConfigOverrides,
      };

      const simResult = await runSimulation(
        simConfig, candles,
        (pct, msg) => onProgress(`  ${msg}`, basePct + 5 + pct * 0.003),
        abortSignal, patternEdgeHints, htfCandles,
      );
      if (abortSignal?.aborted) break;

      const simulationId = await recordSimulation(simResult, candles);
      const { diagnosis, winningPatterns, losingPatterns } = buildDiagnosis(simResult, dateRange);

      const autoResult: AutoSimRunResult = {
        runId: `auto_${Date.now()}_${iteration}`,
        batchId,
        iteration,
        symbol,
        timeframe,
        dateRange,
        simulationId,
        finalCapital: simResult.finalCapital,
        totalReturn: simResult.totalReturn,
        profitFactor: isFinite(simResult.profitFactor) ? simResult.profitFactor : 9.99,
        winRate: simResult.winRate,
        trades: simResult.totalTrades,
        winningPatterns,
        losingPatterns,
        diagnosis,
        timestamp: Date.now(),
      };

      await db.autoSimRuns.add({
        runId: autoResult.runId,
        batchId: autoResult.batchId,
        iteration: autoResult.iteration,
        simulationId: autoResult.simulationId,
        symbol: autoResult.symbol,
        timeframe: autoResult.timeframe,
        dateRangeLabel: autoResult.dateRange.label,
        startDate: autoResult.dateRange.start,
        endDate: autoResult.dateRange.end,
        finalCapital: autoResult.finalCapital,
        totalReturn: autoResult.totalReturn,
        profitFactor: autoResult.profitFactor,
        winRate: autoResult.winRate,
        trades: autoResult.trades,
        winningPatterns: autoResult.winningPatterns,
        losingPatterns: autoResult.losingPatterns,
        diagnosis: autoResult.diagnosis,
        timestamp: autoResult.timestamp,
      });
      recentResults.push(autoResult);
      onResult(autoResult);
    } catch (err) {
      console.warn(`Auto-sim iteration ${iteration} failed:`, err);
      onProgress(`  ⚠ Run failed: ${err instanceof Error ? err.message : 'unknown error'}`, basePct);
    }

    // Learning cycle — reads the real edge registry (already updated by recordSimulation
    // above) and surfaces what changed, rather than computing a second, disconnected one.
    if ((iteration + 1) % config.batchSize === 0) {
      onProgress('🧠 Running learning cycle...', basePct);
      try {
        const report = await generateIntelligenceReport();
        onProgress(`📊 Learning complete: ${report.weightAdjustments.length} weight change(s), health score ${report.overallHealthScore}/100`, basePct);
        report.insights.forEach(insight => onProgress(insight, basePct));
      } catch (err) {
        console.warn('Learning cycle failed:', err);
      }

      // Lightweight rejected-signal check: sample the last 7 days of live rejections
      // and promote patterns that show >70% hypothetical win rate with ≥20 samples.
      try {
        const rejectionSummary = await getLightweightRejectionSummary(7);
        const db = getDB();
        for (const summary of rejectionSummary) {
          if (summary.hypotheticalWinRate >= 70 && summary.sampleSize >= 20) {
            // Promote this pattern's scoreMultiplier in patternEvolution
            const existing = await db.patternEvolution
              .where('pattern').equals(summary.pattern).first();
            const newMultiplier = Math.min(1.5, (existing?.scoreMultiplier ?? 1.0) * 1.1);
            if (existing?.id !== undefined) {
              await db.patternEvolution.update(existing.id, {
                scoreMultiplier: newMultiplier,
                status: 'promoted',
                lastUpdated: Date.now(),
              });
            } else {
              await db.patternEvolution.add({
                pattern: summary.pattern,
                status: 'promoted',
                totalTrades: 0,
                currentWinRate: summary.hypotheticalWinRate,
                currentProfitFactor: 1.5,
                currentExpectancy: 0,
                currentSharpe: 0,
                currentRecoveryFactor: 0,
                scoreMultiplier: newMultiplier,
                lastUpdated: Date.now(),
                history: JSON.stringify([{
                  date: new Date().toISOString(),
                  reason: `Rejected-signal analyzer: ${summary.hypotheticalWinRate.toFixed(0)}% hypothetical WR on ${summary.sampleSize} sampled rejections`,
                  multiplierBefore: 1.0,
                  multiplierAfter: newMultiplier,
                }]),
              });
            }
            onProgress(
              `🔍 Rejected signals: ${summary.pattern} shows ${summary.hypotheticalWinRate.toFixed(0)}% hyp. WR — scoreMultiplier → ${newMultiplier.toFixed(2)}`,
              basePct,
            );
          }
        }
        if (rejectionSummary.length > 0) {
          const highWR = rejectionSummary.filter(s => s.hypotheticalWinRate >= 70 && s.sampleSize >= 20);
          if (highWR.length === 0) {
            onProgress(`🔍 Rejected signals checked: no patterns exceeded 70% hypothetical WR threshold`, basePct);
          }
        }
      } catch (err) {
        // Non-fatal: rejection analysis depends on live signal data which may not exist during backtest runs
        console.warn('Lightweight rejection check failed:', err);
      }
    }

    // Stop early if the target profit factor has been sustained over the last 10 runs.
    const window = recentResults.slice(-10);
    if (window.length >= 5) {
      const avgPF = window.reduce((a, r) => a + r.profitFactor, 0) / window.length;
      if (avgPF >= config.targetProfitFactor) {
        onProgress(`🎯 Target profit factor ${config.targetProfitFactor} achieved (avg ${avgPF.toFixed(2)} over last ${window.length} runs)! Stopping.`, 100);
        break;
      }
    }
  }

  if (!abortSignal?.aborted) {
    try {
      await generateIntelligenceReport();
    } catch (err) {
      console.warn('Final learning cycle failed:', err);
    }
  }
  onProgress('Done.', 100);
}

// ─── History ────────────────────────────────────────────────────────────

export async function getAutoSimHistory(limit = 20): Promise<AutoSimRunRecord[]> {
  const db = getDB();
  return db.autoSimRuns.orderBy('timestamp').reverse().limit(limit).toArray();
}

export async function getAutoSimRunsByBatch(batchId: string): Promise<AutoSimRunRecord[]> {
  const db = getDB();
  return db.autoSimRuns.where('batchId').equals(batchId).sortBy('iteration');
}
