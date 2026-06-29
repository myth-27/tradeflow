/**
 * TradeFlow — ML Training Dataset Builder
 *
 * Converts the trade records already stored in IndexedDB (via lib/simulation-memory.ts /
 * lib/db.ts) into a feature-engineered dataset a model can train on. This deliberately does
 * NOT introduce a second persistence layer — every simulation's trades are already saved to
 * the `simulationMemory` Dexie table by recordSimulation(); this module just reads that data
 * back out and reshapes it.
 */

import type { CompactTrade } from './simulation-memory';
import type { SimulationMemoryRecord } from './db';
import { extractTrades } from './simulation-memory';

// ─── Types ───────────────────────────────────────────────────────────────

export interface TrainingRow {
  // ── Identity ──────────────────────────────
  id: string;
  simulationId: string;
  symbol: string;
  timeframe: string;
  timestamp: number;
  entryTime: string;
  dayOfWeek: number;
  hourUTC: number;

  // ── Pattern Features ──────────────────────
  pattern: string;
  patternEncoded: number;
  direction: number;
  patternConfidence: number;

  // ── HTF Bias Features (same-timeframe EMA50/EMA200 proxy) ────────────
  htfBias: number;
  htfStrength: number;
  htfEmaSeparation: number;
  htfStructure: number;

  // ── Indicator Features ────────────────────
  rsi: number;
  rsiZone: number;
  macdHistPrev: number; // only the prior snapshot's histogram is stored, not the value at entry itself
  macdSign: number;
  macdMomentum: number;
  atrPct: number;
  bbPosition: number;
  ema20VsEma50: number;
  priceVsEma20: number;

  // ── Volume Features ───────────────────────
  volumeRatio: number;
  volumeTrend: number;
  highVolume: number;

  // ── Market Structure Features ─────────────
  regime: string;
  regimeEncoded: number;
  distToSupport: number;
  distToResistance: number;
  rrRatio: number;

  // ── Entry Quality ─────────────────────────
  entryType: string;
  waitedCandles: number;
  slippagePct: number;

  // ── Trade Setup ───────────────────────────
  stopDistPct: number;
  targetDistPct: number;

  // ── Context at Entry ──────────────────────
  consecutiveLossesBefore: number;
  consecutiveWinsBefore: number;
  capitalDrawdownPct: number;

  // ── TARGET LABELS ─────────────────────────
  outcome: 'win' | 'loss' | 'breakeven';
  outcomeEncoded: number;
  rMultiple: number;

  // ── Secondary labels ──────────────────────
  tp1Hit: boolean;
  tp1HitEncoded: number;
  holdingCandles: number;
  exitReason: string;
}

export const PATTERN_ENCODING: Record<string, number> = {
  'Double Top': 1,
  'Double Bottom': 2,
  'Head & Shoulders': 3,
  'Inverse Head & Shoulders': 4,
  'Ascending Triangle': 5,
  'Descending Triangle': 6,
  'Symmetrical Triangle': 7,
  'Bull Flag': 8,
  'Bear Flag': 9,
  'Rectangle': 10,
  'Wedge Rising': 11,
  'Wedge Falling': 12,
  'Cup and Handle': 13,
  'Doji': 14,
  'Hammer': 15,
  'Shooting Star': 16,
  'Engulfing Bullish': 17,
  'Engulfing Bearish': 18,
  'Morning Star': 19,
  'Unknown': 0,
};

export const REGIME_ENCODING: Record<string, number> = {
  strong_uptrend: 2,
  weak_uptrend: 1,
  ranging: 0,
  weak_downtrend: -1,
  strong_downtrend: -2,
  low_volatility: 0,
};

const HTF_BIAS_ENCODING: Record<string, number> = { bullish: 1, bearish: -1, neutral: 0 };
const HTF_STRUCTURE_ENCODING: Record<string, number> = { HH_HL: 1, LH_LL: -1, mixed: 0 };

// ─── Builder: CompactTrade (as stored) → TrainingRow ──────────────────────

export function buildTrainingRow(
  trade: CompactTrade,
  simulationId: string,
  symbol: string,
  timeframe: string,
): TrainingRow {
  const entryDate = new Date(trade.entryTime * 1000);

  const rsiZone = trade.rsi < 30 ? -1 : trade.rsi > 70 ? 1 : 0;
  // Without the numeric histogram at entry (only its sign is stored), "momentum" here means
  // whether the current sign agrees with the prior snapshot's sign (continuing) or not (flipping)
  // — not whether the histogram is growing in magnitude.
  const prevMacdSign = trade.macdHistPrev > 0 ? 1 : trade.macdHistPrev < 0 ? -1 : 0;
  const currentMacdSign = trade.macd === 'bullish' ? 1 : -1;
  const macdMomentum = prevMacdSign === 0 ? 0 : (currentMacdSign === prevMacdSign ? 1 : -1);

  const bbRange = trade.bbUpper - trade.bbLower;
  const bbPosition = bbRange > 0 ? (trade.entry - trade.bbLower) / bbRange : 0.5;

  const volumeTrend = trade.volRatioPrev ? (trade.vol > trade.volRatioPrev ? 1 : -1) : 0;

  let outcome: TrainingRow['outcome'] = 'breakeven';
  if (trade.rMult > 0.1) outcome = 'win';
  else if (trade.reason === 'stop' && trade.rMult <= 0.1) outcome = 'loss';
  const outcomeEncoded = outcome === 'win' ? 1 : outcome === 'loss' ? -1 : 0;

  const riskPerUnit = Math.abs(trade.entry - trade.stop);
  const rewardPerUnit = Math.abs(trade.tp2 - trade.entry);

  return {
    id: trade.id,
    simulationId,
    symbol,
    timeframe,
    timestamp: trade.entryTime,
    entryTime: entryDate.toISOString(),
    dayOfWeek: entryDate.getUTCDay(),
    hourUTC: trade.hour,

    pattern: trade.pat,
    patternEncoded: PATTERN_ENCODING[trade.pat] ?? 0,
    direction: trade.dir === 'long' ? 1 : -1,
    patternConfidence: trade.conf,

    htfBias: HTF_BIAS_ENCODING[trade.htfBias] ?? 0,
    htfStrength: trade.htfStrength,
    htfEmaSeparation: trade.htfEmaSeparation,
    htfStructure: HTF_STRUCTURE_ENCODING[trade.htfStructure] ?? 0,

    rsi: trade.rsi,
    rsiZone,
    macdHistPrev: trade.macdHistPrev,
    macdSign: trade.macd === 'bullish' ? 1 : -1,
    macdMomentum,
    atrPct: trade.atr && trade.entry ? (trade.atr / trade.entry) * 100 : 0,
    bbPosition,
    ema20VsEma50: trade.ema20VsEma50,
    priceVsEma20: trade.priceVsEma20,

    volumeRatio: trade.vol,
    volumeTrend,
    highVolume: trade.vol > 1.5 ? 1 : 0,

    regime: trade.regime,
    regimeEncoded: REGIME_ENCODING[trade.regime] ?? 0,
    distToSupport: trade.distToSupport,
    distToResistance: trade.distToResistance,
    rrRatio: riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : 0,

    entryType: trade.entryType,
    waitedCandles: trade.waitedCandles,
    slippagePct: trade.entry ? (trade.entrySlippage / trade.entry) * 100 : 0,

    stopDistPct: trade.entry ? (riskPerUnit / trade.entry) * 100 : 0,
    targetDistPct: trade.entry ? (rewardPerUnit / trade.entry) * 100 : 0,

    consecutiveLossesBefore: trade.lossStreakBefore,
    consecutiveWinsBefore: trade.winStreakBefore,
    capitalDrawdownPct: trade.drawdownAtEntry,

    outcome,
    outcomeEncoded,
    rMultiple: trade.rMult,

    tp1Hit: trade.tp1Hit,
    tp1HitEncoded: trade.tp1Hit ? 1 : 0,
    holdingCandles: trade.candles,
    exitReason: trade.reason,
  };
}

/** Build the full training dataset from every simulation stored in Dexie. */
export function buildDatasetFromSimulations(sims: SimulationMemoryRecord[]): TrainingRow[] {
  const rows: TrainingRow[] = [];
  for (const sim of sims) {
    const trades = extractTrades(sim).filter(t => t.reason !== 'entry_expired');
    const timeframes = JSON.parse(sim.timeframes || '[]') as string[];
    const timeframe = timeframes[0] ?? '5m';
    for (const t of trades) {
      rows.push(buildTrainingRow(t, sim.simulationId, sim.symbol, timeframe));
    }
  }
  return rows;
}

// ─── Export: CSV ────────────────────────────────────────────────────────

export function trainingRowsToCSV(rows: TrainingRow[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]) as (keyof TrainingRow)[];
  const csvLines = [
    headers.join(','),
    ...rows.map(row =>
      headers.map(h => {
        const val = row[h];
        if (typeof val === 'string' && val.includes(',')) return `"${val}"`;
        return val ?? '';
      }).join(','),
    ),
  ];
  return csvLines.join('\n');
}

export function trainingRowsToJSON(rows: TrainingRow[]): string {
  return JSON.stringify(rows, null, 2);
}

const NUMERIC_FEATURES: (keyof TrainingRow)[] = [
  'patternEncoded', 'direction', 'patternConfidence',
  'htfBias', 'htfStrength', 'htfEmaSeparation', 'htfStructure',
  'rsi', 'rsiZone', 'macdSign', 'macdMomentum',
  'atrPct', 'bbPosition', 'ema20VsEma50', 'priceVsEma20',
  'volumeRatio', 'volumeTrend', 'highVolume',
  'regimeEncoded', 'distToSupport', 'distToResistance', 'rrRatio',
  'waitedCandles', 'slippagePct',
  'stopDistPct', 'targetDistPct',
  'consecutiveLossesBefore', 'consecutiveWinsBefore',
  'capitalDrawdownPct',
  'dayOfWeek', 'hourUTC',
];

export function trainingRowsToFeatureMatrix(rows: TrainingRow[]): {
  X: number[][];
  y: number[];
  yR: number[];
  featureNames: string[];
} {
  const X = rows.map(row => NUMERIC_FEATURES.map(f => Number(row[f]) || 0));
  const y = rows.map(r => r.outcomeEncoded);
  const yR = rows.map(r => r.rMultiple);
  return { X, y, yR, featureNames: NUMERIC_FEATURES as string[] };
}

// ─── Dataset Stats ─────────────────────────────────────────────────────

export type DatasetStats = {
  totalRows: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;
  avgRMultiple: number;
  classBalance: { wins: string; losses: string; breakevens: string };
  patternCounts: Record<string, number>;
  regimeCounts: Record<string, number>;
  featureStats: Record<string, { mean: number; std: number }>;
  recommendations: string[];
  readyForML: boolean;
  suggestedModels: string[];
};

export function analyzeDataset(rows: TrainingRow[]): DatasetStats {
  if (rows.length === 0) {
    return {
      totalRows: 0, wins: 0, losses: 0, breakevens: 0, winRate: 0, avgRMultiple: 0,
      classBalance: { wins: '0%', losses: '0%', breakevens: '0%' },
      patternCounts: {}, regimeCounts: {}, featureStats: {},
      recommendations: ['No trades yet — run some simulations first.'],
      readyForML: false, suggestedModels: ['Need more data'],
    };
  }

  const wins = rows.filter(r => r.outcome === 'win');
  const losses = rows.filter(r => r.outcome === 'loss');
  const breakevens = rows.filter(r => r.outcome === 'breakeven');

  const classBalance = {
    wins: (wins.length / rows.length * 100).toFixed(1) + '%',
    losses: (losses.length / rows.length * 100).toFixed(1) + '%',
    breakevens: (breakevens.length / rows.length * 100).toFixed(1) + '%',
  };

  const patternCounts: Record<string, number> = {};
  rows.forEach(r => { patternCounts[r.pattern] = (patternCounts[r.pattern] ?? 0) + 1; });

  const regimeCounts: Record<string, number> = {};
  rows.forEach(r => { regimeCounts[r.regime] = (regimeCounts[r.regime] ?? 0) + 1; });

  const STAT_FEATURES: (keyof TrainingRow)[] = ['rsi', 'volumeRatio', 'atrPct', 'htfStrength', 'rrRatio'];
  const featureStats: Record<string, { mean: number; std: number }> = {};
  STAT_FEATURES.forEach(feat => {
    const vals = rows.map(r => Number(r[feat]) || 0);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    featureStats[feat as string] = { mean: +mean.toFixed(4), std: +std.toFixed(4) };
  });

  const recommendations: string[] = [];
  if (rows.length < 100) {
    recommendations.push(`Only ${rows.length} trades — need 500+ for reliable ML training.`);
  } else if (rows.length < 500) {
    recommendations.push(`${rows.length} trades — usable for basic patterns. Run more simulations to improve accuracy.`);
  } else {
    recommendations.push(`${rows.length} trades — sufficient for XGBoost/Random Forest training.`);
  }
  if (wins.length / rows.length < 0.3) {
    recommendations.push(`Class imbalance: only ${(wins.length / rows.length * 100).toFixed(0)}% wins. Use class_weight='balanced' in sklearn.`);
  }
  const uniquePatterns = Object.keys(patternCounts).length;
  if (uniquePatterns < 4) {
    recommendations.push(`Only ${uniquePatterns} pattern(s) in dataset. Enable more patterns or run more varied simulations.`);
  }

  return {
    totalRows: rows.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: breakevens.length,
    winRate: +(wins.length / rows.length * 100).toFixed(1),
    avgRMultiple: +(rows.reduce((a, r) => a + r.rMultiple, 0) / rows.length).toFixed(3),
    classBalance,
    patternCounts,
    regimeCounts,
    featureStats,
    recommendations,
    readyForML: rows.length >= 200 && uniquePatterns >= 3,
    suggestedModels: rows.length >= 500
      ? ['XGBoost', 'Random Forest', 'LightGBM']
      : rows.length >= 200
        ? ['Random Forest', 'Logistic Regression']
        : ['Need more data'],
  };
}

// ─── Python notebook generator (downloaded client-side, no server needed) ─

export function buildTrainingNotebook(csvFilename: string): string {
  const notebook = {
    nbformat: 4,
    nbformat_minor: 4,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        cell_type: 'markdown',
        metadata: {},
        source: ['# TradeFlow ML Training\n', 'Train a model on backtest data to predict trade outcomes.'],
      },
      {
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: [
          '!pip install scikit-learn pandas matplotlib\n',
          'import pandas as pd\n',
          'import numpy as np\n',
          'from sklearn.ensemble import RandomForestClassifier\n',
          'from sklearn.model_selection import TimeSeriesSplit\n',
          'from sklearn.metrics import classification_report\n',
          'import matplotlib.pyplot as plt\n',
        ],
      },
      {
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: [
          `df = pd.read_csv("${csvFilename}")\n`,
          'print(f"Total trades: {len(df)}")\n',
          'print(df["outcome"].value_counts())\n',
          'df.head()\n',
        ],
      },
      {
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: [
          'FEATURES = [\n',
          '    "patternEncoded", "direction", "patternConfidence",\n',
          '    "htfBias", "htfStrength", "htfEmaSeparation",\n',
          '    "rsi", "rsiZone", "macdSign", "macdMomentum",\n',
          '    "atrPct", "bbPosition", "volumeRatio", "highVolume",\n',
          '    "regimeEncoded", "rrRatio", "distToSupport",\n',
          '    "distToResistance", "hourUTC", "dayOfWeek",\n',
          '    "consecutiveLossesBefore"\n',
          ']\n\n',
          'X = df[FEATURES].fillna(0)\n',
          'y = df["outcomeEncoded"].map({1: 1, 0: 0, -1: 0})  # binary: win vs not-win\n',
          'y_r = df["rMultiple"]  # regression target\n',
        ],
      },
      {
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: [
          '# Walk-forward cross-validation — NEVER shuffle time series data\n',
          'tscv = TimeSeriesSplit(n_splits=5)\n\n',
          'model = RandomForestClassifier(\n',
          '    n_estimators=200,\n',
          '    max_depth=4,\n',
          '    class_weight="balanced",\n',
          '    random_state=42\n',
          ')\n\n',
          'scores = []\n',
          'for train_idx, test_idx in tscv.split(X):\n',
          '    X_tr, X_te = X.iloc[train_idx], X.iloc[test_idx]\n',
          '    y_tr, y_te = y.iloc[train_idx], y.iloc[test_idx]\n',
          '    model.fit(X_tr, y_tr)\n',
          '    scores.append(model.score(X_te, y_te))\n\n',
          'print(f"CV Accuracy: {np.mean(scores):.3f}")\n',
        ],
      },
      {
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: [
          'importance = pd.Series(\n',
          '    model.feature_importances_, index=FEATURES\n',
          ').sort_values(ascending=True)\n\n',
          'plt.figure(figsize=(10, 8))\n',
          'importance.plot(kind="barh")\n',
          'plt.title("Feature Importance — What predicts wins?")\n',
          'plt.tight_layout()\n',
          'plt.show()\n',
        ],
      },
    ],
  };
  return JSON.stringify(notebook, null, 2);
}
