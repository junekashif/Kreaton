import { clamp } from './mathx.js';
import { toPaise } from './money.js';
import type { Action, CostBreakdown, Paise, Policy } from './types.js';

/**
 * Expected financial cost decision engine.
 *
 * The system does not choose an action by comparing a risk score to a
 * threshold somebody picked. It computes what each available action is
 * expected to cost in rupees and takes the cheapest one. The threshold is an
 * output of that arithmetic, not an input to it.
 *
 * This matters for a reason that is easy to miss: the cost of getting it wrong
 * is wildly asymmetric in the amount. Friction costs roughly the same whether
 * the payment is five hundred rupees or five lakh, while compensation
 * liability scales with the amount. A fixed score threshold therefore has to
 * be wrong at one end or the other. Deriving the threshold from the economics
 * makes it move with the amount automatically, which is both cheaper and far
 * easier to defend to a regulator than a number in a configuration file.
 *
 * The three actions and what each is expected to cost:
 *
 *   APPROVE   Nothing happens now. If the payment is fraudulent, the victim
 *             reports it after a lag, a freeze order goes out, and whatever
 *             cannot be recovered by then becomes compensation liability.
 *
 *   STEP_UP   The payment is held and re-confirmed out of band. A genuine
 *             fraud is stopped with probability stepUpCatchRate, in which case
 *             nothing settles and there is no liability at all. The operational
 *             cost is paid either way, and a legitimate customer may abandon.
 *
 *   BLOCK     Nothing settles, so there is no liability. The whole cost is
 *             friction: complaint handling, and a materially higher chance a
 *             legitimate customer walks.
 *
 * Every figure below is in integer paise.
 */

/**
 * Default policy.
 *
 * These are documented estimates, justified line by line in docs/MODELING.md
 * with a sensitivity analysis showing which of them the decision boundary
 * actually depends on. They are starting positions for the policy interface,
 * not claims of measurement.
 */
export const DEFAULT_POLICY: Policy = {
  // Full reimbursement of the victim by the payment service provider. Set to
  // 0.5 to model a sending/receiving split of the kind the UK Payment Systems
  // Regulator applies to its APP reimbursement regime.
  liabilityShare: 1.0,
  // Probability an out-of-band re-confirmation stops a genuine scam payment.
  // Out-of-band matters: a challenge delivered to the device the fraudster is
  // already coaching the victim through is worth far less than this.
  stepUpCatchRate: 0.65,
  // Operational cost of holding one payment: queue handling, notification,
  // and the customer time consumed.
  stepUpFrictionPaise: toPaise(35),
  // Operational cost of declining one payment: complaint handling and the
  // support contact that reliably follows.
  blockFrictionPaise: toPaise(250),
  // Probability a legitimate customer abandons the relationship after a hold.
  stepUpAbandonmentRate: 0.04,
  // Probability a legitimate customer abandons after an outright decline.
  blockAbandonmentRate: 0.18,
  // Lifetime margin at risk when a customer does abandon.
  customerLifetimeValuePaise: toPaise(8_000),
  // Minutes from authorisation to a realistic fraud report with no
  // intervention. Four hours is a central estimate: some victims realise within
  // minutes, and victims of prolonged coercion typologies can take days.
  reportLagMinutes: 240,
  holdWindowMinutes: 30,
  attemptBudget: 2,
  // Delay between raising a freeze order and the receiving bank acting on it.
  freezeLatencyMinutes: 20,
  maxStepUpRate: null,
  maxFalsePositiveRate: null,
};

/** Inputs the cost model needs beyond the policy itself. */
export interface CostInputs {
  amountPaise: Paise;
  /** Calibrated probability the payment is fraudulent. */
  fraudProbability: number;
  /**
   * Recoverable fraction if this payment settles and is reported after the
   * policy report lag. Comes from the mule chain recoverability model.
   */
  recoveryAtReportLag: number;
}

/**
 * Expected unrecovered liability per rupee sent, if the payment settles.
 * Factored out because it appears in two of the three action costs and in both
 * threshold formulas.
 */
function liabilityPerPaise(recovery: number, policy: Policy): number {
  return (1 - clamp(recovery, 0, 1)) * policy.liabilityShare;
}

/** Expected cost of a single action, with its components retained for audit. */
export function costOfAction(
  action: Action,
  inputs: CostInputs,
  policy: Policy,
): CostBreakdown {
  const p = clamp(inputs.fraudProbability, 0, 1);
  const a = inputs.amountPaise;
  const perPaise = liabilityPerPaise(inputs.recoveryAtReportLag, policy);
  const clv = policy.customerLifetimeValuePaise;

  let liability = 0;
  let friction = 0;
  let abandonment = 0;

  switch (action) {
    case 'APPROVE':
      // Settles. Liability is whatever cannot be frozen by the time it is reported.
      liability = p * a * perPaise;
      friction = 0;
      abandonment = 0;
      break;

    case 'STEP_UP':
      // Only the payments the challenge fails to stop go on to settle.
      liability = p * (1 - policy.stepUpCatchRate) * a * perPaise;
      abandonment = policy.stepUpAbandonmentRate;
      // The handling cost is incurred on every held payment, fraudulent or not.
      // The abandonment cost is only incurred on the legitimate ones: a
      // fraudster giving up is the desired outcome, not a cost.
      friction = policy.stepUpFrictionPaise + (1 - p) * abandonment * clv;
      break;

    case 'BLOCK':
      // Nothing settles, so there is no compensation exposure.
      liability = 0;
      abandonment = policy.blockAbandonmentRate;
      friction = policy.blockFrictionPaise + (1 - p) * abandonment * clv;
      break;
  }

  return {
    action,
    expectedLiabilityPaise: Math.round(liability),
    expectedFrictionPaise: Math.round(friction),
    expectedTotalPaise: Math.round(liability + friction),
    exactTotalPaise: liability + friction,
    components: {
      fraudProbability: p,
      amountPaise: a,
      recoveryFraction: inputs.recoveryAtReportLag,
      liabilityShare: policy.liabilityShare,
      stepUpCatchRate: policy.stepUpCatchRate,
      abandonmentProbability: abandonment,
    },
  };
}

export const ACTIONS: readonly Action[] = ['APPROVE', 'STEP_UP', 'BLOCK'] as const;

export interface Decision {
  byAction: Record<Action, CostBreakdown>;
  chosen: Action;
  /** Expected-cost gap to the next-best action. A small margin is a close call. */
  marginPaise: Paise;
}

/** Cost every action and take the cheapest. */
export function decide(inputs: CostInputs, policy: Policy): Decision {
  const byAction = {
    APPROVE: costOfAction('APPROVE', inputs, policy),
    STEP_UP: costOfAction('STEP_UP', inputs, policy),
    BLOCK: costOfAction('BLOCK', inputs, policy),
  } satisfies Record<Action, CostBreakdown>;

  // Ranked on the exact totals, not the rounded ones, so that the executed
  // decision matches the analytically derived boundary exactly rather than to
  // within a paise. See CostBreakdown.exactTotalPaise.
  const ranked = [...ACTIONS].sort(
    (x, y) => byAction[x].exactTotalPaise - byAction[y].exactTotalPaise,
  );
  const chosen = ranked[0]!;
  const runnerUp = ranked[1]!;

  return {
    byAction,
    chosen,
    marginPaise: Math.round(
      byAction[runnerUp].exactTotalPaise - byAction[chosen].exactTotalPaise,
    ),
  };
}

// ---------------------------------------------------------------------------
// Decision boundaries in closed form
// ---------------------------------------------------------------------------

export interface Thresholds {
  /** Fraud probability at which holding becomes cheaper than approving. */
  approveToStepUp: number;
  /** Fraud probability at which blocking becomes cheaper than holding. */
  stepUpToBlock: number;
  /**
   * True when holding is never the cheapest action at any probability, so the
   * boundary collapses to a single approve/block cut. This happens when the
   * step-up challenge is weak or its friction is priced close to a block.
   */
  stepUpDominated: boolean;
}

/**
 * Solve for the decision boundaries analytically.
 *
 * Setting the expected costs of two actions equal and solving for p gives:
 *
 *   approve -> step-up:
 *     p1 = (F_su + a_su*CLV) / (A*L*c + a_su*CLV)
 *
 *   step-up -> block:
 *     p2 = (F_bl - F_su + (a_bl - a_su)*CLV)
 *          / ((1-c)*A*L + (a_bl - a_su)*CLV)
 *
 * where L is the unrecovered liability per paise and c is the step-up catch
 * rate. Both fall as the amount rises, which is the whole point: a two lakh
 * rupee payment is held at a far lower risk score than a five hundred rupee
 * one, because the downside is four hundred times larger while the friction is
 * identical.
 *
 * These are used to draw the decision surface in the policy interface. The
 * engine itself always decides by comparing costs directly, so the drawn
 * boundary and the executed decision cannot drift apart.
 */
export function thresholds(
  amountPaise: Paise,
  recoveryAtReportLag: number,
  policy: Policy,
): Thresholds {
  const perPaise = liabilityPerPaise(recoveryAtReportLag, policy);
  const exposure = amountPaise * perPaise;
  const clv = policy.customerLifetimeValuePaise;
  const c = clamp(policy.stepUpCatchRate, 0, 1);

  const abandonGapCost = (policy.blockAbandonmentRate - policy.stepUpAbandonmentRate) * clv;
  const stepUpAbandonCost = policy.stepUpAbandonmentRate * clv;

  const d1 = exposure * c + stepUpAbandonCost;
  const p1 = d1 > 0 ? (policy.stepUpFrictionPaise + stepUpAbandonCost) / d1 : 1;

  const d2 = exposure * (1 - c) + abandonGapCost;
  const n2 = policy.blockFrictionPaise - policy.stepUpFrictionPaise + abandonGapCost;
  const p2 = d2 > 0 ? n2 / d2 : 1;

  const a1 = clamp(p1, 0, 1);
  const a2 = clamp(p2, 0, 1);

  // If the block boundary sits at or below the hold boundary there is no band
  // in which holding wins, and the policy degenerates to approve or block.
  return {
    approveToStepUp: a1,
    stepUpToBlock: Math.max(a1, a2),
    stepUpDominated: a2 <= a1,
  };
}

/**
 * Amounts at which the boundary is evaluated when drawing the decision surface.
 * Logarithmically spaced from ten rupees to ten lakh, because that is how
 * payment values are distributed and a linear axis would spend most of its
 * width on amounts almost nobody sends.
 */
export function surfaceAmounts(steps = 60): Paise[] {
  const lo = Math.log(toPaise(10));
  const hi = Math.log(toPaise(1_000_000));
  return Array.from({ length: steps }, (_, i) =>
    Math.round(Math.exp(lo + ((hi - lo) * i) / (steps - 1))),
  );
}

/** The full decision surface, for the policy trade-off interface. */
export function decisionSurface(
  recoveryAtReportLag: number,
  policy: Policy,
  steps = 60,
): Array<{ amountPaise: Paise } & Thresholds> {
  return surfaceAmounts(steps).map((amountPaise) => ({
    amountPaise,
    ...thresholds(amountPaise, recoveryAtReportLag, policy),
  }));
}

/**
 * Liability avoided by intervening on a payment that really was fraudulent.
 *
 * This is the figure reported at portfolio level as compensation liability
 * avoided, and it is deliberately conservative. It counts only the value that
 * would have been unrecoverable had the payment settled and been reported after
 * the usual lag. Value that would have been frozen anyway is not claimed as a
 * saving, because claiming it would inflate the headline number with money that
 * was never actually at risk.
 */
export function liabilityAvoided(
  amountPaise: Paise,
  recoveryAtReportLag: number,
  policy: Policy,
  action: Action,
): Paise {
  if (action === 'APPROVE') return 0;
  const exposure = amountPaise * liabilityPerPaise(recoveryAtReportLag, policy);
  // A hold only avoids liability on the fraction of cases the challenge stops.
  const effectiveness = action === 'BLOCK' ? 1 : policy.stepUpCatchRate;
  return Math.round(exposure * effectiveness);
}
