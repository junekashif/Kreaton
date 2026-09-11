import { formatINR, thresholdProximity, AMOUNT_THRESHOLDS } from '../money.js';
import { clamp } from '../mathx.js';
import type { ScoringContext, SignalId, Transaction } from '../types.js';

/**
 * Raw statistic extraction.
 *
 * Every extractor reduces a transaction and its context to one real number in
 * natural units, plus a sentence of evidence written for a human reader. The
 * evidence string is not decoration: it is carried into the audit record and is
 * what a compliance reviewer or an ombudsman actually reads, so it states the
 * measured quantity and the baseline it was measured against rather than
 * restating the signal name.
 *
 * No extractor consults the label, the model, or the decision. They are pure
 * functions of observable state at authorisation time.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** India Standard Time offset. UPI settlement and customer behaviour are IST-bound. */
const IST_OFFSET_MS = 5.5 * HOUR_MS;

/**
 * Lower bound on the robust scale estimate for amount deviation.
 *
 * A payer whose payments are nearly identical would otherwise have a MAD at or
 * near zero, which makes the z-score diverge and turns any variation at all
 * into an extreme score. In log space 0.35 corresponds to roughly a 42 per cent
 * spread in amount, which is a defensible floor for how precisely anyone repeats
 * their own payment behaviour.
 */
const MIN_LOG_AMOUNT_MAD = 0.35;

/**
 * Probability floor for hour-of-day surprisal, equivalent to having seen the
 * hour once in fifty days. Without it an unobserved hour yields infinite
 * surprisal and a single novel hour would dominate the fused score.
 */
const MIN_HOUR_PROBABILITY = 1 / 1200;

export interface RawSignal {
  raw: number;
  evidence: string;
}

export type Extractor = (txn: Transaction, ctx: ScoringContext) => RawSignal;

/** Hour of day in IST, computed arithmetically so replays do not depend on the host timezone. */
export function istHour(ts: number): number {
  return Math.floor((((ts + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / HOUR_MS);
}

function hoursSince(now: number, then: number): number {
  return Math.max(0, (now - then) / HOUR_MS);
}

function describeAge(hours: number): string {
  if (hours < 1 / 60) return 'seconds ago';
  if (hours < 1) return `${Math.round(hours * 60)} minutes ago`;
  if (hours < 48) return `${hours.toFixed(1)} hours ago`;
  if (hours < 24 * 90) return `${Math.round(hours / 24)} days ago`;
  return `${(hours / 24 / 30.44).toFixed(1)} months ago`;
}

// ---------------------------------------------------------------------------

const payeeNovelty: Extractor = (txn, ctx) => {
  const addedAt = txn.context.beneficiaryAddedAtMs;
  const firstPaidAt = ctx.payer.knownPayees[txn.payeeId];
  const anchors = [addedAt, firstPaidAt].filter((v): v is number => typeof v === 'number');
  // No anchor at all means the beneficiary reached the screen in this session.
  const anchor = anchors.length > 0 ? Math.min(...anchors) : ctx.now;
  const hours = hoursSince(ctx.now, anchor);
  const everPaid = typeof firstPaidAt === 'number';
  const evidence = everPaid
    ? `Beneficiary first paid ${describeAge(hoursSince(ctx.now, firstPaidAt))}.`
    : `No prior payment to this beneficiary; added ${describeAge(hours)}.`;
  return { raw: hours, evidence };
};

const amountDeviation: Extractor = (txn, ctx) => {
  const { payer } = ctx;
  const scale = Math.max(payer.logAmountMad, MIN_LOG_AMOUNT_MAD);
  const z = (Math.log(Math.max(txn.amountPaise, 1)) - payer.logAmountMedian) / scale;
  const typical = Math.exp(payer.logAmountMedian);
  const evidence =
    `${formatINR(txn.amountPaise)} is ${z >= 0 ? '+' : ''}${z.toFixed(1)} robust deviations ` +
    `from this payer median payment of ${formatINR(typical)} across ${payer.txnCount} transactions.`;
  return { raw: z, evidence };
};

const temporalAnomaly: Extractor = (txn, ctx) => {
  const hour = istHour(txn.ts);
  const p = Math.max(ctx.payer.hourHistogram[hour] ?? 0, MIN_HOUR_PROBABILITY);
  const surprisal = -Math.log(p);
  const share = (p * 100).toFixed(1);
  const evidence =
    `Authorised at ${String(hour).padStart(2, '0')}:00 IST, an hour accounting for ` +
    `${share}% of this payer historical activity.`;
  return { raw: surprisal, evidence };
};

const deviceDrift: Extractor = (txn, ctx) => {
  const boundHours = hoursSince(ctx.now, txn.context.deviceBoundAtMs);
  // A SIM swap invalidates device trust outright: UPI registration binds to the
  // SIM, so a recent swap means the binding itself is fresh regardless of handset.
  const raw = txn.context.simChangedRecently ? 0 : boundHours;
  const evidence = txn.context.simChangedRecently
    ? `SIM changed within the risk window; device trust age reset from ${describeAge(boundHours)}.`
    : txn.context.isNewDevice
      ? `Unrecognised device, bound ${describeAge(boundHours)}.`
      : `Device bound ${describeAge(boundHours)}.`;
  return { raw, evidence };
};

const payeeFanIn: Extractor = (_txn, ctx) => {
  const { payee } = ctx;
  const raw = payee.distinctPayers24h * payee.outboundVelocityRatio;
  const evidence =
    `${payee.distinctPayers24h} distinct payers in 24h with ` +
    `${(payee.outboundVelocityRatio * 100).toFixed(0)}% of inbound value forwarded within the hour.`;
  return { raw, evidence };
};

const payeeAccountAge: Extractor = (_txn, ctx) => {
  const hours = hoursSince(ctx.now, ctx.payee.firstSeenMs);
  const churn = ctx.payee.nameChurnCount;
  const evidence =
    `Beneficiary first seen on the network ${describeAge(hours)}` +
    (churn > 0 ? `, with ${churn} registered-name change${churn === 1 ? '' : 's'}.` : '.');
  return { raw: hours, evidence };
};

const callConcurrency: Extractor = (txn) => {
  const c = txn.context;
  // Call weight saturates at 1.5 after ten minutes: a brief call spanning a
  // payment is unremarkable, a long one spanning it is the coaching pattern.
  const callWeight = c.activeCall ? clamp(c.activeCallSeconds / 600, 0.2, 1.5) : 0;
  const raw = callWeight + (c.screenShareActive ? 1 : 0) + (c.remoteAccessAppRunning ? 1.5 : 0);

  const parts: string[] = [];
  if (c.activeCall) parts.push(`call in progress for ${Math.round(c.activeCallSeconds / 60)} min`);
  if (c.screenShareActive) parts.push('screen sharing active');
  if (c.remoteAccessAppRunning) parts.push('remote-access application running');
  const evidence = parts.length
    ? `Authorised while ${parts.join(', ')}.`
    : 'No concurrent call, screen share or remote-access application.';
  return { raw, evidence };
};

const ENTRY_WEIGHT: Record<Transaction['context']['vpaEnteredBy'], number> = {
  deeplink: 1.5,
  pasted: 1,
  typed: 0.25,
  qr: 0,
  contact: 0,
};

const sessionUrgency: Extractor = (txn) => {
  const c = txn.context;
  const switches = clamp(c.appSwitchCount / 3, 0, 2);
  const entry = ENTRY_WEIGHT[c.vpaEnteredBy];
  const rushed = c.secondsFromOpenToAuthorize < 20 ? 1 : 0;
  const raw = switches + entry + rushed;
  const evidence =
    `${c.appSwitchCount} app switch${c.appSwitchCount === 1 ? '' : 'es'} before authorisation; ` +
    `payee entered by ${c.vpaEnteredBy}; ${Math.round(c.secondsFromOpenToAuthorize)}s from app open to authorisation.`;
  return { raw, evidence };
};

const structuring: Extractor = (txn, ctx) => {
  const windowStart = ctx.now - DAY_MS;
  const recent = ctx.recentPayerTxns.filter((t) => t.ts >= windowStart);
  const all = [txn, ...recent];

  let index = 0;
  const notes: string[] = [];

  // (a) This payment sits immediately below a monitored threshold.
  const prox = thresholdProximity(txn.amountPaise);
  if (prox < 0.05) {
    index += 1.5;
    notes.push(`amount within ${(prox * 100).toFixed(1)}% below a monitored threshold`);
  } else if (prox < 0.12) {
    index += 0.75;
    notes.push(`amount within ${(prox * 100).toFixed(1)}% below a monitored threshold`);
  }

  // (b) Several payments in the window cluster just below thresholds.
  const nearCount = all.filter((t) => thresholdProximity(t.amountPaise) < 0.12).length;
  if (nearCount >= 2) {
    index += Math.min(nearCount - 1, 3) * 0.5;
    notes.push(`${nearCount} payments in 24h placed just below a threshold`);
  }

  // (c) The window sums past a threshold that no single payment crosses. This is
  //     the pattern a per-transaction limit cannot see by construction.
  const total = all.reduce((s, t) => s + t.amountPaise, 0);
  const largest = all.reduce((m, t) => Math.max(m, t.amountPaise), 0);
  for (const threshold of AMOUNT_THRESHOLDS) {
    if (total >= threshold && largest < threshold) {
      index += 1.5;
      notes.push(
        `24h total ${formatINR(total)} across ${all.length} payments crosses ${formatINR(threshold)} while no single payment does`,
      );
      break;
    }
  }

  // (d) A split re-attempt aimed at an open hold. Without this the hold protocol
  //     is trivially defeated by retrying the same value in two halves.
  const openHolds = ctx.activeHolds.filter(
    (h) => h.state === 'SOFT_HOLD' || h.state === 'CHALLENGE_ISSUED',
  );
  const matchingHold = openHolds.find((h) => h.payeeId === txn.payeeId);
  if (matchingHold) {
    index += 3;
    notes.push(
      `re-attempt to a beneficiary with ${formatINR(matchingHold.amountPaise)} already on hold`,
    );
  }

  const evidence = notes.length
    ? `Structuring indicators: ${notes.join('; ')}.`
    : 'No threshold-structuring indicators in the trailing 24 hours.';
  return { raw: index, evidence };
};

const velocityBurst: Extractor = (txn, ctx) => {
  const windowStart = ctx.now - DAY_MS;
  const count = ctx.recentPayerTxns.filter((t) => t.ts >= windowStart).length + 1;
  const baseline = Math.max(ctx.payer.dailyCountMean, 0.5);
  const raw = count / baseline;
  const evidence =
    `${count} payments in 24h against a baseline of ${baseline.toFixed(1)} per active day ` +
    `(${raw.toFixed(1)}x).`;
  return { raw, evidence };
};

const drainRatio: Extractor = (txn, ctx) => {
  const available = Math.max(ctx.payer.balanceProxyPaise, 1);
  const raw = txn.amountPaise / available;
  const evidence =
    `${formatINR(txn.amountPaise)} is ${(raw * 100).toFixed(0)}% of estimated available funds ` +
    `(${formatINR(available)}, inferred from spending history rather than a balance read).`;
  return { raw, evidence };
};

const muleProximity: Extractor = (_txn, ctx) => {
  const { payee } = ctx;
  let raw = 0;
  let evidence = 'Beneficiary has no known association with a confirmed mule account.';
  if (payee.confirmedMule) {
    raw = 4;
    evidence = 'Beneficiary is itself a confirmed mule account.';
  } else if (payee.muleHopDistance !== null && payee.muleHopDistance <= 3) {
    raw = 4 - payee.muleHopDistance;
    evidence = `Beneficiary is ${payee.muleHopDistance} hop${payee.muleHopDistance === 1 ? '' : 's'} from a confirmed mule account.`;
  }
  return { raw, evidence };
};

/** Extractor per signal. Iterated in SIGNAL_ORDER so results are deterministic. */
export const EXTRACTORS: Record<SignalId, Extractor> = {
  PAYEE_NOVELTY: payeeNovelty,
  AMOUNT_DEVIATION: amountDeviation,
  TEMPORAL_ANOMALY: temporalAnomaly,
  DEVICE_DRIFT: deviceDrift,
  PAYEE_FAN_IN: payeeFanIn,
  PAYEE_ACCOUNT_AGE: payeeAccountAge,
  CALL_CONCURRENCY: callConcurrency,
  SESSION_URGENCY: sessionUrgency,
  STRUCTURING: structuring,
  VELOCITY_BURST: velocityBurst,
  DRAIN_RATIO: drainRatio,
  MULE_PROXIMITY: muleProximity,
};
