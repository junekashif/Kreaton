# Modelling choices and why

**Team Kreaton · COGNITIA 2026 · FINTECH-PS2**

This document explains the decisions behind the engine: what each component does, what it was chosen
over, and what evidence supports the choice. Numbers are quoted sparingly here; the generated
`MODEL_CARD.md` carries every figure from the committed artefacts, and `SENSITIVITY.md` carries the
boundary sensitivities. Where a figure below is an estimate rather than a measurement, it says so.

Contents

1. [The problem as modelled](#1-the-problem-as-modelled)
2. [Data](#2-data)
3. [Signals](#3-signals)
4. [Fusion and calibration](#4-fusion-and-calibration)
5. [Mule chain recoverability](#5-mule-chain-recoverability)
6. [Expected-cost decisioning](#6-expected-cost-decisioning)
7. [Policy as a trade-off interface](#7-policy-as-a-trade-off-interface)
8. [The step-up protocol](#8-the-step-up-protocol)
9. [The compliance trail](#9-the-compliance-trail)
10. [Adversarial evaluation](#10-adversarial-evaluation)
11. [Portfolio reporting](#11-portfolio-reporting)
12. [Engineering choices](#12-engineering-choices)
13. [What was found and fixed during the build](#13-what-was-found-and-fixed-during-the-build)
14. [Limitations and what real data would change](#14-limitations-and-what-real-data-would-change)

---

## 1. The problem as modelled

Authorised push payment fraud differs from card-not-present fraud in the one way that matters for
detection: the customer is present, authenticated, and pressing the button themselves. Device
fingerprinting, credential checks and velocity rules built for account takeover see nothing wrong,
because nothing about the *authentication* is wrong. What is wrong is the *intent*, and intent leaves
a different fingerprint:

- the beneficiary is new, added minutes ago, often by pasting an identifier sent over chat;
- the payer is on a call, sometimes with their screen shared, and moves faster than usual;
- the amount is far outside the payer's own history, frequently close to a round threshold;
- the receiving account is young, receives from many unrelated payers, and empties within minutes;
- when one payment is stopped, the payer tries again, or tries in two halves.

The engine is built around those facts. It is a sending-side, authorisation-time control: it sees the
payment before settlement, has a budget of a few milliseconds, and can approve, hold for re-confirmation,
or decline. It does not see the beneficiary's books; what it knows about the beneficiary is what the
network or an inter-institution sharing arrangement supplies, and that dependency is stated wherever it
matters.

Two framing choices shape everything downstream.

**Money is the objective, not a score.** The system never compares a risk score to a threshold somebody
picked. It computes the expected cost, in rupees, of each available action, and takes the cheapest. The
threshold falls out of the arithmetic and moves with the amount, because the cost of a wrong approval
scales with the payment while the cost of a wrong hold does not. Section 6.

**Every decision must be reconstructible by hand.** The score is a sum. The contributions are listed.
The costs are listed. The audit record contains all of it, sealed. A reviewer who disagrees with a
decision can point at the line that produced it. Section 9.

## 2. Data

### 2.1 Why a synthetic corpus

There is no public dataset of UPI payments labelled for APP fraud with session context. The nearest
public material is PaySim, a mobile-money simulation, which has labels and amounts but no session
context, no device, and almost no repeat originators. Waiting for a dataset that does not exist is not
an option, so the primary corpus is generated, and the generator is treated as part of the model: its
assumptions are documented, its outputs are checked for leakage, and its results are cross-validated on
PaySim to see what survives contact with data nobody on the team made.

### 2.2 Typology grounding

The generator does not draw "fraud" from one distribution. It draws from eight named typologies
(`packages/sim/src/typologies.ts`), each with a written description, a fingerprint explaining why its
context looks the way it does, and its own amount distribution, call probability, screen-share
probability, urgency profile, entry-method mix, structuring propensity, new-device probability,
hour-of-day weights, episode length, and beneficiary reuse rate. Digital arrest runs around the clock
with the longest calls and the largest amounts; investment scams run on one trusted counterparty for
weeks; marketplace scams have a willing payer and no coercion at all. The point is that the corpus
contains the hard cases as well as the easy ones, in shares that reflect published fraud reporting rather
than what would flatter the model.

### 2.3 Leakage controls

A generated corpus makes it easy to build a model that is measuring the generator. Four controls stand
between the corpus and the results:

1. **Chronological split, never random.** The model is fitted on the first sixty percent of the
   timeline and evaluated on the rest. A random split would let the model see a beneficiary on day
   fifty and be tested on the same beneficiary on day twenty, which no deployed system is ever allowed
   to do.
2. **Profiles are advanced after scoring, never before.** `Interceptor.authorize()` folds the payment
   into the payer and beneficiary profiles as its last step. Scoring against a baseline that already
   contains the payment being scored would make every metric optimistic in a way no cross-validation
   would reveal.
3. **Beneficiary intelligence on its own delayed timeline.** A collection account is only confirmed as
   a mule after an earlier victim reports and an investigation links it. Every fraudulent payment in the
   corpus goes to an account that is eventually identified; a replay that applied that knowledge from
   day one would be reading the answer key. `IntelTimeline` in `replay.ts` releases each event at its
   own timestamp, so most fraud is scored with no intelligence at all.
4. **The single-signal guard.** After fitting, the standalone held-out AUC of every signal is computed.
   If any exceeds 0.98, the seed script warns and the CI gate fails. On generated data, a signal that
   separates the classes on its own is almost always an artefact of the generator, not a discovery. This
   guard found three such artefacts during the build (section 13).

### 2.4 PaySim cross-validation

`npm run paysim` maps PaySim's TRANSFER and CASH_OUT rows into the engine's transaction shape with every
session field at its quiet value, then answers two separate questions: how the committed model transfers
without refitting, and how the method performs when refitted on PaySim's own past. The adapter is
conservative and the script names the signals that are constant on PaySim (everything contextual, and
novelty, because originators appear once). The result is not a claim about UPI; it is a check that the
beneficiary-side and amount-side signals are not artefacts of the generator.

## 3. Signals

Twelve signals, in five groups (`packages/core/src/signals/specs.ts`). Each reduces a payment and its
context to one real-valued statistic in natural units, then discretises it against declared bin edges.
Nothing in the signal definitions encodes a risk direction: whether a high value is more or less
suspicious is learned from the data, and several of the statistics are genuinely non-monotonic.

| Group | Signals | What the group sees |
| --- | --- | --- |
| payee_graph | Beneficiary novelty, account age, fan-in × onward velocity, proximity to a confirmed mule | The receiving side: is this a collection account? |
| behavioural | Amount deviation, time-of-day surprisal, velocity burst, drain ratio | The payer against their own history |
| context | Concurrent coercion indicators, session urgency | The social-engineering fingerprint |
| identity_device | Device trust age | Authorising from something the payer has not used before |
| structuring | Threshold structuring | Amounts placed to evade per-transaction limits, including split re-attempts |

Choices worth defending:

**Weight of evidence binning over raw features.** Each bin carries a fitted log-likelihood ratio
`ln P(bin | fraud) / P(bin | legitimate)`, Laplace-smoothed. This is the classic credit-scoring form, and
it was chosen for three reasons. It handles non-monotone signals without a transform. It makes every
contribution a number in nats that sums exactly to the score. And it gives every fired bin a stable reason
code (`APP-AMT-5`, `APP-CAL-4`) that a regulator can be given a table for.

**Robust statistics for the personal baseline.** Amount deviation is a z-score in log space using the
median and the median absolute deviation, not the mean and standard deviation. MAD has a fifty percent
breakdown point: an attacker who seeds the baseline with one large payment before the extraction, which
is a real attack and one the adversarial suite runs, cannot shift it. The baseline is windowed and bounded
so a profile stays a fixed size regardless of tenure.

**Surprisal for time of day.** A fixed night-time window would permanently penalise shift workers. The
signal is the negative log probability of the hour under the payer's own smoothed hour histogram, so it
adapts to whoever the payer actually is.

**Beneficiary fan-in is multiplied by onward velocity.** Many unrelated payers in a day describes a
popular merchant as well as a mule. What distinguishes the mule is that the money leaves immediately. The
velocity is a supplied attribute, because a sending institution cannot observe the beneficiary's outbound
leg from its own books; the dependency is stated in the type definition and in the model card.

**The structuring signal looks at the window, not the payment.** A per-transaction limit cannot see a
total it never observes. The signal accumulates value across a trailing window and fires when the window
crosses a monitored threshold that no single payment crosses, and adds a large fixed penalty for a
re-attempt against an open hold so the hold protocol cannot be defeated by halving the amount.

**Coercion indicators are counted with weights, not as a boolean.** A forty-minute call with screen
sharing is a different situation from a two-minute call. The signal is a weighted count so that the
fitted table can distinguish them.

## 4. Fusion and calibration

### 4.1 Additive log-odds

The fused score is the prior log-odds plus the sum of signal contributions. This is the naive Bayes form
and it was chosen over a gradient-boosted model or a neural network on purpose:

- **It is an explanation, not a summary.** The contributions sum exactly to the score; the engine
  asserts this on every decision (`verifyAdditivity`) and throws if it ever fails. A feature-attribution
  method laid over a black box approximates; this reconstructs.
- **It is fast enough to run in a browser tab.** The whole authorisation path, including the audit
  seal, takes tens of microseconds. The console runs the real engine client-side because of this.
- **Its failure modes are visible.** When a naive Bayes model is wrong it is wrong in ways a reviewer
  can see in the table. A tree ensemble that has learned an artefact of the generator is wrong invisibly.

The known weakness of the form, the independence assumption, is addressed directly rather than accepted.

### 4.2 Group correlation shrinkage

Four behavioural signals firing together are not four independent pieces of evidence. Intra-group
Pearson correlation between per-signal LLRs is estimated on the training window, and when *k* signals in
a group contribute, each is discounted by `1 / (1 + (k − 1) ρ)`. This is applied inside the design
matrix during fitting, so the weights are fitted against exactly what the runtime computes.

### 4.3 Fitted weights

Per-signal weights are fitted by iteratively reweighted least squares with a ridge penalty centred on
one, not on zero. Centring on one means the null model is "trust the weight-of-evidence tables as
fitted"; the penalty pulls a weight away from one only when the data insist, which keeps the model close
to the interpretable form and stops a rare signal from being driven to an extreme by a handful of rows.
The Python cross-check reproduces the weights to five decimal places by penalised maximum likelihood in
SciPy.

### 4.4 The asymmetric evidence cap

This is the one piece of the fusion that is a security decision rather than a statistical one.

A fitted model learns that scam payments almost always coincide with a call, urgency and a pasted
identifier. The arithmetic consequence is that the *absence* of those becomes strong evidence of
innocence. Absence is exactly what an attacker can manufacture for free by changing the script: end the
call before authorising, use the saved payee, take your time. The model then actively argues for the
payment. This was observed during the build, where the first version caught 1.3% of context-suppressed
episodes.

The fix has two parts. The training corpus now contains operationally hygienic fraud, so the tables no
longer learn that quiet context proves innocence. And the total negative contribution from the `context`
group is floored: presence of an attacker-controllable indicator is informative because producing it
costs the attacker something, while absence is not equally informative because producing it costs nothing.
The positive side is left untouched. The adversarial suite measures the result.

### 4.5 Isotonic calibration

The raw sum is well ordered but over-dispersed: the residual independence assumption makes it report
0.99 far too often. A monotone map fitted by pool-adjacent-violators on the training window corrects the
levels without touching the order, which is why discrimination metrics are unchanged by calibration and
reliability metrics are transformed by it. Isotonic was chosen over Platt scaling because the raw score is
not close to logistic in the tails, and over binning because a step function with a fitted number of steps
uses the data where it is dense and not where it is sparse.

The calibration map is compressed to a bounded number of knots kept *where the level moves*, not at even
ranks. The first version sampled by rank; almost every training row sits in the flat region near zero, so
it described the high-risk tail, where all the decisions are made, with two points. The Python cross-check
found this (section 13), and the fix cut expected calibration error by an order of magnitude with no change
to any ranking metric.

## 5. Mule chain recoverability

A payment that turns out to be fraudulent is not lost the moment it settles. It sits in a first collection
account, moves to a second, fans out, and is eventually cashed out. What matters to the sending institution
is the fraction that a freeze order can still reach at the time the fraud is reported, and that fraction
decays with time.

Two estimators are implemented and both are reported:

- **A continuous-time Markov chain in closed form.** Layers are states, exponential dwell per layer,
  hop-or-cash-out at each transition, solved by matrix exponential. Fast, exact, and memoryless, which
  understates how much moves immediately.
- **A lognormal-dwell Monte Carlo** with per-layer traceability. Matches the right-skewed shape seen in
  reported cases, where most first-layer accounts forward within minutes and a minority stall for hours.
  Sampling noise is reported as a Wilson interval rather than hidden.

The Monte Carlo drives decisions because the shape assumption matters most at the short horizons where
interception lives; the gap between the two is reported in the model card so the choice stays visible.

**Traceability by layer** is the parameter that most people leave out. Funds still inside the chain are
only nominally freezable: every hop adds an institution to trace and a fan-out of accounts to serve, so
the probability that a freeze order actually lands falls steeply with depth. The trace view shows both
"still in chain" and "reachable" so the difference is explicit.

**Operational freeze latency** is added to every horizon. An order raised at minute ten that reaches the
receiving bank at minute thirty can only freeze what is still reachable at minute thirty.

Every parameter here (`DEFAULT_RECOVERY_PARAMS`) is a documented estimate informed by published case
reporting, not a measurement from proprietary data. `SENSITIVITY.md` shows that the decision boundary is
insensitive to the recoverable fraction at the default report lag (elasticity below 0.1), because at four
hours almost everything has moved regardless; the estimate matters far more for the value the trace view
reports at short horizons than for the decision itself.

## 6. Expected-cost decisioning

Three actions, each priced in paise:

| Action | Expected cost |
| --- | --- |
| Approve | `p × A × (1 − r) × L` — the liability on the unrecoverable share if it was fraud |
| Hold | `p × (1 − c) × A × (1 − r) × L + F_hold + (1 − p) × a_hold × CLV` |
| Block | `F_block + (1 − p) × a_block × CLV` |

with `p` the calibrated probability, `A` the amount, `r` the recoverable fraction at the report lag, `L`
the liability share borne by the institution, `c` the step-up catch rate, `F` the operational friction
costs, `a` the abandonment probabilities and `CLV` the lifetime margin at risk. The cheapest wins, ranked
on exact values so the executed decision matches the closed-form boundary to the paise rather than to
rounding.

Setting costs equal and solving for `p` gives the two boundaries in closed form (`thresholds()` in
`cost.ts`). Both fall as the amount rises. This is the whole point of the design: a two-lakh payment is
held at a far lower probability than a five-hundred-rupee one, because the downside is four hundred times
larger while the friction is identical. A fixed score threshold has to be wrong at one end or the other.
The console ribbon draws these curves live, and because the engine decides by comparing costs directly,
the drawn boundary and the executed decision cannot drift apart.

Abandonment cost is charged only on legitimate payments (`(1 − p)`), because a fraudster giving up is
the desired outcome, not a cost. This is easy to get wrong and materially changes the block boundary.

## 7. Policy as a trade-off interface

Two audiences set these numbers and they think differently. A risk officer reasons in prices: what a
held payment costs, what an abandoned customer was worth. A conduct or operations team reasons in rates:
no more than this fraction of legitimate customers may be interrupted. Both are supported.

**Prices** are the policy fields, exposed as sliders with named presets (balanced, customer first,
liability first, shared liability, weak step-up, fast reporting). Each preset changes only the fields
that encode a stance; the recoverability and operational timings stay constant because those are
estimates of how the world behaves, not choices about how to behave in it.

**Rate ceilings** are solved, not bolted on. A ceiling on the false-positive or intervention rate is met
by finding the multiplier on friction prices at which the expected-cost engine, unchanged, produces a
rate under the ceiling. Intervention rate is monotone in the friction price, so geometric bisection
converges. This is the Lagrangian form of the constrained problem: the cap is expressed as the shadow
price of friction. It matters for defensibility. A hard cap applied after the fact would mean the
system sometimes approves a payment it has just calculated to be the expensive choice, and no audit record
could explain that. Solving for the price keeps every individual decision internally consistent with the
policy that produced it.

**The trade-off frontier** sweeps the friction price and plots detection against false-positive rate.
The expected-cost minimum is one point on that curve, marked but not privileged; an institution may
rationally choose another for conduct reasons the cost model does not price.

Every policy change is recorded in the ledger with the before and after states, and every decision carries
the digest of the policy in force, so a decision can only be defended against the settings that were live
when it was taken.

## 8. The step-up protocol

A hold is not a delay. It is a request for a second confirmation from a channel the person coaching the
victim does not control, and its entire value rests on that independence.

**Challenge selection is a function of context** (`selectChallenge`). Sending a one-time passcode to
the handset of a victim who is on the phone with the fraudster is not a control: the fraudster says
"read me the code" and the victim, who believes they are talking to the police, reads it out. So:

- any concurrent call, screen share or remote-access session disqualifies on-device passcodes;
- an observed or remotely driven screen disqualifies biometrics too, leaving a cooling period with a
  self-service cancellation the payer can use once alone;
- an active call defers confirmation to after the call ends, which removes the coach and supplies the
  pause the script is designed to prevent;
- a new device or SIM confirms through the registered channel rather than the requesting one;
- a material amount to an unfamiliar beneficiary shows the payer the *registered name* of the account,
  which is the check impersonation typologies cannot survive.

The disqualified factors and the reason are written into the audit record, because the absence of a
control is itself something a reviewer needs to see.

**Re-attempts are the common case**, because a coached victim is told to try again. A retry to the same
beneficiary during an open hold inherits the hold rather than starting over; each retry consumes the
attempt budget; exhausting it escalates to human review; a retry from a different device mid-hold
escalates immediately; and splitting the value across smaller retries is scored by the structuring signal
and refused a reset by the protocol. When the protocol overrides the economics (a low-cost retry that would
otherwise approve), both the economic choice and the override reason are recorded.

## 9. The compliance trail

Every decision, hold event, attempt link, policy change and model load is an append-only record that
commits to the SHA-256 digest of the record before it. Editing or removing any entry invalidates its
digest and every later one, so a third party can verify the chain without trusting the system that
produced it. The verifier reports the first sequence number at which the chain breaks, and the console
demonstrates this by tampering with a copy.

What a record contains is set by what a reviewer needs afterwards, which is not just what the score was
but why that score justified that action on that day: every signal including the quiet ones, with raw
measurement, bin and exact contribution; the model version and digest; the full policy in force; the
expected cost of every action considered; the recoverability assumption; the hold timeline. Payer and
beneficiary identifiers are pseudonymised and addresses masked on the way in, because a compliance trail
needs to be queryable and retained, not to be a second copy of the customer database.

`renderCaseNarrative` turns a case file into a document a compliance reviewer can read without access to
the system, with the arithmetic that produced the score printed so the total can be checked by hand.

## 10. Adversarial evaluation

Six attacks on the system's own assumptions, each with a written premise (why it should work) and the
countermeasure it targets: threshold structuring, false baseline building, delayed extraction, context
suppression, threshold probing, and collection account rotation.

Two comparisons are reported, because they are different claims:

- **Primary: three whole defences at matched friction.** A tuned amount rule (which is what is usually
  deployed), the fused score with a single global threshold, and the full expected-cost system, each
  calibrated to interrupt the same share of legitimate payments on a chronologically captured sample.
  This answers whether any of this improves on what exists, and how much of the gain comes from the score
  and how much from the decision layer.
- **Secondary: ablation.** The full system with and without the countermeasure the attack targets.
  Frequently close to zero and reported anyway: with twelve fused signals, one removal leaves eleven that
  still catch the episode, so an ablation measures marginal contribution rather than importance.

An episode counts as caught when any payment in it is held or blocked, because stopping one payment
breaks a scam episode; counting payments would double-count. Wilson intervals are reported, and the
weakest position is named, because an adversarial evaluation that only lists wins is marketing.

## 11. Portfolio reporting

The held-out window is replayed through the complete interceptor, not the scorer alone, so the reported
figures are produced by the code path that would run in production: cost engine, hold protocol, protocol
overrides and the audit trail included. Ground truth is known, so detection and false-positive rates are
measured.

Two conservative choices: liability avoided counts only the value that would have been unrecoverable at
the report lag, not value that would have been frozen anyway; and a hold only avoids liability on the
fraction of cases the challenge stops. The false-positive rate and the per-typology breakdown sit next to
the money on the same page, because a report that shows only the money is not a report.

## 12. Engineering choices

**One engine, everywhere.** `@kreaton/core` has no dependencies and no platform assumptions, so the
compiled package runs in the console's browser tab, in the `POST /api/v1/authorize` route handler, and in
the test runner. The console is therefore a demonstration of the engine and not a rendering of
precomputed results, and the endpoint and the console cannot disagree.

**Warm profiles ship with the replay slice.** The browser slice is the tail of the corpus, and scoring it
against empty profiles would not be what the evaluation measured. The seed script replays the corpus to
the window start and ships the resulting profiles, trimmed to what the signals can read for the payments
in the window (the novelty signal looks up only the current payee, the windowed signals read only
timestamp and amount), so no decision in the console differs from the full replay.

**Integer paise throughout.** Every value-bearing quantity is an integer; floats appear only at the
presentation boundary and in probabilities.

**Deterministic everything.** A seeded PRNG, no `Math.random`, a canonical JSON for hashing, and a
corpus that regenerates byte for byte. The CI gate asserts determinism.

**Persistence is phased.** A synchronous `Store` interface backs the decision path, because twelve signals
each making a database round trip would spend the latency budget several times over. `MemoryStore` is the
reference implementation; a durable backing hydrates into memory and receives writes through a
`PersistenceSink` after the decision has been returned.

**Deployment runs through GitHub Actions**, which build with the Vercel CLI and upload the prebuilt
output. Vercel's own git integration is disabled so the deployment demonstrably passes the verification
jobs first.

## 13. What was found and fixed during the build

These are recorded because each one presented first as a *good* result.

1. **Account-age leak.** Every legitimate beneficiary was at least thirty days old and every mule was
   recent, so account age alone separated the classes and ROC AUC came out at exactly 1.0000. Fixed by
   giving both sides overlapping age distributions, including rented aged mule accounts. Found by the
   single-signal guard.
2. **Novelty leak.** Legitimate beneficiaries only ever had novelty age zero or months, and fraud sat in
   between. Fixed with realistic add-to-pay gaps and repeat beneficiaries for sustained-relationship
   typologies. Found by the single-signal guard.
3. **Context over-reliance.** Context suppression caught 1.3% of episodes because the model had learned
   that absence of a call proves innocence. Fixed with hygienic fraud in the corpus and the asymmetric
   evidence cap (section 4.4). Found by the adversarial suite.
4. **Stack overflow at scale.** `buildPortfolioReport` used `Math.min(...timestamps)`, which passes every
   element as an argument and overflows above roughly a hundred thousand entries. It only appeared on the
   full corpus, never on `--quick`. Folded into a loop.
5. **Calibration knots sampled by rank.** The pool-adjacent-violators step function kept every
   legitimate row as its own zero-valued block, and even-rank compression then described the high-risk
   tail with two knots, so the committed calibration was close to a straight line. Fixed by merging equal
   levels and keeping knots where the level moves. Found by the Python cross-check, which showed an
   independent isotonic fit reaching an expected calibration error an order of magnitude lower on the same
   data. Ranking metrics were unaffected; the reliability table was.

## 14. Limitations and what real data would change

- **The corpus is synthetic.** Every rate in the model card is a property of a generator built to match
  published typology descriptions. The method, the leakage controls, the guard and the cross-validation
  are the defensible part; the headline numbers are not a forecast of production performance.
- **Beneficiary intelligence is assumed available.** Onward velocity and mule linkage are supplied
  attributes. A deployment without a network-level feed loses most of the payee-graph group; the PaySim
  run shows roughly what remains.
- **Policy prices are estimates.** The sensitivity analysis shows the boundaries depend mostly on the
  step-up catch rate, the liability share and the abandonment assumptions, and hardly at all on the
  recoverable fraction or the hold friction. Those first three are what a pilot should measure.
- **The false-positive rate under the default policy is high for production.** The tooling to trade it
  down is built and the levers are identified; choosing the point is an institution's decision.
- **Behavioural baselines need history.** A payer's first weeks are scored against weak baselines; the
  velocity and amount signals damp accordingly, but a cold-start policy is a deployment question.

With real labelled traffic the fitting pipeline runs unchanged: feature extraction is model-free, the
fitter takes labelled rows, and the cross-check reproduces it independently. What would change is the
generator's role, from primary corpus to adversarial augmentation.
