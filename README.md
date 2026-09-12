# Kreaton

Real-time authorised push payment (APP) fraud interceptor and mule chain tracer for UPI-style payments.
Team Kreaton's entry for COGNITIA 2026, problem statement FINTECH-PS2.

An APP scam is a payment the victim authorises themselves, under instruction from someone posing as
police, a bank, an employer or a partner. The transaction is valid; the intent behind it is not. Kreaton
scores each in-flight payment on twelve behavioural, beneficiary-side and session-context signals,
fuses them into a calibrated fraud probability, estimates how much of the money could still be frozen
if the payment turns out to be a scam, prices the three possible actions in rupees, takes the cheapest,
and seals the whole reasoning into a hash-chained audit trail. Held payments go through an out-of-band
re-confirmation protocol designed not to be relayable by the person coaching the victim.

Everything runs from one dependency-free TypeScript engine that executes identically in a browser tab,
in a server route handler and in the test runner.

**Live console: https://kreaton-upi.vercel.app** — press "Watch it run" to replay the held-out
window. The engine runs in the tab, so the decisions on screen are computed there and not read back
from a recording.

## What is here

| Path | What it is |
| --- | --- |
| `packages/core` | The engine: signals, fusion, calibration, recoverability, expected-cost decisioning, hold protocol, audit ledger. No dependencies. |
| `packages/sim` | Corpus generator, chronological replay, fitter, metrics, portfolio report, adversarial suite, PaySim adapter, model card generator, dataset importer CLI. |
| `packages/ingest` | Dataset import: delimited and JSON reading, column matching, coercion, and the report of what a file cannot supply. No dependencies. |
| `packages/sheets` | Durable write-behind persistence of the audit trail to a Google Sheet. No dependencies beyond Node's crypto. |
| `apps/web` | The console: live interception ribbon, policy studio, mule chain trace, compliance trail, adversarial and portfolio reports, model card, your-own-data import, and the authorisation API. |
| `analysis` | Python cross-check of the hand-written statistics against NumPy, SciPy and scikit-learn, and the policy sensitivity analysis. |
| `data` | Committed artefacts: fitted model, fit diagnostics, held-out metrics, portfolio report, adversarial results, and the replay slice the console uses. |
| `docs` | `MODELING.md` (why each choice was made), `MODEL_CARD.md` (generated from the artefacts), `SENSITIVITY.md` (generated), `DATA_INPUT.md` (bringing your own dataset), `PERSISTENCE.md` (where state lives). |
| `.github/workflows` | `ci.yml` runs typecheck, lint, tests, the model quality gate and a production build; `deploy.yml` builds with the Vercel CLI and ships the prebuilt output. |

## Requirements coverage

| Requirement | Where |
| --- | --- |
| Multi-signal behavioural evaluation | `packages/core/src/signals/` — twelve signals with written rationale, bin edges and reason codes |
| Defendable risk-score fusion | `packages/core/src/fusion.ts` — additive log-likelihood ratios, group correlation shrinkage, asymmetric evidence cap, isotonic calibration; every contribution reconstructs the score |
| Time-decay mule chain recoverability | `packages/core/src/recovery.ts` — closed-form CTMC and lognormal Monte Carlo with per-layer traceability; `/trace/[txnId]` |
| Expected financial cost decision engine | `packages/core/src/cost.ts` — three actions priced in paise, boundaries derived in closed form and drawn live on the console ribbon |
| Tunable false-positive versus liability policy | `packages/core/src/policy.ts` and `/policy` — presets, sliders, trade-off frontier, rate ceilings solved as a shadow price of friction |
| Step-up friction protocol | `packages/core/src/hold.ts` — context-dependent challenge selection, re-attempt linking, split detection, attempt budget, escalation |
| Auditable compliance trail | `packages/core/src/ledger.ts` and `/audit` — SHA-256 hash chain, redaction, query, regulator narrative, tamper check, JSONL export |
| Adversarial countermeasure evaluation | `packages/sim/src/adversary.ts` and `/adversarial` — six attacks against three defences at matched friction, with ablations |
| Portfolio risk reporting | `packages/sim/src/report.ts` and `/portfolio` — held-out replay with ground truth, liability avoided net of recovery, per-typology detection |
| Justified modelling choices | `docs/MODELING.md`, `docs/MODEL_CARD.md`, `docs/SENSITIVITY.md`, `analysis/crosscheck.py` |
| Evaluation on data you supply | `packages/ingest` and `/data` — CSV, TSV or JSON in the console, the API or the CLI, each reporting what the file cannot show; `docs/DATA_INPUT.md` |
| Durable record of decisions | `packages/sheets` and `PersistenceSink` — the sealed ledger written to a Google Sheet behind the decision path; `docs/PERSISTENCE.md` |

## Running it

Node 20.9 or later. Python 3.11 or later with NumPy, SciPy, pandas and scikit-learn for the optional cross-check.

```bash
npm install
npm run typecheck          # engine, importer, sheets sink, simulation and console
npm test                   # 107 unit tests
npm run gate               # model quality gate on a reduced corpus, as run in CI
npm run dev                # console at http://localhost:3000
```

Nothing above needs a network, a database or an API key. The console runs the real engine in the
browser tab against a committed slice, so `npm run dev` is enough to see every screen working.

Regenerate the committed artefacts from the seed (about six minutes at full scale):

```bash
npm run artefacts          # seed, evaluate, adversarial, model card
npm run seed -- --export   # also writes data/export/features.csv for the Python cross-check
python analysis/crosscheck.py
python analysis/sensitivity.py
```

Any script accepts `--quick` for a 1,200 payer, 21 day corpus.

External cross-validation on PaySim is optional. Download the Kaggle dataset, place the CSV under
`data/paysim/`, and run `npm run paysim`. Without the file the script says so and exits cleanly.
The general importer will also read it: `npm run ingest -- --file=<the csv> --preset=paysim`.

## Your own data

The console ships with a slice of the generated corpus and will replace it with a file of yours.
Open **/data**, drop in a CSV, TSV or JSON file, confirm the column mapping it proposes, and replay
it: the feed, the assessment panel, the audit ledger and the policy studio all then read from your
file. A bank statement works — no payer column and no beneficiary number are both handled — and so
does PaySim. The same page composes a single payment by hand, so you can move one field at a time
and watch the decision move with it.

```bash
npm run ingest -- --file=data/samples/upi-log-sample.csv     # labelled, with session context
npm run ingest -- --file=data/samples/statement-sample.csv   # a passbook export
npm run ingest -- --file=<yours> --preset=paysim --out=data/mine-metrics.json
```

Where a file carries ground truth the CLI reports the same figures the model card does, so a result
on your data is comparable with the committed ones.

Every route into the engine also reports what the file **cannot** show. Almost no real dataset
carries UPI session context, and without it the engine sees every payment as though the attacker had
suppressed every indicator they control — the weakest position in the adversarial report. A detection
rate measured that way is a floor, and it is labelled as one rather than left to stand alone.
`docs/DATA_INPUT.md` has the detail.

## The API

```
GET  /api/v1/health            model and policy digests, ledger head, persistence status
GET  /api/v1/authorize         a complete example request body
POST /api/v1/authorize         authorise one payment
POST /api/v1/authorize/batch   authorise an ordered run, state carrying forward between payments
POST /api/v1/import            match a file's columns and report on it; optionally replay it
```

The authorisation response carries the decision, the calibrated probability, reason codes, the hold
opened (if any) with the challenge to present, the full assessment, and the sealed ledger position.
Invalid bodies return every problem at once.

The batch endpoint is not a loop around the single one: the structuring window, the hold linkage and
every behavioural baseline carry forward between payments, so a run scored together gives different
and correct answers. `/api/v1/import` replays on a scratch engine so a file sent to be understood
leaves nothing behind in the live one.

## Where state lives

Hot profile state is held in memory, because an authorisation has a budget of a few milliseconds and
twelve signals each making a database round trip would spend it several times over. Durability is
layered behind the working set: `PersistenceSink` in `packages/core/src/store.ts` receives writes
after the decision has already been returned.

Two backings are wired up. In the browser, an imported dataset and the replay position are kept in
IndexedDB, so a refresh no longer costs you the file you just mapped. On the server, setting
`KREATON_SHEETS_ID` and `KREATON_SERVICE_ACCOUNT_JSON` copies the sealed ledger, the payments and the
holds into a Google Sheet — batched, because Google allows about sixty writes a minute, and behind
the decision path, because a persistence failure must never fail an authorisation. A rate limit keeps
its rows for the next flush; a permanent refusal lets them go rather than queueing behind an error
that will never clear, and `/api/v1/health` reports `written`, `failed` and `dropped` so a sink that
is configured but failing cannot pass for one that is working.

Both are optional. Unset, the engine behaves exactly as before and the health endpoint says
`backing: memory`. The Sheets path is verified end to end against the real API, including a check
that a 64-digit hash survives the round trip unchanged. `docs/PERSISTENCE.md` has the setup and the
one step people miss.

## Deployment

Production is deployed by GitHub Actions, not by Vercel's git integration, which is disabled in
`apps/web/vercel.json`. On every push to the main branch `deploy.yml` typechecks, lints, tests, runs the
model gate, then runs `vercel build` and `vercel deploy --prebuilt --prod`, and finally smoke-tests the
health endpoint of the deployment it produced.

The smoke test runs through `vercel curl` rather than plain `curl`. `vercel deploy` prints the unique
deployment URL, and deployment protection gates that URL even for a production deployment: a plain
request to it is redirected to a login page, so the test would fail on every deploy while the site
itself was healthy. The production domain is not gated.

Without the secrets the deploy job skips itself rather than failing, so a copy of this
repository that holds none of them — a fork, or the hackathon organisation's copy —
still runs the tests and the model gate and shows a clean result.

Set up once:

1. Create a Vercel project with **Root Directory** `apps/web`. Leave "Include source files outside of
   the Root Directory" enabled; the console imports the workspace packages and `data/`.
2. Add repository secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` (the last two are in
   `.vercel/project.json` after `vercel link`).

Building on Windows is the one thing that does not work: `vercel build` creates symlinks under
`.vercel/output`, which the OS refuses without Developer Mode. Deploy from Windows with
`vercel deploy --prod`, which builds remotely, or let the workflow do it on Linux.

## Results at a glance

Figures below are from the committed artefacts and are reproduced in full in `docs/MODEL_CARD.md`.
They are measurements on a synthetic corpus, reproducible from the seed, and not claims about live
UPI traffic.

- Held-out ROC AUC 0.996, recall 93% at a 1% false-positive ceiling, expected calibration error
  0.002, no single signal above 0.95 alone. The hand-written statistics reproduce in scikit-learn to
  six decimal places (`analysis/crosscheck.py`).
- Full-engine replay of the held-out window under the default policy: 80.9% of fraud caught by count,
  95.7% by value, interrupting 0.15% of legitimate payments at 74.8% precision; ₹8.9 crore of
  compensation liability avoided against ₹3.3 lakh of friction.
- Adversarial: at matched friction the full system catches 73.8% of attacked episodes against 13.1%
  for a tuned amount rule; under the liability-first preset, 81.1% against 19.3%.
- Authorisation latency: mean 0.04 ms, p99 0.12 ms for twelve signals, fusion, recoverability, three
  costs and a sealed audit record.
- 107 unit tests and a 16-check model quality gate run on every push; both must pass before a
  deployment is built.

## Licence

MIT. Copyright Team Kreaton.
