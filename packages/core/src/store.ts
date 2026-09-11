import { AuditLedger } from './ledger.js';
import { emptyPayeeProfile, emptyPayerProfile } from './profiles.js';
import type { LedgerEntry, LedgerRecord } from './ledger.js';
import type { HoldRecord, Millis, PayeeProfile, PayerProfile, Transaction } from './types.js';

/**
 * State access for the interception path.
 *
 * The interface is deliberately synchronous. A real-time authorisation decision
 * has a budget measured in single-digit milliseconds, and twelve signals each
 * making a database round trip would spend that budget several times over
 * before any arithmetic happened. Production fraud engines hold hot profile
 * state in memory for exactly this reason.
 *
 * Durability is therefore layered behind the working set rather than in front
 * of it: a persistent backing hydrates into memory at startup and receives
 * writes asynchronously through a PersistenceSink, so the decision path never
 * waits on the database. That arrangement is what lets the audit ledger be
 * durable without the interceptor being slow.
 */
export interface Store {
  getPayer(payerId: string): PayerProfile | undefined;
  /** Resolve a payer profile, creating an empty one if this is their first payment. */
  ensurePayer(payerId: string, firstSeenMs: Millis): PayerProfile;
  putPayer(profile: PayerProfile): void;

  getPayee(payeeId: string): PayeeProfile | undefined;
  ensurePayee(payeeId: string, payeeVpa: string, firstSeenMs: Millis): PayeeProfile;
  putPayee(profile: PayeeProfile): void;

  /** Payer transactions at or after a cutoff, most recent first. */
  recentPayerTxns(payerId: string, sinceMs: Millis): Transaction[];
  recordTransaction(txn: Transaction): void;

  holdsForPayer(payerId: string): HoldRecord[];
  getHold(holdId: string): HoldRecord | undefined;
  putHold(hold: HoldRecord): void;

  readonly ledger: AuditLedger;
  appendLedger(entry: LedgerEntry, ts: Millis): LedgerRecord;
}

/**
 * Receives writes after the decision has already been returned.
 *
 * Implementations must not throw into the caller: a persistence failure is an
 * operational incident, not a reason to fail an authorisation that has already
 * been decided.
 */
export interface PersistenceSink {
  onPayer?(profile: PayerProfile): void;
  onPayee?(profile: PayeeProfile): void;
  onTransaction?(txn: Transaction): void;
  onHold?(hold: HoldRecord): void;
  onLedgerRecord?(record: LedgerRecord): void;
}

/** How many recent transactions are retained per payer for windowed signals. */
export const PAYER_TXN_RETENTION = 64;

/**
 * In-memory store.
 *
 * This is the reference implementation and the one the replay harness and the
 * test suite use, because it is deterministic and needs no external service.
 * A durable implementation supplies the same interface and forwards writes to a
 * PersistenceSink.
 */
export class MemoryStore implements Store {
  private payers = new Map<string, PayerProfile>();
  private payees = new Map<string, PayeeProfile>();
  private payerTxns = new Map<string, Transaction[]>();
  private holds = new Map<string, HoldRecord>();
  private holdsByPayer = new Map<string, Set<string>>();
  readonly ledger = new AuditLedger();

  constructor(private readonly sink?: PersistenceSink) {}

  getPayer(payerId: string): PayerProfile | undefined {
    return this.payers.get(payerId);
  }

  ensurePayer(payerId: string, firstSeenMs: Millis): PayerProfile {
    const existing = this.payers.get(payerId);
    if (existing) return existing;
    const created = emptyPayerProfile(payerId, firstSeenMs);
    this.payers.set(payerId, created);
    return created;
  }

  putPayer(profile: PayerProfile): void {
    this.payers.set(profile.payerId, profile);
    this.sink?.onPayer?.(profile);
  }

  getPayee(payeeId: string): PayeeProfile | undefined {
    return this.payees.get(payeeId);
  }

  ensurePayee(payeeId: string, payeeVpa: string, firstSeenMs: Millis): PayeeProfile {
    const existing = this.payees.get(payeeId);
    if (existing) return existing;
    const created = emptyPayeeProfile(payeeId, payeeVpa, firstSeenMs);
    this.payees.set(payeeId, created);
    return created;
  }

  putPayee(profile: PayeeProfile): void {
    this.payees.set(profile.payeeId, profile);
    this.sink?.onPayee?.(profile);
  }

  recentPayerTxns(payerId: string, sinceMs: Millis): Transaction[] {
    const all = this.payerTxns.get(payerId);
    if (!all) return [];
    const out: Transaction[] = [];
    // Stored oldest-first; walk backwards and stop once past the cutoff.
    for (let i = all.length - 1; i >= 0; i--) {
      const t = all[i]!;
      if (t.ts < sinceMs) break;
      out.push(t);
    }
    return out;
  }

  recordTransaction(txn: Transaction): void {
    const list = this.payerTxns.get(txn.payerId) ?? [];
    list.push(txn);
    if (list.length > PAYER_TXN_RETENTION) list.splice(0, list.length - PAYER_TXN_RETENTION);
    this.payerTxns.set(txn.payerId, list);
    this.sink?.onTransaction?.(txn);
  }

  holdsForPayer(payerId: string): HoldRecord[] {
    const ids = this.holdsByPayer.get(payerId);
    if (!ids) return [];
    const out: HoldRecord[] = [];
    for (const id of ids) {
      const h = this.holds.get(id);
      if (h) out.push(h);
    }
    return out;
  }

  getHold(holdId: string): HoldRecord | undefined {
    return this.holds.get(holdId);
  }

  putHold(hold: HoldRecord): void {
    this.holds.set(hold.holdId, hold);
    const ids = this.holdsByPayer.get(hold.payerId) ?? new Set<string>();
    ids.add(hold.holdId);
    this.holdsByPayer.set(hold.payerId, ids);
    this.sink?.onHold?.(hold);
  }

  appendLedger(entry: LedgerEntry, ts: Millis): LedgerRecord {
    const record = this.ledger.append(entry, ts);
    this.sink?.onLedgerRecord?.(record);
    return record;
  }

  /** Every hold, for portfolio reporting. */
  allHolds(): HoldRecord[] {
    return [...this.holds.values()];
  }

  /** Every beneficiary profile, for the mule graph view. */
  allPayees(): PayeeProfile[] {
    return [...this.payees.values()];
  }

  /** Every payer profile. */
  allPayers(): PayerProfile[] {
    return [...this.payers.values()];
  }

  /** Counts, for the operations header. */
  stats(): { payers: number; payees: number; holds: number; ledgerRecords: number } {
    return {
      payers: this.payers.size,
      payees: this.payees.size,
      holds: this.holds.size,
      ledgerRecords: this.ledger.length,
    };
  }
}
