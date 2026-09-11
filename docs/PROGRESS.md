# Build progress and handoff

**Project:** COGNITIA 2026, FINTECH-PS2 — real-time APP fraud interceptor and mule-chain tracer.
**Author:** Team Kreaton.
**Last updated:** 2026-09-11 (session 2).

This file records where the build stands so work can resume without re-deriving
decisions. Delete it before submission.

---

## Status: feature complete, uncommitted until this session's commit

Everything in the original scope is built and verified locally:

| Area | State |
| --- | --- |
| `packages/core` engine | complete, 46 tests pass, typechecks |
| `packages/sim` | complete, plus `gate.ts`, `paysim.ts`, `modelcard.ts`, barrel `index.ts` |
| `apps/web` console | complete: `/`, `/policy`, `/trace`, `/trace/[txnId]`, `/audit`, `/adversarial`, `/portfolio`, `/model`, `POST /api/v1/authorize`, `GET /api/v1/health`. Lint clean, `next build` clean |
| `.github/workflows` | `ci.yml` (typecheck, lint, tests, gate, build) and `deploy.yml` (verify, `vercel build`, `vercel deploy --prebuilt --prod`, smoke test) |
| `analysis/` | `crosscheck.py` (10/10 checks pass against sklearn), `sensitivity.py` (writes `docs/SENSITIVITY.md`) |
| Docs | `README.md`, `LICENSE` (MIT, Team Kreaton), `docs/MODELING.md`, `docs/MODEL_CARD.md` (generated), `docs/SENSITIVITY.md` (generated) |
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

## What changed this session that matters

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

## Resume checklist

```bash
cd C:/D/Kreaton
npm install
npm run typecheck && npm run lint && npm test
npm run gate                     # 16 checks, ~1 min
npm run dev                      # console on :3000
npm run artefacts                # seed, evaluate, adversarial, model card (~6 min)
npm run adversarial -- --policy=liability_first
npm run seed -- --export && python analysis/crosscheck.py
python analysis/sensitivity.py
```

## Open items

- **Vercel project and secrets** are not set up: create the project with Root Directory
  `apps/web`, then add `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` to the repo.
  `deploy.yml` will run on the first push to `main`. The repo's current branch is `master`;
  both are listed in the workflow triggers.
- **PaySim** has not been run on real data (no Kaggle download in this environment). The
  adapter's code path was smoke-tested with a throwaway file in PaySim's format, which was
  deleted. Results on the real file should go in `data/paysim-metrics.json` and be mentioned in
  `MODELING.md` §2.4 once available.
- **Session state is per tab and lost on full reload** (in-memory engine). Client-side
  navigation keeps it; `/trace/[txnId]` steps the slice forward on a direct visit so a deep
  link to a slice payment still works. Injected payments do not survive a reload.
- The console's playback clock is payments-per-second, not real time; the slice spans ~4 h.
- Possible follow-ups, none required: durable `Store` (Neon), an ROC/PR chart on `/model`,
  a Playwright smoke test in CI against `next start`.
