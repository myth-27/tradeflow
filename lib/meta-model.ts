/**
 * TradeFlow V3 — Meta Model (Phase 14)
 *
 * Predictive layer that combines ALL inputs to output:
 *   - Win Probability
 *   - Expected RR
 *   - Expected Value
 *
 * Only trade when Expected Value > 0.
 *
 * Uses logistic regression trained on historical signal outcomes.
 */

import { getAllSignalsWithOutcomes } from './signal-memory';
import type { SignalMemoryRecord, MarketRegime, TradingSession } from './db';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MetaModelPrediction {
  winProbability: number;       // 0-1
  expectedRR: number;           // expected R-multiple
  expectedValue: number;        // winProb * avgWin - (1-winProb) * avgLoss
  shouldTrade: boolean;         // expectedValue > 0
  confidence: 'high' | 'medium' | 'low';
  modelVersion: string;
  features: MetaModelFeatures;
}

export interface MetaModelFeatures {
  pattern: string;
  regime: MarketRegime;
  session: TradingSession;
  rsi: number;
  macd: number;
  atr: number;
  volumeRatio: number;
  edgeScore: number;
  patternScore: number;
  openInterest: number | null;
  fundingRate: number | null;
  cvd: number | null;
  historicalWinRate: number;
}

// ─── Model Weights (trained via logistic regression on historical data) ──────

interface ModelCoefficients {
  intercept: number;
  weights: Record<string, number>;
  avgWinR: number;
  avgLossR: number;
  trainedOn: number;
  timestamp: number;
}

let _cachedModel: ModelCoefficients | null = null;
let _lastTrainCount = 0;
const RETRAIN_INTERVAL = 100; // retrain every 100 new outcomes

// ─── Logistic Regression ──────────────────────────────────────────────────────

/** Sigmoid function */
function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));
}

/** Extract normalized features from a signal record */
function extractFeatures(s: SignalMemoryRecord): Record<string, number> {
  return {
    patternScore: s.patternScore / 100,
    tradeScore: s.tradeScore / 100,
    edgeScore: s.edgeScore / 100,
    rsi: s.rsi / 100,
    macd: Math.tanh(s.macd * 10), // normalize MACD with tanh
    volumeRatio: Math.min(1, s.volumeRatio / 5),
    atr: Math.min(1, s.atr * 10), // rough normalization
    regime: regimeToNum(s.regime) / 5,
    session: sessionToNum(s.session) / 4,
    oi: s.openInterest !== null ? Math.tanh(s.openInterest) : 0,
    funding: s.fundingRate !== null ? Math.tanh(s.fundingRate * 100) : 0,
    cvd: s.cvd !== null ? Math.tanh(s.cvd) : 0,
  };
}

/** Train the logistic regression model on historical data */
async function trainModel(): Promise<ModelCoefficients> {
  const signals = await getAllSignalsWithOutcomes();
  if (signals.length < 30) return getDefaultModel();

  const wins = signals.filter(s => s.rMultiple !== null && s.rMultiple > 0.1);
  const losses = signals.filter(s => s.rMultiple !== null && s.rMultiple <= 0.1);

  // Labels: 1 for win, 0 for loss
  const labels = signals.map(s => (s.rMultiple !== null && s.rMultiple > 0.1) ? 1 : 0);
  const features = signals.map(extractFeatures);
  const featureNames = Object.keys(features[0]);

  // Initialize weights
  const weights: Record<string, number> = {};
  for (const name of featureNames) weights[name] = 0;
  let intercept = 0;

  // Gradient descent
  const lr = 0.01;
  const epochs = 200;
  const n = signals.length;

  for (let epoch = 0; epoch < epochs; epoch++) {
    let gradIntercept = 0;
    const gradWeights: Record<string, number> = {};
    for (const name of featureNames) gradWeights[name] = 0;

    for (let i = 0; i < n; i++) {
      let z = intercept;
      for (const name of featureNames) {
        z += weights[name] * (features[i][name] || 0);
      }
      const pred = sigmoid(z);
      const error = pred - labels[i];
      gradIntercept += error;
      for (const name of featureNames) {
        gradWeights[name] += error * (features[i][name] || 0);
      }
    }

    // Update with L2 regularization
    intercept -= lr * (gradIntercept / n);
    for (const name of featureNames) {
      weights[name] -= lr * (gradWeights[name] / n + 0.01 * weights[name]);
    }
  }

  // Average win/loss R-multiples
  const winRs = wins.map(s => s.rMultiple!);
  const lossRs = losses.map(s => Math.abs(s.rMultiple!));
  const avgWinR = winRs.length > 0 ? winRs.reduce((a, b) => a + b, 0) / winRs.length : 1.5;
  const avgLossR = lossRs.length > 0 ? lossRs.reduce((a, b) => a + b, 0) / lossRs.length : 1.0;

  const model: ModelCoefficients = {
    intercept,
    weights,
    avgWinR,
    avgLossR,
    trainedOn: signals.length,
    timestamp: Date.now(),
  };

  _cachedModel = model;
  _lastTrainCount = signals.length;

  return model;
}

function getDefaultModel(): ModelCoefficients {
  return {
    intercept: 0,
    weights: {
      patternScore: 1.0, tradeScore: 0.8, edgeScore: 1.5,
      rsi: 0.3, macd: 0.5, volumeRatio: 0.7,
      atr: 0.2, regime: 0.6, session: 0.3,
      oi: 0.4, funding: 0.3, cvd: 0.4,
    },
    avgWinR: 1.5,
    avgLossR: 1.0,
    trainedOn: 0,
    timestamp: Date.now(),
  };
}

// ─── Prediction ───────────────────────────────────────────────────────────────

/** Get a prediction for a new signal */
export async function predict(features: MetaModelFeatures): Promise<MetaModelPrediction> {
  // Check if model needs retraining
  const totalOutcomes = await (await import('./signal-memory')).getSignalCount();
  if (!_cachedModel || totalOutcomes >= _lastTrainCount + RETRAIN_INTERVAL) {
    await trainModel();
  }

  const model = _cachedModel ?? getDefaultModel();

  // Build feature vector
  const fv: Record<string, number> = {
    patternScore: features.patternScore / 100,
    tradeScore: features.edgeScore / 100, // map edgeScore to tradeScore
    edgeScore: features.edgeScore / 100,
    rsi: features.rsi / 100,
    macd: Math.tanh(features.macd * 10),
    volumeRatio: Math.min(1, features.volumeRatio / 5),
    atr: Math.min(1, features.atr * 10),
    regime: regimeToNum(features.regime) / 5,
    session: sessionToNum(features.session) / 4,
    oi: features.openInterest !== null ? Math.tanh(features.openInterest) : 0,
    funding: features.fundingRate !== null ? Math.tanh(features.fundingRate * 100) : 0,
    cvd: features.cvd !== null ? Math.tanh(features.cvd) : 0,
  };

  // Calculate win probability
  let z = model.intercept;
  for (const [name, value] of Object.entries(fv)) {
    z += (model.weights[name] ?? 0) * value;
  }
  const winProbability = sigmoid(z);

  // Expected value
  const expectedValue = winProbability * model.avgWinR - (1 - winProbability) * model.avgLossR;

  // Determine confidence based on model training size
  let confidence: 'high' | 'medium' | 'low' = 'low';
  if (model.trainedOn >= 200) confidence = 'high';
  else if (model.trainedOn >= 50) confidence = 'medium';

  return {
    winProbability,
    expectedRR: model.avgWinR,
    expectedValue,
    shouldTrade: expectedValue > 0,
    confidence,
    modelVersion: `lr_v1_${model.trainedOn}`,
    features,
  };
}

/** Force retrain the model */
export async function retrainModel(): Promise<void> {
  await trainModel();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function regimeToNum(regime: string): number {
  const map: Record<string, number> = {
    strong_uptrend: 5, weak_uptrend: 4, ranging: 3,
    low_volatility: 2, weak_downtrend: 1, strong_downtrend: 0,
  };
  return map[regime] ?? 3;
}

function sessionToNum(session: string): number {
  const map: Record<string, number> = {
    overlap: 4, new_york: 3, london: 2, asia: 1,
  };
  return map[session] ?? 2;
}
