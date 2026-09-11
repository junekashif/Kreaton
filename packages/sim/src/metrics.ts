import { clamp, wilsonInterval } from '@kreaton/core';

/**
 * Discrimination and calibration metrics.
 *
 * Two families, measuring different things, reported separately because
 * conflating them is the most common way a fraud model is oversold:
 *
 *   Discrimination asks whether the score ranks fraudulent payments above
 *   legitimate ones. ROC AUC, precision-recall AUC and the KS statistic measure
 *   this. Calibration cannot change any of them, because they depend only on
 *   the ordering.
 *
 *   Calibration asks whether a score of 0.05 actually means one in twenty.
 *   Brier score and expected calibration error measure this. It matters here
 *   more than in most classification problems, because the decision engine does
 *   not threshold the score, it multiplies it by an amount of money. A model
 *   that ranks perfectly but reports 0.9 when it means 0.2 will hold payments
 *   that should have been approved and cost real money.
 *
 * ROC AUC is reported but not led with. At a base rate near three in a
 * thousand it is a flattering and largely uninformative number: a model can
 * post 0.95 while its highest-scoring thousand payments are almost all
 * legitimate. Precision-recall AUC and recall at a fixed low false-positive
 * rate are the figures that reflect what an operations team would experience.
 */

export interface ScoredCase {
  /** Calibrated probability, or any monotone score for ranking-only metrics. */
  score: number;
  isFraud: boolean;
  /** Used for value-weighted metrics. */
  amountPaise?: number;
}

export interface DiscriminationMetrics {
  rocAuc: number;
  prAuc: number;
  /** Kolmogorov-Smirnov separation between the two score distributions. */
  ks: number;
  /** Score at which KS is attained, useful as a reference operating point. */
  ksAtScore: number;
  positives: number;
  negatives: number;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  count: number;
  meanPredicted: number;
  observedRate: number;
}

export interface CalibrationMetrics {
  brier: number;
  /** Expected calibration error: count-weighted mean gap across bins. */
  ece: number;
  /** Largest single-bin gap. */
  mce: number;
  bins: CalibrationBin[];
}

export interface OperatingPoint {
  threshold: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  falsePositiveRate: number;
  /** Recall interval, since recall at low prevalence is estimated from few cases. */
  recallInterval: { lo: number; hi: number };
}

/**
 * ROC AUC by the rank-sum identity, with ties handled by mid-rank.
 *
 * Computed from ranks rather than by sweeping thresholds so that tied scores,
 * which are common when many transactions fire no signal at all and share an
 * identical score, are handled correctly rather than silently ordered by input
 * position.
 */
export function rocAuc(cases: readonly ScoredCase[]): number {
  const n = cases.length;
  if (n === 0) return 0.5;
  const sorted = [...cases].sort((a, b) => a.score - b.score);

  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && sorted[j + 1]!.score === sorted[i]!.score) j++;
    const midRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = midRank;
    i = j + 1;
  }

  let positives = 0;
  let rankSum = 0;
  for (let k = 0; k < n; k++) {
    if (sorted[k]!.isFraud) {
      positives += 1;
      rankSum += ranks[k]!;
    }
  }
  const negatives = n - positives;
  if (positives === 0 || negatives === 0) return 0.5;
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/**
 * Precision-recall AUC by the average-precision estimator.
 *
 * Trapezoidal interpolation on a PR curve is optimistically biased, so the
 * step-wise average-precision form is used instead. At this prevalence the
 * difference is not cosmetic.
 */
export function prAuc(cases: readonly ScoredCase[]): number {
  const sorted = [...cases].sort((a, b) => b.score - a.score);
  const positives = sorted.filter((c) => c.isFraud).length;
  if (positives === 0) return 0;

  let tp = 0;
  let fp = 0;
  let previousRecall = 0;
  let ap = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.isFraud) tp += 1;
    else fp += 1;
    // Only accumulate at the end of a run of tied scores.
    if (i + 1 < sorted.length && sorted[i + 1]!.score === sorted[i]!.score) continue;
    const recall = tp / positives;
    const precision = tp / (tp + fp);
    ap += (recall - previousRecall) * precision;
    previousRecall = recall;
  }
  return ap;
}

/** KS statistic: the largest gap between the two cumulative score distributions. */
export function ksStatistic(cases: readonly ScoredCase[]): { ks: number; atScore: number } {
  const sorted = [...cases].sort((a, b) => a.score - b.score);
  const positives = sorted.filter((c) => c.isFraud).length;
  const negatives = sorted.length - positives;
  if (positives === 0 || negatives === 0) return { ks: 0, atScore: 0 };

  let cumulativePositive = 0;
  let cumulativeNegative = 0;
  let ks = 0;
  let atScore = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.isFraud) cumulativePositive += 1;
    else cumulativeNegative += 1;
    if (i + 1 < sorted.length && sorted[i + 1]!.score === sorted[i]!.score) continue;
    const gap = Math.abs(cumulativePositive / positives - cumulativeNegative / negatives);
    if (gap > ks) {
      ks = gap;
      atScore = sorted[i]!.score;
    }
  }
  return { ks, atScore };
}

export function discrimination(cases: readonly ScoredCase[]): DiscriminationMetrics {
  const { ks, atScore } = ksStatistic(cases);
  const positives = cases.filter((c) => c.isFraud).length;
  return {
    rocAuc: rocAuc(cases),
    prAuc: prAuc(cases),
    ks,
    ksAtScore: atScore,
    positives,
    negatives: cases.length - positives,
  };
}

/**
 * Calibration, binned on the predicted probability.
 *
 * Bins are quantile-based rather than equal-width. With most mass below one per
 * cent, equal-width bins would put almost every case in the first bin and
 * report a flattering error from a single enormous bucket.
 */
export function calibration(cases: readonly ScoredCase[], binCount = 12): CalibrationMetrics {
  if (cases.length === 0) return { brier: 0, ece: 0, mce: 0, bins: [] };

  let brier = 0;
  for (const c of cases) {
    const p = clamp(c.score, 0, 1);
    const y = c.isFraud ? 1 : 0;
    brier += (p - y) * (p - y);
  }
  brier /= cases.length;

  const sorted = [...cases].sort((a, b) => a.score - b.score);
  const perBin = Math.ceil(sorted.length / binCount);
  const bins: CalibrationBin[] = [];
  let ece = 0;
  let mce = 0;

  for (let start = 0; start < sorted.length; start += perBin) {
    const slice = sorted.slice(start, start + perBin);
    if (slice.length === 0) continue;
    const meanPredicted = slice.reduce((s, c) => s + clamp(c.score, 0, 1), 0) / slice.length;
    const observedRate = slice.filter((c) => c.isFraud).length / slice.length;
    bins.push({
      lo: slice[0]!.score,
      hi: slice[slice.length - 1]!.score,
      count: slice.length,
      meanPredicted,
      observedRate,
    });
    const gap = Math.abs(meanPredicted - observedRate);
    ece += (slice.length / sorted.length) * gap;
    if (gap > mce) mce = gap;
  }

  return { brier, ece, mce, bins };
}

/** Confusion counts and rates at a score threshold. */
export function operatingPoint(cases: readonly ScoredCase[], threshold: number): OperatingPoint {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const c of cases) {
    const flagged = c.score >= threshold;
    if (c.isFraud) flagged ? tp++ : fn++;
    else flagged ? fp++ : tn++;
  }
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  return {
    threshold,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision: tp + fp > 0 ? tp / (tp + fp) : 0,
    recall,
    falsePositiveRate: fp + tn > 0 ? fp / (fp + tn) : 0,
    recallInterval: wilsonInterval(tp, tp + fn),
  };
}

/**
 * Recall achievable while holding the false-positive rate at or below a ceiling.
 *
 * This is the number an operations team actually cares about: given that we can
 * only interrupt this fraction of legitimate customers, how much fraud do we
 * catch. Reported at several ceilings because the answer is very sensitive to
 * which one is chosen, and quoting a single figure invites cherry-picking.
 */
export function recallAtFpr(cases: readonly ScoredCase[], maxFpr: number): OperatingPoint {
  const negatives = cases.filter((c) => !c.isFraud);
  if (negatives.length === 0) return operatingPoint(cases, 1);

  // The threshold is the (1 - maxFpr) quantile of the negative score distribution.
  const negScores = negatives.map((c) => c.score).sort((a, b) => a - b);
  const idx = Math.min(
    negScores.length - 1,
    Math.floor((1 - clamp(maxFpr, 0, 1)) * negScores.length),
  );
  return operatingPoint(cases, negScores[idx]!);
}

/**
 * Value-weighted recall: the share of fraudulent rupees caught, rather than the
 * share of fraudulent payments.
 *
 * These diverge sharply here, because the typologies with the highest volume
 * carry the smallest amounts. A system can look mediocre by count and strong by
 * value, or the reverse, and reporting only one hides the trade-off the policy
 * interface exists to expose.
 */
export function valueRecallAtFpr(cases: readonly ScoredCase[], maxFpr: number): number {
  const point = recallAtFpr(cases, maxFpr);
  let caught = 0;
  let total = 0;
  for (const c of cases) {
    if (!c.isFraud) continue;
    const value = c.amountPaise ?? 1;
    total += value;
    if (c.score >= point.threshold) caught += value;
  }
  return total > 0 ? caught / total : 0;
}

/**
 * Lift by score decile, the presentation a fraud operations reviewer expects.
 */
export function decileLift(cases: readonly ScoredCase[], deciles = 10): Array<{
  decile: number;
  count: number;
  fraudCount: number;
  fraudRate: number;
  lift: number;
  capturedShare: number;
}> {
  const sorted = [...cases].sort((a, b) => b.score - a.score);
  const totalFraud = sorted.filter((c) => c.isFraud).length;
  const baseRate = totalFraud / Math.max(sorted.length, 1);
  const perBin = Math.ceil(sorted.length / deciles);
  const out = [];
  for (let d = 0; d < deciles; d++) {
    const slice = sorted.slice(d * perBin, (d + 1) * perBin);
    if (slice.length === 0) break;
    const fraudCount = slice.filter((c) => c.isFraud).length;
    const fraudRate = fraudCount / slice.length;
    out.push({
      decile: d + 1,
      count: slice.length,
      fraudCount,
      fraudRate,
      lift: baseRate > 0 ? fraudRate / baseRate : 0,
      capturedShare: totalFraud > 0 ? fraudCount / totalFraud : 0,
    });
  }
  return out;
}

/**
 * Reweight precision to a different prevalence.
 *
 * The corpus carries a higher fraud rate than the live rail so that the
 * evaluation has enough positives to estimate anything with confidence. That
 * inflates precision and precision-recall AUC while leaving ROC AUC and recall
 * untouched. Rather than quietly benefit from it, this converts a measured
 * operating point to the precision it would have at a stated prevalence, so the
 * report can state both.
 */
export function precisionAtPrevalence(
  point: OperatingPoint,
  targetPrevalence: number,
): number {
  const recall = point.recall;
  const fpr = point.falsePositiveRate;
  const numerator = recall * targetPrevalence;
  const denominator = numerator + fpr * (1 - targetPrevalence);
  return denominator > 0 ? numerator / denominator : 0;
}

/** Everything, in one call, for the evaluation report. */
export interface FullMetrics {
  discrimination: DiscriminationMetrics;
  calibration: CalibrationMetrics;
  operatingPoints: Array<{ maxFpr: number; point: OperatingPoint; valueRecall: number }>;
  deciles: ReturnType<typeof decileLift>;
}

export const REPORTED_FPR_CEILINGS: readonly number[] = [0.001, 0.005, 0.01, 0.02, 0.05] as const;

export function fullMetrics(cases: readonly ScoredCase[]): FullMetrics {
  return {
    discrimination: discrimination(cases),
    calibration: calibration(cases),
    operatingPoints: REPORTED_FPR_CEILINGS.map((maxFpr) => ({
      maxFpr,
      point: recallAtFpr(cases, maxFpr),
      valueRecall: valueRecallAtFpr(cases, maxFpr),
    })),
    deciles: decileLift(cases),
  };
}
