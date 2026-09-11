'use client';

import type { FrontierPoint } from '@kreaton/core';
import { pct } from '../lib/format';
import { useSize } from '../lib/use-size';

/**
 * The achievable trade-off: detection rate against false-positive rate as the
 * price of friction is swept. The unmodified candidate is marked; other named
 * points can be overlaid for comparison.
 */
export function FrontierChart({
  frontier,
  marks = [],
  height = 220,
}: {
  frontier: FrontierPoint[];
  marks?: Array<{ label: string; falsePositiveRate: number; detectionRate: number; emphasis?: boolean }>;
  height?: number;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const width = Math.max(size.width, 280);
  const pad = { top: 10, right: 12, bottom: 24, left: 40 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  // Square-root FPR axis: the interesting region is below five percent.
  const maxFpr = Math.max(0.1, ...frontier.map((f) => f.falsePositiveRate));
  const x = (f: number) => pad.left + (Math.sqrt(f) / Math.sqrt(maxFpr)) * innerW;
  const y = (d: number) => pad.top + (1 - d) * innerH;
  const sorted = [...frontier].sort((a, b) => a.falsePositiveRate - b.falsePositiveRate);
  const path = sorted.map((f, i) => `${i === 0 ? 'M' : 'L'}${x(f.falsePositiveRate).toFixed(1)},${y(f.detectionRate).toFixed(1)}`).join(' ');
  const xTicks = [0.001, 0.005, 0.01, 0.02, 0.05, 0.1].filter((t) => t <= maxFpr);
  const yTicks = [0, 0.25, 0.5, 0.75, 1];

  // Labels are nudged apart vertically so nearby presets stay legible.
  const placed = [...marks]
    .map((m) => ({ ...m, lx: x(m.falsePositiveRate) + 8, ly: y(m.detectionRate) + 4 }))
    .sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < placed.length; i++) {
    const prev = placed[i - 1]!;
    const cur = placed[i]!;
    if (Math.abs(cur.lx - prev.lx) < 90 && cur.ly - prev.ly < 12) cur.ly = prev.ly + 12;
  }

  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={width} height={height} role="img" aria-label="Trade-off frontier">
        {yTicks.map((d) => (
          <g key={d}>
            <line x1={pad.left} x2={width - pad.right} y1={y(d)} y2={y(d)} stroke="var(--line)" />
            <text x={pad.left - 6} y={y(d) + 3.5} textAnchor="end" fill="var(--fg-2)" fontSize={10} fontFamily="var(--font-mono)">
              {Math.round(d * 100)}%
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={pad.top} y2={height - pad.bottom} stroke="var(--line)" strokeDasharray="2 4" />
            <text x={x(t)} y={height - 7} textAnchor="middle" fill="var(--fg-2)" fontSize={10} fontFamily="var(--font-mono)">
              {pct(t, t < 0.01 ? 1 : 0)}
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke="var(--fg-1)" strokeWidth={1.5} />
        {sorted.map((f) => (
          <circle key={f.frictionMultiplier} cx={x(f.falsePositiveRate)} cy={y(f.detectionRate)} r={2} fill="var(--fg-1)">
            <title>{`friction ×${f.frictionMultiplier}: FPR ${pct(f.falsePositiveRate, 2)}, detection ${pct(f.detectionRate, 1)}`}</title>
          </circle>
        ))}
        {placed.map((m) => (
          <g key={m.label}>
            <circle cx={x(m.falsePositiveRate)} cy={y(m.detectionRate)} r={m.emphasis ? 5 : 3.5} fill={m.emphasis ? 'var(--fg-0)' : 'var(--bg-0)'} stroke="var(--fg-0)" strokeWidth={1.25} />
            <text x={m.lx} y={m.ly} fill={m.emphasis ? 'var(--fg-0)' : 'var(--fg-2)'} fontSize={10} fontFamily="var(--font-mono)" style={{ paintOrder: 'stroke', stroke: 'var(--bg-0)', strokeWidth: 3 }}>
              {m.label}
            </text>
          </g>
        ))}
        <text x={width - pad.right} y={pad.top + 10} textAnchor="end" fill="var(--fg-3)" fontSize={10} fontFamily="var(--font-mono)">
          detection ↑ · false-positive rate →
        </text>
      </svg>
    </div>
  );
}
