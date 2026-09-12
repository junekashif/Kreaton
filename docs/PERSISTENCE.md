# Persistence

**Team Kreaton · COGNITIA 2026 · FINTECH-PS2**

Where the engine's state lives, what survives what, and how to point the audit
trail at a Google Sheet.

---

## 1. Why the engine holds state in memory

`Store` in `packages/core/src/store.ts` is a synchronous interface, and that is
a decision rather than an oversight. An authorisation has a budget measured in
single-digit milliseconds. Twelve signals each making a database round trip
would spend that budget several times over before any arithmetic happened.
Production fraud engines hold hot profile state in memory for exactly this
reason.

Durability is therefore layered **behind** the working set rather than in front
of it:

```
  payment ──▶ [ in-memory Store ] ──▶ decision returned   (microseconds)
                     │
                     └──▶ PersistenceSink ──▶ durable backing   (whenever)
```

`PersistenceSink` receives writes *after* the decision has already been
returned. Its contract is one sentence long and it is the important one:
**an implementation must never throw into the caller.** A persistence failure
is an operational incident, not a reason to fail an authorisation that has
already been made.

## 2. What survives what

| | Survives a page reload | Survives an instance recycling | Visible to others |
| --- | --- | --- | --- |
| Console session (browser) | — | n/a | no |
| Imported dataset (browser, IndexedDB) | **yes** | n/a | no |
| Server engine state (memory) | n/a | — | no |
| Audit ledger in a Google Sheet | **yes** | **yes** | **yes** |

Two independent mechanisms, because they solve different problems.

**In the browser**, `apps/web/lib/persist.ts` keeps the imported dataset and
the replay position in IndexedDB. A refresh no longer costs you the file you
just mapped. Engine state itself is *not* stored: replaying a file is
deterministic, so restoring the file and the cursor reproduces exactly the
state that was lost, for a fraction of the complexity of serialising profiles,
holds and a hash chain. Nothing leaves the device.

**On the server**, `@kreaton/sheets` copies the sealed audit ledger, the
payments and the holds into a spreadsheet. That is the record that outlives the
process and that somebody else can open.

## 3. Setting up the Google Sheet

Five steps, once.

1. **Create a Google Cloud project** and enable the Sheets API on it:
   <https://console.cloud.google.com/apis/library/sheets.googleapis.com>

2. **Create a service account** under *IAM & Admin → Service Accounts*. It
   needs no project roles; its access comes from the sheet being shared with
   it. Create a **JSON key** for it and download the file.

3. **Create a spreadsheet.** Its id is the long string in the URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`

4. **Share the spreadsheet with the service account**, as **Editor**, using the
   `client_email` from the key file. It looks like
   `something@your-project.iam.gserviceaccount.com`. This step is the one
   people miss; without it every write comes back `403`.

5. **Set two environment variables** on the deployment:

   ```
   KREATON_SHEETS_ID=<the spreadsheet id from step 3>
   KREATON_SERVICE_ACCOUNT_JSON=<the entire contents of the key file>
   ```

   On Vercel: `vercel env add KREATON_SERVICE_ACCOUNT_JSON production` and paste
   the file. Escaped `\n` inside the private key are handled, so pasting through
   a shell that mangles newlines is survivable.

   Optionally, `KREATON_SHEETS_FLUSH_MS` (default `5000`) sets how long rows may
   wait before being sent.

Nothing is required. With the variables unset the engine runs exactly as it did
before, and `GET /api/v1/health` says so:

```json
{ "persistence": { "backing": "memory", "note": "State lives in this instance…" } }
```

With them set, the same endpoint reports what the sink has actually done:

```json
{ "persistence": { "backing": "google-sheets", "written": 1420, "failed": 0,
                   "dropped": 0, "buffered": 12, "lastError": null } }
```

`failed` and `dropped` are the numbers to watch. A sink that is configured but
failing is worse than no sink at all, because it looks like a record is being
kept.

## 4. What lands in the sheet

Three tabs, created on first use with a header row.

| Tab | One row per | Carries |
| --- | --- | --- |
| `ledger` | sealed audit record | sequence, kind, payment, decision, calibrated probability, reason codes, and both hashes of the chain |
| `transactions` | payment | the payment and its full session context |
| `holds` | hold | state, challenge type, window, attempts used and the payments linked to it |

Payer and beneficiary **profiles are deliberately not written.** They are hot
working state, rewritten on every payment and reconstructible from the
transaction history; copying them would spend the entire write quota on rows
nobody reads.

Values are written with `valueInputOption=RAW`. Under Sheets' usual
`USER_ENTERED` mode a hash beginning with a digit, an identifier that looks
like a date and a reason code starting with a minus would all be silently
reinterpreted, and the copy would stop matching the ledger it came from.

### Serverless, and the one thing that bit

The sink flushes on a timer. On a long-lived process that is the right shape;
on Vercel it is the wrong one, because the instance is frozen the moment the
response goes out, and a flush that fires afterwards starts a TLS handshake to
Google that never completes. The first production run reported, every time:

> fetch failed (Client network socket disconnected before secure TLS connection was established)

and wrote nothing. `persistAfterResponse()` in `apps/web/lib/server-engine.ts`
fixes it with `waitUntil` from `@vercel/functions`, which keeps the instance
alive until the flush settles without delaying the response — exactly the
write-behind contract. Every route that produces a decision calls it. The sink
itself stays platform-agnostic; that function is the only place that knows it
is on Vercel.

A consequence worth knowing: the counters in `/api/v1/health` are **per
instance**. The request that reads them may land on an instance other than the
one that just flushed, so `written: 0` there is not evidence that nothing was
written. The sheet is the source of truth; the health endpoint is a signal, and
`lastError` is the field that matters.

## 5. The quota, and why everything is batched

Google allows roughly **sixty write requests per minute per user**. A replay at
sixty payments a second would exhaust that in one second.

So `GoogleSheetsSink` buffers. Rows accumulate and are sent when the buffer
reaches `maxBufferedRows` (400) or when `flushIntervalMs` elapses (5s),
whichever comes first, which turns a per-payment cost into a per-interval one.
One flush runs at a time, so rows cannot arrive out of order and concurrency
cannot double the quota.

Failures are handled by kind, because they mean different things:

- **429 or 5xx** — retryable. The rows go back on the buffer for the next
  interval.
- **anything else**, `403` above all — permanent. The same request would fail
  identically forever, so the rows are let go and counted in `dropped` rather
  than accumulating behind an error that is never going to clear.
- **a long outage** — the queue is capped at `maxQueuedRows` (20,000). Beyond
  that the oldest rows are dropped and counted. A memory leak in an
  authorisation path is worse than a gap in a spreadsheet.

## 6. Is a spreadsheet the right database?

For the audit trail, and at this scale: yes, and it has one property no real
database has, which is that a judge, an auditor or a colleague can open it in a
browser and read it without being given credentials or shown a query tool.

For the hot path: no, and it is not used there. Profiles stay in memory.

If this needed to run at portfolio volume the sink is the seam to replace —
`PersistenceSink` is five optional methods, and a Postgres implementation would
slot in beside this one without the interceptor knowing. That is the point of
the interface. What would change is throughput, not the architecture.

## 7. Verifying it

The package is tested against a fake transport (`packages/sheets/src/sheets.test.ts`,
22 tests) covering the assertion's claims, token caching, tab creation, RAW
appends, batching, the retry split, the memory bound, and the promise that no
failure reaches the engine. Those tests need no credentials and no network.

It has also been run end to end against the real Sheets API: a live token
exchange, tab creation, batched appends, and a read-back confirming a 64-digit
hash survives the round trip byte for byte — which is what the `RAW` choice in
section 4 exists for.

**The fake hid one bug, and it is worth recording which.** `LedgerEntry` is a
discriminated union, and on an `ASSESSMENT` the payment, the decision and the
probability sit under `entry.assessment`, not at the top level. The sink read
them off the entry directly. The unit tests passed, because their fixture
invented a flat entry shape the engine never emits; the real ledger tab came
out with four empty columns on every decision. The fixtures are built from the
real union now, and there is a test per entry kind. A fake transport verifies
the transport; it cannot verify an assumption about the data.

To check a real sheet end to end once the variables are set:

```bash
curl -s https://<deployment>/api/v1/health | jq .persistence
curl -s -X POST https://<deployment>/api/v1/authorize \
  -H 'content-type: application/json' \
  -d "$(curl -s https://<deployment>/api/v1/authorize | jq .example)"
# wait for the flush interval, then look at the sheet
```
