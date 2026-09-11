import {
  EXTRACTORS,
  Rng,
  SIGNAL_ORDER,
  SIGNAL_SPECS,
  decide,
  evaluateSignals,
  fuse,
  mean,
  refreshPayeeWindow,
  sd,
  toBin,
  toPaise,
  updatePayerProfile,
  wilsonInterval,
} from '@kreaton/core';
import { TYPOLOGIES, typologyById } from './typologies.js';
import { intervenes } from './defences.js';
import type { DefenceId, DefenceParams } from './defences.js';
import type {
  Action,
  MemoryStore,
  ModelSpec,
  Paise,
  PayeeProfile,
  PayerProfile,
  Policy,
  ScoringContext,
  SignalId,
  Transaction,
} from '@kreaton/core';
import type { SyntheticPayee, SyntheticPayer } from './generator.js';

/**
 * Adversarial countermeasure evaluation.
 *
 * A fraud control is not evaluated by how it performs against the fraud it was
 * fitted on. It is evaluated by how it performs against somebody who knows it
 * is there. Every attack here is a documented real evasion, and every one is
 * scored twice: once against the system as built, and once against the same
 * system with the specific countermeasure removed. The difference is the only
 * honest way to claim a countermeasure is worth having.
 *
 * The unit of measurement is the episode, not the payment. A scam extracts
 * several payments from one victim, and stopping any one of them breaks the
 * spell: the victim is told to try again, the delay creates a moment to think,
 * and in practice the episode ends. Reporting per-payment catch rates would
 * inflate the numbers by counting the same intervention repeatedly, and would
 * also understate the value of catching the last payment of a long episode.
 *
 * Intervals are Wilson score intervals. At these counts the normal
 * approximation is badly wrong near the extremes, and several of these attacks
 * are caught nearly always or almost never.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * What the system loses when a countermeasure is switched off.
 *
 * Ablations are expressed as removals from the built system rather than as
 * additions to a strawman, so the comparison cannot be gamed by choosing a
 * weak baseline.
 */
export interface Ablation {
  /** Signals whose evidence is discarded entirely. */
  disabledSignals?: SignalId[];
  /**
   * Replace the robust amount baseline with a mean and standard deviation.
   * This is the estimator most systems actually use, and it is what makes
   * baseline poisoning work.
   */
  naiveAmountBaseline?: boolean;
  /**
   * Restore symmetric treatment of attacker-controllable evidence, so that a
   * suppressed context signal argues for the payment as strongly as a present
   * one argues against it.
   */
  disableAsymmetricCap?: boolean;
}

export interface AttackSpec {
  id: string;
  label: string;
  /** What the attacker does. */
  description: string;
  /** Why it works against a system without the countermeasure. */
  premise: string;
  /** The defence being measured, in plain terms. */
  countermeasure: string;
  ablation: Ablation;
}

export const ATTACKS: readonly AttackSpec[] = [
  {
    id: 'structuring',
    label: 'Threshold structuring',
    description:
      'The intended amount is split into several payments, each placed just below a monitored threshold, sent minutes apart to the same collection account.',
    premise:
      'A control that evaluates one payment at a time cannot see a total it never observes. Each individual payment is unremarkable in size.',
    countermeasure:
      'The structuring signal accumulates value across a trailing window and fires when the window crosses a threshold that no single payment crosses.',
    ablation: { disabledSignals: ['STRUCTURING'] },
  },
  {
    id: 'baseline_building',
    label: 'False baseline building',
    description:
      'Before the extraction, the attacker has the victim send a run of ordinary-looking payments to the collection account, including one deliberately large one, to shift the victim spending profile upward.',
    premise:
      'A behavioural baseline built from a mean and a standard deviation can be moved a long way by one large observation, after which the real extraction no longer looks anomalous.',
    countermeasure:
      'The amount baseline uses a median and a median absolute deviation, which have a fifty per cent breakdown point. Half the payment history would have to be poisoned before the estimate moves meaningfully.',
    ablation: { naiveAmountBaseline: true },
  },
  {
    id: 'delayed_extraction',
    label: 'Delayed extraction',
    description:
      'The beneficiary is added and left dormant for several days before any payment is made, defeating first-time-beneficiary rules and cooling periods.',
    premise:
      'Controls keyed on beneficiary novelty expire. Waiting is free for the attacker and costs the victim nothing they will notice.',
    countermeasure:
      'Beneficiary fan-in weighted by onward velocity does not decay with the payer relationship. However long the attacker waits, the collection account is still receiving from unrelated people and still forwarding within the hour.',
    ablation: { disabledSignals: ['PAYEE_FAN_IN'] },
  },
  {
    id: 'context_hygiene',
    label: 'Context suppression',
    description:
      'The script is changed so the victim ends the call before authorising, closes the messaging app, avoids screen sharing, and is told to take their time and select the payee from their saved contacts.',
    premise:
      'Every contextual indicator of coercion is under the attacker control. If the model rests on them, instructing the victim differently defeats it at no cost.',
    countermeasure:
      'Negative evidence from attacker-controllable signals is floored. A quiet session still counts in the payer favour, but it can no longer argue a payment down by a factor of a hundred simply because the script told the victim to hang up first. Presence of a coercion indicator is still counted in full.',
    ablation: { disableAsymmetricCap: true },
  },
  {
    id: 'threshold_probing',
    label: 'Threshold probing',
    description:
      'The attacker sends a sequence of small test payments of increasing value to locate the amount at which the system starts to intervene, then extracts just below it.',
    premise:
      'A fixed score threshold can be mapped from outside with a handful of cheap probes, after which the attacker operates permanently beneath it.',
    countermeasure:
      'The decision boundary is derived from expected cost and therefore moves with the amount, the beneficiary and the policy. There is no single number to find, and the probing sequence itself raises the velocity and structuring signals.',
    ablation: { disabledSignals: ['VELOCITY_BURST', 'STRUCTURING'] },
  },
  {
    id: 'mule_rotation',
    label: 'Collection account rotation',
    description:
      'A previously unused collection account is used for every victim, so no beneficiary ever accumulates the fan-in or the reported-fraud history that would identify it.',
    premise:
      'Intelligence on known collection accounts is always retrospective. An account used once and discarded is never on any list at the moment it matters.',
    countermeasure:
      'Account age and onward velocity are properties of the account at the moment of payment and do not depend on it having been reported before. A freshly opened account that forwards everything within the hour is identifiable on the first use.',
    ablation: { disabledSignals: ['MULE_PROXIMITY'] },
  },
] as const;

// ---------------------------------------------------------------------------
// Attack construction
// ---------------------------------------------------------------------------

export interface AttackEpisode {
  victimId: string;
  payeeId: string;
  transactions: Transaction[];
  /** Total value the attacker is attempting to extract. */
  targetPaise: Paise;
}

interface BuildContext {
  rng: Rng;
  victim: SyntheticPayer;
  mule: SyntheticPayee;
  startMs: number;
  /** Value the attacker intends to extract from this victim. */
  targetPaise: Paise;
  counter: () => string;
}

function baseTransaction(
  c: BuildContext,
  overrides: {
    ts: number;
    amountPaise: Paise;
    beneficiaryAddedAtMs: number;
    activeCall?: boolean;
    activeCallSeconds?: number;
    screenShare?: boolean;
    remoteAccess?: boolean;
    appSwitchCount?: number;
    authorizeSeconds?: number;
    entry?: Transaction['context']['vpaEnteredBy'];
  },
): Transaction {
  return {
    txnId: c.counter(),
    ts: Math.round(overrides.ts),
    payerId: c.victim.payerId,
    payerVpa: c.victim.vpa,
    payeeId: c.mule.payeeId,
    payeeVpa: c.mule.vpa,
    payeeName: c.mule.name,
    amountPaise: Math.max(100, Math.round(overrides.amountPaise)),
    channel: 'p2p',
    deviceId: c.victim.devices[0]!,
    ipHash: `ip_${c.victim.payerId}`,
    simSerialHash: c.victim.simSerial,
    context: {
      activeCall: overrides.activeCall ?? true,
      activeCallSeconds: overrides.activeCallSeconds ?? 900,
      screenShareActive: overrides.screenShare ?? false,
      remoteAccessAppRunning: overrides.remoteAccess ?? false,
      appSwitchCount: overrides.appSwitchCount ?? 3,
      secondsFromOpenToAuthorize: overrides.authorizeSeconds ?? 40,
      vpaEnteredBy: overrides.entry ?? 'pasted',
      beneficiaryAddedAtMs: Math.round(overrides.beneficiaryAddedAtMs),
      sessionId: `adv_${c.victim.payerId}`,
      isNewDevice: false,
      deviceBoundAtMs: c.startMs - 200 * DAY_MS,
      simChangedRecently: false,
    },
  };
}

/** Construct one attacked episode for a given strategy. */
function buildEpisode(attackId: string, c: BuildContext): AttackEpisode {
  const txns: Transaction[] = [];
  const addedAt = c.startMs - 6 * MINUTE_MS;

  switch (attackId) {
    case 'structuring': {
      // Split beneath the highest threshold the total would otherwise cross.
      const threshold = toPaise(50_000);
      const slice = threshold * c.rng.uniform(0.9, 0.985);
      const parts = Math.max(2, Math.ceil(c.targetPaise / slice));
      let t = c.startMs;
      for (let i = 0; i < parts; i++) {
        txns.push(
          baseTransaction(c, {
            ts: t,
            amountPaise: slice,
            beneficiaryAddedAtMs: addedAt,
            activeCallSeconds: 900 + i * 300,
          }),
        );
        t += c.rng.lognormal(Math.log(7 * MINUTE_MS), 0.6);
      }
      break;
    }

    case 'baseline_building': {
      // A run of ordinary payments, one of them deliberately large, to drag the
      // profile upward before the real extraction.
      let t = c.startMs - 9 * DAY_MS;
      const priming = c.rng.int(5, 9);
      for (let i = 0; i < priming; i++) {
        const isAnchor = i === priming - 2;
        txns.push(
          baseTransaction(c, {
            ts: t,
            amountPaise: isAnchor ? c.targetPaise * 0.75 : toPaise(c.rng.uniform(400, 2_500)),
            beneficiaryAddedAtMs: c.startMs - 10 * DAY_MS,
            activeCall: false,
            activeCallSeconds: 0,
            appSwitchCount: 1,
            authorizeSeconds: 45,
            entry: 'contact',
          }),
        );
        t += c.rng.uniform(0.6, 1.8) * DAY_MS;
      }
      txns.push(
        baseTransaction(c, {
          ts: c.startMs,
          amountPaise: c.targetPaise,
          beneficiaryAddedAtMs: c.startMs - 10 * DAY_MS,
        }),
      );
      break;
    }

    case 'delayed_extraction': {
      const dormancy = c.rng.uniform(5, 21) * DAY_MS;
      txns.push(
        baseTransaction(c, {
          ts: c.startMs,
          amountPaise: c.targetPaise,
          beneficiaryAddedAtMs: c.startMs - dormancy,
        }),
      );
      break;
    }

    case 'context_hygiene': {
      // Every session indicator is scrubbed: no call, no sharing, saved payee,
      // unhurried authorisation.
      txns.push(
        baseTransaction(c, {
          ts: c.startMs,
          amountPaise: c.targetPaise,
          beneficiaryAddedAtMs: c.startMs - 3 * DAY_MS,
          activeCall: false,
          activeCallSeconds: 0,
          screenShare: false,
          remoteAccess: false,
          appSwitchCount: 1,
          authorizeSeconds: 120,
          entry: 'contact',
        }),
      );
      break;
    }

    case 'threshold_probing': {
      // Geometrically increasing probes, then the extraction.
      let t = c.startMs;
      let probe = toPaise(200);
      for (let i = 0; i < 6; i++) {
        txns.push(
          baseTransaction(c, {
            ts: t,
            amountPaise: probe,
            beneficiaryAddedAtMs: addedAt,
            activeCall: false,
            activeCallSeconds: 0,
            appSwitchCount: 1,
            entry: 'typed',
          }),
        );
        probe *= 3.2;
        t += c.rng.uniform(4, 12) * MINUTE_MS;
      }
      txns.push(
        baseTransaction(c, { ts: t, amountPaise: c.targetPaise, beneficiaryAddedAtMs: addedAt }),
      );
      break;
    }

    case 'mule_rotation':
    default: {
      txns.push(
        baseTransaction(c, {
          ts: c.startMs,
          amountPaise: c.targetPaise,
          beneficiaryAddedAtMs: addedAt,
        }),
      );
      break;
    }
  }

  return {
    victimId: c.victim.payerId,
    payeeId: c.mule.payeeId,
    transactions: txns,
    targetPaise: c.targetPaise,
  };
}

// ---------------------------------------------------------------------------
// Ablated scoring
// ---------------------------------------------------------------------------

/** Apply an ablation to a model by zeroing the weight of removed signals. */
function ablateModel(model: ModelSpec, ablation: Ablation): ModelSpec {
  const disabled = new Set(ablation.disabledSignals ?? []);
  let out = model;
  if (disabled.size > 0) {
    out = {
      ...out,
      signals: out.signals.map((s) =>
        disabled.has(s.id) ? { ...s, weight: 0, llrByBin: s.llrByBin.map(() => 0) } : s,
      ),
    };
  }
  if (ablation.disableAsymmetricCap) {
    out = { ...out, asymmetricEvidence: { cappedGroups: [], negativeFloor: 0 } };
  }
  return out;
}

/**
 * Recompute the amount-deviation signal with a non-robust baseline.
 *
 * This is the ablation that makes baseline poisoning work, and it cannot be
 * expressed by removing a signal, because the signal is still present and still
 * firing. It is simply measuring against an estimator that an attacker can move.
 */
function naiveAmountBin(txn: Transaction, payer: PayerProfile): number {
  const logs = payer.recentLogAmounts;
  if (logs.length < 2) return toBin('AMOUNT_DEVIATION', 0);
  const mu = mean(logs);
  const sigma = Math.max(sd(logs), 0.35);
  const z = (Math.log(Math.max(txn.amountPaise, 1)) - mu) / sigma;
  return toBin('AMOUNT_DEVIATION', z);
}

const AMOUNT_INDEX = SIGNAL_ORDER.indexOf('AMOUNT_DEVIATION');

/** Score one transaction against a frozen profile state under an ablation. */
function scoreUnder(
  txn: Transaction,
  ctx: ScoringContext,
  model: ModelSpec,
  policy: Policy,
  recoveryAtLag: number,
  ablation: Ablation,
): Action {
  const effective = ablateModel(model, ablation);
  const signals = evaluateSignals(txn, ctx, effective);

  // Under a non-robust baseline the amount signal still fires, but it measures
  // against an estimator the attacker has moved. Re-point that one entry at the
  // bin a mean-and-sigma baseline would have produced, leaving everything else
  // untouched, then let fusion re-add the contributions.
  if (ablation.naiveAmountBaseline && AMOUNT_INDEX >= 0) {
    const bin = naiveAmountBin(txn, ctx.payer);
    const woe = effective.signals.find((s) => s.id === 'AMOUNT_DEVIATION');
    const entry = signals[AMOUNT_INDEX];
    if (woe && entry) {
      entry.bin = bin;
      entry.llr = woe.llrByBin[bin] ?? 0;
      entry.contribution = entry.llr * entry.weight * entry.shrinkage;
    }
  }

  const fused = fuse(signals, effective);
  return decide(
    {
      amountPaise: txn.amountPaise,
      fraudProbability: fused.calibratedP,
      recoveryAtReportLag: recoveryAtLag,
    },
    policy,
  ).chosen;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

export interface DefencePerformance {
  caught: number;
  rate: number;
  interval: { lo: number; hi: number };
  valueLeakedPaise: Paise;
  /** False-positive rate this defence produces on legitimate traffic. */
  falsePositiveRate: number;
}

export interface AttackResult {
  attack: AttackSpec;
  episodes: number;

  /**
   * Primary comparison: three whole systems at matched friction.
   *
   * This is the figure that answers whether any of this improves on what is
   * already deployed, because a tuned rule is what is already deployed.
   */
  byDefence: Record<DefenceId, DefencePerformance>;

  /**
   * Secondary comparison: the full system with and without the specific
   * countermeasure this attack targets.
   *
   * Frequently close to zero, and reported anyway. With twelve signals fused,
   * any single removal leaves eleven others that still catch the episode, so an
   * ablation measures marginal contribution rather than importance. Reporting
   * only the primary comparison would hide that, and reporting only the
   * ablation would understate the system.
   */
  caughtHardened: number;
  caughtAblated: number;
  hardenedRate: number;
  ablatedRate: number;
  improvementPp: number;
  significant: boolean;
  valueLeakedHardenedPaise: Paise;
  valueLeakedAblatedPaise: Paise;
}

export interface AdversarialOptions {
  store: MemoryStore;
  payers: readonly SyntheticPayer[];
  payees: readonly SyntheticPayee[];
  model: ModelSpec;
  policy: Policy;
  recoveryAtReportLag: number;
  /** Instant the attacks are launched from. */
  atMs: number;
  /**
   * Recent inbound activity per collection account, rebased so it ends just
   * before the attack instant.
   *
   * Without this the beneficiary fan-in window is empty at attack time, because
   * the warmed profile holds activity from whenever that account was last used
   * and the window only looks back twenty-four hours. An empty window silently
   * disables the payee-graph signals and makes every countermeasure resting on
   * them look worthless. An account an attacker is actively using is, by
   * definition, receiving from other victims at the same time.
   */
  liveFanIn?: Map<string, Array<{ payerId: string; amountPaise: Paise; offsetMs: number }>>;
  /** Calibrated so every defence interrupts the same share of legitimate payments. */
  defenceParams: DefenceParams;
  /** Measured false-positive rate per defence, carried through to the report. */
  defenceFpr: Record<DefenceId, number>;
  episodesPerAttack?: number;
  seed?: string;
}

const DEFENCE_IDS: readonly DefenceId[] = ['rule_baseline', 'fixed_threshold', 'expected_cost'];

/**
 * Run every attack against every defence, and against the full system with its
 * countermeasure removed.
 *
 * Profiles come from a warmed store, so each victim has the behavioural history
 * a real customer would have. Within an episode the payer profile is advanced on
 * a copy, so multi-payment attacks such as structuring and probing are judged
 * against the state their own earlier payments created, exactly as they would be
 * in production.
 */
export function runAdversarialSuite(opts: AdversarialOptions): AttackResult[] {
  const {
    store,
    payers,
    payees,
    model,
    policy,
    recoveryAtReportLag,
    atMs,
    episodesPerAttack = 220,
    liveFanIn,
    defenceParams,
    defenceFpr,
  } = opts;

  const rng = new Rng(opts.seed ?? 'adversarial');
  const mules = payees.filter((p) => p.kind === 'mule');
  const eligible = payers.filter((p) => (store.getPayer(p.payerId)?.txnCount ?? 0) >= 12);
  if (eligible.length === 0 || mules.length === 0) return [];

  const results: AttackResult[] = [];

  for (const attack of ATTACKS) {
    const defenceCaught: Record<string, number> = {};
    const defenceLeaked: Record<string, number> = {};
    for (const d of DEFENCE_IDS) {
      defenceCaught[d] = 0;
      defenceLeaked[d] = 0;
    }
    let caughtHardened = 0;
    let caughtAblated = 0;
    let leakedHardened = 0;
    let leakedAblated = 0;
    let counter = 0;

    for (let e = 0; e < episodesPerAttack; e++) {
      const victim = rng.pick(eligible);
      const profile = store.getPayer(victim.payerId)!;

      const mule =
        attack.id === 'mule_rotation'
          ? {
              ...rng.pick(mules),
              payeeId: `fresh_${e}`,
              vpa: `fresh${e}@okaxis`,
              firstSeenMs: atMs - rng.uniform(1, 96) * HOUR_MS,
            }
          : rng.pick(mules);

      const spec = typologyById(rng.pick(TYPOLOGIES).id);
      const target = Math.min(
        Math.max(rng.lognormal(spec.amountLogMean, spec.amountLogSd), spec.amountFloor),
        spec.amountCeiling,
      );

      const episode = buildEpisode(attack.id, {
        rng,
        victim,
        mule,
        startMs: atMs,
        targetPaise: target,
        counter: () => `adv_${attack.id}_${e}_${counter++}`,
      });

      /** Walk the episode under a decision rule, returning where it stopped. */
      const runEpisode = (
        stop: (txn: Transaction, ctx: ScoringContext) => boolean,
      ): { caught: boolean; leaked: Paise } => {
        let workingProfile: PayerProfile = profile;
        const priorTxns: Transaction[] = [];
        let leaked = 0;

        for (const txn of episode.transactions) {
          const stored = store.getPayee(txn.payeeId);
          const base: PayeeProfile = stored ?? {
            payeeId: txn.payeeId,
            payeeVpa: txn.payeeVpa,
            firstSeenMs: mule.firstSeenMs,
            distinctPayers24h: 0,
            distinctPayersAllTime: 0,
            inboundCount24h: 0,
            inboundValue24h: 0,
            outboundVelocityRatio: mule.outboundVelocityRatio,
            confirmedMule: false,
            muleHopDistance: null,
            nameChurnCount: 0,
            inboundWindow: [],
          };

          const activity = liveFanIn?.get(mule.payeeId);
          const rebased = activity
            ? activity.map((a) => ({
                payerId: a.payerId,
                ts: atMs - a.offsetMs,
                amountPaise: a.amountPaise,
              }))
            : base.inboundWindow;

          const payee = refreshPayeeWindow({ ...base, inboundWindow: rebased }, txn.ts);

          const ctx: ScoringContext = {
            payer: workingProfile,
            payee: {
              ...payee,
              firstSeenMs: mule.firstSeenMs,
              outboundVelocityRatio: mule.outboundVelocityRatio,
            },
            recentPayerTxns: priorTxns.filter((t) => t.ts >= txn.ts - DAY_MS),
            activeHolds: [],
            now: txn.ts,
          };

          if (stop(txn, ctx)) return { caught: true, leaked };
          leaked += txn.amountPaise;
          workingProfile = updatePayerProfile(workingProfile, txn);
          priorTxns.push(txn);
        }
        return { caught: false, leaked };
      };

      // Primary: the three competing defences at matched friction.
      for (const id of DEFENCE_IDS) {
        const r = runEpisode((txn, ctx) =>
          intervenes(id, txn, ctx, model, policy, recoveryAtReportLag, defenceParams),
        );
        if (r.caught) defenceCaught[id] = (defenceCaught[id] ?? 0) + 1;
        defenceLeaked[id] = (defenceLeaked[id] ?? 0) + r.leaked;
      }

      // Secondary: the full system with and without this attack countermeasure.
      const hardened = runEpisode(
        (txn, ctx) => scoreUnder(txn, ctx, model, policy, recoveryAtReportLag, {}) !== 'APPROVE',
      );
      if (hardened.caught) caughtHardened += 1;
      leakedHardened += hardened.leaked;

      const ablated = runEpisode(
        (txn, ctx) =>
          scoreUnder(txn, ctx, model, policy, recoveryAtReportLag, attack.ablation) !== 'APPROVE',
      );
      if (ablated.caught) caughtAblated += 1;
      leakedAblated += ablated.leaked;
    }

    const h = wilsonInterval(caughtHardened, episodesPerAttack);
    const a = wilsonInterval(caughtAblated, episodesPerAttack);

    const byDefence = Object.fromEntries(
      DEFENCE_IDS.map((id) => {
        const w = wilsonInterval(defenceCaught[id] ?? 0, episodesPerAttack);
        return [
          id,
          {
            caught: defenceCaught[id] ?? 0,
            rate: w.point,
            interval: { lo: w.lo, hi: w.hi },
            valueLeakedPaise: defenceLeaked[id] ?? 0,
            falsePositiveRate: defenceFpr[id] ?? 0,
          } satisfies DefencePerformance,
        ];
      }),
    ) as Record<DefenceId, DefencePerformance>;

    results.push({
      attack,
      episodes: episodesPerAttack,
      byDefence,
      caughtHardened,
      caughtAblated,
      hardenedRate: h.point,
      ablatedRate: a.point,
      improvementPp: (h.point - a.point) * 100,
      significant: h.lo > a.hi || a.lo > h.hi,
      valueLeakedHardenedPaise: leakedHardened,
      valueLeakedAblatedPaise: leakedAblated,
    });
  }

  return results;
}

/** Signal labels for an attack ablation, for the report. */
export function ablationLabels(ablation: Ablation): string[] {
  const out = (ablation.disabledSignals ?? []).map((id) => SIGNAL_SPECS[id].label);
  if (ablation.naiveAmountBaseline) out.push('Robust amount baseline (median and MAD)');
  if (ablation.disableAsymmetricCap) out.push('Asymmetric cap on attacker-controllable evidence');
  return out;
}
