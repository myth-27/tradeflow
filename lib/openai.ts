import OpenAI from 'openai';
import type { PatternResult } from './pattern-engine';
import type { Candle } from './binance-ws';
import { getPatternContextForGPT } from './pattern-knowledge';

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

export type AnalysisResult = {
  verdict: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';
  confidence: number;
  analysis: string;
  entryStrategy: string;
  riskManagement: string;
  keyLevels: string[];
  timeToTarget: string;
  // Populated when the pattern knowledge base has an entry for this pattern — optional so
  // existing callers (and the safe fallback default) don't need to supply them.
  patternQuality?: 'confirmed' | 'partial' | 'failed';
  confirmationsMet?: string[];
  failureRisks?: string[];
  keyInsight?: string;
  riskNote?: string;
};

export type VisionResult = {
  pattern: { name: string; type: 'bullish' | 'bearish' | 'neutral'; confidence: number };
  support: number[];
  resistance: number[];
  trend: 'uptrend' | 'downtrend' | 'sideways';
  candlestickPattern: string | null;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  analysis: string;
  recommendation: 'buy' | 'sell' | 'wait';
};

export type QuickSuggestion = {
  suggestion: string;
  type: 'bullish' | 'bearish' | 'neutral';
};

const safeAnalysisDefault: AnalysisResult = {
  verdict: 'neutral',
  confidence: 50,
  analysis: 'Analysis unavailable at this time.',
  entryStrategy: 'Wait for clearer signal.',
  riskManagement: 'Use standard stop loss placement.',
  keyLevels: [],
  timeToTarget: 'Unknown',
};

export async function analyzePattern(params: {
  symbol: string;
  pattern: PatternResult;
  candles: Candle[];
  rsi: number;
  macd: { macd: number; signal: number; histogram: number };
  atr: number;
  support: number;
  resistance: number;
  target: number;
  stopLoss: number;
  riskReward: number;
  timeframe: string;
  currentPrice: number;
  // Optional — existing callers keep working unchanged; when provided, sharpens the
  // pattern-knowledge-base context injected into the system prompt.
  volumeRatio?: number;
  htfBias?: 'bullish' | 'bearish' | 'neutral';
}): Promise<AnalysisResult> {
  const last10 = params.candles.slice(-10).map((c) => ({
    t: c.time,
    o: c.open.toFixed(4),
    h: c.high.toFixed(4),
    l: c.low.toFixed(4),
    c: c.close.toFixed(4),
    v: c.volume.toFixed(2),
  }));

  const macdTrend: 'bullish' | 'bearish' = params.macd.histogram > 0 ? 'bullish' : 'bearish';

  // Pattern Knowledge Base — extracted from the real chart-pattern reference PDFs (see
  // lib/pattern-knowledge.ts), injected so the model reasons from these specific rules
  // rather than generic training knowledge.
  const systemPrompt = getPatternContextForGPT(
    params.pattern.name,
    params.pattern.type === 'bearish' ? 'bearish' : 'bullish',
    { rsi: params.rsi, macd: macdTrend, volume: params.volumeRatio ?? 1 },
    params.htfBias ?? 'unknown',
  );

  const userPrompt = `Analyze this crypto trading setup:

Symbol: ${params.symbol.toUpperCase()} | Timeframe: ${params.timeframe}
Pattern: ${params.pattern.name} (${params.pattern.confidence}% confidence) — ${params.pattern.type}
Current Price: ${params.currentPrice.toFixed(4)}

Key Levels:
- Support: ${params.support.toFixed(4)}
- Resistance: ${params.resistance.toFixed(4)}
- Target: ${params.target.toFixed(4)}
- Stop Loss: ${params.stopLoss.toFixed(4)}
- Risk/Reward: 1:${params.riskReward}

Indicators:
- RSI(14): ${params.rsi.toFixed(2)}
- MACD Signal: ${params.macd.signal > params.macd.macd ? 'Bearish' : 'Bullish'}
- ATR: ${params.atr.toFixed(4)}

Last 10 candles (OHLCV): ${JSON.stringify(last10)}

Respond ONLY with this JSON:
{
  "verdict": "strong_buy|buy|neutral|sell|strong_sell",
  "confidence": <number 0-100>,
  "analysis": "<2-3 sentence technical analysis, referencing the specific pattern rules above>",
  "entryStrategy": "<specific entry price and trigger conditions>",
  "riskManagement": "<stop loss placement reasoning>",
  "keyLevels": ["<level description 1>", "<level description 2>", "<level description 3>"],
  "timeToTarget": "<estimated time to reach target>",
  "patternQuality": "confirmed|partial|failed",
  "confirmationsMet": ["<which confirmation rules from the spec are satisfied>"],
  "failureRisks": ["<which failure conditions from the spec are present, if any>"],
  "keyInsight": "<single most important observation>",
  "riskNote": "<specific risk for this pattern type per the spec>"
}`;

  try {
    const response = await getClient().chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });
    const text = response.choices[0]?.message?.content || '{}';
    return JSON.parse(text) as AnalysisResult;
  } catch {
    return safeAnalysisDefault;
  }
}

export async function analyzeChartImage(params: {
  base64Image: string;
  mimeType: string;
  question?: string;
}): Promise<VisionResult> {
  const userText = `Analyze this crypto price chart.
${params.question ? `User question: ${params.question}` : ''}

Identify and respond ONLY with this JSON:
{
  "pattern": { "name": "<string>", "type": "bullish|bearish|neutral", "confidence": <number> },
  "support": [<number>, <number>],
  "resistance": [<number>, <number>],
  "trend": "uptrend|downtrend|sideways",
  "candlestickPattern": "<string or null>",
  "entry": <number>,
  "stopLoss": <number>,
  "target": <number>,
  "riskReward": <number>,
  "analysis": "<detailed 3-4 sentence analysis>",
  "recommendation": "buy|sell|wait"
}`;

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content:
          'You are an expert crypto technical analyst. Analyze chart images and provide precise trading insights. Always respond in valid JSON only.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:${params.mimeType};base64,${params.base64Image}`,
              detail: 'high',
            },
          },
          { type: 'text', text: userText },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 1000,
    temperature: 0.3,
  });

  const text = response.choices[0]?.message?.content || '{}';
  return JSON.parse(text) as VisionResult;
}

export async function generateQuickSuggestion(params: {
  symbol: string;
  pattern: { name: string; type: string };
  rsi: number;
  price: number;
  timeframe: string;
}): Promise<QuickSuggestion> {
  try {
    const response = await getClient().chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: `Give a one-sentence trading alert for ${params.symbol.toUpperCase()}: ${params.pattern.name} detected, RSI ${params.rsi.toFixed(1)}, price ${params.price}. Be specific and actionable. JSON: { "suggestion": "<string>", "type": "bullish|bearish|neutral" }`,
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 150,
      temperature: 0.4,
    });
    const text = response.choices[0]?.message?.content || '{}';
    return JSON.parse(text) as QuickSuggestion;
  } catch {
    return { suggestion: 'Monitor price action closely.', type: 'neutral' };
  }
}

export async function streamAnalysis(params: {
  symbol: string;
  pattern: PatternResult;
  candles: Candle[];
  rsi: number;
  macd: { macd: number; signal: number; histogram: number };
  atr: number;
  support: number;
  resistance: number;
  target: number;
  stopLoss: number;
  riskReward: number;
  timeframe: string;
  currentPrice: number;
}): Promise<ReadableStream<Uint8Array>> {
  const last10 = params.candles.slice(-10).map((c) => ({
    t: c.time,
    o: c.open.toFixed(4),
    h: c.high.toFixed(4),
    l: c.low.toFixed(4),
    c: c.close.toFixed(4),
    v: c.volume.toFixed(2),
  }));

  const userPrompt = `Analyze ${params.symbol.toUpperCase()} on ${params.timeframe}: ${params.pattern.name} pattern (${params.pattern.confidence}% confidence). Price: ${params.currentPrice.toFixed(4)}, RSI: ${params.rsi.toFixed(1)}, Support: ${params.support.toFixed(4)}, Resistance: ${params.resistance.toFixed(4)}, Target: ${params.target.toFixed(4)}, Stop: ${params.stopLoss.toFixed(4)}. Last 10 candles: ${JSON.stringify(last10)}. Provide detailed analysis as JSON with: verdict, confidence, analysis, entryStrategy, riskManagement, keyLevels array, timeToTarget.`;

  const stream = await getClient().chat.completions.create({
    model: 'gpt-4o',
    stream: true,
    messages: [
      {
        role: 'system',
        content: 'You are an expert crypto technical analyst. Always respond in valid JSON only.',
      },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
  });

  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || '';
        if (text) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
        }
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}
