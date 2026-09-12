/**
 * Constructing transactions from mapped rows.
 *
 * The output of this module is what the engine sees, so it carries two
 * obligations beyond correctness. It must order payments by time, because
 * every behavioural baseline is built forward through the stream and a file in
 * reverse chronological order would score every payment against a future it
 * has not had yet. And it must account for what it invented: the report names
 * every substituted field, every unreadable cell, and every structural
 * property of the dataset that will limit what the engine can find in it.
 */

import { toPaise } from '@kreaton/core';
import type { LabelledTransaction, Millis, Paise, Transaction, Typology } from '@kreaton/core';
import { FIELDS, FIELDS_BY_PATH, QUIET_PATHS } from './fields.js';
import { coerceAmount, coerceBoolean, coerceEnum, coerceNumber, coerceTimestamp } from './coerce.js';
import { suppliedPaths } from './mapping.js';
import type { Mapping } from './mapping.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;

/** Movement types that mean money arrived. Everything else is money leaving. */
const INFLOW_WORDS = new Set(['credit', 'cr', 'c', 'deposit', 'cash_in', 'cashin', 'inflow', 'paid_in', 'received', 'refund']);
const OUTFLOW_WORDS = new Set([
  'debit', 'dr', 'd', 'withdrawal', 'withdraw', 'transfer', 'cash_out', 'cashout',
  'payment', 'purchase', 'outflow', 'paid_out', 'sent', 'pay',
]);

/**
 * A stable identifier for a counterparty a file names but does not number.
 *
 * A bank statement has a narration and no beneficiary account, so the name is
 * the only identity available. Folding case and punctuation means "RAMESH
 * TRADERS" and "Ramesh Traders." are one beneficiary rather than two, which is
 * what makes the payee-graph signals work at all on a statement.
 */
export function slugIdentity(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/\b(?:upi|neft|imps|rtgs|ref|txn|to|from|via)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return slug === '' ? 'unnamed' : slug;
}

/** The payer a statement-shaped file implies but never names. */
export const IMPLIED_PAYER = 'account_holder';

/** Beneficiary attributes assembled from the file. */
export interface ImportedPayee {
  payeeId: string;
  name: string;
  firstSeenMs: Millis;
  outboundVelocityRatio: number;
}

/** A confirmed-mule marking, released at the timestamp it was asserted. */
export interface ImportedIntel {
  ts: Millis;
  payeeId: string;
}

export interface ColumnIssue {
  column: string;
  path: string;
  label: string;
  count: number;
  /** First few offending values, for the operator to look at. */
  samples: string[];
}

export interface ImportReport {
  rowsRead: number;
  rowsKept: number;
  rowsSkipped: number;
  /** Why rows were dropped, counted. */
  skipped: Record<string, number>;
  columnIssues: ColumnIssue[];
  /** Fields left at a value an attacker would choose, because no column supplied them. */
  quiet: Array<{ path: string; label: string; note: string }>;
  /** Fields substituted harmlessly. */
  substituted: Array<{ path: string; label: string; note: string }>;
  labelled: boolean;
  fraudCount: number;
  windowFromMs: Millis;
  windowToMs: Millis;
  distinctPayers: number;
  distinctPayees: number;
  /** Share of payments whose beneficiary the payer had paid before. */
  repeatBeneficiaryRate: number;
  /** Median payments per payer. Thin histories weaken every behavioural signal. */
  medianPaymentsPerPayer: number;
  /** Plain-language cautions about what this dataset can and cannot show. */
  warnings: string[];
  /** Conventions the importer assumed, worth stating. */
  assumptions: string[];
}

export interface ImportedDataset {
  transactions: LabelledTransaction[];
  payees: ImportedPayee[];
  intel: ImportedIntel[];
  /** Closing balances observed per payer, when the file carried them. */
  balances: Record<string, Paise>;
  /**
   * Balance available to the payer immediately before each payment, keyed by
   * payment reference. A statement records the balance after the debit, so
   * this is that figure plus the amount; it is what the drain-ratio signal
   * should divide by, and it is a measurement rather than the engine's
   * spend-based estimate.
   */
  balanceBefore: Record<string, Paise>;
  report: ImportReport;
}

export interface BuildOptions {
  /** Anchor for relative timestamps and the fallback for unreadable ones. */
  baseMs?: Millis;
  /** Stop after this many kept rows. */
  limit?: number;
  /** Prefix for synthesised payment references. */
  idPrefix?: string;
}

interface Issue {
  column: string;
  path: string;
  count: number;
  samples: string[];
}

/** Read one dotted path out of a row through the mapping. */
function cell(row: Record<string, string>, mapping: Mapping, path: string): string | null {
  const b = mapping[path];
  if (!b) return null;
  if (b.constant !== undefined && b.constant !== '') return b.constant;
  if (b.column === null) return null;
  const v = row[b.column];
  return v === undefined ? null : v;
}

/**
 * Build transactions from mapped rows.
 *
 * Rows are processed in file order, then sorted by timestamp. Sorting is
 * stable, so a file with a single timestamp per day keeps its within-day
 * order rather than being shuffled.
 */
export function buildDataset(
  rows: ReadonlyArray<Record<string, string>>,
  mapping: Mapping,
  opts: BuildOptions = {},
): ImportedDataset {
  const base = (opts.baseMs ?? Date.now()) as Millis;
  const limit = opts.limit ?? Infinity;
  const prefix = opts.idPrefix ?? 'imp';
  const supplied = suppliedPaths(mapping);

  const issues = new Map<string, Issue>();
  const noteIssue = (path: string, column: string, sample: string): void => {
    const key = `${path}|${column}`;
    const existing = issues.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.samples.length < 3 && !existing.samples.includes(sample)) existing.samples.push(sample);
    } else {
      issues.set(key, { column, path, count: 1, samples: [sample] });
    }
  };
  const assumptions = new Set<string>();

  const skipped: Record<string, number> = {};
  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  interface Draft {
    txn: LabelledTransaction;
    order: number;
    payeeVelocity: number | null;
    payeeFirstSeen: Millis | null;
    confirmedMule: boolean;
    balance: Paise | null;
  }

  const drafts: Draft[] = [];
  const creditBalances: Record<string, Paise> = {};
  let order = 0;
  let rowsRead = 0;

  for (const row of rows) {
    rowsRead += 1;
    if (drafts.length >= limit) {
      skip('beyond the row limit');
      continue;
    }

    // --- direction, first, because a credit is not a payment ------------
    let isCredit = false;
    const directionRaw = cell(row, mapping, 'direction');
    if (directionRaw !== null && directionRaw.trim() !== '') {
      const d = directionRaw.trim().toLowerCase().replace(/[\s-]+/g, '_');
      // Many files put a movement type in this column rather than a
      // direction. PaySim is the common case: PAYMENT and DEBIT are money
      // leaving the account, and only CASH_IN is money arriving.
      if (INFLOW_WORDS.has(d)) isCredit = true;
      else if (OUTFLOW_WORDS.has(d)) isCredit = false;
      else {
        const c = coerceEnum(d, ['debit', 'credit']);
        isCredit = c.ok && c.value === 'credit';
        if (!c.ok) noteIssue('direction', mapping.direction?.column ?? 'direction', directionRaw);
      }
    }

    // A two-column statement: the row is a credit when the credit column has
    // a value and the debit column does not.
    const creditRaw = cell(row, mapping, 'creditPaise');
    const amountRaw = cell(row, mapping, 'amountPaise');
    if (supplied.has('creditPaise')) {
      const hasCredit = creditRaw !== null && creditRaw.trim() !== '' && Number(creditRaw.replace(/[^0-9.-]/g, '')) !== 0;
      const hasDebit = amountRaw !== null && amountRaw.trim() !== '' && Number(amountRaw.replace(/[^0-9.-]/g, '')) !== 0;
      if (hasCredit && !hasDebit) isCredit = true;
    }

    // --- required fields -------------------------------------------------
    // A statement is written from one account's point of view and never names
    // the account holder in a column. Rather than reject such a file, the
    // whole statement is read as one payer; the report says so.
    let payerId: string;
    if (supplied.has('payerId')) {
      payerId = (cell(row, mapping, 'payerId') ?? '').trim();
      if (payerId === '') {
        skip('no payer');
        continue;
      }
    } else {
      payerId = IMPLIED_PAYER;
      assumptions.add('No payer column, so every row is read as the same account holder. Behavioural baselines are built for that one payer.');
    }

    const balanceRaw = cell(row, mapping, 'balancePaise');
    let balance: Paise | null = null;
    if (balanceRaw !== null && balanceRaw.trim() !== '') {
      const b = coerceAmount(balanceRaw, mapping.balancePaise?.unit ?? 'rupees');
      if (b.ok) balance = b.value;
    }

    if (isCredit) {
      if (balance !== null) creditBalances[payerId] = balance;
      skip('money in, not a payment');
      continue;
    }

    // A statement names the counterparty in the narration and numbers it
    // nowhere. The name folded to a stable slug is then the only beneficiary
    // identity available, and it is a real one: it makes repeat payments to
    // the same counterparty recognisable, which is what the payee-graph
    // signals need.
    const payeeNameRaw = (cell(row, mapping, 'payeeName') ?? '').trim();
    let payeeId = (cell(row, mapping, 'payeeId') ?? '').trim();
    if (payeeId === '') {
      if (payeeNameRaw === '') {
        skip('no beneficiary');
        continue;
      }
      payeeId = slugIdentity(payeeNameRaw);
      assumptions.add('No beneficiary identifier column, so beneficiaries are identified by their name.');
    }

    if (amountRaw === null || amountRaw.trim() === '') {
      skip('no amount');
      continue;
    }
    const amount = coerceAmount(amountRaw, mapping.amountPaise?.unit ?? 'rupees');
    if (!amount.ok) {
      noteIssue('amountPaise', mapping.amountPaise?.column ?? 'amount', amountRaw);
      skip('unreadable amount');
      continue;
    }
    if (amount.value <= 0) {
      skip('zero amount');
      continue;
    }
    if (amount.note) assumptions.add(`Amounts: ${amount.note}.`);

    // --- timestamp -------------------------------------------------------
    let ts: Millis;
    const tsRaw = cell(row, mapping, 'ts');
    if (tsRaw !== null && tsRaw.trim() !== '') {
      const t = coerceTimestamp(tsRaw, mapping.ts?.mode ?? 'auto', base);
      if (!t.ok) noteIssue('ts', mapping.ts?.column ?? 'timestamp', tsRaw);
      if (t.note) assumptions.add(`Timestamps: ${t.note}.`);
      ts = t.value;
    } else {
      // Preserve file order at a fixed spacing, ending at the base time.
      ts = (base - (rows.length - order) * 5 * 60_000) as Millis;
    }

    // --- everything else, with its documented substitute ------------------
    const str = (path: string, fallback: string): string => {
      const v = cell(row, mapping, path);
      return v === null || v.trim() === '' ? fallback : v.trim();
    };
    const bool = (path: string, fallback: boolean): boolean => {
      const v = cell(row, mapping, path);
      if (v === null || v.trim() === '') return fallback;
      const c = coerceBoolean(v);
      if (!c.ok) noteIssue(path, mapping[path]?.column ?? path, v);
      return c.ok ? c.value : fallback;
    };
    const num = (path: string, fallback: number): number => {
      const v = cell(row, mapping, path);
      if (v === null || v.trim() === '') return fallback;
      const c = coerceNumber(v);
      if (!c.ok) noteIssue(path, mapping[path]?.column ?? path, v);
      return c.ok ? c.value : fallback;
    };
    const time = (path: string, fallback: Millis): Millis => {
      const v = cell(row, mapping, path);
      if (v === null || v.trim() === '') return fallback;
      const c = coerceTimestamp(v, mapping[path]?.mode ?? 'auto', base);
      if (!c.ok) noteIssue(path, mapping[path]?.column ?? path, v);
      return c.ok ? c.value : fallback;
    };

    const channelRaw = cell(row, mapping, 'channel');
    let channel: Transaction['channel'] = 'p2p';
    if (channelRaw !== null && channelRaw.trim() !== '') {
      const c = coerceEnum(channelRaw, ['p2p', 'p2m', 'collect']);
      if (!c.ok) noteIssue('channel', mapping.channel?.column ?? 'channel', channelRaw);
      else channel = c.value as Transaction['channel'];
    }

    const entryRaw = cell(row, mapping, 'context.vpaEnteredBy');
    let entry: Transaction['context']['vpaEnteredBy'] = 'typed';
    if (entryRaw !== null && entryRaw.trim() !== '') {
      const c = coerceEnum(entryRaw, ['typed', 'pasted', 'qr', 'contact', 'deeplink']);
      if (!c.ok) noteIssue('context.vpaEnteredBy', mapping['context.vpaEnteredBy']?.column ?? 'entry', entryRaw);
      else entry = c.value as Transaction['context']['vpaEnteredBy'];
    }

    const txnId = str('txnId', `${prefix}_${String(order + 1).padStart(6, '0')}`);
    const payeeName = payeeNameRaw === '' ? payeeId : payeeNameRaw;
    const deviceId = str('deviceId', `dev_${payerId}`);

    const labelled = supplied.has('label.isFraud');
    const isFraud = labelled ? bool('label.isFraud', false) : false;
    const typologyRaw = str('label.typology', '');

    const txn: LabelledTransaction = {
      txnId,
      ts,
      payerId,
      payerVpa: str('payerVpa', `${payerId}@imported`),
      payeeId,
      payeeVpa: str('payeeVpa', `${payeeId}@imported`),
      payeeName,
      amountPaise: amount.value,
      channel,
      deviceId,
      ipHash: `ip_${payerId}`,
      simSerialHash: `sim_${payerId}`,
      ...(str('note', '') ? { note: str('note', '') } : {}),
      context: {
        activeCall: bool('context.activeCall', false),
        activeCallSeconds: Math.max(0, num('context.activeCallSeconds', 0)),
        screenShareActive: bool('context.screenShareActive', false),
        remoteAccessAppRunning: bool('context.remoteAccessAppRunning', false),
        appSwitchCount: Math.max(0, Math.round(num('context.appSwitchCount', 0))),
        secondsFromOpenToAuthorize: Math.max(0, num('context.secondsFromOpenToAuthorize', 30)),
        vpaEnteredBy: entry,
        // Null means "added in this session", which is the strongest novelty
        // reading available. The engine derives beneficiary age from the payer
        // profile when this is absent, so leaving it null here would assert
        // something the file never said. It is set from the payer's own history
        // during the forward pass below.
        beneficiaryAddedAtMs: null,
        sessionId: str('context.sessionId', `sess_${txnId}`),
        isNewDevice: bool('context.isNewDevice', false),
        deviceBoundAtMs: time('context.deviceBoundAtMs', (ts - YEAR_MS) as Millis),
        simChangedRecently: bool('context.simChangedRecently', false),
      },
      label: {
        isFraud,
        ...(isFraud && typologyRaw ? { typology: typologyRaw as Typology } : {}),
      },
    };

    const velocityRaw = cell(row, mapping, 'payee.outboundVelocityRatio');
    const payeeVelocity =
      velocityRaw !== null && velocityRaw.trim() !== ''
        ? Math.max(0, Math.min(1, num('payee.outboundVelocityRatio', 0)))
        : null;
    const firstSeenRaw = cell(row, mapping, 'payee.firstSeenMs');
    const payeeFirstSeen = firstSeenRaw !== null && firstSeenRaw.trim() !== '' ? time('payee.firstSeenMs', ts) : null;

    drafts.push({
      txn,
      order,
      payeeVelocity,
      payeeFirstSeen,
      confirmedMule: bool('payee.confirmedMule', false),
      balance,
    });
    order += 1;
  }

  // --- order by time, stably -------------------------------------------
  drafts.sort((a, b) => a.txn.ts - b.txn.ts || a.order - b.order);

  // --- forward pass: beneficiary history and first appearances ----------
  const payees = new Map<string, ImportedPayee>();
  const intel: ImportedIntel[] = [];
  const intelSeen = new Set<string>();
  const payerPayees = new Map<string, Map<string, Millis>>();
  const perPayerCount = new Map<string, number>();
  const balances: Record<string, Paise> = { ...creditBalances };
  const balanceBefore: Record<string, Paise> = {};
  let repeats = 0;

  for (const d of drafts) {
    const { txn } = d;
    const existing = payees.get(txn.payeeId);
    if (existing) {
      if (d.payeeFirstSeen !== null) existing.firstSeenMs = Math.min(existing.firstSeenMs, d.payeeFirstSeen) as Millis;
      if (d.payeeVelocity !== null) existing.outboundVelocityRatio = d.payeeVelocity;
    } else {
      payees.set(txn.payeeId, {
        payeeId: txn.payeeId,
        name: txn.payeeName,
        firstSeenMs: (d.payeeFirstSeen ?? txn.ts) as Millis,
        outboundVelocityRatio: d.payeeVelocity ?? 0,
      });
    }

    if (d.confirmedMule && !intelSeen.has(txn.payeeId)) {
      intel.push({ ts: txn.ts, payeeId: txn.payeeId });
      intelSeen.add(txn.payeeId);
    }

    // Beneficiary novelty: when this payer first paid this beneficiary. Set
    // from the file's own history rather than asserted, so the first payment
    // to a beneficiary reads as new and later ones read as established.
    let known = payerPayees.get(txn.payerId);
    if (!known) {
      known = new Map();
      payerPayees.set(txn.payerId, known);
    }
    const firstPaid = known.get(txn.payeeId);
    if (firstPaid === undefined) {
      known.set(txn.payeeId, txn.ts);
      txn.context.beneficiaryAddedAtMs = null;
    } else {
      repeats += 1;
      txn.context.beneficiaryAddedAtMs = firstPaid;
    }

    perPayerCount.set(txn.payerId, (perPayerCount.get(txn.payerId) ?? 0) + 1);
    if (d.balance !== null) {
      balances[txn.payerId] = d.balance;
      balanceBefore[txn.txnId] = (d.balance + txn.amountPaise) as Paise;
    }
  }

  // --- report ------------------------------------------------------------
  const transactions = drafts.map((d) => d.txn);
  const labelled = supplied.has('label.isFraud');
  const fraudCount = transactions.filter((t) => t.label.isFraud).length;
  const counts = [...perPayerCount.values()].sort((a, b) => a - b);
  const median = counts.length === 0 ? 0 : counts[Math.floor(counts.length / 2)]!;

  const quiet: ImportReport['quiet'] = [];
  const substituted: ImportReport['substituted'] = [];
  for (const f of FIELDS) {
    if (supplied.has(f.path) || !f.whenMissing) continue;
    const entry = { path: f.path, label: f.label, note: f.whenMissing.note };
    if (f.whenMissing.quiet) quiet.push(entry);
    else substituted.push(entry);
  }

  const warnings: string[] = [];
  const quietSession = quiet.filter((q) => q.path.startsWith('context.')).length;
  if (quietSession >= 5) {
    warnings.push(
      'This file carries no session context, so the engine sees every payment as if the attacker had suppressed every indicator they control: no call, no urgency, a typed identifier, a trusted device. That is the hardest position for the model and the weakest one in the adversarial report. Detection here is a floor, not a representative figure.',
    );
  }
  if (!supplied.has('payee.outboundVelocityRatio')) {
    warnings.push(
      'No beneficiary onward-velocity column, so the fan-in signal cannot separate a mule from a busy merchant. That signal is the most specific mule indicator the engine has.',
    );
  }
  const repeatRate = transactions.length === 0 ? 0 : repeats / transactions.length;
  if (transactions.length > 0 && repeatRate < 0.05) {
    warnings.push(
      `Beneficiaries almost never repeat in this file (${(repeatRate * 100).toFixed(1)}% of payments go to someone the payer had paid before), so beneficiary novelty fires on nearly every row and carries little information.`,
    );
  }
  if (median > 0 && median < 10) {
    warnings.push(
      `Payers have a median of ${median} payment${median === 1 ? '' : 's'} each. Behavioural baselines need history; with this little, amount deviation and time-of-day surprisal are being measured against almost nothing.`,
    );
  }
  if (!labelled) {
    warnings.push('No ground-truth column, so the run reports what the engine decided but cannot report whether it was right.');
  } else if (fraudCount === 0) {
    warnings.push('The ground-truth column is present but no row is marked as fraud, so accuracy cannot be measured.');
  }

  const columnIssues: ColumnIssue[] = [...issues.values()]
    .map((i) => ({
      column: i.column,
      path: i.path,
      label: FIELDS_BY_PATH.get(i.path)?.label ?? i.path,
      count: i.count,
      samples: i.samples,
    }))
    .sort((a, b) => b.count - a.count);

  const rowsKept = transactions.length;
  return {
    transactions,
    payees: [...payees.values()],
    intel,
    balances,
    balanceBefore,
    report: {
      rowsRead,
      rowsKept,
      rowsSkipped: rowsRead - rowsKept,
      skipped,
      columnIssues,
      quiet,
      substituted,
      labelled,
      fraudCount,
      windowFromMs: (transactions[0]?.ts ?? base) as Millis,
      windowToMs: (transactions[transactions.length - 1]?.ts ?? base) as Millis,
      distinctPayers: perPayerCount.size,
      distinctPayees: payees.size,
      repeatBeneficiaryRate: repeatRate,
      medianPaymentsPerPayer: median,
      warnings,
      assumptions: [...assumptions],
    },
  };
}

/** Paths that leave an attacker-controllable indicator quiet when unmapped. */
export { QUIET_PATHS };

/** Convenience for callers holding rupee figures. */
export const rupees = toPaise;

/** Hours between two instants, for report formatting. */
export function hoursBetween(a: Millis, b: Millis): number {
  return (b - a) / HOUR_MS;
}
