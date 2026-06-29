'use client';

import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Brush,
} from 'recharts';
import type { EquityPoint, SimTrade } from '@/lib/simulator';

type Props = {
  equityCurve: EquityPoint[];
  trades: SimTrade[];
  startingCapital: number;
};

function fmtDate(t: number) {
  return new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtUsd(n: number) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const point: EquityPoint = payload[0].payload;
  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-lg p-2.5 text-[11px]">
      <div className="text-[#888888] mb-1">{fmtDate(point.time)}</div>
      <div className="text-[#f5f5f5] font-mono">{fmtUsd(point.value)}</div>
      <div className="text-[#ef4444] font-mono">-{point.drawdown.toFixed(2)}% drawdown</div>
    </div>
  );
}

export default function SimulatorChart({ equityCurve, trades, startingCapital }: Props) {
  const tradeById = new Map(trades.map(t => [t.id, t]));
  const final = equityCurve[equityCurve.length - 1]?.value ?? startingCapital;
  const positive = final >= startingCapital;
  const lineColor = positive ? '#22c55e' : '#ef4444';

  const data = equityCurve.map(p => ({ ...p, dateLabel: fmtDate(p.time) }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderDot = (props: any) => {
    const point: EquityPoint = props.payload;
    const trade = point.tradeId ? tradeById.get(point.tradeId) : null;
    if (!trade) return <circle key={`dot-${point.time}`} r={0} />;
    const win = trade.rMultiple > 0.1;
    return (
      <circle
        key={`dot-${point.time}`}
        cx={props.cx} cy={props.cy} r={3}
        fill={win ? '#22c55e' : '#ef4444'}
        stroke="#0a0a0a" strokeWidth={1}
      />
    );
  };

  return (
    <div style={{ width: '100%', height: 320 }}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 10, right: 30, left: 10, bottom: 0 }}>
          <defs>
            <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={lineColor} stopOpacity={0.15} />
              <stop offset="95%" stopColor={lineColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#1a1a1a" vertical={false} />
          <XAxis dataKey="dateLabel" stroke="#555" tick={{ fontSize: 10, fill: '#888' }} minTickGap={40} />
          <YAxis
            yAxisId="capital"
            stroke="#555" tick={{ fontSize: 10, fill: '#888' }}
            domain={['auto', 'auto']}
            tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
          />
          <YAxis
            yAxisId="drawdown" orientation="right"
            stroke="#ef4444" tick={{ fontSize: 10, fill: '#ef4444' }}
            tickFormatter={(v: number) => `${v.toFixed(0)}%`}
          />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine yAxisId="capital" y={startingCapital} stroke="#444" strokeDasharray="4 4" label={{ value: `Start $${(startingCapital / 1000).toFixed(0)}k`, fill: '#666', fontSize: 10, position: 'insideTopLeft' }} />
          <Area
            yAxisId="capital" type="monotone" dataKey="value"
            stroke={lineColor} strokeWidth={1.5} fill="url(#equityFill)"
            dot={renderDot} activeDot={{ r: 4 }}
          />
          <Line
            yAxisId="drawdown" type="monotone" dataKey="drawdown"
            stroke="#ef4444" strokeWidth={1} strokeDasharray="3 3" dot={false}
          />
          <Brush dataKey="dateLabel" height={20} stroke="#333" fill="#111111" travellerWidth={8} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
