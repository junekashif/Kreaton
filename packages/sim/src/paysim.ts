import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { toPaise } from '@kreaton/core';
import type { LabelledTransaction, Millis, Paise } from '@kreaton/core';
import { DATA_DIR } from './paths.js';
import type { GeneratedCorpus, SyntheticPayee } from './generator.js';

/**
 * PaySim adapter.
 *
 * PaySim is a public mobile-money simulation (Lopez-Rojas, Elmir and Axelsson,
 * 2016) distributed through Kaggle. It is not a UPI dataset and it carries
 * none of the session context this engine is built around: no call state, no
 * device, no entry method. What it does carry is a labelled stream of
 * transfers with amounts, originators, beneficiaries and balances, which is
 * enough to ask whether the payee-side and amount-side signals generalise to
 * data nobody on this team generated.
 *
 * The mapping is deliberately conservative:
 *
 *   - Only TRANSFER and CASH_OUT rows are kept, because those are the only
 *     types in which PaySim fraud occurs and the only ones that resemble a
 *     push payment to a beneficiary.
 *   - Every context field is set to its quiet value. The engine therefore
 *     sees an attacker who has suppressed every controllable indicator, which
 *     is exactly the case the asymmetric evidence cap exists for.
 *   - Amounts are read as rupees. PaySim's currency is unspecified; the
 *     amount-deviation signal is scale-free and the structuring signal keys
 *     on named thresholds, so the choice affects one signal and is stated.
 *
 * The file is large and not committed. If it is absent the adapter reports
 * that and the caller exits cleanly, so no build depends on a Kaggle login.
 */

export const PAYSIM_DIR = resolve(DATA_DIR, 'paysim');

const HOUR_MS = 3_600_000;

/** Epoch of PaySim step zero. Arbitrary; only differences matter. */
const PAYSIM_EPOCH: Millis = Date.UTC(2026, 0, 1);

export interface PaySimRow {
  step: number;
  type: string;
  amount: number;
  nameOrig: string;
  oldbalanceOrg: number;
  newbalanceOrig: number;
  nameDest: string;
  oldbalanceDest: number;
  newbalanceDest: number;
  isFraud: boolean;
}

/** Locate a PaySim CSV under data/paysim, whatever Kaggle named it. */
export function findPaySimFile(): string | null {
  if (!existsSync(PAYSIM_DIR)) return null;
  const candidates = readdirSync(PAYSIM_DIR).filter((f) => f.toLowerCase().endsWith('.csv'));
  if (candidates.length === 0) return null;
  // Prefer the full file over any sample.
  candidates.sort((a, b) => (a.includes('sample') ? 1 : 0) - (b.includes('sample') ? 1 : 0));
  return resolve(PAYSIM_DIR, candidates[0]!);
}

export interface PaySimLoadOptions {
  /** Stop after this many kept rows. */
  limit?: number;
  /** Keep every fraudulent row and this fraction of legitimate rows. */
  legitimateSampleRate?: number;
}

/** Stream the CSV, keeping only the row types that look like push payments. */
export async function loadPaySim(path: string, opts: PaySimLoadOptions = {}): Promise<PaySimRow[]> {
  const rows: PaySimRow[] = [];
  const rate = opts.legitimateSampleRate ?? 1;
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let header: string[] | null = null;
  let seen = 0;
  for await (const line of rl) {
    if (!line) continue;
    if (!header) {
      header = line.split(',').map((h) => h.trim());
      continue;
    }
    const cols = line.split(',');
    const get = (name: string): string => cols[header!.indexOf(name)] ?? '';
    const type = get('type');
    if (type !== 'TRANSFER' && type !== 'CASH_OUT') continue;
    const isFraud = get('isFraud') === '1';
    seen += 1;
    // Deterministic thinning of legitimate rows, keyed on the row index so the
    // sample is the same on every run.
    if (!isFraud && rate < 1 && (seen * 2654435761) % 1_000_000 >= rate * 1_000_000) continue;
    rows.push({
      step: Number(get('step')),
      type,
      amount: Number(get('amount')),
      nameOrig: get('nameOrig'),
      oldbalanceOrg: Number(get('oldbalanceOrg')),
      newbalanceOrig: Number(get('newbalanceOrig')),
      nameDest: get('nameDest'),
      oldbalanceDest: Number(get('oldbalanceDest')),
      newbalanceDest: Number(get('newbalanceDest')),
      isFraud,
    });
    if (opts.limit && rows.length >= opts.limit) break;
  }
  return rows;
}

/** Spread rows within a one-hour step so timestamps are strictly ordered. */
function timestampFor(step: number, indexInStep: number, countInStep: number): Millis {
  const offset = Math.floor((HOUR_MS * (indexInStep + 0.5)) / Math.max(countInStep, 1));
  return PAYSIM_EPOCH + step * HOUR_MS + offset;
}

/** Quiet context: none of the session indicators PaySim does not observe. */
function quietContext(sessionId: string, firstPaidAt: Millis | null, deviceBoundAt: Millis): LabelledTransaction['context'] {
  return {
    activeCall: false,
    activeCallSeconds: 0,
    screenShareActive: false,
    remoteAccessAppRunning: false,
    appSwitchCount: 1,
    secondsFromOpenToAuthorize: 40,
    vpaEnteredBy: firstPaidAt === null ? 'typed' : 'contact',
    beneficiaryAddedAtMs: firstPaidAt,
    sessionId,
    isNewDevice: false,
    deviceBoundAtMs: deviceBoundAt,
    simChangedRecently: false,
  };
}

/**
 * Convert PaySim rows into a corpus the replay harness can consume.
 *
 * Beneficiary attributes are derived from what PaySim exposes: first
 * appearance on the stream, and the fraction of inbound value that leaves the
 * destination balance within the same step, which stands in for the outbound
 * velocity a network operator would supply.
 */
export function paySimToCorpus(rows: readonly PaySimRow[]): GeneratedCorpus {
  const sorted = [...rows].sort((a, b) => a.step - b.step);
  const perStep = new Map<number, number>();
  for (const r of sorted) perStep.set(r.step, (perStep.get(r.step) ?? 0) + 1);
  const indexInStep = new Map<number, number>();

  const firstPaid = new Map<string, Millis>();
  const firstSeenPayee = new Map<string, Millis>();
  const deviceBound = new Map<string, Millis>();
  const inbound = new Map<string, { value: number; retained: number }>();

  const transactions: LabelledTransaction[] = [];
  let totalValuePaise = 0;
  let fraudValuePaise = 0;
  let fraudCount = 0;

  sorted.forEach((r, i) => {
    const idx = indexInStep.get(r.step) ?? 0;
    indexInStep.set(r.step, idx + 1);
    const ts = timestampFor(r.step, idx, perStep.get(r.step) ?? 1);
    const amountPaise: Paise = Math.max(1, toPaise(r.amount));
    const pairKey = `${r.nameOrig}>${r.nameDest}`;
    const paidBefore = firstPaid.get(pairKey) ?? null;
    if (paidBefore === null) firstPaid.set(pairKey, ts);
    if (!firstSeenPayee.has(r.nameDest)) firstSeenPayee.set(r.nameDest, ts);
    if (!deviceBound.has(r.nameOrig)) deviceBound.set(r.nameOrig, ts - 400 * 24 * HOUR_MS);

    // Value that arrived and did not stay: PaySim reports the destination
    // balance before and after, so what left in the same step is observable.
    const arrived = r.amount;
    const retained = Math.max(0, r.newbalanceDest - r.oldbalanceDest);
    const agg = inbound.get(r.nameDest) ?? { value: 0, retained: 0 };
    agg.value += arrived;
    agg.retained += Math.min(arrived, retained);
    inbound.set(r.nameDest, agg);

    const txn: LabelledTransaction = {
      txnId: `paysim_${i}`,
      ts,
      payerId: r.nameOrig,
      payerVpa: `${r.nameOrig.toLowerCase()}@paysim`,
      payeeId: r.nameDest,
      payeeVpa: `${r.nameDest.toLowerCase()}@paysim`,
      payeeName: r.nameDest,
      amountPaise,
      channel: r.type === 'CASH_OUT' ? 'p2m' : 'p2p',
      deviceId: `dev_${r.nameOrig}`,
      ipHash: `ip_${r.nameOrig}`,
      simSerialHash: `sim_${r.nameOrig}`,
      context: quietContext(`sess_${i}`, paidBefore, deviceBound.get(r.nameOrig)!),
      label: r.isFraud ? { isFraud: true, typology: 'impersonation_known_person' } : { isFraud: false },
    };
    transactions.push(txn);
    totalValuePaise += amountPaise;
    if (r.isFraud) {
      fraudCount += 1;
      fraudValuePaise += amountPaise;
    }
  });

  const payees: SyntheticPayee[] = [...firstSeenPayee.entries()].map(([id, firstSeenMs]) => {
    const agg = inbound.get(id) ?? { value: 0, retained: 0 };
    const velocity = agg.value > 0 ? 1 - agg.retained / agg.value : 0;
    return {
      payeeId: id,
      vpa: `${id.toLowerCase()}@paysim`,
      name: id,
      kind: id.startsWith('M') ? 'merchant' : 'personal',
      channel: 'p2p',
      outboundVelocityRatio: Math.min(1, Math.max(0, velocity)),
      firstSeenMs,
    };
  });

  const config = {
    seed: 'paysim',
    payers: new Set(transactions.map((t) => t.payerId)).size,
    days: Math.ceil((sorted[sorted.length - 1]?.step ?? 0) / 24),
    fraudRate: transactions.length ? fraudCount / transactions.length : 0,
    startMs: PAYSIM_EPOCH,
    merchants: payees.filter((p) => p.kind === 'merchant').length,
    muleChains: 0,
    mulesPerChain: 0,
  };

  return {
    transactions,
    payers: [],
    payees,
    intel: [],
    meta: {
      config,
      generatedAt: new Date().toISOString(),
      totalTransactions: transactions.length,
      fraudulentTransactions: fraudCount,
      observedFraudRate: config.fraudRate,
      totalValuePaise,
      fraudValuePaise,
      byTypology: { impersonation_known_person: { count: fraudCount, valuePaise: fraudValuePaise } },
    },
  };
}
