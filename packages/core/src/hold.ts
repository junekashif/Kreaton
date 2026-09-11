import { formatINR, toPaise } from './money.js';
import type {
  ChallengeType,
  HoldEvent,
  HoldRecord,
  HoldState,
  Millis,
  Paise,
  Policy,
  Transaction,
} from './types.js';

/**
 * Step-up friction protocol.
 *
 * A hold is not a delay. It is a request for a second, independent confirmation
 * from a channel the person coaching the victim does not control. The entire
 * value of the intervention rests on that independence, which is why challenge
 * selection is a function of the risk context rather than a fixed configuration
 * setting.
 *
 * The failure mode that defines this design: sending a one-time passcode to the
 * handset of a victim who is on the phone with the fraudster is not a control.
 * The fraudster simply says read me the code, and the victim, who is being told
 * they are speaking to their bank or to the police, reads it out. A step-up
 * that can be relayed by the person applying the pressure adds friction for
 * legitimate customers and stops almost nothing. So when a coercion indicator
 * is present, on-device passcodes are disqualified outright.
 *
 * The protocol also has to survive the payer trying again, because that is what
 * a coached victim is instructed to do when a payment does not go through. A
 * retry must not be treated as a fresh transaction with a fresh score, and
 * splitting the amount across two retries must not slip under the boundary that
 * caught the original. Both are handled here and in the structuring signal, and
 * both are scored in the adversarial evaluation.
 */

const MINUTE_MS = 60_000;

/** Amount above which a confirmation naming the beneficiary is preferred. */
const NAMED_PAYEE_AMOUNT_FLOOR: Paise = toPaise(10_000);

export interface ChallengeChoice {
  type: ChallengeType;
  /** Why this factor was chosen, recorded in the audit trail. */
  rationale: string;
  /** Factors ruled out, and the reason. Absence of a control is itself auditable. */
  disqualified: Array<{ type: ChallengeType; reason: string }>;
}

/**
 * Choose a step-up factor for the context the payment was authorised in.
 *
 * Ordering is by independence from whatever is currently influencing the payer,
 * not by convenience.
 */
export function selectChallenge(txn: Transaction): ChallengeChoice {
  const c = txn.context;
  const disqualified: ChallengeChoice['disqualified'] = [];

  const coerced = c.activeCall || c.screenShareActive || c.remoteAccessAppRunning;
  if (coerced) {
    disqualified.push({
      type: 'IN_APP_OTP',
      reason:
        'A concurrent call, screen share or remote-access session means an on-device code can be read out or observed by the party influencing the payer.',
    });
  }

  // The device itself is being watched or driven: nothing shown on it is private,
  // so the only safe control is time plus a cancellation route the payer can use
  // once they are alone.
  if (c.screenShareActive || c.remoteAccessAppRunning) {
    disqualified.push({
      type: 'DELAYED_BIOMETRIC',
      reason: 'Biometric confirmation happens on the same observed device.',
    });
    return {
      type: 'COOLING_PERIOD_SELF_CANCEL',
      rationale:
        'The screen is being observed or the device is being driven remotely, so no on-device factor is independent. The payment is held for a cooling period with a self-service cancellation the payer can use once the session ends.',
      disqualified,
    };
  }

  // On a call: defer the confirmation until after it ends, which both removes
  // the coach from the loop and gives the payer the pause the scam script is
  // designed to prevent.
  if (c.activeCall) {
    return {
      type: 'DELAYED_BIOMETRIC',
      rationale:
        'A call was in progress at authorisation. Confirmation is deferred until after the call ends, so the payer completes it without the other party present.',
      disqualified,
    };
  }

  // Unrecognised device or a fresh SIM: confirm through the registered channel
  // rather than the one making the request.
  if (c.isNewDevice || c.simChangedRecently) {
    return {
      type: 'BANK_INITIATED_CALLBACK',
      rationale:
        'The authorising device or SIM binding is new, so confirmation is taken on the registered contact channel rather than on the requesting device.',
      disqualified,
    };
  }

  // Larger payments to an unfamiliar beneficiary: the highest-value check is
  // simply showing the payer who they are actually paying. Impersonation
  // typologies collapse when the registered name is put in front of the victim.
  const firstTimePayee = c.beneficiaryAddedAtMs === null || c.vpaEnteredBy === 'pasted';
  if (txn.amountPaise >= NAMED_PAYEE_AMOUNT_FLOOR && firstTimePayee) {
    return {
      type: 'NAMED_PAYEE_CONFIRMATION',
      rationale:
        'A material amount to an unfamiliar beneficiary. The payer is shown the name registered to the receiving account and asked to confirm that is who they intend to pay.',
      disqualified,
    };
  }

  return {
    type: 'IN_APP_OTP',
    rationale:
      'No coercion indicators present and the device is established, so a standard in-app confirmation is proportionate.',
    disqualified,
  };
}

/** Human-readable text presented to the payer for a challenge. */
export function challengePrompt(type: ChallengeType, txn: Transaction): string {
  const amount = formatINR(txn.amountPaise);
  switch (type) {
    case 'NAMED_PAYEE_CONFIRMATION':
      return `This payment of ${amount} will reach an account registered to ${txn.payeeName}. Confirm that this is who you intend to pay.`;
    case 'DELAYED_BIOMETRIC':
      return `${amount} is on hold. Once your call has ended, confirm with your fingerprint or face to release it.`;
    case 'BANK_INITIATED_CALLBACK':
      return `${amount} is on hold. Expect a call on your registered number to confirm this payment. Nobody will ask you for a passcode.`;
    case 'COOLING_PERIOD_SELF_CANCEL':
      return `${amount} is held for review. It will not be sent yet. Cancel it at any time from your payment history.`;
    case 'IN_APP_OTP':
      return `Confirm ${amount} to ${txn.payeeName} in the app to release this payment.`;
  }
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/** States from which a hold can still change. */
const OPEN_STATES: ReadonlySet<HoldState> = new Set<HoldState>(['SOFT_HOLD', 'CHALLENGE_ISSUED']);

export function isOpen(hold: HoldRecord): boolean {
  return OPEN_STATES.has(hold.state);
}

/** Terminal states in which the payment did not go through. */
const BLOCKED_STATES: ReadonlySet<HoldState> = new Set<HoldState>([
  'FAILED_BLOCKED',
  'EXPIRED_BLOCKED',
  'ABANDONED',
]);

export function wasStopped(hold: HoldRecord): boolean {
  return BLOCKED_STATES.has(hold.state) || hold.state === 'ESCALATED_REVIEW';
}

function event(ts: Millis, state: HoldState, detail: string): HoldEvent {
  return { ts, state, detail };
}

export interface OpenHoldOptions {
  holdId: string;
  txn: Transaction;
  policy: Policy;
  now: Millis;
}

/** Open a soft hold and issue the chosen challenge. */
export function openHold({ holdId, txn, policy, now }: OpenHoldOptions): HoldRecord {
  const choice = selectChallenge(txn);
  const expiresAtMs = now + policy.holdWindowMinutes * MINUTE_MS;

  const timeline: HoldEvent[] = [
    event(
      now,
      'SOFT_HOLD',
      `Soft hold placed on ${formatINR(txn.amountPaise)} to ${txn.payeeName}. Funds not sent.`,
    ),
    event(now, 'CHALLENGE_ISSUED', `${choice.type}: ${choice.rationale}`),
  ];

  return {
    holdId,
    txnId: txn.txnId,
    payerId: txn.payerId,
    payeeId: txn.payeeId,
    amountPaise: txn.amountPaise,
    state: 'CHALLENGE_ISSUED',
    challengeType: choice.type,
    openedAtMs: now,
    expiresAtMs,
    attemptsUsed: 0,
    attemptBudget: policy.attemptBudget,
    linkedAttempts: [],
    timeline,
    resolvedAtMs: null,
  };
}

export type HoldOutcome =
  | { kind: 'confirmed' }
  | { kind: 'failed'; reason: string }
  | { kind: 'abandoned' }
  | { kind: 'expired' };

/** Apply a terminal outcome to an open hold. */
export function resolveHold(hold: HoldRecord, outcome: HoldOutcome, now: Millis): HoldRecord {
  if (!isOpen(hold)) return hold;

  const next: HoldState =
    outcome.kind === 'confirmed'
      ? 'CONFIRMED_RELEASED'
      : outcome.kind === 'failed'
        ? 'FAILED_BLOCKED'
        : outcome.kind === 'abandoned'
          ? 'ABANDONED'
          : 'EXPIRED_BLOCKED';

  const detail =
    outcome.kind === 'confirmed'
      ? `Re-confirmation passed via ${hold.challengeType}. Payment released.`
      : outcome.kind === 'failed'
        ? `Re-confirmation failed: ${outcome.reason}. Payment stopped.`
        : outcome.kind === 'abandoned'
          ? 'Payer abandoned the payment during the hold.'
          : `Hold expired after ${Math.round((now - hold.openedAtMs) / MINUTE_MS)} minutes without confirmation. Payment stopped.`;

  return {
    ...hold,
    state: next,
    resolvedAtMs: now,
    timeline: [...hold.timeline, event(now, next, detail)],
  };
}

/** Expire a hold whose window has elapsed. Returns it unchanged if still live. */
export function expireIfDue(hold: HoldRecord, now: Millis): HoldRecord {
  if (!isOpen(hold) || now < hold.expiresAtMs) return hold;
  return resolveHold(hold, { kind: 'expired' }, now);
}

export interface AttemptOutcome {
  hold: HoldRecord;
  /** What the interceptor should do with the re-attempt itself. */
  disposition: 'LINKED_TO_HOLD' | 'ESCALATED' | 'NOT_RELATED';
  explanation: string;
}

/**
 * Handle a further payment attempt while a hold is open.
 *
 * A coached victim is told to try again, so this is the common case rather than
 * an edge case. Three things must not happen:
 *
 *   - The retry must not be scored as a clean, unrelated transaction. It
 *     inherits the hold rather than starting over.
 *   - Repeated retries must not be free. Each consumes the attempt budget, and
 *     exhausting it escalates to human review rather than quietly continuing.
 *   - A retry from a different device during an open hold is not a retry. It is
 *     a material change in the risk picture and escalates immediately.
 */
export function registerAttempt(
  hold: HoldRecord,
  attempt: Transaction,
  now: Millis,
): AttemptOutcome {
  if (!isOpen(hold)) {
    return {
      hold,
      disposition: 'NOT_RELATED',
      explanation: 'Hold is already resolved; the attempt is evaluated independently.',
    };
  }

  if (attempt.payeeId !== hold.payeeId) {
    return {
      hold,
      disposition: 'NOT_RELATED',
      explanation: 'Attempt is to a different beneficiary and is evaluated on its own merits.',
    };
  }

  // A new device mid-hold changes the risk picture rather than continuing it.
  if (attempt.context.isNewDevice) {
    const escalated: HoldRecord = {
      ...hold,
      state: 'ESCALATED_REVIEW',
      resolvedAtMs: now,
      linkedAttempts: [...hold.linkedAttempts, attempt.txnId],
      timeline: [
        ...hold.timeline,
        event(
          now,
          'ESCALATED_REVIEW',
          'Re-attempt arrived from an unrecognised device while the hold was open. Escalated for human review.',
        ),
      ],
    };
    return {
      hold: escalated,
      disposition: 'ESCALATED',
      explanation: 'Re-attempt from a new device during an open hold.',
    };
  }

  const attemptsUsed = hold.attemptsUsed + 1;
  const linkedAttempts = [...hold.linkedAttempts, attempt.txnId];

  // Splitting the held value across smaller retries is the standard evasion.
  // The structuring signal scores it; the protocol refuses to reset for it.
  const isSplit = attempt.amountPaise < hold.amountPaise;

  if (attemptsUsed > hold.attemptBudget) {
    const escalated: HoldRecord = {
      ...hold,
      state: 'ESCALATED_REVIEW',
      attemptsUsed,
      linkedAttempts,
      resolvedAtMs: now,
      timeline: [
        ...hold.timeline,
        event(
          now,
          'ESCALATED_REVIEW',
          `Attempt budget of ${hold.attemptBudget} exhausted with ${attemptsUsed} attempts to the same beneficiary. Escalated for human review.`,
        ),
      ],
    };
    return {
      hold: escalated,
      disposition: 'ESCALATED',
      explanation: 'Attempt budget exhausted during an open hold.',
    };
  }

  const detail = isSplit
    ? `Re-attempt ${attemptsUsed} of ${hold.attemptBudget} for ${formatINR(attempt.amountPaise)}, a smaller amount to the same beneficiary already holding ${formatINR(hold.amountPaise)}. Linked to this hold; the original re-confirmation still stands.`
    : `Re-attempt ${attemptsUsed} of ${hold.attemptBudget} to the same beneficiary. Linked to this hold; the original re-confirmation still stands.`;

  return {
    hold: {
      ...hold,
      attemptsUsed,
      linkedAttempts,
      timeline: [...hold.timeline, event(now, hold.state, detail)],
    },
    disposition: 'LINKED_TO_HOLD',
    explanation: detail,
  };
}

/** Total value a payer currently has held, for exposure reporting. */
export function heldExposure(holds: readonly HoldRecord[]): Paise {
  return holds.filter(isOpen).reduce((sum, h) => sum + h.amountPaise, 0);
}
