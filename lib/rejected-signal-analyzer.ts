/**
 * TradeFlow — Rejected Signal Analyzer
 *
 * Analyzes every live signal the strategy did NOT take (db.signalMemory where wasTaken=false),
 * fetches forward candles from Binance to compute the hypothetical outcome, and surfaces
 * patterns in wrongly-rejected signals so the config can be tuned.
 *
 * Key constraint: wasWrongToReject is NEVER set true for fundamental rejections
 * (low ATR, counter-trend conditions). Only tunable filter reasons can surface as
 * wrong rejections.
 */

import { getDB, type SignalMemoryRecord } from './db';

// ─── Types ───────────────────────────────────────────────────────────────────

export type HypotheticalOutcome = 'tp1_hit' | 'tp2_hit' | 'stopped_out' | 'expired' | 'pending';

export interface RejectedSignalOutcome {
  signalId: number;
  symbol: string;
  timeframe: string;
  timestamp: number;
  pattern: string;
  direction: 'long' | 'short';
  regime: string;
  rejectionReason: string;

  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  edgeScore: number;
  atr: number;       // stored as pct (atr / price) in signalMemory
  volumeRatio: number;

  hypotheticalOutcome: HypotheticalOutcome;
  barsToOutcome: number | null;
  hypotheticalPnlR: number; // +1=TP1, +2=TP2, -1=stop, 0=expired
  wasWrongToReject: boolean;

  analyzedAt: number;
}

export interface DiscoveredEdge {
  pattern: string;
  regime: string;
  rejectionReason: string;
  sampleCount: number;
  hypotheticalWinRate: number; // 0-100
  avgPnlR: number;
  recommendation: string;
}

export interface Recommendation {
  type: 'lower_score_floor' | 'disable_session_filter' | 'reduce_htf_strictness' | 'expand_patterns' | 'review_rr' | 'review_expectation';
  description: string;
  potentialImpact: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface RejectionAnalysisReport {
  generatedAt: number;
  totalRejected: number;
  analyzed: number;
  skipped: number;

  overallWouldHaveWonPct: number;
  overallAvgPnlR: number;
  wrongToRejectCount: number;

  byReason: Record<string, { count: number; wouldHaveWon: number; winRate: number; avgPnlR: number }>;
  byPattern: Record<string, { count: number; wouldHaveWon: number; winRate: number; avgPnlR: number }>;
  byRegime: Record<string, { count: number; wouldHaveWon: number; winRate: number }>;

  discoveredEdges: DiscoveredEdge[];
  outcomes: RejectedSignalOutcome[];
  scoreFloorBoundary: RejectedSignalOutcome[];   // score rejections that would have won
  recommendations: Recommendation[];
  correctlyAvoided: RejectedSignalOutcome[];      // rejected AND would have lost
}

// ─── Constants ───────────────────────────────────────────────────────────────

// Rejection reasons that are tunable — wasWrongToReject CAN be true
const TUNABLE_REASONS = new Set([
  'Negative Expected Value',
  'Score too low',
  'R:R insufficient',
  'Session filter',
  'HTF disagreement',
  'Daily limit',
  'Weekly limit',
  'Loss streak cooldown',
  'Confidence too low',
  'Pattern not in allowed list',
  'Regime filter',
]);

// Fundamental reasons — wasWrongToReject is ALWAYS false
// (counter-trend, low ATR, invalid stop geometry)
const FUNDAMENTAL_REASONS = new Set([
  'Low ATR',
  'Counter-trend',
  'Invalid stop distance',
  'Pattern logic failed',
  'Validation failed',
]);

const MAX_FORWARD_BARS = 50;   // max candles to walk forward per signal
const BATCH_SIZE = 10;          // signals per Binance API burst
const BATCH_DELAY_MS = 500;     // pause between bursts (rate limit safety)
const LOW_ATR_THRESHOLD = 0.001; // atr pct < 0.1% = fundamentally low volatility

const PROGRESS_KEY = 'rejected_analyzer_progress';

// ─── Binance Forward Candle Fetch ─────────────────────────────────────────────

interface MinimalCandle {
  time: number; // unix seconds
  high: number;
  low: number;
  close: number;
}

export async function fetchForwardCandles(
  symbol: string,
  interval: string,
  fromTimestampMs: number,
  limit = MAX_FORWARD_BARS,
): Promise<MinimalCandle[]> {
  const url = `https://api.binance.com/api/v3/klines` +
    `?symbol=${symbol.toUpperCase()}&interval=${interval}` +
    `&startTime=${fromTimestampMs}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${res.statusText}`);
  const raw = await res.json() as [number, string, string, string, string, ...unknown[]][];
  return raw.map(k => ({
    time: Math.floor(k[0] / 1000),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));
}

// ─── Outcome Calculator ───────────────────────────────────────────────────────

export function calcHypotheticalOutcome(
  signal: Pick<RejectedSignalOutcome, 'direction' | 'entry' | 'stop' | 'tp1' | 'tp2'>,
  forwardCandles: MinimalCandle[],
): { outcome: HypotheticalOutcome; barsToOutcome: number | null; pnlR: number } {
  const { direction, entry, stop, tp1, tp2 } = signal;
  const isLong = direction === 'long';
  let tp1Hit = false;

  for (let i = 0; i < forwardCandles.length; i++) {
    const c = forwardCandles[i];

    if (!tp1Hit) {
      if (isLong) {
        // Check stop first (conservative: assume adverse move happens intrabar)
        if (c.low <= stop) return { outcome: 'stopped_out', barsToOutcome: i + 1, pnlR: -1 };
        if (c.high >= tp1) {
          tp1Hit = true;
          if (c.high >= tp2) return { outcome: 'tp2_hit', barsToOutcome: i + 1, pnlR: 2 };
        }
      } else {
        if (c.high >= stop) return { outcome: 'stopped_out', barsToOutcome: i + 1, pnlR: -1 };
        if (c.low <= tp1) {
          tp1Hit = true;
          if (c.low <= tp2) return { outcome: 'tp2_hit', barsToOutcome: i + 1, pnlR: 2 };
        }
      }
    } else {
      // TP1 already hit; stop is at breakeven (entry)
      if (isLong) {
        if (c.low <= entry) return { outcome: 'tp1_hit', barsToOutcome: i + 1, pnlR: 1 }; // stopped at BE — count TP1 banked
        if (c.high >= tp2) return { outcome: 'tp2_hit', barsToOutcome: i + 1, pnlR: 2 };
      } else {
        if (c.high >= entry) return { outcome: 'tp1_hit', barsToOutcome: i + 1, pnlR: 1 };
        if (c.low <= tp2) return { outcome: 'tp2_hit', barsToOutcome: i + 1, pnlR: 2 };
      }
    }
  }

  if (tp1Hit) return { outcome: 'tp1_hit', barsToOutcome: forwardCandles.length, pnlR: 1 };
  return { outcome: 'expired', barsToOutcome: null, pnlR: 0 };
}

// ─── Tunable / Fundamental Classifier ────────────────────────────────────────

function isTunableReason(reason: string): boolean {
  if (FUNDAMENTAL_REASONS.has(reason)) return false;
  if (TUNABLE_REASONS.has(reason)) return true;
  // Default: treat unknown reason as tunable (conservative — we'd rather flag for review)
  return true;
}

function isFundamentalRejection(signal: SignalMemoryRecord): boolean {
  // Low ATR check: atr is stored as percentage (atr / price)
  if (signal.atr < LOW_ATR_THRESHOLD) return true;
  // If rejectionReason is explicitly a fundamental one, honour it
  if (signal.rejectionReason && FUNDAMENTAL_REASONS.has(signal.rejectionReason)) return true;
  return false;
}

// ─── Progress Persistence ─────────────────────────────────────────────────────

interface AnalysisProgress {
  processedIds: number[];
  outcomes: RejectedSignalOutcome[];
  startedAt: number;
}

function loadProgress(): AnalysisProgress | null {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AnalysisProgress;
  } catch { return null; }
}

function saveProgress(progress: AnalysisProgress): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch { /* quota exceeded — ignore */ }
}

export function clearAnalysisProgress(): void {
  try { localStorage.removeItem(PROGRESS_KEY); } catch { /* ignore */ }
}

// ─── Report Builder ───────────────────────────────────────────────────────────

export function buildAnalysisReport(
  outcomes: RejectedSignalOutcome[],
  totalRejected: number,
): RejectionAnalysisReport {
  const analyzed = outcomes.length;
  const skipped = totalRejected - analyzed;

  const wins = outcomes.filter(o => o.hypotheticalOutcome === 'tp1_hit' || o.hypotheticalOutcome === 'tp2_hit');
  const losses = outcomes.filter(o => o.hypotheticalOutcome === 'stopped_out');
  const completed = outcomes.filter(o => o.hypotheticalOutcome !== 'expired' && o.hypotheticalOutcome !== 'pending');
  const overallWouldHaveWonPct = completed.length > 0 ? (wins.length / completed.length) * 100 : 0;
  const overallAvgPnlR = outcomes.length > 0
    ? outcomes.reduce((s, o) => s + o.hypotheticalPnlR, 0) / outcomes.length
    : 0;
  const wrongToRejectCount = outcomes.filter(o => o.wasWrongToReject).length;

  // ── by reason ──
  const byReason: RejectionAnalysisReport['byReason'] = {};
  for (const o of outcomes) {
    const r = o.rejectionReason || 'Unknown';
    if (!byReason[r]) byReason[r] = { count: 0, wouldHaveWon: 0, winRate: 0, avgPnlR: 0 };
    byReason[r].count++;
    if (o.hypotheticalOutcome === 'tp1_hit' || o.hypotheticalOutcome === 'tp2_hit') byReason[r].wouldHaveWon++;
    byReason[r].avgPnlR += o.hypotheticalPnlR;
  }
  for (const [reasonKey, r] of Object.entries(byReason)) {
    const completedInGroup = r.count - outcomes.filter(o => (o.rejectionReason || 'Unknown') === reasonKey && o.hypotheticalOutcome === 'expired').length;
    r.winRate = completedInGroup > 0 ? (r.wouldHaveWon / completedInGroup) * 100 : 0;
    r.avgPnlR = r.count > 0 ? r.avgPnlR / r.count : 0;
  }

  // ── by pattern ──
  const byPattern: RejectionAnalysisReport['byPattern'] = {};
  for (const o of outcomes) {
    if (!byPattern[o.pattern]) byPattern[o.pattern] = { count: 0, wouldHaveWon: 0, winRate: 0, avgPnlR: 0 };
    byPattern[o.pattern].count++;
    if (o.hypotheticalOutcome === 'tp1_hit' || o.hypotheticalOutcome === 'tp2_hit') byPattern[o.pattern].wouldHaveWon++;
    byPattern[o.pattern].avgPnlR += o.hypotheticalPnlR;
  }
  for (const p of Object.values(byPattern)) {
    const completedInGroup = outcomes.filter(o => byPattern[o.pattern] === p && o.hypotheticalOutcome !== 'expired').length;
    p.winRate = completedInGroup > 0 ? (p.wouldHaveWon / completedInGroup) * 100 : 0;
    p.avgPnlR = p.count > 0 ? p.avgPnlR / p.count : 0;
  }
  // recalculate winRate correctly by pattern name
  for (const [name, stat] of Object.entries(byPattern)) {
    const group = outcomes.filter(o => o.pattern === name);
    const completedGroup = group.filter(o => o.hypotheticalOutcome !== 'expired' && o.hypotheticalOutcome !== 'pending');
    const wonGroup = group.filter(o => o.hypotheticalOutcome === 'tp1_hit' || o.hypotheticalOutcome === 'tp2_hit');
    stat.winRate = completedGroup.length > 0 ? (wonGroup.length / completedGroup.length) * 100 : 0;
    stat.avgPnlR = group.length > 0 ? group.reduce((s, o) => s + o.hypotheticalPnlR, 0) / group.length : 0;
  }

  // ── by regime ──
  const byRegime: RejectionAnalysisReport['byRegime'] = {};
  for (const o of outcomes) {
    if (!byRegime[o.regime]) byRegime[o.regime] = { count: 0, wouldHaveWon: 0, winRate: 0 };
    byRegime[o.regime].count++;
    if (o.hypotheticalOutcome === 'tp1_hit' || o.hypotheticalOutcome === 'tp2_hit') byRegime[o.regime].wouldHaveWon++;
  }
  for (const [name, stat] of Object.entries(byRegime)) {
    const group = outcomes.filter(o => o.regime === name && o.hypotheticalOutcome !== 'expired' && o.hypotheticalOutcome !== 'pending');
    stat.winRate = group.length > 0 ? (stat.wouldHaveWon / group.length) * 100 : 0;
  }

  // ── discovered edges ──
  const discoveredEdges: DiscoveredEdge[] = [];
  for (const [patternName, pStat] of Object.entries(byPattern)) {
    if (pStat.count < 5) continue;
    if (pStat.winRate >= 60) {
      discoveredEdges.push({
        pattern: patternName,
        regime: 'all',
        rejectionReason: 'Mixed',
        sampleCount: pStat.count,
        hypotheticalWinRate: pStat.winRate,
        avgPnlR: pStat.avgPnlR,
        recommendation: `${patternName} shows ${pStat.winRate.toFixed(0)}% hypothetical win rate across ${pStat.count} rejected signals — consider including it in allowed patterns or relaxing the score floor for this pattern.`,
      });
    }
  }
  // Per-pattern per-regime edges (need ≥5 samples)
  for (const [patternName] of Object.entries(byPattern)) {
    const regimes = Array.from(new Set(outcomes.filter(o => o.pattern === patternName).map(o => o.regime)));
    for (const regime of regimes) {
      const group = outcomes.filter(o => o.pattern === patternName && o.regime === regime);
      if (group.length < 5) continue;
      const completedGroup = group.filter(o => o.hypotheticalOutcome !== 'expired' && o.hypotheticalOutcome !== 'pending');
      if (completedGroup.length < 5) continue;
      const winGroup = completedGroup.filter(o => o.hypotheticalOutcome === 'tp1_hit' || o.hypotheticalOutcome === 'tp2_hit');
      const wr = (winGroup.length / completedGroup.length) * 100;
      const avgR = group.reduce((s, o) => s + o.hypotheticalPnlR, 0) / group.length;
      if (wr >= 65 && !discoveredEdges.find(e => e.pattern === patternName && e.regime === regime)) {
        discoveredEdges.push({
          pattern: patternName,
          regime,
          rejectionReason: group[0]?.rejectionReason ?? 'Unknown',
          sampleCount: group.length,
          hypotheticalWinRate: wr,
          avgPnlR: avgR,
          recommendation: `${patternName} in ${regime} regime: ${wr.toFixed(0)}% WR on ${group.length} rejected signals. Consider loosening filters in this regime.`,
        });
      }
    }
  }
  discoveredEdges.sort((a, b) => b.hypotheticalWinRate - a.hypotheticalWinRate);

  // ── score floor boundary ──
  const scoreFloorBoundary = outcomes.filter(
    o => (o.rejectionReason === 'Score too low' || o.rejectionReason === 'Negative Expected Value') &&
      (o.hypotheticalOutcome === 'tp1_hit' || o.hypotheticalOutcome === 'tp2_hit'),
  );

  // ── recommendations ──
  const recommendations: Recommendation[] = [];
  const negEV = byReason['Negative Expected Value'];
  if (negEV && negEV.count >= 5) {
    const negEVWR = negEV.winRate;
    if (negEVWR >= 50) {
      recommendations.push({
        type: 'review_expectation',
        description: `${negEVWR.toFixed(0)}% of "Negative Expected Value" rejections would have won. The expected value calculation may be too conservative.`,
        potentialImpact: `Potentially ${negEV.wouldHaveWon} additional winning trades over this period.`,
        confidence: negEVWR >= 65 ? 'high' : 'medium',
      });
    }
  }
  const scoreLow = byReason['Score too low'];
  if (scoreLow && scoreLow.count >= 5 && scoreLow.winRate >= 45) {
    recommendations.push({
      type: 'lower_score_floor',
      description: `${scoreLow.winRate.toFixed(0)}% of "Score too low" rejections would have been winners. Consider reducing the score floor by 5-10 points.`,
      potentialImpact: `Up to ${scoreLow.wouldHaveWon} additional profitable trades.`,
      confidence: scoreLow.winRate >= 60 ? 'high' : 'medium',
    });
  }
  const htf = byReason['HTF disagreement'];
  if (htf && htf.count >= 5 && htf.winRate >= 55) {
    recommendations.push({
      type: 'reduce_htf_strictness',
      description: `${htf.winRate.toFixed(0)}% of HTF-rejected signals would have won. HTF confirmation may be overly strict.`,
      potentialImpact: `${htf.wouldHaveWon} missed winners due to HTF filter.`,
      confidence: 'medium',
    });
  }
  const session = byReason['Session filter'];
  if (session && session.count >= 5 && session.winRate >= 50) {
    recommendations.push({
      type: 'disable_session_filter',
      description: `Session-filtered signals show ${session.winRate.toFixed(0)}% win rate. The session window may be cutting valid signals.`,
      potentialImpact: `${session.wouldHaveWon} potential wins outside the configured session.`,
      confidence: 'low',
    });
  }
  const rr = byReason['R:R insufficient'];
  if (rr && rr.count >= 5 && rr.winRate >= 55) {
    recommendations.push({
      type: 'review_rr',
      description: `${rr.winRate.toFixed(0)}% of R:R-rejected signals hit TP1 or TP2. The minRR threshold may be too strict.`,
      potentialImpact: `${rr.wouldHaveWon} signals would have been profitable.`,
      confidence: 'medium',
    });
  }

  // ── correctly avoided ──
  const correctlyAvoided = outcomes.filter(o => o.hypotheticalOutcome === 'stopped_out');

  return {
    generatedAt: Date.now(),
    totalRejected,
    analyzed,
    skipped,
    overallWouldHaveWonPct,
    overallAvgPnlR,
    wrongToRejectCount,
    byReason,
    byPattern,
    byRegime,
    discoveredEdges,
    outcomes,
    scoreFloorBoundary,
    recommendations,
    correctlyAvoided,
  };
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export type AnalysisProgressFn = (msg: string, pct: number, processedSoFar: number, total: number) => void;

export async function analyzeRejectedSignals(
  daysBack = 7,
  onProgress: AnalysisProgressFn = () => {},
  resumeFromSaved = true,
  abortSignal?: AbortSignal,
): Promise<RejectionAnalysisReport> {
  const db = getDB();
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;

  // Load all rejected signals from DB
  const allRejected = await db.signalMemory
    .where('wasTaken')
    .equals(0) // Dexie stores booleans as 0/1
    .filter(r => r.timestamp >= cutoff)
    .toArray();

  const totalRejected = allRejected.length;
  onProgress(`Found ${totalRejected} rejected signals in the last ${daysBack} days`, 0, 0, totalRejected);

  if (totalRejected === 0) {
    return buildAnalysisReport([], 0);
  }

  // Resume from saved progress if available
  const saved = resumeFromSaved ? loadProgress() : null;
  const processedIds = new Set(saved?.processedIds ?? []);
  const outcomes: RejectedSignalOutcome[] = saved?.outcomes ?? [];

  const pending = allRejected.filter(s => s.id !== undefined && !processedIds.has(s.id!));
  onProgress(`Resuming: ${outcomes.length} already analyzed, ${pending.length} remaining`, 5, outcomes.length, totalRejected);

  // Process in batches
  for (let batchStart = 0; batchStart < pending.length; batchStart += BATCH_SIZE) {
    if (abortSignal?.aborted) break;

    const batch = pending.slice(batchStart, batchStart + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(signal => analyzeOneSignal(signal)),
    );

    for (let j = 0; j < batchResults.length; j++) {
      const res = batchResults[j];
      const signal = batch[j];
      if (res.status === 'fulfilled' && res.value) {
        outcomes.push(res.value);
        if (signal.id !== undefined) processedIds.add(signal.id);
      } else if (signal.id !== undefined) {
        // Mark as processed even on failure so we don't retry indefinitely
        processedIds.add(signal.id);
      }
    }

    // Persist progress
    saveProgress({ processedIds: Array.from(processedIds), outcomes, startedAt: saved?.startedAt ?? Date.now() });

    const processed = outcomes.length;
    const pct = 5 + (processed / totalRejected) * 90;
    onProgress(
      `Analyzed ${processed}/${totalRejected} signals (batch ${Math.ceil((batchStart + BATCH_SIZE) / BATCH_SIZE)}/${Math.ceil(pending.length / BATCH_SIZE)})`,
      pct,
      processed,
      totalRejected,
    );

    // Rate limit: pause between batches
    if (batchStart + BATCH_SIZE < pending.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  onProgress('Building report...', 97, outcomes.length, totalRejected);
  const report = buildAnalysisReport(outcomes, totalRejected);
  onProgress('Done.', 100, outcomes.length, totalRejected);

  return report;
}

async function analyzeOneSignal(signal: SignalMemoryRecord): Promise<RejectedSignalOutcome | null> {
  const id = signal.id;
  if (id === undefined) return null;

  const rejectionReason = signal.rejectionReason ?? 'Unknown';
  const fundamental = isFundamentalRejection(signal);

  let hypotheticalOutcome: HypotheticalOutcome = 'pending';
  let barsToOutcome: number | null = null;
  let hypotheticalPnlR = 0;

  try {
    const forwardCandles = await fetchForwardCandles(signal.symbol, signal.timeframe, signal.timestamp, MAX_FORWARD_BARS);
    if (forwardCandles.length > 0) {
      const result = calcHypotheticalOutcome(signal as Parameters<typeof calcHypotheticalOutcome>[0], forwardCandles);
      hypotheticalOutcome = result.outcome;
      barsToOutcome = result.barsToOutcome;
      hypotheticalPnlR = result.pnlR;
    }
  } catch {
    // Fetch failed — leave as 'pending' and skip
    return null;
  }

  const isWin = hypotheticalOutcome === 'tp1_hit' || hypotheticalOutcome === 'tp2_hit';
  const wasWrongToReject =
    !fundamental &&
    isTunableReason(rejectionReason) &&
    isWin;

  return {
    signalId: id,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    timestamp: signal.timestamp,
    pattern: signal.pattern,
    direction: signal.direction,
    regime: signal.regime,
    rejectionReason,
    entry: signal.entry,
    stop: signal.stop,
    tp1: signal.tp1,
    tp2: signal.tp2,
    edgeScore: signal.edgeScore,
    atr: signal.atr,
    volumeRatio: signal.volumeRatio,
    hypotheticalOutcome,
    barsToOutcome,
    hypotheticalPnlR,
    wasWrongToReject,
    analyzedAt: Date.now(),
  };
}

// ─── Lightweight check for auto-simulator integration ─────────────────────────
// Returns only the pattern-level summary — does NOT update any state.

export interface LightweightRejectionSummary {
  pattern: string;
  rejectedCount: number;
  hypotheticalWinRate: number; // 0-100
  sampleSize: number;
}

export async function getLightweightRejectionSummary(
  daysBack = 7,
): Promise<LightweightRejectionSummary[]> {
  const db = getDB();
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;

  const rejected = await db.signalMemory
    .where('wasTaken')
    .equals(0)
    .filter(r => r.timestamp >= cutoff)
    .toArray();

  if (rejected.length === 0) return [];

  // Sample at most 30 signals (rate limit friendly — no large bursts)
  const sample = rejected.slice(0, 30);
  const results: RejectedSignalOutcome[] = [];

  for (let i = 0; i < sample.length; i += BATCH_SIZE) {
    const batch = sample.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map(s => analyzeOneSignal(s)));
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) results.push(r.value);
    }
    if (i + BATCH_SIZE < sample.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  // Aggregate by pattern
  const byPattern = new Map<string, { won: number; total: number }>();
  for (const o of results) {
    if (!byPattern.has(o.pattern)) byPattern.set(o.pattern, { won: 0, total: 0 });
    const s = byPattern.get(o.pattern)!;
    s.total++;
    if (o.hypotheticalOutcome === 'tp1_hit' || o.hypotheticalOutcome === 'tp2_hit') s.won++;
  }

  return Array.from(byPattern.entries()).map(([pattern, { won, total }]) => ({
    pattern,
    rejectedCount: rejected.filter(r => r.pattern === pattern).length,
    hypotheticalWinRate: total > 0 ? (won / total) * 100 : 0,
    sampleSize: total,
  }));
}
