import { hashObject } from './hash.js';
import { formatINR } from './money.js';
import { SIGNAL_SPECS } from './signals/specs.js';
import type {
  Action,
  Assessment,
  ChallengeType,
  HoldRecord,
  HoldState,
  Millis,
  Policy,
  Transaction,
} from './types.js';

/**
 * Auditable compliance explainability trail.
 *
 * Every decision the interceptor takes is written here as an append-only
 * record, and every record commits to the hash of the record before it. Editing
 * or removing any entry invalidates the digest of that entry and of every entry
 * after it, so the chain can be verified by a third party without trusting the
 * system that produced it. That is the difference between a log and an audit
 * trail.
 *
 * What a record has to contain is set by what a reviewer needs to answer
 * afterwards, which is not just what the score was but why that score justified
 * that action on that day:
 *
 *   - Every signal evaluated, including the ones that did not fire, with the
 *     raw measurement, the bin, and the exact log-odds it contributed. Omitting
 *     the quiet signals would make the record unfalsifiable.
 *   - The model version and digest, so the record identifies the exact weights
 *     that produced it.
 *   - The full policy in force, digested, because the same score justifies
 *     different actions under different trade-off settings and a record that
 *     cannot show the settings cannot defend the action.
 *   - The expected cost of every action considered, not only the chosen one.
 *   - The hold timeline and its outcome.
 *
 * Payer and beneficiary identifiers are masked on the way in. A compliance
 * trail needs to be queryable and retained; it does not need to be a second
 * copy of the customer database.
 */

export interface RedactedParty {
  /** Stable pseudonymous id, safe to use as a query key. */
  id: string;
  /** Partially masked virtual payment address, e.g. ra****@okhdfcbank. */
  maskedVpa: string;
}

function maskVpa(vpa: string): string {
  const [handle = '', domain = ''] = vpa.split('@');
  const head = handle.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(handle.length - 2, 0))}@${domain}`;
}

function redact(id: string, vpa: string): RedactedParty {
  return { id, maskedVpa: maskVpa(vpa) };
}

/** The transaction facts a reviewer needs, without carrying the payload wholesale. */
export interface RedactedTransaction {
  txnId: string;
  ts: Millis;
  amountPaise: number;
  payer: RedactedParty;
  payee: RedactedParty;
  payeeName: string;
  channel: string;
  deviceId: string;
}

export function redactTransaction(txn: Transaction): RedactedTransaction {
  return {
    txnId: txn.txnId,
    ts: txn.ts,
    amountPaise: txn.amountPaise,
    payer: redact(txn.payerId, txn.payerVpa),
    payee: redact(txn.payeeId, txn.payeeVpa),
    payeeName: txn.payeeName,
    channel: txn.channel,
    deviceId: txn.deviceId,
  };
}

// ---------------------------------------------------------------------------

export type LedgerEntry =
  | { kind: 'ASSESSMENT'; txn: RedactedTransaction; assessment: Assessment; policy: Policy }
  | {
      kind: 'HOLD_OPENED';
      holdId: string;
      txnId: string;
      challengeType: ChallengeType;
      rationale: string;
      disqualified: Array<{ type: ChallengeType; reason: string }>;
      expiresAtMs: Millis;
    }
  | {
      kind: 'HOLD_RESOLVED';
      holdId: string;
      txnId: string;
      state: HoldState;
      detail: string;
      heldMinutes: number;
    }
  | {
      kind: 'ATTEMPT_LINKED';
      holdId: string;
      txnId: string;
      disposition: string;
      explanation: string;
    }
  | { kind: 'POLICY_CHANGED'; before: Policy; after: Policy; changedBy: string; note: string }
  | { kind: 'MODEL_LOADED'; version: string; modelHash: string; fittedAt: string };

export interface LedgerRecord {
  seq: number;
  ts: Millis;
  prevHash: string;
  /** SHA-256 over { seq, ts, prevHash, entry } in canonical form. */
  hash: string;
  entry: LedgerEntry;
}

/** Digest standing in for the predecessor of the first record. */
export const GENESIS_HASH = '0'.repeat(64);

function digest(seq: number, ts: Millis, prevHash: string, entry: LedgerEntry): string {
  return hashObject({ seq, ts, prevHash, entry });
}

export interface LedgerQuery {
  txnId?: string;
  payerId?: string;
  payeeId?: string;
  decision?: Action;
  reasonCode?: string;
  kind?: LedgerEntry['kind'];
  fromMs?: Millis;
  toMs?: Millis;
  /** Minimum calibrated fraud probability, for assessment records. */
  minProbability?: number;
}

/**
 * Append-only hash-chained ledger.
 *
 * Held in memory behind the same interface a durable store implements, so the
 * chain logic is identical whichever backing is in use and can be tested
 * without one.
 */
export class AuditLedger {
  private records: LedgerRecord[] = [];

  /** Append an entry and return the sealed record. */
  append(entry: LedgerEntry, ts: Millis): LedgerRecord {
    const seq = this.records.length;
    const prevHash = seq === 0 ? GENESIS_HASH : this.records[seq - 1]!.hash;
    const record: LedgerRecord = {
      seq,
      ts,
      prevHash,
      hash: digest(seq, ts, prevHash, entry),
      entry,
    };
    this.records.push(record);
    return record;
  }

  get length(): number {
    return this.records.length;
  }

  /** Digest of the most recent record, which commits to the entire history. */
  get head(): string {
    return this.records.length === 0 ? GENESIS_HASH : this.records[this.records.length - 1]!.hash;
  }

  all(): readonly LedgerRecord[] {
    return this.records;
  }

  /**
   * Recompute every digest and confirm each record links to its predecessor.
   *
   * Returns the first sequence number at which the chain breaks, so a reviewer
   * can see exactly where history was altered rather than only that it was.
   */
  verify(): { valid: boolean; brokenAt: number | null; checked: number } {
    let prevHash = GENESIS_HASH;
    for (const r of this.records) {
      if (r.prevHash !== prevHash) return { valid: false, brokenAt: r.seq, checked: r.seq };
      const expected = digest(r.seq, r.ts, r.prevHash, r.entry);
      if (expected !== r.hash) return { valid: false, brokenAt: r.seq, checked: r.seq };
      prevHash = r.hash;
    }
    return { valid: true, brokenAt: null, checked: this.records.length };
  }

  /** Query the trail. Every filter is conjunctive. */
  query(q: LedgerQuery): LedgerRecord[] {
    return this.records.filter((r) => {
      if (q.kind && r.entry.kind !== q.kind) return false;
      if (q.fromMs !== undefined && r.ts < q.fromMs) return false;
      if (q.toMs !== undefined && r.ts > q.toMs) return false;

      const e = r.entry;
      if (q.txnId) {
        const txnId =
          e.kind === 'ASSESSMENT'
            ? e.txn.txnId
            : e.kind === 'HOLD_OPENED' || e.kind === 'HOLD_RESOLVED' || e.kind === 'ATTEMPT_LINKED'
              ? e.txnId
              : undefined;
        if (txnId !== q.txnId) return false;
      }
      if (q.payerId) {
        if (e.kind !== 'ASSESSMENT' || e.txn.payer.id !== q.payerId) return false;
      }
      if (q.payeeId) {
        if (e.kind !== 'ASSESSMENT' || e.txn.payee.id !== q.payeeId) return false;
      }
      if (q.decision) {
        if (e.kind !== 'ASSESSMENT' || e.assessment.decision !== q.decision) return false;
      }
      if (q.reasonCode) {
        if (e.kind !== 'ASSESSMENT' || !e.assessment.reasonCodes.includes(q.reasonCode)) {
          return false;
        }
      }
      if (q.minProbability !== undefined) {
        if (e.kind !== 'ASSESSMENT' || e.assessment.calibratedP < q.minProbability) return false;
      }
      return true;
    });
  }

  /** Every record touching one transaction, in order. Used for the case view. */
  caseFile(txnId: string): LedgerRecord[] {
    return this.query({ txnId });
  }

  /** Serialise to JSON Lines, the format the regulator export ships. */
  toJsonl(): string {
    return this.records.map((r) => JSON.stringify(r)).join('\n');
  }

  /** Rebuild from JSON Lines without re-sealing, so verification is meaningful. */
  static fromJsonl(jsonl: string): AuditLedger {
    const ledger = new AuditLedger();
    ledger.records = jsonl
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LedgerRecord);
    return ledger;
  }
}

// ---------------------------------------------------------------------------
// Regulator-facing rendering
// ---------------------------------------------------------------------------

/**
 * Render one held transaction as a narrative a compliance reviewer can read
 * without access to the system.
 *
 * The signal table is printed in contribution order and includes the arithmetic
 * that produced the score, because the model is additive in log-odds and the
 * contribution column therefore sums exactly to the score. A reviewer can check
 * the total by hand, which is the property that makes the explanation an
 * explanation rather than a summary.
 */
export function renderCaseNarrative(
  records: readonly LedgerRecord[],
  txnId: string,
): string {
  const relevant = records.filter((r) => {
    const e = r.entry;
    if (e.kind === 'ASSESSMENT') return e.txn.txnId === txnId;
    if (e.kind === 'HOLD_OPENED' || e.kind === 'HOLD_RESOLVED' || e.kind === 'ATTEMPT_LINKED') {
      return e.txnId === txnId;
    }
    return false;
  });

  const assessmentRecord = relevant.find((r) => r.entry.kind === 'ASSESSMENT');
  if (!assessmentRecord || assessmentRecord.entry.kind !== 'ASSESSMENT') {
    return `No assessment recorded for transaction ${txnId}.`;
  }
  const { txn, assessment, policy } = assessmentRecord.entry;

  const lines: string[] = [];
  lines.push(`# Compliance record: ${txn.txnId}`);
  lines.push('');
  lines.push(`- Ledger sequence: ${assessmentRecord.seq}`);
  lines.push(`- Record digest: ${assessmentRecord.hash}`);
  lines.push(`- Previous digest: ${assessmentRecord.prevHash}`);
  lines.push(`- Timestamp: ${new Date(txn.ts).toISOString()}`);
  lines.push(`- Amount: ${formatINR(txn.amountPaise, { paise: true })}`);
  lines.push(`- Payer: ${txn.payer.maskedVpa}`);
  lines.push(`- Beneficiary: ${txn.payee.maskedVpa} registered as ${txn.payeeName}`);
  lines.push(`- Model: ${assessment.modelVersion} (${assessment.modelHash.slice(0, 12)})`);
  lines.push(`- Policy digest: ${assessment.policyHash.slice(0, 12)}`);
  lines.push('');

  lines.push('## Decision');
  lines.push('');
  lines.push(`**${assessment.decision}** at a calibrated fraud probability of ${(assessment.calibratedP * 100).toFixed(2)}%.`);
  lines.push('');
  lines.push('| Action | Expected liability | Expected friction | Expected total |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const action of ['APPROVE', 'STEP_UP', 'BLOCK'] as const) {
    const c = assessment.economics.byAction[action];
    const marker = action === assessment.decision ? ' **(chosen)**' : '';
    lines.push(
      `| ${action}${marker} | ${formatINR(c.expectedLiabilityPaise)} | ${formatINR(c.expectedFrictionPaise)} | ${formatINR(c.expectedTotalPaise)} |`,
    );
  }
  lines.push('');
  lines.push(
    `The chosen action was cheaper than the next best by ${formatINR(assessment.economics.marginPaise)} in expectation.`,
  );
  lines.push('');

  lines.push('## Evidence');
  lines.push('');
  lines.push(
    `Base rate log-odds ${assessment.priorLogOdds.toFixed(4)} plus the contributions below give a fused score of ${assessment.fusedLogOdds.toFixed(4)}.`,
  );
  lines.push('');
  lines.push('| Signal | Measured | Bin | LLR | Weight | Shrinkage | Contribution | Reason |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  const ordered = [...assessment.signals].sort((a, b) => b.contribution - a.contribution);
  for (const s of ordered) {
    lines.push(
      `| ${SIGNAL_SPECS[s.id].label} | ${s.raw.toFixed(3)} ${SIGNAL_SPECS[s.id].unit} | ${s.bin} | ${s.llr.toFixed(4)} | ${s.weight.toFixed(3)} | ${s.shrinkage.toFixed(3)} | ${s.contribution >= 0 ? '+' : ''}${s.contribution.toFixed(4)} | ${s.fired ? s.reasonCode : '-'} |`,
    );
  }
  lines.push('');
  lines.push('### Findings');
  lines.push('');
  for (const s of ordered.filter((x) => x.fired)) {
    lines.push(`- **${SIGNAL_SPECS[s.id].label}** (${s.reasonCode}): ${s.evidence}`);
  }
  if (!ordered.some((x) => x.fired)) lines.push('- No signal reached the reporting threshold.');
  lines.push('');

  lines.push('## Recoverability assumption');
  lines.push('');
  lines.push(
    `Had this payment settled and been reported after the policy lag of ${policy.reportLagMinutes} minutes, an estimated ${(assessment.recovery.fractionAtHorizon * 100).toFixed(1)}% of value would still have been freezable, based on the ${assessment.recovery.method === 'monte_carlo' ? 'lognormal Monte Carlo' : 'closed-form Markov'} chain model with an expected ${assessment.recovery.expectedHops.toFixed(2)} onward hops.`,
  );
  lines.push('');

  const holdRecords = relevant.filter(
    (r) =>
      r.entry.kind === 'HOLD_OPENED' ||
      r.entry.kind === 'HOLD_RESOLVED' ||
      r.entry.kind === 'ATTEMPT_LINKED',
  );
  if (holdRecords.length > 0) {
    lines.push('## Hold');
    lines.push('');
    for (const r of holdRecords) {
      const e = r.entry;
      const at = new Date(r.ts).toISOString();
      if (e.kind === 'HOLD_OPENED') {
        lines.push(`- ${at} — challenge **${e.challengeType}** issued. ${e.rationale}`);
        for (const d of e.disqualified) {
          lines.push(`  - Ruled out ${d.type}: ${d.reason}`);
        }
      } else if (e.kind === 'ATTEMPT_LINKED') {
        lines.push(`- ${at} — further attempt ${e.txnId}: ${e.explanation}`);
      } else if (e.kind === 'HOLD_RESOLVED') {
        lines.push(`- ${at} — **${e.state}** after ${e.heldMinutes} minutes. ${e.detail}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Minutes a hold was open, for the resolution record. */
export function heldMinutes(hold: HoldRecord, now: Millis): number {
  return Math.round(((hold.resolvedAtMs ?? now) - hold.openedAtMs) / 60_000);
}
