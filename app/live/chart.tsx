'use client';

import { useMemo } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CandleData {
  t: number; // epoch ms
  o: number; h: number; l: number; c: number; v: number;
}

export interface TradeLevels {
  entry: number;
  stop_loss: number;
  tp1: number;
  tp2: number;
  tp1_hit: boolean;
  direction: string;
}

interface Props {
  candles: CandleData[];
  trade?: TradeLevels | null;
  livePrice?: number;
  symbol: string;
}

// ─── Layout constants ────────────────────────────────────────────────────────

const W = 900;
const PRICE_H = 230;
const VOL_H = 50;
const GAP = 10;
const TOTAL_H = PRICE_H + GAP + VOL_H;
const PAD_L = 58; // price label column
const PAD_R = 6;
const PAD_T = 10;
const PAD_B = 20; // bottom of price area — for time labels
const CHART_W = W - PAD_L - PAD_R;
const CHART_H = PRICE_H - PAD_T - PAD_B;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtLabel(p: number): string {
  if (p >= 10000) return p.toFixed(0);
  if (p >= 1000) return p.toFixed(1);
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(3);
  return p.toFixed(5);
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CandleChart({ candles, trade, livePrice, symbol }: Props) {
  const visible = useMemo(() => candles.slice(-80), [candles]);

  const layout = useMemo(() => {
    if (!visible.length) return null;
    const n = visible.length;
    const candleW = CHART_W / n;
    const bodyW = Math.max(candleW - Math.max(candleW * 0.2, 1), 1);

    // Price range — include trade levels and live price
    let minP = Math.min(...visible.map(c => c.l));
    let maxP = Math.max(...visible.map(c => c.h));
    if (trade) {
      minP = Math.min(minP, trade.entry, trade.stop_loss);
      maxP = Math.max(maxP, trade.tp1, trade.tp2);
    }
    if (livePrice) { minP = Math.min(minP, livePrice); maxP = Math.max(maxP, livePrice); }
    const pad = (maxP - minP) * 0.06 || maxP * 0.01;
    minP -= pad; maxP += pad;
    const pRange = maxP - minP || 1;

    // Volume range
    const maxV = Math.max(...visible.map(c => c.v), 1);

    // Price label positions (5 levels)
    const priceLabels = Array.from({ length: 6 }, (_, i) => {
      const price = minP + (pRange * i) / 5;
      const y = PAD_T + CHART_H * (1 - (price - minP) / pRange);
      return { price, y };
    });

    // Time labels at first / mid / last candle
    const timeIdxs = [0, Math.floor(n / 2), n - 1];
    const timeLabels = timeIdxs.map(i => ({
      x: PAD_L + (i + 0.5) * candleW,
      label: fmtTime(visible[i].t),
    }));

    return { n, candleW, bodyW, minP, pRange, maxV, priceLabels, timeLabels };
  }, [visible, trade, livePrice]);

  if (!layout) {
    return (
      <div className="flex items-center justify-center text-gray-700 text-xs" style={{ height: TOTAL_H }}>
        Loading chart…
      </div>
    );
  }

  const { n, candleW, bodyW, minP, pRange, maxV, priceLabels, timeLabels } = layout;

  const toX = (i: number) => PAD_L + (i + 0.5) * candleW;
  const toY = (p: number) => PAD_T + CHART_H * (1 - (p - minP) / pRange);
  const toVolH = (v: number) => (VOL_H - 4) * (v / maxV);

  const tradeLevels = trade
    ? [
        { price: trade.entry, color: '#60a5fa', label: `Entry  ${fmtLabel(trade.entry)}`, dash: '' },
        { price: trade.stop_loss, color: '#f87171', label: `SL  ${fmtLabel(trade.stop_loss)}`, dash: '4 2' },
        { price: trade.tp1, color: '#a5b4fc', label: `TP1  ${fmtLabel(trade.tp1)}`, dash: '4 2' },
        { price: trade.tp2, color: '#34d399', label: `TP2  ${fmtLabel(trade.tp2)}`, dash: '4 2' },
      ]
    : [];

  return (
    <svg
      viewBox={`0 0 ${W} ${TOTAL_H}`}
      className="w-full"
      style={{ height: TOTAL_H, display: 'block' }}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* ── Grid lines ── */}
      {priceLabels.map((l, i) => (
        <line key={i}
          x1={PAD_L} y1={l.y} x2={W - PAD_R} y2={l.y}
          stroke="#1f2937" strokeWidth="1"
        />
      ))}

      {/* ── Price labels ── */}
      {priceLabels.map((l, i) => (
        <text key={i}
          x={PAD_L - 4} y={l.y + 3}
          fontSize="9" fill="#4b5563" textAnchor="end" fontFamily="monospace"
        >
          {fmtLabel(l.price)}
        </text>
      ))}

      {/* ── Time labels ── */}
      {timeLabels.map((l, i) => (
        <text key={i}
          x={l.x} y={PRICE_H - 4}
          fontSize="8" fill="#374151" textAnchor="middle" fontFamily="monospace"
        >
          {l.label}
        </text>
      ))}

      {/* ── Candles ── */}
      {visible.map((c, i) => {
        const cx = toX(i);
        const x = PAD_L + i * candleW;
        const isGreen = c.c >= c.o;
        const fill = isGreen ? '#16a34a' : '#dc2626';
        const stroke = isGreen ? '#22c55e' : '#ef4444';
        const bodyTop = toY(Math.max(c.o, c.c));
        const bodyBot = toY(Math.min(c.o, c.c));
        const bodyH = Math.max(bodyBot - bodyTop, 1);

        return (
          <g key={i}>
            {/* Wick */}
            <line
              x1={cx} y1={toY(c.h)}
              x2={cx} y2={toY(c.l)}
              stroke={stroke} strokeWidth="0.8"
            />
            {/* Body */}
            <rect
              x={x + (candleW - bodyW) / 2}
              y={bodyTop}
              width={bodyW}
              height={bodyH}
              fill={fill}
              stroke={stroke}
              strokeWidth="0.3"
            />
          </g>
        );
      })}

      {/* ── Trade level lines ── */}
      {tradeLevels.map((l, i) => {
        const y = toY(l.price);
        if (y < PAD_T || y > PRICE_H - PAD_B) return null;
        const labelW = l.label.length * 5.2 + 8;
        return (
          <g key={i}>
            <line
              x1={PAD_L} y1={y} x2={W - PAD_R} y2={y}
              stroke={l.color} strokeWidth="1"
              strokeDasharray={l.dash || undefined}
              opacity="0.85"
            />
            <rect x={PAD_L + 4} y={y - 9} width={labelW} height={11}
              fill="#0f172a" opacity="0.85" rx="2"
            />
            <text x={PAD_L + 8} y={y} fontSize="8" fill={l.color} fontFamily="monospace">
              {l.label}
            </text>
          </g>
        );
      })}

      {/* ── Live price line ── */}
      {livePrice && (() => {
        const y = toY(livePrice);
        if (y < PAD_T || y > PRICE_H - PAD_B) return null;
        const label = `▶ ${fmtLabel(livePrice)}`;
        const labelW = label.length * 5.5 + 8;
        return (
          <g>
            <line
              x1={PAD_L} y1={y} x2={W - PAD_R} y2={y}
              stroke="#fbbf24" strokeWidth="1"
              strokeDasharray="3 2" opacity="0.8"
            />
            <rect x={W - PAD_R - labelW - 2} y={y - 9} width={labelW} height={11}
              fill="#451a03" rx="2"
            />
            <text x={W - PAD_R - labelW + 2} y={y} fontSize="8" fill="#fbbf24" fontFamily="monospace">
              {label}
            </text>
          </g>
        );
      })()}

      {/* ── Separator ── */}
      <line
        x1={PAD_L} y1={PRICE_H + 2}
        x2={W - PAD_R} y2={PRICE_H + 2}
        stroke="#1f2937" strokeWidth="1"
      />

      {/* ── Volume bars ── */}
      {visible.map((c, i) => {
        const x = PAD_L + i * candleW;
        const isGreen = c.c >= c.o;
        const vh = toVolH(c.v);
        const volY = PRICE_H + GAP + (VOL_H - 4 - vh);
        return (
          <rect key={i}
            x={x + (candleW - bodyW) / 2}
            y={volY}
            width={bodyW}
            height={vh}
            fill={isGreen ? '#14532d' : '#7f1d1d'}
            opacity="0.8"
          />
        );
      })}

      {/* ── Left border ── */}
      <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PRICE_H + GAP + VOL_H}
        stroke="#1f2937" strokeWidth="1"
      />
    </svg>
  );
}
