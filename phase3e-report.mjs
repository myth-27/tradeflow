// Phase 3E Report Generator
// Compares Condition F (floor 75) and Condition G (no ranging) vs baseline (floor 60)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS = path.join(__dirname, 'training-exports');

function loadJson(file) {
  const fullPath = path.join(EXPORTS, file);
  if (!fs.existsSync(fullPath)) { console.error(`Missing: ${file}`); return []; }
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pct(val) {
  return `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`;
}

function delta(condVal, baseVal) {
  const d = condVal - baseVal;
  return `${d >= 0 ? '+' : ''}${d.toFixed(2)} (${d >= 0 ? '+' : ''}${((d / Math.abs(baseVal)) * 100).toFixed(1)}%)`;
}

function groupByKey(data) {
  const out = {};
  for (const r of data) {
    const key = `${r.windowId}|${r.symbol}|${r.timeframe}`;
    out[key] = r;
  }
  return out;
}

function windowRegimeLabel(windowId) {
  const map = { 1: 'bull', 2: 'bull', 3: 'bear', 4: 'bear', 5: 'choppy', 6: 'choppy' };
  return map[windowId] || 'unknown';
}

function summarize(data, label) {
  if (!data.length) return { label, count: 0 };
  const wr = mean(data.map(r => r.winRate));
  const pf = mean(data.map(r => r.profitFactor));
  const ret = mean(data.map(r => r.totalReturn));
  const dd = mean(data.map(r => r.maxDrawdown));
  const sharpe = mean(data.map(r => r.sharpeRatio));
  const exp = mean(data.map(r => r.expectancy));
  const trades = mean(data.map(r => r.totalTrades));
  return { label, count: data.length, wr, pf, ret, dd, sharpe, exp, trades };
}

function verdictStr(condSumm, baseSumm) {
  const wrDelta = condSumm.wr - baseSumm.wr;
  const pfDelta = condSumm.pf - baseSumm.pf;
  const retDelta = condSumm.ret - baseSumm.ret;

  const positiveSignals = [wrDelta > 0, pfDelta > 0, retDelta > 0].filter(Boolean).length;

  if (positiveSignals === 3) {
    if (wrDelta > 3 && pfDelta > 0.2) return 'STRONGLY CONFIRMS';
    return 'CONFIRMS';
  } else if (positiveSignals === 2) return 'MIXED (lean positive)';
  else if (positiveSignals === 1) return 'MIXED (lean negative)';
  else return 'CONTRADICTS';
}

function regimeBreakdownDiff(condData, baseData) {
  const baseMap = groupByKey(baseData);
  const regimes = ['strong_uptrend', 'weak_uptrend', 'strong_downtrend', 'weak_downtrend', 'ranging'];
  const stats = {};
  for (const r of regimes) {
    stats[r] = { baseWR: [], condWR: [], baseTrades: [], condTrades: [] };
  }

  for (const cRun of condData) {
    const key = `${cRun.windowId}|${cRun.symbol}|${cRun.timeframe}`;
    const bRun = baseMap[key];
    if (!bRun || !cRun.regimeBreakdown) continue;
    for (const r of regimes) {
      const cBD = cRun.regimeBreakdown[r];
      const bBD = bRun?.regimeBreakdown?.[r];
      if (cBD) {
        stats[r].condWR.push(cBD.winRate);
        stats[r].condTrades.push(cBD.tradesAllowed);
      }
      if (bBD) {
        stats[r].baseWR.push(bBD.winRate);
        stats[r].baseTrades.push(bBD.tradesAllowed);
      }
    }
  }
  return stats;
}

function rejectionDiff(condData, baseData) {
  const baseMap = groupByKey(baseData);
  const keys = [
    'tradesRejectedByScore', 'tradesRejectedByRR', 'tradesRejectedBySession',
    'tradesRejectedByDailyLimit', 'tradesRejectedByWeeklyLimit', 'tradesRejectedByRegime',
    'tradesRejectedByATR', 'tradesRejectedByLossStreak', 'tradesRejectedByHtfDisagreement',
  ];
  const out = {};
  for (const k of keys) {
    let baseTotal = 0, condTotal = 0, count = 0;
    for (const cRun of condData) {
      const bRun = baseMap[`${cRun.windowId}|${cRun.symbol}|${cRun.timeframe}`];
      if (!bRun || !cRun.rejections) continue;
      baseTotal += bRun.rejections?.[k] || 0;
      condTotal += cRun.rejections?.[k] || 0;
      count++;
    }
    out[k] = { base: baseTotal, cond: condTotal, delta: condTotal - baseTotal, count };
  }
  return out;
}

function runReport() {
  // Prefer the controlled baseline rerun (same Playwright session as CondF/G) for valid comparison.
  // Fall back to original baseline-campaign-results.json only if rerun doesn't exist.
  const baselineRerun = loadJson('phase3e-baseline-rerun-results.json');
  const baselineOld = loadJson('baseline-campaign-results.json');
  const baseline = baselineRerun.length >= 36 ? baselineRerun : baselineOld;
  const baselineSource = baselineRerun.length >= 36 ? 'phase3e-baseline-rerun-results.json (CONTROLLED)' : `baseline-campaign-results.json (ORIGINAL — ${baselineRerun.length}/36 rerun runs available)`;

  const condF = loadJson('phase3e-conditionF-results.json');
  const condG = loadJson('phase3e-conditionG-results.json');

  if (!baseline.length) { console.error('Baseline missing'); return; }

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const lines = [];
  const p = (...args) => lines.push(args.join(' '));

  p('═══════════════════════════════════════════════════════════════════');
  p('                   PHASE 3E EXPERIMENT REPORT');
  p('        Two-Lever Controlled Test: Score Floor vs Regime Filter');
  p(`                     Generated: ${now}`);
  p('═══════════════════════════════════════════════════════════════════');
  p('');
  p(`BASELINE:  ${baselineSource}`);
  p('           Score Floor = 60 | All regimes (incl. ranging) | 36 runs');
  p('COND F:    Score Floor = 75 | All regimes                  | 36 runs');
  p('COND G:    Score Floor = 60 | No ranging regime            | 36 runs');
  p('');
  p('Windows: 6 × (Bull ×2, Bear ×2, Choppy ×2)');
  p('Symbols: BTCUSDT, ETHUSDT, SOLUSDT');
  p('TFs:     15m, 1h');
  p('');

  // ─── Summary Tables ──────────────────────────────────────────────────────────
  const baseSumm = summarize(baseline, 'Baseline (floor 60)');
  const condFAll = condF;
  const condGAll = condG;

  p('─── AGGREGATE METRICS ─────────────────────────────────────────────');
  p('');
  p('                    | Baseline  | Cond F    | Cond G    |');
  p('                    | floor 60  | floor 75  | no range  |');
  p('─────────────────────────────────────────────────────────────────────');

  function row(label, fn) {
    const b = fn(baseline);
    const f = condFAll.length ? fn(condFAll) : null;
    const g = condGAll.length ? fn(condGAll) : null;
    const fStr = f !== null ? f.toFixed(2) : 'N/A';
    const gStr = g !== null ? g.toFixed(2) : 'N/A';
    const fDelta = f !== null ? (f - b >= 0 ? '+' : '') + (f - b).toFixed(2) : '';
    const gDelta = g !== null ? (g - b >= 0 ? '+' : '') + (g - b).toFixed(2) : '';
    p(`${label.padEnd(20)}| ${b.toFixed(2).padEnd(10)}| ${(fStr + '  ' + fDelta).padEnd(10)}| ${(gStr + '  ' + gDelta).padEnd(10)}|`);
  }

  const bWR = mean(baseline.map(r => r.winRate));
  const fWR = condFAll.length ? mean(condFAll.map(r => r.winRate)) : null;
  const gWR = condGAll.length ? mean(condGAll.map(r => r.winRate)) : null;
  p(`Win Rate (%)        | ${bWR.toFixed(1)}%    | ${fWR !== null ? fWR.toFixed(1) + '% (' + (fWR - bWR >= 0 ? '+' : '') + (fWR - bWR).toFixed(1) + ')' : 'N/A'}  | ${gWR !== null ? gWR.toFixed(1) + '% (' + (gWR - bWR >= 0 ? '+' : '') + (gWR - bWR).toFixed(1) + ')' : 'N/A'}  |`);

  const bPF = mean(baseline.map(r => r.profitFactor));
  const fPF = condFAll.length ? mean(condFAll.map(r => r.profitFactor)) : null;
  const gPF = condGAll.length ? mean(condGAll.map(r => r.profitFactor)) : null;
  p(`Profit Factor       | ${bPF.toFixed(3)}  | ${fPF !== null ? fPF.toFixed(3) + ' (' + (fPF - bPF >= 0 ? '+' : '') + (fPF - bPF).toFixed(3) + ')' : 'N/A'}  | ${gPF !== null ? gPF.toFixed(3) + ' (' + (gPF - bPF >= 0 ? '+' : '') + (gPF - bPF).toFixed(3) + ')' : 'N/A'}  |`);

  const bRet = mean(baseline.map(r => r.totalReturn));
  const fRet = condFAll.length ? mean(condFAll.map(r => r.totalReturn)) : null;
  const gRet = condGAll.length ? mean(condGAll.map(r => r.totalReturn)) : null;
  p(`Total Return (%)    | ${bRet.toFixed(1)}%  | ${fRet !== null ? fRet.toFixed(1) + '% (' + (fRet - bRet >= 0 ? '+' : '') + (fRet - bRet).toFixed(1) + ')' : 'N/A'}   | ${gRet !== null ? gRet.toFixed(1) + '% (' + (gRet - bRet >= 0 ? '+' : '') + (gRet - bRet).toFixed(1) + ')' : 'N/A'}   |`);

  const bDD = mean(baseline.map(r => r.maxDrawdown));
  const fDD = condFAll.length ? mean(condFAll.map(r => r.maxDrawdown)) : null;
  const gDD = condGAll.length ? mean(condGAll.map(r => r.maxDrawdown)) : null;
  p(`Max Drawdown (%)    | -${bDD.toFixed(1)}%  | ${fDD !== null ? '-' + fDD.toFixed(1) + '% (' + (fDD - bDD >= 0 ? '+' : '') + (fDD - bDD).toFixed(1) + ')' : 'N/A'}   | ${gDD !== null ? '-' + gDD.toFixed(1) + '% (' + (gDD - bDD >= 0 ? '+' : '') + (gDD - bDD).toFixed(1) + ')' : 'N/A'}   |`);

  const bSh = mean(baseline.map(r => r.sharpeRatio));
  const fSh = condFAll.length ? mean(condFAll.map(r => r.sharpeRatio)) : null;
  const gSh = condGAll.length ? mean(condGAll.map(r => r.sharpeRatio)) : null;
  p(`Sharpe Ratio        | ${bSh.toFixed(3)}  | ${fSh !== null ? fSh.toFixed(3) + ' (' + (fSh - bSh >= 0 ? '+' : '') + (fSh - bSh).toFixed(3) + ')' : 'N/A'}  | ${gSh !== null ? gSh.toFixed(3) + ' (' + (gSh - bSh >= 0 ? '+' : '') + (gSh - bSh).toFixed(3) + ')' : 'N/A'}  |`);

  const bEx = mean(baseline.map(r => r.expectancy));
  const fEx = condFAll.length ? mean(condFAll.map(r => r.expectancy)) : null;
  const gEx = condGAll.length ? mean(condGAll.map(r => r.expectancy)) : null;
  p(`Expectancy (R)      | ${bEx.toFixed(4)}| ${fEx !== null ? fEx.toFixed(4) + ' (' + (fEx - bEx >= 0 ? '+' : '') + (fEx - bEx).toFixed(4) + ')' : 'N/A'}| ${gEx !== null ? gEx.toFixed(4) + ' (' + (gEx - bEx >= 0 ? '+' : '') + (gEx - bEx).toFixed(4) + ')' : 'N/A'}|`);

  const bTr = mean(baseline.map(r => r.totalTrades));
  const fTr = condFAll.length ? mean(condFAll.map(r => r.totalTrades)) : null;
  const gTr = condGAll.length ? mean(condGAll.map(r => r.totalTrades)) : null;
  p(`Avg Trades/Run      | ${bTr.toFixed(0).padEnd(9)} | ${fTr !== null ? fTr.toFixed(0) + ' (' + (fTr - bTr >= 0 ? '+' : '') + (fTr - bTr).toFixed(0) + ')' : 'N/A'}      | ${gTr !== null ? gTr.toFixed(0) + ' (' + (gTr - bTr >= 0 ? '+' : '') + (gTr - bTr).toFixed(0) + ')' : 'N/A'}      |`);
  p('');

  // ─── By Market Regime ────────────────────────────────────────────────────────
  p('─── PERFORMANCE BY MARKET REGIME (WINDOW TYPE) ────────────────────');
  p('');
  for (const regimeType of ['bull', 'bear', 'choppy']) {
    const bSub = baseline.filter(r => r.handPickedRegime === regimeType);
    const fSub = condFAll.filter(r => r.handPickedRegime === regimeType);
    const gSub = condGAll.filter(r => r.handPickedRegime === regimeType);
    const bS = summarize(bSub, 'Base');
    const fS = summarize(fSub, 'CondF');
    const gS = summarize(gSub, 'CondG');
    p(`${regimeType.toUpperCase()} (${bSub.length} base runs):`);
    p(`  WR:  Base=${bS.wr.toFixed(1)}%  CondF=${fSub.length ? fS.wr.toFixed(1) + '%' : 'N/A'}  CondG=${gSub.length ? gS.wr.toFixed(1) + '%' : 'N/A'}`);
    p(`  PF:  Base=${bS.pf.toFixed(2)}  CondF=${fSub.length ? fS.pf.toFixed(2) : 'N/A'}  CondG=${gSub.length ? gS.pf.toFixed(2) : 'N/A'}`);
    p(`  Ret: Base=${pct(bS.ret)}  CondF=${fSub.length ? pct(fS.ret) : 'N/A'}  CondG=${gSub.length ? pct(gS.ret) : 'N/A'}`);
    p('');
  }

  // ─── By Timeframe ────────────────────────────────────────────────────────────
  p('─── PERFORMANCE BY TIMEFRAME ────────────────────────────────────────');
  p('');
  for (const tf of ['15m', '1h']) {
    const bSub = baseline.filter(r => r.timeframe === tf);
    const fSub = condFAll.filter(r => r.timeframe === tf);
    const gSub = condGAll.filter(r => r.timeframe === tf);
    const bS = summarize(bSub, 'Base');
    const fS = summarize(fSub, 'F');
    const gS = summarize(gSub, 'G');
    p(`${tf} (${bSub.length} base runs):`);
    p(`  WR:  Base=${bS.wr.toFixed(1)}%  CondF=${fSub.length ? fS.wr.toFixed(1) + '%' : 'N/A'}  CondG=${gSub.length ? gS.wr.toFixed(1) + '%' : 'N/A'}`);
    p(`  PF:  Base=${bS.pf.toFixed(2)}  CondF=${fSub.length ? fS.pf.toFixed(2) : 'N/A'}  CondG=${gSub.length ? gS.pf.toFixed(2) : 'N/A'}`);
    p(`  Ret: Base=${pct(bS.ret)}  CondF=${fSub.length ? pct(fS.ret) : 'N/A'}  CondG=${gSub.length ? pct(gS.ret) : 'N/A'}`);
    p(`  Trades: Base=${bS.trades.toFixed(0)}  CondF=${fSub.length ? fS.trades.toFixed(0) : 'N/A'}  CondG=${gSub.length ? gS.trades.toFixed(0) : 'N/A'}`);
    p('');
  }

  // ─── Ranging Regime Impact Analysis (for Cond G) ─────────────────────────────
  if (condGAll.length) {
    p('─── RANGING REGIME IMPACT (Condition G Analysis) ────────────────────');
    p('');
    const baseMap = groupByKey(baseline);
    let totalRangingTradesBase = 0, totalRangingWins = 0, totalRangingLosses = 0;
    let rangingWRSum = 0, rangingCount = 0;
    for (const r of baseline) {
      const bd = r.regimeBreakdown?.ranging;
      if (bd && bd.tradesAllowed > 0) {
        totalRangingTradesBase += bd.tradesAllowed;
        rangingWRSum += bd.winRate * bd.tradesAllowed;
        rangingCount++;
      }
    }
    const rangingWR = totalRangingTradesBase > 0 ? rangingWRSum / totalRangingTradesBase : 0;
    p(`Ranging trades in baseline:  ${totalRangingTradesBase} total trades`);
    p(`Ranging regime WR (baseline): ${rangingWR.toFixed(1)}%`);
    p(`(Expected WR from score bands: ~42-45%)`);
    p('');

    // Trades removed by excluding ranging
    let tradeDiff = 0;
    for (const g of condGAll) {
      const b = baseMap[`${g.windowId}|${g.symbol}|${g.timeframe}`];
      if (b) tradeDiff += (b.totalTrades - g.totalTrades);
    }
    p(`Avg trades removed per run by excluding ranging: ${(tradeDiff / condGAll.length).toFixed(0)}`);
    p('');
  }

  // ─── Rejection Impact (Condition F) ──────────────────────────────────────────
  if (condFAll.length) {
    p('─── SCORE FLOOR IMPACT: Extra Rejections from Floor 60→75 (Cond F) ─');
    p('');
    const baseMap = groupByKey(baseline);
    let extraByScore = 0, tradeCountF = 0;
    for (const f of condFAll) {
      const b = baseMap[`${f.windowId}|${f.symbol}|${f.timeframe}`];
      if (b && f.rejections && b.rejections) {
        extraByScore += (f.rejections.tradesRejectedByScore || 0) - (b.rejections?.tradesRejectedByScore || 0);
        tradeCountF++;
      }
    }
    const tradeDiff = condFAll.length
      ? mean(baseline.map(r => r.totalTrades)) - mean(condFAll.map(r => r.totalTrades))
      : 0;
    p(`Extra score rejections per run (floor 60→75): ${(extraByScore / (tradeCountF || 1)).toFixed(0)}`);
    p(`Avg trades removed per run by floor raise: ${tradeDiff.toFixed(0)}`);
    p('');
  }

  // ─── VERDICTS ────────────────────────────────────────────────────────────────
  p('═══════════════════════════════════════════════════════════════════');
  p('                         PHASE 3E VERDICTS');
  p('═══════════════════════════════════════════════════════════════════');
  p('');

  if (condFAll.length >= 18) {
    const fWR_ = mean(condFAll.map(r => r.winRate));
    const fPF_ = mean(condFAll.map(r => r.profitFactor));
    const fRet_ = mean(condFAll.map(r => r.totalReturn));
    const bWR_ = mean(baseline.map(r => r.winRate));
    const bPF_ = mean(baseline.map(r => r.profitFactor));
    const bRet_ = mean(baseline.map(r => r.totalReturn));
    const v = verdictStr({ wr: fWR_, pf: fPF_, ret: fRet_ }, { wr: bWR_, pf: bPF_, ret: bRet_ });
    p(`CONDITION F (Score Floor 60 → 75): ${v}`);
    p(`  Hypothesis: raising floor removes low-edge trades and improves quality`);
    p(`  WR:  ${bWR_.toFixed(1)}% → ${fWR_.toFixed(1)}% (${(fWR_ - bWR_ >= 0 ? '+' : '')}${(fWR_ - bWR_).toFixed(1)} pp)`);
    p(`  PF:  ${bPF_.toFixed(3)} → ${fPF_.toFixed(3)} (${(fPF_ - bPF_ >= 0 ? '+' : '')}${(fPF_ - bPF_).toFixed(3)})`);
    p(`  Ret: ${pct(bRet_)} → ${pct(fRet_)} (${(fRet_ - bRet_ >= 0 ? '+' : '')}${(fRet_ - bRet_).toFixed(1)} pp)`);
    p(`  Trades: ${mean(baseline.map(r => r.totalTrades)).toFixed(0)} → ${mean(condFAll.map(r => r.totalTrades)).toFixed(0)} avg/run`);
    const fDD_ = mean(condFAll.map(r => r.maxDrawdown));
    const bDD_ = mean(baseline.map(r => r.maxDrawdown));
    p(`  MaxDD: -${bDD_.toFixed(1)}% → -${fDD_.toFixed(1)}% (${(fDD_ - bDD_ >= 0 ? '+' : '')}${(fDD_ - bDD_).toFixed(1)} pp)`);
    p(`  → RECOMMENDED ACTION: ${v.includes('CONFIRMS') ? 'RAISE score floor to 75' : v.includes('MIXED') ? 'Partial raise to 65-70 (not full 75)' : 'KEEP floor at 60'}`);
  } else {
    p(`CONDITION F: INCOMPLETE (${condFAll.length}/36 runs)`);
  }
  p('');

  if (condGAll.length >= 18) {
    const gWR_ = mean(condGAll.map(r => r.winRate));
    const gPF_ = mean(condGAll.map(r => r.profitFactor));
    const gRet_ = mean(condGAll.map(r => r.totalReturn));
    const bWR_ = mean(baseline.map(r => r.winRate));
    const bPF_ = mean(baseline.map(r => r.profitFactor));
    const bRet_ = mean(baseline.map(r => r.totalReturn));
    const v = verdictStr({ wr: gWR_, pf: gPF_, ret: gRet_ }, { wr: bWR_, pf: bPF_, ret: bRet_ });
    p(`CONDITION G (Exclude Ranging Regime): ${v}`);
    p(`  Hypothesis: ranging removes worst-performing regime (42% WR, -0.15R mean)`);
    p(`  WR:  ${bWR_.toFixed(1)}% → ${gWR_.toFixed(1)}% (${(gWR_ - bWR_ >= 0 ? '+' : '')}${(gWR_ - bWR_).toFixed(1)} pp)`);
    p(`  PF:  ${bPF_.toFixed(3)} → ${gPF_.toFixed(3)} (${(gPF_ - bPF_ >= 0 ? '+' : '')}${(gPF_ - bPF_).toFixed(3)})`);
    p(`  Ret: ${pct(bRet_)} → ${pct(gRet_)} (${(gRet_ - bRet_ >= 0 ? '+' : '')}${(gRet_ - bRet_).toFixed(1)} pp)`);
    const gTr_ = mean(condGAll.map(r => r.totalTrades));
    const bTr_ = mean(baseline.map(r => r.totalTrades));
    p(`  Trades: ${bTr_.toFixed(0)} → ${gTr_.toFixed(0)} avg/run (${((gTr_ - bTr_) / bTr_ * 100).toFixed(1)}% change)`);
    const gDD_ = mean(condGAll.map(r => r.maxDrawdown));
    const bDD_ = mean(baseline.map(r => r.maxDrawdown));
    p(`  MaxDD: -${bDD_.toFixed(1)}% → -${gDD_.toFixed(1)}% (${(gDD_ - bDD_ >= 0 ? '+' : '')}${(gDD_ - bDD_).toFixed(1)} pp)`);
    p(`  → RECOMMENDED ACTION: ${v.includes('CONFIRMS') ? 'EXCLUDE ranging from allowedRegimes' : v.includes('MIXED') ? 'Use regime size multiplier (e.g. 0.25x) instead of full exclusion' : 'KEEP ranging (exclusion hurts trade count too much)'}`);
  } else {
    p(`CONDITION G: INCOMPLETE (${condGAll.length}/36 runs)`);
  }
  p('');

  // ─── Combined Recommendation ────────────────────────────────────────────────
  p('─── COMBINED RECOMMENDATION ────────────────────────────────────────');
  p('');
  if (condFAll.length >= 18 && condGAll.length >= 18) {
    const fBetter = mean(condFAll.map(r => r.profitFactor)) > mean(baseline.map(r => r.profitFactor));
    const gBetter = mean(condGAll.map(r => r.profitFactor)) > mean(baseline.map(r => r.profitFactor));
    if (fBetter && gBetter) {
      const fGain = mean(condFAll.map(r => r.profitFactor)) - mean(baseline.map(r => r.profitFactor));
      const gGain = mean(condGAll.map(r => r.profitFactor)) - mean(baseline.map(r => r.profitFactor));
      const winner = fGain > gGain ? 'Condition F (floor 75)' : 'Condition G (no ranging)';
      p(`Both levers improve PF vs baseline. Stronger lever: ${winner} (+${Math.max(fGain, gGain).toFixed(3)} PF)`);
      p(`Consider combining: floor=75 + exclude ranging for maximum quality filter.`);
      p(`Note: combining will further reduce trade count — verify minimum 30 trades/run.`);
    } else if (fBetter) {
      p(`Only Condition F (floor 75) improves PF. Recommend: raise floor to 75.`);
    } else if (gBetter) {
      p(`Only Condition G (no ranging) improves PF. Recommend: exclude ranging regime.`);
    } else {
      p(`Neither lever improved PF over baseline. Score floor and regime filter are`);
      p(`already at near-optimal settings. No change recommended.`);
    }
  } else {
    p(`Incomplete data — run both conditions to 36 runs for full recommendation.`);
  }
  p('');
  p('═══════════════════════════════════════════════════════════════════');
  p(`Report complete. Baseline: ${baseline.length} runs | CondF: ${condFAll.length}/36 | CondG: ${condGAll.length}/36`);
  p('═══════════════════════════════════════════════════════════════════');

  const report = lines.join('\n');
  console.log(report);

  const outPath = path.join(EXPORTS, 'phase3e-report.txt');
  fs.writeFileSync(outPath, report);
  console.log(`\n→ Saved to ${outPath}`);
}

runReport();
