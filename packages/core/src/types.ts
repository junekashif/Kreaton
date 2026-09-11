/**
 * Core domain types for the APP fraud interceptor.
 *
 * Money is represented exclusively as integer paise (1 INR = 100 paise).
 * Floating-point rupees are never used for value-bearing quantities; every
 * currency figure that reaches a report or a decision is an integer.
 */

/** Integer paise. 1 INR = 100 paise. */
export type Paise = number;

/** Epoch milliseconds. */
export type Millis = number;

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export type Channel = 'p2p' | 'p2m' | 'collect';

/** How the payee identifier reached the payment screen. */
export type VpaEntryMethod = 'typed' | 'pasted' | 'qr' | 'contact' | 'deeplink';

/**
 * Session and device context captured at authorisation time.
 *
 * These fields are the observable analogues of the social-engineering
 * fingerprint an APP scam leaves behind: the victim is usually on a call with
 * the fraudster, has just added the beneficiary, and is acting under time
 * pressure. See docs/MODELING.md for the typology mapping.
 */
export interface TxnContext {
  /** A voice call was in progress while the payment was authorised. */
  activeCall: boolean;
  /** Duration of that call at authorisation time, in seconds. */
  activeCallSeconds: number;
  /** Screen sharing was active (AnyDesk, TeamViewer, Meet screen share). */
  screenShareActive: boolean;
  /** A known remote-access application was running in the background. */
  remoteAccessAppRunning: boolean;
  /** Number of app switches during the session before authorisation. */
  appSwitchCount: number;
  /** Seconds from app open to authorisation. */
  secondsFromOpenToAuthorize: number;
  /** How the payee VPA got onto the screen. */
  vpaEnteredBy: VpaEntryMethod;
  /** When this beneficiary was added, or null if added in this session. */
  beneficiaryAddedAtMs: Millis | null;
  /** Opaque session identifier. */
  sessionId: string;
  /** Device is unrecognised for this payer. */
  isNewDevice: boolean;
  /** When the current device was bound to the account. */
  deviceBoundAtMs: Millis;
  /** SIM was swapped within the recent risk window. */
  simChangedRecently: boolean;
  /** Foreground application name, when observable. */
  foregroundApp?: string;
}

/** An in-flight UPI-style push payment awaiting an authorisation decision. */
export interface Transaction {
  txnId: string;
  ts: Millis;
  payerId: string;
  payerVpa: string;
  payeeId: string;
  payeeVpa: string;
  /** Beneficiary name as registered at the receiving PSP. */
  payeeName: string;
  amountPaise: Paise;
  channel: Channel;
  deviceId: string;
  ipHash: string;
  simSerialHash: string;
  /** Free-text UPI remark, when present. */
  note?: string;
  context: TxnContext;
}

/**
 * Ground-truth label, present only in generated or historical corpora.
 * Never available at decision time.
 */
export interface TxnLabel {
  isFraud: boolean;
  /** Scam typology, for fraudulent transactions. */
  typology?: Typology;
  /** Identifier of the mule chain the funds entered. */
  chainId?: string;
}

export type Typology =
  | 'digital_arrest'
  | 'kyc_update'
  | 'investment_trading'
  | 'job_task'
  | 'refund_reversal'
  | 'romance'
  | 'purchase_marketplace'
  | 'impersonation_known_person';

export interface LabelledTransaction extends Transaction {
  label: TxnLabel;
}

// ---------------------------------------------------------------------------
// Behavioural profiles
// ---------------------------------------------------------------------------

/**
 * A payer rolling behavioural baseline.
 *
 * Amount statistics are kept in log space with robust estimators (median and
 * median absolute deviation) because UPI amount distributions are heavy-tailed
 * and a mean/sigma baseline is trivially poisoned by a single large legitimate
 * payment, which is itself an attack (see the baseline-building adversary).
 */
export interface PayerProfile {
  payerId: string;
  firstSeenMs: Millis;
  /** Most recent transaction time folded into this profile. */
  lastSeenMs: Millis;
  txnCount: number;
  /** Median of ln(amountPaise). Derived from recentLogAmounts. */
  logAmountMedian: number;
  /** Median absolute deviation of ln(amountPaise). Derived from recentLogAmounts. */
  logAmountMad: number;
  maxAmountPaise: Paise;
  /** Normalised 24-bin hour-of-day histogram, sums to 1. Derived from hourCounts. */
  hourHistogram: number[];
  /** Payee ids this payer has previously paid, with first-payment time. */
  knownPayees: Record<string, Millis>;
  /** Device ids seen for this payer, with first-seen time. */
  knownDevices: Record<string, Millis>;
  /** Mean transactions per active day. */
  dailyCountMean: number;
  /** Standard deviation of transactions per active day. */
  dailyCountSd: number;
  /** Mean value moved per active day. */
  dailyValueMean: Paise;
  /**
   * Proxy for available balance, used by the drain-ratio signal.
   * Estimated as a multiple of observed spend, not a real balance read.
   */
  balanceProxyPaise: Paise;

  // --- Incremental maintenance state -------------------------------------
  // These back the derived statistics above. They are bounded rather than
  // unbounded so that a profile stays a fixed size regardless of how long a
  // customer has been active, which is what makes per-payer state affordable
  // at portfolio scale.

  /** Log amounts of recent transactions, capped at PROFILE_AMOUNT_WINDOW. */
  recentLogAmounts: number[];
  /** Raw 24-bin hour-of-day counts. */
  hourCounts: number[];
  /** Transactions per calendar day in IST, capped at PROFILE_DAY_WINDOW days. */
  dailyCounts: Record<string, number>;
  /** Lifetime value moved, for the daily-value baseline. */
  totalValuePaise: Paise;
}

/**
 * A payee inbound-side profile. Mule accounts have a characteristic
 * signature: many unrelated payers, a short account life, and funds that leave
 * almost as fast as they arrive.
 */
export interface PayeeProfile {
  payeeId: string;
  payeeVpa: string;
  firstSeenMs: Millis;
  /** Distinct payers in the trailing 24 hours. */
  distinctPayers24h: number;
  /** Distinct payers over the full observation window. */
  distinctPayersAllTime: number;
  inboundCount24h: number;
  inboundValue24h: Paise;
  /**
   * Fraction of inbound value moved onward within one hour.
   *
   * A sending institution cannot observe the beneficiary outbound leg from its
   * own books. This is therefore a supplied attribute, standing in for
   * beneficiary-side intelligence of the kind a central infrastructure or an
   * inter-institution sharing arrangement can provide. docs/MODELING.md states
   * this dependency explicitly, because a deployment without such a feed would
   * lose most of the discriminating power of the fan-in signal.
   */
  outboundVelocityRatio: number;
  /** Confirmed mule per investigation outcome or reported-fraud linkage. */
  confirmedMule: boolean;
  /** Hops to the nearest confirmed mule in the payee graph; null if unreachable. */
  muleHopDistance: number | null;
  /** Times the registered name attached to this VPA has changed. */
  nameChurnCount: number;

  // --- Incremental maintenance state -------------------------------------

  /** Recent inbound payments, capped at PAYEE_WINDOW_HOURS, for fan-in counting. */
  inboundWindow: Array<{ payerId: string; ts: Millis; amountPaise: Paise }>;
}

/** Everything the engine needs to score a transaction, resolved by the store. */
export interface ScoringContext {
  payer: PayerProfile;
  payee: PayeeProfile;
  /** Payer transactions in the trailing structuring window, most recent first. */
  recentPayerTxns: Transaction[];
  /** Active holds for this payer, used for hold-aware re-attempt detection. */
  activeHolds: HoldRecord[];
  /** Evaluation time, injected so replays are deterministic. */
  now: Millis;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export type SignalId =
  | 'PAYEE_NOVELTY'
  | 'AMOUNT_DEVIATION'
  | 'TEMPORAL_ANOMALY'
  | 'DEVICE_DRIFT'
  | 'PAYEE_FAN_IN'
  | 'PAYEE_ACCOUNT_AGE'
  | 'CALL_CONCURRENCY'
  | 'SESSION_URGENCY'
  | 'STRUCTURING'
  | 'VELOCITY_BURST'
  | 'DRAIN_RATIO'
  | 'MULE_PROXIMITY';

/**
 * Signals are grouped so that correlated evidence can be shrunk as a block.
 * Without this, four correlated behavioural signals firing together would
 * contribute four independent log-likelihood ratios and badly overstate the
 * evidence. See fusion.ts.
 */
export type SignalGroup =
  | 'identity_device'
  | 'behavioural'
  | 'payee_graph'
  | 'context'
  | 'structuring';

/** One signal evaluation against a single transaction. */
export interface SignalResult {
  id: SignalId;
  group: SignalGroup;
  /** The raw measured statistic, in the signal own natural units. */
  raw: number;
  /** Discretised bin index used for the weight-of-evidence lookup. */
  bin: number;
  /** True when the signal is in an evidentially elevated bin. */
  fired: boolean;
  /** Log-likelihood ratio ln( P(bin|fraud) / P(bin|legitimate) ). */
  llr: number;
  /** Per-signal weight from the fitted model. */
  weight: number;
  /** Group correlation shrinkage applied to this signal. */
  shrinkage: number;
  /** weight x shrinkage x llr. Exactly additive in log-odds. */
  contribution: number;
  /** Human-readable statement of what was measured. */
  evidence: string;
  /** Stable regulator-facing reason code. */
  reasonCode: string;
}

/** Static description of a signal, used for documentation and the model card. */
export interface SignalSpec {
  id: SignalId;
  group: SignalGroup;
  label: string;
  /** What the signal measures, in one sentence. */
  description: string;
  /** Why it discriminates APP fraud, with its typology grounding. */
  rationale: string;
  /** Units of the raw statistic. */
  unit: string;
  /** Upper bin edges; values above the last edge fall in the final bin. */
  binEdges: number[];
  reasonCodePrefix: string;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type Action = 'APPROVE' | 'STEP_UP' | 'BLOCK';

/** Expected-cost breakdown for one candidate action, all figures in paise. */
export interface CostBreakdown {
  action: Action;
  /** Expected unrecovered loss borne by the PSP under this action. */
  expectedLiabilityPaise: Paise;
  /** Expected friction cost imposed on the customer and operations. */
  expectedFrictionPaise: Paise;
  /** Sum of the two, rounded. This is the figure reported and audited. */
  expectedTotalPaise: Paise;
  /**
   * Unrounded sum, used for ranking only.
   *
   * Within a fraction of a paise of a decision boundary the rounded totals of
   * two actions tie, and a tie would be broken by array order rather than by
   * economics. Ranking on the exact value keeps the executed decision identical
   * to the closed-form boundary that the policy interface draws.
   */
  exactTotalPaise: number;
  /** Components, retained for the audit trail. */
  components: {
    fraudProbability: number;
    amountPaise: Paise;
    recoveryFraction: number;
    liabilityShare: number;
    stepUpCatchRate: number;
    abandonmentProbability: number;
  };
}

export interface RecoveryEstimate {
  /** Fraction of value expected to remain freezable at the reference horizon. */
  fractionAtHorizon: number;
  /** Horizon used, in minutes from the moment funds land. */
  horizonMinutes: number;
  /** Recovery curve sampled over time, for display and audit. */
  curve: Array<{ minutes: number; recoverable: number }>;
  /** Expected number of mule hops before cash-out. */
  expectedHops: number;
  /** Which estimator produced fractionAtHorizon. */
  method: 'ctmc_closed_form' | 'monte_carlo';
  /** 95% interval from the Monte Carlo estimator, when available. */
  interval?: { lo: number; hi: number };
}

/** The complete, auditable output of one authorisation decision. */
export interface Assessment {
  txnId: string;
  ts: Millis;
  amountPaise: Paise;
  signals: SignalResult[];
  /** Log-odds of the population base rate before any signal is applied. */
  priorLogOdds: number;
  /** priorLogOdds plus the sum of signal contributions. */
  fusedLogOdds: number;
  /** Calibrated P(fraud given signals), after isotonic mapping. */
  calibratedP: number;
  recovery: RecoveryEstimate;
  economics: {
    byAction: Record<Action, CostBreakdown>;
    chosen: Action;
    /** Expected-cost gap to the runner-up action, in paise. */
    marginPaise: Paise;
  };
  decision: Action;
  /**
   * Set when the hold protocol overrode the economically cheapest action.
   *
   * A re-attempt against an open hold cannot be allowed to proceed just because
   * its own expected cost happens to be low; that would let a payer defeat a
   * hold by simply trying again. The override and its reason are recorded so
   * the audit trail shows both what the economics said and why the protocol
   * took precedence.
   */
  protocolOverride?: { from: Action; to: Action; reason: string };
  /** Reason codes for every fired signal, most influential first. */
  reasonCodes: string[];
  modelVersion: string;
  modelHash: string;
  policyHash: string;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

export type HoldState =
  | 'SOFT_HOLD'
  | 'CHALLENGE_ISSUED'
  | 'CONFIRMED_RELEASED'
  | 'FAILED_BLOCKED'
  | 'EXPIRED_BLOCKED'
  | 'ESCALATED_REVIEW'
  | 'ABANDONED';

/**
 * Step-up factor types. Selection is constrained by context: an SMS or in-app
 * OTP is disqualified while a call is in progress, because the fraudster is on
 * the line and will simply ask the victim to read it out.
 */
export type ChallengeType =
  | 'DELAYED_BIOMETRIC'
  | 'BANK_INITIATED_CALLBACK'
  | 'NAMED_PAYEE_CONFIRMATION'
  | 'COOLING_PERIOD_SELF_CANCEL'
  | 'IN_APP_OTP';

export interface HoldEvent {
  ts: Millis;
  state: HoldState;
  detail: string;
}

export interface HoldRecord {
  holdId: string;
  txnId: string;
  payerId: string;
  payeeId: string;
  amountPaise: Paise;
  state: HoldState;
  challengeType: ChallengeType;
  openedAtMs: Millis;
  expiresAtMs: Millis;
  /** Re-confirmation attempts consumed. */
  attemptsUsed: number;
  attemptBudget: number;
  /** Transaction ids linked to this hold as re-attempts. */
  linkedAttempts: string[];
  timeline: HoldEvent[];
  resolvedAtMs: Millis | null;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Every tunable in one place. The policy is hashed into each assessment so an
 * auditor can prove which trade-off settings produced a given decision.
 */
export interface Policy {
  /** Share of unrecovered loss borne by the PSP. 1.0 means full reimbursement. */
  liabilityShare: number;
  /** Probability a step-up challenge stops a genuine fraud. */
  stepUpCatchRate: number;
  /** Operational friction cost of holding one payment, in paise. */
  stepUpFrictionPaise: Paise;
  /** Operational friction cost of blocking one payment, in paise. */
  blockFrictionPaise: Paise;
  /** Probability a legitimate customer abandons after a step-up. */
  stepUpAbandonmentRate: number;
  /** Probability a legitimate customer abandons after a block. */
  blockAbandonmentRate: number;
  /** Customer lifetime margin at risk on abandonment, in paise. */
  customerLifetimeValuePaise: Paise;
  /** Minutes from authorisation to realistic fraud report, absent intervention. */
  reportLagMinutes: number;
  /** Minutes a soft hold stays open before expiring. */
  holdWindowMinutes: number;
  /** Re-confirmation attempts allowed per hold. */
  attemptBudget: number;
  /** Operational latency between freeze order and bank action, in minutes. */
  freezeLatencyMinutes: number;
  /** Optional ceiling on the step-up rate, enforced by threshold search. */
  maxStepUpRate: number | null;
  /** Optional ceiling on the false-positive rate, enforced by threshold search. */
  maxFalsePositiveRate: number | null;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Per-bin weight-of-evidence table for one signal. */
export interface SignalWoe {
  id: SignalId;
  /** ln( P(bin|fraud) / P(bin|legit) ) per bin, Laplace-smoothed. */
  llrByBin: number[];
  /** Count of fraudulent training rows per bin, for the model card. */
  fraudCountByBin: number[];
  /** Count of legitimate training rows per bin. */
  legitCountByBin: number[];
  /** Fitted weight. */
  weight: number;
  /** Index of the lowest bin considered evidentially elevated. */
  firedFromBin: number;
}

/** Recoverability model parameters, per mule layer. */
export interface RecoveryParams {
  /** Mean dwell time in each layer before funds move on, in minutes. */
  layerDwellMinutes: number[];
  /** Probability funds hop onward rather than cash out, per layer. */
  hopProbability: number[];
  /**
   * Probability a freeze order actually reaches funds resting at each depth
   * within the operational window. Funds still inside the chain are only
   * nominally freezable: every hop adds an institution to trace and a fan-out
   * of accounts to serve, so reachability falls steeply with depth.
   */
  traceabilityByLayer: number[];
  /** Lognormal shape parameter for dwell time in the Monte Carlo estimator. */
  dwellSigma: number;
  /** Mean fan-out branches per hop. */
  meanFanOut: number;
  /** Maximum layers modelled before funds are treated as unrecoverable. */
  maxLayers: number;
}

/** A fitted, versioned model. Serialised to model.json and hashed. */
export interface ModelSpec {
  version: string;
  /** ISO date the model was fitted. */
  fittedAt: string;
  /** Population fraud base rate used as the prior. */
  baseRate: number;
  signals: SignalWoe[];
  /** Correlation shrinkage factor per signal group. */
  groupShrinkage: Record<SignalGroup, number>;
  /**
   * Asymmetric treatment of evidence from signals an attacker controls.
   *
   * A fitted model learns that scam payments almost always coincide with a
   * call, urgency and a pasted identifier. The arithmetic consequence is that
   * the *absence* of those becomes strong evidence of innocence, and absence is
   * exactly what an attacker can manufacture for free by changing the script:
   * end the call before authorising, use the saved payee, take your time. The
   * model then actively argues in favour of the payment.
   *
   * The asymmetry is deliberate and is a security property rather than a
   * statistical one. Presence of an attacker-controllable indicator is
   * informative, because producing it costs the attacker something. Absence is
   * not equally informative, because producing it costs nothing. So the total
   * negative evidence a controllable group may contribute is floored, while its
   * positive contribution is left untouched.
   */
  asymmetricEvidence: {
    /** Groups an attacker can suppress at will. */
    cappedGroups: SignalGroup[];
    /** Most negative total log-odds such a group may contribute, in nats. */
    negativeFloor: number;
  };
  /** Isotonic calibration map: sorted (rawLogOdds, calibratedProbability) knots. */
  calibration: Array<{ x: number; y: number }>;
  recovery: RecoveryParams;
  /** Held-out discrimination metrics, reproduced in the model card. */
  metrics: {
    rocAuc: number;
    prAuc: number;
    ks: number;
    brier: number;
    ece: number;
    recallAt1PctFpr: number;
    trainRows: number;
    testRows: number;
  };
}
