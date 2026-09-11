/**
 * Small numerical helpers. Deliberately dependency-free so the engine can run
 * unchanged in a browser, in a Node server route, and in a test runner.
 */

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function sigmoid(x: number): number {
  // Branch to avoid overflow of Math.exp for large positive x.
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

export function logit(p: number): number {
  const q = clamp(p, 1e-12, 1 - 1e-12);
  return Math.log(q / (1 - q));
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/** Linear-interpolated quantile of an unsorted array. */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loV = sorted[lo] ?? 0;
  const hiV = sorted[hi] ?? loV;
  return lo === hi ? loV : loV + (hiV - loV) * (pos - lo);
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

/**
 * Median absolute deviation, scaled by 1.4826 so that for normally distributed
 * data it estimates the standard deviation. Used instead of the standard
 * deviation throughout the payer baseline because MAD has a 50% breakdown
 * point: half the observations must be poisoned before the estimate moves.
 * A mean-and-sigma baseline can be shifted by a single large transaction,
 * which is precisely the false-baseline attack the adversarial suite runs.
 */
export function mad(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const m = median(xs);
  const devs = xs.map((x) => Math.abs(x - m));
  return 1.4826 * median(devs);
}

/** Abramowitz and Stegun 7.1.26 approximation, max absolute error 1.5e-7. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(x: number, mu = 0, sigma = 1): number {
  return 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));
}

/** P(X <= x) for X lognormal with the given log-space parameters. */
export function lognormalCdf(x: number, mu: number, sigma: number): number {
  if (x <= 0) return 0;
  return normalCdf(Math.log(x), mu, sigma);
}

/**
 * Wilson score interval for a binomial proportion. Used for adversarial
 * catch-rate reporting, where the naive normal interval is badly wrong at the
 * small counts and extreme proportions these experiments produce.
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  z = 1.96,
): { lo: number; hi: number; point: number } {
  if (trials === 0) return { lo: 0, hi: 1, point: 0 };
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return {
    lo: clamp((centre - spread) / denom, 0, 1),
    hi: clamp((centre + spread) / denom, 0, 1),
    point: p,
  };
}

// ---------------------------------------------------------------------------
// Small dense matrix operations, for the CTMC recoverability estimator
// ---------------------------------------------------------------------------

export type Matrix = number[][];

export function zeros(n: number, m: number = n): Matrix {
  return Array.from({ length: n }, () => new Array<number>(m).fill(0));
}

export function identity(n: number): Matrix {
  const out = zeros(n);
  for (let i = 0; i < n; i++) out[i]![i] = 1;
  return out;
}

export function matMul(a: Matrix, b: Matrix): Matrix {
  const n = a.length;
  const k = b.length;
  const m = b[0]?.length ?? 0;
  const out = zeros(n, m);
  for (let i = 0; i < n; i++) {
    const ai = a[i]!;
    const oi = out[i]!;
    for (let p = 0; p < k; p++) {
      const aip = ai[p]!;
      if (aip === 0) continue;
      const bp = b[p]!;
      for (let j = 0; j < m; j++) oi[j]! += aip * bp[j]!;
    }
  }
  return out;
}

export function matAdd(a: Matrix, b: Matrix): Matrix {
  return a.map((row, i) => row.map((v, j) => v + b[i]![j]!));
}

export function matScale(a: Matrix, s: number): Matrix {
  return a.map((row) => row.map((v) => v * s));
}

function maxAbs(a: Matrix): number {
  let m = 0;
  for (const row of a) for (const v of row) m = Math.max(m, Math.abs(v));
  return m;
}

/**
 * Matrix exponential by scaling and squaring with a truncated Taylor series.
 *
 * The generator matrices used here are tiny (at most 8x8), strictly upper
 * triangular plus a diagonal, and well conditioned, so a Taylor series applied
 * after scaling the norm below 0.5 converges to machine precision well within
 * the iteration cap. A full Pade implementation would add complexity without
 * changing any digit that reaches a report.
 */
export function expm(a: Matrix, terms = 24): Matrix {
  const n = a.length;
  const norm = maxAbs(a);
  if (norm === 0) return identity(n);

  // Scale so that the norm is below 1/2, then square back up.
  const squarings = Math.max(0, Math.ceil(Math.log2(norm / 0.5)));
  const scaled = matScale(a, 1 / 2 ** squarings);

  let result = identity(n);
  let term = identity(n);
  for (let k = 1; k <= terms; k++) {
    term = matScale(matMul(term, scaled), 1 / k);
    result = matAdd(result, term);
    if (maxAbs(term) < 1e-18) break;
  }
  for (let s = 0; s < squarings; s++) result = matMul(result, result);
  return result;
}

/**
 * Trapezoidal integration of a sampled curve. Used to reduce a recovery curve
 * to a single expected-recovery figure over a reporting window.
 */
export function trapezoid(xs: readonly number[], ys: readonly number[]): number {
  let area = 0;
  for (let i = 1; i < xs.length; i++) {
    const dx = xs[i]! - xs[i - 1]!;
    area += (dx * (ys[i]! + ys[i - 1]!)) / 2;
  }
  return area;
}

/**
 * Evaluate a piecewise-linear map defined by sorted knots, clamping outside
 * the knot range. This is how the fitted isotonic calibration is applied.
 */
export function interpolatePiecewise(
  knots: ReadonlyArray<{ x: number; y: number }>,
  x: number,
): number {
  if (knots.length === 0) return 0;
  const first = knots[0]!;
  const last = knots[knots.length - 1]!;
  if (x <= first.x) return first.y;
  if (x >= last.x) return last.y;
  let lo = 0;
  let hi = knots.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (knots[mid]!.x <= x) lo = mid;
    else hi = mid;
  }
  const a = knots[lo]!;
  const b = knots[hi]!;
  const span = b.x - a.x;
  if (span === 0) return b.y;
  return a.y + ((x - a.x) / span) * (b.y - a.y);
}
