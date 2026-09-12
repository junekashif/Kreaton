# Build progress and handoff

**Project:** COGNITIA 2026, FINTECH-PS2 — real-time APP fraud interceptor and mule-chain tracer.
**Author:** Team Kreaton.
**Last updated:** 2026-09-12 (session 5).

This file records where the build stands so work can resume without re-deriving
decisions. It ships with the repository on purpose: the calibration bug in session 2 and
the CI and deploy fixes in session 4 are the kind of thing a reader should be able to
check rather than take on trust.

---

## Status: submitted, deployed, pipeline green

| Where | What |
| --- | --- |
| Live console | **https://kreaton-upi.vercel.app** (public, production, no login) |
| Submission repo | `Cognitia-IEM/KREATON` (private, org-owned; the hackathon's copy) |
| Own repo | `junekashif/Kreaton` (public; this is the deploy source) |
| Vercel project | `kreaton-upi` under team `voice-7c83`, id `prj_UdZKy2CDnv1rDpCOCcoFB0s6vp08`, Root Directory `apps/web`, Node 24.x |
| CI | `ci.yml` and `deploy.yml` both pass on every push to `junekashif/Kreaton`; on the org copy the deploy job skips itself (no secrets there) and CI passes |
| User manual | `C:/Users/kakas/OneDrive/Desktop/Kreaton-User-Manual.pdf`, 16 pages, A4; web copy at https://claude.ai/code/artifact/4e02496d-40e0-49f2-ad2f-8a67fef0cc1c |

Everything in the original scope is built and verified:

| Area | State |
| --- | --- |
| `packages/core` engine | complete, 51 tests pass, typechecks |
| `packages/sim` | complete, plus `gate.ts`, `paysim.ts`, `modelcard.ts`, `ingest.ts`, barrel `index.ts` |
| `packages/ingest` | complete, 31 tests, zero dependencies |
| `packages/sheets` | complete, 25 tests; verified end to end against the real Sheets API and live on production |
| `apps/web` console | complete: `/`, `/data`, `/policy`, `/trace`, `/trace/[txnId]`, `/audit`, `/adversarial`, `/portfolio`, `/model`, `POST /api/v1/authorize`, `POST /api/v1/authorize/batch`, `POST /api/v1/import`, `GET /api/v1/health`. Lint clean, `next build` clean, verified from a cold clone |
| `.github/workflows` | `ci.yml` (typecheck, lint, tests, gate, build) and `deploy.yml` (preflight, verify, `vercel build`, `vercel deploy --prebuilt --prod`, authenticated smoke test) |
| `analysis/` | `crosscheck.py` (10/10 checks pass against sklearn), `sensitivity.py` (writes `docs/SENSITIVITY.md`) |
| Docs | `README.md` (links the live console), `LICENSE` (MIT, Team Kreaton), `docs/MODELING.md`, `docs/MODEL_CARD.md` (generated), `docs/SENSITIVITY.md` (generated), `docs/DATA_INPUT.md`, `docs/PERSISTENCE.md` |
| Artefacts | `data/{model,fit,metrics,portfolio,adversarial,adversarial-liability_first}.json`, `apps/web/public/data/{model,slice}.json` |

## Agreed stack decisions (unchanged)

| Decision | Choice |
| --- | --- |
| Engine | TypeScript, isomorphic, zero dependencies; the console runs it client-side against a warm slice |
| Sidecar | Python in `analysis/`, offline, cross-checks the TS statistics; nothing the runtime reads |
| Deploy | GitHub Actions drives the Vercel CLI; Vercel git auto-deploy disabled in `apps/web/vercel.json` |
| Persistence | `MemoryStore` behind `Store`; durable backing later |
| Data | Synthetic corpus primary; PaySim adapter for external cross-validation, degrades cleanly when the CSV is absent |
| Authorship | "Team Kreaton" only. No assistant attribution anywhere, including commit trailers. `agentRules: false` in `next.config.ts` stops Next writing instruction files |

## Session 2: calibration fix and the corrected operating point

1. **Calibration bug found and fixed** (`packages/sim/src/fit.ts`). PAVA never merged equal
   levels, so the step function kept every legitimate row as its own zero block; even-rank
   knot compression then described the whole high-risk tail with two knots. The committed
   calibration was close to a straight line from log-odds −11.6 to +20. Found by
   `analysis/crosscheck.py` (sklearn isotonic reached ECE 0.0018 against the committed
   0.0144). Fix: merge equal levels, keep knots where the level moves. Ranking metrics
   unchanged; ECE 0.0144 → 0.0019.
2. **The operating point moved as a consequence.** Under the default policy: FPR 3.14% →
   0.145%, precision 14.1% → 74.8%, detection 96.9% → 80.9% by count (99.7% → 95.7% by value),
   net benefit ₹8.96 Cr → ₹8.86 Cr with 16× less friction. The "FPR too high" open question
   from session 1 was this bug. Adversarial at matched friction: 73.8% vs 13.1% for the rule
   (balanced); 81.1% vs 19.3% (liability-first, `data/adversarial-liability_first.json`).
   Weakest position is context suppression (25% / 37.5%).
3. **Warm profile snapshots ship with the web slice** so the console's decisions match the
   full replay. `seed.ts` replays to the window start and trims the snapshot to what the
   signals can read (3.4 MB raw, ~760 KB gzipped).
4. **`fit.json` split from `metrics.json`** because seed and evaluate used to overwrite each
   other's `metrics.json`.
5. **CI gate bands** were recalibrated to the honest operating point (`gate.ts`).
6. **Injected scenarios** in the console were tuned against the corrected calibration:
   digital arrest and KYC block at ~97%; structuring passes the first payment then blocks;
   split re-attempt holds with `NAMED_PAYEE_CONFIRMATION`, links retries, escalates; the
   hygienic attacker usually passes under balanced and is held under liability-first
   (stated in the scenario text); the legitimate large payment approves.

## Session 3: comprehension pass on the console

The console read as an instrument for someone who already knew the problem. A
first-time visitor landed on all-zero counters with the Play button small and
top right, and 99% of feed rows said "Approve", so the one blocked scam was
invisible. Nothing said what the product does. The engine was not touched.

1. **An orientation band opens `/`**: one plain sentence on what APP fraud is
   and what the engine does about it, then the three outcomes as a key that
   doubles as the legend -- same glyphs, same hues, same live counts as the
   ribbon and feed, so reading the header teaches the rest of the screen. The
   primary action is now "Watch it run", and it breathes until first use.
2. **Plain labels, technical terms kept as secondary.** "Scam risk" over
   `p(fraud)`, "Genuine payments stopped" over "false positives", "Why it
   decided that" over "Assessment". No figure lost its precise name.
3. **A feed filter, "Only the ones it stopped"**, which is the fastest way to
   see what the system is for.
4. **Colour corrected against the dataviz validator.** Approve moved from hue
   165 to 195: green against the block red measured a deutan delta-E of 7.6,
   the weakest pair in the palette and the most important distinction in the
   product. At 195 the worst pair is block against hold at 13.5. The ramp's
   light end moved from L 0.36 to 0.44 (it sat at 1.76:1 against the ground,
   under the 2:1 floor) and the second stop to 0.52 to keep the step gaps.
   `lib/risk.ts` mirrors both. Two validator checks are declined deliberately:
   the dark lightness band (our ground is far darker than the one it assumes,
   and contrast passes at >= 3:1) and single-hue (the ramp is magma-style and
   monotonic, which the rule is not aimed at).
5. **Motion, tied to data only.** Figures animate to new values, the newest
   feed row washes in its decision colour, an interception marks itself with a
   rule in its own hue. `prefers-reduced-motion` is honoured globally and
   verified under emulation. Nothing animates on scroll.
6. **Responsive.** Fluid type via `clamp()`, nothing under 11.5px, 44px touch
   targets and 16px form controls under `pointer: coarse`, a fade telling you
   the nav scrolls, and card layouts for the feed and the evidence table below
   760px. All seven routes verified free of horizontal overflow at 390px.

One real bug was found and fixed doing this: `AnimatedNumber` used the rAF
frame timestamp against a `performance.now()` captured in the effect. The frame
timestamp can predate it, `t` went negative, the ease cubic returned values
past 1, and each overshoot seeded the next animation -- counters diverged to
about -1e69. Progress is clamped to [0, 1].

## Session 4: deployment, submission, critique pass

Everything below was verified by running it, not by reading it.

1. **Deployed to Vercel.** Project created through the REST API with
   `rootDirectory: apps/web` (the CLI has no flag for it). `vercel build` cannot run on
   Windows: it creates symlinks under `.vercel/output` and the OS refuses without Developer
   Mode, so the first deploy used `vercel deploy --prod` (remote build). The project was
   renamed from `kreaton` (that `.vercel.app` name was taken; Vercel had assigned
   `kreaton-two`) to `kreaton-upi`. A rename does not re-alias, so `kreaton-upi.vercel.app`
   was added as a domain explicitly and `kreaton-two` removed.
2. **CI had failed on every commit from the first one.** `app/layout.tsx` annotates the
   root layout with `LayoutProps<'/'>`, a type Next generates into `.next/types`. Local
   checks passed because `.next` was always lying around; a clean checkout has none.
   `typecheck` is now `next typegen && tsc --noEmit`. Found only because the push was
   watched.
3. **The deploy smoke test needed three fixes**, each findable only by running it. The
   earlier claim in these notes that it was correct before it ever ran was wrong.
   - `vercel curl` takes the full URL as its positional argument; `--deployment <url>` plus
     a path builds a malformed URL and curl rejects it before any request.
   - `vercel deploy` prints a JSON object, not a bare URL. `url=$(vercel deploy ...)`
     captured a multi-line blob that `$GITHUB_OUTPUT` silently dropped. The step now greps
     the first deployment host out and fails if nothing matched.
   - `vercel curl` forwards every flag it does not recognise to the curl binary, and
     `--token` is one of them (`curl: option --token: is unknown`). Auth goes through
     `VERCEL_TOKEN` in the step's environment. Every other step accepts `--token`, which is
     why only this one broke.
   Three CI-built deployments were READY on Vercel while the smoke test was still failing;
   the deploy itself had worked from the moment the secrets landed.
4. **The deploy job skips itself when `VERCEL_TOKEN` is absent.** A preflight job publishes
   whether the secret is set (secrets cannot be tested in a job-level `if:` directly). This
   keeps the org's copy green: it holds none of the secrets and was never meant to deploy.
   Verified in both directions, a real deploy on `junekashif/Kreaton` and a skip on the org
   copy.
5. **Submitted.** The organisers had pre-created an empty private `Cognitia-IEM/KREATON`;
   the full history was pushed into it (identical SHAs, single human author, no trailers).
   The About box needs admin, which the team does not have; left for the organisers.
6. **The risk chart's axis topped out at 98.2%**, and the calibration's last isotonic step
   sits just under 98%, so the blocked scams sat 4px below the plot's top border and read as
   having fallen off. Measured: nothing was actually clipped; all 1,200 marks were inside.
   `LOGIT_MAX` 4 to 6 (99.75%), a labelled 99% tick, ribbon 300 to 400px. The same 97.8%
   mark now sits 53px inside. `/policy`'s surface chart shares the axis through
   `riskPosition` and picked up the same ticks.
7. **A dual-agent design critique** (design review and mechanical detector, run isolated)
   scored the console 26/40 on Nielsen's heuristics and found four things worth fixing
   before a deadline. All four shipped in `94b146c`:
   - The assessment panel is sticky beside the feed above 1100px; below that a row selection
     scrolls it into view. Clicking the bottom row of a forty-row feed used to update a panel
     414px above the viewport, and 505px away on a phone.
   - `APP-FAN-1 5 distinct payers` read as `APP-FAN-15`. The reason code takes the data face
     and a separator. The "Scam risk / p(fraud)" heading was also holding its column open at
     141px for a sixty-pixel value; the sub-label sits on its own line now. A `min-width` on
     the reason column that briefly forced the table sideways was caught in the screenshot
     round and removed: the numbers said 260px, the render showed a scrollbar.
   - `--fg-2` measured 4.08:1 on sixty-odd elements; it is L 0.59 now, 4.84:1 on the ground
     and 4.62:1 on the raised plane the key sits on (0.58 would fail the second). `--fg-3`
     went from 2.34:1 to 3.32:1.
   - On a phone, panel headers wrap and a selected feed card paints as one surface.
   Declined on purpose: drawing approvals as a density strip (a rework that changes what
   the ribbon means); the detector's "cyan neon" hits (that is the approve teal, chosen
   because green failed colourblind separation); collapsing the type scale.
8. **The manual.** Written for someone who has never seen a fraud system; ten screenshots
   from the live site. Chrome will not embed variable fonts into a PDF; it rasterises them
   and falls back to Segoe UI. Newsreader and Instrument Sans are instanced to static
   weights with fontTools for the print build. The rupee sign still falls to Segoe because
   the Latin subsets lack U+20B9; harmless.
9. **Fresh-clone check.** `git clone`, `npm ci`, typecheck, tests, `next build`, `next dev`
   all clean from an empty folder. Node >= 20.9 is enforced by `engines` and is Next's real
   minimum; the only platform-specific packages are esbuild's per-OS binaries, which npm
   selects automatically.

## Session 5: your own data, and somewhere for it to go

The question that prompted this was direct: can we feed in our own dataset, are the UPI
parameters real, can it take real payments, and can a database hold the
name/credit/debit/amount rows. The honest answers before this session were: only through a
one-off PaySim CLI adapter, the schema is real but every value is synthetic, no, and no.
Three of the four have answers now; real payment rails still do not, and the API is the
integration surface for that rather than a connection to one.

1. **`packages/ingest`, a new zero-dependency package.** Delimited and JSON reading, column
   matching against the twenty-eight fields the engine can use, coercion, and the construction
   of ordered transactions. The same code runs in the browser tab, the route handler and the
   CLI. 31 tests.
   - Delimiter sniffed by *consistency* rather than frequency, so a narration column full of
     commas does not fool it. Quoted fields, embedded newlines, doubled quotes, a BOM.
   - Amounts: Indian and Western grouping, currency symbols, Dr/Cr markers, accounting
     parentheses. The sign is dropped, because direction is a separate field.
   - Timestamps: epoch ms and seconds, ISO, dd/mm, mm/dd, PaySim step hours. Where the order
     is genuinely ambiguous the assumed convention is *stated*, not picked silently.
2. **A bank statement works**, which was the shape actually asked about. Two substitutions
   make it possible and both are reported: with no payer column the whole file is read as one
   account holder, and with no beneficiary number the narration folded to a stable slug
   becomes the identity, so RAMESH TRADERS, Ramesh Traders and UPI/RAMESH TRADERS. are one
   beneficiary. That is what makes the payee-graph signals work on a statement at all. Only
   the amount is genuinely required.
3. **The report is the feature, not the importer.** Almost no real file carries UPI session
   context, and without it the engine is in the suppressed-indicator position from the
   adversarial suite, its weakest. Every route says so beside the number. The report also
   names each field left at its quiet value (marked with a dot in the mapping itself), each
   harmless substitution, rows dropped by reason, unreadable cells by column with examples,
   and structural limits: beneficiaries that never repeat, payers with no history. An
   unlabelled file gets no accuracy figure at all.
4. **`/data` in the console**, two tabs. A file: drop it, confirm the mapping, see the first
   rows as the engine will read them, read the report, replay. A single payment: compose one
   by hand from four presets, with the equivalent POST /api/v1/authorize body beside it. The
   console page carries a banner whenever an imported file is loaded, because every counter on
   it is then measured on that file.
5. **One real honesty bug found doing this.** The assessment panel printed "labelled
   legitimate" for every payment without a fraud label. A file with no ground-truth column
   never said a payment was legitimate; it said nothing. It reads "no ground truth" now.
6. **A core change, with tests.** `PayerProfile.observedBalancePaise` is used by the
   drain-ratio signal in preference to the spend-based estimate when an institution actually
   has a balance, which an imported statement does. Previously the balance column would have
   been read and silently discarded, since `updatePayerProfile` recomputes the proxy from
   spend on every payment. The evidence line now says which of the two it used. 5 tests; the
   16-check gate still passes unchanged.
7. **`POST /api/v1/authorize/batch` and `POST /api/v1/import`.** The batch endpoint is not a
   loop around the single one: the structuring window, hold linkage and every baseline carry
   forward, so a run scored together gives different and correct answers. A bad row is
   reported in place rather than losing the run. `/api/v1/import` replays on a *scratch*
   engine, because a file sent to be understood must not leave its payers and ledger entries
   in the live one.
8. **`npm run ingest`**, unbounded, with the full model-card metric set (ROC AUC, PR AUC, KS,
   Brier, ECE, recall at fixed FPR ceilings) when the file has labels. The root script needed
   a trailing `--` to forward arguments through `npm -w`; the same latent bug affects
   `npm run adversarial -- --policy=...` and was fixed for `ingest` only.
9. **Persistence, both halves.** In the browser, the imported dataset and the replay position
   go to IndexedDB, so a refresh no longer costs the file you just mapped. Verified with a
   hard reload. Engine state is *not* stored: replay is deterministic, so restoring the file
   and the cursor reproduces it for a fraction of the complexity.
10. **`packages/sheets`**, the durable half. A `PersistenceSink` writing the sealed ledger, the
    payments and the holds to a Google Sheet. Service-account JWT signed with `node:crypto`,
    no `googleapis` dependency. Batched, because Google allows about 60 writes a minute and a
    replay at 60/s would exhaust that in one second. Retryable failures (429, 5xx) keep their
    rows; a 403, which is what a sheet not shared with the service account returns, lets them
    go rather than accumulating behind an error that will never clear. Queue bounded at 20,000
    rows. Profiles are deliberately *not* written: hot state, reconstructible, and copying them
    would spend the whole quota. 22 tests against a fake transport, so no credentials or
    network are needed.
11. **Then it was run against the real Sheets API, and the fake had hidden a bug.**
    `LedgerEntry` is a discriminated union: on an ASSESSMENT the payment, the decision and
    the probability sit under `entry.assessment`, not at the top level, and the sink read
    them off the entry directly. The unit tests passed because their fixture invented a flat
    shape the engine never emits, so the real ledger tab came out with four empty columns on
    every decision. Fixtures are built from the real union now, with a test per entry kind.
    A fake transport verifies the transport; it cannot verify an assumption about the data.
    Verified live after the fix: token exchange, tab creation, batched appends, and a
    read-back confirming a 64-digit hash survives byte for byte, which is exactly what the
    RAW write mode exists for. Credentials are in `apps/web/.env.local`, gitignored.
12. **Docs.** `docs/DATA_INPUT.md` and `docs/PERSISTENCE.md`, plus README sections. Runnable
    samples in `data/samples/`.

Verified by running: 107 tests pass (was 46), typecheck and lint clean, `next build` clean, the
16-check gate passes, both new endpoints exercised with curl, and the console import driven end
to end in a browser - a bank statement's 89,000 rupee scam payment blocked at 90.4% with the
drain ratio computed from the file's own balance column.

## Resume checklist

```bash
cd C:/D/Kreaton
npm install
npm run typecheck && npm run lint && npm test     # 107 tests
npm run gate                     # 16 checks, ~1 min
npm run dev                      # console on :3000, /data for your own files
npm run artefacts                # seed, evaluate, adversarial, model card (~6 min)
npm run adversarial -- --policy=liability_first
npm run ingest -- --file=data/samples/upi-log-sample.csv
npm run seed -- --export && python analysis/crosscheck.py
python analysis/sensitivity.py
```

## Open items

None block the submission.

- **The Sheets sink is live on production.** Set through `vercel env add` for the production
  environment (`KREATON_SHEETS_ID`, `KREATON_SERVICE_ACCOUNT_JSON` as sensitive,
  `KREATON_SHEETS_FLUSH_MS`), then redeployed. A decision made against
  kreaton-upi.vercel.app was read back out of the spreadsheet. Two failures on the way, both
  recorded in `docs/PERSISTENCE.md`: `vercel deploy` must run from the repository root
  because the project's Root Directory is `apps/web`; and the timer-based flush never
  completed on a frozen instance until the routes called `waitUntil`.
- **The service account key currently in use should be rotated.** It was handled outside a
  secret store during setup. In IAM & Admin, Service Accounts, open the Kreaton sheet-writer
  account, Keys: delete that key, create a new one, and update `.env.local` and the Vercel
  environment. Nothing else about the setup changes. The account's address and the
  spreadsheet id are deliberately not recorded in this repository, which is public.
- **The spreadsheet is clean.** The probe rows from every verification run were removed with
  `SheetsClient.truncate`, and an append afterwards was confirmed to land directly under the
  header. All three tabs hold their header row and nothing else.
- **Real payment rails are not connected and nothing moves money.** `POST /api/v1/authorize`
  is the integration surface a PSP would call in the authorisation path; there is no
  connection to NPCI, a switch, or any provider sandbox.
- **PaySim** has not been run on real data (no Kaggle download in this environment). The
  adapter's code path was smoke-tested with a throwaway file in PaySim's format, which was
  deleted. Results on the real file should go in `data/paysim-metrics.json` and be mentioned in
  `MODELING.md` section 2.4 once available.
- **The org repo's About box** (description, website link) needs admin, which the team does
  not have. Ask the organisers to set it or grant admin. The README carries the same
  information, so nothing is lost.
- **The deployment builds inside `apps/web`, not at the root.** `apps/web/vercel.json` sets
  `buildCommand: npm run build`, and that script now compiles the workspace packages before
  `next build`. The first deploy of session 5 failed because it did not: `@kreaton/ingest` and
  `@kreaton/sheets` resolve through `dist/`, which a fresh checkout does not have, and
  `transpilePackages` does not rescue a package whose entry file is missing. CI had passed
  because the root `build` script compiles the packages first. Reproduced locally by deleting
  every `dist/` and running the build from `apps/web`; fixed the same way.
- **`deploy.yml` builds on Node 22 and Vercel runs Node 24.** Working fine; the first place
  to look if a deploy ever behaves oddly.
- **Session state is per tab and lost on full reload** (in-memory engine). Client-side
  navigation keeps it; `/trace/[txnId]` steps the slice forward on a direct visit so a deep
  link to a slice payment still works. Injected payments do not survive a reload.
- The console's playback clock is payments-per-second, not real time; the slice spans ~4 h.
- From the critique, not done and not required: a density strip for the approve band on the
  ribbon; keyboard focus on feed rows (`tr.selectable:focus-visible` is dead CSS with no
  `tabindex`); a confirmation on Rewind; a persistent marker for the most recent
  interception so a demo does not depend on the feed filter.
- Possible follow-ups, none required: durable `Store` (Neon), an ROC/PR chart on `/model`,
  a Playwright smoke test in CI against `next start`.

## Working with the three copies

`C:/D/Kreaton` is the working copy. `C:/Users/kakas/OneDrive/Desktop/Github Uploads/Kreaton`
is a clone with three remotes: `origin` (junekashif/Kreaton), `cognitia` (the org repo), and
`worktree` (the working copy). To ship a change:

```bash
cd C:/D/Kreaton && git commit ...
cd "C:/Users/kakas/OneDrive/Desktop/Github Uploads/Kreaton"
git fetch worktree && git merge --ff-only worktree/main
git push origin main      # this is the deploy
git push cognitia main    # this is the submission
```

Pushing to `cognitia` asks for an explicit confirmation in the assistant's auto mode. That
is deliberate for a submission repo.
