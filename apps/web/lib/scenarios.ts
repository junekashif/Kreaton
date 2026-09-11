import { toPaise } from '@kreaton/core';
import type { LabelledTransaction, PayerProfile, Transaction, Typology } from '@kreaton/core';

/**
 * Injected episodes.
 *
 * The committed slice carries a realistic base rate, which means a live
 * demonstration would wait a long time for a scam to arrive on its own. These
 * scenarios construct one on demand against a real payer from the slice, with
 * the context fingerprint the typology actually leaves, and push it through
 * the same authorisation path as everything else. They are labelled as
 * injected in the feed and in the ledger so measured rates are never
 * contaminated by them.
 *
 * Each scenario is one or more payments; multi-payment scenarios are the ones
 * the hold protocol and the structuring signal exist for.
 */

export interface ScenarioStep {
  /** Seconds after the previous step. */
  afterSeconds: number;
  amountPaise: number;
  /** Overrides applied on top of the scenario's base context. */
  context?: Partial<Transaction['context']>;
  /** Pay a different beneficiary than the scenario's collection account. */
  newPayee?: boolean;
}

export interface Scenario {
  id: string;
  label: string;
  typology: Typology | null;
  isFraud: boolean;
  /** One line shown in the injector, in the language of the person choosing it. */
  summary: string;
  /** What the engine is expected to do, so the demonstration can be checked. */
  expectation: string;
  base: Partial<Transaction['context']>;
  steps: ScenarioStep[];
  payeeName: string;
  /** Age of the collection account when the episode starts. */
  payeeAgeDays: number;
  /** Fraction of inbound value the collection account forwards within the hour. */
  payeeVelocity: number;
  /** Choose a victim whose median payment is at least this, so the amounts read as ordinary. */
  minPayerMedianPaise?: number;
}

const DAY_MS = 86_400_000;

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'digital_arrest',
    payeeAgeDays: 3,
    payeeVelocity: 0.94,
    label: 'Digital arrest',
    typology: 'digital_arrest',
    isFraud: true,
    payeeName: 'CYBER CELL VERIFICATION',
    summary:
      'Victim held on a video call by someone posing as police, told to transfer savings to a "verification" account.',
    expectation:
      'Call concurrency, urgency, novelty and amount deviation all fire. Expected-cost holds or blocks; an on-device passcode is disqualified because the coach is on the line.',
    base: {
      activeCall: true,
      activeCallSeconds: 2_700,
      screenShareActive: false,
      remoteAccessAppRunning: false,
      appSwitchCount: 5,
      secondsFromOpenToAuthorize: 14,
      vpaEnteredBy: 'pasted',
      beneficiaryAddedAtMs: null,
      isNewDevice: false,
      simChangedRecently: false,
    },
    steps: [{ afterSeconds: 0, amountPaise: toPaise(185_000) }],
  },
  {
    id: 'kyc_remote',
    payeeAgeDays: 11,
    payeeVelocity: 0.9,
    label: 'KYC update with remote access',
    typology: 'kyc_update',
    isFraud: true,
    payeeName: 'KYC SUPPORT DESK',
    summary:
      'Victim installs a screen-sharing app "to complete KYC" and is walked through a payment while the fraudster watches the screen.',
    expectation:
      'Remote access disqualifies every on-device factor. If held, the challenge must be a cooling period with self-cancellation, not a biometric or a code.',
    base: {
      activeCall: true,
      activeCallSeconds: 900,
      screenShareActive: true,
      remoteAccessAppRunning: true,
      appSwitchCount: 3,
      secondsFromOpenToAuthorize: 22,
      vpaEnteredBy: 'typed',
      beneficiaryAddedAtMs: null,
      isNewDevice: false,
      simChangedRecently: false,
    },
    steps: [{ afterSeconds: 0, amountPaise: toPaise(47_500) }],
  },
  {
    id: 'structuring',
    payeeAgeDays: 40,
    payeeVelocity: 0.85,
    minPayerMedianPaise: toPaise(2_000),
    label: 'Threshold structuring',
    typology: 'job_task',
    isFraud: true,
    payeeName: 'TASK PAYOUT LTD',
    summary:
      'Four payments of ₹24,500 to the same account saved two days ago, minutes apart, each kept just under the ₹25,000 mark the victim has been told is monitored. No call during authorisation.',
    expectation:
      'The first payment passes: for this payer the amount is unusual but not damning. From the second, the trailing window has crossed a monitored threshold with no single payment doing so, the structuring contribution climbs, velocity joins in, and the rest are stopped.',
    base: {
      activeCall: false,
      activeCallSeconds: 0,
      screenShareActive: false,
      remoteAccessAppRunning: false,
      appSwitchCount: 2,
      secondsFromOpenToAuthorize: 28,
      vpaEnteredBy: 'contact',
      beneficiaryAddedAtMs: -2 * DAY_MS,
      isNewDevice: false,
      simChangedRecently: false,
    },
    steps: [
      { afterSeconds: 0, amountPaise: toPaise(24_500) },
      { afterSeconds: 240, amountPaise: toPaise(24_500) },
      { afterSeconds: 300, amountPaise: toPaise(24_500) },
      { afterSeconds: 300, amountPaise: toPaise(24_500) },
    ],
  },
  {
    id: 'hygienic',
    payeeAgeDays: 420,
    payeeVelocity: 0.62,
    label: 'Context suppression',
    typology: 'investment_trading',
    isFraud: true,
    payeeName: 'ALPHA WEALTH TRADING',
    summary:
      'The attacker has read the playbook: no call during authorisation, no urgency, the beneficiary saved yesterday, VPA typed slowly. Only the amount and the destination are wrong.',
    expectation:
      'Under the balanced policy this one usually gets through: with every controllable indicator suppressed, the remaining evidence sits just under the hold boundary. Switch to the liability-first preset and the same payment is held. This is the weakest position in the adversarial suite, and the console does not hide it.',
    base: {
      activeCall: false,
      activeCallSeconds: 0,
      screenShareActive: false,
      remoteAccessAppRunning: false,
      appSwitchCount: 1,
      secondsFromOpenToAuthorize: 52,
      vpaEnteredBy: 'contact',
      beneficiaryAddedAtMs: -DAY_MS,
      isNewDevice: false,
      simChangedRecently: false,
    },
    steps: [{ afterSeconds: 0, amountPaise: toPaise(95_000) }],
  },
  {
    id: 'split_retry',
    payeeAgeDays: 2,
    payeeVelocity: 0.92,
    minPayerMedianPaise: toPaise(800),
    label: 'Split re-attempt against a hold',
    typology: 'impersonation_known_person',
    isFraud: true,
    payeeName: 'RAHUL (NEW NUMBER)',
    summary:
      '"Hi, this is my new number, I need ₹30,000 urgently." When the first payment is held, the victim is told to try two smaller ones, then a third.',
    expectation:
      'The first payment is usually held with a challenge that names the beneficiary. Each retry is linked to that open hold, the re-attempt evidence pushes it to a block, the attempt budget is consumed, and the one after that escalates to human review.',
    base: {
      activeCall: false,
      activeCallSeconds: 0,
      screenShareActive: false,
      remoteAccessAppRunning: false,
      appSwitchCount: 6,
      secondsFromOpenToAuthorize: 11,
      vpaEnteredBy: 'pasted',
      beneficiaryAddedAtMs: null,
      isNewDevice: false,
      simChangedRecently: false,
    },
    steps: [
      { afterSeconds: 0, amountPaise: toPaise(30_000) },
      { afterSeconds: 90, amountPaise: toPaise(15_000) },
      { afterSeconds: 120, amountPaise: toPaise(15_000) },
      { afterSeconds: 150, amountPaise: toPaise(15_000) },
    ],
  },
  {
    id: 'legit_large',
    payeeAgeDays: 900,
    payeeVelocity: 0.05,
    label: 'Legitimate large payment',
    typology: null,
    isFraud: false,
    payeeName: 'KNOWN PAYEE',
    summary:
      'A genuine high-value transfer to a beneficiary this payer has paid before, from their usual device, with no coercion indicators.',
    expectation:
      'Approved despite the amount. The decision boundary is low at this value, but the calibrated probability is lower still, because every signal argues for the payment.',
    base: {
      activeCall: false,
      activeCallSeconds: 0,
      screenShareActive: false,
      remoteAccessAppRunning: false,
      appSwitchCount: 1,
      secondsFromOpenToAuthorize: 41,
      vpaEnteredBy: 'contact',
      beneficiaryAddedAtMs: -30 * DAY_MS,
      isNewDevice: false,
      simChangedRecently: false,
    },
    steps: [{ afterSeconds: 0, amountPaise: toPaise(120_000) }],
  },
] as const;

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

let injectedCounter = 0;

/**
 * Build the payments for a scenario against a real payer.
 *
 * The template transaction supplies everything that identifies the payer: id,
 * address, device and SIM binding. The payee is a fresh collection account
 * unless the scenario asks for a known one, in which case it reuses the
 * template's beneficiary so the novelty signal sees an established
 * relationship.
 */
export function buildScenario(
  scenario: Scenario,
  template: Transaction,
  profile: PayerProfile | undefined,
  startTs: number,
): LabelledTransaction[] {
  injectedCounter += 1;
  const episode = `inj${injectedCounter}`;
  const collectionId = `mule_${episode}`;
  const collectionVpa = `${scenario.id.replace(/_/g, '')}${injectedCounter}@okaxis`;
  const knownDevice = profile ? Object.keys(profile.knownDevices)[0] : undefined;

  const usesKnownPayee = scenario.base.beneficiaryAddedAtMs !== null && !scenario.isFraud;

  let ts = startTs;
  return scenario.steps.map((step, i) => {
    ts += step.afterSeconds * 1000;
    const ctx = { ...template.context, ...scenario.base, ...step.context };
    // Relative beneficiary ages are expressed as negative offsets in the
    // scenario and resolved against the payment time here.
    if (typeof ctx.beneficiaryAddedAtMs === 'number' && ctx.beneficiaryAddedAtMs <= 0) {
      ctx.beneficiaryAddedAtMs = ts + ctx.beneficiaryAddedAtMs;
    }
    ctx.sessionId = `sess_${episode}_${i + 1}`;

    const txn: LabelledTransaction = {
      txnId: `txn_${episode}_${i + 1}`,
      ts,
      payerId: template.payerId,
      payerVpa: template.payerVpa,
      payeeId: usesKnownPayee ? template.payeeId : collectionId,
      payeeVpa: usesKnownPayee ? template.payeeVpa : collectionVpa,
      payeeName: usesKnownPayee ? template.payeeName : scenario.payeeName,
      amountPaise: step.amountPaise,
      channel: 'p2p',
      deviceId: ctx.isNewDevice ? `dev_${episode}` : (knownDevice ?? template.deviceId),
      ipHash: template.ipHash,
      simSerialHash: template.simSerialHash,
      context: ctx,
      label: scenario.isFraud
        ? { isFraud: true, typology: scenario.typology ?? undefined, chainId: `chain_${episode}` }
        : { isFraud: false },
    };
    return txn;
  });
}
