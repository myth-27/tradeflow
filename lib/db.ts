/**
 * TradeFlow V3 — Persistent Memory Database
 *
 * Uses IndexedDB (via Dexie) for structured, indexed, persistent storage.
 * All signals, simulations, edge stats, learning snapshots, and feature weights
 * are stored here. The system NEVER FORGETS.
 *
 * Backup/export path: D:\trade_data
 */

import Dexie, { type Table } from 'dexie';

// ─── Schema Types ─────────────────────────────────────────────────────────────

export type MarketRegime =
  | 'strong_uptrend' | 'weak_uptrend'
  | 'strong_downtrend' | 'weak_downtrend'
  | 'ranging' | 'low_volatility';

export type TradingSession = 'london' | 'new_york' | 'asia' | 'overlap';

export type SignalStatus =
  | 'detected' | 'waiting' | 'confirmed'
  | 'active' | 'expired' | 'invalidated';

export type TradeResult = 'win' | 'loss' | 'breakeven' | null;

// ─── Signal Memory (Phase 1) ─────────────────────────────────────────────────

export interface SignalMemoryRecord {
  id?: number;              // auto-increment
  timestamp: number;        // epoch ms
  symbol: string;
  timeframe: string;

  pattern: string;
  direction: 'long' | 'short';

  patternScore: number;     // raw pattern detection quality
  tradeScore: number;       // indicator confluence score
  edgeScore: number;        // final edge score (Phase 8)

  regime: MarketRegime;
  session: TradingSession;

  // Indicators at time of signal
  rsi: number;
  macd: number;
  atr: number;
  volumeRatio: number;

  // Order flow (Phase 9) — nullable until data available
  openInterest: number | null;
  fundingRate: number | null;
  cvd: number | null;
  liquidations: number | null;

  supportLevels: string;     // JSON stringified number[]
  resistanceLevels: string;  // JSON stringified number[]

  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number;

  signalStatus: SignalStatus;
  wasTaken: boolean;
  rejectionReason: string | null;

  result: TradeResult;
  rMultiple: number | null;
  holdingTime: number | null;  // in candles

  simulationId: string | null;

  // Feature vector for RAG similarity search (Phase 7)
  featureVector: string;     // JSON stringified number[]

  // Multi-timeframe context (Phase 10)
  htfBias: 'bullish' | 'bearish' | 'neutral' | null;
  mtfConfirmation: boolean | null;
}

// ─── Simulation Memory (Phase 2) ─────────────────────────────────────────────

export interface SimulationMemoryRecord {
  id?: number;
  simulationId: string;
  date: number;              // epoch ms
  symbol: string;
  timeframes: string;        // JSON stringified string[]
  dateRange: string;         // "2024-01-01 to 2024-06-01"

  // Config snapshot
  settings: string;          // JSON stringified config

  riskPerTrade: number;
  filters: string;           // JSON stringified filter settings

  entryRules: string;
  exitRules: string;
  regimeRules: string;

  // Results
  totalSignals: number;
  signalsTaken: number;
  signalsRejected: number;

  winRate: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  sharpeRatio: number;
  finalCapital: number;
  startingCapital: number;
  totalReturn: number;

  // All trades from simulation (stored as JSON blob)
  allTrades: string;         // JSON stringified trade array

  // Rejection breakdown (stored as JSON blob of RejectionStats)
  rejectionReasons?: string;

  // Metadata
  durationMs: number;        // how long the simulation took to run
  totalCandles: number;
}

// ─── Edge Stats (Phase 3) ─────────────────────────────────────────────────────

export type EdgeStatus =
  | 'learning'    // < 20 samples
  | 'emerging'    // 20-49 samples
  | 'active'      // 50-199 samples
  | 'confident'   // 200+ samples
  | 'degraded'    // PF < 0.9 at 50+ samples
  | 'disabled'    // PF < 0.8 at 100+ samples
  | 'promoted';   // PF > 1.8 at 100+ samples

export interface EdgeStatsRecord {
  id?: number;
  // Composite key fields
  pattern: string;
  symbol: string;
  timeframe: string;
  session: TradingSession;
  regime: MarketRegime;

  // Performance metrics
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;        // (winRate * avgWin) - (lossRate * avgLoss) in R
  avgRMultiple: number;
  bestRMultiple: number;
  worstRMultiple: number;
  sharpeRatio: number;
  maxDrawdown: number;
  recoveryFactor: number;
  avgHoldingTime: number;

  // Gross R tracking, used for profitFactor (added for sim-trade + status-classification support)
  grossWins?: number;
  grossLosses?: number;
  status?: EdgeStatus;
  last20WinRate?: number;
  last20RMultiple?: number;
  recentTrend?: 'improving' | 'degrading' | 'stable';
  firstSeenAt?: number;      // epoch ms
  // 'sim' | 'live' | 'mixed' — which data source(s) have contributed trades to this record
  dataSource?: 'sim' | 'live' | 'mixed';

  lastUpdated: number;       // epoch ms
}

// ─── Learning Snapshots (Phase 4) ─────────────────────────────────────────────

export interface LearningSnapshotRecord {
  id?: number;
  timestamp: number;
  totalTradesAnalyzed: number;
  triggerReason: string;      // "50_trade_cycle" | "manual" | "nightly"

  // JSON blobs for complex nested data
  findings: string;           // JSON: LearningFinding[]
  weightAdjustments: string;  // JSON: WeightAdjustment[]
  patternAdjustments: string; // JSON: PatternAdjustment[]
  performanceDelta: string;   // JSON: PerformanceDelta

  // Summary metrics for quick display
  patternsImproved: number;
  patternsDegraded: number;
  weightsChanged: number;
  overallExpectancyDelta: number;
}

// ─── Feature Weights (Phase 5) ────────────────────────────────────────────────

export interface FeatureWeightsRecord {
  id?: number;
  timestamp: number;
  tradesSinceLastUpdate: number;

  // Individual feature weights (0-100 scale)
  volume: number;
  rsi: number;
  macd: number;
  atr: number;
  openInterest: number;
  fundingRate: number;
  cvd: number;
  regime: number;
  session: number;
  historicalSimilarity: number;
  patternQuality: number;
  momentum: number;

  // History tracking
  reason: string;             // why this update was made
}

// ─── Feature Importance (Phase 6) ─────────────────────────────────────────────

export interface FeatureImportanceRecord {
  id?: number;
  timestamp: number;
  rankings: string;           // JSON: { feature: string, importance: number }[]
  totalSamplesUsed: number;
  method: string;             // "permutation" | "correlation" | "mutual_info"
}

// ─── Pattern Evolution (Phase 11) ─────────────────────────────────────────────

export interface PatternEvolutionRecord {
  id?: number;
  pattern: string;
  status: 'active' | 'promoted' | 'downgraded' | 'disabled';
  totalTrades: number;
  currentWinRate: number;
  currentProfitFactor: number;
  currentExpectancy: number;
  currentSharpe: number;
  currentRecoveryFactor: number;
  scoreMultiplier: number;    // 1.0 = normal, >1 = promoted, <1 = downgraded
  lastUpdated: number;
  history: string;            // JSON: status change history
}

// ─── Drawing Memory (Phase 12) ────────────────────────────────────────────────

export interface DrawingMemoryRecord {
  id?: number;
  drawingId: string;
  signalId: number | null;    // links to SignalMemoryRecord
  symbol: string;
  timeframe: string;
  drawingType: string;        // 'sr_zone' | 'trendline' | 'pattern_shape' | 'signal_line'
  data: string;               // JSON: drawing-specific data
  status: 'active' | 'expired' | 'hit_target' | 'hit_stop' | 'locked' | 'cleared';
  createdAt: number;
  expiresAt: number | null;
  lockedByUser: boolean;
}

// ─── Candle Snapshots (Phase 13) ──────────────────────────────────────────────
// Raw prev/next candle structure around every signal — future visual (CNN/LSTM) ML training.

export interface SerializedCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface CandleSnapshot {
  id?: number;
  signalId: string;
  symbol: string;
  timeframe: string;
  signalTimestamp: number;
  pattern: string;
  direction: string;
  outcome: string;
  rMultiple: number | null;

  prev100: SerializedCandle[];
  next100: SerializedCandle[];

  simulationId: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Intelligence Reports (Phase 14) ──────────────────────────────────────────
// Nightly edge report: top/worst/emerging edges + auto weight adjustments, derived from
// edgeStats (fed by both live signals and simulator trades).

export interface IntelligenceReportEntry {
  label: string;
  pattern: string;
  symbol: string;
  timeframe: string;
  regime: string;
  session: string;
  sampleSize: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  trend: 'improving' | 'degrading' | 'stable';
  badge: '🏆' | '⚠️' | '🚀' | '📉';
}

export interface IntelligenceWeightAdjustment {
  pattern: string;
  regime: string;
  session: string;
  previousWeight: number;
  newWeight: number;
  reason: string;
}

export interface IntelligenceReportRecord {
  id?: number;
  generatedAt: number;
  tradesSinceLastReport: number;

  topPerforming: IntelligenceReportEntry[];
  worstPerforming: IntelligenceReportEntry[];
  emergingEdge: IntelligenceReportEntry[];

  weightAdjustments: IntelligenceWeightAdjustment[];
  disabledPatterns: string[];
  promotedPatterns: string[];

  insights: string[];
  overallHealthScore: number;
}

// ─── Sentiment History (Phase 15) ─────────────────────────────────────────────
// Fear & Greed + funding rate + open interest, fetched client-side (all three endpoints
// verified to allow browser CORS). News/GPT classification deliberately omitted: CryptoPanic's
// RSS feed has no CORS header (confirmed dead on arrival from a browser fetch), and routing an
// OpenAI key through client-side fetch would expose it in the browser — this app keeps
// OPENAI_API_KEY server-only (see lib/openai.ts + app/api/analyze/route.ts).

export interface SentimentRecord {
  id?: number;
  timestamp: number;

  fearGreedScore: number;
  fearGreedLabel: 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed';
  fearGreedPrev: number;
  fearGreedChange: number;

  fundingRate: number;
  fundingLabel: string;
  fundingSignal: 'bullish' | 'bearish' | 'neutral';

  openInterest: number;
  openInterestChange: number;
  oiTrend: 'rising' | 'falling' | 'flat';
  oiSignal: 'bullish' | 'bearish' | 'neutral';

  overallScore: number;
  overallLabel: string;
  tradingBias: 'strongly_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strongly_bearish';

  longModifier: number;
  shortModifier: number;

  symbol: string;
  cachedAt: number;
}

// ─── Auto-Sim Runs (Phase 16) ──────────────────────────────────────────────────
// Lightweight per-run metadata for the auto-simulator's history view. The heavy trade data
// already lives in simulationMemory (via recordSimulation) — this table just adds the
// session/iteration/diagnosis framing on top, linked back by simulationId.

export interface AutoSimRunRecord {
  id?: number;
  runId: string;
  batchId: string;
  iteration: number;
  simulationId: string; // FK into simulationMemory

  symbol: string;
  timeframe: string;
  dateRangeLabel: string;
  startDate: string;
  endDate: string;

  finalCapital: number;
  totalReturn: number;
  profitFactor: number;
  winRate: number;
  trades: number;

  winningPatterns: string[];
  losingPatterns: string[];
  diagnosis: string[];

  timestamp: number;
}

// ─── Database Class ───────────────────────────────────────────────────────────

export class TradeFlowDB extends Dexie {
  signalMemory!: Table<SignalMemoryRecord, number>;
  simulationMemory!: Table<SimulationMemoryRecord, number>;
  edgeStats!: Table<EdgeStatsRecord, number>;
  learningSnapshots!: Table<LearningSnapshotRecord, number>;
  featureWeights!: Table<FeatureWeightsRecord, number>;
  featureImportance!: Table<FeatureImportanceRecord, number>;
  patternEvolution!: Table<PatternEvolutionRecord, number>;
  drawingMemory!: Table<DrawingMemoryRecord, number>;
  candleSnapshots!: Table<CandleSnapshot, number>;
  intelligenceReports!: Table<IntelligenceReportRecord, number>;
  sentimentHistory!: Table<SentimentRecord, number>;
  autoSimRuns!: Table<AutoSimRunRecord, number>;

  constructor() {
    super('TradeFlowV3');

    this.version(1).stores({
      signalMemory: [
        '++id',
        'timestamp',
        'symbol',
        'timeframe',
        'pattern',
        'direction',
        'regime',
        'session',
        'signalStatus',
        'wasTaken',
        'result',
        'simulationId',
        '[symbol+timeframe]',
        '[pattern+regime]',
        '[pattern+symbol+timeframe]',
        '[pattern+session]',
        '[symbol+timeframe+regime]',
      ].join(', '),

      simulationMemory: [
        '++id',
        'simulationId',
        'date',
        'symbol',
      ].join(', '),

      edgeStats: [
        '++id',
        '[pattern+symbol+timeframe+session+regime]',
        'pattern',
        'symbol',
        'regime',
        'session',
        'lastUpdated',
      ].join(', '),

      learningSnapshots: [
        '++id',
        'timestamp',
        'triggerReason',
      ].join(', '),

      featureWeights: [
        '++id',
        'timestamp',
      ].join(', '),

      featureImportance: [
        '++id',
        'timestamp',
      ].join(', '),

      patternEvolution: [
        '++id',
        'pattern',
        'status',
      ].join(', '),

      drawingMemory: [
        '++id',
        'drawingId',
        'signalId',
        'symbol',
        'status',
        '[symbol+timeframe]',
      ].join(', '),
    });

    // Version 2 — Phase 13/14: candle snapshots (visual ML training data) + intelligence
    // reports. Only new tables need declaring; unchanged v1 tables carry forward automatically.
    this.version(2).stores({
      candleSnapshots: [
        '++id',
        'signalId',
        'symbol',
        'timeframe',
        'pattern',
        'outcome',
        'simulationId',
        'signalTimestamp',
      ].join(', '),

      intelligenceReports: [
        '++id',
        'generatedAt',
      ].join(', '),
    });

    // Version 3 — Phase 15/16: market sentiment history + auto-simulator run log.
    this.version(3).stores({
      sentimentHistory: [
        '++id',
        'timestamp',
        'symbol',
        'overallScore',
        'tradingBias',
      ].join(', '),

      autoSimRuns: [
        '++id',
        'runId',
        'batchId',
        'simulationId',
        'symbol',
        'timeframe',
        'timestamp',
      ].join(', '),
    });
  }
}

// ─── Singleton Instance ───────────────────────────────────────────────────────

let _db: TradeFlowDB | null = null;

export function getDB(): TradeFlowDB {
  if (!_db) {
    _db = new TradeFlowDB();
  }
  return _db;
}

// ─── Database Utilities ───────────────────────────────────────────────────────

/** Get total record counts for all tables */
export async function getMemoryStats(): Promise<{
  signals: number;
  simulations: number;
  edgeEntries: number;
  learningCycles: number;
  drawings: number;
  candleSnapshots: number;
  intelligenceReports: number;
  sentimentReadings: number;
  autoSimRuns: number;
}> {
  const db = getDB();
  const [signals, simulations, edgeEntries, learningCycles, drawings, candleSnapshots, intelligenceReports, sentimentReadings, autoSimRuns] = await Promise.all([
    db.signalMemory.count(),
    db.simulationMemory.count(),
    db.edgeStats.count(),
    db.learningSnapshots.count(),
    db.drawingMemory.count(),
    db.candleSnapshots.count(),
    db.intelligenceReports.count(),
    db.sentimentHistory.count(),
    db.autoSimRuns.count(),
  ]);
  return { signals, simulations, edgeEntries, learningCycles, drawings, candleSnapshots, intelligenceReports, sentimentReadings, autoSimRuns };
}

/** Export entire database to a JSON object (for D:\trade_data backup) */
export async function exportDatabase(): Promise<Record<string, unknown[]>> {
  const db = getDB();
  const [signals, simulations, edge, learning, weights, importance, evolution, drawings, snapshots, reports, sentiment, autoSims] =
    await Promise.all([
      db.signalMemory.toArray(),
      db.simulationMemory.toArray(),
      db.edgeStats.toArray(),
      db.learningSnapshots.toArray(),
      db.featureWeights.toArray(),
      db.featureImportance.toArray(),
      db.patternEvolution.toArray(),
      db.drawingMemory.toArray(),
      db.candleSnapshots.toArray(),
      db.intelligenceReports.toArray(),
      db.sentimentHistory.toArray(),
      db.autoSimRuns.toArray(),
    ]);
  return {
    signalMemory: signals,
    simulationMemory: simulations,
    edgeStats: edge,
    learningSnapshots: learning,
    featureWeights: weights,
    featureImportance: importance,
    patternEvolution: evolution,
    drawingMemory: drawings,
    candleSnapshots: snapshots,
    intelligenceReports: reports,
    sentimentHistory: sentiment,
    autoSimRuns: autoSims,
    exportedAt: [{ timestamp: Date.now(), version: 'V3.0' }],
  };
}

/** Import database from a JSON export */
export async function importDatabase(data: Record<string, unknown[]>): Promise<void> {
  const db = getDB();
  await db.transaction('rw',
    [db.signalMemory, db.simulationMemory, db.edgeStats,
    db.learningSnapshots, db.featureWeights, db.featureImportance,
    db.patternEvolution, db.drawingMemory, db.candleSnapshots, db.intelligenceReports,
    db.sentimentHistory, db.autoSimRuns],
    async () => {
      if (data.signalMemory) await db.signalMemory.bulkPut(data.signalMemory as SignalMemoryRecord[]);
      if (data.simulationMemory) await db.simulationMemory.bulkPut(data.simulationMemory as SimulationMemoryRecord[]);
      if (data.edgeStats) await db.edgeStats.bulkPut(data.edgeStats as EdgeStatsRecord[]);
      if (data.learningSnapshots) await db.learningSnapshots.bulkPut(data.learningSnapshots as LearningSnapshotRecord[]);
      if (data.featureWeights) await db.featureWeights.bulkPut(data.featureWeights as FeatureWeightsRecord[]);
      if (data.featureImportance) await db.featureImportance.bulkPut(data.featureImportance as FeatureImportanceRecord[]);
      if (data.patternEvolution) await db.patternEvolution.bulkPut(data.patternEvolution as PatternEvolutionRecord[]);
      if (data.drawingMemory) await db.drawingMemory.bulkPut(data.drawingMemory as DrawingMemoryRecord[]);
      if (data.candleSnapshots) await db.candleSnapshots.bulkPut(data.candleSnapshots as CandleSnapshot[]);
      if (data.intelligenceReports) await db.intelligenceReports.bulkPut(data.intelligenceReports as IntelligenceReportRecord[]);
      if (data.sentimentHistory) await db.sentimentHistory.bulkPut(data.sentimentHistory as SentimentRecord[]);
      if (data.autoSimRuns) await db.autoSimRuns.bulkPut(data.autoSimRuns as AutoSimRunRecord[]);
    });
}

/** Dangerous: clear all data. Use for testing only. */
export async function clearAllData(): Promise<void> {
  const db = getDB();
  await Promise.all([
    db.signalMemory.clear(),
    db.simulationMemory.clear(),
    db.edgeStats.clear(),
    db.learningSnapshots.clear(),
    db.featureWeights.clear(),
    db.featureImportance.clear(),
    db.patternEvolution.clear(),
    db.drawingMemory.clear(),
    db.candleSnapshots.clear(),
    db.intelligenceReports.clear(),
    db.sentimentHistory.clear(),
    db.autoSimRuns.clear(),
  ]);
}
