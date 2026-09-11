import { readFileSync } from 'node:fs';
import {
  DEFAULT_POLICY,
  RecoveryModel,
  formatINR,
  formatINRCompact,
} from '@kreaton/core';
import { DEFAULT_CONFIG, generateCorpus } from '../generator.js';
import { buildFeatureStream, chronologicalSplit, defaultHoldResponder, replay } from '../replay.js';
import { fitModel } from '../fit.js';
import { fullMetrics, precisionAtPrevalence } from '../metrics.js';
import { buildPortfolioReport } from '../report.js';
import { ARTEFACTS, writeJson } from '../paths.js';
import type { ModelSpec } from '@kreaton/core';
import type { GeneratorConfig } from '../generator.js';

/**
 * End-to-end evaluation.
 *
 * Regenerates the corpus, fits on the training window, then replays the
 * held-out window through the complete interceptor rather than through the
 * scorer alone. That distinction matters: the numbers reported here are
 * produced by the same code path that would run in production, including the
 * cost engine, the hold protocol, the protocol overrides and the audit trail,
 * so nothing is measured on a simplified stand-in for the real system.
 */

function parseArgs(): { quick: boolean; payers?: number; days?: number } {
  const out: { quick: boolean; payers?: number; days?: number } = { quick: false };
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'quick') out.quick = true;
    if (key === 'payers') out.payers = Number(value);
    if (key === 'days') out.days = Number(value);
  }
  return out;
}

const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;

function bar(value: number, max: number, width = 22): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return '#'.repeat(filled).padEnd(width, '.');
}

async function main(): Promise<void> {
  const args = parseArgs();
  const config: GeneratorConfig = {
    ...DEFAULT_CONFIG,
    ...(args.quick ? { payers: 1_200, days: 21 } : {}),
    ...(args.payers ? { payers: args.payers } : {}),
    ...(args.days ? { days: args.days } : {}),
  };

  console.log('='.repeat(78));
  console.log('APP FRAUD INTERCEPTOR - EVALUATION');
  console.log('='.repeat(78));

  const corpus = generateCorpus(config);
  const rows = buildFeatureStream(corpus);
  const { train, test, splitAtMs } = chronologicalSplit(rows, 0.6);

  // Reuse the committed model when it matches this corpus, otherwise refit.
  let model: ModelSpec;
  try {
    const committed = JSON.parse(readFileSync(ARTEFACTS.model, 'utf8')) as ModelSpec;
    const expected = `1.0.0-${String(config.seed)}-${config.payers}x${config.days}`;
    model = committed.version === expected ? committed : fitModel({ version: expected, train, test }).model;
  } catch {
    model = fitModel({
      version: `1.0.0-${String(config.seed)}-${config.payers}x${config.days}`,
      train,
      test,
    }).model;
  }

  console.log(`\nCorpus     ${corpus.meta.totalTransactions.toLocaleString()} payments over ${config.days} days`);
  console.log(`           ${corpus.meta.fraudulentTransactions} fraudulent (${pct(corpus.meta.observedFraudRate, 3)})`);
  console.log(`           ${formatINRCompact(corpus.meta.totalValuePaise)} screened`);
  console.log(`Model      ${model.version}`);
  console.log(`Split      train to ${new Date(splitAtMs).toISOString().slice(0, 10)}, test after`);

  // ---- Scoring quality on the held-out window -----------------------------
  const policy = DEFAULT_POLICY;
  const recovery = new RecoveryModel({
    params: model.recovery,
    freezeLatencyMinutes: policy.freezeLatencyMinutes,
    seed: 'evaluation',
  });
  const recoveryAtLag = recovery.recoverableAt(policy.reportLagMinutes);

  console.log('\n' + '-'.repeat(78));
  console.log('RECOVERABILITY');
  console.log('-'.repeat(78));
  const q = recovery.cashOutQuantiles;
  console.log(`  Time to cash-out         p10 ${q.p10.toFixed(0)} min   p50 ${q.p50.toFixed(0)} min   p90 ${q.p90.toFixed(0)} min`);
  console.log(`  Expected onward hops     ${recovery.estimate(60).expectedHops.toFixed(2)}`);
  console.log(`  Freeze orders per case   ${recovery.expectedFreezeOrders.toFixed(2)}`);
  const gap = recovery.estimatorGap();
  console.log(`  Estimator disagreement   ${pct(gap.maxAbsDiff)} at ${gap.atMinutes} min (lognormal vs closed-form Markov)`);
  console.log('\n  Recoverable fraction if a freeze order is raised at:');
  for (const m of [0, 15, 60, 240, 1440]) {
    const r = recovery.recoverableAt(m);
    console.log(`    ${String(m).padStart(4)} min  ${bar(r, 1)} ${pct(r, 1).padStart(7)}`);
  }
  console.log(`\n  Policy report lag is ${policy.reportLagMinutes} min, giving ${pct(recoveryAtLag, 1)} recoverable.`);

  // ---- Full replay through the interceptor --------------------------------
  console.log('\n' + '-'.repeat(78));
  console.log('DECISIONS (full interceptor replay on the held-out window)');
  console.log('-'.repeat(78));

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
  const m = fullMetrics(scored);

  console.log(`  Scored ${result.outcomes.length.toLocaleString()} payments`);
  console.log(`  ROC AUC ${m.discrimination.rocAuc.toFixed(4)}   PR AUC ${m.discrimination.prAuc.toFixed(4)}   KS ${m.discrimination.ks.toFixed(4)}`);
  console.log(`  Brier ${m.calibration.brier.toFixed(6)}   calibration error ${m.calibration.ece.toFixed(6)}   worst bin ${m.calibration.mce.toFixed(4)}`);

  console.log('\n  Recall at a capped false-positive rate');
  console.log('    FPR cap    recall   value recall   precision   precision at 0.05% prevalence');
  for (const op of m.operatingPoints) {
    const adjusted = precisionAtPrevalence(op.point, 0.0005);
    console.log(
      `    ${pct(op.maxFpr, 2).padStart(7)}   ${pct(op.point.recall, 1).padStart(6)}   ` +
        `${pct(op.valueRecall, 1).padStart(12)}   ${pct(op.point.precision, 1).padStart(9)}   ${pct(adjusted, 1).padStart(28)}`,
    );
  }
  console.log(
    '\n  The final column restates precision at a prevalence closer to a live rail than the corpus carries.',
  );
  console.log('  Ranking metrics are unaffected by prevalence; precision is not, and is reported both ways.');

  // ---- Portfolio ----------------------------------------------------------
  const report = buildPortfolioReport({
    outcomes: result.outcomes,
    holds: result.store.allHolds(),
    policy,
    recoveryAtReportLag: recoveryAtLag,
  });

  console.log('\n' + '-'.repeat(78));
  console.log('PORTFOLIO IMPACT');
  console.log('-'.repeat(78));
  console.log(`  Screened                 ${report.screened.count.toLocaleString()} payments, ${formatINRCompact(report.screened.valuePaise)}`);
  for (const a of ['APPROVE', 'STEP_UP', 'BLOCK'] as const) {
    const b = report.byAction[a];
    console.log(
      `    ${a.padEnd(9)}              ${String(b.count).padStart(7)}  ${pct(b.count / Math.max(report.screened.count, 1), 2).padStart(7)}  ${formatINRCompact(b.valuePaise).padStart(12)}`,
    );
  }
  console.log(`\n  Detection rate           ${pct(report.outcomes.detectionRate, 1)} by count, ${pct(report.outcomes.valueDetectionRate, 1)} by value`);
  console.log(`  False-positive rate      ${pct(report.outcomes.falsePositiveRate, 3)} of legitimate payments`);
  console.log(`  Operational load         ${report.outcomes.frictionPerThousand.toFixed(2)} interventions per 1,000 screened`);
  console.log(`  Precision                ${pct(report.outcomes.precision, 1)}`);

  console.log('\n  Holds');
  console.log(`    Opened                 ${report.holds.opened}`);
  for (const [state, count] of Object.entries(report.holds.byState)) {
    if (count > 0) console.log(`      ${state.padEnd(20)} ${count}`);
  }
  console.log(`    Value released         ${formatINRCompact(report.holds.releasedValuePaise)}`);
  console.log(`    Value stopped          ${formatINRCompact(report.holds.stoppedValuePaise)}`);

  console.log('\n  Financial impact, in real currency');
  const f = report.financial;
  console.log(`    Liability with no interception   ${formatINR(f.unmitigatedLiabilityPaise).padStart(16)}`);
  console.log(`    Compensation liability avoided   ${formatINR(f.liabilityAvoidedPaise).padStart(16)}`);
  console.log(`    Residual liability               ${formatINR(f.residualLiabilityPaise).padStart(16)}`);
  console.log(`    Friction cost of intervening     ${formatINR(f.frictionCostPaise).padStart(16)}`);
  console.log(`    Net benefit                      ${formatINR(f.netBenefitPaise).padStart(16)}`);

  console.log('\n  Detection by typology (the honest breakdown)');
  console.log('    typology                       cases   by count   by value');
  for (const t of report.byTypology) {
    console.log(
      `    ${String(t.typology).padEnd(30)} ${String(t.count).padStart(5)}   ${pct(t.detectionRate, 1).padStart(8)}   ${pct(t.valueDetectionRate, 1).padStart(8)}`,
    );
  }

  console.log('\n  Latency of the authorisation path');
  console.log(
    `    mean ${report.latency.meanMs.toFixed(3)} ms   p95 ${report.latency.p95Ms.toFixed(3)} ms   p99 ${report.latency.p99Ms.toFixed(3)} ms   max ${report.latency.maxMs.toFixed(3)} ms`,
  );
  console.log(
    '    Twelve signals, fusion, a recoverability lookup, three cost evaluations and a sealed audit record.',
  );

  // How often beneficiary intelligence was actually available at decision time.
  const withIntel = result.outcomes.filter((o) =>
    o.assessment.signals.some((s) => s.id === 'MULE_PROXIMITY' && s.raw > 0),
  ).length;
  const fraudWithIntel = result.outcomes.filter(
    (o) => o.isFraud && o.assessment.signals.some((s) => s.id === 'MULE_PROXIMITY' && s.raw > 0),
  ).length;
  const fraudTotal = result.outcomes.filter((o) => o.isFraud).length;
  console.log(
    `
  Beneficiary intelligence was available for ${withIntel} of ${result.outcomes.length} payments ` +
      `(${fraudWithIntel} of ${fraudTotal} fraudulent).`,
  );
  console.log(
    '    Low by construction: a collection account is only known after an earlier victim reported and an',
  );
  console.log(
    '    investigation linked it, so the signal contributes only where a network is reused after discovery.',
  );

  // ---- Audit trail integrity ---------------------------------------------
  const verification = result.store.ledger.verify();
  console.log('\n' + '-'.repeat(78));
  console.log('AUDIT TRAIL');
  console.log('-'.repeat(78));
  console.log(`  Records sealed           ${result.store.ledger.length.toLocaleString()}`);
  console.log(`  Chain verification       ${verification.valid ? 'intact' : `BROKEN at sequence ${verification.brokenAt}`}`);
  console.log(`  Head digest              ${result.store.ledger.head}`);

  writeJson(ARTEFACTS.portfolio, report);
  writeJson(ARTEFACTS.metrics, {
    generatedAt: new Date().toISOString(),
    config,
    modelVersion: model.version,
    corpus: corpus.meta,
    split: { splitAtMs, trainRows: train.length, testRows: test.length },
    heldOut: m,
    recovery: {
      atReportLag: recoveryAtLag,
      quantiles: q,
      estimatorGap: gap,
      curve: recovery.estimate(policy.reportLagMinutes).curve,
    },
    portfolio: report,
    auditChainValid: verification.valid,
  });

  console.log(`\nWrote ${ARTEFACTS.metrics}`);
  console.log(`Wrote ${ARTEFACTS.portfolio}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
