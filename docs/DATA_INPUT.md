# Bringing your own data

**Team Kreaton · COGNITIA 2026 · FINTECH-PS2**

Four ways to put a dataset of your own through the engine, and — the part that
matters more — what any given file can and cannot tell you once it is in.

---

## 1. The short version

| Where | Good for | Limit |
| --- | --- | --- |
| `/data` in the console | seeing your file replayed, with the assessment panel, the ledger and the policy studio all reading from it | 50,000 payments, one browser tab |
| `/data` → **One payment** | changing one field at a time and watching the decision move | one payment |
| `POST /api/v1/import` | an integrator checking their export's shape without a browser | 20,000 rows per request |
| `npm run ingest` | a whole dataset with full metrics, comparable with the model card | none |

All four share one implementation, `@kreaton/ingest`. Reading, column matching,
coercion and the honesty report are the same code in every case.

## 2. What the importer accepts

**Formats.** CSV, TSV, semicolon- or pipe-delimited text, or JSON. The
delimiter is sniffed by consistency rather than frequency, so a narration
column full of commas does not fool it. Quoted fields, embedded newlines,
doubled quotes and a UTF-8 byte order mark are all handled. JSON may be a bare
array, or an object with the array under `transactions`, `rows`, `data`,
`items`, `payments` or `records`; nested objects are flattened to dotted keys,
so `context.activeCall` reads exactly like a column of that name.

**Amounts.** Indian and Western digit grouping (`1,20,300.50` and
`120,300.50`), a leading `₹`, `INR` or `Rs.`, a trailing `Dr`/`Cr`, and
accounting parentheses. The sign is discarded — direction is a separate field,
and a statement that writes outgoing money as a negative should not produce a
negative payment. Columns are read as rupees unless the column is named in
paise or you say otherwise.

**Timestamps.** Epoch milliseconds, epoch seconds, ISO 8601, `dd/mm/yyyy`,
`mm/dd/yyyy`, `yyyy-mm-dd`, and PaySim-style step numbers counting hours. The
order is resolved from the data where it can be (`25/04` can only be a day),
and where it genuinely cannot the importer states the convention it assumed
rather than picking silently. You can override it per column.

**Layouts recognised outright.** `kreaton` (this engine's own shape), `paysim`
(the Kaggle mobile-money set), and `statement` (a passbook export). A preset is
a starting point for the mapping panel, never a bypass of it.

## 3. The two fields you may not have, and what happens

Only the **amount** is truly required. The other two required-looking fields
have defensible substitutes, which is what lets a bank statement work at all:

- **No payer column.** A statement is written from one account's point of view
  and never names the account holder. The whole file is read as one payer, and
  the report says so.
- **No beneficiary identifier.** A statement names the counterparty in the
  narration and numbers it nowhere. The name, folded to a stable slug, becomes
  the identity — so `RAMESH TRADERS`, `Ramesh Traders` and `UPI/RAMESH TRADERS.`
  are one beneficiary rather than three. That is what makes the payee-graph
  signals work on a statement.

## 4. The part that matters: what your file cannot show

This is why the import report exists and why it is impossible to skip.

A UPI authorisation carries session context — a live call, a pasted identifier,
a freshly bound device — that **no bank statement and no public dataset
contains.** Importing such a file does not mean those signals are neutral. It
means the engine sees every payment as if the attacker had suppressed every
indicator they control:

> no call, no urgency, a typed identifier, a trusted device

That is precisely the **suppressed-indicator position** from the adversarial
suite (`docs/MODELING.md` §10), the engine's weakest one, and the case the
asymmetric evidence cap (§4.4) exists to handle. A detection rate measured that
way is a **floor**, not a representative figure — and the console, the API and
the CLI all say so next to the number rather than letting it stand alone.

The report also names:

- every field left at its quiet value, marked with a dot in the mapping itself
  so the cost of an unmapped column is visible while you are mapping;
- every field substituted harmlessly, and with what;
- rows dropped, counted by reason;
- unreadable cells, counted by column, with examples;
- **structural limits of the dataset** — if beneficiaries almost never repeat,
  novelty fires on nearly every row and carries little information; if payers
  have a handful of payments each, the behavioural baselines have almost
  nothing to measure against. Both are stated in those words.

If the file has no ground-truth column, accuracy is not reported at all. It is
not estimated, and a payment the file never labelled is shown as *no ground
truth* rather than *labelled legitimate* — the file's silence is not a fact
about the payment.

## 5. Things the importer does that are easy to get wrong

- **Payments are sorted by time**, stably, before anything is scored. A file in
  reverse chronological order would otherwise have every payment judged against
  a future it has not had yet.
- **Credits are not payments.** A row with a movement type meaning money in, or
  a value in a credit column and none in the debit column, seeds the balance and
  is not scored. PaySim's `PAYMENT` and `DEBIT` are money *leaving*; only
  `CASH_IN` is money arriving.
- **Beneficiary novelty is derived from the file's own history.** The first
  payment to a beneficiary reads as new; later ones read as established. Nothing
  is asserted that the file did not say.
- **Confirmed-mule markings are released at the row's timestamp**, never applied
  retroactively. A payment is never scored with knowledge that arrived after it.
- **A running balance, if present, is used.** The drain-ratio signal normally
  divides by an estimate inferred from spending history; given a real balance it
  divides by the measurement instead, and the evidence line says which.

## 6. The command line

```bash
npm run ingest -- --file=data/mine.csv
npm run ingest -- --file=data/paysim/PS_20174392719_1491204439457_log.csv --preset=paysim
npm run ingest -- --file=data/mine.csv --out=data/mine-metrics.json
npm run ingest -- --file=data/mine.csv --map=payerId=account_no,amountPaise=txn_value
```

Where the file carries ground truth this reports the same figures the model card
does — ROC AUC, PR AUC, KS, Brier, calibration error, and recall at fixed
false-positive ceilings — so a result on your data is directly comparable with
the committed ones. `--out` writes the whole report as JSON.

Note that a cold replay has no warm profiles: unlike the committed evaluation,
which builds sixty days of baselines before the test window opens, this starts
from nothing. On a short file most payers will have very little history, and the
report says so.

## 7. The HTTP surface

```bash
# What would you make of this file? Returns the proposed mapping and the report.
curl -X POST /api/v1/import -H 'content-type: application/json' \
  -d '{"text":"date,payer,payee,amount\n2026-04-01,ravi.k,shop1,480\n"}'

# Same, but replay it and return decisions.
curl -X POST /api/v1/import -H 'content-type: application/json' \
  -d '{"text":"...","authorize":true}'

# One payment, the production path.
curl -X POST /api/v1/authorize -H 'content-type: application/json' -d @payment.json

# An ordered run. Not a loop around the single endpoint: the structuring window,
# the hold linkage and every behavioural baseline carry forward between payments,
# so a run scored together gives different and correct answers.
curl -X POST /api/v1/authorize/batch -H 'content-type: application/json' \
  -d '{"transactions":[...]}'
```

`GET` on any of them returns a working example body.

`/api/v1/import` replays on a **scratch engine**, never the one behind
`/api/v1/authorize`. A file sent there to be understood does not leave its
payers, its beneficiaries or its ledger entries behind in the live one.
`/api/v1/authorize/batch` does the opposite, on purpose: it is the production
engine, and a bad row is reported in place rather than losing the run.
