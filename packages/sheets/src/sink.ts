/**
 * Write-behind persistence of the audit trail to a Google Sheet.
 *
 * This implements `PersistenceSink` from @kreaton/core, which is the interface
 * the engine hands writes to *after* a decision has already been returned.
 * That placement is the whole design. An authorisation has a budget measured
 * in single-digit milliseconds; a Sheets append takes hundreds of them. Put it
 * in front of the decision and the engine is no longer real time. Put it
 * behind, and the decision path never waits on the network while the record
 * still lands durably.
 *
 * Three consequences follow, and all three are deliberate:
 *
 *   - **Nothing here may throw into the caller.** A persistence failure is an
 *     operational incident, not a reason to fail an authorisation that has
 *     already been made. Errors are counted and reported through `onError`.
 *   - **Writes are batched.** Google allows roughly sixty write requests per
 *     minute per user. A replay at sixty payments a second would exhaust that
 *     in one second. Rows are buffered and flushed on an interval or when the
 *     buffer fills, which turns a per-payment cost into a per-interval one.
 *   - **Hot profile state is not written.** Payer and beneficiary profiles
 *     change on every payment and are rebuilt from the transaction history
 *     anyway. Copying them to a spreadsheet would spend the entire quota on
 *     data nobody reads. What goes to the sheet is the part worth keeping: the
 *     sealed ledger, the decisions, and the holds.
 */

import type {
  HoldRecord,
  LedgerEntry,
  LedgerRecord,
  PayeeProfile,
  PayerProfile,
  PersistenceSink,
  Transaction,
} from '@kreaton/core';
import { SheetsClient, SheetsError } from './client.js';
import type { SheetsClientOptions } from './client.js';

export const TABS = {
  ledger: 'ledger',
  transactions: 'transactions',
  holds: 'holds',
} as const;

export const HEADERS: Record<string, readonly string[]> = {
  [TABS.ledger]: ['seq', 'ts', 'kind', 'txnId', 'decision', 'calibratedP', 'reasonCodes', 'prevHash', 'hash'],
  [TABS.transactions]: [
    'txnId', 'ts', 'payerId', 'payerVpa', 'payeeId', 'payeeVpa', 'payeeName', 'amountPaise',
    'channel', 'deviceId', 'activeCall', 'activeCallSeconds', 'screenShare', 'remoteAccess',
    'appSwitches', 'secondsToAuthorize', 'vpaEnteredBy', 'isNewDevice', 'simChangedRecently',
  ],
  [TABS.holds]: [
    'holdId', 'txnId', 'payerId', 'payeeId', 'amountPaise', 'state', 'challengeType',
    'openedAtMs', 'expiresAtMs', 'resolvedAtMs', 'attemptsUsed', 'attemptBudget', 'linkedAttempts',
  ],
};

export interface SheetsSinkOptions extends SheetsClientOptions {
  /** How long rows may wait before being sent. Default 5s. */
  flushIntervalMs?: number;
  /** Flush as soon as a tab holds this many rows. Default 400. */
  maxBufferedRows?: number;
  /** Hard ceiling on rows held while the network is unavailable. Default 20,000. */
  maxQueuedRows?: number;
  /** Called for every failure. Never throws into the engine. */
  onError?: (error: unknown) => void;
  /** Write the full transaction alongside the ledger entry. Default true. */
  writeTransactions?: boolean;
}

export interface SinkStats {
  buffered: number;
  written: number;
  failed: number;
  dropped: number;
  lastFlushAtMs: number | null;
  lastError: string | null;
}

type Row = Array<string | number | boolean>;

/**
 * Flatten a ledger entry into the four columns the sheet summarises it by.
 *
 * A `LedgerEntry` is a discriminated union and only some arms carry a payment,
 * a decision or a probability — on an `ASSESSMENT` they sit one level down,
 * under `assessment`, not at the top. Reading them off the entry directly
 * produced a ledger tab with empty columns for every real decision, which the
 * unit tests missed because their fixture invented a flat shape the engine
 * never emits. The tests now build entries the same way the engine does.
 */
function summarise(entry: LedgerEntry): {
  txnId: string;
  decision: string;
  calibratedP: number | '';
  reasons: string;
} {
  switch (entry.kind) {
    case 'ASSESSMENT':
      return {
        txnId: entry.assessment.txnId,
        decision: entry.assessment.decision,
        calibratedP: entry.assessment.calibratedP,
        reasons: entry.assessment.reasonCodes.join(' '),
      };
    case 'HOLD_OPENED':
      return { txnId: entry.txnId, decision: entry.challengeType, calibratedP: '', reasons: entry.holdId };
    case 'HOLD_RESOLVED':
      return { txnId: entry.txnId, decision: entry.state, calibratedP: '', reasons: entry.holdId };
    case 'ATTEMPT_LINKED':
      return { txnId: entry.txnId, decision: entry.disposition, calibratedP: '', reasons: entry.holdId };
    case 'POLICY_CHANGED':
      return { txnId: '', decision: 'POLICY_CHANGED', calibratedP: '', reasons: entry.changedBy };
    case 'MODEL_LOADED':
      return { txnId: '', decision: entry.version, calibratedP: '', reasons: entry.modelHash };
    default:
      return { txnId: '', decision: '', calibratedP: '', reasons: '' };
  }
}

export class GoogleSheetsSink implements PersistenceSink {
  private readonly client: SheetsClient;
  private readonly buffers = new Map<string, Row[]>();
  private readonly flushIntervalMs: number;
  private readonly maxBufferedRows: number;
  private readonly maxQueuedRows: number;
  private readonly onError: (error: unknown) => void;
  private readonly writeTransactions: boolean;

  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private ready: Promise<void> | null = null;
  private written = 0;
  private failed = 0;
  private dropped = 0;
  private lastFlushAtMs: number | null = null;
  private lastError: string | null = null;

  constructor(opts: SheetsSinkOptions) {
    this.client = new SheetsClient(opts);
    this.flushIntervalMs = opts.flushIntervalMs ?? 5_000;
    this.maxBufferedRows = opts.maxBufferedRows ?? 400;
    this.maxQueuedRows = opts.maxQueuedRows ?? 20_000;
    this.writeTransactions = opts.writeTransactions ?? true;
    this.onError =
      opts.onError ??
      ((error) => {
        console.error('[kreaton/sheets]', error instanceof Error ? error.message : error);
      });
  }

  /**
   * Create the tabs and write their header rows, once.
   *
   * Safe to call repeatedly; the work happens on the first call and later
   * callers await the same promise.
   */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const created = await this.client.ensureTabs(Object.values(TABS));
      for (const tab of created) {
        const header = HEADERS[tab];
        if (header) await this.client.append(tab, [[...header]]);
      }
    })().catch((error: unknown) => {
      this.note(error);
      // A failed setup must not poison the sink forever: clear it so a later
      // call can try again once whatever was wrong has been fixed.
      this.ready = null;
      throw error;
    });

    if (!this.timer) {
      this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
      // Never hold a process open for the sake of a flush timer.
      (this.timer as unknown as { unref?: () => void }).unref?.();
    }
    return this.ready;
  }

  // --- PersistenceSink ----------------------------------------------------

  onLedgerRecord(record: LedgerRecord): void {
    const { txnId, decision, calibratedP, reasons } = summarise(record.entry);
    this.push(TABS.ledger, [
      record.seq,
      record.ts,
      record.entry.kind,
      txnId,
      decision,
      calibratedP,
      reasons,
      record.prevHash,
      record.hash,
    ]);
  }

  onTransaction(txn: Transaction): void {
    if (!this.writeTransactions) return;
    const c = txn.context;
    this.push(TABS.transactions, [
      txn.txnId, txn.ts, txn.payerId, txn.payerVpa, txn.payeeId, txn.payeeVpa, txn.payeeName,
      txn.amountPaise, txn.channel, txn.deviceId, c.activeCall, c.activeCallSeconds,
      c.screenShareActive, c.remoteAccessAppRunning, c.appSwitchCount,
      c.secondsFromOpenToAuthorize, c.vpaEnteredBy, c.isNewDevice, c.simChangedRecently,
    ]);
  }

  onHold(hold: HoldRecord): void {
    this.push(TABS.holds, [
      hold.holdId,
      hold.txnId,
      hold.payerId,
      hold.payeeId,
      hold.amountPaise,
      hold.state,
      hold.challengeType,
      hold.openedAtMs,
      hold.expiresAtMs,
      hold.resolvedAtMs ?? '',
      hold.attemptsUsed,
      hold.attemptBudget,
      hold.linkedAttempts.join(' '),
    ]);
  }

  /**
   * Profiles are not persisted here.
   *
   * They are hot working state, rewritten on every payment and reconstructible
   * from the transaction history. Sending them would spend the whole write
   * quota on rows nobody reads. The methods exist so the interface is
   * satisfied explicitly rather than by omission.
   */
  onPayer(_profile: PayerProfile): void {}
  onPayee(_profile: PayeeProfile): void {}

  // --- buffering ----------------------------------------------------------

  private push(tab: string, row: Row): void {
    let buffer = this.buffers.get(tab);
    if (!buffer) {
      buffer = [];
      this.buffers.set(tab, buffer);
    }
    buffer.push(row);
    if (this.queued() > this.maxQueuedRows) {
      // The network has been unavailable long enough that holding more rows
      // would be a memory leak. Drop the oldest and say how many, rather than
      // growing without bound or failing an authorisation.
      const excess = this.queued() - this.maxQueuedRows;
      buffer.splice(0, Math.min(excess, buffer.length));
      this.dropped += excess;
    }
    if (buffer.length >= this.maxBufferedRows) void this.flush();
  }

  private queued(): number {
    let n = 0;
    for (const b of this.buffers.values()) n += b.length;
    return n;
  }

  /**
   * Send everything buffered.
   *
   * Only one flush runs at a time; a call made while one is in flight awaits
   * it rather than starting a second, so rows cannot arrive out of order and
   * the quota cannot be doubled by concurrency.
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (this.queued() === 0) return;
    try {
      if (this.ready) await this.ready;
      else await this.start();
    } catch {
      return; // start() already reported it; the rows stay buffered.
    }

    for (const [tab, buffer] of this.buffers) {
      if (buffer.length === 0) continue;
      const batch = buffer.splice(0, buffer.length);
      try {
        this.written += await this.client.append(tab, batch);
        this.lastFlushAtMs = Date.now();
      } catch (error) {
        this.failed += batch.length;
        this.note(error);
        // A retryable failure keeps the rows for the next interval; anything
        // else (a bad key, a sheet that is not shared with the service
        // account) would fail identically forever, so the rows are let go
        // rather than accumulating behind a permanent error.
        if (error instanceof SheetsError && error.retryable) buffer.unshift(...batch);
        else this.dropped += batch.length;
      }
    }
  }

  /** Flush and stop the timer. Call on shutdown. */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  stats(): SinkStats {
    return {
      buffered: this.queued(),
      written: this.written,
      failed: this.failed,
      dropped: this.dropped,
      lastFlushAtMs: this.lastFlushAtMs,
      lastError: this.lastError,
    };
  }

  private note(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    try {
      this.onError(error);
    } catch {
      // An error handler that throws is not allowed to take the engine with it.
    }
  }
}
