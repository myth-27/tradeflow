'use client';

/**
 * TradeFlow V3 — Memory & Learning Panel
 *
 * Shows system memory state, learning status, feature importance,
 * pattern evolution, and the learning report.
 */

import { useState, useEffect, useCallback } from 'react';
import { getMemoryStats } from '@/lib/db';
import { getLatestImportance, type FeatureRanking } from '@/lib/feature-importance';
import { getAllPatternStates, type PatternEvolutionState } from '@/lib/pattern-evolution';
import { getLearningHistory, parseFindings } from '@/lib/self-learning-engine';
import { type LearningSnapshotRecord } from '@/lib/db';
import { runImprovementCycle, formatImprovementReport, type ImprovementReport } from '@/lib/continuous-improvement';
import { downloadExport, importFromFile } from '@/lib/data-export';

type Tab = 'memory' | 'features' | 'patterns' | 'learning';

export default function MemoryPanel() {
  const [tab, setTab] = useState<Tab>('memory');
  const [memStats, setMemStats] = useState({ signals: 0, simulations: 0, edgeEntries: 0, learningCycles: 0, drawings: 0 });
  const [featureRankings, setFeatureRankings] = useState<FeatureRanking[]>([]);
  const [patternStates, setPatternStates] = useState<PatternEvolutionState[]>([]);
  const [learningHistory, setLearningHistory] = useState<LearningSnapshotRecord[]>([]);
  const [isLearning, setIsLearning] = useState(false);
  const [lastReport, setLastReport] = useState<ImprovementReport | null>(null);
  const [importMsg, setImportMsg] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [stats, features, patterns, history] = await Promise.all([
        getMemoryStats(),
        getLatestImportance(),
        getAllPatternStates(),
        getLearningHistory(),
      ]);
      setMemStats(stats);
      setFeatureRankings(features);
      setPatternStates(patterns);
      setLearningHistory(history);
    } catch { /* IndexedDB not available during SSR */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleRunLearning = async () => {
    setIsLearning(true);
    try {
      const report = await runImprovementCycle();
      setLastReport(report);
      await refresh();
    } catch (e) {
      console.error('Learning cycle failed:', e);
    }
    setIsLearning(false);
  };

  const handleExport = async () => {
    await downloadExport();
  };

  const handleImport = async () => {
    const result = await importFromFile();
    setImportMsg(result.message);
    if (result.success) await refresh();
    setTimeout(() => setImportMsg(''), 4000);
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'memory', label: '📊 Memory' },
    { key: 'features', label: '🎯 Features' },
    { key: 'patterns', label: '📈 Patterns' },
    { key: 'learning', label: '🧠 Learning' },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', borderLeft: '1px solid #1f1f1f' }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex', borderBottom: '1px solid #1f1f1f',
        padding: '0 4px', flexShrink: 0,
      }}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              flex: 1, padding: '6px 0', fontSize: '9px', fontWeight: 600,
              color: tab === t.key ? '#f5f5f5' : '#555',
              background: tab === t.key ? '#1a1a1a' : 'transparent',
              border: 'none', cursor: 'pointer',
              borderBottom: tab === t.key ? '2px solid #8b5cf6' : '2px solid transparent',
              transition: 'all 0.2s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '8px 10px' }}>
        {tab === 'memory' && (
          <div>
            <SectionHeader>SYSTEM MEMORY</SectionHeader>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '12px' }}>
              <MemoryCard label="Signals" value={memStats.signals.toLocaleString()} icon="📡" />
              <MemoryCard label="Simulations" value={memStats.simulations.toString()} icon="📊" />
              <MemoryCard label="Edge Entries" value={memStats.edgeEntries.toString()} icon="🎯" />
              <MemoryCard label="Learning Cycles" value={memStats.learningCycles.toString()} icon="🧠" />
            </div>

            <SectionHeader>DATA MANAGEMENT</SectionHeader>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <ActionButton onClick={handleExport} label="Export Data" sublabel="Download JSON backup" icon="💾" />
              <ActionButton onClick={handleImport} label="Import Data" sublabel="Load from file" icon="📥" />
              <ActionButton
                onClick={handleRunLearning}
                label={isLearning ? 'Learning...' : 'Run Learning Cycle'}
                sublabel={isLearning ? 'Analyzing all data...' : `${memStats.signals} signals available`}
                icon={isLearning ? '⏳' : '🧠'}
                disabled={isLearning}
                accent
              />
            </div>
            {importMsg && (
              <div style={{ marginTop: '6px', fontSize: '9px', color: '#22c55e', padding: '4px 6px', background: 'rgba(34,197,94,0.1)', borderRadius: '4px' }}>
                {importMsg}
              </div>
            )}
          </div>
        )}

        {tab === 'features' && (
          <div>
            <SectionHeader>FEATURE IMPORTANCE</SectionHeader>
            <div style={{ fontSize: '9px', color: '#555', marginBottom: '8px' }}>
              Which variables predict profitability
            </div>
            {featureRankings.map((f, i) => (
              <div key={f.feature} style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                <span style={{ fontSize: '9px', color: '#666', width: '16px', textAlign: 'right' }}>{i + 1}.</span>
                <span style={{ fontSize: '10px', color: '#ccc', width: '80px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.description}
                </span>
                <div style={{ flex: 1, height: '6px', borderRadius: '3px', background: '#1a1a1a' }}>
                  <div style={{
                    width: `${f.importance}%`, height: '100%', borderRadius: '3px',
                    background: i === 0 ? '#fbbf24' : i < 3 ? '#22c55e' : '#3b82f6',
                    transition: 'width 0.5s',
                  }} />
                </div>
                <span style={{
                  fontSize: '9px', fontWeight: 700, color: i === 0 ? '#fbbf24' : '#888',
                  width: '28px', textAlign: 'right',
                  fontFamily: "'SF Mono', 'Fira Code', monospace",
                  fontFeatureSettings: "'tnum'",
                }}>
                  {f.importance}%
                </span>
              </div>
            ))}
          </div>
        )}

        {tab === 'patterns' && (
          <div>
            <SectionHeader>PATTERN EVOLUTION</SectionHeader>
            {patternStates.length === 0 ? (
              <div style={{ fontSize: '10px', color: '#555', textAlign: 'center', padding: '20px 0' }}>
                No pattern data yet. Run simulations or trade to build pattern history.
              </div>
            ) : (
              patternStates.map(p => (
                <div key={p.pattern} style={{
                  padding: '6px 8px', marginBottom: '4px', borderRadius: '4px',
                  background: '#111', border: '1px solid #1f1f1f',
                  borderLeft: `3px solid ${
                    p.status === 'promoted' ? '#22c55e' :
                    p.status === 'downgraded' ? '#f59e0b' :
                    p.status === 'disabled' ? '#ef4444' : '#3b82f6'
                  }`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '10px', fontWeight: 600, color: '#f5f5f5' }}>{p.pattern}</span>
                    <span style={{
                      fontSize: '8px', fontWeight: 700, textTransform: 'uppercase',
                      padding: '1px 6px', borderRadius: '3px',
                      color: p.status === 'promoted' ? '#22c55e' :
                        p.status === 'downgraded' ? '#f59e0b' :
                        p.status === 'disabled' ? '#ef4444' : '#888',
                      background: p.status === 'promoted' ? 'rgba(34,197,94,0.1)' :
                        p.status === 'downgraded' ? 'rgba(245,158,11,0.1)' :
                        p.status === 'disabled' ? 'rgba(239,68,68,0.1)' : 'rgba(136,136,136,0.1)',
                    }}>
                      {p.status}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '3px' }}>
                    <MiniStat label="Trades" value={p.totalTrades.toString()} />
                    <MiniStat label="WR" value={`${p.winRate.toFixed(0)}%`} color={p.winRate >= 55 ? '#22c55e' : '#ef4444'} />
                    <MiniStat label="PF" value={p.profitFactor.toFixed(1)} color={p.profitFactor >= 1.2 ? '#22c55e' : '#ef4444'} />
                    <MiniStat label="Mult" value={`${p.scoreMultiplier.toFixed(1)}x`} />
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'learning' && (
          <div>
            <SectionHeader>LEARNING HISTORY</SectionHeader>
            {lastReport && (
              <div style={{
                padding: '8px', marginBottom: '8px', borderRadius: '4px',
                background: '#111', border: '1px solid #22c55e33',
              }}>
                <div style={{ fontSize: '9px', color: '#22c55e', fontWeight: 600, marginBottom: '4px' }}>
                  Latest Report
                </div>
                {lastReport.changes.slice(0, 5).map((c, i) => (
                  <div key={i} style={{ fontSize: '9px', color: '#ccc', marginBottom: '2px' }}>
                    {c.impact === 'positive' ? '✅' : c.impact === 'negative' ? '⚠️' : 'ℹ️'} {c.description}
                  </div>
                ))}
                <div style={{ fontSize: '8px', color: '#555', marginTop: '4px' }}>
                  Completed in {lastReport.durationMs}ms
                </div>
              </div>
            )}
            {learningHistory.length === 0 ? (
              <div style={{ fontSize: '10px', color: '#555', textAlign: 'center', padding: '20px 0' }}>
                No learning cycles yet. Click "Run Learning Cycle" when you have data.
              </div>
            ) : (
              learningHistory.slice(0, 10).map((snap, i) => (
                <div key={snap.id ?? i} style={{
                  padding: '6px 8px', marginBottom: '3px', borderRadius: '4px',
                  background: '#111', border: '1px solid #1f1f1f',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '9px', color: '#888' }}>
                      {new Date(snap.timestamp).toLocaleDateString()}
                    </span>
                    <span style={{ fontSize: '9px', color: '#555' }}>
                      {snap.totalTradesAnalyzed} trades
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '2px' }}>
                    <MiniStat label="Improved" value={snap.patternsImproved.toString()} color="#22c55e" />
                    <MiniStat label="Degraded" value={snap.patternsDegraded.toString()} color="#ef4444" />
                    <MiniStat label="Δ Exp" value={`${snap.overallExpectancyDelta >= 0 ? '+' : ''}${snap.overallExpectancyDelta.toFixed(2)}`}
                      color={snap.overallExpectancyDelta >= 0 ? '#22c55e' : '#ef4444'} />
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: '9px', fontWeight: 700, color: '#555',
      textTransform: 'uppercase', letterSpacing: '1px',
      marginBottom: '6px',
    }}>
      {children}
    </div>
  );
}

function MemoryCard({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <div style={{
      padding: '8px', borderRadius: '6px',
      background: '#111', border: '1px solid #1f1f1f',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: '14px', marginBottom: '2px' }}>{icon}</div>
      <div style={{
        fontSize: '16px', fontWeight: 800, color: '#f5f5f5',
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        fontFeatureSettings: "'tnum'",
      }}>
        {value}
      </div>
      <div style={{ fontSize: '8px', color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {label}
      </div>
    </div>
  );
}

function ActionButton({ onClick, label, sublabel, icon, disabled, accent }: {
  onClick: () => void; label: string; sublabel: string;
  icon: string; disabled?: boolean; accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 10px', borderRadius: '6px',
        background: accent ? 'rgba(139, 92, 246, 0.1)' : '#111',
        border: `1px solid ${accent ? '#8b5cf633' : '#1f1f1f'}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'all 0.2s',
        textAlign: 'left',
        width: '100%',
      }}
    >
      <span style={{ fontSize: '14px' }}>{icon}</span>
      <div>
        <div style={{ fontSize: '10px', fontWeight: 600, color: '#f5f5f5' }}>{label}</div>
        <div style={{ fontSize: '8px', color: '#555' }}>{sublabel}</div>
      </div>
    </button>
  );
}

function MiniStat({ label, value, color = '#888' }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{
        fontSize: '10px', fontWeight: 600, color,
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        fontFeatureSettings: "'tnum'",
      }}>
        {value}
      </div>
      <div style={{ fontSize: '7px', color: '#555' }}>{label}</div>
    </div>
  );
}
