'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { getAllSimulations } from '@/lib/simulation-memory';
import {
  buildDatasetFromSimulations, analyzeDataset, trainingRowsToCSV, trainingRowsToJSON,
  buildTrainingNotebook, type TrainingRow, type DatasetStats,
} from '@/lib/ml-dataset';
import type { SimulationMemoryRecord } from '@/lib/db';

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function QualityBar({ label, pct, detail }: { label: string; pct: number; detail: string }) {
  const filled = Math.round(Math.min(100, pct) / 12.5);
  const bar = '█'.repeat(filled) + '░'.repeat(8 - filled);
  return (
    <div className="flex items-center gap-3 text-[12px]">
      <span className="w-32 text-[#888888] flex-shrink-0">{label}</span>
      <span className="font-mono text-[#3b82f6] tracking-tight">{bar}</span>
      <span className="text-[#666] flex-shrink-0">{detail}</span>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-4">
      <div className="text-[9px] text-[#666] uppercase tracking-wider mb-1.5">{label}</div>
      <div className="text-[20px] font-mono font-bold" style={{ color: color ?? '#f5f5f5' }}>{value}</div>
    </div>
  );
}

export default function DatasetPage() {
  const [sims, setSims] = useState<SimulationMemoryRecord[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAllSimulations().then(s => { setSims(s); setLoading(false); });
  }, []);

  const rows: TrainingRow[] = useMemo(() => sims ? buildDatasetFromSimulations(sims) : [], [sims]);
  const stats: DatasetStats = useMemo(() => analyzeDataset(rows), [rows]);

  const symbolsCovered = useMemo(() => Array.from(new Set(rows.map(r => r.symbol))), [rows]);
  const timeframesCovered = useMemo(() => Array.from(new Set(rows.map(r => r.timeframe))), [rows]);

  const csvFilename = `tradeflow_training_dataset.csv`;

  const handleExportCsv = () => downloadFile(trainingRowsToCSV(rows), csvFilename, 'text/csv');
  const handleExportJson = () => downloadFile(trainingRowsToJSON(rows), 'tradeflow_training_dataset.json', 'application/json');
  const handleExportNotebook = () => downloadFile(buildTrainingNotebook(csvFilename), 'tradeflow_ml_training.ipynb', 'application/json');

  const previewRows = rows.slice(0, 5);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f5f5f5]">
      <div className="max-w-[1200px] mx-auto px-6 py-8">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black">
              📊 ML Training Dataset
            </h1>
            <p className="text-[13px] text-[#888888] mt-1">Every backtest trade, feature-engineered for model training. Built from {sims?.length ?? 0} stored simulation{sims?.length === 1 ? '' : 's'}.</p>
          </div>
          <Link href="/simulate" className="text-[12px] text-[#3b82f6] hover:underline">← Back to Simulator</Link>
        </header>

        {loading && <div className="text-[#888888] text-[13px]">Loading dataset from memory...</div>}

        {!loading && rows.length === 0 && (
          <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-8 text-center">
            <p className="text-[14px] text-[#888888]">No training data yet. Run a few simulations on the Simulator page — every completed run is automatically saved here.</p>
            <Link href="/simulate" className="inline-block mt-4 px-4 py-2 rounded-lg bg-[#3b82f6] text-white text-[13px] font-semibold">Go run a simulation</Link>
          </div>
        )}

        {!loading && rows.length > 0 && (
          <div className="space-y-6">
            <div className="grid grid-cols-4 gap-4">
              <StatCard label="Training Examples" value={stats.totalRows.toLocaleString()} />
              <StatCard label="Win Rate" value={`${stats.winRate}%`} color={stats.winRate >= 50 ? '#22c55e' : '#ef4444'} />
              <StatCard label="Avg R-Multiple" value={`${stats.avgRMultiple >= 0 ? '+' : ''}${stats.avgRMultiple}`} color={stats.avgRMultiple >= 0 ? '#22c55e' : '#ef4444'} />
              <StatCard label="Ready for ML" value={stats.readyForML ? '✓ Yes' : 'Not yet'} color={stats.readyForML ? '#22c55e' : '#f59e0b'} />
            </div>

            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
              <div className="text-[14px] font-semibold mb-4">Dataset Quality Score</div>
              <div className="space-y-2.5">
                <QualityBar label="Sample Size" pct={(stats.totalRows / 500) * 100} detail={`${stats.totalRows} / 500 target`} />
                <QualityBar label="Class Balance" pct={Math.min(stats.winRate, 100 - stats.winRate) * 2} detail={`${stats.winRate}% wins`} />
                <QualityBar label="Pattern Variety" pct={(Object.keys(stats.patternCounts).length / 8) * 100} detail={`${Object.keys(stats.patternCounts).length} patterns`} />
                <QualityBar label="Regime Coverage" pct={(Object.keys(stats.regimeCounts).length / 6) * 100} detail={`${Object.keys(stats.regimeCounts).length} regimes`} />
              </div>
              <div className="mt-4 pt-3 border-t border-[#1f1f1f] text-[12px] font-semibold" style={{ color: stats.readyForML ? '#22c55e' : '#f59e0b' }}>
                {stats.readyForML ? '✓ Ready for Random Forest / XGBoost training' : 'Building phase — run more simulations to grow the dataset'}
              </div>
              {stats.recommendations.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {stats.recommendations.map((r, i) => (
                    <li key={i} className="text-[11px] text-[#888888]">⚠ {r}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
              <div className="text-[14px] font-semibold mb-3">Feature Columns Preview (first 5 rows)</div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] min-w-[700px]">
                  <thead>
                    <tr className="text-[9px] text-[#666] uppercase text-left border-b border-[#1f1f1f]">
                      <th className="py-1.5">Pattern</th><th>RSI</th><th>HTF Bias</th><th>Vol Ratio</th><th>Regime</th><th>R-Multiple</th><th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map(r => (
                      <tr key={r.id} className="border-b border-[rgba(26,26,26,0.5)]">
                        <td className="py-1.5">{r.pattern}</td>
                        <td className="font-mono">{r.rsi.toFixed(0)}</td>
                        <td className="font-mono">{r.htfBias > 0 ? 'bullish' : r.htfBias < 0 ? 'bearish' : 'neutral'}</td>
                        <td className="font-mono">{r.volumeRatio.toFixed(2)}x</td>
                        <td className="font-mono">{r.regime}</td>
                        <td className={`font-mono ${r.rMultiple >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>{r.rMultiple >= 0 ? '+' : ''}{r.rMultiple.toFixed(2)}</td>
                        <td className="font-mono">{r.outcome}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
              <div className="text-[14px] font-semibold mb-3">Export</div>
              <div className="flex gap-3">
                <button onClick={handleExportCsv} className="px-4 py-2 rounded-lg bg-[#1a1a1a] border border-[#222] text-[13px] text-[#f5f5f5] hover:border-[#3b82f6]">⬇ Download CSV</button>
                <button onClick={handleExportJson} className="px-4 py-2 rounded-lg bg-[#1a1a1a] border border-[#222] text-[13px] text-[#f5f5f5] hover:border-[#3b82f6]">⬇ Download JSON</button>
                <button onClick={handleExportNotebook} className="px-4 py-2 rounded-lg bg-[#1a1a1a] border border-[#222] text-[13px] text-[#f5f5f5] hover:border-[#3b82f6]">⬇ Python Notebook</button>
              </div>
              <p className="text-[10px] text-[#666] mt-3">All {Object.keys(rows[0] ?? {}).length} feature columns included — pattern, indicators, HTF bias proxy, regime, entry quality, streak/drawdown context, plus the outcome and rMultiple labels.</p>
            </div>

            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
              <div className="text-[14px] font-semibold mb-3">Python Quickstart</div>
              <pre className="bg-[#0d0d0d] border border-[#1f1f1f] rounded-lg p-4 text-[11px] text-[#cccccc] overflow-x-auto font-mono leading-relaxed">
{`from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
import pandas as pd

df = pd.read_csv('${csvFilename}')
features = [
    'patternEncoded', 'direction', 'patternConfidence',
    'htfBias', 'htfStrength', 'rsi', 'rsiZone',
    'macdSign', 'macdMomentum', 'atrPct', 'volumeRatio',
    'highVolume', 'regimeEncoded', 'rrRatio',
    'distToSupport', 'distToResistance', 'hourUTC',
    'consecutiveLossesBefore',
]

X = df[features]
y = df['outcomeEncoded']  # 1=win, 0=BE, -1=loss

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, shuffle=False  # no shuffle for time series
)

model = RandomForestClassifier(
    n_estimators=100, class_weight='balanced', random_state=42
)
model.fit(X_train, y_train)
print(model.score(X_test, y_test))

importance = pd.Series(
    model.feature_importances_, index=features
).sort_values(ascending=False)
print(importance.head(10))`}
              </pre>
            </div>

            <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-5">
              <div className="text-[14px] font-semibold mb-3">Accumulated Across All Simulations</div>
              <div className="grid grid-cols-4 gap-4 text-[12px]">
                <div><span className="text-[#666]">Total examples: </span><span className="font-mono text-[#f5f5f5]">{stats.totalRows}</span></div>
                <div><span className="text-[#666]">Simulations: </span><span className="font-mono text-[#f5f5f5]">{sims?.length ?? 0}</span></div>
                <div><span className="text-[#666]">Symbols: </span><span className="font-mono text-[#f5f5f5]">{symbolsCovered.join(', ') || '—'}</span></div>
                <div><span className="text-[#666]">Timeframes: </span><span className="font-mono text-[#f5f5f5]">{timeframesCovered.join(', ') || '—'}</span></div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
