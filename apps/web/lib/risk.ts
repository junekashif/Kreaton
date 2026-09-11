/**
 * The risk ramp.
 *
 * One colour scale for one quantity: the calibrated fraud probability. It is
 * luminance-monotonic, so it reads correctly in greyscale and to viewers with
 * any common colour vision deficiency, and it is interpolated in OKLCH so the
 * perceived steps are even. The stops are mirrored as CSS custom properties in
 * globals.css; change both together.
 *
 * The light end stops at L 0.44 rather than lower: below that the quietest
 * marks fall under a 2:1 contrast ratio against the ground and disappear.
 *
 * Probabilities are positioned on a log-odds axis rather than a linear one,
 * because almost every payment sits below one percent and a linear ramp would
 * paint the whole feed the same indigo.
 */

interface Stop {
  t: number;
  l: number;
  c: number;
  h: number;
}

/* Hues are unwrapped so interpolation runs 290 -> 455 without crossing back. */
const STOPS: readonly Stop[] = [
  { t: 0, l: 0.44, c: 0.12, h: 290 },
  { t: 0.25, l: 0.52, c: 0.2, h: 310 },
  { t: 0.5, l: 0.6, c: 0.24, h: 350 },
  { t: 0.75, l: 0.76, c: 0.17, h: 420 },
  { t: 1, l: 0.93, c: 0.16, h: 455 },
];

export const LOGIT_MIN = -9;
export const LOGIT_MAX = 4;

export function logit(p: number): number {
  const q = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
  return Math.log(q / (1 - q));
}

/** Map a probability to [0, 1] along the display axis. */
export function riskPosition(p: number): number {
  const z = logit(p);
  return Math.min(1, Math.max(0, (z - LOGIT_MIN) / (LOGIT_MAX - LOGIT_MIN)));
}

/** Inverse of riskPosition, for axis ticks. */
export function positionToProbability(t: number): number {
  const z = LOGIT_MIN + t * (LOGIT_MAX - LOGIT_MIN);
  return 1 / (1 + Math.exp(-z));
}

function rampAt(t: number): string {
  const x = Math.min(1, Math.max(0, t));
  let i = 0;
  while (i < STOPS.length - 2 && x > STOPS[i + 1]!.t) i++;
  const a = STOPS[i]!;
  const b = STOPS[i + 1]!;
  const f = (x - a.t) / (b.t - a.t);
  const l = a.l + (b.l - a.l) * f;
  const c = a.c + (b.c - a.c) * f;
  const h = (a.h + (b.h - a.h) * f) % 360;
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;
}

/** Colour for a calibrated probability. */
export function riskColor(p: number): string {
  return rampAt(riskPosition(p));
}

/** Colour at a position on the display axis. */
export function riskColorAt(t: number): string {
  return rampAt(t);
}

export const ACTION_GLYPH = {
  APPROVE: 'approve',
  STEP_UP: 'hold',
  BLOCK: 'block',
} as const;
