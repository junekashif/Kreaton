'use client';

import type { RecoveryEstimate } from '@kreaton/core';
import { pct } from '../lib/format';
import { useSize } from '../lib/use-size';

/**
 * Recoverable fraction against minutes since the funds landed. Time is on a
 * square-root axis: the first hour is where interception lives and a linear
 * axis would compress it into a sliver.
 */
export function RecoveryCurve({
  estimate,
  height = 150,
  markers = [],
  compact = false,
}: {
  estimate: RecoveryEstimate;
  height?: number;
  /** Extra vertical markers, e.g. the report lag or a freeze order time. */
  markers?: Array<{ minutes: number; label: string }>;
  compact?: boolean;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const width = Math.max(size.width, 240);
  const pad = { top: 8, right: 10, bottom: compact ? 16 : 22, left: compact ? 34 : 40 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const maxMin = estimate.curve[estimate.curve.length - 1]?.minutes ?? 1440;
  const sx = (m: number) => pad.left + (Math.sqrt(m) / Math.sqrt(maxMin)) * innerW;
  const sy = (r: number) => pad.top + (1 - r) * innerH;

  const path = estimate.curve
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.minutes).toFixed(1)},${sy(p.recoverable).toFixed(1)}`)
    .join(' ');
  const area = `${path} L${sx(maxMin).toFixed(1)},${sy(0).toFixed(1)} L${sx(0).toFixed(1)},${sy(0).toFixed(1)} Z`;

  const xTicks = compact ? [0, 15, 60, 240, 1440] : [0, 30, 60, 120, 240, 480, 1440];
  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const all = [...markers, { minutes: estimate.horizonMinutes, label: 'report lag' }];

  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={width} height={height} role="img" aria-label="Recoverability curve">
        {yTicks.map((r) => (
          <g key={r}>
            <line x1={pad.left} x2={width - pad.right} y1={sy(r)} y2={sy(r)} stroke="var(--line)" />
            <text x={pad.left - 6} y={sy(r) + 3.5} textAnchor="end" fill="var(--fg-2)" fontSize={10} fontFamily="var(--font-mono)">
              {Math.round(r * 100)}%
            </text>
          </g>
        ))}
        {xTicks.map((m) => (
          <text key={m} x={sx(m)} y={height - 6} textAnchor="middle" fill="var(--fg-2)" fontSize={10} fontFamily="var(--font-mono)">
            {m >= 60 ? `${m / 60}h` : `${m}m`}
          </text>
        ))}
        <path d={area} fill="var(--risk-0)" fillOpacity={0.25} />
        <path d={path} fill="none" stroke="var(--fg-0)" strokeWidth={1.5} />
        {[...all]
          .sort((a, b) => a.minutes - b.minutes)
          .map((mk, i) => (
            <g key={mk.label}>
              <line x1={sx(mk.minutes)} x2={sx(mk.minutes)} y1={pad.top} y2={height - pad.bottom} stroke="var(--fg-1)" strokeDasharray="3 3" />
              <text x={sx(mk.minutes) + 4} y={pad.top + 10 + (i % 2) * 12} fill="var(--fg-1)" fontSize={10} fontFamily="var(--font-mono)">
                {mk.label}
              </text>
            </g>
          ))}
        <circle cx={sx(estimate.horizonMinutes)} cy={sy(estimate.fractionAtHorizon)} r={3.5} fill="var(--fg-0)" />
        <text
          x={sx(estimate.horizonMinutes) + 7}
          y={sy(estimate.fractionAtHorizon) + 4}
          fill="var(--fg-0)"
          fontSize={11}
          fontFamily="var(--font-mono)"
        >
          {pct(estimate.fractionAtHorizon, 1)}
        </text>
      </svg>
    </div>
  );
}
