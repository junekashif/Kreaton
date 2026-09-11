import type { SignalId, SignalSpec } from '../types.js';

/**
 * Specifications for the twelve behavioural signals.
 *
 * Each signal reduces one transaction plus its context to a single real-valued
 * statistic in natural units. That statistic is then discretised against the
 * bin edges declared here, and the bin is looked up in a weight-of-evidence
 * table fitted on labelled data. Nothing in this file encodes a risk direction:
 * whether a high value is more or less suspicious is learned from the data, not
 * asserted by the author. That matters, because several of these statistics are
 * genuinely non-monotonic.
 *
 * Bin edges are upper-exclusive: a value v falls in the first bin i for which
 * v < binEdges[i], or in the final bin if it exceeds every edge. So n edges
 * produce n+1 bins.
 *
 * The rationale attached to each signal is reproduced verbatim in the model
 * card and in the regulator export, so that a reviewer reading an audit record
 * can see why a signal exists without reading the source.
 */

export const SIGNAL_SPECS: Record<SignalId, SignalSpec> = {
  PAYEE_NOVELTY: {
    id: 'PAYEE_NOVELTY',
    group: 'payee_graph',
    label: 'Beneficiary novelty',
    description:
      'Hours elapsed since this beneficiary was first added or first paid by this payer.',
    rationale:
      'Almost every authorised push payment scam ends in a transfer to a beneficiary the victim has never paid before, added minutes earlier while under instruction. Reserve Bank of India consultation on a cooling period for first-time beneficiaries above a low value threshold targets exactly this window. A long-standing beneficiary is strong evidence against the APP typology, which is why the signal is retained rather than reduced to a first-time boolean.',
    unit: 'hours',
    binEdges: [0.084, 0.5, 1, 4, 24, 168, 720],
    reasonCodePrefix: 'APP-NOV',
  },

  AMOUNT_DEVIATION: {
    id: 'AMOUNT_DEVIATION',
    group: 'behavioural',
    label: 'Amount deviation from personal baseline',
    description:
      'Robust z-score of the log amount against the payer own historical log-amount distribution.',
    rationale:
      'Scam payments are typically far larger than the victim ordinary spending, because the fraudster is extracting savings rather than intercepting routine payments. The score is computed in log space with a median and a median absolute deviation rather than a mean and a standard deviation: MAD has a fifty per cent breakdown point, so an attacker cannot shift the baseline by seeding one large payment first. That attack is exercised directly by the false-baseline adversary.',
    unit: 'robust z-score',
    binEdges: [-1, 0, 1, 2, 3, 4, 5],
    reasonCodePrefix: 'APP-AMT',
  },

  TEMPORAL_ANOMALY: {
    id: 'TEMPORAL_ANOMALY',
    group: 'behavioural',
    label: 'Time-of-day surprisal',
    description:
      'Negative log probability, in nats, of the transaction hour under the payer own hour-of-day histogram.',
    rationale:
      'Coercive scams run to the fraudster schedule, not the victim habits, and several typologies deliberately operate outside banking hours so the victim cannot reach their branch. Surprisal is used rather than a fixed night-time window because it adapts to shift workers and to genuinely nocturnal customers, who would otherwise be penalised permanently for a legitimate pattern.',
    unit: 'nats',
    binEdges: [1, 2, 3, 4, 5, 6],
    reasonCodePrefix: 'APP-TIM',
  },

  DEVICE_DRIFT: {
    id: 'DEVICE_DRIFT',
    group: 'identity_device',
    label: 'Device trust age',
    description:
      'Hours since the authorising device was first bound to this payer, forced to zero when the SIM changed inside the risk window.',
    rationale:
      'A newly bound device, or a device on a freshly swapped SIM, is the standard fingerprint of an account takeover and also appears in APP cases where the victim was walked through a re-registration on the fraudster instructions. A recent SIM swap collapses the trust age to zero regardless of how long the handset itself has been known, because SIM-binding is the factor UPI registration actually rests on.',
    unit: 'hours',
    binEdges: [0.017, 1, 24, 168, 720, 4320],
    reasonCodePrefix: 'APP-DEV',
  },

  PAYEE_FAN_IN: {
    id: 'PAYEE_FAN_IN',
    group: 'payee_graph',
    label: 'Unrelated inflow that leaves immediately',
    description:
      'Distinct payers to this beneficiary in the trailing 24 hours, multiplied by the fraction of inbound value moved onward within the hour.',
    rationale:
      'This is a deliberate interaction term, not two signals merged for convenience. Fan-in alone does not separate a mule from a legitimate merchant: both receive money from many unrelated people. What separates them is dwell time. A merchant accumulates and settles on a cycle, so its onward velocity is low; a mule account exists only to forward funds, so its onward velocity approaches one. The product isolates the conjunction that actually identifies a collection account, and it is the single most specific mule indicator available at authorisation time.',
    unit: 'payers x onward-velocity',
    binEdges: [0.5, 1, 2, 4, 8, 16, 32],
    reasonCodePrefix: 'APP-FAN',
  },

  PAYEE_ACCOUNT_AGE: {
    id: 'PAYEE_ACCOUNT_AGE',
    group: 'payee_graph',
    label: 'Beneficiary account age',
    description: 'Hours since this beneficiary was first observed anywhere in the network.',
    rationale:
      'Mule accounts are consumed and discarded. Rented or purchased accounts are cycled quickly once they attract a freeze, so the beneficiary side of a scam payment is disproportionately young in network terms. This is a network-wide observation and therefore survives the mule-rotation adversary, which defeats payer-side history by using a fresh beneficiary each time but cannot manufacture account age.',
    unit: 'hours',
    binEdges: [1, 6, 24, 168, 720, 2160],
    reasonCodePrefix: 'APP-AGE',
  },

  CALL_CONCURRENCY: {
    id: 'CALL_CONCURRENCY',
    group: 'context',
    label: 'Concurrent coercion indicators',
    description:
      'Weighted count of coercion indicators present at authorisation: call duration, screen sharing, and remote-access software.',
    rationale:
      'This is the signal that distinguishes authorised push payment fraud from unauthorised fraud. The victim authenticates perfectly, because it really is them; what is abnormal is that somebody else is on the line telling them what to press. Long concurrent calls, an active screen share, and a running remote-access application are the observable residue of that coaching. The call component scales with duration because a brief call during a payment is unremarkable while a forty-minute one spanning the authorisation is not.',
    unit: 'weighted indicator count',
    binEdges: [0.01, 0.5, 1, 1.5, 2.5, 3.5],
    reasonCodePrefix: 'APP-CAL',
  },

  SESSION_URGENCY: {
    id: 'SESSION_URGENCY',
    group: 'context',
    label: 'Session urgency and instruction-following',
    description:
      'Composite of in-session application switches, how the payee identifier was entered, and time from app open to authorisation.',
    rationale:
      'A victim following instructions behaves differently from a person paying someone they know. They switch away repeatedly to re-read a message, they paste an identifier supplied to them rather than choosing a saved contact or scanning a code in front of them, and they complete the payment unusually quickly because they are being hurried. Each component is weak alone and none is conclusive, which is precisely why it belongs in a fused score rather than in a rule.',
    unit: 'weighted index',
    binEdges: [0.25, 0.75, 1.5, 2.25, 3],
    reasonCodePrefix: 'APP-URG',
  },

  STRUCTURING: {
    id: 'STRUCTURING',
    group: 'structuring',
    label: 'Threshold structuring',
    description:
      'Index combining payments placed just below a monitored threshold, cumulative value that crosses one while each part stays below, and split re-attempts against an open hold.',
    rationale:
      'Once a payer believes a limit is monitored, the natural evasion is to stay under it. The index therefore looks at three things a single-transaction rule cannot see: proximity of this amount to a threshold from below, whether the trailing window sums past a threshold that no individual payment crosses, and whether a payment is a split re-attempt of value already held. The third component is what makes the hold protocol resistant to a payer simply retrying in halves, and it is the countermeasure the structuring adversary is scored against.',
    unit: 'index',
    binEdges: [0.5, 1.5, 2.5, 3.5, 5],
    reasonCodePrefix: 'APP-STR',
  },

  VELOCITY_BURST: {
    id: 'VELOCITY_BURST',
    group: 'behavioural',
    label: 'Velocity against personal baseline',
    description:
      'Transactions in the trailing 24 hours as a multiple of the payer usual daily transaction count.',
    rationale:
      'Scams that run to completion produce a burst: once a victim is under control, the fraudster extracts as much as possible before the victim reconsiders or a limit is hit. Expressing the burst relative to the payer own baseline rather than an absolute count avoids penalising high-frequency users, who would otherwise generate a permanent stream of false positives.',
    unit: 'multiple of baseline',
    binEdges: [1, 1.5, 2, 3, 5, 10],
    reasonCodePrefix: 'APP-VEL',
  },

  DRAIN_RATIO: {
    id: 'DRAIN_RATIO',
    group: 'behavioural',
    label: 'Account drain ratio',
    description:
      'Transaction amount as a fraction of the estimated funds available to the payer.',
    rationale:
      'The defining financial harm of an APP scam is that the victim loses savings rather than pocket money, so scam payments cluster near the top of what the account can actually send. The denominator is an estimate derived from observed spending, not a balance read, and the modelling document is explicit that this weakens the signal relative to a deployment with real balance access.',
    unit: 'fraction',
    binEdges: [0.05, 0.1, 0.25, 0.5, 0.75, 0.9],
    reasonCodePrefix: 'APP-DRN',
  },

  MULE_PROXIMITY: {
    id: 'MULE_PROXIMITY',
    group: 'payee_graph',
    label: 'Graph proximity to a confirmed mule',
    description:
      'Decayed closeness of the beneficiary to the nearest confirmed mule account in the payee graph.',
    rationale:
      'Mule accounts are not used once. They sit in networks that are reused across victims and across typologies, so a beneficiary one or two hops from an account already confirmed in an earlier investigation carries real evidential weight. Closeness is decayed with distance rather than thresholded, because a direct match is far stronger evidence than a three-hop association and collapsing both to a boolean would waste that difference.',
    unit: 'proximity score',
    binEdges: [0.5, 1.5, 2.5, 3.5],
    reasonCodePrefix: 'APP-MUL',
  },
};

/** Stable evaluation order. Fixing it keeps assessment hashes reproducible. */
export const SIGNAL_ORDER: readonly SignalId[] = [
  'PAYEE_NOVELTY',
  'AMOUNT_DEVIATION',
  'TEMPORAL_ANOMALY',
  'DEVICE_DRIFT',
  'PAYEE_FAN_IN',
  'PAYEE_ACCOUNT_AGE',
  'CALL_CONCURRENCY',
  'SESSION_URGENCY',
  'STRUCTURING',
  'VELOCITY_BURST',
  'DRAIN_RATIO',
  'MULE_PROXIMITY',
] as const;

/** Number of bins a signal produces, which is one more than its edge count. */
export function binCount(id: SignalId): number {
  return SIGNAL_SPECS[id].binEdges.length + 1;
}

/**
 * Discretise a raw statistic. Upper-exclusive against each edge in turn, with
 * everything above the last edge landing in the final bin. NaN is mapped to
 * bin zero so a missing input degrades to the reference level rather than
 * throwing inside the authorisation path.
 */
export function toBin(id: SignalId, raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  const edges = SIGNAL_SPECS[id].binEdges;
  for (let i = 0; i < edges.length; i++) {
    if (raw < edges[i]!) return i;
  }
  return edges.length;
}

/** Regulator-facing reason code for a signal and bin, e.g. APP-FAN-5. */
export function reasonCode(id: SignalId, bin: number): string {
  return `${SIGNAL_SPECS[id].reasonCodePrefix}-${bin}`;
}
