import { ACTIONS, liabilityAvoided, wasStopped } from '@kreaton/core';
import type { Action, HoldRecord, HoldState, Paise, Policy, Typology } from '@kreaton/core';
import type { ReplayOutcome } from './replay.js';

/**
 * Portfolio risk and financial impact reporting.
 *
 * Reporting on a fraud control is an exercise in not flattering yourself, and
 * three conventions here exist for that reason:
 *
 *   Liability avoided counts only value that was genuinely at risk. When a
 *   fraudulent payment is stopped, the saving is not the amount of the payment.
 *   It is the portion that would still have been unrecoverable by the time the
 *   victim reported it, which at a four-hour lag is most but not all of it.
 *   Claiming the full amount would credit the system for money that would have
 *   been frozen anyway.
 *
 *   A hold is credited only for the share a challenge actually stops. Holding a
 *   fraudulent payment is not the same as preventing it; the payer can still
 *   confirm. The credit is scaled by the same catch rate the cost model uses,
 *   so the report and the decisions cannot disagree.
 *
 *   Friction is reported in the same units as the benefit. A system that
 *   prevents fifty lakh of liability by interrupting nine per cent of
 *   legitimate payments has not obviously succeeded, and a report that shows
 *   only the first number is not a report.
 */

export interface ActionBucket {
  count: number;
  valuePaise: Paise;
}

export interface TypologyPerformance {
  typology: Typology | 'unknown';
  count: number;
  valuePaise: Paise;
  interveneCount: number;
  interveneValuePaise: Paise;
  /** Share of this typology caught, by count. */
  detectionRate: number;
  /** Share of this typology caught, by value. */
  valueDetectionRate: number;
}

export interface PortfolioReport {
  generatedAt: string;
  windowFromMs: number;
  windowToMs: number;

  screened: ActionBucket;
  byAction: Record<Action, ActionBucket>;

  /** Ground-truth counts, available because this is an evaluation run. */
  truth: {
    fraudCount: number;
    fraudValuePaise: Paise;
    legitimateCount: number;
    legitimateValuePaise: Paise;
  };

  outcomes: {
    truePositives: number;
    falsePositives: number;
    trueNegatives: number;
    falseNegatives: number;
    /** Share of legitimate payments that were held or blocked. */
    falsePositiveRate: number;
    /** Interventions per thousand payments screened, the operational load figure. */
    frictionPerThousand: number;
    detectionRate: number;
    valueDetectionRate: number;
    precision: number;
  };

  holds: {
    opened: number;
    byState: Record<HoldState, number>;
    /** Held value that was released after successful re-confirmation. */
    releasedValuePaise: Paise;
    /** Held value that was stopped. */
    stoppedValuePaise: Paise;
    medianHoldMinutes: number;
  };

  financial: {
    /** Compensation liability avoided, net of what would have been recovered anyway. */
    liabilityAvoidedPaise: Paise;
    /** Liability still incurred on fraud that was approved. */
    residualLiabilityPaise: Paise;
    /** Operational and abandonment cost of every intervention. */
    frictionCostPaise: Paise;
    /** Liability avoided minus friction cost. */
    netBenefitPaise: Paise;
    /** Liability that would have been incurred with no interception at all. */
    unmitigatedLiabilityPaise: Paise;
  };

  byTypology: TypologyPerformance[];

  latency: {
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
}

function emptyBucket(): ActionBucket {
  return { count: 0, valuePaise: 0 };
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx]!;
}

export interface ReportOptions {
  outcomes: readonly ReplayOutcome[];
  holds: readonly HoldRecord[];
  policy: Policy;
  /** Recoverable fraction at the policy report lag, from the recovery model. */
  recoveryAtReportLag: number;
}

export function buildPortfolioReport(opts: ReportOptions): PortfolioReport {
  const { outcomes, holds, policy, recoveryAtReportLag } = opts;

  const byAction: Record<Action, ActionBucket> = {
    APPROVE: emptyBucket(),
    STEP_UP: emptyBucket(),
    BLOCK: emptyBucket(),
  };
  const screened = emptyBucket();

  let fraudCount = 0;
  let fraudValue = 0;
  let legitCount = 0;
  let legitValue = 0;
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let caughtValue = 0;
  let liabilityAvoidedTotal = 0;
  let residualLiability = 0;
  let unmitigatedLiability = 0;
  let frictionCost = 0;

  const typologyMap = new Map<string, TypologyPerformance>();
  const latencies: number[] = [];

  for (const o of outcomes) {
    screened.count += 1;
    screened.valuePaise += o.amountPaise;
    const action = o.assessment.decision;
    byAction[action].count += 1;
    byAction[action].valuePaise += o.amountPaise;
    latencies.push(o.assessment.latencyMs);

    const intervened = action !== 'APPROVE';

    // Friction is charged on every intervention, whether or not it was right.
    if (intervened) {
      const base =
        action === 'BLOCK' ? policy.blockFrictionPaise : policy.stepUpFrictionPaise;
      const abandon =
        action === 'BLOCK' ? policy.blockAbandonmentRate : policy.stepUpAbandonmentRate;
      frictionCost += base + (o.isFraud ? 0 : abandon * policy.customerLifetimeValuePaise);
    }

    if (o.isFraud) {
      fraudCount += 1;
      fraudValue += o.amountPaise;
      const exposure = Math.round(
        o.amountPaise * (1 - recoveryAtReportLag) * policy.liabilityShare,
      );
      unmitigatedLiability += exposure;

      if (intervened) {
        tp += 1;
        caughtValue += o.amountPaise;
        const avoided = liabilityAvoided(
          o.amountPaise,
          recoveryAtReportLag,
          policy,
          action,
        );
        liabilityAvoidedTotal += avoided;
        // A hold that fails to stop the payment still leaves exposure behind.
        residualLiability += exposure - avoided;
      } else {
        fn += 1;
        residualLiability += exposure;
      }

      const key = o.typology ?? 'unknown';
      const bucket =
        typologyMap.get(key) ??
        ({
          typology: key as Typology | 'unknown',
          count: 0,
          valuePaise: 0,
          interveneCount: 0,
          interveneValuePaise: 0,
          detectionRate: 0,
          valueDetectionRate: 0,
        } satisfies TypologyPerformance);
      bucket.count += 1;
      bucket.valuePaise += o.amountPaise;
      if (intervened) {
        bucket.interveneCount += 1;
        bucket.interveneValuePaise += o.amountPaise;
      }
      typologyMap.set(key, bucket);
    } else {
      legitCount += 1;
      legitValue += o.amountPaise;
      if (intervened) fp += 1;
      else tn += 1;
    }
  }

  const byState: Record<HoldState, number> = {
    SOFT_HOLD: 0,
    CHALLENGE_ISSUED: 0,
    CONFIRMED_RELEASED: 0,
    FAILED_BLOCKED: 0,
    EXPIRED_BLOCKED: 0,
    ESCALATED_REVIEW: 0,
    ABANDONED: 0,
  };
  let releasedValue = 0;
  let stoppedValue = 0;
  const holdDurations: number[] = [];
  for (const h of holds) {
    byState[h.state] += 1;
    if (h.state === 'CONFIRMED_RELEASED') releasedValue += h.amountPaise;
    else if (wasStopped(h)) stoppedValue += h.amountPaise;
    if (h.resolvedAtMs !== null) {
      holdDurations.push((h.resolvedAtMs - h.openedAtMs) / 60_000);
    }
  }
  holdDurations.sort((a, b) => a - b);
  latencies.sort((a, b) => a - b);

  const typologies = [...typologyMap.values()].map((t) => ({
    ...t,
    detectionRate: t.count > 0 ? t.interveneCount / t.count : 0,
    valueDetectionRate: t.valuePaise > 0 ? t.interveneValuePaise / t.valuePaise : 0,
  }));
  typologies.sort((a, b) => b.valuePaise - a.valuePaise);

  // Folded rather than spread. Math.min(...array) passes every element as an
  // argument, which overflows the call stack somewhere above a hundred thousand
  // entries, and a portfolio report over a real window is well past that.
  let windowFromMs = Number.POSITIVE_INFINITY;
  let windowToMs = Number.NEGATIVE_INFINITY;
  for (const o of outcomes) {
    if (o.ts < windowFromMs) windowFromMs = o.ts;
    if (o.ts > windowToMs) windowToMs = o.ts;
  }

  return {
    generatedAt: new Date().toISOString(),
    windowFromMs: outcomes.length > 0 ? windowFromMs : 0,
    windowToMs: outcomes.length > 0 ? windowToMs : 0,
    screened,
    byAction,
    truth: {
      fraudCount,
      fraudValuePaise: fraudValue,
      legitimateCount: legitCount,
      legitimateValuePaise: legitValue,
    },
    outcomes: {
      truePositives: tp,
      falsePositives: fp,
      trueNegatives: tn,
      falseNegatives: fn,
      falsePositiveRate: legitCount > 0 ? fp / legitCount : 0,
      frictionPerThousand: screened.count > 0 ? ((tp + fp) / screened.count) * 1000 : 0,
      detectionRate: fraudCount > 0 ? tp / fraudCount : 0,
      valueDetectionRate: fraudValue > 0 ? caughtValue / fraudValue : 0,
      precision: tp + fp > 0 ? tp / (tp + fp) : 0,
    },
    holds: {
      opened: holds.length,
      byState,
      releasedValuePaise: releasedValue,
      stoppedValuePaise: stoppedValue,
      medianHoldMinutes: percentile(holdDurations, 0.5),
    },
    financial: {
      liabilityAvoidedPaise: liabilityAvoidedTotal,
      residualLiabilityPaise: residualLiability,
      frictionCostPaise: Math.round(frictionCost),
      netBenefitPaise: Math.round(liabilityAvoidedTotal - frictionCost),
      unmitigatedLiabilityPaise: unmitigatedLiability,
    },
    byTypology: typologies,
    latency: {
      meanMs: latencies.reduce((a, b) => a + b, 0) / Math.max(latencies.length, 1),
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      p99Ms: percentile(latencies, 0.99),
      maxMs: latencies.length > 0 ? latencies[latencies.length - 1]! : 0,
    },
  };
}

/** Decision mix as shares, for the interface header. */
export function actionShares(report: PortfolioReport): Record<Action, number> {
  const total = Math.max(report.screened.count, 1);
  return Object.fromEntries(
    ACTIONS.map((a) => [a, report.byAction[a].count / total]),
  ) as Record<Action, number>;
}
