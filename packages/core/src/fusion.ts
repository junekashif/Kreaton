import { clamp, interpolatePiecewise, logit, sigmoid } from './mathx.js';
import { EXTRACTORS } from './signals/extract.js';
import { SIGNAL_ORDER, SIGNAL_SPECS, reasonCode, toBin } from './signals/specs.js';
import type {
  ModelSpec,
  ScoringContext,
  SignalGroup,
  SignalResult,
  SignalWoe,
  Transaction,
} from './types.js';

/**
 * Risk score fusion.
 *
 * The fused score is a sum of log-likelihood ratios in log-odds space:
 *
 *   logOdds = logit(baseRate) + sum_i  w_i * s_i * llr_i(bin_i)
 *
 * This form was chosen over a black-box classifier for one reason, and it is
 * the reason the whole audit trail works: because the model is additive in
 * log-odds, each signal contribution is *exactly* w_i * s_i * llr_i. There is
 * no attribution approximation, no sampling, and no post-hoc explainer that
 * could disagree with the model. For an additive model the Shapley value of a
 * feature is its own term, so the contributions printed in an audit record are
 * simultaneously the arithmetic that produced the score and its exact Shapley
 * decomposition. A reviewer can add the printed column up and get the score.
 *
 * Two deliberate departures from textbook naive Bayes:
 *
 * 1. Weight of evidence is computed per bin rather than per signal, so a signal
 *    may be evidence *against* fraud in some ranges. A long-standing
 *    beneficiary genuinely lowers the odds and the model is allowed to say so.
 *
 * 2. Correlated signals are shrunk as a block. Naive Bayes assumes conditional
 *    independence, which is plainly false here: amount deviation, drain ratio
 *    and velocity burst move together. Left uncorrected, a single underlying
 *    behavioural anomaly gets counted three times and the score saturates. See
 *    groupShrinkageFactor below.
 */

/**
 * A signal is reported as fired when its bin carries at least this much
 * evidence, in nats. 0.25 nats is a likelihood ratio of about 1.28 to 1: the
 * lowest level worth showing a human as a contributing reason. The threshold
 * affects presentation and reason codes only; the score always uses the full
 * log-likelihood ratio, including the bins below this line.
 */
export const FIRE_LLR_THRESHOLD = 0.25;

/**
 * Effective-sample-size correction for correlated evidence within a group.
 *
 * For k signals with mean pairwise correlation rho, the number of effectively
 * independent observations is k / (1 + (k-1) * rho). Dividing the group
 * contribution by (1 + (k-1) * rho) therefore restores the evidence to what
 * that many independent signals would have carried. With rho = 0 the factor is
 * 1 and the model reduces to plain naive Bayes; with rho = 1 the group counts
 * once however many signals fire.
 *
 * rho is estimated per group from the training data by the fitter, not chosen
 * by hand, and is published in the model card.
 */
export function groupShrinkageFactor(rho: number, contributingCount: number): number {
  if (contributingCount <= 1) return 1;
  return 1 / (1 + (contributingCount - 1) * clamp(rho, 0, 0.95));
}

/** Negligible-contribution cutoff, below which a signal is not counted toward k. */
const CONTRIBUTION_EPSILON = 1e-6;

function woeFor(model: ModelSpec, id: string): SignalWoe | undefined {
  return model.signals.find((s) => s.id === id);
}

/**
 * Evaluate all twelve signals against a transaction.
 *
 * Returns results in SIGNAL_ORDER with shrinkage already applied, so the
 * contribution column sums exactly to the fused score minus the prior.
 */
export function evaluateSignals(
  txn: Transaction,
  ctx: ScoringContext,
  model: ModelSpec,
): SignalResult[] {
  // Pass one: raw statistics, bins and unshrunk log-likelihood ratios.
  const staged = SIGNAL_ORDER.map((id) => {
    const spec = SIGNAL_SPECS[id];
    const { raw, evidence } = EXTRACTORS[id](txn, ctx);
    const bin = toBin(id, raw);
    const woe = woeFor(model, id);
    const llr = woe?.llrByBin[bin] ?? 0;
    const weight = woe?.weight ?? 1;
    return { id, spec, raw, bin, llr, weight, evidence, unshrunk: weight * llr };
  });

  // Pass two: count contributing signals per group to size the correction.
  const contributing = new Map<SignalGroup, number>();
  for (const s of staged) {
    if (Math.abs(s.unshrunk) > CONTRIBUTION_EPSILON) {
      contributing.set(s.spec.group, (contributing.get(s.spec.group) ?? 0) + 1);
    }
  }

  // Pass three: apply the group correction and finalise.
  const results: SignalResult[] = staged.map((s) => {
    const rho = model.groupShrinkage[s.spec.group] ?? 0;
    const shrinkage = groupShrinkageFactor(rho, contributing.get(s.spec.group) ?? 0);
    return {
      id: s.id,
      group: s.spec.group,
      raw: s.raw,
      bin: s.bin,
      fired: s.llr >= FIRE_LLR_THRESHOLD,
      llr: s.llr,
      weight: s.weight,
      shrinkage,
      contribution: s.unshrunk * shrinkage,
      evidence: s.evidence,
      reasonCode: reasonCode(s.id, s.bin),
    };
  });

  applyAsymmetricCap(results, model);
  return results;
}

/**
 * Floor the negative evidence an attacker-controllable group may contribute.
 *
 * Applied after shrinkage so the capped total is the one that actually reaches
 * the score, and applied by scaling the group negative contributions
 * proportionally so that the contribution column still sums exactly to the
 * fused score. Additivity is the property the entire audit trail rests on and
 * cannot be broken by a security adjustment.
 *
 * Positive contributions are never touched: a fraudster who does leave the call
 * running should still be caught by it.
 */
function applyAsymmetricCap(results: SignalResult[], model: ModelSpec): void {
  const config = model.asymmetricEvidence;
  if (!config || config.cappedGroups.length === 0) return;

  for (const group of config.cappedGroups) {
    const members = results.filter((r) => r.group === group);
    if (members.length === 0) continue;
    const total = members.reduce((sum, r) => sum + r.contribution, 0);
    if (total >= config.negativeFloor) continue;

    // Scale only the negative side, so the group total lands exactly on the floor.
    const negativeTotal = members.reduce((sum, r) => sum + Math.min(r.contribution, 0), 0);
    if (negativeTotal === 0) continue;
    const positiveTotal = total - negativeTotal;
    const allowedNegative = config.negativeFloor - positiveTotal;
    const scale = allowedNegative / negativeTotal;

    for (const r of members) {
      if (r.contribution < 0) r.contribution *= scale;
    }
  }
}

export interface FusionResult {
  priorLogOdds: number;
  fusedLogOdds: number;
  calibratedP: number;
  /** Reason codes for fired signals, strongest contribution first. */
  reasonCodes: string[];
}

/**
 * Fuse signal results into a calibrated probability.
 *
 * The raw sum of log-likelihood ratios is well ordered but poorly calibrated:
 * the independence assumption, even after group shrinkage, leaves the score
 * over-dispersed, so a raw sigmoid would report 0.99 far too often. The fitted
 * isotonic map corrects the levels while preserving the ordering, which is why
 * discrimination metrics are unchanged by calibration and reliability metrics
 * are transformed by it. Both are reported separately in the model card.
 */
export function fuse(signals: readonly SignalResult[], model: ModelSpec): FusionResult {
  const priorLogOdds = logit(model.baseRate);
  let fusedLogOdds = priorLogOdds;
  for (const s of signals) fusedLogOdds += s.contribution;

  const calibratedP =
    model.calibration.length > 0
      ? clamp(interpolatePiecewise(model.calibration, fusedLogOdds), 1e-9, 1 - 1e-9)
      : sigmoid(fusedLogOdds);

  const reasonCodes = signals
    .filter((s) => s.fired)
    .sort((a, b) => b.contribution - a.contribution)
    .map((s) => s.reasonCode);

  return { priorLogOdds, fusedLogOdds, calibratedP, reasonCodes };
}

/**
 * Total evidence carried by each signal group, for the contribution breakdown
 * shown in the interface and in the regulator export.
 */
export function contributionsByGroup(
  signals: readonly SignalResult[],
): Record<SignalGroup, number> {
  const out: Record<SignalGroup, number> = {
    identity_device: 0,
    behavioural: 0,
    payee_graph: 0,
    context: 0,
    structuring: 0,
  };
  for (const s of signals) out[s.group] += s.contribution;
  return out;
}

/**
 * Verify that the reported contributions reconstruct the reported score.
 *
 * This is an invariant of the additive form, and the audit export calls it
 * before writing a record. If it ever fails, the explanation and the decision
 * have diverged and the record must not be presented as an explanation.
 */
export function verifyAdditivity(
  signals: readonly SignalResult[],
  priorLogOdds: number,
  fusedLogOdds: number,
  tolerance = 1e-9,
): boolean {
  let sum = priorLogOdds;
  for (const s of signals) sum += s.contribution;
  return Math.abs(sum - fusedLogOdds) <= tolerance;
}
