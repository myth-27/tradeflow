/**
 * TradeFlow — Pattern Knowledge Base
 *
 * Structured pattern knowledge extracted from the 5 source documents in
 * data_patterns/ (GoodCrypto-patterns-presentation.pdf, Idenitfying-Chart-Patterns.pdf,
 * Ondrej_Bucek_Bc_thesis.pdf, Price-Action-Trading-Guide.pdf, Technical-analysis-Price-patterns.pdf).
 *
 * Every numeric statistic here (win rate, avg move, failure rate) is taken directly from one of
 * those documents — none are invented. Where a pattern has no quantitative stats in the source
 * material, historicalWinRate/avgMove/failureRate are left at 0 and reliability is set from the
 * qualitative language the source actually uses ("below average performance" → 'low', etc.).
 * Each entry's `sources` field cites which PDF(s) the content came from for traceability.
 *
 * Retrieved via getPatternContextForGPT() and injected into the GPT-4o system prompt before
 * every pattern analysis call (see lib/openai.ts), so the model reasons from these specific
 * rules instead of generic training knowledge.
 */

export interface PatternKnowledge {
  name: string;
  aliases: string[];
  type: 'reversal' | 'continuation' | 'bilateral';
  direction: 'bullish' | 'bearish' | 'both';

  definition: string;
  characteristics: string[];
  targetFormula: string;
  targetCalculation: string;
  stopPlacement: string;
  confirmationRules: string[];
  failureConditions: string[];

  historicalWinRate: number; // 0 if the source gives no number
  avgMove: number;
  failureRate: number;
  bestConditions: string[];
  worstConditions: string[];

  bestTimeframes: string[];
  reliability: 'high' | 'medium' | 'low';
  sources: string[];
}

export const PATTERN_KNOWLEDGE_BASE: Record<string, PatternKnowledge> = {

  'Double Top': {
    name: 'Double Top',
    aliases: ['M-Top', 'Twin Peaks'],
    type: 'reversal',
    direction: 'bearish',
    definition: 'A price formation at the end of a bull move where price tests a resistance zone twice at approximately the same level, separated by a valley (the neckline). The pattern is only complete and confirmed when price closes below the neckline.',
    characteristics: [
      'Two successive peaks at approximately the same price level (resistance)',
      'Peaks separated by a valley — the neckline',
      'First peak forms on increased volume; decline to the valley on low volume',
      'Second rally attempt typically on lower volume than the first (supply outpacing demand)',
      'If the two tops form very close together in time, more likely just consolidation than a real reversal',
    ],
    targetFormula: 'Target = Neckline - (Peak height above neckline)',
    targetCalculation: 'Take the vertical height from the highest peak down to the neckline (valley low). Subtract that height from the neckline breakout price.',
    stopPlacement: 'Just above the higher of the two peaks',
    confirmationRules: [
      'Price must close below the neckline, not just wick through it',
      'High volume should accompany the breakdown',
      'Distrust the pattern if it formed too quickly on the chart',
    ],
    failureConditions: [
      'Breakout occurs without volume confirmation',
      'Price pulls back above the neckline after the initial breakdown',
    ],
    historicalWinRate: 0,
    avgMove: 0,
    failureRate: 0,
    bestConditions: ['Spot/cash markets (more reliable here than on futures/forward charts)'],
    worstConditions: ['Futures/forward charts — noted as "not all that reliable" there'],
    bestTimeframes: ['1h', '4h', '1d'],
    reliability: 'medium',
    sources: ['Technical-analysis-Price-patterns.pdf', 'GoodCrypto-patterns-presentation.pdf', 'Price-Action-Trading-Guide.pdf', 'Idenitfying-Chart-Patterns.pdf'],
  },

  'Double Bottom': {
    name: 'Double Bottom',
    aliases: ['W-Bottom', 'Twin Lows'],
    type: 'reversal',
    direction: 'bullish',
    definition: 'The inverse of double top, forming at the end of a decline. Two troughs at approximately the same support level separated by a peak (the neckline). Confirmed when price closes above the neckline.',
    characteristics: [
      'Two successive troughs at approximately the same price level (support)',
      'Troughs separated by an intermittent peak — the neckline',
      'Price tests support two or more times',
      'Volume should increase markedly on the rally off the second trough',
    ],
    targetFormula: 'Target = Neckline + (Neckline - Trough)',
    targetCalculation: 'Take the vertical height from the troughs up to the neckline (peak). Add that height to the neckline breakout price.',
    stopPlacement: 'Just below the lower of the two troughs',
    confirmationRules: [
      'Price must close above the neckline',
      'High volume should accompany the breakout',
    ],
    failureConditions: [
      'Price breaks back below the neckline after breakout',
    ],
    historicalWinRate: 0,
    avgMove: 0,
    failureRate: 0,
    bestConditions: ['Spot/cash markets'],
    worstConditions: ['Futures/forward charts — noted as "not all that reliable" there'],
    bestTimeframes: ['1h', '4h', '1d'],
    reliability: 'medium',
    sources: ['Technical-analysis-Price-patterns.pdf', 'GoodCrypto-patterns-presentation.pdf', 'Price-Action-Trading-Guide.pdf', 'Idenitfying-Chart-Patterns.pdf'],
  },

  'Head & Shoulders': {
    name: 'Head & Shoulders',
    aliases: ['H&S Top', 'HnS'],
    type: 'reversal',
    direction: 'bearish',
    definition: 'A three-peak reversal pattern where the center peak (head) is higher than the two outer peaks (shoulders), which sit at roughly equal levels. Described in the source material as the most reliable reversal pattern with one of the lowest failure rates.',
    characteristics: [
      'Three peaks: left shoulder, head (highest), right shoulder',
      'Shoulders at approximately the same level',
      'Left shoulder forms at the end of an extensive move on high volume',
      'Head rallies on normal/heavy volume, then reacts on low volume',
      'Right shoulder forms on declining volume relative to the left shoulder and head',
      'Neckline connects the two troughs between the peaks (can be flat or sloped)',
    ],
    targetFormula: 'Target = Neckline - (Head height above neckline)',
    targetCalculation: 'Measure the perpendicular distance from the head to the neckline. Project that same distance below the neckline breakout. Note: the pattern should not be expected to retrace more than the move that preceded it — that is the limiting factor on the target.',
    stopPlacement: 'Just above the head (the highest peak), or at a failsafe trendline',
    confirmationRules: [
      'Pattern is only complete on a neckline break',
      'A pullback to touch the neckline before continuing to decline is common and not a failure on its own',
      'Price must close beyond the pattern to activate it',
    ],
    failureConditions: [
      'Price reverses back above the neckline',
      'An excessive downside projection beyond where the prior move began is a warning sign',
    ],
    historicalWinRate: 87,
    avgMove: 0,
    failureRate: 13,
    bestConditions: ['After a sustained uptrend', 'Volume distribution pattern present (declining volume right shoulder vs left)'],
    worstConditions: ['Head only barely higher than the shoulders'],
    bestTimeframes: ['1h', '4h', '1d'],
    reliability: 'high',
    sources: ['Technical-analysis-Price-patterns.pdf (86-88% reliability)', 'Price-Action-Trading-Guide.pdf', 'Idenitfying-Chart-Patterns.pdf', 'GoodCrypto-patterns-presentation.pdf'],
  },

  'Inverse Head & Shoulders': {
    name: 'Inverse Head & Shoulders',
    aliases: ['Head & Shoulders Bottom', 'IH&S'],
    type: 'reversal',
    direction: 'bullish',
    definition: 'The upside-down version of Head & Shoulders, forming at market bottoms. The source notes bottom formations typically take much longer to form than top formations (sometimes a year or more vs a few weeks for tops) and are described as "not as profitable" as the top pattern.',
    characteristics: [
      'Inverted structure vs H&S top: left shoulder, head (lowest), right shoulder',
      'Left shoulder: price moves up off the first low on increasing volume',
      'Head: falls to a new low, then recovers on somewhat more volume',
      'Right shoulder: low-volume corrective reaction, then a sharp move up on heavier volume breaks the neckline',
      'Bottom formations often take several months to over a year to complete, vs a few weeks for top patterns',
    ],
    targetFormula: 'Target = Neckline + (Neckline - Head)',
    targetCalculation: 'Same measured-move logic as H&S top, inverted.',
    stopPlacement: 'Failsafe trendline below the head',
    confirmationRules: [
      'Pattern completes on a breakout above the neckline with heavier volume',
    ],
    failureConditions: [
      'Price fails to hold the neckline breakout',
    ],
    historicalWinRate: 0,
    avgMove: 0,
    failureRate: 0,
    bestConditions: ['After an extended downtrend, with patience for the longer formation time'],
    worstConditions: [],
    bestTimeframes: ['4h', '1d'],
    reliability: 'medium',
    sources: ['Price-Action-Trading-Guide.pdf', 'Idenitfying-Chart-Patterns.pdf'],
  },

  'Ascending Triangle': {
    name: 'Ascending Triangle',
    aliases: ['Rising Triangle'],
    type: 'continuation',
    direction: 'bullish',
    definition: 'A bullish continuation pattern bounded by a horizontal resistance line and a rising support line, formed from at least two higher lows. The source gives this pattern a high probability rating (75-80%) and notes it more commonly breaks upward.',
    characteristics: [
      'Horizontal resistance touched at least twice',
      'Rising support line touched at least twice (higher lows)',
      'A minimum 4-point reversal pattern (price must touch each bound at least twice)',
      'Breakout should not occur too far into the pattern — beyond ~3/4 of the horizontal distance to the apex weakens it',
    ],
    targetFormula: 'Target = Breakout price ± pattern height (height measured from the 2nd reversal point)',
    targetCalculation: 'Take the height from the highest peak to the lowest trough in the pattern. Add that height to the breakout price for an upside break, or subtract it for a downside break.',
    stopPlacement: 'Slightly beyond the rising support line (a couple of ticks)',
    confirmationRules: [
      'Breakout should occur with high volume',
      'Pattern more commonly breaks upward, but can break either way',
    ],
    failureConditions: [
      'Breakout without volume confirmation',
      'Violation of the rising support line destroys the pattern',
      'Many small false breakouts are common',
    ],
    historicalWinRate: 78,
    avgMove: 0,
    failureRate: 0,
    bestConditions: ['Rare on futures/forward charts; more prevalent and reliable on cash/spot charts'],
    worstConditions: [],
    bestTimeframes: ['15m', '1h', '4h'],
    reliability: 'high',
    sources: ['Technical-analysis-Price-patterns.pdf (75-80% probability)', 'GoodCrypto-patterns-presentation.pdf', 'Idenitfying-Chart-Patterns.pdf'],
  },

  'Descending Triangle': {
    name: 'Descending Triangle',
    aliases: ['Falling Triangle'],
    type: 'continuation',
    direction: 'bearish',
    definition: 'The bearish counterpart to the ascending triangle: bounded by horizontal support and a falling resistance line formed from lower highs. Originates from a bearish trend and most commonly resolves downward.',
    characteristics: [
      'Horizontal support touched at least twice',
      'Falling resistance line touched at least twice (lower highs)',
      'A minimum 4-point reversal pattern',
    ],
    targetFormula: 'Target = Breakout price ± pattern height (height measured from the 2nd reversal point)',
    targetCalculation: 'Same measured-move method as ascending triangle, applied to a downside break.',
    stopPlacement: 'Beyond the falling resistance line',
    confirmationRules: [
      'Breakout should occur with high volume',
    ],
    failureConditions: [
      'Breakout without volume confirmation',
      'Retracements after the breakout occur often',
    ],
    historicalWinRate: 0,
    avgMove: 0,
    failureRate: 0,
    bestConditions: ['Above-average performance noted specifically on upside breaks'],
    worstConditions: [],
    bestTimeframes: ['15m', '1h', '4h'],
    reliability: 'medium',
    sources: ['Technical-analysis-Price-patterns.pdf', 'GoodCrypto-patterns-presentation.pdf', 'Idenitfying-Chart-Patterns.pdf'],
  },

  'Symmetrical Triangle': {
    name: 'Symmetrical Triangle',
    aliases: ['Coil'],
    type: 'continuation',
    direction: 'both',
    definition: 'A bilateral consolidation pattern with a downward-sloping upper line and upward-sloping lower line converging toward an apex. The source describes an "overwhelming tendency" for a valid triangle to continue the prior trend, with a 76-78% reliability rating.',
    characteristics: [
      'Each boundary line touched at least twice',
      'Four reversals of the minor trend needed to draw both converging lines',
      'First reversal point is always at a relative high (bull market) or relative low (bear market)',
      'Volume usually drifts lower, somewhat irregularly, as the pattern forms',
      'Not active until a closing price posts beyond one boundary line',
    ],
    targetFormula: 'Target = Breakout price ± pattern height (measured from the 2nd reversal point)',
    targetCalculation: 'Take the height from the highest peak to the lowest trough. Add for an upside breakout, subtract for a downside breakout.',
    stopPlacement: 'Beyond the opposite boundary line from the breakout direction',
    confirmationRules: [
      'Must break with volume expansion',
      'Use the prior trend as a directional bias',
      'Many false breakouts occur — wait for a confirmed close outside the boundary',
    ],
    failureConditions: [
      'Violating the opposite boundary line, or price extending beyond the apex, destroys the pattern',
      'Even a single intra-bar violation of the opposite line can destroy it',
    ],
    historicalWinRate: 77,
    avgMove: 0,
    failureRate: 0,
    bestConditions: ['Best performance noted specifically on upward breakouts — "above average for all patterns when breaking upward"'],
    worstConditions: ['Used without any trend context to bias direction'],
    bestTimeframes: ['1h', '4h'],
    reliability: 'high',
    sources: ['Technical-analysis-Price-patterns.pdf (76-78% reliability)', 'GoodCrypto-patterns-presentation.pdf', 'Idenitfying-Chart-Patterns.pdf'],
  },

  'Bull Flag': {
    name: 'Bull Flag',
    aliases: ['Bullish Flag'],
    type: 'continuation',
    direction: 'bullish',
    definition: 'The source material covers "Flag" and "Pennant" as a combined continuation pattern rather than naming bullish/bearish variants separately: a short consolidation that forms a "half-way, breath-catching resting place" after a rapid, straight-line price move, normally sloping slightly against the trend. Applied here to the bullish (uptrend) case.',
    characteristics: [
      'Preceded by a rapid, sharp price advance (the "flagpole")',
      'Short, narrow, rectangular consolidation that slopes slightly downward (against the trend)',
      'On a daily chart the flag body seldom lasts more than ~5 sessions before the trend resumes',
      'Ideally minimal price activity/overlap within the flag range',
    ],
    targetFormula: 'Target = Breakout price + flagpole height',
    targetCalculation: 'Minimum measuring objective duplicates the rapid straight-line move that preceded the flag — take the flagpole\'s height and project it from the breakout point.',
    stopPlacement: 'Below the low of the flag consolidation',
    confirmationRules: [
      'Breakout should occur on high volume',
      'Once the flag objective is reached, the source notes a violent reversal often follows — a trailing stop is likely to be hit',
    ],
    failureConditions: [
      'Breakout without volume confirmation',
      'Pattern breaking in the opposite direction of the trend',
    ],
    historicalWinRate: 0,
    avgMove: 0,
    failureRate: 0,
    bestConditions: ['Daily timeframe charts — the source specifically notes flags "work best on daily time frame charts"'],
    worstConditions: [],
    bestTimeframes: ['5m', '15m', '1h', '1d'],
    reliability: 'medium',
    sources: ['Technical-analysis-Price-patterns.pdf (Flags & Pennants)', 'Idenitfying-Chart-Patterns.pdf'],
  },

  'Bear Flag': {
    name: 'Bear Flag',
    aliases: ['Bearish Flag'],
    type: 'continuation',
    direction: 'bearish',
    definition: 'Same generic Flag/Pennant pattern from the source material, applied to the bearish (downtrend) case — a short consolidation sloping slightly upward against a sharp prior decline, before the downtrend resumes.',
    characteristics: [
      'Preceded by a rapid, sharp price decline (the "flagpole")',
      'Short consolidation sloping slightly upward (against the trend)',
      'Seldom lasts more than ~5 sessions before resumption on a daily chart',
    ],
    targetFormula: 'Target = Breakout price - flagpole height',
    targetCalculation: 'Take the height of the decline that preceded the flag and project that same distance down from the breakdown point.',
    stopPlacement: 'Above the high of the flag consolidation',
    confirmationRules: [
      'Breakdown should occur on high volume',
    ],
    failureConditions: [
      'Breakdown without volume confirmation',
      'Pattern resolving upward instead of continuing the downtrend',
    ],
    historicalWinRate: 0,
    avgMove: 0,
    failureRate: 0,
    bestConditions: ['Daily timeframe charts'],
    worstConditions: [],
    bestTimeframes: ['5m', '15m', '1h', '1d'],
    reliability: 'medium',
    sources: ['Technical-analysis-Price-patterns.pdf (Flags & Pennants)', 'Idenitfying-Chart-Patterns.pdf'],
  },

  'Doji': {
    name: 'Doji',
    aliases: [],
    type: 'reversal',
    direction: 'both',
    definition: 'A single-candle pattern where the open and close are virtually identical, with shadows of varying length above and below. Extremely common; signals indecision and is a possible early warning of a price change, especially at trend extremes.',
    characteristics: [
      'Open and close at the same or nearly the same price',
      'High and low roughly equidistant from the open/close',
      'Long-Legged Doji: very long upper and lower shadows — strong opposing forces in balance',
      'Dragonfly Doji: open/close at the high, long lower shadow — more bullish, reversal signal at bottoms',
      'Gravestone Doji: open/close at the low, long upper shadow — more bearish, reversal signal at tops',
    ],
    targetFormula: 'No standard measured-move target — used as a reversal/indecision signal, typically combined with the surrounding level (S/R) for trade planning.',
    targetCalculation: 'Not applicable on its own; treat as a confirmation/warning signal within a larger setup.',
    stopPlacement: 'Beyond the high/low of the doji candle itself, in the direction of expected failure',
    confirmationRules: [
      'Far more meaningful as part of a larger pattern (e.g. Morning/Evening Doji Star, Harami Cross) than alone',
      'Best performance when it appears after an extended trend',
    ],
    failureConditions: [
      'Appearing mid-range with no preceding trend — much lower significance',
    ],
    historicalWinRate: 0,
    avgMove: 0,
    failureRate: 0,
    bestConditions: ['At trend extremes, after a sustained directional move'],
    worstConditions: ['In the middle of a range with no trend context'],
    bestTimeframes: ['15m', '1h', '4h'],
    reliability: 'low',
    sources: ['Price-Action-Trading-Guide.pdf', 'Idenitfying-Chart-Patterns.pdf'],
  },

  'Hammer': {
    name: 'Hammer',
    aliases: [],
    type: 'reversal',
    direction: 'bullish',
    definition: 'A candle with a small body near the high, little or no upper shadow, and a long lower tail (roughly 2-3x the body height). Bullish signal when it appears at the bottom of a downtrend. The source notes hammers occur fairly often but have below-average standalone performance.',
    characteristics: [
      'Small body positioned near the high of the candle',
      'Little to no upper shadow',
      'Lower shadow approximately 2-3x the body height',
      'Body can be bullish or bearish color',
      'Quantitative threshold used in one source: (min(open,close) - low) / (high - low) >= 0.7',
    ],
    targetFormula: 'Not a measured-move pattern — used as a reversal trigger with stop/target set from the swing structure.',
    targetCalculation: 'One source\'s algorithmic rule: stop at the low of the swing low; take-profit placed the same distance above entry as the stop is below it (1:1 baseline, scale from there).',
    stopPlacement: 'Below the low of the hammer / the swing low it formed at',
    confirmationRules: [
      'Best context: appearing at a support level or after an extended downtrend',
    ],
    failureConditions: [
      'On its own, performs below average — needs confirmation from level/volume context',
    ],
    historicalWinRate: 0,
    avgMove: 0,
    failureRate: 0,
    bestConditions: ['At market bottoms / established support, after a downtrend'],
    worstConditions: ['Standalone, without support/trend context — below-average performance'],
    bestTimeframes: ['15m', '1h', '4h'],
    reliability: 'low',
    sources: ['Price-Action-Trading-Guide.pdf', 'Idenitfying-Chart-Patterns.pdf', 'Ondrej_Bucek_Bc_thesis.pdf'],
  },

  'Shooting Star': {
    name: 'Shooting Star',
    aliases: [],
    type: 'reversal',
    direction: 'bearish',
    definition: 'The inverted hammer: small body with a long upper shadow, where the high coincides with the open or close. Bearish when appearing at market tops after an uptrend. The source rates standalone performance as average.',
    characteristics: [
      'Small body (either color)',
      'Long upper shadow/tail',
      'High coincides with the open or close',
      'Quantitative threshold used in one source: (high - max(open,close)) / (high - low) >= 0.7',
    ],
    targetFormula: 'Not a measured-move pattern — reversal trigger, stop/target from swing structure.',
    targetCalculation: 'One source\'s algorithmic rule: stop at the high of the swing high; take-profit the same distance below entry as the stop is above it.',
    stopPlacement: 'Above the high of the shooting star / the swing high it formed at',
    confirmationRules: [
      'Best context: appearing at resistance or after an extended uptrend',
    ],
    failureConditions: [
      'Average performance standalone — needs level/volume confirmation',
    ],
    historicalWinRate: 0,
    avgMove: 0,
    failureRate: 0,
    bestConditions: ['At market tops / resistance, after an uptrend'],
    worstConditions: [],
    bestTimeframes: ['15m', '1h', '4h'],
    reliability: 'low',
    sources: ['Price-Action-Trading-Guide.pdf', 'Idenitfying-Chart-Patterns.pdf', 'Ondrej_Bucek_Bc_thesis.pdf'],
  },

  'Engulfing Bullish': {
    name: 'Engulfing Bullish',
    aliases: ['Bullish Engulfing'],
    type: 'reversal',
    direction: 'bullish',
    definition: 'A two-candle pattern: a small black body followed by a larger white body that completely contains it. At market bottoms this is interpreted as a major upward reversal signal — the source notes very good performance when this occurs after a downtrend.',
    characteristics: [
      'First candle: small bearish (black) body',
      'Second candle: larger bullish (white) body that fully contains the first candle\'s body',
      'Best performance when appearing at the bottom after an extended downtrend',
    ],
    targetFormula: 'Not a measured-move pattern — reversal trigger; combine with nearby support/resistance for target planning.',
    targetCalculation: 'N/A — use the structure the engulfing pattern forms at (e.g. prior swing high as a first target).',
    stopPlacement: 'Below the low of the engulfing candle pair',
    confirmationRules: [
      'Strongest at the extremes of an established trend, not mid-range',
    ],
    failureConditions: [
      'Appearing without a preceding trend reduces significance',
    ],
    historicalWinRate: 0,
    avgMove: 0,
    failureRate: 0,
    bestConditions: ['After an extended downtrend — "very good performance" per source'],
    worstConditions: ['Mid-range, no trend context'],
    bestTimeframes: ['15m', '1h', '4h'],
    reliability: 'medium',
    sources: ['Price-Action-Trading-Guide.pdf', 'Idenitfying-Chart-Patterns.pdf'],
  },

  'Engulfing Bearish': {
    name: 'Engulfing Bearish',
    aliases: ['Bearish Engulfing'],
    type: 'reversal',
    direction: 'bearish',
    definition: 'The bearish counterpart: a small white body followed by a larger black body that completely contains it. Considered a major reversal signal at market tops.',
    characteristics: [
      'First candle: small bullish (white) body',
      'Second candle: larger bearish (black) body that fully contains the first candle\'s body',
      'Best performance after an extended uptrend',
    ],
    targetFormula: 'Not a measured-move pattern — reversal trigger; combine with nearby support/resistance for target planning.',
    targetCalculation: 'N/A — use the structure the engulfing pattern forms at.',
    stopPlacement: 'Above the high of the engulfing candle pair',
    confirmationRules: [
      'Strongest at the extremes of an established uptrend',
    ],
    failureConditions: [
      'Appearing without a preceding uptrend reduces significance',
    ],
    historicalWinRate: 0,
    avgMove: 0,
    failureRate: 0,
    bestConditions: ['After an extended uptrend'],
    worstConditions: ['Mid-range, no trend context'],
    bestTimeframes: ['15m', '1h', '4h'],
    reliability: 'medium',
    sources: ['Price-Action-Trading-Guide.pdf', 'Idenitfying-Chart-Patterns.pdf'],
  },

  'Morning Star': {
    name: 'Morning Star',
    aliases: ['Morning Doji Star'],
    type: 'reversal',
    direction: 'bullish',
    definition: 'A three-candle bullish reversal: a large bearish body, then a small body (or a doji — "Morning Doji Star", considered more bullish) gapping below it, then a large bullish body closing well into the first candle. Major reversal signal at market bottoms.',
    characteristics: [
      'Candle 1: large bearish body',
      'Candle 2: small body (or doji) below candle 1',
      'Candle 3: large bullish body closing well into candle 1\'s range',
      'The doji variant ("Morning Doji Star") is considered more bullish due to the added indecision signal',
    ],
    targetFormula: 'Not a measured-move pattern — reversal trigger; plan target from nearby resistance/structure.',
    targetCalculation: 'N/A',
    stopPlacement: 'Below the low of the three-candle pattern',
    confirmationRules: [
      'Best performance when preceded by a longer downtrend',
    ],
    failureConditions: [
      'Appearing without a preceding downtrend reduces significance',
    ],
    historicalWinRate: 0,
    avgMove: 0,
    failureRate: 0,
    bestConditions: ['After an extended downtrend'],
    worstConditions: [],
    bestTimeframes: ['1h', '4h', '1d'],
    reliability: 'medium',
    sources: ['Price-Action-Trading-Guide.pdf'],
  },

};

// ─── Retrieval ─────────────────────────────────────────────────────────

export function getPatternContext(patternName: string): string {
  const entry = Object.values(PATTERN_KNOWLEDGE_BASE).find(p =>
    p.name.toLowerCase() === patternName.toLowerCase() ||
    p.aliases.some(a => a.toLowerCase() === patternName.toLowerCase()),
  );

  if (!entry) {
    return `Pattern: ${patternName} — no specific knowledge base entry available. Apply general breakout/reversal rules and be explicit that this assessment is not backed by the pattern knowledge base.`;
  }

  const stats = entry.historicalWinRate > 0
    ? `- Reliability/Win Rate: ${entry.historicalWinRate}%\n${entry.failureRate > 0 ? `- Failure Rate: ${entry.failureRate}%\n` : ''}`
    : `- No quantitative win-rate statistic is given in the source material for this pattern — treat reliability as qualitative only (rated ${entry.reliability.toUpperCase()}).\n`;

  return `
PATTERN KNOWLEDGE BASE — ${entry.name.toUpperCase()}
═══════════════════════════════════════════════

Definition:
${entry.definition}

Key Characteristics:
${entry.characteristics.map(c => `• ${c}`).join('\n')}

Target Calculation:
Formula: ${entry.targetFormula}
Method: ${entry.targetCalculation}

Stop Placement: ${entry.stopPlacement}

Confirmation Required:
${entry.confirmationRules.map(r => `✓ ${r}`).join('\n')}

Failure Conditions (invalidates setup):
${entry.failureConditions.map(f => `✗ ${f}`).join('\n')}

Source-Documented Statistics:
${stats}
Best Conditions: ${entry.bestConditions.join(', ') || 'Not specified in source'}
Worst Conditions: ${entry.worstConditions.join(', ') || 'Not specified in source'}
Reliability: ${entry.reliability.toUpperCase()}
Best Timeframes: ${entry.bestTimeframes.join(', ')}
Sources: ${entry.sources.join('; ')}
`;
}

export function getPatternContextForGPT(
  patternName: string,
  signalType: 'bullish' | 'bearish',
  indicators: { rsi: number; macd: string; volume: number },
  htfBias: string,
): string {
  const knowledge = getPatternContext(patternName);

  return `
You are a professional crypto technical analyst. Use ONLY the following pattern specification —
extracted directly from real chart-pattern reference material — for your analysis. Do not fall
back on generic pattern knowledge; if the specification doesn't cover something, say so explicitly
rather than inventing a number or rule.

${knowledge}

CURRENT SETUP CONTEXT:
Pattern Direction: ${signalType.toUpperCase()}
HTF Trend Bias: ${htfBias}
RSI: ${indicators.rsi} ${indicators.rsi > 70 ? '(OVERBOUGHT — caution)' : indicators.rsi < 30 ? '(OVERSOLD — potential)' : '(neutral zone)'}
MACD: ${indicators.macd}
Volume Ratio: ${indicators.volume}x average ${indicators.volume > 1.5 ? '(HIGH VOLUME — confirms)' : indicators.volume < 0.8 ? '(LOW VOLUME — weak signal)' : '(average)'}

Based on the above pattern rules and current context:
1. Assess whether the current setup MATCHES the pattern's stated requirements.
2. Identify any FAILURE CONDITIONS present from the list above.
3. Calculate the target using the EXACT formula given.
4. Give a specific, rule-based trade assessment that cites which rules are met or violated.
`;
}
