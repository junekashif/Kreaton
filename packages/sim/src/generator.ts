import { Rng, toPaise } from '@kreaton/core';
import { TYPOLOGIES, validateShares } from './typologies.js';
import type { TypologySpec } from './typologies.js';
import type {
  Channel,
  LabelledTransaction,
  Millis,
  Paise,
  Transaction,
  Typology,
  VpaEntryMethod,
} from '@kreaton/core';

/**
 * Transaction corpus generation.
 *
 * There is no public labelled dataset of authorised push payment fraud on a
 * UPI-style rail, and there is a reason for that: the label only exists inside
 * a payment institution, attached to a customer complaint, and it is not
 * publishable. So the corpus here is generated, and this file is written on the
 * assumption that a reader will be sceptical of that and should be.
 *
 * Three commitments make a generated corpus worth evaluating on:
 *
 *   1. Fraud is produced by typologies with independent, documented
 *      fingerprints, not by perturbing a field the detector then finds. See
 *      typologies.ts.
 *
 *   2. Legitimate behaviour is deliberately made to overlap with fraudulent
 *      behaviour on every individual signal. Roughly one legitimate payment in
 *      seven goes to a new beneficiary. Roughly one in fourteen is authorised
 *      during a phone call. Legitimate customers occasionally send an unusually
 *      large amount at an unusual hour from a new phone. If any single signal
 *      separated the classes cleanly the fusion model would be untested, and
 *      the headline metric would be an artefact of the generator.
 *
 *   3. Knowledge that would not have existed at decision time is withheld.
 *      Beneficiary accounts are confirmed as mules on an intelligence timeline,
 *      so a payment made before an account was identified is scored without
 *      that knowledge. This is the difference between a realistic evaluation
 *      and one that silently reads the answer key.
 *
 * The corpus is still synthetic, and no claim here depends on it being
 * otherwise. The PaySim adapter exists so the same engine can be run against an
 * externally produced dataset as a cross-check.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface GeneratorConfig {
  seed: number | string;
  /** Distinct paying customers. */
  payers: number;
  /** Days of activity to generate. */
  days: number;
  /** Share of all payments that are fraudulent. */
  fraudRate: number;
  /** First instant of the corpus. */
  startMs: Millis;
  /** Legitimate merchant beneficiaries, which have high fan-in but low onward velocity. */
  merchants: number;
  /** Independent mule networks. */
  muleChains: number;
  /** Collection accounts per network. */
  mulesPerChain: number;
}

export const DEFAULT_CONFIG: GeneratorConfig = {
  seed: 'kreaton-2026',
  payers: 4_000,
  days: 60,
  // Higher than reported national incidence on the live rail, deliberately.
  // At a realistic rate a sixty-day corpus would contain too few positives to
  // estimate precision at a useful confidence, and every interval in the
  // evaluation would be uselessly wide. The evaluation reports metrics
  // reweighted to lower prevalence so the inflation does not flatter results:
  // ranking metrics are unaffected by prevalence, precision-recall is, and both
  // are reported.
  fraudRate: 0.003,
  startMs: Date.UTC(2026, 5, 1, 0, 0, 0),
  merchants: 700,
  muleChains: 60,
  mulesPerChain: 4,
} as const;

// ---------------------------------------------------------------------------
// Population
// ---------------------------------------------------------------------------

/** Hour-of-day preference archetypes over IST. */
const HOUR_ARCHETYPES: readonly number[][] = [
  // Standard daytime
  [0.2, 0.1, 0.1, 0.1, 0.1, 0.3, 0.9, 1.6, 2.4, 2.8, 2.6, 2.4, 2.2, 2.4, 2.6, 2.6, 2.4, 2.2, 2.0, 1.6, 1.1, 0.7, 0.4, 0.3],
  // Evening-heavy
  [0.3, 0.2, 0.1, 0.1, 0.1, 0.2, 0.5, 0.9, 1.3, 1.5, 1.5, 1.6, 1.7, 1.6, 1.6, 1.8, 2.2, 2.8, 3.2, 3.0, 2.4, 1.6, 0.9, 0.5],
  // Morning-heavy
  [0.2, 0.1, 0.1, 0.1, 0.2, 0.8, 2.0, 3.0, 3.2, 2.8, 2.2, 1.8, 1.6, 1.5, 1.4, 1.3, 1.2, 1.1, 1.0, 0.8, 0.6, 0.4, 0.3, 0.2],
  // Night worker
  [1.8, 1.9, 1.8, 1.5, 1.2, 0.8, 0.5, 0.4, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 1.8, 1.8],
];

export interface SyntheticPayer {
  payerId: string;
  vpa: string;
  /** Median payment size in paise, log space. */
  spendLogMean: number;
  spendLogSd: number;
  /** Mean payments per day. */
  dailyRate: number;
  hourWeights: number[];
  devices: string[];
  /** Probability of using the primary device on any given payment. */
  deviceStability: number;
  personalPayees: string[];
  merchantPayees: string[];
  /** How readily this payer pays somebody new. */
  noveltyAppetite: number;
  simSerial: string;
}

export interface SyntheticPayee {
  payeeId: string;
  vpa: string;
  name: string;
  kind: 'merchant' | 'personal' | 'mule';
  channel: Channel;
  /** Fraction of inbound value forwarded within the hour. */
  outboundVelocityRatio: number;
  /** Network this collection account belongs to, for mules. */
  chainId?: string;
  /** Position in the collection network, for mules. */
  layer?: number;
  /** When this account first appears on the network. */
  firstSeenMs: Millis;
  /**
   * When a collection account starts receiving victim payments. Distinct from
   * firstSeenMs, because a rented account can be years old and still have been
   * pressed into service last week.
   */
  activeFromMs?: Millis;
}

/** Beneficiary identified as a mule by an investigation, at a point in time. */
export interface MuleIntelEvent {
  ts: Millis;
  payeeId: string;
  chainId: string;
  /**
   * Zero when the account itself is confirmed; one or more when it is
   * associated with a confirmed account at that many hops.
   */
  hopDistance: number;
}

export interface GeneratedCorpus {
  transactions: LabelledTransaction[];
  payers: SyntheticPayer[];
  payees: SyntheticPayee[];
  intel: MuleIntelEvent[];
  meta: {
    config: GeneratorConfig;
    generatedAt: string;
    totalTransactions: number;
    fraudulentTransactions: number;
    observedFraudRate: number;
    totalValuePaise: Paise;
    fraudValuePaise: Paise;
    byTypology: Record<string, { count: number; valuePaise: Paise }>;
  };
}

const FIRST_NAMES = [
  'Aarav', 'Vivaan', 'Aditya', 'Rajesh', 'Priya', 'Ananya', 'Kavya', 'Rohan', 'Neha', 'Arjun',
  'Ishaan', 'Meera', 'Sanjay', 'Deepa', 'Karthik', 'Lakshmi', 'Farhan', 'Zara', 'Manish', 'Pooja',
  'Suresh', 'Ritu', 'Vikram', 'Sneha', 'Imran', 'Divya', 'Gaurav', 'Anjali', 'Nikhil', 'Tanvi',
];
const LAST_NAMES = [
  'Sharma', 'Verma', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Singh', 'Gupta', 'Bose', 'Khan',
  'Das', 'Menon', 'Joshi', 'Kulkarni', 'Chopra', 'Rao', 'Mehta', 'Pillai', 'Banerjee', 'Ahmed',
];
const PSP_HANDLES = ['okhdfcbank', 'oksbi', 'okicici', 'okaxis', 'ybl', 'paytm', 'upi', 'apl'];
const MERCHANT_WORDS = [
  'Stores', 'Traders', 'Mart', 'Kirana', 'Electronics', 'Pharmacy', 'Cafe', 'Fuel', 'Textiles',
  'Sweets', 'Hardware', 'Mobiles', 'Bakery', 'Dairy', 'Opticals', 'Restaurant', 'Salon',
];

function personName(rng: Rng): string {
  return `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
}

function vpaFor(rng: Rng, handleSeed: string): string {
  return `${handleSeed}@${rng.pick(PSP_HANDLES)}`;
}

function weightedHour(rng: Rng, weights: readonly number[]): number {
  return rng.weightedIndex(weights);
}

/**
 * Fraction of inbound value an account forwards within the hour.
 *
 * Collection accounts forward almost everything almost immediately, and that is
 * the most specific mule indicator available. But the distributions have to
 * overlap, because both tails exist in reality: a small trader paying suppliers
 * out of the same account, or an individual who sweeps every incoming payment
 * straight to savings, looks fast; a patient network that accumulates before
 * moving, or an account being warmed before use, looks slow.
 *
 * Without that overlap this attribute alone identifies every mule, and the
 * fan-in signal stops being a signal and becomes the label.
 */
function drawOutboundVelocity(rng: Rng, kind: SyntheticPayee['kind']): number {
  switch (kind) {
    case 'merchant':
      // A minority settle same-hour, typically small traders paying suppliers.
      return rng.bool(0.08) ? rng.uniform(0.4, 0.75) : rng.uniform(0.02, 0.35);
    case 'personal':
      // People who sweep incoming payments to savings immediately.
      return rng.bool(0.12) ? rng.uniform(0.5, 0.85) : rng.uniform(0.05, 0.45);
    case 'mule':
      // Patient networks accumulate before moving, or the account is still
      // being warmed up.
      return rng.bool(0.2) ? rng.uniform(0.15, 0.45) : rng.uniform(0.45, 0.98);
  }
}

/**
 * When a beneficiary account first appeared on the network.
 *
 * Getting this distribution wrong is the single easiest way to produce a
 * corpus that looks impressive and means nothing. An earlier version gave every
 * legitimate beneficiary an age of at least thirty days and every collection
 * account an age of at most a few weeks, which made account age a perfect
 * separator on its own and drove the held-out ROC AUC to exactly 1.0. A metric
 * like that is a defect report, not a result.
 *
 * Both sides of the overlap are real:
 *
 *   - Legitimate beneficiaries are constantly new. Shops open, people change
 *     payment handles, a friend sets up a new account. A model that treats
 *     novelty as near-proof of fraud would interrupt all of them.
 *
 *   - Collection accounts are frequently not new at all. There is an
 *     established market in rented and purchased accounts belonging to real
 *     people, precisely because account age defeats naive controls. Roughly
 *     half the mule accounts here are aged genuine accounts for that reason.
 *
 * What survives is a signal that shifts the odds without deciding the case,
 * which is what a signal in a fused model is supposed to do.
 */
function drawFirstSeen(
  rng: Rng,
  kind: SyntheticPayee['kind'],
  startMs: Millis,
  windowDays: number,
): Millis {
  const daysBeforeStart = (() => {
    switch (kind) {
      case 'merchant': {
        const r = rng.next();
        if (r < 0.7) return rng.uniform(180, 1400); // long-established
        if (r < 0.92) return rng.uniform(14, 180); // opened in the last few months
        return rng.uniform(-windowDays, 14); // opens during or just before the window
      }
      case 'personal': {
        const r = rng.next();
        if (r < 0.55) return rng.uniform(60, 1200);
        if (r < 0.83) return rng.uniform(7, 60);
        return rng.uniform(-windowDays, 7);
      }
      case 'mule': {
        // Rented and purchased accounts are genuinely old; the rest are opened
        // for the purpose and burned.
        return rng.bool(0.45) ? rng.uniform(90, 900) : rng.uniform(-windowDays * 0.8, 30);
      }
    }
  })();
  return startMs - daysBeforeStart * DAY_MS;
}

/** Build the payer and beneficiary population. */
export function createPopulation(config: GeneratorConfig): {
  payers: SyntheticPayer[];
  payees: SyntheticPayee[];
  rng: Rng;
} {
  const rng = new Rng(config.seed);
  const payees: SyntheticPayee[] = [];

  // Legitimate merchants: many unrelated payers, but funds settle on a cycle
  // rather than leaving immediately. This is what separates them from mules and
  // is the reason fan-in alone is not a usable signal.
  for (let i = 0; i < config.merchants; i++) {
    const name = `${rng.pick(LAST_NAMES)} ${rng.pick(MERCHANT_WORDS)}`;
    payees.push({
      payeeId: `mer_${i}`,
      vpa: vpaFor(rng, `m${i}`),
      name,
      kind: 'merchant',
      channel: 'p2m',
      outboundVelocityRatio: drawOutboundVelocity(rng, 'merchant'),
      firstSeenMs: drawFirstSeen(rng, 'merchant', config.startMs, config.days),
    });
  }

  // Mule networks. Layer-one accounts receive victim payments directly.
  const mules: SyntheticPayee[] = [];
  for (let c = 0; c < config.muleChains; c++) {
    const chainId = `chain_${c}`;
    // Networks become active on a stagger, independently of how old the
    // individual accounts they use happen to be.
    const chainActiveFrom = config.startMs + rng.uniform(-10, config.days * 0.8) * DAY_MS;
    for (let m = 0; m < config.mulesPerChain; m++) {
      const mule: SyntheticPayee = {
        payeeId: `mul_${c}_${m}`,
        vpa: vpaFor(rng, `x${c}${m}${rng.int(100, 999)}`),
        name: personName(rng),
        kind: 'mule',
        channel: 'p2p',
        outboundVelocityRatio: drawOutboundVelocity(rng, 'mule'),
        chainId,
        layer: 1,
        firstSeenMs: drawFirstSeen(rng, 'mule', config.startMs, config.days),
        activeFromMs: chainActiveFrom + rng.uniform(0, 3) * DAY_MS,
      };
      mules.push(mule);
      payees.push(mule);
    }
  }

  // Personal beneficiaries: friends, family, landlords. Low fan-in, low velocity.
  const personalCount = Math.max(config.payers * 3, 1_000);
  for (let i = 0; i < personalCount; i++) {
    payees.push({
      payeeId: `per_${i}`,
      vpa: vpaFor(rng, `p${i}`),
      name: personName(rng),
      kind: 'personal',
      channel: 'p2p',
      outboundVelocityRatio: drawOutboundVelocity(rng, 'personal'),
      firstSeenMs: drawFirstSeen(rng, 'personal', config.startMs, config.days),
    });
  }

  const merchantPool = payees.filter((p) => p.kind === 'merchant');
  const personalPool = payees.filter((p) => p.kind === 'personal');

  const payers: SyntheticPayer[] = [];
  for (let i = 0; i < config.payers; i++) {
    // Spend level is itself lognormal across the population, which is what
    // produces the heavy-tailed amount distribution seen on real rails.
    const spendLogMean = Math.log(toPaise(Math.exp(rng.normal(Math.log(420), 0.85))));
    const deviceCount = rng.bool(0.22) ? 2 : 1;
    payers.push({
      payerId: `pay_${i}`,
      vpa: vpaFor(rng, `u${i}`),
      spendLogMean,
      spendLogSd: rng.uniform(0.55, 1.15),
      dailyRate: Math.max(0.15, rng.lognormal(Math.log(1.5), 0.75)),
      hourWeights: rng.pick(HOUR_ARCHETYPES),
      devices: Array.from({ length: deviceCount }, (_, d) => `dev_${i}_${d}`),
      deviceStability: rng.uniform(0.85, 0.995),
      personalPayees: rng.sample(personalPool, rng.int(2, 9)).map((p) => p.payeeId),
      merchantPayees: rng.sample(merchantPool, rng.int(4, 22)).map((p) => p.payeeId),
      noveltyAppetite: rng.uniform(0.04, 0.3),
      simSerial: `sim_${i}`,
    });
  }

  return { payers, payees, rng };
}

// ---------------------------------------------------------------------------
// Transaction construction
// ---------------------------------------------------------------------------

function pickEntry(rng: Rng, mix: Record<VpaEntryMethod, number>): VpaEntryMethod {
  return rng.weightedPick(mix);
}

/** Entry-method mix for ordinary payments. */
const LEGIT_ENTRY_MIX: Record<VpaEntryMethod, number> = {
  contact: 0.34,
  qr: 0.31,
  typed: 0.19,
  pasted: 0.12,
  deeplink: 0.04,
};

interface BuildArgs {
  rng: Rng;
  txnId: string;
  ts: Millis;
  payer: SyntheticPayer;
  payee: SyntheticPayee;
  amountPaise: Paise;
  deviceId: string;
  beneficiaryAddedAtMs: Millis | null;
  isNewDevice: boolean;
  deviceBoundAtMs: Millis;
  simChangedRecently: boolean;
  activeCall: boolean;
  activeCallSeconds: number;
  screenShareActive: boolean;
  remoteAccessAppRunning: boolean;
  appSwitchCount: number;
  secondsFromOpenToAuthorize: number;
  vpaEnteredBy: VpaEntryMethod;
  sessionId: string;
}

function buildTransaction(a: BuildArgs): Transaction {
  return {
    txnId: a.txnId,
    ts: Math.round(a.ts),
    payerId: a.payer.payerId,
    payerVpa: a.payer.vpa,
    payeeId: a.payee.payeeId,
    payeeVpa: a.payee.vpa,
    payeeName: a.payee.name,
    amountPaise: Math.max(100, Math.round(a.amountPaise)),
    channel: a.payee.channel,
    deviceId: a.deviceId,
    ipHash: `ip_${a.payer.payerId}_${a.deviceId}`,
    simSerialHash: a.payer.simSerial,
    context: {
      activeCall: a.activeCall,
      activeCallSeconds: Math.round(a.activeCallSeconds),
      screenShareActive: a.screenShareActive,
      remoteAccessAppRunning: a.remoteAccessAppRunning,
      appSwitchCount: Math.max(0, Math.round(a.appSwitchCount)),
      secondsFromOpenToAuthorize: Math.max(2, Math.round(a.secondsFromOpenToAuthorize)),
      vpaEnteredBy: a.vpaEnteredBy,
      beneficiaryAddedAtMs: a.beneficiaryAddedAtMs,
      sessionId: a.sessionId,
      isNewDevice: a.isNewDevice,
      deviceBoundAtMs: Math.round(a.deviceBoundAtMs),
      simChangedRecently: a.simChangedRecently,
    },
  };
}

/**
 * Baseline rate at which ordinary payments are authorised during a call.
 *
 * People do pay while on the phone: settling a bill with a shopkeeper, sending
 * rent while talking to a flatmate. If this were zero, concurrent call would be
 * a perfect separator and the entire fusion exercise would be theatre.
 */
const LEGIT_CALL_RATE = 0.07;

/** Rate at which ordinary payments go to a beneficiary never paid before. */
const LEGIT_NEW_PAYEE_BASE = 0.12;

/**
 * Rate of large legitimate payments: rent, premiums, fees, major purchases.
 * Roughly one payment in twenty, which is about how often a household sends
 * something well outside its daily pattern.
 */
const LEGIT_LARGE_PAYMENT_RATE = 0.05;

/** Rate of legitimate payments made in a hurry, from a link or a chat request. */
const LEGIT_HURRIED_RATE = 0.09;

/**
 * Share of fraud episodes run with deliberate operational hygiene.
 *
 * Experienced operators know what banks look for. They coach the victim to end
 * the call before authorising, to pick the payee from their saved list rather
 * than pasting an identifier, and to take their time. This costs the attacker
 * nothing and removes the entire contextual fingerprint.
 *
 * Including these in the corpus is not a detail. A model fitted only on
 * careless fraud learns that the absence of a concurrent call is strong
 * evidence of innocence, and is then defeated completely by a script change.
 * The adversarial suite measures exactly that failure, and this is what the
 * model needs to have seen in order to survive it.
 */
const FRAUD_HYGIENIC_RATE = 0.15;

/** Entry-method mix for hurried legitimate payments, skewed to pasted and linked. */
const LEGIT_HURRIED_ENTRY_MIX: Record<VpaEntryMethod, number> = {
  pasted: 0.42,
  deeplink: 0.26,
  typed: 0.16,
  qr: 0.11,
  contact: 0.05,
};

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export function generateCorpus(config: GeneratorConfig = DEFAULT_CONFIG): GeneratedCorpus {
  validateShares();
  const { payers, payees } = createPopulation(config);
  const rng = new Rng(`${config.seed}:stream`);

  const payeeById = new Map(payees.map((p) => [p.payeeId, p]));
  const personalPool = payees.filter((p) => p.kind === 'personal');
  const merchantPool = payees.filter((p) => p.kind === 'merchant');
  const mulePool = payees.filter((p) => p.kind === 'mule');

  const transactions: LabelledTransaction[] = [];
  // First time each payer paid each beneficiary, so novelty is computed from
  // the generated history rather than asserted.
  const firstPaid = new Map<string, number>();
  const beneficiaryAdded = new Map<string, number>();
  const deviceBound = new Map<string, number>();

  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_${(seq++).toString(36).padStart(7, '0')}`;

  // --- Legitimate stream ---------------------------------------------------
  for (const payer of payers) {
    for (const device of payer.devices) {
      // Primary device predates the window; a second device is acquired during it.
      const bound =
        device.endsWith('_0')
          ? config.startMs - rng.uniform(60, 900) * DAY_MS
          : config.startMs + rng.uniform(0, config.days) * DAY_MS;
      deviceBound.set(device, bound);
    }

    for (let day = 0; day < config.days; day++) {
      const count = rng.poisson(payer.dailyRate);
      for (let k = 0; k < count; k++) {
        const hour = weightedHour(rng, payer.hourWeights);
        const ts =
          config.startMs + day * DAY_MS + hour * HOUR_MS + rng.uniform(0, 1) * HOUR_MS;

        // Beneficiary selection: mostly familiar, sometimes new.
        const wantsNew = rng.bool(LEGIT_NEW_PAYEE_BASE * (payer.noveltyAppetite / 0.15));
        let payee: SyntheticPayee;
        if (wantsNew) {
          payee = rng.bool(0.6) ? rng.pick(merchantPool) : rng.pick(personalPool);
          // Adopt the new beneficiary into this payer circle. Without this, a
          // payer never pays the same new shop twice, and the novelty signal
          // sees legitimate beneficiaries only at age zero or age months,
          // never at the hours-to-days range where scam payments sit. That gap
          // turned novelty into a near-perfect separator in an earlier version.
          if (payee.kind === 'merchant') payer.merchantPayees.push(payee.payeeId);
          else payer.personalPayees.push(payee.payeeId);
        } else {
          const known = rng.bool(0.72) ? payer.merchantPayees : payer.personalPayees;
          const id = known.length > 0 ? rng.pick(known) : rng.pick(merchantPool).payeeId;
          payee = payeeById.get(id)!;
        }

        // A beneficiary that has not opened yet cannot be paid. Some legitimate
        // beneficiaries are created during the window precisely so that account
        // age overlaps between the classes, which means this case is common
        // rather than an edge, and falling back keeps the volume unbiased.
        if (ts < payee.firstSeenMs) {
          const established = payer.merchantPayees
            .map((id) => payeeById.get(id)!)
            .filter((p) => p.firstSeenMs <= ts);
          if (established.length === 0) continue;
          payee = rng.pick(established);
        }

        const key = `${payer.payerId}|${payee.payeeId}`;
        // The beneficiary is added shortly before the first payment to it, not
        // at the instant of that payment. People add a payee, then pay: the gap
        // is usually a couple of minutes and occasionally much longer. The same
        // add time is then reused for every later payment, so novelty ages
        // forward naturally.
        let addedAt = beneficiaryAdded.get(key);
        if (addedAt === undefined) {
          addedAt = ts - rng.lognormal(Math.log(4 * MINUTE_MS), 1.3);
          beneficiaryAdded.set(key, addedAt);
        }
        if (!firstPaid.has(key)) firstPaid.set(key, ts);

        const usePrimary = rng.bool(payer.deviceStability);
        const deviceId = usePrimary ? payer.devices[0]! : rng.pick(payer.devices);
        const boundAt = deviceBound.get(deviceId)!;
        const isNewDevice = ts - boundAt < 36 * HOUR_MS;

        // Most legitimate payments sit near the payer own baseline, but a real
        // customer periodically sends something far larger: rent, an insurance
        // premium, tuition, a hospital bill, a wedding purchase. Without that
        // tail, amount deviation becomes a near-perfect separator, because every
        // scam payment is large relative to the victim baseline and no
        // legitimate payment ever is. That tail is the single most important
        // piece of overlap in the whole corpus.
        const isLargeLegitimate = rng.bool(LEGIT_LARGE_PAYMENT_RATE);
        const amount = isLargeLegitimate
          ? rng.lognormal(Math.log(toPaise(22_000)), 1.1)
          : rng.lognormal(payer.spendLogMean, payer.spendLogSd);
        // Merchant payments cluster on round-ish values; person-to-person less so.
        const rounded =
          payee.kind === 'merchant' && rng.bool(0.45)
            ? Math.round(amount / toPaise(10)) * toPaise(10)
            : amount;

        const onCall = rng.bool(LEGIT_CALL_RATE);

        // A minority of legitimate payments genuinely look hurried: paying from
        // a bill reminder, settling a request a friend sent over chat, topping
        // up before a deadline. These produce pasted identifiers, app switching
        // and fast authorisation without any fraud behind them.
        const hurried = rng.bool(LEGIT_HURRIED_RATE);

        transactions.push({
          ...buildTransaction({
            rng,
            txnId: nextId('txn'),
            ts,
            payer,
            payee,
            amountPaise: rounded,
            deviceId,
            beneficiaryAddedAtMs: addedAt,
            isNewDevice,
            deviceBoundAtMs: boundAt,
            simChangedRecently: false,
            activeCall: onCall,
            activeCallSeconds: onCall ? rng.lognormal(Math.log(180), 0.9) : 0,
            // Legitimate screen sharing during a payment is rare but not absent.
            screenShareActive: rng.bool(0.004),
            remoteAccessAppRunning: rng.bool(0.003),
            appSwitchCount: rng.poisson(hurried ? 4.2 : 1.1),
            secondsFromOpenToAuthorize: rng.lognormal(Math.log(hurried ? 16 : 38), 0.7),
            vpaEnteredBy: pickEntry(rng, hurried ? LEGIT_HURRIED_ENTRY_MIX : LEGIT_ENTRY_MIX),
            sessionId: nextId('ses'),
          }),
          label: { isFraud: false },
        });
      }
    }
  }

  // --- Fraudulent stream ---------------------------------------------------
  const legitCount = transactions.length;
  const targetFraud = Math.round((legitCount * config.fraudRate) / (1 - config.fraudRate));

  const intel: MuleIntelEvent[] = [];
  const chainFirstUsed = new Map<string, number>();

  // Group collection accounts by network once, rather than scanning the pool
  // per episode.
  const mulesByChain = new Map<string, SyntheticPayee[]>();
  for (const m of mulePool) {
    const list = mulesByChain.get(m.chainId!) ?? [];
    list.push(m);
    mulesByChain.set(m.chainId!, list);
  }
  const chainIds = [...mulesByChain.keys()];

  let produced = 0;
  let guard = 0;

  // Collection accounts each victim has already paid, so sustained-relationship
  // typologies can come back to the same one.
  const victimHistory = new Map<string, SyntheticPayee[]>();

  while (produced < targetFraud && guard++ < targetFraud * 40) {
    const spec = pickTypology(rng);
    const victim = rng.pick(payers);

    const priorMules = victimHistory.get(victim.payerId) ?? [];
    const reusing = priorMules.length > 0 && rng.bool(spec.repeatBeneficiaryProb);
    const mule = reusing ? rng.pick(priorMules) : rng.pick(mulesByChain.get(rng.pick(chainIds))!);
    const chainId = mule.chainId!;

    // The episode starts once the network has pressed this account into
    // service, which is unrelated to how old the account itself is.
    const earliest = Math.max(config.startMs, mule.activeFromMs ?? mule.firstSeenMs);
    const latest = config.startMs + config.days * DAY_MS;
    if (earliest >= latest) continue;
    const episodeStart = rng.uniform(earliest, latest - HOUR_MS);

    const episodeLength = rng.int(spec.episodeMin, spec.episodeMax);
    const hygienic = rng.bool(FRAUD_HYGIENIC_RATE);

    // The first payment lands on an hour drawn from the typology operating
    // schedule; the rest follow within the same coercion session, minutes apart.
    const episodeDay = Math.floor((episodeStart - config.startMs) / DAY_MS);
    let cursor =
      config.startMs +
      episodeDay * DAY_MS +
      weightedHour(rng, spec.hourWeights) * HOUR_MS +
      rng.uniform(0, 1) * HOUR_MS;
    const activeFrom = mule.activeFromMs ?? mule.firstSeenMs;
    if (cursor < activeFrom) cursor = activeFrom + rng.uniform(1, 120) * MINUTE_MS;

    // The beneficiary is added shortly before the first payment. The gap is
    // drawn from the same family as the legitimate one, only slightly longer,
    // because a coached victim adds the payee and then spends a minute being
    // talked through the rest. Making this gap distinctly different from the
    // legitimate case would hand the novelty signal a timing artefact to key
    // on instead of the fact that the beneficiary is new at all.
    //
    // When the relationship is being resumed, the beneficiary was added weeks
    // ago and is no longer new by any measure the system can see.
    const historyKey = `${victim.payerId}|${mule.payeeId}`;
    const existingAdd = beneficiaryAdded.get(historyKey);
    const addedAt =
      reusing && existingAdd !== undefined
        ? existingAdd
        : hygienic
          ? cursor - rng.uniform(1, 9) * DAY_MS
          : cursor - rng.lognormal(Math.log(8 * MINUTE_MS), 1.3);
    beneficiaryAdded.set(historyKey, addedAt);

    for (let i = 0; i < episodeLength && produced < targetFraud; i++) {
      if (i > 0) cursor += rng.lognormal(Math.log(9 * MINUTE_MS), 0.9);
      if (cursor > latest) break;

      let amount = rng.lognormal(spec.amountLogMean, spec.amountLogSd);
      amount = Math.min(Math.max(amount, spec.amountFloor), spec.amountCeiling);
      // Structured episodes are steered to sit just under a monitored threshold.
      if (rng.bool(spec.structuringProb)) {
        const threshold = rng.pick([toPaise(2_000), toPaise(25_000), toPaise(50_000), toPaise(100_000)]);
        amount = threshold * rng.uniform(0.9, 0.995);
      }

      const useNewDevice = rng.bool(spec.newDeviceProb);
      const deviceId = useNewDevice ? `dev_${victim.payerId}_new` : victim.devices[0]!;
      const boundAt = useNewDevice
        ? cursor - rng.uniform(5, 300) * MINUTE_MS
        : (deviceBound.get(deviceId) ?? cursor - 200 * DAY_MS);

      // Hygienic episodes scrub the contextual fingerprint entirely.
      const onCall = hygienic ? false : rng.bool(spec.activeCallProb);

      transactions.push({
        ...buildTransaction({
          rng,
          txnId: nextId('txn'),
          ts: cursor,
          payer: victim,
          payee: mule,
          amountPaise: amount,
          deviceId,
          beneficiaryAddedAtMs: addedAt,
          isNewDevice: useNewDevice,
          deviceBoundAtMs: boundAt,
          simChangedRecently: useNewDevice && rng.bool(0.35),
          activeCall: onCall,
          // Duration grows through the episode: the victim has been on the line
          // since before the first payment.
          activeCallSeconds: onCall
            ? rng.lognormal(Math.log(spec.callSecondsMean), 0.7) + i * 480
            : 0,
          screenShareActive: hygienic ? false : rng.bool(spec.screenShareProb),
          remoteAccessAppRunning: hygienic ? false : rng.bool(spec.remoteAccessProb),
          appSwitchCount: rng.poisson(hygienic ? 1.2 : spec.appSwitchMean),
          secondsFromOpenToAuthorize: rng.lognormal(
            Math.log(hygienic ? 95 : spec.authorizeSecondsMean),
            0.6,
          ),
          vpaEnteredBy: hygienic ? pickEntry(rng, LEGIT_ENTRY_MIX) : pickEntry(rng, spec.entryMix),
          sessionId: `ses_fr_${produced}`,
        }),
        label: { isFraud: true, typology: spec.id, chainId },
      });

      if (!firstPaid.has(historyKey)) firstPaid.set(historyKey, cursor);
      const seen = victimHistory.get(victim.payerId) ?? [];
      if (!seen.some((m) => m.payeeId === mule.payeeId)) {
        seen.push(mule);
        victimHistory.set(victim.payerId, seen);
      }

      if (!chainFirstUsed.has(chainId)) chainFirstUsed.set(chainId, cursor);
      produced += 1;
    }
  }

  // --- Mule intelligence timeline -----------------------------------------
  // An account becomes known only after a victim reports and an investigation
  // links it. Roughly two thirds of networks are eventually identified, after a
  // lag measured in days. Scoring applies each event only from its timestamp,
  // so a payment made before the account was known is scored without it.
  for (const [chainId, firstUse] of chainFirstUsed) {
    if (!rng.bool(0.65)) continue;
    const confirmedAt = firstUse + rng.lognormal(Math.log(3.2 * DAY_MS), 0.8);
    const chainAccounts = mulePool.filter((m) => m.chainId === chainId);
    // One account in the network is confirmed directly; the rest are associated.
    const confirmed = rng.pick(chainAccounts);
    intel.push({ ts: confirmedAt, payeeId: confirmed.payeeId, chainId, hopDistance: 0 });
    for (const other of chainAccounts) {
      if (other.payeeId === confirmed.payeeId) continue;
      intel.push({
        ts: confirmedAt + rng.uniform(0, 2) * DAY_MS,
        payeeId: other.payeeId,
        chainId,
        hopDistance: rng.int(1, 3),
      });
    }
  }

  transactions.sort((a, b) => a.ts - b.ts || (a.txnId < b.txnId ? -1 : 1));
  intel.sort((a, b) => a.ts - b.ts);

  // --- Summary -------------------------------------------------------------
  const byTypology: Record<string, { count: number; valuePaise: Paise }> = {};
  let fraudValue = 0;
  let totalValue = 0;
  let fraudCount = 0;
  for (const t of transactions) {
    totalValue += t.amountPaise;
    if (!t.label.isFraud) continue;
    fraudCount += 1;
    fraudValue += t.amountPaise;
    const key = t.label.typology ?? 'unknown';
    const bucket = (byTypology[key] ??= { count: 0, valuePaise: 0 });
    bucket.count += 1;
    bucket.valuePaise += t.amountPaise;
  }

  return {
    transactions,
    payers,
    payees,
    intel,
    meta: {
      config,
      generatedAt: new Date().toISOString(),
      totalTransactions: transactions.length,
      fraudulentTransactions: fraudCount,
      observedFraudRate: fraudCount / Math.max(transactions.length, 1),
      totalValuePaise: totalValue,
      fraudValuePaise: fraudValue,
      byTypology,
    },
  };
}

function pickTypology(rng: Rng): TypologySpec {
  const idx = rng.weightedIndex(TYPOLOGIES.map((t) => t.share));
  return TYPOLOGIES[idx]!;
}

/** Look up the typology share table, for reporting. */
export function typologyShares(): Record<Typology, number> {
  return Object.fromEntries(TYPOLOGIES.map((t) => [t.id, t.share])) as Record<Typology, number>;
}
