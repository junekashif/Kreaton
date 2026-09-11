import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POLICY_PRESETS, RecoveryModel, formatINRCompact, presetById } from '@kreaton/core';
import { DEFAULT_CONFIG, generateCorpus } from '../generator.js';
import { buildFeatureStream, chronologicalSplit, collectContexts, replay } from '../replay.js';
import { fitModel } from '../fit.js';
import { ablationLabels, runAdversarialSuite } from '../adversary.js';
import { DEFENCE_LABELS, calibrateDefences, measureFpr } from '../defences.js';
import { ARTEFACTS, DATA_DIR, writeJson } from '../paths.js';
import type { ModelSpec } from '@kreaton/core';
import type { DefenceId } from '../defences.js';
import type { GeneratorConfig } from '../generator.js';

/**
 * Adversarial evaluation.
 *
 * Warms profiles across the whole corpus, calibrates three competing defences to
 * interrupt the same share of legitimate payments, then launches every attack
 * against all three.
 */

function parseArgs(): { quick: boolean; episodes?: number; policy: string } {
  const out: { quick: boolean; episodes?: number; policy: string } = { quick: false, policy: 'balanced' };
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'quick') out.quick = true;
    if (key === 'episodes') out.episodes = Number(value);
    if (key === 'policy' && value) out.policy = value;
  }
  return out;
}

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + w).length > width) {
      lines.push(line.trimEnd());
      line = '';
    }
    line += `${w} `;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.map((l) => indent + l).join('\n');
}

const DEFENCE_IDS: readonly DefenceId[] = ['rule_baseline', 'fixed_threshold', 'expected_cost'];
const DAY = 86_400_000;

async function main(): Promise<void> {
  const args = parseArgs();
  const config: GeneratorConfig = {
    ...DEFAULT_CONFIG,
    ...(args.quick ? { payers: 1_200, days: 21 } : {}),
  };

  console.log('='.repeat(78));
  console.log('ADVERSARIAL COUNTERMEASURE EVALUATION');
  console.log('='.repeat(78));

  const corpus = generateCorpus(config);
  const rows = buildFeatureStream(corpus);
  const { train, test, splitAtMs } = chronologicalSplit(rows, 0.6);

  const expected = `1.0.0-${String(config.seed)}-${config.payers}x${config.days}`;
  let model: ModelSpec;
  try {
    const committed = JSON.parse(readFileSync(ARTEFACTS.model, 'utf8')) as ModelSpec;
    model =
      committed.version === expected ? committed : fitModel({ version: expected, train, test }).model;
  } catch {
    model = fitModel({ version: expected, train, test }).model;
  }

  // The whole suite runs under one named stance. The friction budget the
  // other defences are matched to follows from it, so running the suite under
  // a second preset shows how much adversarial robustness the policy interface
  // buys and what it costs in interruptions.
  const preset = presetById(args.policy);
  if (!preset) {
    throw new Error(`Unknown policy preset ${args.policy}. Known: ${POLICY_PRESETS.map((p) => p.id).join(', ')}`);
  }
  const policy = preset.policy;
  console.log(`
Policy     ${preset.label} (${preset.id})`);
  const outputPath = preset.id === 'balanced' ? ARTEFACTS.adversarial : resolve(DATA_DIR, `adversarial-${preset.id}.json`);
  const recovery = new RecoveryModel({
    params: model.recovery,
    freezeLatencyMinutes: policy.freezeLatencyMinutes,
    seed: 'adversarial',
  });
  const recoveryAtLag = recovery.recoverableAt(policy.reportLagMinutes);

  // Warm the population across the whole corpus, then attack immediately after
  // the last observed payment. fromMs beyond the corpus means nothing is scored.
  const corpusEndMs = corpus.transactions[corpus.transactions.length - 1]!.ts;
  const warm = replay({ corpus, model, policy, fromMs: corpusEndMs + 1, warmUp: true });
  const attackAtMs = corpusEndMs + 30 * 60_000;

  // Recent inbound activity per collection account, compressed into the day
  // before the attack so fan-in reflects an account in active use.
  const liveFanIn = new Map<
    string,
    Array<{ payerId: string; amountPaise: number; offsetMs: number }>
  >();
  for (const t of corpus.transactions) {
    if (!t.label.isFraud) continue;
    const list = liveFanIn.get(t.payeeId) ?? [];
    list.push({ payerId: t.payerId, amountPaise: t.amountPaise, offsetMs: corpusEndMs - t.ts });
    liveFanIn.set(t.payeeId, list);
  }
  for (const [id, list] of liveFanIn) {
    list.sort((a, b) => a.offsetMs - b.offsetMs);
    liveFanIn.set(
      id,
      list.slice(0, 12).map((e, i) => ({ ...e, offsetMs: (i + 1) * (DAY / 16) })),
    );
  }

  // A sample of genuine legitimate traffic from the held-out window, used to put
  // every defence on the same friction budget. Contexts are captured during a
  // chronological pass, so each payment is judged against the profile as it
  // stood at that moment rather than against an end-of-corpus profile that
  // already contains activity which had not happened yet.
  const legitSamples = collectContexts(corpus, {
    fromMs: splitAtMs,
    keep: (t) => !t.label.isFraud,
  });

  const { params, referenceFpr } = calibrateDefences(legitSamples, model, policy, recoveryAtLag);
  const defenceFpr = Object.fromEntries(
    DEFENCE_IDS.map((id) => [
      id,
      measureFpr(id, legitSamples, model, policy, recoveryAtLag, params),
    ]),
  ) as Record<DefenceId, number>;

  const episodesPerAttack = args.episodes ?? (args.quick ? 150 : 400);

  console.log(`\nModel      ${model.version}`);
  console.log(`Victims    ${corpus.payers.length.toLocaleString()} with warmed profiles`);
  console.log(`Episodes   ${episodesPerAttack} per attack, per defence`);
  console.log(
    '\nAn episode counts as caught when any payment in it is held or blocked. Stopping one\n' +
      'payment breaks a scam episode, so the payment is the wrong unit and would double count.',
  );

  console.log('\n' + '-'.repeat(78));
  console.log('DEFENCES UNDER TEST, CALIBRATED TO A COMMON FRICTION BUDGET');
  console.log('-'.repeat(78));
  console.log(
    `  Reference friction: the expected-cost system interrupts ${pct(referenceFpr, 3)} of\n` +
      `  legitimate payments on a sample of ${legitSamples.length.toLocaleString()}. The others are tuned to match.\n`,
  );
  for (const id of DEFENCE_IDS) {
    console.log(`  ${DEFENCE_LABELS[id].label}`);
    console.log(wrap(DEFENCE_LABELS[id].description, 72, '    '));
    console.log(`    Measured false-positive rate: ${pct(defenceFpr[id], 3)}`);
    if (id === 'rule_baseline') {
      console.log(
        `    Fitted thresholds: intervene above ${formatINRCompact(params.ruleHighAmount)}, or above ` +
          `${formatINRCompact(params.ruleNewPayeeAmount)} for a beneficiary under ${params.ruleNoveltyHours}h old.`,
      );
    }
    if (id === 'fixed_threshold') {
      console.log(`    Fitted threshold: intervene at p >= ${params.fixedThreshold.toFixed(6)}.`);
    }
    console.log('');
  }

  const results = runAdversarialSuite({
    store: warm.store,
    payers: corpus.payers,
    payees: corpus.payees,
    model,
    policy,
    recoveryAtReportLag: recoveryAtLag,
    atMs: attackAtMs,
    liveFanIn,
    defenceParams: params,
    defenceFpr,
    episodesPerAttack,
  });

  for (const r of results) {
    console.log('\n' + '-'.repeat(78));
    console.log(r.attack.label.toUpperCase());
    console.log('-'.repeat(78));
    console.log(wrap(r.attack.description, 74, '  '));
    console.log('\n  Why it works:');
    console.log(wrap(r.attack.premise, 72, '    '));
    console.log('');
    console.log('    defence                              caught    interval        leaked');
    for (const id of DEFENCE_IDS) {
      const d = r.byDefence[id];
      console.log(
        `    ${DEFENCE_LABELS[id].label.padEnd(36)} ${pct(d.rate).padStart(6)}  ` +
          `[${pct(d.interval.lo).padStart(5)} to ${pct(d.interval.hi).padStart(6)}]  ` +
          `${formatINRCompact(d.valueLeakedPaise).padStart(10)}`,
      );
    }
    const gain =
      (r.byDefence.expected_cost.rate - r.byDefence.rule_baseline.rate) * 100;
    const disjoint =
      r.byDefence.expected_cost.interval.lo > r.byDefence.rule_baseline.interval.hi;
    console.log(
      `\n    Against the deployed-rule baseline: ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} percentage points` +
        `  ${disjoint ? '(intervals disjoint)' : '(intervals overlap)'}`,
    );
    console.log(
      `    Countermeasure ablation (${ablationLabels(r.attack.ablation).join(', ')}): ` +
        `${r.improvementPp >= 0 ? '+' : ''}${r.improvementPp.toFixed(1)} pp`,
    );
  }

  // ---- Summary ------------------------------------------------------------
  const totals = Object.fromEntries(
    DEFENCE_IDS.map((id) => [
      id,
      {
        caught: results.reduce((s, r) => s + r.byDefence[id].caught, 0),
        episodes: results.reduce((s, r) => s + r.episodes, 0),
        leaked: results.reduce((s, r) => s + r.byDefence[id].valueLeakedPaise, 0),
      },
    ]),
  ) as Record<DefenceId, { caught: number; episodes: number; leaked: number }>;

  console.log('\n' + '='.repeat(78));
  console.log('SUMMARY, ALL ATTACKS COMBINED');
  console.log('='.repeat(78));
  console.log('  defence                                caught    episodes    value leaked');
  for (const id of DEFENCE_IDS) {
    const t = totals[id];
    console.log(
      `  ${DEFENCE_LABELS[id].label.padEnd(36)} ${pct(t.caught / t.episodes).padStart(6)}   ` +
        `${String(t.episodes).padStart(8)}   ${formatINRCompact(t.leaked).padStart(13)}`,
    );
  }

  const rule = totals.rule_baseline;
  const full = totals.expected_cost;
  const fixed = totals.fixed_threshold;
  console.log(
    `\n  At matched friction, the full system catches ${pct(full.caught / full.episodes)} of attacked episodes\n` +
      `  against ${pct(rule.caught / rule.episodes)} for a tuned rule, and leaks ` +
      `${formatINRCompact(full.leaked)} against ${formatINRCompact(rule.leaked)}.`,
  );
  console.log(
    `\n  Of the gap over the rule, the fused score accounts for most of it (${pct(fixed.caught / fixed.episodes)}\n` +
      `  at a single threshold) and the expected-cost boundary supplies the remainder.`,
  );

  const weakest = [...results].sort(
    (a, b) => a.byDefence.expected_cost.rate - b.byDefence.expected_cost.rate,
  )[0];
  if (weakest) {
    console.log(
      `\n  Weakest position: ${weakest.attack.label} at ${pct(weakest.byDefence.expected_cost.rate)} caught.`,
    );
    console.log('  Reported because an adversarial evaluation that only lists wins is marketing.');
  }

  writeJson(outputPath, {
    generatedAt: new Date().toISOString(),
    modelVersion: model.version,
    episodesPerAttack,
    policyPreset: { id: preset.id, label: preset.label },
    policy,
    defences: Object.fromEntries(
      DEFENCE_IDS.map((id) => [
        id,
        { ...DEFENCE_LABELS[id], falsePositiveRate: defenceFpr[id] },
      ]),
    ),
    calibration: { referenceFpr, params, legitimateSampleSize: legitSamples.length },
    results: results.map((r) => ({
      id: r.attack.id,
      label: r.attack.label,
      description: r.attack.description,
      premise: r.attack.premise,
      countermeasure: r.attack.countermeasure,
      removedForComparison: ablationLabels(r.attack.ablation),
      episodes: r.episodes,
      byDefence: r.byDefence,
      ablation: {
        caughtHardened: r.caughtHardened,
        caughtAblated: r.caughtAblated,
        hardenedRate: r.hardenedRate,
        ablatedRate: r.ablatedRate,
        improvementPp: r.improvementPp,
        significant: r.significant,
        valueLeakedHardenedPaise: r.valueLeakedHardenedPaise,
        valueLeakedAblatedPaise: r.valueLeakedAblatedPaise,
      },
    })),
    summary: totals,
  });

  console.log(`\nWrote ${ARTEFACTS.adversarial}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
