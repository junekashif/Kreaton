import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_POLICY, formatINRCompact, refreshPayeeWindow, SIGNAL_ORDER, SIGNAL_SPECS } from '@kreaton/core';
import { DEFAULT_CONFIG, generateCorpus } from '../generator.js';
import { buildFeatureStream, chronologicalSplit, replay } from '../replay.js';
import { applyCalibration, fitModel, scoreRow } from '../fit.js';
import { ARTEFACTS, DATA_DIR, humanBytes, writeJson } from '../paths.js';
import type { PayeeProfile, PayerProfile, Transaction } from '@kreaton/core';
import type { GeneratorConfig } from '../generator.js';

/**
 * Generate the corpus, fit the model, and write the committed artefacts.
 *
 * The corpus itself is not committed. It is several hundred megabytes and it is
 * fully determined by the seed and the configuration in generator.ts, so
 * committing it would add weight to the repository without adding information.
 * Anyone can reproduce it byte for byte by running this script. What is
 * committed is the fitted model, the metrics, and a small slice for the
 * interface to replay.
 */

function parseArgs(): Partial<GeneratorConfig> & { quick?: boolean; export?: boolean } {
  const out: Partial<GeneratorConfig> & { quick?: boolean; export?: boolean } = {};
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'quick') out.quick = true;
    else if (key === 'export') out.export = true;
    else if (key === 'payers') out.payers = Number(value);
    else if (key === 'days') out.days = Number(value);
    else if (key === 'seed') out.seed = value;
    else if (key === 'fraudRate') out.fraudRate = Number(value);
  }
  return out;
}

function pct(x: number, digits = 2): string {
  return `${(x * 100).toFixed(digits)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const config: GeneratorConfig = {
    ...DEFAULT_CONFIG,
    // A reduced corpus for fast iteration and for the continuous integration
    // gate, where a full run would dominate the job time.
    ...(args.quick ? { payers: 1_200, days: 21 } : {}),
    ...args,
  };
  delete (config as { quick?: boolean }).quick;
  delete (config as { export?: boolean }).export;

  console.log('Generating corpus');
  console.log(`  payers ${config.payers}  days ${config.days}  seed ${String(config.seed)}`);
  let t = Date.now();
  const corpus = generateCorpus(config);
  console.log(`  ${corpus.meta.totalTransactions.toLocaleString()} transactions in ${Date.now() - t} ms`);
  console.log(
    `  ${corpus.meta.fraudulentTransactions.toLocaleString()} fraudulent (${pct(corpus.meta.observedFraudRate, 3)})`,
  );
  console.log(
    `  ${formatINRCompact(corpus.meta.totalValuePaise)} screened, ${formatINRCompact(corpus.meta.fraudValuePaise)} fraudulent (${pct(corpus.meta.fraudValuePaise / corpus.meta.totalValuePaise)} of value)`,
  );
  console.log(`  ${corpus.intel.length} mule intelligence events on a delayed timeline`);

  console.log('\nExtracting features chronologically');
  t = Date.now();
  const rows = buildFeatureStream(corpus);
  console.log(`  ${rows.length.toLocaleString()} rows in ${Date.now() - t} ms`);

  const { train, test, splitAtMs } = chronologicalSplit(rows, 0.6);
  console.log(
    `  train ${train.length.toLocaleString()} (${train.filter((r) => r.isFraud).length} fraud)` +
      `  test ${test.length.toLocaleString()} (${test.filter((r) => r.isFraud).length} fraud)`,
  );
  console.log(`  split at ${new Date(splitAtMs).toISOString()}`);

  console.log('\nFitting model');
  t = Date.now();
  const { model, diagnostics } = fitModel({
    version: `1.0.0-${String(config.seed)}-${config.payers}x${config.days}`,
    train,
    test,
  });
  console.log(`  fitted in ${Date.now() - t} ms`);
  console.log(
    `  IRLS ${diagnostics.irlsConverged ? 'converged' : 'hit the iteration cap'} after ${diagnostics.irlsIterations} iterations`,
  );

  console.log('\n  Intra-group correlation (evidence discount)');
  for (const [group, rho] of Object.entries(diagnostics.groupCorrelation)) {
    console.log(`    ${group.padEnd(16)} rho ${rho.toFixed(3)}`);
  }

  console.log('\n  Signal weights, evidence range, and standalone discrimination');
  for (const id of SIGNAL_ORDER) {
    const woe = model.signals.find((s) => s.id === id)!;
    const top = Math.max(...woe.llrByBin);
    const bottom = Math.min(...woe.llrByBin);
    const auc = diagnostics.marginalAuc[id];
    const flag = auc > 0.98 ? '  <-- separates almost perfectly, check the generator' : '';
    console.log(
      `    ${SIGNAL_SPECS[id].label.padEnd(38)} w ${woe.weight.toFixed(3).padStart(6)}` +
        `   llr ${bottom.toFixed(2).padStart(6)} to ${top.toFixed(2).padStart(5)}` +
        `   auc ${auc.toFixed(3)}${flag}`,
    );
  }

  const suspicious = SIGNAL_ORDER.filter((id) => diagnostics.marginalAuc[id] > 0.98);
  if (suspicious.length > 0) {
    console.log(
      `\n  WARNING: ${suspicious.length} signal(s) separate the held-out classes almost perfectly on their own.`,
    );
    console.log(
      '  That is a property of the generated corpus, not of the method. Fix the generator before trusting any headline metric.',
    );
  }

  console.log('\n  Held-out performance');
  console.log(`    ROC AUC              ${model.metrics.rocAuc.toFixed(4)}`);
  console.log(`    PR AUC               ${model.metrics.prAuc.toFixed(4)}`);
  console.log(`    KS                   ${model.metrics.ks.toFixed(4)}`);
  console.log(`    Brier                ${model.metrics.brier.toFixed(6)}`);
  console.log(`    Calibration error    ${model.metrics.ece.toFixed(6)}`);
  console.log(`    Recall at 1% FPR     ${pct(model.metrics.recallAt1PctFpr)}`);

  // A small, self-contained slice for the interface to replay without needing
  // the full corpus. Taken from the end of the test window so it reflects
  // decisions made against warmed-up profiles.
  const sliceSize = 4_000;
  const sliceStart = Math.max(0, corpus.transactions.length - sliceSize);
  const demoSlice = {
    generatedAt: new Date().toISOString(),
    config,
    note:
      'A tail slice of the generated corpus, committed so the interface can replay a realistic stream without regenerating the full corpus. Labels are included because the console reports measured detection rates.',
    transactions: corpus.transactions.slice(sliceStart),
    payees: corpus.payees.filter((p) =>
      new Set(corpus.transactions.slice(sliceStart).map((x) => x.payeeId)).has(p.payeeId),
    ),
    intel: corpus.intel,
  };

  // A shorter window for the browser, carrying the same payments so the console
  // and the evaluation cannot disagree about what happened.
  //
  // The browser runs the engine itself, so it also needs the state the engine
  // would have had at the start of the window. Without it every payer in the
  // slice would be scored as a first-time customer with no baseline, which is
  // not the situation the evaluation measured and not the situation a deployed
  // system is in. So the corpus is replayed up to the window start, and the
  // resulting profiles for every payer and beneficiary in the window are
  // snapshotted and shipped alongside the payments.
  const webCount = 1_200;
  const webTxns = corpus.transactions.slice(-webCount);
  const webStartMs = webTxns[0]!.ts;
  const webPayerIds = new Set(webTxns.map((t) => t.payerId));
  const webPayeeIds = new Set(webTxns.map((t) => t.payeeId));

  console.log('\nWarming profiles to the start of the browser window');
  t = Date.now();
  const warm = replay({
    corpus: { ...corpus, transactions: corpus.transactions.slice(0, -webCount) },
    model,
    policy: DEFAULT_POLICY,
    fromMs: Number.POSITIVE_INFINITY,
    warmUp: true,
  });
  const round = (x: number, places: number): number => Number(x.toFixed(places));
  const DAY_MS = 86_400_000;

  // What the browser receives is a snapshot cut down to what the signals can
  // read for the payments in the window, so that no decision differs from the
  // full replay while the payload stays small:
  //
  //   - knownPayees keeps only the beneficiaries this payer pays inside the
  //     window, because the novelty signal looks up the current payee alone;
  //   - hourHistogram is dropped and rebuilt from the integer counts on load;
  //   - recent payments carry only the two fields the windowed signals read;
  //   - beneficiary fan-in windows are refreshed to the window start, which
  //     drops exactly the entries scoring would have dropped anyway.
  const payeesByPayer = new Map<string, Set<string>>();
  for (const txn of webTxns) {
    const set = payeesByPayer.get(txn.payerId) ?? new Set<string>();
    set.add(txn.payeeId);
    payeesByPayer.set(txn.payerId, set);
  }
  const warmPayers: Array<Omit<PayerProfile, 'hourHistogram'>> = [];
  for (const id of webPayerIds) {
    const p = warm.store.getPayer(id);
    if (!p) continue;
    const keep = payeesByPayer.get(id) ?? new Set<string>();
    const knownPayees: Record<string, number> = {};
    for (const [payeeId, ts] of Object.entries(p.knownPayees)) {
      if (keep.has(payeeId)) knownPayees[payeeId] = ts;
    }
    const { hourHistogram: _dropped, ...rest } = p;
    warmPayers.push({
      ...rest,
      knownPayees,
      // Three decimals in log space is a tenth of a percent in amount, far
      // below anything the binning can resolve.
      recentLogAmounts: p.recentLogAmounts.map((x) => round(x, 3)),
      logAmountMedian: round(p.logAmountMedian, 6),
      logAmountMad: round(p.logAmountMad, 6),
      dailyCountMean: round(p.dailyCountMean, 4),
      dailyCountSd: round(p.dailyCountSd, 4),
    });
  }
  const warmPayees: PayeeProfile[] = [];
  for (const id of webPayeeIds) {
    const p = warm.store.getPayee(id);
    if (p) warmPayees.push(refreshPayeeWindow(p, webStartMs));
  }
  const warmRecent: Array<Pick<Transaction, 'payerId' | 'ts' | 'amountPaise'>> = [];
  for (const id of webPayerIds) {
    for (const txn of warm.store.recentPayerTxns(id, webStartMs - DAY_MS)) {
      warmRecent.push({ payerId: txn.payerId, ts: txn.ts, amountPaise: txn.amountPaise });
    }
  }
  console.log(
    `  ${warmPayers.length} payer and ${warmPayees.length} beneficiary profiles, ` +
      `${warmRecent.length} prior-day payments, in ${Date.now() - t} ms`,
  );

  const webSlice = {
    generatedAt: new Date().toISOString(),
    modelVersion: model.version,
    note: demoSlice.note,
    windowFromMs: webStartMs,
    windowToMs: webTxns[webTxns.length - 1]!.ts,
    transactions: webTxns,
    payees: corpus.payees
      .filter((p) => webPayeeIds.has(p.payeeId))
      .map((p) => ({
        payeeId: p.payeeId,
        name: p.name,
        kind: p.kind,
        outboundVelocityRatio: p.outboundVelocityRatio,
        firstSeenMs: p.firstSeenMs,
        chainId: p.chainId ?? null,
        layer: p.layer ?? null,
      })),
    intel: corpus.intel.filter((e) => webPayeeIds.has(e.payeeId)),
    warm: { payers: warmPayers, payees: warmPayees, recentTxns: warmRecent },
  };

  writeJson(ARTEFACTS.model, model);
  writeJson(ARTEFACTS.webModel, model);
  writeJson(ARTEFACTS.webSlice, webSlice, false);
  writeJson(ARTEFACTS.demoSlice, demoSlice, false);
  writeJson(ARTEFACTS.fit, {
    generatedAt: new Date().toISOString(),
    config,
    modelVersion: model.version,
    corpus: corpus.meta,
    split: { splitAtMs, trainRows: train.length, testRows: test.length },
    diagnostics,
    metrics: model.metrics,
  });

  // Feature rows and the engine's own scores, for the Python cross-check in
  // analysis/. Not committed: reproducible from the seed, and large.
  if (args.export) {
    const dir = resolve(DATA_DIR, 'export');
    mkdirSync(dir, { recursive: true });
    const header = [
      'split',
      'isFraud',
      'amountPaise',
      'rawLogOdds',
      'calibratedP',
      ...SIGNAL_ORDER.map((id) => `bin_${id}`),
    ];
    const lines = [header.join(',')];
    for (const [split, set] of [
      ['train', train],
      ['test', test],
    ] as const) {
      for (const row of set) {
        const raw = scoreRow(row, model);
        lines.push(
          [
            split,
            row.isFraud ? 1 : 0,
            row.amountPaise,
            raw.toFixed(8),
            applyCalibration(raw, model.calibration).toExponential(6),
            ...row.bins,
          ].join(','),
        );
      }
    }
    const path = resolve(dir, 'features.csv');
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
    console.log(`\nExported ${lines.length - 1} feature rows to ${path} (${humanBytes(statSync(path).size)})`);
  }

  console.log('\nWrote');
  console.log(`  ${ARTEFACTS.model}`);
  console.log(`  ${ARTEFACTS.fit}`);
  console.log(`  ${ARTEFACTS.demoSlice}  (${demoSlice.transactions.length} transactions)`);
  console.log(
    `  ${ARTEFACTS.webSlice}  (${webSlice.transactions.length} transactions, ${humanBytes(statSync(ARTEFACTS.webSlice).size)}, served to the browser)`,
  );
  console.log(`  ${ARTEFACTS.webModel}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
