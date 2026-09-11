'use client';

import { useMemo, useState } from 'react';
import {
  POLICY_PRESETS,
  RecoveryModel,
  evaluatePolicy,
  policyDiff,
  solveForConstraints,
  thresholds,
  toPaise,
  toRupees,
  tradeOffFrontier,
} from '@kreaton/core';
import type { ModelSpec, Policy, PolicySample } from '@kreaton/core';
import { FrontierChart } from '../../components/FrontierChart';
import { SurfaceChart } from '../../components/SurfaceChart';
import { formatINR, formatINRCompact, pct, prob, withCommas } from '../../lib/format';
import { useSession } from '../../lib/use-session';

/**
 * Policy studio.
 *
 * The tunable trade-off between false positives and compensation liability,
 * expressed two ways: as prices, for a risk officer, and as rate ceilings,
 * for an operations or conduct team. Every candidate is priced against the
 * scored population of the replay window before it is applied, and applying
 * it writes a POLICY_CHANGED record to the same ledger the decisions go to.
 */

interface Field {
  key: keyof Policy;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  /** Display transform: paise to rupees, fraction to percent. */
  kind: 'rupees' | 'rate' | 'minutes' | 'count';
}

const FIELDS: Field[] = [
  { key: 'liabilityShare', label: 'Liability share borne by the PSP', help: '1.0 is full reimbursement of the victim. 0.5 models a sending and receiving split.', min: 0, max: 1, step: 0.05, kind: 'rate' },
  { key: 'stepUpCatchRate', label: 'Step-up catch rate', help: 'Probability an out-of-band re-confirmation stops a genuine scam payment.', min: 0, max: 1, step: 0.05, kind: 'rate' },
  { key: 'stepUpFrictionPaise', label: 'Friction cost of one hold', help: 'Queue handling, notification, customer time.', min: 0, max: 50_000, step: 500, kind: 'rupees' },
  { key: 'blockFrictionPaise', label: 'Friction cost of one block', help: 'Complaint handling and the support contact that follows.', min: 0, max: 300_000, step: 2_500, kind: 'rupees' },
  { key: 'stepUpAbandonmentRate', label: 'Abandonment after a hold', help: 'Share of legitimate customers who leave after being held.', min: 0, max: 0.3, step: 0.01, kind: 'rate' },
  { key: 'blockAbandonmentRate', label: 'Abandonment after a block', help: 'Share of legitimate customers who leave after being declined.', min: 0, max: 0.6, step: 0.01, kind: 'rate' },
  { key: 'customerLifetimeValuePaise', label: 'Lifetime margin at risk', help: 'What an abandoning customer was worth.', min: 0, max: 5_000_000, step: 50_000, kind: 'rupees' },
  { key: 'reportLagMinutes', label: 'Report lag without intervention', help: 'Minutes from authorisation to a realistic fraud report. Drives how much is still recoverable.', min: 5, max: 1_440, step: 5, kind: 'minutes' },
  { key: 'freezeLatencyMinutes', label: 'Freeze latency', help: 'Minutes between raising a freeze order and the receiving bank acting on it.', min: 0, max: 180, step: 5, kind: 'minutes' },
  { key: 'holdWindowMinutes', label: 'Hold window', help: 'How long a soft hold stays open before it expires and the payment is stopped.', min: 5, max: 240, step: 5, kind: 'minutes' },
  { key: 'attemptBudget', label: 'Re-attempt budget per hold', help: 'Retries to the same beneficiary before escalation to human review.', min: 0, max: 5, step: 1, kind: 'count' },
];

/**
 * One Monte Carlo run per distinct freeze latency, shared across renders and
 * visits. The model is fixed for the life of the page, so the key is the
 * latency alone.
 */
const recoveryCache = new Map<string, RecoveryModel>();
function recoveryFor(model: ModelSpec, freezeLatencyMinutes: number): RecoveryModel {
  const key = `${model.version}:${freezeLatencyMinutes}`;
  let m = recoveryCache.get(key);
  if (!m) {
    m = new RecoveryModel({ params: model.recovery, freezeLatencyMinutes, seed: 'studio' });
    recoveryCache.set(key, m);
  }
  return m;
}

function show(f: Field, v: number): string {
  switch (f.kind) {
    case 'rupees':
      return formatINR(v);
    case 'rate':
      return pct(v, 0);
    case 'minutes':
      return `${v} min`;
    case 'count':
      return String(v);
  }
}

export default function PolicyPage() {
  const { snap, session } = useSession();
  const [edited, setCandidate] = useState<Policy | null>(null);
  const [fprCap, setFprCap] = useState<string>('');
  const [stepCap, setStepCap] = useState<string>('');

  // Until the operator touches a slider, the candidate is the policy in force.
  const candidate = edited ?? (snap.status === 'ready' ? snap.policy : null);

  const samples = useMemo<PolicySample[]>(() => {
    if (snap.status !== 'ready') return [];
    return session.sliceSamples();
    // The slice population is fixed for the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.status]);

  const model = snap.model;

  if (snap.status !== 'ready' || !candidate || !model) {
    return (
      <div className="loading">
        Loading the engine and scoring the replay window for pricing.
        <div className="bar" />
      </div>
    );
  }

  const current = snap.policy;
  const recCand = recoveryFor(model, candidate.freezeLatencyMinutes).recoverableAt(candidate.reportLagMinutes);
  const recCurr = recoveryFor(model, current.freezeLatencyMinutes).recoverableAt(current.reportLagMinutes);

  // Recoverability at the report lag is a policy input, so re-derive it for
  // the candidate rather than reusing the value scored under the old policy.
  const candSamples = samples.map((s) => ({ ...s, recoveryAtReportLag: recCand }));
  const currSamples = samples.map((s) => ({ ...s, recoveryAtReportLag: recCurr }));

  const withCaps: Policy = {
    ...candidate,
    maxFalsePositiveRate: fprCap === '' ? null : Number(fprCap) / 100,
    maxStepUpRate: stepCap === '' ? null : Number(stepCap) / 100,
  };
  const solution = solveForConstraints(candSamples, withCaps);
  const effective = solution.policy;
  const candRates = evaluatePolicy(candSamples, effective);
  const currRates = evaluatePolicy(currSamples, current);
  const frontier = tradeOffFrontier(candSamples, effective);
  const fraudCount = samples.filter((s) => s.isFraud).length;

  const presetMarks = POLICY_PRESETS.map((p) => {
    const r = evaluatePolicy(candSamples, p.policy);
    return { label: p.label, falsePositiveRate: r.falsePositiveRate, detectionRate: r.detectionRate };
  });

  const diff = policyDiff(current, effective);
  const reference = toPaise(25_000);
  const tCand = thresholds(reference, recCand, effective);
  const tCurr = thresholds(reference, recCurr, current);

  const set = (key: keyof Policy, value: number) => setCandidate({ ...candidate, [key]: value });
  const revert = () => setCandidate(null);

  return (
    <>
      <div className="row between mb" style={{ alignItems: 'flex-end' }}>
        <div>
          <h1>Policy studio</h1>
          <p className="lede small">
            Price friction and liability, or set a rate ceiling and let the solver find the price. Every
            candidate is scored against the {withCommas(samples.length)} payments of the replay window (
            {fraudCount} labelled fraud) before it is applied.
          </p>
        </div>
        <div className="btn-row">
          <select
            className="select"
            value={POLICY_PRESETS.find((p) => policyDiff(p.policy, candidate).length === 0)?.id ?? 'custom'}
            onChange={(e) => {
              const p = POLICY_PRESETS.find((x) => x.id === e.target.value);
              if (p) setCandidate(p.policy);
            }}
            aria-label="Start from preset"
          >
            <option value="custom" disabled>
              Custom
            </option>
            {POLICY_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button className="btn quiet" onClick={revert}>
            Revert to in force
          </button>
          <button
            className="btn primary"
            disabled={diff.length === 0}
            onClick={() => {
              const presetId = POLICY_PRESETS.find((p) => policyDiff(p.policy, effective).length === 0)?.id ?? 'custom';
              session.setPolicy(
                effective,
                presetId,
                solution.frictionMultiplier !== 1
                  ? `Studio: ${solution.explanation}`
                  : `Studio: ${diff.map((d) => `${d.key} ${String(d.from)} → ${String(d.to)}`).join('; ')}`,
              );
            }}
          >
            Apply to console
          </button>
        </div>
      </div>

      <div className="side-first" style={{ display: 'grid' }}>
        <div>
          <section className="panel">
            <header>
              <h2>Prices and estimates</h2>
              <span className="meta">candidate</span>
            </header>
            {FIELDS.map((f) => (
              <label key={f.key} className="field">
                <span className="label">{f.label}</span>
                <span className="value">{show(f, candidate[f.key] as number)}</span>
                <input
                  type="range"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={candidate[f.key] as number}
                  onChange={(e) => set(f.key, Number(e.target.value))}
                />
                <span className="help">{f.help}</span>
              </label>
            ))}
          </section>

          <section className="panel">
            <header>
              <h2>Rate ceilings</h2>
              <span className="meta">solved as a friction price, not a cap</span>
            </header>
            <div className="field">
              <span className="label">Maximum false-positive rate</span>
              <span className="row" style={{ gap: 6 }}>
                <input className="input mono" style={{ width: 80 }} placeholder="none" value={fprCap} onChange={(e) => setFprCap(e.target.value)} inputMode="decimal" aria-label="FPR ceiling percent" />
                <span className="faint">%</span>
              </span>
              <span className="help">Share of legitimate payments that may be held or blocked.</span>
            </div>
            <div className="field">
              <span className="label">Maximum intervention rate</span>
              <span className="row" style={{ gap: 6 }}>
                <input className="input mono" style={{ width: 80 }} placeholder="none" value={stepCap} onChange={(e) => setStepCap(e.target.value)} inputMode="decimal" aria-label="Intervention ceiling percent" />
                <span className="faint">%</span>
              </span>
              <span className="help">Share of all payments that may be interrupted, fraudulent or not.</span>
            </div>
            <p className="small muted" style={{ marginTop: 10 }}>
              {solution.explanation}
              {solution.frictionMultiplier !== 1 ? (
                <>
                  {' '}
                  Effective prices: hold {formatINR(effective.stepUpFrictionPaise)}, block{' '}
                  {formatINR(effective.blockFrictionPaise)}.
                </>
              ) : null}
              {!solution.satisfied ? <strong> The ceiling cannot be met.</strong> : null}
            </p>
          </section>
        </div>

        <div>
          <section className="panel">
            <header>
              <h2>Decision boundaries by amount</h2>
              <span className="meta">
                at ₹25,000: hold above {prob(tCand.approveToStepUp)}, block above {prob(tCand.stepUpToBlock)}
                {tCand.stepUpDominated ? ' · holding never wins' : ''}
              </span>
            </header>
            <SurfaceChart candidate={effective} current={current} recoveryCandidate={recCand} recoveryCurrent={recCurr} />
            <p className="tiny faint" style={{ marginTop: 6 }}>
              In force at ₹25,000: hold above {prob(tCurr.approveToStepUp)}, block above {prob(tCurr.stepUpToBlock)}.
              Recoverable at the report lag: {pct(recCand, 1)} candidate, {pct(recCurr, 1)} in force.
            </p>
          </section>

          <section className="panel">
            <header>
              <h2>What it would have done</h2>
              <span className="meta">replay window, ground truth known</span>
            </header>
            <table className="data">
              <thead>
                <tr>
                  <th></th>
                  <th className="num">Candidate</th>
                  <th className="num">In force</th>
                </tr>
              </thead>
              <tbody>
                <Row label="Held" a={pct(candRates.stepUpRate, 2)} b={pct(currRates.stepUpRate, 2)} />
                <Row label="Blocked" a={pct(candRates.blockRate, 2)} b={pct(currRates.blockRate, 2)} />
                <Row label="False-positive rate" a={pct(candRates.falsePositiveRate, 2)} b={pct(currRates.falsePositiveRate, 2)} />
                <Row label="Detection rate" a={pct(candRates.detectionRate, 1)} b={pct(currRates.detectionRate, 1)} />
                <Row label="Expected cost over window" a={formatINRCompact(candRates.expectedCostPaise)} b={formatINRCompact(currRates.expectedCostPaise)} />
              </tbody>
            </table>
            <p className="tiny faint" style={{ marginTop: 6 }}>
              {fraudCount} labelled fraud cases make the detection rate coarse here; the portfolio page carries
              the held-out figure over the full window.
            </p>
          </section>

          <section className="panel">
            <header>
              <h2>Achievable trade-off</h2>
              <span className="meta">friction price swept from 0.02× to 1000×</span>
            </header>
            <FrontierChart
              frontier={frontier}
              marks={[
                { label: 'candidate', falsePositiveRate: candRates.falsePositiveRate, detectionRate: candRates.detectionRate, emphasis: true },
                ...presetMarks.filter((m) => Math.abs(m.falsePositiveRate - candRates.falsePositiveRate) > 1e-6 || Math.abs(m.detectionRate - candRates.detectionRate) > 1e-6),
              ]}
            />
            <p className="tiny faint" style={{ marginTop: 6 }}>
              The expected-cost minimum is one point on this curve, not a privileged one. An institution may choose
              another for conduct reasons the cost model does not price.
            </p>
          </section>

          {diff.length > 0 ? (
            <section className="panel">
              <header>
                <h2>Change record</h2>
                <span className="meta">written to the ledger on apply</span>
              </header>
              <table className="data">
                <tbody>
                  {diff.map((d) => (
                    <tr key={d.key}>
                      <td className="mono">{d.key}</td>
                      <td className="num faint">{fmt(d.key, d.from)}</td>
                      <td className="num">{fmt(d.key, d.to)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Row({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <tr>
      <td className="muted">{label}</td>
      <td className="num">{a}</td>
      <td className="num faint">{b}</td>
    </tr>
  );
}

function fmt(key: keyof Policy, v: unknown): string {
  if (v === null) return 'none';
  if (typeof v !== 'number') return String(v);
  if (key.endsWith('Paise')) return `₹${toRupees(v).toLocaleString('en-IN')}`;
  if (key.endsWith('Rate') || key === 'liabilityShare') return pct(v, 1);
  return String(v);
}
