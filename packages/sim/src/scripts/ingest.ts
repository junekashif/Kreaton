/**
 * Replay a dataset of your own through the engine, from the command line.
 *
 * The console importer is bounded by what one browser tab can hold. This is
 * not: it streams a file of any size, replays every payment in order, and
 * where the file carries ground truth it reports the same metrics the model
 * card does — ROC AUC, PR AUC, calibration error, recall at fixed
 * false-positive ceilings — so a result on your data is directly comparable
 * with the committed figures.
 *
 *   npm run ingest -- --file=data/mine.csv
 *   npm run ingest -- --file=data/mine.csv --preset=paysim --limit=200000
 *   npm run ingest -- --file=data/mine.csv --out=data/mine-metrics.json
 *   npm run ingest -- --file=data/mine.csv --map=payerId=account,amountPaise=txn_value
 *
 * What it will not do is present a figure the file cannot support. An
 * unlabelled dataset gets a decision breakdown and no accuracy; a dataset with
 * no session context gets its detection rate printed next to a statement of
 * why that number is a floor.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_POLICY,
  Interceptor,
  MemoryStore,
  RecoveryModel,
  formatINR,
  refreshPayeeWindow,
} from '@kreaton/core';
import type { ModelSpec } from '@kreaton/core';
import {
  PRESETS,
  buildDataset,
  detectMapping,
  readSource,
  withDefaults,
} from '@kreaton/ingest';
import type { Mapping } from '@kreaton/ingest';
import { fullMetrics } from '../metrics.js';
import type { ScoredCase } from '../metrics.js';
import { ARTEFACTS, REPO_ROOT, writeJson } from '../paths.js';

interface Args {
  file: string;
  preset?: string;
  limit?: number;
  out?: string;
  overrides: Record<string, string>;
}

function parseArgs(): Args | null {
  const out: Args = { file: '', overrides: {} };
  for (const arg of process.argv.slice(2)) {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    const value = rest.join('=');
    if (key === 'file') out.file = value;
    else if (key === 'preset') out.preset = value;
    else if (key === 'limit') out.limit = Number(value);
    else if (key === 'out') out.out = value;
    else if (key === 'map') {
      // --map=fieldPath=column,fieldPath=column
      for (const pair of value.split(',')) {
        const [path, column] = pair.split('=');
        if (path && column) out.overrides[path] = column;
      }
    }
  }
  return out.file ? out : null;
}

const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;

function main(): void {
  const args = parseArgs();
  if (!args) {
    console.log('\n  Replay your own dataset through the interception engine.\n');
    console.log('  npm run ingest -- --file=<path>  [--preset=<id>] [--limit=<n>] [--out=<path>]');
    console.log('                                   [--map=payerId=<column>,amountPaise=<column>]\n');
    console.log(`  Presets: ${PRESETS.map((p) => p.id).join(', ')}\n`);
    process.exitCode = 1;
    return;
  }

  const path = resolve(REPO_ROOT, args.file);
  if (!existsSync(path)) {
    console.error(`\n  No file at ${path}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Reading ${args.file}`);
  const text = readFileSync(path, 'utf8');
  const source = readSource(text, args.limit !== undefined ? { limit: args.limit } : {});
  if (source.header.length === 0) {
    console.error('  No column headings were found. The first row should name the columns.\n');
    process.exitCode = 1;
    return;
  }

  const detected = detectMapping(source.header);
  let mapping: Mapping = detected.mapping;
  if (args.preset) {
    const preset = PRESETS.find((p) => p.id === args.preset);
    if (!preset) {
      console.error(`  Unknown preset "${args.preset}". Known: ${PRESETS.map((p) => p.id).join(', ')}\n`);
      process.exitCode = 1;
      return;
    }
    const byName = new Map(source.header.map((h) => [h.toLowerCase().replace(/[^a-z0-9]/g, ''), h]));
    mapping = {};
    for (const [fieldPath, col] of Object.entries(preset.columns)) {
      const actual = byName.get(col.toLowerCase().replace(/[^a-z0-9]/g, ''));
      if (!actual) continue;
      const unit = preset.units?.[fieldPath];
      const mode = preset.modes?.[fieldPath];
      mapping[fieldPath] = {
        ...withDefaults(fieldPath, { column: actual }),
        ...(unit ? { unit } : {}),
        ...(mode ? { mode } : {}),
      };
    }
  }
  for (const [fieldPath, column] of Object.entries(args.overrides)) {
    mapping[fieldPath] = withDefaults(fieldPath, { column });
  }

  console.log(`  ${source.header.length} columns, read as ${source.format}${source.delimiter ? ` with "${source.delimiter}"` : ''}`);
  if (detected.preset) console.log(`  Recognised as ${detected.preset.label}`);
  console.log('\n  Mapping');
  for (const [fieldPath, binding] of Object.entries(mapping)) {
    const extra = [binding.unit, binding.mode].filter((x) => x && x !== 'auto').join(', ');
    console.log(`    ${fieldPath.padEnd(36)} <- ${binding.column}${extra ? `  (${extra})` : ''}`);
  }

  const dataset = buildDataset(source.rows, mapping, {});
  const r = dataset.report;

  console.log('\n  The file');
  console.log(`    ${r.rowsKept.toLocaleString('en-IN')} payments from ${r.rowsRead.toLocaleString('en-IN')} rows`);
  for (const [reason, count] of Object.entries(r.skipped)) {
    console.log(`      ${String(count).padStart(8)} ${reason}`);
  }
  console.log(`    ${r.distinctPayers.toLocaleString('en-IN')} payers, median ${r.medianPaymentsPerPayer} payments each`);
  console.log(`    ${r.distinctPayees.toLocaleString('en-IN')} beneficiaries, ${pct(r.repeatBeneficiaryRate, 1)} of payments to one seen before`);
  console.log(`    ${new Date(r.windowFromMs).toISOString().slice(0, 10)} to ${new Date(r.windowToMs).toISOString().slice(0, 10)}`);
  if (r.labelled) console.log(`    ${r.fraudCount.toLocaleString('en-IN')} marked fraud (${pct(r.fraudCount / Math.max(1, r.rowsKept), 3)})`);

  if (r.assumptions.length > 0) {
    console.log('\n  Assumed');
    for (const a of r.assumptions) console.log(`    ${a}`);
  }

  if (r.columnIssues.length > 0) {
    console.log('\n  Unreadable cells');
    for (const i of r.columnIssues) {
      console.log(`    ${String(i.count).padStart(8)} in ${i.column} (${i.label}), such as ${i.samples.map((s) => `"${s}"`).join(', ')}`);
    }
  }

  if (r.warnings.length > 0) {
    console.log('\n  What this file cannot show');
    for (const w of r.warnings) {
      console.log(`    - ${wrap(w, 92, '      ')}`);
    }
  }

  if (dataset.transactions.length === 0) {
    console.log('\n  Nothing to replay.\n');
    process.exitCode = 1;
    return;
  }

  // --- replay -----------------------------------------------------------
  const model = JSON.parse(readFileSync(ARTEFACTS.model, 'utf8')) as ModelSpec;
  const store = new MemoryStore();
  const engine = new Interceptor({
    model,
    policy: DEFAULT_POLICY,
    store,
    recovery: new RecoveryModel({
      params: model.recovery,
      freezeLatencyMinutes: DEFAULT_POLICY.freezeLatencyMinutes,
      seed: 'ingest',
    }),
  });

  const attributes = new Map(dataset.payees.map((p) => [p.payeeId, p]));
  const confirmedFrom = new Map(dataset.intel.map((e) => [e.payeeId, e.ts]));
  const counts: Record<string, number> = { APPROVE: 0, STEP_UP: 0, BLOCK: 0 };
  const cases: ScoredCase[] = [];
  let caught = 0;
  let falsePositives = 0;
  let valueCaught = 0;
  let valueFraud = 0;

  console.log(`\n  Replaying ${dataset.transactions.length.toLocaleString('en-IN')} payments`);
  const startedAt = Date.now();

  for (const txn of dataset.transactions) {
    const attrs = attributes.get(txn.payeeId);
    const existing = store.ensurePayee(txn.payeeId, txn.payeeVpa, txn.ts);
    const confirmedAt = confirmedFrom.get(txn.payeeId);
    store.putPayee({
      ...refreshPayeeWindow(existing, txn.ts),
      firstSeenMs: attrs?.firstSeenMs ?? existing.firstSeenMs,
      outboundVelocityRatio: attrs?.outboundVelocityRatio ?? existing.outboundVelocityRatio,
      // Released at the timestamp it was asserted, never applied retroactively.
      confirmedMule: existing.confirmedMule || (confirmedAt !== undefined && confirmedAt <= txn.ts),
    });

    const observed = dataset.balanceBefore[txn.txnId];
    if (observed !== undefined && observed > 0) {
      const payer = store.ensurePayer(txn.payerId, txn.ts);
      store.putPayer({ ...payer, observedBalancePaise: observed, balanceProxyPaise: observed });
    }

    const { assessment } = engine.authorize(txn);
    counts[assessment.decision] = (counts[assessment.decision] ?? 0) + 1;
    cases.push({ score: assessment.calibratedP, isFraud: txn.label.isFraud, amountPaise: txn.amountPaise });

    const intervened = assessment.decision !== 'APPROVE';
    if (txn.label.isFraud) {
      valueFraud += txn.amountPaise;
      if (intervened) {
        caught += 1;
        valueCaught += txn.amountPaise;
      }
    } else if (intervened) {
      falsePositives += 1;
    }
  }

  const elapsed = Date.now() - startedAt;
  const total = dataset.transactions.length;
  console.log(`  Done in ${(elapsed / 1000).toFixed(1)}s (${Math.round(total / Math.max(elapsed / 1000, 0.001)).toLocaleString('en-IN')} payments/s)`);

  console.log('\n  What the engine decided');
  for (const [action, n] of Object.entries(counts)) {
    console.log(`    ${action.padEnd(10)} ${String(n).padStart(10)}  ${pct(n / total, 2)}`);
  }

  let metrics: ReturnType<typeof fullMetrics> | null = null;
  if (r.labelled && r.fraudCount > 0) {
    const genuine = total - r.fraudCount;
    console.log('\n  Against the file’s own labels');
    console.log(`    Detection by count   ${pct(caught / r.fraudCount)} (${caught} of ${r.fraudCount})`);
    console.log(`    Detection by value   ${pct(valueFraud > 0 ? valueCaught / valueFraud : 0)} (${formatINR(valueCaught)} of ${formatINR(valueFraud)})`);
    console.log(`    Genuine intervened   ${pct(genuine > 0 ? falsePositives / genuine : 0)} (${falsePositives} of ${genuine})`);

    metrics = fullMetrics(cases);
    console.log('\n  Scorer quality');
    console.log(`    ROC AUC              ${metrics.discrimination.rocAuc.toFixed(4)}`);
    console.log(`    PR AUC               ${metrics.discrimination.prAuc.toFixed(4)}`);
    console.log(`    KS                   ${metrics.discrimination.ks.toFixed(4)}`);
    console.log(`    Brier                ${metrics.calibration.brier.toFixed(6)}`);
    console.log(`    Calibration error    ${metrics.calibration.ece.toFixed(4)}`);
    console.log('\n    Recall at a false-positive ceiling');
    for (const op of metrics.operatingPoints) {
      console.log(
        `      ${pct(op.maxFpr, 1).padStart(6)}  recall ${pct(op.point.recall).padStart(8)}  ` +
          `value ${pct(op.valueRecall).padStart(8)}  precision ${pct(op.point.precision).padStart(8)}`,
      );
    }

    const quietSession = r.quiet.filter((q) => q.path.startsWith('context.')).length;
    if (quietSession >= 5) {
      console.log(
        '\n    These figures were measured with no session context in the file, which is the\n' +
          '    suppressed-indicator position in the adversarial report. Treat them as a floor.',
      );
    }
  } else {
    console.log('\n  No usable ground truth, so accuracy cannot be reported.');
  }

  if (args.out) {
    const outPath = resolve(REPO_ROOT, args.out);
    writeJson(outPath, {
      generatedAt: new Date().toISOString(),
      source: args.file,
      modelVersion: model.version,
      mapping,
      report: r,
      counts,
      labelled: r.labelled,
      ...(r.labelled && r.fraudCount > 0
        ? {
            detectionByCount: caught / r.fraudCount,
            detectionByValue: valueFraud > 0 ? valueCaught / valueFraud : 0,
            falsePositiveRate: total - r.fraudCount > 0 ? falsePositives / (total - r.fraudCount) : 0,
            metrics,
          }
        : {}),
    });
    console.log(`\n  Written to ${args.out}`);
  }

  console.log('');
}

/** Wrap a long sentence for the terminal, indenting continuation lines. */
function wrap(text: string, width: number, indent: string): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}

main();
