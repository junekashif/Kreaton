import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_POLICY, RecoveryModel, SIGNAL_ORDER, SIGNAL_SPECS, formatINRCompact } from '@kreaton/core';
import type { ModelSpec } from '@kreaton/core';
import { applyCalibration, fitModel, scoreRow } from '../fit.js';
import { fullMetrics } from '../metrics.js';
import { ARTEFACTS, DATA_DIR, writeJson } from '../paths.js';
import { PAYSIM_DIR, findPaySimFile, loadPaySim, paySimToCorpus } from '../paysim.js';
import { buildFeatureStream, chronologicalSplit, defaultHoldResponder, replay } from '../replay.js';
import { buildPortfolioReport } from '../report.js';

/**
 * External cross-validation on PaySim.
 *
 * Two questions, answered separately because they are different claims:
 *
 *   1. Transfer. Score PaySim with the committed model, fitted on the
 *      synthetic corpus and never shown a PaySim row. This measures whether
 *      the signals that PaySim can populate carry across to data with a
 *      different generating process.
 *
 *   2. Method. Refit the same pipeline on PaySim's own chronological training
 *      window and evaluate on what follows. This measures whether the method
 *      works on external data when allowed to learn its weights there.
 *
 * Neither is a claim about UPI. PaySim has no session context and almost no
 * repeat originators, so most of the behavioural and every contextual signal
 * sit at their quiet values; what remains is beneficiary novelty, account
 * age, fan-in, inbound velocity, drain ratio and amount. The output says so.
 */

function parseArgs(): { limit?: number; legitRate: number } {
  const out: { limit?: number; legitRate: number } = { legitRate: 0.15 };
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'limit') out.limit = Number(value);
    if (key === 'legitRate') out.legitRate = Number(value);
  }
  return out;
}

const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;

async function main(): Promise<void> {
  const args = parseArgs();
  const file = findPaySimFile();

  console.log('PaySim external cross-validation');
  if (!file) {
    console.log(`\n  No PaySim CSV found under ${PAYSIM_DIR}.`);
    console.log('  Download the dataset from Kaggle ("PaySim1", ealaxi/paysim1), place the CSV in that');
    console.log('  directory, and run this script again. Nothing else in the build depends on it.');
    return;
  }

  console.log(`  reading ${file}`);
  const rows = await loadPaySim(file, { limit: args.limit, legitimateSampleRate: args.legitRate });
  const corpus = paySimToCorpus(rows);
  console.log(
    `  ${corpus.meta.totalTransactions.toLocaleString()} transfer and cash-out rows kept ` +
      `(${corpus.meta.fraudulentTransactions.toLocaleString()} fraudulent, ${pct(corpus.meta.observedFraudRate)}), ` +
      `legitimate rows thinned to ${pct(args.legitRate, 0)}`,
  );
  console.log(`  ${corpus.meta.config.payers.toLocaleString()} originators, ${corpus.payees.length.toLocaleString()} beneficiaries, ${corpus.meta.config.days} days`);

  const featureRows = buildFeatureStream(corpus);
  const { train, test, splitAtMs } = chronologicalSplit(featureRows, 0.6);

  // 1. Transfer: the committed model, untouched.
  const committed = JSON.parse(readFileSync(ARTEFACTS.model, 'utf8')) as ModelSpec;
  const transferCases = test.map((row) => ({
    score: applyCalibration(scoreRow(row, committed), committed.calibration),
    isFraud: row.isFraud,
    amountPaise: row.amountPaise,
  }));
  const transfer = fullMetrics(transferCases);

  console.log('\n' + '-'.repeat(78));
  console.log('TRANSFER: committed model, fitted on the synthetic corpus, scored on PaySim');
  console.log('-'.repeat(78));
  console.log(`  ROC AUC ${transfer.discrimination.rocAuc.toFixed(4)}   PR AUC ${transfer.discrimination.prAuc.toFixed(4)}   KS ${transfer.discrimination.ks.toFixed(4)}`);
  for (const op of transfer.operatingPoints) {
    console.log(`    FPR ≤ ${pct(op.maxFpr, 1).padStart(5)}  recall ${pct(op.point.recall, 1).padStart(6)}  value recall ${pct(op.valueRecall, 1).padStart(6)}`);
  }

  // 2. Method: refit on PaySim's own past.
  const { model, diagnostics } = fitModel({ version: `paysim-${train.length}`, train, test });
  console.log('\n' + '-'.repeat(78));
  console.log('METHOD: same pipeline refitted on the PaySim training window');
  console.log('-'.repeat(78));
  console.log(`  ROC AUC ${model.metrics.rocAuc.toFixed(4)}   PR AUC ${model.metrics.prAuc.toFixed(4)}   KS ${model.metrics.ks.toFixed(4)}   recall at 1% FPR ${pct(model.metrics.recallAt1PctFpr, 1)}`);
  console.log('\n  Signals that carry information on PaySim (standalone held-out AUC)');
  const informative: string[] = [];
  const quiet: string[] = [];
  for (const id of SIGNAL_ORDER) {
    const auc = diagnostics.marginalAuc[id];
    const woe = model.signals.find((s) => s.id === id)!;
    const range = Math.max(...woe.llrByBin) - Math.min(...woe.llrByBin);
    if (range < 1e-6) {
      quiet.push(SIGNAL_SPECS[id].label);
      continue;
    }
    informative.push(id);
    console.log(`    ${SIGNAL_SPECS[id].label.padEnd(40)} w ${woe.weight.toFixed(3).padStart(6)}   auc ${auc.toFixed(3)}`);
  }
  if (quiet.length > 0) {
    console.log(`\n  Constant on PaySim, as expected without session context: ${quiet.join('; ')}.`);
  }

  // Portfolio view under the default policy, with the refitted model.
  const policy = DEFAULT_POLICY;
  const recovery = new RecoveryModel({ params: model.recovery, freezeLatencyMinutes: policy.freezeLatencyMinutes, seed: 'paysim' });
  const recoveryAtLag = recovery.recoverableAt(policy.reportLagMinutes);
  const result = replay({ corpus, model, policy, fromMs: splitAtMs, warmUp: true, holdResponder: defaultHoldResponder(policy) });
  const report = buildPortfolioReport({ outcomes: result.outcomes, holds: result.store.allHolds(), policy, recoveryAtReportLag: recoveryAtLag });
  console.log('\n  Full interceptor replay on the PaySim held-out window');
  console.log(`    detection ${pct(report.outcomes.detectionRate, 1)} by count, ${pct(report.outcomes.valueDetectionRate, 1)} by value; false-positive rate ${pct(report.outcomes.falsePositiveRate, 2)}`);
  console.log(`    liability avoided ${formatINRCompact(report.financial.liabilityAvoidedPaise)} against friction ${formatINRCompact(report.financial.frictionCostPaise)}, reading PaySim amounts as rupees`);
  console.log(`    audit chain ${result.store.ledger.verify().valid ? 'intact' : 'BROKEN'} over ${result.store.ledger.length.toLocaleString()} records`);

  const out = resolve(DATA_DIR, 'paysim-metrics.json');
  writeJson(out, {
    generatedAt: new Date().toISOString(),
    source: file,
    rowsKept: corpus.meta.totalTransactions,
    fraudRows: corpus.meta.fraudulentTransactions,
    legitimateSampleRate: args.legitRate,
    split: { splitAtMs, trainRows: train.length, testRows: test.length },
    transfer: { model: committed.version, heldOut: transfer },
    method: { model: model.version, metrics: model.metrics, marginalAuc: diagnostics.marginalAuc, informativeSignals: informative },
    portfolio: report,
  });
  console.log(`\nWrote ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
