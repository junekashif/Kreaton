import { DEFAULT_POLICY, decide } from './cost.js';
import { hashObject } from './hash.js';
import { toPaise } from './money.js';
import type { Action, Paise, Policy } from './types.js';

/**
 * Policy trade-off management.
 *
 * The decision engine turns a policy into decision boundaries. This module is
 * the other direction: it turns an operational intent into a policy.
 *
 * Two ways to express intent are supported, because the two audiences that set
 * these numbers think about them differently. A risk officer reasons in costs
 * and liabilities, and wants to say what a held payment is worth. An operations
 * or conduct team reasons in rates, and wants to say that no more than a given
 * fraction of legitimate customers may be interrupted. Both are legitimate, and
 * a system that only supports the first is unusable by the second.
 */

export interface PolicyPreset {
  id: string;
  label: string;
  /** What stance this encodes, in the language of the person choosing it. */
  description: string;
  policy: Policy;
}

/**
 * Named stances.
 *
 * These are starting points for the trade-off interface, not recommendations.
 * Each one differs from the others only in the handful of parameters that
 * actually encode the trade-off; the recoverability and operational timings
 * stay constant, because those are estimates of how the world behaves rather
 * than choices about how to behave in it.
 */
export const POLICY_PRESETS: readonly PolicyPreset[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    description:
      'Prices friction and liability at their estimated operational values and lets the arithmetic decide. The default position.',
    policy: DEFAULT_POLICY,
  },
  {
    id: 'customer_first',
    label: 'Customer first',
    description:
      'Treats interrupting a legitimate payment as expensive. Fewer holds, fewer blocks, and materially more compensation liability accepted in exchange.',
    policy: {
      ...DEFAULT_POLICY,
      stepUpFrictionPaise: toPaise(180),
      blockFrictionPaise: toPaise(1_200),
      stepUpAbandonmentRate: 0.09,
      blockAbandonmentRate: 0.3,
      customerLifetimeValuePaise: toPaise(14_000),
    },
  },
  {
    id: 'liability_first',
    label: 'Liability first',
    description:
      'Treats compensation exposure as the dominant cost. Holds earlier and blocks sooner, accepting a higher interruption rate on legitimate payments.',
    policy: {
      ...DEFAULT_POLICY,
      stepUpFrictionPaise: toPaise(8),
      blockFrictionPaise: toPaise(90),
      stepUpAbandonmentRate: 0.02,
      blockAbandonmentRate: 0.1,
      customerLifetimeValuePaise: toPaise(5_000),
    },
  },
  {
    id: 'shared_liability',
    label: 'Shared liability',
    description:
      'Models a regime in which the sending institution bears half the unrecovered loss, as under a sending and receiving split. Everything else unchanged.',
    policy: { ...DEFAULT_POLICY, liabilityShare: 0.5 },
  },
  {
    id: 'weak_challenge',
    label: 'Weak step-up',
    description:
      'Stress case in which the re-confirmation factor is easily relayed by the fraudster. Shows how much of the value of holding depends on the challenge being genuinely out of band.',
    policy: { ...DEFAULT_POLICY, stepUpCatchRate: 0.25 },
  },
  {
    id: 'fast_reporting',
    label: 'Fast reporting',
    description:
      'Models a population that reports within the golden hour rather than after four hours, which raises recovery and lowers the liability of approving.',
    policy: { ...DEFAULT_POLICY, reportLagMinutes: 45 },
  },
] as const;

export function presetById(id: string): PolicyPreset | undefined {
  return POLICY_PRESETS.find((p) => p.id === id);
}

/** Stable digest of a policy, recorded alongside every decision it produced. */
export function policyDigest(policy: Policy): string {
  return hashObject(policy);
}

// ---------------------------------------------------------------------------
// Constraint solving
// ---------------------------------------------------------------------------

/** One scored payment, enough to replay the decision under a candidate policy. */
export interface PolicySample {
  amountPaise: Paise;
  /** Calibrated fraud probability from the fused score. */
  probability: number;
  /** Ground truth, available only in evaluation. */
  isFraud: boolean;
  recoveryAtReportLag: number;
}

export interface PolicyOutcomeRates {
  screened: number;
  stepUpRate: number;
  blockRate: number;
  /** Share of legitimate payments that were held or blocked. */
  falsePositiveRate: number;
  /** Share of fraudulent payments that were held or blocked. */
  detectionRate: number;
  /** Total expected cost over the sample, in paise. */
  expectedCostPaise: Paise;
  byAction: Record<Action, number>;
}

/** Replay a scored sample under a policy and summarise what it would do. */
export function evaluatePolicy(
  samples: readonly PolicySample[],
  policy: Policy,
): PolicyOutcomeRates {
  const byAction: Record<Action, number> = { APPROVE: 0, STEP_UP: 0, BLOCK: 0 };
  let legit = 0;
  let fraud = 0;
  let legitIntervened = 0;
  let fraudIntervened = 0;
  let cost = 0;

  for (const s of samples) {
    const d = decide(
      {
        amountPaise: s.amountPaise,
        fraudProbability: s.probability,
        recoveryAtReportLag: s.recoveryAtReportLag,
      },
      policy,
    );
    byAction[d.chosen] += 1;
    cost += d.byAction[d.chosen].exactTotalPaise;
    const intervened = d.chosen !== 'APPROVE';
    if (s.isFraud) {
      fraud += 1;
      if (intervened) fraudIntervened += 1;
    } else {
      legit += 1;
      if (intervened) legitIntervened += 1;
    }
  }

  const n = samples.length || 1;
  return {
    screened: samples.length,
    stepUpRate: byAction.STEP_UP / n,
    blockRate: byAction.BLOCK / n,
    falsePositiveRate: legit > 0 ? legitIntervened / legit : 0,
    detectionRate: fraud > 0 ? fraudIntervened / fraud : 0,
    expectedCostPaise: Math.round(cost),
    byAction,
  };
}

export interface ConstraintSolution {
  policy: Policy;
  /** Multiplier applied to both friction costs to satisfy the constraint. */
  frictionMultiplier: number;
  achieved: PolicyOutcomeRates;
  /** False when no multiplier in the search range satisfies the constraint. */
  satisfied: boolean;
  explanation: string;
}

const MULTIPLIER_LO = 1e-4;
const MULTIPLIER_HI = 1e6;
const BISECTION_STEPS = 48;

/**
 * Solve for a policy that meets a rate constraint.
 *
 * The lever is a single multiplier applied to both friction costs. Raising the
 * price of friction makes intervention less attractive everywhere at once,
 * which shifts both decision boundaries upward and reduces the intervention
 * rate. This is the Lagrangian form of the constrained problem: rather than
 * bolting a rate cap onto the side of the decision rule, the cap is expressed
 * as the shadow price of friction, and the engine keeps minimising expected
 * cost exactly as before.
 *
 * That matters for defensibility. A hard rate cap applied after the fact would
 * mean the system sometimes approves a payment it has just calculated to be the
 * expensive choice, and no audit record could explain that. Solving for the
 * price instead keeps every individual decision internally consistent with the
 * policy that produced it.
 *
 * Intervention rate is monotone decreasing in the multiplier, so bisection
 * converges.
 */
export function solveForConstraints(
  samples: readonly PolicySample[],
  basePolicy: Policy,
): ConstraintSolution {
  const capStepUp = basePolicy.maxStepUpRate;
  const capFpr = basePolicy.maxFalsePositiveRate;

  if (capStepUp === null && capFpr === null) {
    return {
      policy: basePolicy,
      frictionMultiplier: 1,
      achieved: evaluatePolicy(samples, basePolicy),
      satisfied: true,
      explanation: 'No rate constraint set; decisions follow expected cost directly.',
    };
  }

  const withMultiplier = (m: number): Policy => ({
    ...basePolicy,
    stepUpFrictionPaise: Math.round(basePolicy.stepUpFrictionPaise * m),
    blockFrictionPaise: Math.round(basePolicy.blockFrictionPaise * m),
  });

  const violates = (rates: PolicyOutcomeRates): boolean => {
    if (capStepUp !== null && rates.stepUpRate + rates.blockRate > capStepUp) return true;
    if (capFpr !== null && rates.falsePositiveRate > capFpr) return true;
    return false;
  };

  // If the unmodified policy already complies, leave it alone. Tightening a
  // policy that already meets its constraint would spend liability for nothing.
  const atBase = evaluatePolicy(samples, basePolicy);
  if (!violates(atBase)) {
    return {
      policy: basePolicy,
      frictionMultiplier: 1,
      achieved: atBase,
      satisfied: true,
      explanation:
        'The unconstrained economic policy already satisfies the configured rate ceiling, so no adjustment was applied.',
    };
  }

  let lo = 1;
  let hi = MULTIPLIER_HI;
  const atHi = evaluatePolicy(samples, withMultiplier(hi));
  if (violates(atHi)) {
    return {
      policy: withMultiplier(hi),
      frictionMultiplier: hi,
      achieved: atHi,
      satisfied: false,
      explanation:
        'No friction price within the search range satisfies the constraint. The constraint is tighter than the signal can deliver; loosen the ceiling or improve discrimination.',
    };
  }

  for (let i = 0; i < BISECTION_STEPS; i++) {
    const mid = Math.sqrt(lo * hi); // Geometric bisection: the scale is multiplicative.
    if (violates(evaluatePolicy(samples, withMultiplier(mid)))) lo = mid;
    else hi = mid;
  }

  const solved = withMultiplier(hi);
  const achieved = evaluatePolicy(samples, solved);
  const capText = [
    capStepUp !== null ? `intervention rate ${(capStepUp * 100).toFixed(2)}%` : null,
    capFpr !== null ? `false-positive rate ${(capFpr * 100).toFixed(2)}%` : null,
  ]
    .filter(Boolean)
    .join(' and ');

  return {
    policy: solved,
    frictionMultiplier: hi,
    achieved,
    satisfied: true,
    explanation:
      `Friction priced at ${hi.toFixed(2)}x its operational estimate to meet the configured ceiling on ${capText}. ` +
      'Expressed as a price rather than a cap so that every individual decision remains the cheapest option under the policy that produced it.',
  };
}

/** Search range for the lowest friction multiplier, used to draw the trade-off frontier. */
const FRONTIER_MULTIPLIERS: readonly number[] = [
  0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2.5, 4, 6, 10, 20, 50, 120, 300, 1000,
] as const;

export interface FrontierPoint {
  frictionMultiplier: number;
  falsePositiveRate: number;
  detectionRate: number;
  interventionRate: number;
  expectedCostPaise: Paise;
  liabilityAvoidedPaise: Paise;
}

/**
 * The achievable trade-off frontier.
 *
 * Sweeping the friction price traces out the set of operating points the system
 * can actually reach, which is the honest answer to the question of how much
 * fraud can be stopped at a given level of customer interruption. The
 * expected-cost minimum is one point on this curve, marked but not privileged:
 * an institution may rationally choose a different point for conduct reasons
 * the cost model does not price.
 */
export function tradeOffFrontier(
  samples: readonly PolicySample[],
  basePolicy: Policy,
): FrontierPoint[] {
  return FRONTIER_MULTIPLIERS.map((m) => {
    const policy: Policy = {
      ...basePolicy,
      stepUpFrictionPaise: Math.round(basePolicy.stepUpFrictionPaise * m),
      blockFrictionPaise: Math.round(basePolicy.blockFrictionPaise * m),
    };
    const rates = evaluatePolicy(samples, policy);

    let avoided = 0;
    for (const s of samples) {
      if (!s.isFraud) continue;
      const d = decide(
        {
          amountPaise: s.amountPaise,
          fraudProbability: s.probability,
          recoveryAtReportLag: s.recoveryAtReportLag,
        },
        policy,
      );
      if (d.chosen === 'APPROVE') continue;
      const exposure = s.amountPaise * (1 - s.recoveryAtReportLag) * policy.liabilityShare;
      avoided += exposure * (d.chosen === 'BLOCK' ? 1 : policy.stepUpCatchRate);
    }

    return {
      frictionMultiplier: m,
      falsePositiveRate: rates.falsePositiveRate,
      detectionRate: rates.detectionRate,
      interventionRate: rates.stepUpRate + rates.blockRate,
      expectedCostPaise: rates.expectedCostPaise,
      liabilityAvoidedPaise: Math.round(avoided),
    };
  });
}

/** Fields that differ between two policies, for the change record and the interface. */
export function policyDiff(a: Policy, b: Policy): Array<{ key: keyof Policy; from: unknown; to: unknown }> {
  const keys = Object.keys(a) as Array<keyof Policy>;
  return keys
    .filter((k) => a[k] !== b[k])
    .map((k) => ({ key: k, from: a[k], to: b[k] }));
}
