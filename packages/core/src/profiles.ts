import { mad, median, sd } from './mathx.js';
import { istHour } from './signals/extract.js';
import type { Millis, PayeeProfile, PayerProfile, Transaction } from './types.js';

/**
 * Rolling behavioural profile maintenance.
 *
 * Profiles are updated transaction by transaction as the stream is replayed,
 * never computed in one pass over the whole corpus. That ordering discipline is
 * what keeps the evaluation honest: when a transaction is scored, the profile it
 * is scored against contains only transactions that came before it. A profile
 * built over the full corpus would leak the future into every score and inflate
 * every metric in this repository.
 *
 * All maintenance state is bounded, so a profile is a fixed size regardless of
 * how long a customer has been active.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Recent log amounts retained for the robust amount baseline. */
export const PROFILE_AMOUNT_WINDOW = 200;

/** Calendar days retained for the velocity baseline. */
export const PROFILE_DAY_WINDOW = 60;

/** Hours of inbound history retained on a beneficiary for fan-in counting. */
export const PAYEE_WINDOW_HOURS = 24;

/**
 * Multiple of typical daily spend used as the available-funds proxy.
 *
 * There is no balance read here, so the drain-ratio signal needs a stand-in.
 * Twelve times the daily average approximates a fortnight of normal spending
 * capacity. It is crude, it is documented as crude, and the sensitivity
 * analysis in docs/MODELING.md shows how much the decision boundary moves when
 * it is varied.
 */
export const BALANCE_PROXY_MULTIPLE = 12;

/** IST calendar day key, used so day bucketing does not depend on host timezone. */
function istDayKey(ts: Millis): string {
  return new Date(ts + 5.5 * HOUR_MS).toISOString().slice(0, 10);
}

/**
 * Smoothed hour-of-day distribution from raw counts.
 *
 * Additive smoothing keeps every hour at a non-zero probability, so an hour
 * the payer has simply not used yet produces high but finite surprisal rather
 * than dominating the fused score outright. Exported so a profile snapshot can
 * ship the integer counts alone and rebuild the histogram on load.
 */
export function hourHistogramFromCounts(hourCounts: readonly number[]): number[] {
  const totalHours = hourCounts.reduce((a, b) => a + b, 0) || 1;
  return hourCounts.map((c) => (c + 0.5) / (totalHours + 12));
}

export function emptyPayerProfile(payerId: string, firstSeenMs: Millis): PayerProfile {
  return {
    payerId,
    firstSeenMs,
    lastSeenMs: firstSeenMs,
    txnCount: 0,
    logAmountMedian: Math.log(50_000), // 500 rupees, a neutral opening prior
    logAmountMad: 1,
    maxAmountPaise: 0,
    hourHistogram: new Array<number>(24).fill(1 / 24),
    knownPayees: {},
    knownDevices: {},
    dailyCountMean: 1,
    dailyCountSd: 0,
    dailyValueMean: 0,
    balanceProxyPaise: 0,
    recentLogAmounts: [],
    hourCounts: new Array<number>(24).fill(0),
    dailyCounts: {},
    totalValuePaise: 0,
  };
}

/**
 * Fold a transaction into a payer profile.
 *
 * Call this only after the transaction has been scored. Returns a new profile;
 * the input is not mutated, so a caller can score against the pre-transaction
 * state and keep it.
 */
export function updatePayerProfile(profile: PayerProfile, txn: Transaction): PayerProfile {
  const logAmount = Math.log(Math.max(txn.amountPaise, 1));

  const recentLogAmounts = [...profile.recentLogAmounts, logAmount];
  if (recentLogAmounts.length > PROFILE_AMOUNT_WINDOW) {
    recentLogAmounts.splice(0, recentLogAmounts.length - PROFILE_AMOUNT_WINDOW);
  }

  const hourCounts = [...profile.hourCounts];
  hourCounts[istHour(txn.ts)] = (hourCounts[istHour(txn.ts)] ?? 0) + 1;
  const hourHistogram = hourHistogramFromCounts(hourCounts);

  const dayKey = istDayKey(txn.ts);
  const dailyCounts = { ...profile.dailyCounts, [dayKey]: (profile.dailyCounts[dayKey] ?? 0) + 1 };
  const dayKeys = Object.keys(dailyCounts).sort();
  if (dayKeys.length > PROFILE_DAY_WINDOW) {
    for (const stale of dayKeys.slice(0, dayKeys.length - PROFILE_DAY_WINDOW)) {
      delete dailyCounts[stale];
    }
  }
  const perDay = Object.values(dailyCounts);

  const txnCount = profile.txnCount + 1;
  const totalValuePaise = profile.totalValuePaise + txn.amountPaise;
  const activeDays = Math.max(perDay.length, 1);

  const dailyValueMean = Math.round(totalValuePaise / activeDays);

  return {
    ...profile,
    lastSeenMs: Math.max(profile.lastSeenMs, txn.ts),
    txnCount,
    logAmountMedian: median(recentLogAmounts),
    logAmountMad: mad(recentLogAmounts),
    maxAmountPaise: Math.max(profile.maxAmountPaise, txn.amountPaise),
    hourHistogram,
    knownPayees: {
      ...profile.knownPayees,
      [txn.payeeId]: profile.knownPayees[txn.payeeId] ?? txn.ts,
    },
    knownDevices: {
      ...profile.knownDevices,
      [txn.deviceId]: profile.knownDevices[txn.deviceId] ?? txn.ts,
    },
    dailyCountMean: perDay.reduce((a, b) => a + b, 0) / activeDays,
    dailyCountSd: sd(perDay),
    dailyValueMean,
    balanceProxyPaise: Math.max(
      dailyValueMean * BALANCE_PROXY_MULTIPLE,
      profile.maxAmountPaise,
      txn.amountPaise,
    ),
    recentLogAmounts,
    hourCounts,
    dailyCounts,
    totalValuePaise,
  };
}

export function emptyPayeeProfile(
  payeeId: string,
  payeeVpa: string,
  firstSeenMs: Millis,
): PayeeProfile {
  return {
    payeeId,
    payeeVpa,
    firstSeenMs,
    distinctPayers24h: 0,
    distinctPayersAllTime: 0,
    inboundCount24h: 0,
    inboundValue24h: 0,
    outboundVelocityRatio: 0,
    confirmedMule: false,
    muleHopDistance: null,
    nameChurnCount: 0,
    inboundWindow: [],
  };
}

/** Fold an inbound payment into a beneficiary profile. */
export function updatePayeeProfile(
  profile: PayeeProfile,
  txn: Transaction,
  distinctPayersAllTime?: number,
): PayeeProfile {
  const cutoff = txn.ts - PAYEE_WINDOW_HOURS * HOUR_MS;
  const inboundWindow = [
    ...profile.inboundWindow.filter((e) => e.ts >= cutoff),
    { payerId: txn.payerId, ts: txn.ts, amountPaise: txn.amountPaise },
  ];

  const distinct = new Set(inboundWindow.map((e) => e.payerId));

  return {
    ...profile,
    distinctPayers24h: distinct.size,
    distinctPayersAllTime: distinctPayersAllTime ?? Math.max(profile.distinctPayersAllTime, distinct.size),
    inboundCount24h: inboundWindow.length,
    inboundValue24h: inboundWindow.reduce((s, e) => s + e.amountPaise, 0),
    inboundWindow,
  };
}

/**
 * Recompute the 24-hour window of a beneficiary profile as of a given time,
 * without adding a transaction.
 *
 * Fan-in decays with time, and a profile that is only refreshed on write would
 * report a stale count for a beneficiary that has gone quiet. Scoring calls
 * this so the count reflects the moment of authorisation.
 */
export function refreshPayeeWindow(profile: PayeeProfile, now: Millis): PayeeProfile {
  const cutoff = now - PAYEE_WINDOW_HOURS * HOUR_MS;
  const inboundWindow = profile.inboundWindow.filter((e) => e.ts >= cutoff);
  if (inboundWindow.length === profile.inboundWindow.length) return profile;
  const distinct = new Set(inboundWindow.map((e) => e.payerId));
  return {
    ...profile,
    distinctPayers24h: distinct.size,
    inboundCount24h: inboundWindow.length,
    inboundValue24h: inboundWindow.reduce((s, e) => s + e.amountPaise, 0),
    inboundWindow,
  };
}

/** Days a payer has been observed, used to damp baselines for thin histories. */
export function payerTenureDays(profile: PayerProfile, now: Millis): number {
  return Math.max((now - profile.firstSeenMs) / DAY_MS, 0);
}
