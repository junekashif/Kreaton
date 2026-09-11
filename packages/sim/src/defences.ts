import {
  SIGNAL_ORDER,
  decide,
  evaluateSignals,
  fuse,
  toPaise,
} from '@kreaton/core';
import type {
  ModelSpec,
  Paise,
  Policy,
  ScoringContext,
  Transaction,
} from '@kreaton/core';

/**
 * Competing defences, for a comparison that means something.
 *
 * An ablation study on a twelve-signal fused model turns out to say very little
 * about episode outcomes. Remove any one signal and the other eleven still
 * catch the attack, so nearly every countermeasure measures as worth zero. That
 * is a real property of defence in depth rather than a measurement error, but
 * it is not an answer to the question of whether any of this is an improvement
 * on what is already deployed.
 *
 * So the primary comparison here is between three whole systems, evaluated
 * against the same attacks at the same level of customer friction:
 *
 *   1. A tuned rule, which is what most deployed controls actually are: an
 *      amount threshold, plus a tighter threshold for first-time beneficiaries.
 *      It is tuned rather than strawmanned, its thresholds fitted to hit the
 *      same false-positive rate as the other two.
 *
 *   2. The same fused score as the full system, but thresholded at a single
 *      global probability. This isolates the contribution of the expected-cost
 *      decision layer from the contribution of the score itself.
 *
 *   3. The full system: fused score plus an amount-dependent boundary derived
 *      from expected cost.
 *
 * Matching false-positive rates is what makes the comparison fair. A control
 * that catches more fraud by interrupting more customers has not improved
 * anything, and comparing catch rates at different friction levels is the
 * commonest way that claim gets made.
 */

export type DefenceId = 'rule_baseline' | 'fixed_threshold' | 'expected_cost';

export interface DefenceParams {
  /** Amount above which the rule intervenes regardless of beneficiary. */
  ruleHighAmount: Paise;
  /** Amount above which the rule intervenes for a first-time beneficiary. */
  ruleNewPayeeAmount: Paise;
  /** Hours below which a beneficiary counts as first-time for the rule. */
  ruleNoveltyHours: number;
  /** Global probability threshold for the fixed-threshold system. */
  fixedThreshold: number;
}

export const DEFENCE_LABELS: Record<DefenceId, { label: string; description: string }> = {
  rule_baseline: {
    label: 'Tuned rule',
    description:
      'Intervene above a fixed amount, or above a lower amount when the beneficiary is new. Thresholds fitted to the same false-positive rate as the other systems. This is the shape of most controls actually in production.',
  },
  fixed_threshold: {
    label: 'Fused score, single threshold',
    description:
      'The same twelve-signal fused and calibrated score, compared against one global probability threshold. Isolates what the score contributes from what the decision layer contributes.',
  },
  expected_cost: {
    label: 'Fused score, expected-cost boundary',
    description:
      'The full system. The same score, but the intervention boundary is derived per payment from expected compensation liability against expected friction, so it moves with the amount.',
  },
};

/** Does this defence intervene on this payment? */
export function intervenes(
  id: DefenceId,
  txn: Transaction,
  ctx: ScoringContext,
  model: ModelSpec,
  policy: Policy,
  recoveryAtReportLag: number,
  params: DefenceParams,
): boolean {
  if (id === 'rule_baseline') {
    const noveltyIndex = SIGNAL_ORDER.indexOf('PAYEE_NOVELTY');
    const noveltyHours = noveltyIndex >= 0 ? noveltyRaw(txn, ctx) : Number.POSITIVE_INFINITY;
    const isNew = noveltyHours < params.ruleNoveltyHours;
    return (
      txn.amountPaise >= params.ruleHighAmount ||
      (isNew && txn.amountPaise >= params.ruleNewPayeeAmount)
    );
  }

  const signals = evaluateSignals(txn, ctx, model);
  const fused = fuse(signals, model);

  if (id === 'fixed_threshold') return fused.calibratedP >= params.fixedThreshold;

  return (
    decide(
      {
        amountPaise: txn.amountPaise,
        fraudProbability: fused.calibratedP,
        recoveryAtReportLag,
      },
      policy,
    ).chosen !== 'APPROVE'
  );
}

/** Beneficiary age in hours, computed the same way the novelty signal does. */
function noveltyRaw(txn: Transaction, ctx: ScoringContext): number {
  const addedAt = txn.context.beneficiaryAddedAtMs;
  const firstPaidAt = ctx.payer.knownPayees[txn.payeeId];
  const anchors = [addedAt, firstPaidAt].filter((v): v is number => typeof v === 'number');
  const anchor = anchors.length > 0 ? Math.min(...anchors) : ctx.now;
  return Math.max(0, (ctx.now - anchor) / 3_600_000);
}

// ---------------------------------------------------------------------------
// Calibration to a common friction level
// ---------------------------------------------------------------------------

export interface CalibrationSample {
  txn: Transaction;
  ctx: ScoringContext;
}

/**
 * Fit every defence to the false-positive rate the full system produces.
 *
 * The full system sets the reference, because its boundary comes from the cost
 * model rather than from a number anyone chose. The other two are then tuned to
 * match it, so any difference in catch rate is a difference in discrimination
 * rather than in appetite for interrupting customers.
 */
export function calibrateDefences(
  legitimate: readonly CalibrationSample[],
  model: ModelSpec,
  policy: Policy,
  recoveryAtReportLag: number,
): { params: DefenceParams; referenceFpr: number } {
  const seed: DefenceParams = {
    ruleHighAmount: toPaise(50_000),
    ruleNewPayeeAmount: toPaise(5_000),
    ruleNoveltyHours: 24,
    fixedThreshold: 0.5,
  };

  // Reference: what the full system actually does to legitimate traffic.
  let flagged = 0;
  const probabilities: number[] = [];
  for (const s of legitimate) {
    const signals = evaluateSignals(s.txn, s.ctx, model);
    const fused = fuse(signals, model);
    probabilities.push(fused.calibratedP);
    const action = decide(
      {
        amountPaise: s.txn.amountPaise,
        fraudProbability: fused.calibratedP,
        recoveryAtReportLag,
      },
      policy,
    ).chosen;
    if (action !== 'APPROVE') flagged += 1;
  }
  const referenceFpr = legitimate.length > 0 ? flagged / legitimate.length : 0;

  // Fixed threshold: the quantile of legitimate scores that produces the same rate.
  const sortedScores = [...probabilities].sort((a, b) => a - b);
  const idx = Math.min(
    sortedScores.length - 1,
    Math.max(0, Math.floor((1 - referenceFpr) * sortedScores.length)),
  );
  const fixedThreshold = sortedScores[idx] ?? 0.5;

  // Rule thresholds: search the amount pair that lands closest to the same rate.
  // Searched rather than asserted, so the rule is given its best shot.
  const highCandidates = [10_000, 20_000, 35_000, 50_000, 75_000, 100_000, 150_000, 250_000, 500_000];
  const newCandidates = [500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000];

  let best = { high: seed.ruleHighAmount, low: seed.ruleNewPayeeAmount, gap: Number.POSITIVE_INFINITY };
  for (const high of highCandidates) {
    for (const low of newCandidates) {
      if (low > high) continue;
      let hits = 0;
      for (const s of legitimate) {
        const hours = noveltyRaw(s.txn, s.ctx);
        const isNew = hours < seed.ruleNoveltyHours;
        if (s.txn.amountPaise >= toPaise(high) || (isNew && s.txn.amountPaise >= toPaise(low))) {
          hits += 1;
        }
      }
      const fpr = legitimate.length > 0 ? hits / legitimate.length : 0;
      const gap = Math.abs(fpr - referenceFpr);
      if (gap < best.gap) best = { high: toPaise(high), low: toPaise(low), gap };
    }
  }

  return {
    params: {
      ruleHighAmount: best.high,
      ruleNewPayeeAmount: best.low,
      ruleNoveltyHours: seed.ruleNoveltyHours,
      fixedThreshold,
    },
    referenceFpr,
  };
}

/** Measured false-positive rate of one defence on legitimate traffic. */
export function measureFpr(
  id: DefenceId,
  legitimate: readonly CalibrationSample[],
  model: ModelSpec,
  policy: Policy,
  recoveryAtReportLag: number,
  params: DefenceParams,
): number {
  if (legitimate.length === 0) return 0;
  let hits = 0;
  for (const s of legitimate) {
    if (intervenes(id, s.txn, s.ctx, model, policy, recoveryAtReportLag, params)) hits += 1;
  }
  return hits / legitimate.length;
}
