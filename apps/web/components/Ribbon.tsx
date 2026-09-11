'use client';

import { useMemo } from 'react';
import { decisionSurface, toPaise } from '@kreaton/core';
import type { Policy } from '@kreaton/core';
import type { Decision } from '../lib/session';
import { riskColor, riskPosition } from '../lib/risk';
import { formatINRCompact, prob } from '../lib/format';
import { useSize } from '../lib/use-size';

/**
 * The interception ribbon.
 *
 * Every payment is a mark placed by its amount (across) and its calibrated
 * fraud probability (up). The two curves are the decision boundaries the
 * policy implies at every amount, computed in closed form from the same cost
 * model the engine decides with, so a mark above the lower curve was held and
 * a mark above the upper one was blocked, by construction rather than by
 * annotation. Move a policy slider and the curves move; the marks do not,
 * because those decisions were already taken and sealed.
 *
 * The vertical axis is log-odds. On a linear axis every legitimate payment
 * would sit in a line along the floor.
 */

const AMOUNT_LO = toPaise(10);
const AMOUNT_HI = toPaise(1_000_000);
const LOG_LO = Math.log(AMOUNT_LO);
const LOG_HI = Math.log(AMOUNT_HI);

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

const PAD = { top: 10, right: 14, bottom: 26, left: 46 };

interface Props {
  decisions: readonly Decision[];
  policy: Policy;
  recoveryAtReportLag: number;
  selectedTxnId: string | null;
  onSelect: (txnId: string) => void;
  /** How many of the most recent decisions to draw. */
  window?: number;
}

export function Ribbon({
  decisions,
  policy,
  recoveryAtReportLag,
  selectedTxnId,
  onSelect,
  window = 600,
}: Props) {
  const [ref, size] = useSize<HTMLDivElement>();
  const width = Math.max(size.width, 320);
  const height = 300;
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;

  const x = (amountPaise: number): number => {
    const v = Math.min(Math.max(Math.log(Math.max(amountPaise, 1)), LOG_LO), LOG_HI);
    return PAD.left + ((v - LOG_LO) / (LOG_HI - LOG_LO)) * innerW;
  };
  const y = (p: number): number => PAD.top + (1 - riskPosition(p)) * innerH;

  const surface = useMemo(
    () => decisionSurface(recoveryAtReportLag, policy, 80),
    [recoveryAtReportLag, policy],
  );

  const { holdPath, blockPath, holdArea, blockArea } = useMemo(() => {
    const pts1 = surface.map((s) => [x(s.amountPaise), y(s.approveToStepUp)] as const);
    const pts2 = surface.map((s) => [x(s.amountPaise), y(s.stepUpToBlock)] as const);
    const line = (pts: readonly (readonly [number, number])[]) =>
      pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
    const top = PAD.top;
    const area = (lower: readonly (readonly [number, number])[], upper: readonly (readonly [number, number])[]) =>
      `${line(lower)} ${[...upper].reverse().map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join(' ')} Z`;
    const ceiling = pts2.map(([px]) => [px, top] as const);
    return {
      holdPath: line(pts1),
      blockPath: line(pts2),
      holdArea: area(pts1, pts2),
      blockArea: area(pts2, ceiling),
    };
    // x and y are stable for a given size; surface captures policy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, width]);

  const recent = decisions.slice(-window);
  const n = recent.length;

  return (
    <div ref={ref} className="ribbon" style={{ width: '100%' }}>
      <svg width={width} height={height} role="img" aria-label="Interception ribbon">
        <defs>
          <clipPath id="ribbon-clip">
            <rect x={PAD.left} y={PAD.top} width={innerW} height={innerH} />
          </clipPath>
        </defs>

        {/* Regions */}
        <g clipPath="url(#ribbon-clip)">
          <path d={holdArea} fill="var(--stepup)" fillOpacity={0.06} />
          <path d={blockArea} fill="var(--block)" fillOpacity={0.07} />
        </g>

        {/* Grid */}
        {Y_TICKS.map(([p, label]) => (
          <g key={p}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(p)}
              y2={y(p)}
              stroke="var(--line)"
              strokeDasharray="2 4"
            />
            <text
              x={PAD.left - 8}
              y={y(p) + 3.5}
              textAnchor="end"
              fill="var(--fg-2)"
              fontSize={10}
              fontFamily="var(--font-mono)"
            >
              {label}
            </text>
          </g>
        ))}
        {X_TICKS.map(([amt, label]) => (
          <g key={amt}>
            <line
              x1={x(amt)}
              x2={x(amt)}
              y1={PAD.top}
              y2={height - PAD.bottom}
              stroke="var(--line)"
            />
            <text
              x={x(amt)}
              y={height - 8}
              textAnchor="middle"
              fill="var(--fg-2)"
              fontSize={10}
              fontFamily="var(--font-mono)"
            >
              {label}
            </text>
          </g>
        ))}

        {/* Boundaries */}
        <g clipPath="url(#ribbon-clip)">
          <path d={holdPath} fill="none" stroke="var(--stepup)" strokeWidth={1.25} />
          <path d={blockPath} fill="none" stroke="var(--block)" strokeWidth={1.25} />
        </g>
        <text
          x={width - PAD.right - 4}
          y={y(surface[surface.length - 1]!.approveToStepUp) + 15}
          textAnchor="end"
          fill="var(--stepup)"
          stroke="var(--bg-0)"
          strokeWidth={3.5}
          paintOrder="stroke"
          fontSize={10}
          fontFamily="var(--font-mono)"
        >
          held above
        </text>
        <text
          x={width - PAD.right - 4}
          y={y(surface[surface.length - 1]!.stepUpToBlock) - 9}
          textAnchor="end"
          fill="var(--block)"
          stroke="var(--bg-0)"
          strokeWidth={3.5}
          paintOrder="stroke"
          fontSize={10}
          fontFamily="var(--font-mono)"
        >
          blocked above
        </text>

        {/* Marks. Oldest first so the newest paint on top. */}
        <g clipPath="url(#ribbon-clip)">
          {recent.map((d, i) => {
            const a = d.result.assessment;
            const cx = x(d.txn.amountPaise);
            const cy = y(a.calibratedP);
            const age = n > 1 ? (n - 1 - i) / (n - 1) : 0;
            const opacity = 0.35 + 0.65 * (1 - age);
            const color = riskColor(a.calibratedP);
            const selected = d.txn.txnId === selectedTxnId;
            const title = `${formatINRCompact(d.txn.amountPaise)} · p=${prob(a.calibratedP)} · ${a.decision}${d.injected ? ' · injected' : ''}`;
            return (
              <g
                key={d.txn.txnId}
                opacity={selected ? 1 : opacity}
                onClick={() => onSelect(d.txn.txnId)}
                style={{ cursor: 'pointer' }}
              >
                <title>{title}</title>
                {a.decision === 'APPROVE' ? (
                  <line x1={cx} x2={cx} y1={cy - 4} y2={cy + 4} stroke={color} strokeWidth={1.5} />
                ) : a.decision === 'STEP_UP' ? (
                  <circle cx={cx} cy={cy} r={3.5} fill="none" stroke={color} strokeWidth={1.5} />
                ) : (
                  <path
                    d={`M${cx - 3.5},${cy - 3.5} L${cx + 3.5},${cy + 3.5} M${cx + 3.5},${cy - 3.5} L${cx - 3.5},${cy + 3.5}`}
                    stroke={color}
                    strokeWidth={1.75}
                  />
                )}
                {d.injected ? (
                  <circle cx={cx} cy={cy} r={7} fill="none" stroke={color} strokeWidth={0.75} strokeDasharray="2 2" />
                ) : null}
                {selected ? (
                  <>
                    <circle cx={cx} cy={cy} r={9} fill="none" stroke="var(--fg-0)" strokeWidth={1} />
                    <line x1={PAD.left} x2={width - PAD.right} y1={cy} y2={cy} stroke="var(--fg-0)" strokeOpacity={0.25} />
                    <line x1={cx} x2={cx} y1={PAD.top} y2={height - PAD.bottom} stroke="var(--fg-0)" strokeOpacity={0.25} />
                  </>
                ) : null}
              </g>
            );
          })}
        </g>

        <text
          x={PAD.left + 4}
          y={PAD.top + 11}
          fill="var(--fg-3)"
          fontSize={10}
          fontFamily="var(--font-mono)"
        >
          p(fraud) ↑ · amount →
        </text>
      </svg>
      <TimeStrip decisions={decisions} selectedTxnId={selectedTxnId} onSelect={onSelect} width={width} />
    </div>
  );
}

/**
 * The feed as a timeline: one slot per decision in arrival order, coloured by
 * risk, taller when the engine intervened. Reads as a seismograph of the
 * last few minutes of traffic.
 */
function TimeStrip({
  decisions,
  selectedTxnId,
  onSelect,
  width,
}: {
  decisions: readonly Decision[];
  selectedTxnId: string | null;
  onSelect: (txnId: string) => void;
  width: number;
}) {
  const slots = Math.max(60, Math.floor((width - PAD.left - PAD.right) / 4));
  const recent = decisions.slice(-slots);
  const h = 34;
  const w = width - PAD.left - PAD.right;
  const step = w / slots;
  return (
    <svg width={width} height={h} role="img" aria-label="Decision timeline">
      <line x1={PAD.left} x2={width - PAD.right} y1={h - 8} y2={h - 8} stroke="var(--line-strong)" />
      {recent.map((d, i) => {
        const a = d.result.assessment;
        const cx = PAD.left + w - (recent.length - i) * step + step / 2;
        const tall = a.decision === 'BLOCK' ? 22 : a.decision === 'STEP_UP' ? 15 : 6;
        const color = riskColor(a.calibratedP);
        const selected = d.txn.txnId === selectedTxnId;
        return (
          <g key={d.txn.txnId} onClick={() => onSelect(d.txn.txnId)} style={{ cursor: 'pointer' }}>
            <title>{`${a.decision} · ${prob(a.calibratedP)}`}</title>
            <line
              x1={cx}
              x2={cx}
              y1={h - 8 - tall}
              y2={h - 8}
              stroke={selected ? 'var(--fg-0)' : color}
              strokeWidth={selected ? 2.5 : Math.max(1, step - 1.5)}
            />
          </g>
        );
      })}
      <text x={PAD.left} y={h - 0} fill="var(--fg-3)" fontSize={9.5} fontFamily="var(--font-mono)" dy={-0.5}>
        {decisions.length > 0 ? `last ${recent.length} of ${decisions.length}` : 'no payments yet'}
      </text>
      <text x={width - PAD.right} y={h - 0} textAnchor="end" fill="var(--fg-3)" fontSize={9.5} fontFamily="var(--font-mono)" dy={-0.5}>
        now
      </text>
    </svg>
  );
}
