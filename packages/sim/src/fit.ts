import {
  DEFAULT_RECOVERY_PARAMS,
  SIGNAL_ORDER,
  SIGNAL_SPECS,
  binCount,
  groupShrinkageFactor,
  logit,
} from '@kreaton/core';
import { fullMetrics } from './metrics.js';
import type { ModelSpec, SignalGroup, SignalId, SignalWoe } from '@kreaton/core';
import type { FeatureRow } from './replay.js';

/**
 * Model fitting.
 *
 * The model is fitted in four stages, in this order, and the order matters:
 *
 *   1. Weight of evidence per signal bin. Counts of fraudulent and legitimate
 *      rows in each bin give a log-likelihood ratio directly. This is the part
 *      a reviewer can audit by hand: the counts are published in the model
 *      card, and the ratio follows from them arithmetically.
 *
 *   2. Intra-group correlation. Signals in the same family move together, and
 *      the fusion step needs to know how much before it can discount them. The
 *      correlation is measured from the fitted log-likelihood ratios rather
 *      than assumed.
 *
 *   3. Per-signal weights, by logistic regression on the shrunk evidence. If
 *      the weight-of-evidence tables were perfectly estimated and the
 *      independence correction exact, every weight would come out at one. They
 *      do not, so fitting them absorbs the residual. Weights are regularised
 *      toward one rather than toward zero, so the naive Bayes solution is the
 *      null hypothesis and any departure from it has to be earned by the data.
 *
 *   4. Isotonic calibration of the fused score. Monotone, so it changes no
 *      ranking and therefore no discrimination metric, and corrects the levels
 *      that the residual independence violation leaves over-dispersed.
 *
 * Everything is fitted on the training window only. The test window is not
 * touched until evaluation.
 */

/** Laplace smoothing constant for the weight-of-evidence counts. */
const SMOOTHING = 0.5;

/**
 * Default asymmetric-evidence configuration.
 *
 * Only the context group is capped. Its members, concurrent coercion
 * indicators and session urgency, are the ones an attacker can suppress purely
 * by changing what they tell the victim to do, at no cost and with no effect on
 * the money they extract. Every other group requires the attacker to give
 * something up: paying a smaller amount, waiting longer, or using an account
 * with real history.
 *
 * The floor is two nats, roughly a likelihood ratio of seven to one, so a clean
 * session still counts meaningfully in the payer favour but cannot on its own
 * argue a payment down by two orders of magnitude. An earlier setting of one nat
 * was measurably too aggressive: it raised the context-suppression catch rate
 * but cost around a third of precision-recall AUC across the whole portfolio,
 * which is not a trade worth making. The cost of the cap is measured rather
 * than assumed, and is reported alongside the catch-rate improvement it buys.
 */
export const DEFAULT_ASYMMETRIC_EVIDENCE = {
  cappedGroups: ['context'] as const,
  negativeFloor: -2.0,
};

/** Ridge strength pulling weights toward the naive Bayes solution of one. */
const RIDGE = 12;

const IRLS_ITERATIONS = 30;
const IRLS_TOLERANCE = 1e-9;

/** Maximum knots retained in the calibration map. */
const CALIBRATION_KNOTS = 96;

// ---------------------------------------------------------------------------
// Stage 1: weight of evidence
// ---------------------------------------------------------------------------

interface WoeTable {
  llrByBin: number[];
  fraudCountByBin: number[];
  legitCountByBin: number[];
}

/**
 * Count-based log-likelihood ratio per bin.
 *
 * Laplace smoothing keeps a bin that happens to contain no fraud in the
 * training window from asserting infinite evidence against fraud, which matters
 * because at this base rate many bins legitimately contain none.
 */
function fitWoe(rows: readonly FeatureRow[], signalIndex: number, id: SignalId): WoeTable {
  const nBins = binCount(id);
  const fraudCountByBin = new Array<number>(nBins).fill(0);
  const legitCountByBin = new Array<number>(nBins).fill(0);

  for (const row of rows) {
    const bin = row.bins[signalIndex] ?? 0;
    if (row.isFraud) fraudCountByBin[bin] = (fraudCountByBin[bin] ?? 0) + 1;
    else legitCountByBin[bin] = (legitCountByBin[bin] ?? 0) + 1;
  }

  const totalFraud = fraudCountByBin.reduce((a, b) => a + b, 0);
  const totalLegit = legitCountByBin.reduce((a, b) => a + b, 0);

  const llrByBin = fraudCountByBin.map((f, b) => {
    const l = legitCountByBin[b] ?? 0;
    const pFraud = (f + SMOOTHING) / (totalFraud + SMOOTHING * nBins);
    const pLegit = (l + SMOOTHING) / (totalLegit + SMOOTHING * nBins);
    return Math.log(pFraud / pLegit);
  });

  return { llrByBin, fraudCountByBin, legitCountByBin };
}

/**
 * Extend the table across bins the training window never observed.
 *
 * Two bins are systematically unobserved during fitting: the extreme tails of
 * rarely-used signals, and the structuring bins that only open when a hold is
 * already running, which cannot happen during a model-free feature pass. Left
 * smoothed to roughly zero, those bins would silently discard evidence at
 * exactly the moments the system is most likely to be under attack.
 *
 * An unobserved bin therefore inherits the nearest observed bin on the side
 * closer to the body of the distribution, which extends the last measured level
 * outward rather than inventing a new one.
 */
function fillSparseBins(table: WoeTable, minimumObservations = 5): WoeTable {
  const observed = table.fraudCountByBin.map(
    (f, b) => f + (table.legitCountByBin[b] ?? 0) >= minimumObservations,
  );
  const llr = [...table.llrByBin];

  let lastSeen: number | null = null;
  for (let b = 0; b < llr.length; b++) {
    if (observed[b]) lastSeen = llr[b]!;
    else if (lastSeen !== null) llr[b] = lastSeen;
  }
  lastSeen = null;
  for (let b = llr.length - 1; b >= 0; b--) {
    if (observed[b]) lastSeen = llr[b]!;
    else if (lastSeen !== null && !observed[b]) {
      // Only fill from the right if the left pass found nothing.
      const filledFromLeft = llr[b] !== table.llrByBin[b];
      if (!filledFromLeft) llr[b] = lastSeen;
    }
  }

  return { ...table, llrByBin: llr };
}

// ---------------------------------------------------------------------------
// Stage 2: intra-group correlation
// ---------------------------------------------------------------------------

function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i]!;
    my += ys[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Mean pairwise correlation of the evidence contributed by signals in a group.
 *
 * Measured on the log-likelihood ratios rather than on the raw statistics,
 * because it is the evidence that gets double counted, not the measurement.
 * Negative correlations are floored at zero: a group whose members genuinely
 * disagree carries more independent information than one signal, not less, and
 * inflating evidence on that basis would be the wrong kind of correction.
 */
function estimateGroupCorrelation(
  rows: readonly FeatureRow[],
  llrSeries: number[][],
): Record<SignalGroup, number> {
  const groups: Record<SignalGroup, number[]> = {
    identity_device: [],
    behavioural: [],
    payee_graph: [],
    context: [],
    structuring: [],
  };
  SIGNAL_ORDER.forEach((id, idx) => {
    groups[SIGNAL_SPECS[id].group].push(idx);
  });

  const out: Record<SignalGroup, number> = {
    identity_device: 0,
    behavioural: 0,
    payee_graph: 0,
    context: 0,
    structuring: 0,
  };

  for (const [group, indices] of Object.entries(groups) as Array<[SignalGroup, number[]]>) {
    if (indices.length < 2) {
      out[group] = 0;
      continue;
    }
    let total = 0;
    let pairs = 0;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        total += Math.max(0, pearson(llrSeries[indices[a]!]!, llrSeries[indices[b]!]!));
        pairs += 1;
      }
    }
    out[group] = pairs > 0 ? total / pairs : 0;
  }
  void rows;
  return out;
}

// ---------------------------------------------------------------------------
// Stage 3: weights by iteratively reweighted least squares
// ---------------------------------------------------------------------------

/** Gaussian elimination with partial pivoting. The system here is 12x12. */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) continue;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];

    const pivotValue = m[col]![col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r]![col]! / pivotValue;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) m[r]![c]! -= factor * m[col]![c]!;
    }
  }

  return Array.from({ length: n }, (_, i) => {
    const d = m[i]![i]!;
    return Math.abs(d) < 1e-12 ? 1 : m[i]![n]! / d;
  });
}

function sigmoidSafe(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const z = Math.exp(x);
  return z / (1 + z);
}

/**
 * Fit per-signal weights.
 *
 * The offset is the population prior, so the weights explain only the departure
 * from it. The ridge penalty is centred on one rather than zero, which encodes
 * the position that the weight-of-evidence estimate is correct until the data
 * says otherwise, and keeps a signal with thin support from acquiring a large
 * weight on the strength of a handful of rows.
 */
function fitWeights(
  design: number[][],
  labels: readonly boolean[],
  offset: number,
): { weights: number[]; iterations: number; converged: boolean } {
  const k = SIGNAL_ORDER.length;
  const n = design.length;
  let w = new Array<number>(k).fill(1);

  for (let iter = 0; iter < IRLS_ITERATIONS; iter++) {
    const hessian = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const gradient = new Array<number>(k).fill(0);

    for (let i = 0; i < n; i++) {
      const x = design[i]!;
      let z = offset;
      for (let j = 0; j < k; j++) z += w[j]! * x[j]!;
      const p = sigmoidSafe(z);
      const residual = (labels[i] ? 1 : 0) - p;
      const variance = Math.max(p * (1 - p), 1e-10);

      for (let j = 0; j < k; j++) {
        const xj = x[j]!;
        if (xj === 0) continue;
        gradient[j]! += residual * xj;
        const hj = hessian[j]!;
        for (let l = j; l < k; l++) hj[l]! += variance * xj * x[l]!;
      }
    }

    // Mirror the upper triangle and apply the ridge centred on one.
    for (let j = 0; j < k; j++) {
      for (let l = 0; l < j; l++) hessian[j]![l] = hessian[l]![j]!;
      hessian[j]![j]! += RIDGE;
      gradient[j]! -= RIDGE * (w[j]! - 1);
    }

    const step = solveLinear(hessian, gradient);
    let maxStep = 0;
    for (let j = 0; j < k; j++) {
      // Damped, because an early iteration on a near-singular design can
      // otherwise throw a weight far enough that it never recovers.
      const delta = Math.max(-0.75, Math.min(0.75, step[j]!));
      w[j]! += delta;
      maxStep = Math.max(maxStep, Math.abs(delta));
    }

    if (maxStep < IRLS_TOLERANCE) return { weights: w, iterations: iter + 1, converged: true };
  }
  return { weights: w, iterations: IRLS_ITERATIONS, converged: false };
}

// ---------------------------------------------------------------------------
// Stage 4: isotonic calibration
// ---------------------------------------------------------------------------

/**
 * Pool adjacent violators.
 *
 * Produces the non-decreasing step function closest to the observed outcomes in
 * least squares, which is the maximum-likelihood monotone calibration. Monotone
 * means it cannot reorder anything, so every discrimination metric is identical
 * before and after; only the reported levels move.
 */
function pava(xs: readonly number[], ys: readonly number[]): Array<{ x: number; y: number }> {
  const n = xs.length;
  if (n === 0) return [];

  const values: number[] = [];
  const weights: number[] = [];
  const rightEdge: number[] = [];

  for (let i = 0; i < n; i++) {
    values.push(ys[i]!);
    weights.push(1);
    rightEdge.push(xs[i]!);
    // Merge backwards while the sequence violates monotonicity. Equal levels
    // merge too: pooling them changes no fitted value, and without it every
    // legitimate row in a run of zeros stays its own block, which leaves the
    // step function with hundreds of thousands of knots that all say zero and
    // starves the compression below of the knots that carry information.
    while (values.length > 1 && values[values.length - 2]! >= values[values.length - 1]!) {
      const yB = values.pop()!;
      const wB = weights.pop()!;
      const xB = rightEdge.pop()!;
      const yA = values.pop()!;
      const wA = weights.pop()!;
      rightEdge.pop();
      values.push((yA * wA + yB * wB) / (wA + wB));
      weights.push(wA + wB);
      rightEdge.push(xB);
    }
  }

  return values.map((y, i) => ({ x: rightEdge[i]!, y }));
}

/**
 * Reduce a step function to a bounded set of knots.
 *
 * Knots are kept where the level moves, not at even ranks. Almost all of the
 * training rows sit in the flat region near zero, and sampling by rank would
 * spend nearly every knot there and describe the high-risk tail, where the
 * decisions are made, with one or two points. The tolerance is raised until
 * the set fits; the first and last knots are always retained.
 */
function compressKnots(
  knots: ReadonlyArray<{ x: number; y: number }>,
  limit = CALIBRATION_KNOTS,
): Array<{ x: number; y: number }> {
  if (knots.length <= limit) return [...knots];
  let tolerance = 1e-5;
  for (;;) {
    const out: Array<{ x: number; y: number }> = [{ ...knots[0]! }];
    for (let i = 1; i < knots.length - 1; i++) {
      const k = knots[i]!;
      if (k.y - out[out.length - 1]!.y >= tolerance) out.push({ x: k.x, y: k.y });
    }
    const last = knots[knots.length - 1]!;
    if (last.x > out[out.length - 1]!.x) out.push({ x: last.x, y: last.y });
    if (out.length <= limit) return out;
    tolerance *= 1.5;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface FitDiagnostics {
  groupCorrelation: Record<SignalGroup, number>;
  weights: Record<SignalId, number>;
  irlsIterations: number;
  irlsConverged: boolean;
  trainRows: number;
  trainFraud: number;
  /** Bins that had to be filled because the training window never observed them. */
  filledBins: Array<{ signal: SignalId; bin: number }>;
  /**
   * Held-out ROC AUC of each signal used alone.
   *
   * This exists as a guard against the corpus, not as a description of the
   * model. A generated dataset makes it very easy to create a signal that
   * separates the classes perfectly by accident, at which point the fused score
   * is measuring the generator rather than the method. Any single-signal AUC
   * approaching 1.0 means the generator needs fixing, and the evaluation script
   * fails the run rather than reporting the result.
   */
  marginalAuc: Record<SignalId, number>;
}

/** Single-signal ROC AUC, by the mid-rank rank-sum identity. */
function marginalAucFor(rows: readonly FeatureRow[], llrOf: (row: FeatureRow) => number): number {
  const scored = rows.map((r) => ({ s: llrOf(r), y: r.isFraud })).sort((a, b) => a.s - b.s);
  const n = scored.length;
  if (n === 0) return 0.5;
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scored[j + 1]!.s === scored[i]!.s) j++;
    const mid = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = mid;
    i = j + 1;
  }
  let pos = 0;
  let rankSum = 0;
  for (let k = 0; k < n; k++) {
    if (scored[k]!.y) {
      pos += 1;
      rankSum += ranks[k]!;
    }
  }
  const neg = n - pos;
  if (pos === 0 || neg === 0) return 0.5;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export interface FitResult {
  model: ModelSpec;
  diagnostics: FitDiagnostics;
}

export interface FitOptions {
  version: string;
  /** Rows from the training window only. */
  train: readonly FeatureRow[];
  /** Held-out rows, scored to populate the published metrics. */
  test: readonly FeatureRow[];
}

/** Score a feature row under a fitted model, returning the fused log-odds. */
export function scoreRow(row: FeatureRow, model: ModelSpec): number {
  const contributions = signalContributions(row, model);
  let total = logit(model.baseRate);
  for (const c of contributions) total += c;
  return total;
}

/** Per-signal contribution to the fused log-odds, in SIGNAL_ORDER. */
export function signalContributions(row: FeatureRow, model: ModelSpec): number[] {
  const llrs = SIGNAL_ORDER.map((id, idx) => {
    const woe = model.signals.find((s) => s.id === id);
    return woe?.llrByBin[row.bins[idx] ?? 0] ?? 0;
  });
  const weights = SIGNAL_ORDER.map((id) => model.signals.find((s) => s.id === id)?.weight ?? 1);

  const contributing: Record<string, number> = {};
  SIGNAL_ORDER.forEach((id, idx) => {
    if (Math.abs(llrs[idx]! * weights[idx]!) > 1e-6) {
      const g = SIGNAL_SPECS[id].group;
      contributing[g] = (contributing[g] ?? 0) + 1;
    }
  });

  const contributions = SIGNAL_ORDER.map((id, idx) => {
    const g = SIGNAL_SPECS[id].group;
    const shrinkage = groupShrinkageFactor(model.groupShrinkage[g] ?? 0, contributing[g] ?? 0);
    return llrs[idx]! * weights[idx]! * shrinkage;
  });

  // The same asymmetric floor the runtime engine applies. Calibration is fitted
  // on these scores, so if the two diverged the committed calibration map would
  // be describing a scoring function the engine does not actually compute.
  const config = model.asymmetricEvidence;
  if (config && config.cappedGroups.length > 0) {
    for (const group of config.cappedGroups) {
      const indices = SIGNAL_ORDER.map((id, i) => (SIGNAL_SPECS[id].group === group ? i : -1)).filter(
        (i) => i >= 0,
      );
      if (indices.length === 0) continue;
      const total = indices.reduce((sum, i) => sum + contributions[i]!, 0);
      if (total >= config.negativeFloor) continue;
      const negativeTotal = indices.reduce((sum, i) => sum + Math.min(contributions[i]!, 0), 0);
      if (negativeTotal === 0) continue;
      const scale = (config.negativeFloor - (total - negativeTotal)) / negativeTotal;
      for (const i of indices) {
        if (contributions[i]! < 0) contributions[i]! *= scale;
      }
    }
  }

  return contributions;
}

export function fitModel(opts: FitOptions): FitResult {
  const { train, test, version } = opts;
  const trainFraud = train.filter((r) => r.isFraud).length;
  const baseRate = Math.max(trainFraud / Math.max(train.length, 1), 1e-6);
  const offset = logit(baseRate);

  // Stage 1.
  const tables = SIGNAL_ORDER.map((id, idx) => fillSparseBins(fitWoe(train, idx, id)));
  const filledBins: FitDiagnostics['filledBins'] = [];
  SIGNAL_ORDER.forEach((id, idx) => {
    const t = tables[idx]!;
    t.fraudCountByBin.forEach((f, b) => {
      if (f + (t.legitCountByBin[b] ?? 0) < 5) filledBins.push({ signal: id, bin: b });
    });
  });

  // Per-signal LLR series, reused by stages 2 and 3.
  const llrSeries: number[][] = SIGNAL_ORDER.map((_, idx) =>
    train.map((row) => tables[idx]!.llrByBin[row.bins[idx] ?? 0] ?? 0),
  );

  // Stage 2.
  const groupCorrelation = estimateGroupCorrelation(train, llrSeries);

  // Stage 3. The design matrix carries the shrunk evidence, so the weights are
  // fitted against exactly what the runtime engine will compute.
  const groupOf = SIGNAL_ORDER.map((id) => SIGNAL_SPECS[id].group);
  const design: number[][] = train.map((_, rowIdx) => {
    const counts: Partial<Record<SignalGroup, number>> = {};
    for (let s = 0; s < SIGNAL_ORDER.length; s++) {
      if (Math.abs(llrSeries[s]![rowIdx]!) > 1e-6) {
        const g = groupOf[s]!;
        counts[g] = (counts[g] ?? 0) + 1;
      }
    }
    return SIGNAL_ORDER.map((_id, s) => {
      const g = groupOf[s]!;
      return llrSeries[s]![rowIdx]! * groupShrinkageFactor(groupCorrelation[g] ?? 0, counts[g] ?? 0);
    });
  });

  const { weights, iterations, converged } = fitWeights(
    design,
    train.map((r) => r.isFraud),
    offset,
  );

  const signals: SignalWoe[] = SIGNAL_ORDER.map((id, idx) => {
    const t = tables[idx]!;
    const fireFrom = t.llrByBin.findIndex((v) => v >= 0.25);
    return {
      id,
      llrByBin: t.llrByBin,
      fraudCountByBin: t.fraudCountByBin,
      legitCountByBin: t.legitCountByBin,
      weight: weights[idx]!,
      firedFromBin: fireFrom === -1 ? t.llrByBin.length : fireFrom,
    };
  });

  // Stage 4. Calibrate on the training window using the fitted weights.
  const draft: ModelSpec = {
    version,
    fittedAt: new Date().toISOString(),
    baseRate,
    signals,
    groupShrinkage: groupCorrelation,
    asymmetricEvidence: {
      cappedGroups: [...DEFAULT_ASYMMETRIC_EVIDENCE.cappedGroups],
      negativeFloor: DEFAULT_ASYMMETRIC_EVIDENCE.negativeFloor,
    },
    calibration: [],
    recovery: DEFAULT_RECOVERY_PARAMS,
    metrics: {
      rocAuc: 0,
      prAuc: 0,
      ks: 0,
      brier: 0,
      ece: 0,
      recallAt1PctFpr: 0,
      trainRows: train.length,
      testRows: test.length,
    },
  };

  const trainScored = train
    .map((row) => ({ x: scoreRow(row, draft), y: row.isFraud ? 1 : 0 }))
    .sort((a, b) => a.x - b.x);
  const calibration = compressKnots(
    pava(
      trainScored.map((p) => p.x),
      trainScored.map((p) => p.y),
    ),
  );

  const calibrated: ModelSpec = { ...draft, calibration };

  // Evaluate on the held-out window.
  const testCases = test.map((row) => ({
    score: applyCalibration(scoreRow(row, calibrated), calibration),
    isFraud: row.isFraud,
    amountPaise: row.amountPaise,
  }));
  const m = fullMetrics(testCases);
  const onePct = m.operatingPoints.find((p) => p.maxFpr === 0.01);

  const model: ModelSpec = {
    ...calibrated,
    metrics: {
      rocAuc: m.discrimination.rocAuc,
      prAuc: m.discrimination.prAuc,
      ks: m.discrimination.ks,
      brier: m.calibration.brier,
      ece: m.calibration.ece,
      recallAt1PctFpr: onePct?.point.recall ?? 0,
      trainRows: train.length,
      testRows: test.length,
    },
  };

  const marginalAuc = Object.fromEntries(
    SIGNAL_ORDER.map((id, idx) => {
      const woe = model.signals.find((s) => s.id === id)!;
      return [id, marginalAucFor(test, (row) => woe.llrByBin[row.bins[idx] ?? 0] ?? 0)];
    }),
  ) as Record<SignalId, number>;

  return {
    model,
    diagnostics: {
      groupCorrelation,
      weights: Object.fromEntries(SIGNAL_ORDER.map((id, i) => [id, weights[i]!])) as Record<
        SignalId,
        number
      >,
      irlsIterations: iterations,
      irlsConverged: converged,
      trainRows: train.length,
      trainFraud,
      filledBins,
      marginalAuc,
    },
  };
}

/** Apply a fitted calibration map to a fused log-odds score. */
export function applyCalibration(
  logOdds: number,
  knots: ReadonlyArray<{ x: number; y: number }>,
): number {
  if (knots.length === 0) return sigmoidSafe(logOdds);
  const first = knots[0]!;
  const last = knots[knots.length - 1]!;
  if (logOdds <= first.x) return first.y;
  if (logOdds >= last.x) return last.y;
  let lo = 0;
  let hi = knots.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (knots[mid]!.x <= logOdds) lo = mid;
    else hi = mid;
  }
  const a = knots[lo]!;
  const b = knots[hi]!;
  const span = b.x - a.x;
  return span === 0 ? b.y : a.y + ((logOdds - a.x) / span) * (b.y - a.y);
}
