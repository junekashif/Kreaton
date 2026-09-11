import {
  EXTRACTORS,
  Interceptor,
  MemoryStore,
  SIGNAL_ORDER,
  refreshPayeeWindow,
  toBin,
  updatePayeeProfile,
  updatePayerProfile,
} from '@kreaton/core';
import type {
  Assessment,
  LabelledTransaction,
  Millis,
  ModelSpec,
  Paise,
  Policy,
  ScoringContext,
  Typology,
} from '@kreaton/core';
import type { GeneratedCorpus, MuleIntelEvent, SyntheticPayee } from './generator.js';

/**
 * Chronological replay.
 *
 * Everything downstream of this file depends on one property: when a payment is
 * evaluated, the state it is evaluated against contains only what was knowable
 * before it. That covers three separate leaks, each of which would inflate
 * results on its own:
 *
 *   - Behavioural profiles are advanced one transaction at a time, so a payment
 *     is never compared to a baseline that already includes it.
 *   - Beneficiary fan-in is windowed to the trailing 24 hours as of the
 *     authorisation instant, not as of the end of the corpus.
 *   - Mule intelligence is applied on its own timeline. An account confirmed on
 *     day forty is not known on day twelve, and payments made on day twelve are
 *     scored without it.
 *
 * The third is the one most often skipped, and skipping it is close to fatal:
 * every fraudulent payment in the corpus goes to an account that is eventually
 * identified as a mule, so a replay that applies that knowledge from the start
 * is reading the answer key and will report a near-perfect model.
 */

const DAY_MS = 86_400_000;

/** One transaction reduced to the inputs the fitter needs. */
export interface FeatureRow {
  txnId: string;
  ts: Millis;
  payerId: string;
  payeeId: string;
  amountPaise: Paise;
  /** Raw statistic per signal, in SIGNAL_ORDER. */
  raw: number[];
  /** Discretised bin per signal, in SIGNAL_ORDER. */
  bins: number[];
  isFraud: boolean;
  typology?: Typology;
}

/** Applies mule intelligence to beneficiary profiles as it becomes available. */
class IntelTimeline {
  private cursor = 0;
  private readonly events: MuleIntelEvent[];
  /** Best knowledge held about each beneficiary so far. */
  private known = new Map<string, { confirmed: boolean; hopDistance: number }>();

  constructor(events: readonly MuleIntelEvent[]) {
    this.events = [...events].sort((a, b) => a.ts - b.ts);
  }

  /** Advance to a point in time, absorbing every event at or before it. */
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

/** Index beneficiary attributes that a sending institution receives rather than derives. */
function payeeAttributeMap(payees: readonly SyntheticPayee[]): Map<string, SyntheticPayee> {
  return new Map(payees.map((p) => [p.payeeId, p]));
}

/**
 * Walk the corpus and produce one feature row per transaction.
 *
 * No model is required: raw extraction and binning are model-independent, which
 * is what allows the same pass to be used for fitting and for refitting without
 * a chicken-and-egg problem.
 */
export function buildFeatureStream(corpus: GeneratedCorpus): FeatureRow[] {
  const store = new MemoryStore();
  const intel = new IntelTimeline(corpus.intel);
  const attributes = payeeAttributeMap(corpus.payees);
  const rows: FeatureRow[] = [];

  for (const txn of corpus.transactions) {
    const now = txn.ts;
    intel.advanceTo(now);

    const payer = store.ensurePayer(txn.payerId, now);
    let payee = store.ensurePayee(txn.payeeId, txn.payeeVpa, now);

    // Attach the attributes an institution receives from network intelligence
    // rather than observing on its own books.
    const attrs = attributes.get(txn.payeeId);
    const known = intel.lookup(txn.payeeId);
    payee = {
      ...refreshPayeeWindow(payee, now),
      firstSeenMs: attrs?.firstSeenMs ?? payee.firstSeenMs,
      outboundVelocityRatio: attrs?.outboundVelocityRatio ?? payee.outboundVelocityRatio,
      confirmedMule: known.confirmed,
      muleHopDistance: known.hopDistance,
    };

    const ctx: ScoringContext = {
      payer,
      payee,
      recentPayerTxns: store.recentPayerTxns(txn.payerId, now - DAY_MS),
      activeHolds: [],
      now,
    };

    const raw: number[] = [];
    const bins: number[] = [];
    for (const id of SIGNAL_ORDER) {
      const value = EXTRACTORS[id](txn, ctx).raw;
      raw.push(value);
      bins.push(toBin(id, value));
    }

    rows.push({
      txnId: txn.txnId,
      ts: now,
      payerId: txn.payerId,
      payeeId: txn.payeeId,
      amountPaise: txn.amountPaise,
      raw,
      bins,
      isFraud: txn.label.isFraud,
      typology: txn.label.typology,
    });

    // Advance state only after the row is captured.
    store.putPayer(updatePayerProfile(payer, txn));
    store.putPayee(updatePayeeProfile(payee, txn));
    store.recordTransaction(txn);
  }

  return rows;
}

export interface CapturedContext {
  txn: LabelledTransaction;
  ctx: ScoringContext;
}

/**
 * Walk the corpus and capture the scoring context as it stood at each payment.
 *
 * Needed wherever something outside the engine has to score a transaction the
 * way the engine would: the defence comparison, the sensitivity analysis, and
 * anything else that needs a realistic context without running a full replay.
 *
 * Taking profiles from a store that has already been warmed to the end of the
 * corpus is not equivalent and is a subtle way to get optimistic results, since
 * the profile then contains activity that had not happened yet. An earlier
 * version of the defence calibration did exactly that and reported a
 * false-positive rate several times too high.
 */
export function collectContexts(
  corpus: GeneratedCorpus,
  options: { fromMs?: Millis; keep?: (txn: LabelledTransaction) => boolean; limit?: number } = {},
): CapturedContext[] {
  const store = new MemoryStore();
  const intel = new IntelTimeline(corpus.intel);
  const attributes = payeeAttributeMap(corpus.payees);
  const out: CapturedContext[] = [];
  const fromMs = options.fromMs ?? Number.NEGATIVE_INFINITY;

  for (const txn of corpus.transactions) {
    const now = txn.ts;
    intel.advanceTo(now);

    const payer = store.ensurePayer(txn.payerId, now);
    const stored = store.ensurePayee(txn.payeeId, txn.payeeVpa, now);
    const attrs = attributes.get(txn.payeeId);
    const known = intel.lookup(txn.payeeId);
    const payee = {
      ...refreshPayeeWindow(stored, now),
      firstSeenMs: attrs?.firstSeenMs ?? stored.firstSeenMs,
      outboundVelocityRatio: attrs?.outboundVelocityRatio ?? stored.outboundVelocityRatio,
      confirmedMule: known.confirmed,
      muleHopDistance: known.hopDistance,
    };

    if (now >= fromMs && (options.keep?.(txn) ?? true)) {
      if (options.limit === undefined || out.length < options.limit) {
        out.push({
          txn,
          ctx: {
            payer,
            payee,
            recentPayerTxns: store.recentPayerTxns(txn.payerId, now - DAY_MS),
            activeHolds: [],
            now,
          },
        });
      }
    }

    store.putPayer(updatePayerProfile(payer, txn));
    store.putPayee(updatePayeeProfile(payee, txn));
    store.recordTransaction(txn);
  }

  return out;
}

/**
 * Chronological train and test split.
 *
 * A random split would let the model learn from a beneficiary on day fifty and
 * be tested on the same beneficiary on day twenty, which is not a situation any
 * deployed system is ever in. Splitting on time reproduces the real task:
 * fitted on the past, judged on the future, including on mule networks that did
 * not exist during fitting.
 */
export function chronologicalSplit<T extends { ts: Millis }>(
  rows: readonly T[],
  trainFraction = 0.6,
): { train: T[]; test: T[]; splitAtMs: Millis } {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const cut = Math.floor(sorted.length * trainFraction);
  const splitAtMs = sorted[cut]?.ts ?? 0;
  return {
    train: sorted.slice(0, cut),
    test: sorted.slice(cut),
    splitAtMs,
  };
}

// ---------------------------------------------------------------------------
// Full-engine replay
// ---------------------------------------------------------------------------

export interface ReplayOutcome {
  txnId: string;
  ts: Millis;
  amountPaise: Paise;
  isFraud: boolean;
  typology?: Typology;
  assessment: Assessment;
}

export interface ReplayResult {
  outcomes: ReplayOutcome[];
  store: MemoryStore;
  interceptor: Interceptor;
  /** Wall-clock time spent inside authorise, for the latency budget. */
  totalAuthorizeMs: number;
}

export interface ReplayOptions {
  corpus: GeneratedCorpus;
  model: ModelSpec;
  policy: Policy;
  /** Evaluate only transactions at or after this instant, e.g. the test window. */
  fromMs?: Millis;
  /**
   * When set, transactions before fromMs still advance profiles but are not
   * scored. This warms the baselines so the test window is not dominated by
   * payers with no history, which is the situation a deployed system is in.
   */
  warmUp?: boolean;
  /** Resolve holds as they are opened, simulating customer response. */
  holdResponder?: (outcome: ReplayOutcome) => 'confirmed' | 'failed' | 'abandoned' | 'ignore';
}

/**
 * Replay the corpus through the full interceptor, producing decisions, holds
 * and a sealed audit trail rather than only scores.
 */
export function replay(opts: ReplayOptions): ReplayResult {
  const { corpus, model, policy } = opts;
  const store = new MemoryStore();
  const interceptor = new Interceptor({ model, policy, store });
  const intel = new IntelTimeline(corpus.intel);
  const attributes = payeeAttributeMap(corpus.payees);

  const outcomes: ReplayOutcome[] = [];
  let totalAuthorizeMs = 0;

  for (const txn of corpus.transactions) {
    const now = txn.ts;
    intel.advanceTo(now);

    // Refresh supplied beneficiary attributes before the engine reads them.
    const attrs = attributes.get(txn.payeeId);
    const known = intel.lookup(txn.payeeId);
    const existing = store.ensurePayee(txn.payeeId, txn.payeeVpa, now);
    store.putPayee({
      ...existing,
      firstSeenMs: attrs?.firstSeenMs ?? existing.firstSeenMs,
      outboundVelocityRatio: attrs?.outboundVelocityRatio ?? existing.outboundVelocityRatio,
      confirmedMule: known.confirmed,
      muleHopDistance: known.hopDistance,
    });

    const inWindow = opts.fromMs === undefined || now >= opts.fromMs;

    if (!inWindow && opts.warmUp) {
      // Warm the baselines without scoring or writing an audit record.
      const payer = store.ensurePayer(txn.payerId, now);
      const payee = store.getPayee(txn.payeeId)!;
      store.putPayer(updatePayerProfile(payer, txn));
      store.putPayee(updatePayeeProfile(payee, txn));
      store.recordTransaction(txn);
      continue;
    }
    if (!inWindow) continue;

    const started = performance.now();
    const result = interceptor.authorize(txn);
    totalAuthorizeMs += performance.now() - started;

    const outcome: ReplayOutcome = {
      txnId: txn.txnId,
      ts: now,
      amountPaise: txn.amountPaise,
      isFraud: txn.label.isFraud,
      typology: txn.label.typology,
      assessment: result.assessment,
    };
    outcomes.push(outcome);

    if (result.hold && opts.holdResponder) {
      const response = opts.holdResponder(outcome);
      if (response !== 'ignore') {
        interceptor.resolve(
          result.hold.holdId,
          response === 'confirmed'
            ? { kind: 'confirmed' }
            : response === 'failed'
              ? { kind: 'failed', reason: 'Payer did not complete re-confirmation.' }
              : { kind: 'abandoned' },
          now + 60_000,
        );
      }
    }
  }

  return { outcomes, store, interceptor, totalAuthorizeMs };
}

/**
 * Default hold responder.
 *
 * A held payment has an outcome, and the portfolio report needs one. The
 * responder models it: a genuine fraud is stopped with the policy catch rate,
 * and a legitimate customer almost always completes the re-confirmation but
 * sometimes abandons. These are the same parameters the cost model uses, so the
 * simulation and the economics cannot silently disagree.
 */
export function defaultHoldResponder(
  policy: Policy,
  seedOffset = 0,
): (outcome: ReplayOutcome) => 'confirmed' | 'failed' | 'abandoned' {
  let counter = seedOffset;
  return (outcome) => {
    // Deterministic pseudo-random draw keyed on the transaction, so replays
    // repeat exactly without threading an Rng through the call site.
    const x = Math.abs(Math.sin(++counter * 12.9898 + outcome.ts % 1000) * 43758.5453) % 1;
    if (outcome.isFraud) return x < policy.stepUpCatchRate ? 'failed' : 'confirmed';
    return x < policy.stepUpAbandonmentRate ? 'abandoned' : 'confirmed';
  };
}
