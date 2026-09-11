import { readFileSync } from 'node:fs';
import {
  AuditLedger,
  DEFAULT_POLICY,
  RecoveryModel,
  SIGNAL_ORDER,
  hashObject,
} from '@kreaton/core';
import { DEFAULT_CONFIG, generateCorpus } from '../generator.js';
import { buildFeatureStream, chronologicalSplit, defaultHoldResponder, replay } from '../replay.js';
import { fitModel } from '../fit.js';
import { fullMetrics } from '../metrics.js';
import { ARTEFACTS } from '../paths.js';
import type { ModelSpec } from '@kreaton/core';
import type { GeneratorConfig } from '../generator.js';

/**
 * Model quality gate.
 *
 * Runs in continuous integration on a reduced corpus and fails the build when
 * the system stops behaving like a fraud model and starts behaving like an
 * artefact of its own test data. The checks are ordered from the cheapest to
 * the most expensive so a broken build fails fast.
 *
 * The gate is deliberately more interested in what should not be true than in
 * what should. A ROC AUC that is too good is a stronger warning than one that
 * is slightly worse, because on a generated corpus the usual way to reach
 * 1.0000 is a leak, and every leak found during the build presented first as a
 * headline improvement.
 */

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name.padEnd(48)} ${detail}`);
}

function parseArgs(): { full: boolean } {
  return { full: process.argv.includes('--full') };
}

interface GateBands {
  minRocAuc: number;
  maxRocAuc: number;
  minPrAuc: number;
  maxSingleSignalAuc: number;
  maxEce: number;
  minRecallAt1PctFpr: number;
  maxFalsePositiveRate: number;
  minDetectionRate: number;
  maxP99LatencyMs: number;
}

/**
 * Floors and ceilings the fitted model must respect.
 *
 * The quick corpus holds only a few dozen held-out fraud cases, so its
 * rate-based floors carry wide sampling error and are set loosely; the ceilings
 * that guard against leakage are identical at both scales because a leak shows
 * up regardless of sample size.
 */
const QUICK_GATE: GateBands = {
  minRocAuc: 0.96,
  maxRocAuc: 0.9995,
  minPrAuc: 0.5,
  maxSingleSignalAuc: 0.98,
  maxEce: 0.02,
  minRecallAt1PctFpr: 0.6,
  // The default policy is deliberately conservative once the calibration is
  // honest; these bound the operating point rather than describe a target.
  maxFalsePositiveRate: 0.02,
  minDetectionRate: 0.6,
  maxP99LatencyMs: 2,
};

const FULL_GATE: GateBands = {
  ...QUICK_GATE,
  minRocAuc: 0.98,
  minPrAuc: 0.75,
  minRecallAt1PctFpr: 0.85,
  minDetectionRate: 0.75,
};

async function main(): Promise<void> {
  const { full } = parseArgs();
  const GATE = full ? FULL_GATE : QUICK_GATE;
  const config: GeneratorConfig = {
    ...DEFAULT_CONFIG,
    ...(full ? {} : { payers: 1_200, days: 21 }),
  };

  console.log('Model quality gate');
  console.log(`  corpus ${config.payers} payers x ${config.days} days, seed ${String(config.seed)}\n`);

  // 1. The committed model must parse and hash to something stable.
  try {
    const committed = JSON.parse(readFileSync(ARTEFACTS.model, 'utf8')) as ModelSpec;
    check(
      'committed model.json parses',
      committed.signals.length === SIGNAL_ORDER.length,
      `${committed.version}, ${committed.signals.length} signals, digest ${hashObject(committed).slice(0, 12)}`,
    );
  } catch (error) {
    check('committed model.json parses', false, String(error));
  }

  // 2. Regenerate and refit. Determinism is a property worth asserting: two
  //    runs from the same seed must produce the same corpus, or nothing below
  //    is reproducible.
  const corpus = generateCorpus(config);
  const again = generateCorpus(config);
  check(
    'corpus generation is deterministic',
    corpus.meta.totalTransactions === again.meta.totalTransactions &&
      corpus.transactions[corpus.transactions.length - 1]?.txnId ===
        again.transactions[again.transactions.length - 1]?.txnId,
    `${corpus.meta.totalTransactions.toLocaleString()} transactions, ${corpus.meta.fraudulentTransactions} fraudulent`,
  );

  const rows = buildFeatureStream(corpus);
  const { train, test, splitAtMs } = chronologicalSplit(rows, 0.6);
  const { model, diagnostics } = fitModel({
    version: `gate-${String(config.seed)}-${config.payers}x${config.days}`,
    train,
    test,
  });

  check('IRLS converged', diagnostics.irlsConverged, `${diagnostics.irlsIterations} iterations`);

  // 3. No single signal may separate the held-out classes on its own. This is
  //    the guard that found three of the four generator artefacts.
  const worst = SIGNAL_ORDER.map((id) => ({ id, auc: diagnostics.marginalAuc[id] })).sort(
    (a, b) => b.auc - a.auc,
  )[0]!;
  check(
    'no single signal separates the classes alone',
    worst.auc <= GATE.maxSingleSignalAuc,
    `strongest ${worst.id} at ${worst.auc.toFixed(4)} (ceiling ${GATE.maxSingleSignalAuc})`,
  );

  // 4. Held-out discrimination inside a plausible band.
  const m = model.metrics;
  check(
    'held-out ROC AUC in plausible band',
    m.rocAuc >= GATE.minRocAuc && m.rocAuc <= GATE.maxRocAuc,
    `${m.rocAuc.toFixed(4)} (band ${GATE.minRocAuc} to ${GATE.maxRocAuc})`,
  );
  check('held-out PR AUC above floor', m.prAuc >= GATE.minPrAuc, `${m.prAuc.toFixed(4)}`);
  check('calibration error below ceiling', m.ece <= GATE.maxEce, `ECE ${m.ece.toFixed(4)}`);
  check(
    'recall at 1% FPR above floor',
    m.recallAt1PctFpr >= GATE.minRecallAt1PctFpr,
    `${(m.recallAt1PctFpr * 100).toFixed(1)}%`,
  );

  // 5. Full interceptor replay: the decision layer, protocol and audit trail.
  const policy = DEFAULT_POLICY;
  const result = replay({
    corpus,
    model,
    policy,
    fromMs: splitAtMs,
    warmUp: true,
    holdResponder: defaultHoldResponder(policy),
  });
  const scored = result.outcomes.map((o) => ({
    score: o.assessment.calibratedP,
    isFraud: o.isFraud,
    amountPaise: o.amountPaise,
  }));
  const fm = fullMetrics(scored);
  check(
    'replay discrimination matches the fitter',
    Math.abs(fm.discrimination.rocAuc - m.rocAuc) < 0.02,
    `replay ${fm.discrimination.rocAuc.toFixed(4)} vs fit ${m.rocAuc.toFixed(4)}`,
  );

  let legit = 0;
  let legitIntervened = 0;
  let fraud = 0;
  let fraudIntervened = 0;
  const latencies: number[] = [];
  for (const o of result.outcomes) {
    const intervened = o.assessment.decision !== 'APPROVE';
    if (o.isFraud) {
      fraud++;
      if (intervened) fraudIntervened++;
    } else {
      legit++;
      if (intervened) legitIntervened++;
    }
    latencies.push(o.assessment.latencyMs);
  }
  const fpr = legit > 0 ? legitIntervened / legit : 0;
  const det = fraud > 0 ? fraudIntervened / fraud : 0;
  check(
    'false-positive rate under default policy',
    fpr <= GATE.maxFalsePositiveRate,
    `${(fpr * 100).toFixed(2)}% (ceiling ${GATE.maxFalsePositiveRate * 100}%)`,
  );
  check(
    'detection rate under default policy',
    det >= GATE.minDetectionRate,
    `${(det * 100).toFixed(1)}% (floor ${GATE.minDetectionRate * 100}%)`,
  );

  latencies.sort((a, b) => a - b);
  const p99 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.99))] ?? 0;
  check('p99 authorisation latency', p99 <= GATE.maxP99LatencyMs, `${p99.toFixed(3)} ms`);

  // 6. Every explanation must reconstruct its score. The engine throws on
  //    violation, so reaching here proves it, but the audit trail also has to
  //    survive a round trip through its export format with the chain intact.
  const verification = result.store.ledger.verify();
  check(
    'audit chain verifies',
    verification.valid,
    `${verification.checked.toLocaleString()} records, head ${result.store.ledger.head.slice(0, 12)}`,
  );
  const roundTrip = AuditLedger.fromJsonl(result.store.ledger.toJsonl()).verify();
  check('audit chain survives export round trip', roundTrip.valid, `${roundTrip.checked} records`);

  // 7. Tampering must be detected. Alter one sealed record and confirm the
  //    verifier points at it.
  const tampered = AuditLedger.fromJsonl(result.store.ledger.toJsonl());
  const victim = tampered.all()[Math.floor(tampered.length / 2)]!;
  if (victim.entry.kind === 'ASSESSMENT') {
    const a = victim.entry.assessment as { decision: string };
    a.decision = a.decision === 'APPROVE' ? 'BLOCK' : 'APPROVE';
  } else {
    (victim as { ts: number }).ts += 1;
  }
  const detected = tampered.verify();
  check(
    'tampering is detected at the altered record',
    !detected.valid && detected.brokenAt === victim.seq,
    `broke at seq ${detected.brokenAt} (altered ${victim.seq})`,
  );

  // 8. Recoverability is monotone in time and bounded.
  const recovery = new RecoveryModel({
    params: model.recovery,
    freezeLatencyMinutes: policy.freezeLatencyMinutes,
  });
  const curve = recovery.estimate(policy.reportLagMinutes).curve;
  const first = curve[0]!;
  const last = curve[curve.length - 1]!;
  const monotone = curve.every(
    (pt, i) => i === 0 || pt.recoverable <= curve[i - 1]!.recoverable + 1e-9,
  );
  check(
    'recoverability curve is monotone non-increasing',
    monotone && first.recoverable <= 1 && last.recoverable >= 0,
    `${(first.recoverable * 100).toFixed(1)}% at 0 min to ${(last.recoverable * 100).toFixed(2)}% at ${last.minutes} min`,
  );

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.error(`\nGate failed on: ${failed.map((c) => c.name).join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
