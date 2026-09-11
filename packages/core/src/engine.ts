import { decide } from './cost.js';
import { evaluateSignals, fuse, verifyAdditivity } from './fusion.js';
import { hashObject } from './hash.js';
import {
  expireIfDue,
  heldExposure,
  isOpen,
  openHold,
  registerAttempt,
  resolveHold,
  selectChallenge,
} from './hold.js';
import { heldMinutes, redactTransaction } from './ledger.js';
import { refreshPayeeWindow, updatePayeeProfile, updatePayerProfile } from './profiles.js';
import { RecoveryModel } from './recovery.js';
import type { HoldOutcome } from './hold.js';
import type { LedgerRecord } from './ledger.js';
import type { Store } from './store.js';
import type {
  Action,
  Assessment,
  HoldRecord,
  Millis,
  ModelSpec,
  Paise,
  Policy,
  ScoringContext,
  Transaction,
} from './types.js';

/**
 * The interceptor.
 *
 * One entry point, authorise, which takes an in-flight payment and returns a
 * decision together with everything needed to defend it. The ordering inside is
 * not incidental:
 *
 *   1. Resolve state as it stood before this payment.
 *   2. Age out anything that has expired.
 *   3. Attach the payment to an open hold if it is a re-attempt.
 *   4. Score, fuse, cost, decide.
 *   5. Apply protocol overrides.
 *   6. Seal the audit record.
 *   7. Only then fold the payment into the profiles.
 *
 * Step seven has to come last. If profiles were updated before scoring, every
 * transaction would be scored against a baseline that already contained it, and
 * every metric produced by this system would be optimistic in a way that no
 * amount of cross-validation would reveal.
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** Window of payer history made available to windowed signals. */
const STRUCTURING_WINDOW_MS = DAY_MS;

export interface InterceptorOptions {
  model: ModelSpec;
  policy: Policy;
  store: Store;
  /** Supplied so the recovery simulation is run once, not per transaction. */
  recovery?: RecoveryModel;
  /** Injected for deterministic hold identifiers in replays. */
  holdIdFactory?: (txn: Transaction) => string;
}

export interface AuthorizationResult {
  assessment: Assessment;
  /** The hold opened by this decision, if it was held. */
  hold?: HoldRecord;
  /** Set when this payment was attached to a hold that was already open. */
  linkedTo?: { holdId: string; disposition: string; explanation: string };
  /** Sequence number of the sealed assessment record. */
  ledgerSeq: number;
}

export class Interceptor {
  readonly store: Store;
  readonly recovery: RecoveryModel;
  private model: ModelSpec;
  private policy: Policy;
  private modelHash: string;
  private policyHash: string;
  private readonly holdIdFactory: (txn: Transaction) => string;
  private holdCounter = 0;

  constructor(opts: InterceptorOptions) {
    this.model = opts.model;
    this.policy = opts.policy;
    this.store = opts.store;
    this.modelHash = hashObject(opts.model);
    this.policyHash = hashObject(opts.policy);
    this.recovery =
      opts.recovery ??
      new RecoveryModel({
        params: opts.model.recovery,
        freezeLatencyMinutes: opts.policy.freezeLatencyMinutes,
      });
    this.holdIdFactory = opts.holdIdFactory ?? ((txn) => `hold_${txn.txnId}`);

    this.store.appendLedger(
      {
        kind: 'MODEL_LOADED',
        version: opts.model.version,
        modelHash: this.modelHash,
        fittedAt: opts.model.fittedAt,
      },
      Date.now(),
    );
  }

  get currentPolicy(): Policy {
    return this.policy;
  }

  get currentModel(): ModelSpec {
    return this.model;
  }

  get policyDigest(): string {
    return this.policyHash;
  }

  get modelDigest(): string {
    return this.modelHash;
  }

  /**
   * Replace the policy in force.
   *
   * Recorded in the ledger with both the before and after states, because a
   * decision can only be defended against the settings that were live when it
   * was taken, and those settings change.
   */
  setPolicy(next: Policy, changedBy: string, note = '', ts: Millis = Date.now()): void {
    const before = this.policy;
    this.policy = next;
    this.policyHash = hashObject(next);
    this.store.appendLedger(
      { kind: 'POLICY_CHANGED', before, after: next, changedBy, note },
      ts,
    );
  }

  /** Replace the fitted model. */
  setModel(next: ModelSpec, ts: Millis = Date.now()): void {
    this.model = next;
    this.modelHash = hashObject(next);
    this.store.appendLedger(
      { kind: 'MODEL_LOADED', version: next.version, modelHash: this.modelHash, fittedAt: next.fittedAt },
      ts,
    );
  }

  /** Expire any hold for this payer whose window has elapsed. */
  private ageHolds(payerId: string, now: Millis): HoldRecord[] {
    const holds = this.store.holdsForPayer(payerId);
    const aged: HoldRecord[] = [];
    for (const hold of holds) {
      const next = expireIfDue(hold, now);
      if (next !== hold) {
        this.store.putHold(next);
        this.store.appendLedger(
          {
            kind: 'HOLD_RESOLVED',
            holdId: next.holdId,
            txnId: next.txnId,
            state: next.state,
            detail: next.timeline[next.timeline.length - 1]?.detail ?? '',
            heldMinutes: heldMinutes(next, now),
          },
          now,
        );
        aged.push(next);
      } else {
        aged.push(hold);
      }
    }
    return aged;
  }

  /**
   * Evaluate an in-flight payment and decide what to do with it.
   *
   * Pure with respect to its inputs apart from the state it deliberately
   * advances: profiles, holds and the ledger.
   */
  authorize(txn: Transaction): AuthorizationResult {
    // performance.now gives sub-millisecond resolution. Date.now does not, and
    // an authorisation path that completes well inside a millisecond would
    // otherwise report a latency of zero for almost every transaction, which
    // makes the p95 and p99 figures meaningless.
    const started = performance.now();
    const now = txn.ts;

    // 1. State as it stood before this payment.
    const payer = this.store.ensurePayer(txn.payerId, txn.ts);
    const payeeStored = this.store.ensurePayee(txn.payeeId, txn.payeeVpa, txn.ts);
    const payee = refreshPayeeWindow(payeeStored, now);
    if (payee !== payeeStored) this.store.putPayee(payee);

    // 2. Age out expired holds before reading them.
    const holds = this.ageHolds(txn.payerId, now);
    const activeHolds = holds.filter(isOpen);

    // 3. Attach to an open hold if this is a re-attempt to the same beneficiary.
    let linkedTo: AuthorizationResult['linkedTo'];
    const openForPayee = activeHolds.find((h) => h.payeeId === txn.payeeId);
    if (openForPayee) {
      const outcome = registerAttempt(openForPayee, txn, now);
      if (outcome.disposition !== 'NOT_RELATED') {
        this.store.putHold(outcome.hold);
        this.store.appendLedger(
          {
            kind: 'ATTEMPT_LINKED',
            holdId: outcome.hold.holdId,
            txnId: txn.txnId,
            disposition: outcome.disposition,
            explanation: outcome.explanation,
          },
          now,
        );
        if (outcome.disposition === 'ESCALATED') {
          this.store.appendLedger(
            {
              kind: 'HOLD_RESOLVED',
              holdId: outcome.hold.holdId,
              txnId: outcome.hold.txnId,
              state: outcome.hold.state,
              detail: outcome.explanation,
              heldMinutes: heldMinutes(outcome.hold, now),
            },
            now,
          );
        }
        linkedTo = {
          holdId: outcome.hold.holdId,
          disposition: outcome.disposition,
          explanation: outcome.explanation,
        };
      }
    }

    // 4. Score, fuse, cost, decide.
    const ctx: ScoringContext = {
      payer,
      payee,
      recentPayerTxns: this.store.recentPayerTxns(txn.payerId, now - STRUCTURING_WINDOW_MS),
      // The structuring signal needs to see holds that are still open, including
      // one just escalated by this very attempt.
      activeHolds: this.store.holdsForPayer(txn.payerId).filter(isOpen),
      now,
    };

    const signals = evaluateSignals(txn, ctx, this.model);
    const fused = fuse(signals, this.model);
    const recovery = this.recovery.estimate(this.policy.reportLagMinutes);
    const economics = decide(
      {
        amountPaise: txn.amountPaise,
        fraudProbability: fused.calibratedP,
        recoveryAtReportLag: recovery.fractionAtHorizon,
      },
      this.policy,
    );

    // 5. Protocol overrides. Economics decides the ordinary case; the hold
    //    protocol takes precedence when letting the payment through would
    //    defeat a control that is already in force.
    let decision: Action = economics.chosen;
    let protocolOverride: Assessment['protocolOverride'];
    if (linkedTo?.disposition === 'ESCALATED') {
      if (decision !== 'BLOCK') {
        protocolOverride = {
          from: decision,
          to: 'BLOCK',
          reason: `Escalated to human review: ${linkedTo.explanation}`,
        };
        decision = 'BLOCK';
      }
    } else if (linkedTo?.disposition === 'LINKED_TO_HOLD' && decision === 'APPROVE') {
      protocolOverride = {
        from: 'APPROVE',
        to: 'STEP_UP',
        reason:
          'Re-attempt to a beneficiary with an open hold. The payment inherits the existing hold rather than being reassessed as an unrelated payment.',
      };
      decision = 'STEP_UP';
    }

    const assessment: Assessment = {
      txnId: txn.txnId,
      ts: txn.ts,
      amountPaise: txn.amountPaise,
      signals,
      priorLogOdds: fused.priorLogOdds,
      fusedLogOdds: fused.fusedLogOdds,
      calibratedP: fused.calibratedP,
      recovery,
      economics,
      decision,
      protocolOverride,
      reasonCodes: fused.reasonCodes,
      modelVersion: this.model.version,
      modelHash: this.modelHash,
      policyHash: this.policyHash,
      latencyMs: performance.now() - started,
    };

    // The explanation must reconstruct the score, or it is not an explanation.
    if (!verifyAdditivity(signals, fused.priorLogOdds, fused.fusedLogOdds)) {
      throw new Error(
        `Additivity violated for ${txn.txnId}: contributions do not reconstruct the fused score.`,
      );
    }

    // 6. Seal the record.
    const record: LedgerRecord = this.store.appendLedger(
      {
        kind: 'ASSESSMENT',
        txn: redactTransaction(txn),
        assessment,
        policy: this.policy,
      },
      now,
    );

    // Open a hold if the decision calls for one and none is already running.
    let hold: HoldRecord | undefined;
    if (decision === 'STEP_UP' && !openForPayee) {
      const choice = selectChallenge(txn);
      hold = openHold({
        holdId: this.holdIdFactory(txn) || `hold_${++this.holdCounter}`,
        txn,
        policy: this.policy,
        now,
      });
      this.store.putHold(hold);
      this.store.appendLedger(
        {
          kind: 'HOLD_OPENED',
          holdId: hold.holdId,
          txnId: txn.txnId,
          challengeType: choice.type,
          rationale: choice.rationale,
          disqualified: choice.disqualified,
          expiresAtMs: hold.expiresAtMs,
        },
        now,
      );
    } else if (openForPayee) {
      hold = this.store.getHold(openForPayee.holdId);
    }

    // 7. Fold into the profiles, last.
    this.store.putPayer(updatePayerProfile(payer, txn));
    this.store.putPayee(updatePayeeProfile(payee, txn));
    this.store.recordTransaction(txn);

    return { assessment, hold, linkedTo, ledgerSeq: record.seq };
  }

  /** Resolve an open hold and seal the outcome. */
  resolve(holdId: string, outcome: HoldOutcome, now: Millis = Date.now()): HoldRecord | undefined {
    const hold = this.store.getHold(holdId);
    if (!hold || !isOpen(hold)) return hold;
    const next = resolveHold(hold, outcome, now);
    this.store.putHold(next);
    this.store.appendLedger(
      {
        kind: 'HOLD_RESOLVED',
        holdId: next.holdId,
        txnId: next.txnId,
        state: next.state,
        detail: next.timeline[next.timeline.length - 1]?.detail ?? '',
        heldMinutes: heldMinutes(next, now),
      },
      now,
    );
    return next;
  }

  /** Total value this payer currently has held. */
  exposure(payerId: string): Paise {
    return heldExposure(this.store.holdsForPayer(payerId));
  }

  /** Sweep every open hold for expiry. Called by the demo clock, or a real scheduler. */
  sweepExpiries(now: Millis, payerIds: readonly string[]): HoldRecord[] {
    const expired: HoldRecord[] = [];
    for (const payerId of payerIds) {
      for (const hold of this.ageHolds(payerId, now)) {
        if (hold.state === 'EXPIRED_BLOCKED' && hold.resolvedAtMs === now) expired.push(hold);
      }
    }
    return expired;
  }
}

/** Minutes between two instants, for display. */
export function minutesBetween(a: Millis, b: Millis): number {
  return Math.abs(b - a) / MINUTE_MS;
}
