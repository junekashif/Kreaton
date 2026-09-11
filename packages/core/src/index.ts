/**
 * @kreaton/core
 *
 * The APP fraud interception engine: signals, score fusion, mule chain
 * recoverability, expected-cost decisioning, the step-up hold protocol and the
 * hash-chained audit trail.
 *
 * The package has no dependencies and no platform assumptions, so the same
 * compiled code runs in a browser tab, in a server route handler and in the
 * test runner. That is what lets the live console and the production
 * authorisation endpoint be provably the same engine rather than two
 * implementations that are supposed to agree.
 */

export * from './types.js';

export { PAISE_PER_RUPEE, toPaise, toRupees, formatINR, formatINRCompact, AMOUNT_THRESHOLDS, thresholdProximity } from './money.js';
export type { FormatOptions } from './money.js';

export {
  clamp,
  sigmoid,
  logit,
  mean,
  sd,
  median,
  mad,
  quantile,
  erf,
  normalCdf,
  lognormalCdf,
  wilsonInterval,
  expm,
  identity,
  matMul,
  trapezoid,
  interpolatePiecewise,
} from './mathx.js';
export type { Matrix } from './mathx.js';

export { Rng } from './rng.js';
export { sha256, canonicalJson, hashObject, shortHash } from './hash.js';

export { SIGNAL_SPECS, SIGNAL_ORDER, binCount, toBin, reasonCode } from './signals/specs.js';
export { EXTRACTORS, istHour } from './signals/extract.js';
export type { Extractor, RawSignal } from './signals/extract.js';

export {
  FIRE_LLR_THRESHOLD,
  groupShrinkageFactor,
  evaluateSignals,
  fuse,
  contributionsByGroup,
  verifyAdditivity,
} from './fusion.js';
export type { FusionResult } from './fusion.js';

export {
  CURVE_SAMPLE_MINUTES,
  DEFAULT_RECOVERY_PARAMS,
  RecoveryModel,
  buildGenerator,
  recoverableCtmc,
  simulateChains,
  splitRecoverable,
} from './recovery.js';
export type { MonteCarloResult, RecoveryOptions } from './recovery.js';

export {
  ACTIONS,
  DEFAULT_POLICY,
  costOfAction,
  decide,
  decisionSurface,
  liabilityAvoided,
  surfaceAmounts,
  thresholds,
} from './cost.js';
export type { CostInputs, Decision, Thresholds } from './cost.js';

export {
  POLICY_PRESETS,
  presetById,
  policyDigest,
  evaluatePolicy,
  solveForConstraints,
  tradeOffFrontier,
  policyDiff,
} from './policy.js';
export type {
  PolicyPreset,
  PolicySample,
  PolicyOutcomeRates,
  ConstraintSolution,
  FrontierPoint,
} from './policy.js';

export {
  selectChallenge,
  challengePrompt,
  isOpen,
  wasStopped,
  openHold,
  resolveHold,
  expireIfDue,
  registerAttempt,
  heldExposure,
} from './hold.js';
export type { ChallengeChoice, HoldOutcome, AttemptOutcome, OpenHoldOptions } from './hold.js';

export {
  AuditLedger,
  GENESIS_HASH,
  redactTransaction,
  renderCaseNarrative,
  heldMinutes,
} from './ledger.js';
export type {
  LedgerEntry,
  LedgerRecord,
  LedgerQuery,
  RedactedParty,
  RedactedTransaction,
} from './ledger.js';

export {
  MemoryStore,
  PAYER_TXN_RETENTION,
} from './store.js';
export type { Store, PersistenceSink } from './store.js';

export {
  emptyPayerProfile,
  updatePayerProfile,
  emptyPayeeProfile,
  updatePayeeProfile,
  refreshPayeeWindow,
  hourHistogramFromCounts,
  payerTenureDays,
  PROFILE_AMOUNT_WINDOW,
  PROFILE_DAY_WINDOW,
  PAYEE_WINDOW_HOURS,
  BALANCE_PROXY_MULTIPLE,
} from './profiles.js';

export { Interceptor, minutesBetween } from './engine.js';
export type { InterceptorOptions, AuthorizationResult } from './engine.js';
