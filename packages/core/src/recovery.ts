import { expm, quantile, zeros } from './mathx.js';
import { Rng } from './rng.js';
import type { Matrix } from './mathx.js';
import type { Paise, RecoveryEstimate, RecoveryParams } from './types.js';

/**
 * Time-decay mule chain recoverability.
 *
 * Once a push payment settles, the money sits in a beneficiary account that can
 * still be frozen. Two separate things destroy recoverability, and conflating
 * them produces a model that is badly wrong at exactly the horizons where
 * interception decisions are made:
 *
 *   1. Cash-out. The moment funds leave the traceable banking layer, through an
 *      ATM withdrawal, a crypto over-the-counter trade, gift cards or a
 *      cross-border hop, they stop being freezable at all.
 *
 *   2. Depth. Funds that are still inside the chain are only recoverable to the
 *      extent an investigator can actually reach them inside the freeze window.
 *      Every hop adds another institution, another legal request and another
 *      fan-out of accounts to chase. Money resting in the fifth mule account is
 *      nominally frozen-able and practically often not.
 *
 * So the recoverable fraction is the survival probability weighted by how
 * reachable each depth is:
 *
 *   R(t) = sum_k  P(funds are in layer k at time t)  x  traceability_k
 *
 * An earlier version of this model omitted the traceability term and reported
 * roughly 58 per cent of value still recoverable one hour after landing, which
 * is implausible against published recovery outcomes. The term is what
 * reconciles the model with the observation that recovery rates are low even
 * though chains take hours to fully cash out.
 *
 * Two estimators are provided deliberately, and docs/MODELING.md reports the
 * gap between them rather than presenting either as truth:
 *
 *   - A continuous-time Markov chain with exponential dwell times, solved in
 *     closed form through the matrix exponential. Exact and checkable by hand.
 *     Its weakness is that exponential dwell is memoryless, which understates
 *     the mass of funds that move almost immediately.
 *
 *   - A Monte Carlo simulation with lognormal dwell times, which matches the
 *     observed right-skewed shape far better: most mule accounts forward funds
 *     within minutes, a minority sit for hours. Its weakness is sampling noise,
 *     which is reported as an interval rather than hidden.
 *
 * Where they disagree, the lognormal figure drives decisions, because the shape
 * assumption matters most at the short horizons where interception lives.
 */

/** Minutes at which the published recovery curve is sampled. */
export const CURVE_SAMPLE_MINUTES: readonly number[] = [
  0, 1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1080, 1440,
] as const;

/** Horizon of the precomputed survival grid, in minutes. Two days. */
const GRID_MAX_MINUTES = 2880;

/**
 * Default recoverability parameters.
 *
 * Every figure is a documented estimate. docs/MODELING.md states the reasoning
 * and the published sources behind each one, together with a sensitivity
 * analysis showing which of them the final decision actually depends on. They
 * are not measured from proprietary transaction data and nothing here claims
 * otherwise.
 */
export const DEFAULT_RECOVERY_PARAMS: RecoveryParams = {
  // Median dwell per layer, in minutes. The first mule account is fastest: it
  // exists to be emptied, UPI settles instantly, and the operator moves funds on
  // almost immediately. Later layers slow as the operator batches and rests.
  layerDwellMinutes: [8, 22, 47, 95, 180, 360],
  // Probability funds hop onward rather than cash out, by layer. Falls with
  // depth because each extra layer costs another rented account and another cut.
  // The final layer is forced to zero so every chain terminates.
  hopProbability: [0.82, 0.71, 0.58, 0.44, 0.3, 0],
  // Probability a freeze order actually reaches funds resting at each depth
  // inside the operational window. Falls steeply: layer one is a single
  // identified account at a known bank, layer five is a fan-out across several
  // institutions that must each be traced and served in sequence.
  traceabilityByLayer: [0.95, 0.74, 0.5, 0.3, 0.16, 0.08],
  // Lognormal shape. 0.9 produces the heavy right tail seen in reported cases,
  // where a minority of chains stall for hours while the median moves in minutes.
  dwellSigma: 0.9,
  // Mean onward branches per hop. Does not change the survival function, but
  // drives how many separate freeze orders an investigator must issue.
  meanFanOut: 2.4,
  maxLayers: 6,
};

// ---------------------------------------------------------------------------
// Closed form: continuous-time Markov chain
// ---------------------------------------------------------------------------

/**
 * Build the CTMC generator.
 *
 * States 0..K-1 are mule layers; state K is the absorbing cashed-out state.
 * Leaving layer k happens at rate 1/dwell_k, split between hopping onward and
 * cashing out according to that layer hop probability.
 */
export function buildGenerator(params: RecoveryParams): Matrix {
  const k = Math.min(params.maxLayers, params.layerDwellMinutes.length);
  const n = k + 1;
  const q = zeros(n);

  for (let i = 0; i < k; i++) {
    const dwell = Math.max(params.layerDwellMinutes[i] ?? 60, 1e-6);
    const rate = 1 / dwell;
    const isLast = i === k - 1;
    const hop = isLast ? 0 : (params.hopProbability[i] ?? 0);

    if (!isLast) q[i]![i + 1] = rate * hop;
    q[i]![k] = rate * (1 - hop);
    q[i]![i] = -rate;
  }
  // State k is absorbing: its row stays all zeros.
  return q;
}

/**
 * Closed-form recoverable fraction at t minutes after the funds land,
 * weighting each layer occupancy by how reachable that depth is.
 */
export function recoverableCtmc(params: RecoveryParams, minutes: number): number {
  const k = Math.min(params.maxLayers, params.layerDwellMinutes.length);
  if (minutes <= 0) return params.traceabilityByLayer[0] ?? 1;

  const q = buildGenerator(params);
  const p = expm(
    q.map((row) => row.map((v) => v * minutes)),
    32,
  );
  let recoverable = 0;
  for (let layer = 0; layer < k; layer++) {
    recoverable += (p[0]?.[layer] ?? 0) * (params.traceabilityByLayer[layer] ?? 0);
  }
  return Math.max(0, Math.min(1, recoverable));
}

// ---------------------------------------------------------------------------
// Monte Carlo: lognormal dwell
// ---------------------------------------------------------------------------

export interface MonteCarloResult {
  /** Sampled cash-out times in minutes, sorted ascending. */
  cashOutTimes: number[];
  /**
   * Traceability-weighted survival, precomputed per minute from 0 to
   * GRID_MAX_MINUTES. Precomputed because the decision engine queries this for
   * every authorisation, and re-simulating per transaction would put the
   * interception path into the hundreds of milliseconds.
   */
  grid: Float64Array;
  expectedHops: number;
  /** Mean number of distinct accounts touched, which is the freeze-order count. */
  expectedAccounts: number;
}

/**
 * Simulate fund movement through the chain.
 *
 * Dwell in each layer is lognormal with the layer median as its location, so
 * the median path matches the configured figure while the tail is heavier than
 * exponential. Seeded, so every published curve is reproducible.
 */
export function simulateChains(
  params: RecoveryParams,
  paths = 20_000,
  seed: number | string = 'recovery',
): MonteCarloResult {
  const rng = new Rng(seed);
  const k = Math.min(params.maxLayers, params.layerDwellMinutes.length);
  const cashOutTimes = new Array<number>(paths);
  let hopTotal = 0;
  let accountTotal = 0;

  // Difference array over minutes: each layer occupancy adds its traceability
  // weight for the span the funds rest there. One prefix sum at the end turns
  // this into the weighted survival curve.
  const diff = new Float64Array(GRID_MAX_MINUTES + 2);

  for (let p = 0; p < paths; p++) {
    let t = 0;
    let layer = 0;
    let accounts = 1;

    for (;;) {
      const median = Math.max(params.layerDwellMinutes[layer] ?? 60, 1e-6);
      const dwell = rng.lognormal(Math.log(median), params.dwellSigma);
      const enteredAt = t;
      t += dwell;

      // Funds rest in this layer over [enteredAt, t). Credit that span with the
      // layer traceability weight.
      const weight = params.traceabilityByLayer[layer] ?? 0;
      if (weight > 0 && enteredAt <= GRID_MAX_MINUTES) {
        const a = Math.max(0, Math.ceil(enteredAt));
        const b = Math.min(GRID_MAX_MINUTES + 1, Math.ceil(t));
        if (b > a) {
          diff[a]! += weight;
          diff[b]! -= weight;
        }
      }

      const isLast = layer >= k - 1;
      const hop = isLast ? 0 : (params.hopProbability[layer] ?? 0);
      if (rng.next() < hop) {
        layer += 1;
        // Each hop fans out into several onward accounts, every one of which
        // needs its own freeze order.
        accounts += 1 + rng.poisson(Math.max(params.meanFanOut - 1, 0));
      } else {
        break;
      }
    }

    cashOutTimes[p] = t;
    hopTotal += layer;
    accountTotal += accounts;
  }

  const grid = new Float64Array(GRID_MAX_MINUTES + 1);
  let running = 0;
  for (let m = 0; m <= GRID_MAX_MINUTES; m++) {
    running += diff[m]!;
    grid[m] = running / paths;
  }

  cashOutTimes.sort((a, b) => a - b);
  return {
    cashOutTimes,
    grid,
    expectedHops: hopTotal / paths,
    expectedAccounts: accountTotal / paths,
  };
}

/** Fraction of paths not yet cashed out at t, ignoring traceability. */
function survivalAt(sortedTimes: readonly number[], minutes: number): number {
  if (sortedTimes.length === 0) return 0;
  let lo = 0;
  let hi = sortedTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTimes[mid]! <= minutes) lo = mid + 1;
    else hi = mid;
  }
  return (sortedTimes.length - lo) / sortedTimes.length;
}

// ---------------------------------------------------------------------------
// Public estimator
// ---------------------------------------------------------------------------

export interface RecoveryOptions {
  params?: RecoveryParams;
  /** Operational delay between issuing a freeze order and the bank acting, in minutes. */
  freezeLatencyMinutes?: number;
  method?: 'ctmc_closed_form' | 'monte_carlo';
  paths?: number;
  seed?: number | string;
}

/** A prepared recovery model. Simulation runs once; queries are constant time. */
export class RecoveryModel {
  readonly params: RecoveryParams;
  readonly freezeLatencyMinutes: number;
  readonly method: 'ctmc_closed_form' | 'monte_carlo';
  private readonly mc: MonteCarloResult;

  constructor(opts: RecoveryOptions = {}) {
    this.params = opts.params ?? DEFAULT_RECOVERY_PARAMS;
    this.freezeLatencyMinutes = opts.freezeLatencyMinutes ?? 0;
    this.method = opts.method ?? 'monte_carlo';
    this.mc = simulateChains(this.params, opts.paths ?? 20_000, opts.seed ?? 'recovery');
  }

  /**
   * Recoverable fraction when a freeze order is issued this many minutes after
   * the funds land. Operational freeze latency is added to the horizon: an
   * order raised at minute 10 that reaches the receiving bank at minute 25 can
   * only freeze what is still reachable at minute 25.
   */
  recoverableAt(minutesAfterLanding: number): number {
    const effective = Math.max(0, minutesAfterLanding) + this.freezeLatencyMinutes;
    if (this.method === 'ctmc_closed_form') return recoverableCtmc(this.params, effective);
    if (effective >= GRID_MAX_MINUTES) return this.mc.grid[GRID_MAX_MINUTES] ?? 0;
    // Linear interpolation between the two bracketing minute buckets.
    const lo = Math.floor(effective);
    const hi = Math.min(lo + 1, GRID_MAX_MINUTES);
    const frac = effective - lo;
    const a = this.mc.grid[lo] ?? 0;
    const b = this.mc.grid[hi] ?? 0;
    return a + (b - a) * frac;
  }

  /** 95% interval from the binomial sampling error of the survival estimate. */
  private interval(minutes: number): { lo: number; hi: number } {
    const n = this.mc.cashOutTimes.length;
    const p = this.recoverableAt(minutes - this.freezeLatencyMinutes);
    const se = Math.sqrt(Math.max(p * (1 - p), 0) / n);
    return { lo: Math.max(0, p - 1.96 * se), hi: Math.min(1, p + 1.96 * se) };
  }

  /** Full estimate at a reporting horizon, including the published curve. */
  estimate(horizonMinutes: number): RecoveryEstimate {
    return {
      fractionAtHorizon: this.recoverableAt(horizonMinutes),
      horizonMinutes,
      curve: CURVE_SAMPLE_MINUTES.map((m) => ({
        minutes: m,
        recoverable: this.recoverableAt(m),
      })),
      expectedHops: this.mc.expectedHops,
      method: this.method,
      interval:
        this.method === 'monte_carlo'
          ? this.interval(horizonMinutes + this.freezeLatencyMinutes)
          : undefined,
    };
  }

  /** Expected number of distinct accounts a freeze order must reach. */
  get expectedFreezeOrders(): number {
    return this.mc.expectedAccounts;
  }

  /** Quantiles of time to full cash-out, in minutes, ignoring traceability. */
  get cashOutQuantiles(): { p10: number; p50: number; p90: number } {
    return {
      p10: quantile(this.mc.cashOutTimes, 0.1),
      p50: quantile(this.mc.cashOutTimes, 0.5),
      p90: quantile(this.mc.cashOutTimes, 0.9),
    };
  }

  /** Unweighted survival, for separating the cash-out effect from the depth effect. */
  survivingAt(minutesAfterLanding: number): number {
    return survivalAt(
      this.mc.cashOutTimes,
      Math.max(0, minutesAfterLanding) + this.freezeLatencyMinutes,
    );
  }

  /**
   * Disagreement between the two estimators across the published curve, as the
   * maximum absolute difference in recoverable fraction. Reported in the
   * modelling document so the dwell-distribution choice stays visible.
   */
  estimatorGap(): { maxAbsDiff: number; atMinutes: number } {
    let maxAbsDiff = 0;
    let atMinutes = 0;
    for (const m of CURVE_SAMPLE_MINUTES) {
      const eff = m + this.freezeLatencyMinutes;
      const diff = Math.abs(this.recoverableAt(m) - recoverableCtmc(this.params, eff));
      if (diff > maxAbsDiff) {
        maxAbsDiff = diff;
        atMinutes = m;
      }
    }
    return { maxAbsDiff, atMinutes };
  }
}

/** Split a flagged amount into recoverable and lost components, conserving paise. */
export function splitRecoverable(
  amountPaise: Paise,
  recoverableFraction: number,
): { recoverablePaise: Paise; lostPaise: Paise } {
  const recoverablePaise = Math.round(amountPaise * recoverableFraction);
  return { recoverablePaise, lostPaise: amountPaise - recoverablePaise };
}
