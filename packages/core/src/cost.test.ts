import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  DEFAULT_POLICY,
  costOfAction,
  decide,
  decisionSurface,
  liabilityAvoided,
  thresholds,
} from './cost.js';
import { toPaise } from './money.js';
import type { Policy } from './types.js';

const RECOVERY = 0.0687; // Recoverable fraction at the default four-hour report lag.

function at(amountRupees: number, p: number, policy: Policy = DEFAULT_POLICY) {
  return decide(
    {
      amountPaise: toPaise(amountRupees),
      fraudProbability: p,
      recoveryAtReportLag: RECOVERY,
    },
    policy,
  );
}

describe('cost of each action', () => {
  it('charges no liability and no friction for approving', () => {
    const c = costOfAction(
      'APPROVE',
      { amountPaise: toPaise(50_000), fraudProbability: 0, recoveryAtReportLag: RECOVERY },
      DEFAULT_POLICY,
    );
    expect(c.expectedTotalPaise).toBe(0);
  });

  it('charges no liability for blocking, because nothing settles', () => {
    const c = costOfAction(
      'BLOCK',
      { amountPaise: toPaise(500_000), fraudProbability: 1, recoveryAtReportLag: RECOVERY },
      DEFAULT_POLICY,
    );
    expect(c.expectedLiabilityPaise).toBe(0);
  });

  it('charges block friction without abandonment when the payment is certainly fraud', () => {
    // A fraudster abandoning is the goal, not a cost, so only the handling cost applies.
    const c = costOfAction(
      'BLOCK',
      { amountPaise: toPaise(500_000), fraudProbability: 1, recoveryAtReportLag: RECOVERY },
      DEFAULT_POLICY,
    );
    expect(c.expectedFrictionPaise).toBe(DEFAULT_POLICY.blockFrictionPaise);
  });

  it('leaves residual liability on a step-up, because challenges are not perfect', () => {
    const c = costOfAction(
      'STEP_UP',
      { amountPaise: toPaise(100_000), fraudProbability: 1, recoveryAtReportLag: RECOVERY },
      DEFAULT_POLICY,
    );
    expect(c.expectedLiabilityPaise).toBeGreaterThan(0);
    const approve = costOfAction(
      'APPROVE',
      { amountPaise: toPaise(100_000), fraudProbability: 1, recoveryAtReportLag: RECOVERY },
      DEFAULT_POLICY,
    );
    // It must still be a large improvement on doing nothing.
    expect(c.expectedLiabilityPaise).toBeLessThan(approve.expectedLiabilityPaise * 0.4);
  });

  it('reports totals as integer paise', () => {
    for (const action of ACTIONS) {
      const c = costOfAction(
        action,
        { amountPaise: 123_457, fraudProbability: 0.137, recoveryAtReportLag: RECOVERY },
        DEFAULT_POLICY,
      );
      expect(Number.isInteger(c.expectedTotalPaise)).toBe(true);
      expect(Number.isInteger(c.expectedLiabilityPaise)).toBe(true);
      expect(Number.isInteger(c.expectedFrictionPaise)).toBe(true);
    }
  });
});

describe('decision', () => {
  it('approves a small payment at low risk', () => {
    expect(at(500, 0.01).chosen).toBe('APPROVE');
  });

  it('blocks a large payment at high risk', () => {
    expect(at(200_000, 0.9).chosen).toBe('BLOCK');
  });

  it('is monotone in risk: raising p never makes the action less severe', () => {
    const severity = { APPROVE: 0, STEP_UP: 1, BLOCK: 2 } as const;
    for (const amount of [100, 2_000, 25_000, 200_000]) {
      let previous = -1;
      for (let p = 0; p <= 1.0001; p += 0.01) {
        const s = severity[at(amount, Math.min(p, 1)).chosen];
        expect(s).toBeGreaterThanOrEqual(previous);
        previous = s;
      }
    }
  });

  it('is monotone in amount: the same risk on more money never de-escalates', () => {
    const severity = { APPROVE: 0, STEP_UP: 1, BLOCK: 2 } as const;
    let previous = -1;
    for (const amount of [50, 200, 1_000, 5_000, 20_000, 80_000, 300_000, 1_000_000]) {
      const s = severity[at(amount, 0.05).chosen];
      expect(s).toBeGreaterThanOrEqual(previous);
      previous = s;
    }
  });

  it('reports a non-negative margin to the runner-up action', () => {
    expect(at(25_000, 0.2).marginPaise).toBeGreaterThanOrEqual(0);
  });
});

describe('closed-form thresholds', () => {
  it('agree with the action the engine actually chooses', () => {
    // This is the invariant that keeps the drawn decision surface honest: the
    // boundary shown to the user must be the boundary the engine executes.
    for (const rupees of [100, 1_000, 10_000, 50_000, 200_000, 900_000]) {
      const t = thresholds(toPaise(rupees), RECOVERY, DEFAULT_POLICY);
      const eps = 1e-6;

      if (t.approveToStepUp > eps && t.approveToStepUp < 1 - eps) {
        expect(at(rupees, t.approveToStepUp - eps).chosen).toBe('APPROVE');
        if (!t.stepUpDominated) {
          expect(at(rupees, t.approveToStepUp + eps).chosen).toBe('STEP_UP');
        }
      }
      if (!t.stepUpDominated && t.stepUpToBlock > eps && t.stepUpToBlock < 1 - eps) {
        expect(at(rupees, t.stepUpToBlock - eps).chosen).toBe('STEP_UP');
        expect(at(rupees, t.stepUpToBlock + eps).chosen).toBe('BLOCK');
      }
    }
  });

  it('falls as the amount rises, which is the point of the whole model', () => {
    const small = thresholds(toPaise(500), RECOVERY, DEFAULT_POLICY);
    const large = thresholds(toPaise(200_000), RECOVERY, DEFAULT_POLICY);
    expect(large.approveToStepUp).toBeLessThan(small.approveToStepUp);
    expect(large.approveToStepUp).toBeLessThan(0.01);
    expect(small.approveToStepUp).toBeGreaterThan(0.3);
  });

  it('holds more readily when recovery is poor', () => {
    const goodRecovery = thresholds(toPaise(50_000), 0.9, DEFAULT_POLICY);
    const poorRecovery = thresholds(toPaise(50_000), 0.02, DEFAULT_POLICY);
    expect(poorRecovery.approveToStepUp).toBeLessThan(goodRecovery.approveToStepUp);
  });

  it('collapses the hold band when the challenge is useless', () => {
    // With a catch rate of zero, a hold costs friction and prevents nothing, so
    // there can be no band of probabilities in which it is the cheapest action.
    const useless: Policy = { ...DEFAULT_POLICY, stepUpCatchRate: 0 };
    const t = thresholds(toPaise(100_000), RECOVERY, useless);
    expect(t.stepUpDominated).toBe(true);
    for (const p of [0.05, 0.2, 0.5, 0.9]) {
      expect(at(100_000, p, useless).chosen).not.toBe('STEP_UP');
    }
  });

  it('produces a surface that is monotone decreasing in amount', () => {
    const surface = decisionSurface(RECOVERY, DEFAULT_POLICY, 40);
    for (let i = 1; i < surface.length; i++) {
      expect(surface[i]!.approveToStepUp).toBeLessThanOrEqual(
        surface[i - 1]!.approveToStepUp + 1e-12,
      );
    }
  });
});

describe('liability avoided', () => {
  it('credits nothing for approving', () => {
    expect(liabilityAvoided(toPaise(100_000), RECOVERY, DEFAULT_POLICY, 'APPROVE')).toBe(0);
  });

  it('credits a hold only for the share the challenge actually stops', () => {
    const block = liabilityAvoided(toPaise(100_000), RECOVERY, DEFAULT_POLICY, 'BLOCK');
    const stepUp = liabilityAvoided(toPaise(100_000), RECOVERY, DEFAULT_POLICY, 'STEP_UP');
    expect(stepUp).toBeCloseTo(block * DEFAULT_POLICY.stepUpCatchRate, -1);
  });

  it('never claims value that would have been frozen anyway', () => {
    // With perfect recovery there is nothing at risk, so nothing can be avoided.
    expect(liabilityAvoided(toPaise(100_000), 1, DEFAULT_POLICY, 'BLOCK')).toBe(0);
  });
});
