/**
 * TradeFlow V3 — RAG Memory Engine (Phase 7)
 *
 * Vector memory for similarity search. When a new setup appears,
 * retrieves the most similar historical setups and returns their
 * aggregate performance statistics.
 *
 * Uses numerical feature vectors + cosine similarity (no external
 * embedding API needed — better for structured trading data).
 */

import { getDB, type SignalMemoryRecord } from './db';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SimilarSetup {
  signal: SignalMemoryRecord;
  similarity: number;         // 0-1 cosine similarity
}

export interface SimilarSetupStats {
  matchCount: number;
  avgSimilarity: number;
  historicalWinRate: number;
  avgRMultiple: number;
  avgRR: number;
  expectancy: number;
  maxDrawdown: number;
  avgHoldTime: number;
  bestRMultiple: number;
  worstRMultiple: number;
  profitFactor: number;
  sampleConfidence: 'high' | 'medium' | 'low'; // based on match count
}

// ─── Cosine Similarity ────────────────────────────────────────────────────────

/** Calculate cosine similarity between two vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

// ─── Similarity Search ────────────────────────────────────────────────────────

/**
 * Find the top-K most similar historical signals to a query vector.
 * Brute-force cosine similarity — fast enough for ~100K signals in-browser.
 */
export async function findSimilarSetups(
  queryVector: number[],
  topK = 100,
  minSimilarity = 0.5,
): Promise<SimilarSetup[]> {
  const db = getDB();

  // Only look at signals that have outcomes (we need their results for stats)
  const allSignals = await db.signalMemory
    .where('result')
    .notEqual('')
    .toArray();

  if (allSignals.length === 0) return [];

  const scored: SimilarSetup[] = [];
  for (const signal of allSignals) {
    if (signal.result === null) continue;

    let fv: number[];
    try { fv = JSON.parse(signal.featureVector); }
    catch { continue; }

    if (!Array.isArray(fv) || fv.length === 0) continue;

    const sim = cosineSimilarity(queryVector, fv);
    if (sim >= minSimilarity) {
      scored.push({ signal, similarity: sim });
    }
  }

  // Sort by similarity descending, take top K
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}

/**
 * Get aggregate statistics from the most similar historical setups.
 * This is the key function that powers the "Historical Edge" component
 * of the Edge Score.
 */
export async function getSimilarSetupStats(
  queryVector: number[],
  topK = 100,
): Promise<SimilarSetupStats> {
  const similar = await findSimilarSetups(queryVector, topK, 0.4);

  if (similar.length === 0) {
    return {
      matchCount: 0,
      avgSimilarity: 0,
      historicalWinRate: 50, // neutral default
      avgRMultiple: 0,
      avgRR: 0,
      expectancy: 0,
      maxDrawdown: 0,
      avgHoldTime: 0,
      bestRMultiple: 0,
      worstRMultiple: 0,
      profitFactor: 0,
      sampleConfidence: 'low',
    };
  }

  const withOutcomes = similar.filter(s => s.signal.rMultiple !== null);
  const rMultiples = withOutcomes.map(s => s.signal.rMultiple!);
  const holdTimes = withOutcomes
    .filter(s => s.signal.holdingTime !== null)
    .map(s => s.signal.holdingTime!);

  const wins = rMultiples.filter(r => r > 0.1);
  const losses = rMultiples.filter(r => r < -0.1);
  const grossWins = wins.reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(losses.reduce((a, b) => a + b, 0));

  // Similarity-weighted win rate (more weight to more similar setups)
  let weightedWins = 0, totalWeight = 0;
  for (const s of withOutcomes) {
    const w = s.similarity;
    totalWeight += w;
    if (s.signal.rMultiple! > 0.1) weightedWins += w;
  }
  const weightedWinRate = totalWeight > 0 ? (weightedWins / totalWeight) * 100 : 50;

  // Max drawdown from sequential R-multiples
  let peak = 0, maxDD = 0, cumR = 0;
  for (const r of rMultiples) {
    cumR += r;
    if (cumR > peak) peak = cumR;
    const dd = peak - cumR;
    if (dd > maxDD) maxDD = dd;
  }

  const avgR = rMultiples.length > 0 ? rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length : 0;
  const avgSim = similar.reduce((a, s) => a + s.similarity, 0) / similar.length;

  // Sample confidence
  let sampleConfidence: 'high' | 'medium' | 'low' = 'low';
  if (withOutcomes.length >= 50 && avgSim > 0.7) sampleConfidence = 'high';
  else if (withOutcomes.length >= 20 && avgSim > 0.5) sampleConfidence = 'medium';

  return {
    matchCount: withOutcomes.length,
    avgSimilarity: avgSim,
    historicalWinRate: weightedWinRate,
    avgRMultiple: avgR,
    avgRR: wins.length > 0 ? (grossWins / wins.length) / (grossLosses / Math.max(1, losses.length)) : 0,
    expectancy: avgR,
    maxDrawdown: maxDD,
    avgHoldTime: holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0,
    bestRMultiple: rMultiples.length > 0 ? Math.max(...rMultiples) : 0,
    worstRMultiple: rMultiples.length > 0 ? Math.min(...rMultiples) : 0,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0),
    sampleConfidence,
  };
}

/**
 * Quick similarity check — returns just the historical win rate and
 * match count for a query vector. Used inline during signal generation
 * to avoid the full stats calculation overhead.
 */
export async function quickHistoricalEdge(
  queryVector: number[],
): Promise<{ winRate: number; matchCount: number; confidence: 'high' | 'medium' | 'low' }> {
  const stats = await getSimilarSetupStats(queryVector, 50);
  return {
    winRate: stats.historicalWinRate,
    matchCount: stats.matchCount,
    confidence: stats.sampleConfidence,
  };
}
