'use client';

import { decisionSurface, toPaise } from '@kreaton/core';
import type { Policy } from '@kreaton/core';
import { riskPosition } from '../lib/risk';
import { useSize } from '../lib/use-size';

/**
 * Decision boundaries against amount, for a candidate policy and the one in
 * force. Same axes as the ribbon, so a reader can carry the picture across.
 */
const LOG_LO = Math.log(toPaise(10));
const LOG_HI = Math.log(toPaise(1_000_000));
const X_TICKS: Array<[number, string]> = [
  [toPaise(10), '₹10'],
  [toPaise(100), '₹100'],
  [toPaise(1_000), '₹1K'],
  [toPaise(10_000), '₹10K'],
  [toPaise(100_000), '₹1L'],
  [toPaise(1_000_000), '₹10L'],
];
const Y_TICKS: Array<[number, string]> = [
  [0.0001, '0.01%'],
  [0.001, '0.1%'],
  [0.01, '1%'],
  [0.1, '10%'],
  [0.5, '50%'],
  [0.9, '90%'],
];
const PAD = { top: 10, right: 12, bottom: 24, left: 46 };

export function SurfaceChart({
  candidate,
  current,
  recoveryCandidate,
  recoveryCurrent,
  height = 240,
}: {
  candidate: Policy;
  current: Policy | null;
  recoveryCandidate: number;
  recoveryCurrent: number;
  height?: number;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const width = Math.max(size.width, 280);
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const x = (amt: number) => PAD.left + ((Math.log(Math.max(amt, 1)) - LOG_LO) / (LOG_HI - LOG_LO)) * innerW;
  const y = (p: number) => PAD.top + (1 - riskPosition(p)) * innerH;
  const line = (pts: Array<[number, number]>) =>
    pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');

  const cand = decisionSurface(recoveryCandidate, candidate, 80);
  const curr = current ? decisionSurface(recoveryCurrent, current, 80) : null;

  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={width} height={height} role="img" aria-label="Decision surface">
        {Y_TICKS.map(([p, label]) => (
          <g key={p}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(p)} y2={y(p)} stroke="var(--line)" strokeDasharray="2 4" />
            <text x={PAD.left - 8} y={y(p) + 3.5} textAnchor="end" fill="var(--fg-2)" fontSize={10} fontFamily="var(--font-mono)">
              {label}
            </text>
          </g>
        ))}
        {X_TICKS.map(([amt, label]) => (
          <g key={amt}>
            <line x1={x(amt)} x2={x(amt)} y1={PAD.top} y2={height - PAD.bottom} stroke="var(--line)" />
            <text x={x(amt)} y={height - 7} textAnchor="middle" fill="var(--fg-2)" fontSize={10} fontFamily="var(--font-mono)">
              {label}
            </text>
          </g>
        ))}
        {curr ? (
          <>
            <path d={line(curr.map((s) => [x(s.amountPaise), y(s.approveToStepUp)]))} fill="none" stroke="var(--stepup)" strokeOpacity={0.45} strokeDasharray="4 3" />
            <path d={line(curr.map((s) => [x(s.amountPaise), y(s.stepUpToBlock)]))} fill="none" stroke="var(--block)" strokeOpacity={0.45} strokeDasharray="4 3" />
          </>
        ) : null}
        <path d={line(cand.map((s) => [x(s.amountPaise), y(s.approveToStepUp)]))} fill="none" stroke="var(--stepup)" strokeWidth={1.5} />
        <path d={line(cand.map((s) => [x(s.amountPaise), y(s.stepUpToBlock)]))} fill="none" stroke="var(--block)" strokeWidth={1.5} />
        <text x={width - PAD.right} y={PAD.top + 10} textAnchor="end" fill="var(--fg-2)" fontSize={10} fontFamily="var(--font-mono)">
          solid: candidate · dashed: in force
        </text>
      </svg>
    </div>
  );
}
