'use client';

import {
  DEFAULT_POLICY,
  Interceptor,
  MemoryStore,
  POLICY_PRESETS,
  RecoveryModel,
  hourHistogramFromCounts,
  policyDigest,
  refreshPayeeWindow,
} from '@kreaton/core';
import type {
  AuthorizationResult,
  HoldOutcome,
  HoldRecord,
  LabelledTransaction,
  Millis,
  ModelSpec,
  PayeeProfile,
  Policy,
  PolicySample,
  Transaction,
} from '@kreaton/core';
import type { ImportReport, ImportedDataset } from '@kreaton/ingest';
import { loadData } from './data';
import { clearSession, loadSession, saveSession } from './persist';
import type { IntelEvent, Slice, SlicePayee } from './data';
import { buildScenario, scenarioById } from './scenarios';

/**
 * The console session.
 *
 * One engine instance lives in the browser tab and every page reads from it.
 * The same compiled @kreaton/core that runs in the server route handler runs
 * here, against the committed slice and the profile snapshots the seed script
 * shipped with it, so what the console shows is what the engine does and not a
 * rendering of precomputed results.
 *
 * State is held outside React and exposed through a subscribe/snapshot pair
 * for useSyncExternalStore, because the engine mutates its store in place and
 * the feed advances many times a second.
 */

export interface Decision {
  seq: number;
  txn: LabelledTransaction;
  result: AuthorizationResult;
  /** Scenario id when the payment was injected rather than replayed. */
  injected?: string;
}

export type SessionStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Which corpus the session is replaying.
 *
 * The console ships with a slice of the generated corpus, and an operator can
 * replace it with a file of their own. Everything downstream — the feed, the
 * assessment panel, the ledger, the policy studio — reads whichever is
 * loaded, so the distinction is recorded here once and surfaced wherever a
 * figure could be mistaken for a measurement of the shipped corpus.
 */
export interface DatasetInfo {
  kind: 'shipped' | 'imported';
  /** What to call it on screen. */
  name: string;
  /** Present only for an imported file. */
  report: ImportReport | null;
}

export const SHIPPED_DATASET: DatasetInfo = {
  kind: 'shipped',
  name: 'Generated corpus, four-hour slice',
  report: null,
};

export interface SessionSnapshot {
  status: SessionStatus;
  error: string | null;
  model: ModelSpec | null;
  slice: Slice | null;
  dataset: DatasetInfo;
  cursor: number;
  total: number;
  playing: boolean;
  /** Payments per second while playing. */
  speed: number;
  decisions: readonly Decision[];
  policy: Policy;
  policyId: string;
  policyHash: string;
  selectedTxnId: string | null;
  /** Latest engine clock, i.e. the timestamp of the most recent payment. */
  clockMs: Millis;
  /** Bumped on every change so consumers can memoise on it. */
  version: number;
}

/** Same delayed-intelligence logic as the replay harness in packages/sim. */
class IntelTimeline {
  private cursor = 0;
  private readonly events: IntelEvent[];
  private known = new Map<string, { confirmed: boolean; hopDistance: number }>();

  constructor(events: readonly IntelEvent[]) {
    this.events = [...events].sort((a, b) => a.ts - b.ts);
  }

  advanceTo(now: Millis): void {
    while (this.cursor < this.events.length && this.events[this.cursor]!.ts <= now) {
      const e = this.events[this.cursor]!;
      const current = this.known.get(e.payeeId);
      const hopDistance = current ? Math.min(current.hopDistance, e.hopDistance) : e.hopDistance;
      this.known.set(e.payeeId, {
        confirmed: (current?.confirmed ?? false) || e.hopDistance === 0,
        hopDistance,
      });
      this.cursor += 1;
    }
  }

  lookup(payeeId: string): { confirmed: boolean; hopDistance: number | null } {
    const k = this.known.get(payeeId);
    if (!k) return { confirmed: false, hopDistance: null };
    return { confirmed: k.confirmed, hopDistance: k.hopDistance === 0 ? null : k.hopDistance };
  }
}

const DAY_MS = 86_400_000;

/**
 * Present an imported dataset in the shape the console already replays.
 *
 * The warm state is deliberately empty. A slice of the generated corpus ships
 * with snapshots of who every payer was before the window opened; an imported
 * file has no such history, and inventing one would be fabricating the
 * baseline every behavioural signal is measured against.
 */
function sliceFromImport(dataset: ImportedDataset, name: string): Slice {
  return {
    generatedAt: new Date().toISOString(),
    modelVersion: 'imported',
    note: `Imported from ${name}.`,
    windowFromMs: dataset.report.windowFromMs,
    windowToMs: dataset.report.windowToMs,
    transactions: dataset.transactions,
    payees: dataset.payees.map((p) => ({
      payeeId: p.payeeId,
      name: p.name,
      kind: 'personal' as const,
      outboundVelocityRatio: p.outboundVelocityRatio,
      firstSeenMs: p.firstSeenMs,
      chainId: null,
      layer: null,
    })),
    // A confirmed beneficiary is its own chain of one: the file asserts that
    // this account is a collection account, and nothing about who it pays on.
    intel: dataset.intel.map((e) => ({
      ts: e.ts,
      payeeId: e.payeeId,
      chainId: `imported_${e.payeeId}`,
      hopDistance: 0,
    })),
    warm: { payers: [], payees: [], recentTxns: [] },
  };
}

class ConsoleSession {
  private listeners = new Set<() => void>();
  private snapshot: SessionSnapshot;
  private store = new MemoryStore();
  private interceptor: Interceptor | null = null;
  private intel = new IntelTimeline([]);
  private attributes = new Map<string, SlicePayee>();
  private decisions: Decision[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private loadPromise: Promise<void> | null = null;
  private version = 0;
  /** Payers already used as scenario victims, so each episode gets a clean baseline. */
  private usedVictims = new Set<string>();
  /** The shipped slice, kept so an import can be undone without refetching. */
  private shippedSlice: Slice | null = null;
  /** Observed pre-payment balances from an import, keyed by payment reference. */
  private balanceBefore: Record<string, number> = {};
  /** The imported dataset itself, kept so it can be written to local storage. */
  private importedDataset: ImportedDataset | null = null;
  /** Debounce handle for saving the replay position. */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.snapshot = {
      status: 'idle',
      error: null,
      model: null,
      slice: null,
      dataset: SHIPPED_DATASET,
      cursor: 0,
      total: 0,
      playing: false,
      speed: 6,
      decisions: [],
      policy: DEFAULT_POLICY,
      policyId: 'balanced',
      policyHash: policyDigest(DEFAULT_POLICY),
      selectedTxnId: null,
      clockMs: 0,
      version: 0,
    };
  }

  // --- External store contract --------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  private emit(patch: Partial<SessionSnapshot>): void {
    this.version += 1;
    this.snapshot = { ...this.snapshot, ...patch, decisions: this.decisions, version: this.version };
    for (const l of this.listeners) l();
  }

  // --- Lifecycle ----------------------------------------------------------

  /** Load the slice and model once. Safe to call from every page. */
  ensureLoaded(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.emit({ status: 'loading' });
    this.loadPromise = loadData()
      .then(async ({ model, slice }) => {
        this.shippedSlice = slice;
        this.boot(model, slice, SHIPPED_DATASET);

        // A dataset the operator imported on an earlier visit outranks the
        // shipped corpus: they chose it, and losing it to a refresh is the
        // thing this exists to prevent. Replaying to the cursor they had
        // reached reproduces exactly the state that was lost, because the
        // replay is deterministic.
        const saved = await loadSession();
        if (!saved) return;
        this.loadImported(saved.dataset, saved.name, { persist: false });
        if (saved.cursor > 0) this.step(saved.cursor);
      })
      .catch((error: unknown) => {
        this.emit({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      });
    return this.loadPromise;
  }

  private boot(model: ModelSpec, slice: Slice, dataset: DatasetInfo = this.snapshot.dataset): void {
    this.store = new MemoryStore();
    this.decisions = [];
    this.usedVictims = new Set();
    this.scratchSamples = null;
    this.intel = new IntelTimeline(slice.intel);
    this.attributes = new Map(slice.payees.map((p) => [p.payeeId, p]));

    // Hydrate the engine with the state it had at the start of the window.
    for (const p of slice.warm.payers) {
      this.store.putPayer({ ...p, hourHistogram: hourHistogramFromCounts(p.hourCounts) });
    }
    for (const p of slice.warm.payees) this.store.putPayee(p);
    for (const r of slice.warm.recentTxns) {
      // Only the timestamp and amount are ever read from prior-day history.
      this.store.recordTransaction({
        txnId: `prior_${r.payerId}_${r.ts}`,
        ts: r.ts,
        payerId: r.payerId,
        payerVpa: '',
        payeeId: '',
        payeeVpa: '',
        payeeName: '',
        amountPaise: r.amountPaise,
        channel: 'p2p',
        deviceId: '',
        ipHash: '',
        simSerialHash: '',
        context: {
          activeCall: false,
          activeCallSeconds: 0,
          screenShareActive: false,
          remoteAccessAppRunning: false,
          appSwitchCount: 0,
          secondsFromOpenToAuthorize: 0,
          vpaEnteredBy: 'typed',
          beneficiaryAddedAtMs: null,
          sessionId: '',
          isNewDevice: false,
          deviceBoundAtMs: 0,
          simChangedRecently: false,
        },
      });
    }
    // Intelligence known before the window opened is already folded into the
    // snapshotted beneficiary profiles; advance past it so it is not reapplied.
    this.intel.advanceTo(slice.windowFromMs - 1);

    const policy = this.snapshot.policy;
    this.interceptor = new Interceptor({
      model,
      policy,
      store: this.store,
      recovery: new RecoveryModel({
        params: model.recovery,
        freezeLatencyMinutes: policy.freezeLatencyMinutes,
        seed: 'console',
      }),
    });

    this.emit({
      status: 'ready',
      error: null,
      model,
      slice,
      dataset,
      cursor: 0,
      total: slice.transactions.length,
      clockMs: slice.windowFromMs,
      selectedTxnId: null,
    });
  }

  // --- Imported datasets --------------------------------------------------

  /**
   * Replace the replayed corpus with a file the operator supplied.
   *
   * The engine is rebuilt from nothing: no warm profiles, no prior
   * intelligence. That is the honest starting position for a file whose past
   * the console has never seen, and it means the first payments from each
   * payer are scored against a baseline that is still forming. The import
   * report says as much, and the console repeats it beside the figures.
   */
  loadImported(dataset: ImportedDataset, name: string, opts: { persist?: boolean } = {}): void {
    this.pause();
    const { model } = this.snapshot;
    if (!model) return;
    this.balanceBefore = dataset.balanceBefore;
    this.importedDataset = dataset;
    this.boot(model, sliceFromImport(dataset, name), {
      kind: 'imported',
      name,
      report: dataset.report,
    });
    if (opts.persist !== false) void this.persist();
  }

  /**
   * Keep the imported dataset and the replay position on this device.
   *
   * Fire and forget: persistence is a convenience, and a browser that refuses
   * to store anything is not a reason for the console to behave differently.
   */
  private persist(): void {
    const { dataset, cursor, policyId } = this.snapshot;
    if (dataset.kind !== 'imported' || !this.importedDataset) return;
    void saveSession({
      name: dataset.name,
      dataset: this.importedDataset,
      cursor,
      policyId,
      savedAtMs: Date.now(),
    });
  }

  /** Go back to the corpus slice the console ships with. */
  restoreShipped(): void {
    this.pause();
    this.balanceBefore = {};
    this.importedDataset = null;
    void clearSession();
    const { model } = this.snapshot;
    if (!model || !this.shippedSlice) return;
    this.boot(model, this.shippedSlice, SHIPPED_DATASET);
  }

  /** Rewind to the start of the window under the current policy. */
  reset(): void {
    this.pause();
    const { model, slice } = this.snapshot;
    if (model && slice) this.boot(model, slice);
  }

  // --- Playback -----------------------------------------------------------

  play(): void {
    if (this.snapshot.playing || this.snapshot.status !== 'ready') return;
    this.emit({ playing: true });
    this.schedule();
  }

  pause(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.snapshot.playing) this.emit({ playing: false });
  }

  setSpeed(speed: number): void {
    this.emit({ speed: Math.max(1, Math.min(60, speed)) });
    if (this.snapshot.playing) this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    const perTick = Math.max(1, Math.round(this.snapshot.speed / 10));
    this.timer = setInterval(() => {
      const advanced = this.step(perTick);
      if (advanced === 0) this.pause();
    }, 100);
  }

  /** Authorise the next n payments from the slice. Returns how many ran. */
  step(n = 1): number {
    const { slice } = this.snapshot;
    if (!slice || !this.interceptor) return 0;
    let ran = 0;
    let cursor = this.snapshot.cursor;
    let clock = this.snapshot.clockMs;
    while (ran < n && cursor < slice.transactions.length) {
      const txn = slice.transactions[cursor]!;
      this.authorize(txn, undefined);
      cursor += 1;
      clock = txn.ts;
      ran += 1;
    }
    if (ran > 0) {
      this.emit({ cursor, clockMs: clock });
      this.schedulePersist();
    }
    return ran;
  }

  /** Push one payment through the engine with the same pre-steps as the replay harness. */
  private authorize(txn: LabelledTransaction, injected: string | undefined): Decision {
    const interceptor = this.interceptor!;
    this.intel.advanceTo(txn.ts);

    // An imported file may carry a running balance. Where it does, the payer
    // profile is told the figure before the payment is scored, so the
    // drain-ratio signal divides by a measurement rather than by the engine's
    // estimate from spending history.
    const observed = this.balanceBefore[txn.txnId];
    if (observed !== undefined && observed > 0) {
      const payer = this.store.ensurePayer(txn.payerId, txn.ts);
      this.store.putPayer({ ...payer, observedBalancePaise: observed, balanceProxyPaise: observed });
    }

    const attrs = this.attributes.get(txn.payeeId);
    const known = this.intel.lookup(txn.payeeId);
    const existing = this.store.ensurePayee(txn.payeeId, txn.payeeVpa, txn.ts);
    const refreshed: PayeeProfile = {
      ...refreshPayeeWindow(existing, txn.ts),
      firstSeenMs: attrs?.firstSeenMs ?? existing.firstSeenMs,
      outboundVelocityRatio: attrs?.outboundVelocityRatio ?? existing.outboundVelocityRatio,
      confirmedMule: known.confirmed || existing.confirmedMule,
      muleHopDistance: known.hopDistance ?? existing.muleHopDistance,
    };
    this.store.putPayee(refreshed);

    const result = interceptor.authorize(txn);
    const decision: Decision = { seq: this.decisions.length, txn, result, injected };
    this.decisions = [...this.decisions, decision];
    return decision;
  }

  /**
   * Authorise one payment composed by hand.
   *
   * The same path as a replayed payment, so it lands in the feed, the
   * assessment panel and the ledger like any other. Beneficiary attributes are
   * supplied alongside because a hand-written payment names an account the
   * console has never seen, and the fan-in signal needs to be told what is
   * known about it rather than inventing a value.
   */
  submit(
    txn: Transaction,
    payee?: { outboundVelocityRatio?: number; firstSeenMs?: Millis; confirmedMule?: boolean },
  ): Decision | null {
    if (!this.interceptor) return null;
    this.pause();
    const labelled: LabelledTransaction = { ...txn, label: { isFraud: false } };

    if (payee && !this.attributes.has(txn.payeeId)) {
      this.attributes.set(txn.payeeId, {
        payeeId: txn.payeeId,
        name: txn.payeeName,
        kind: 'personal',
        outboundVelocityRatio: payee.outboundVelocityRatio ?? 0,
        firstSeenMs: payee.firstSeenMs ?? txn.ts,
        chainId: null,
        layer: null,
      });
    }
    if (payee?.confirmedMule) {
      const existing = this.store.ensurePayee(txn.payeeId, txn.payeeVpa, txn.ts);
      this.store.putPayee({ ...existing, confirmedMule: true });
    }

    const decision = this.authorize(labelled, 'composed');
    this.emit({ clockMs: Math.max(this.snapshot.clockMs, txn.ts), selectedTxnId: txn.txnId });
    return decision;
  }

  /**
   * Save the replay position, at most once every few seconds.
   *
   * Playback advances many times a second and the dataset is megabytes; a
   * write per step would be both wasteful and janky.
   */
  private schedulePersist(): void {
    if (this.snapshot.dataset.kind !== 'imported' || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, 3_000);
  }

  // --- Policy -------------------------------------------------------------

  setPolicy(policy: Policy, policyId: string, note: string): void {
    const hash = policyDigest(policy);
    if (hash === this.snapshot.policyHash) {
      this.emit({ policyId });
      return;
    }
    this.interceptor?.setPolicy(policy, 'console operator', note, this.snapshot.clockMs);
    this.emit({ policy, policyId, policyHash: hash });
  }

  applyPreset(id: string): void {
    const preset = POLICY_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    this.setPolicy(preset.policy, preset.id, `Preset ${preset.label} applied from the console.`);
  }

  // --- Selection and holds -----------------------------------------------

  select(txnId: string | null): void {
    this.emit({ selectedTxnId: txnId });
  }

  resolveHold(holdId: string, outcome: HoldOutcome): HoldRecord | undefined {
    if (!this.interceptor) return undefined;
    const now = this.snapshot.clockMs + 30_000;
    const hold = this.interceptor.resolve(holdId, outcome, now);
    this.emit({});
    return hold;
  }

  /** Age every open hold against the current clock. */
  sweep(): void {
    if (!this.interceptor || !this.snapshot.slice) return;
    const payers = new Set(this.decisions.map((d) => d.txn.payerId));
    this.interceptor.sweepExpiries(this.snapshot.clockMs, [...payers]);
    this.emit({});
  }

  // --- Injection ----------------------------------------------------------

  /**
   * Run a scenario against a payer with an established baseline, at the
   * current engine clock. Multi-step scenarios advance the clock between
   * payments so hold windows and the structuring window see real elapsed time.
   */
  inject(scenarioId: string): Decision[] {
    const scenario = scenarioById(scenarioId);
    const { slice } = this.snapshot;
    if (!scenario || !slice || !this.interceptor) return [];
    this.pause();

    // Prefer a payer who has appeared in the feed already, so the operator
    // has seen their ordinary behaviour, and who has a real history.
    const seen = this.decisions.filter((d) => !d.injected).map((d) => d.txn);
    const pool = seen.length > 0 ? seen : slice.transactions.slice(0, 200);
    const eligible = (t: Transaction, fresh: boolean): boolean => {
      const p = this.store.getPayer(t.payerId);
      if (!p || p.txnCount < 25) return false;
      if (fresh && this.usedVictims.has(t.payerId)) return false;
      if (scenario.minPayerMedianPaise && Math.exp(p.logAmountMedian) < scenario.minPayerMedianPaise) return false;
      // A hold already open for this payer would link the episode to it.
      return this.store.holdsForPayer(t.payerId).every((h) => h.resolvedAtMs !== null);
    };
    let template: Transaction | undefined;
    for (let i = pool.length - 1; i >= 0 && !template; i--) {
      if (eligible(pool[i]!, true)) template = pool[i];
    }
    for (let i = pool.length - 1; i >= 0 && !template; i--) {
      if (eligible(pool[i]!, false)) template = pool[i];
    }
    template ??= pool[pool.length - 1]!;
    this.usedVictims.add(template.payerId);
    const profile = this.store.getPayer(template.payerId);

    const startTs = this.snapshot.clockMs + 20_000;
    const txns = buildScenario(scenario, template, profile, startTs);

    // The collection account: aged as the scenario says, forwarding as fast as
    // the scenario says. This is the beneficiary intelligence a sending
    // institution would receive rather than observe.
    const first = txns[0]!;
    if (!this.attributes.has(first.payeeId)) {
      this.attributes.set(first.payeeId, {
        payeeId: first.payeeId,
        name: first.payeeName,
        kind: scenario.isFraud ? 'mule' : 'personal',
        outboundVelocityRatio: scenario.payeeVelocity,
        firstSeenMs: startTs - scenario.payeeAgeDays * DAY_MS,
        chainId: scenario.isFraud ? (first.label.chainId ?? null) : null,
        layer: scenario.isFraud ? 1 : null,
      });
    }

    const out: Decision[] = [];
    let clock = this.snapshot.clockMs;
    for (const txn of txns) {
      out.push(this.authorize(txn, scenario.id));
      clock = txn.ts;
    }
    this.emit({ clockMs: clock, selectedTxnId: first.txnId });
    return out;
  }

  // --- Queries ------------------------------------------------------------

  get storeRef(): MemoryStore {
    return this.store;
  }

  get engine(): Interceptor | null {
    return this.interceptor;
  }

  /** Beneficiary attributes as the engine received them, including injected accounts. */
  payeeInfo(payeeId: string): SlicePayee | undefined {
    return this.attributes.get(payeeId);
  }

  /** Every known member of a collection network, slice and injected alike. */
  chainMembers(chainId: string): SlicePayee[] {
    return [...this.attributes.values()]
      .filter((p) => p.chainId === chainId)
      .sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0));
  }

  decisionFor(txnId: string): Decision | undefined {
    return this.decisions.find((d) => d.txn.txnId === txnId);
  }

  holdFor(txnId: string): HoldRecord | undefined {
    const d = this.decisionFor(txnId);
    if (!d) return undefined;
    if (d.result.hold) return this.store.getHold(d.result.hold.holdId) ?? d.result.hold;
    if (d.result.linkedTo) return this.store.getHold(d.result.linkedTo.holdId);
    return undefined;
  }

  /** Scored samples for the policy studio, from every replayed decision so far. */
  samples(): PolicySample[] {
    return this.decisions
      .filter((d) => !d.injected)
      .map((d) => ({
        amountPaise: d.txn.amountPaise,
        probability: d.result.assessment.calibratedP,
        isFraud: d.txn.label.isFraud,
        recoveryAtReportLag: d.result.assessment.recovery.fractionAtHorizon,
      }));
  }

  /**
   * Samples for the whole slice, scored without writing to the live session.
   *
   * The studio needs a population to price a policy against even before the
   * operator has pressed play. A scratch engine replays the full window on a
   * copy of the warm state; nothing it does reaches the console ledger.
   */
  private scratchSamples: PolicySample[] | null = null;

  sliceSamples(): PolicySample[] {
    if (this.scratchSamples) return this.scratchSamples;
    const { model, slice } = this.snapshot;
    if (!model || !slice) return [];
    const scratch = new ConsoleSession();
    scratch.snapshot = { ...scratch.snapshot, policy: DEFAULT_POLICY };
    scratch.boot(model, slice);
    scratch.step(slice.transactions.length);
    this.scratchSamples = scratch.samples();
    return this.scratchSamples;
  }
}

let singleton: ConsoleSession | null = null;

export function getSession(): ConsoleSession {
  if (!singleton) singleton = new ConsoleSession();
  return singleton;
}

export type { ConsoleSession };
