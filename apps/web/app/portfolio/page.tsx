import type { Metadata } from 'next';
import { formatINR, formatINRCompact, istDate, pct, withCommas } from '../../lib/format';
import { METRICS, PORTFOLIO, TYPOLOGY_LABEL } from '../../lib/artefacts';
import { LivePortfolio } from './live';

export const metadata: Metadata = { title: 'Portfolio' };

/**
 * Portfolio risk report.
 *
 * The held-out window replayed through the complete interceptor, with ground
 * truth known, so every figure is a measurement rather than a projection. The
 * false-positive rate and the per-typology breakdown sit next to the
 * liability figure on purpose: a report that shows only the money saved is
 * not a report.
 */
export default function PortfolioPage() {
  const r = PORTFOLIO;
  const f = r.financial;
  const o = r.outcomes;
  const days = (r.windowToMs - r.windowFromMs) / 86_400_000;
  const byTypology = [...r.byTypology].sort((a, b) => a.detectionRate - b.detectionRate);
  const ops = METRICS.heldOut.operatingPoints;

  return (
    <>
      <div className="mb">
        <h1>Portfolio risk report</h1>
        <p className="lede small">
          Held-out window of {days.toFixed(0)} days, {istDate(r.windowFromMs)} to {istDate(r.windowToMs)}, replayed
          through the full engine under the default policy. Ground truth is known, so detection and
          false-positive rates are measured, not estimated. Model {METRICS.modelVersion}, generated{' '}
          {r.generatedAt.slice(0, 10)}.
        </p>
      </div>

      <div className="stats panel">
        <Stat label="screened" value={withCommas(r.screened.count)} sub={formatINRCompact(r.screened.valuePaise)} />
        <Stat label="compensation liability avoided" value={formatINRCompact(f.liabilityAvoidedPaise)} sub={`of ${formatINRCompact(f.unmitigatedLiabilityPaise)} with no interception`} />
        <Stat label="friction cost" value={formatINRCompact(f.frictionCostPaise)} sub={`${o.frictionPerThousand.toFixed(1)} interventions per 1,000`} />
        <Stat label="net benefit" value={formatINRCompact(f.netBenefitPaise)} sub="liability avoided minus friction" />
        <Stat label="detection" value={pct(o.detectionRate, 1)} sub={`${pct(o.valueDetectionRate, 1)} by value`} />
        <Stat label="false-positive rate" value={pct(o.falsePositiveRate, 2)} sub={`${withCommas(o.falsePositives)} legitimate payments interrupted`} />
        <Stat label="precision" value={pct(o.precision, 1)} sub="at corpus prevalence" />
      </div>

      <div className="two-col" style={{ display: 'grid' }}>
        <div>
          <section className="panel">
            <header>
              <h2>Decisions</h2>
              <span className="meta">count and value</span>
            </header>
            <table className="data">
              <thead>
                <tr>
                  <th>Action</th>
                  <th className="num">Payments</th>
                  <th className="num">Share</th>
                  <th className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {(['APPROVE', 'STEP_UP', 'BLOCK'] as const).map((a) => (
                  <tr key={a}>
                    <td className="mono">{a}</td>
                    <td className="num">{withCommas(r.byAction[a].count)}</td>
                    <td className="num">{pct(r.byAction[a].count / r.screened.count, 2)}</td>
                    <td className="num">{formatINRCompact(r.byAction[a].valuePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <header>
              <h2>Confusion</h2>
              <span className="meta">payments</span>
            </header>
            <table className="data">
              <thead>
                <tr>
                  <th></th>
                  <th className="num">Intervened</th>
                  <th className="num">Approved</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="muted">Fraudulent ({withCommas(r.truth.fraudCount)})</td>
                  <td className="num">{withCommas(o.truePositives)}</td>
                  <td className="num">{withCommas(o.falseNegatives)}</td>
                </tr>
                <tr>
                  <td className="muted">Legitimate ({withCommas(r.truth.legitimateCount)})</td>
                  <td className="num">{withCommas(o.falsePositives)}</td>
                  <td className="num">{withCommas(o.trueNegatives)}</td>
                </tr>
              </tbody>
            </table>
            <p className="tiny faint" style={{ marginTop: 6 }}>
              Residual liability on the {o.falseNegatives} approved frauds: {formatINR(f.residualLiabilityPaise)}.
            </p>
          </section>

          <section className="panel">
            <header>
              <h2>Holds</h2>
              <span className="meta">{withCommas(r.holds.opened)} opened, median {r.holds.medianHoldMinutes} min</span>
            </header>
            <table className="data">
              <tbody>
                {Object.entries(r.holds.byState)
                  .filter(([, n]) => n > 0)
                  .map(([state, n]) => (
                    <tr key={state}>
                      <td className="mono">{state}</td>
                      <td className="num">{withCommas(n)}</td>
                    </tr>
                  ))}
                <tr>
                  <td className="muted">Value released after re-confirmation</td>
                  <td className="num">{formatINRCompact(r.holds.releasedValuePaise)}</td>
                </tr>
                <tr>
                  <td className="muted">Value stopped</td>
                  <td className="num">{formatINRCompact(r.holds.stoppedValuePaise)}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="panel">
            <header>
              <h2>Authorisation latency</h2>
              <span className="meta">twelve signals, fusion, recoverability, three costs, a sealed record</span>
            </header>
            <div className="stats">
              <Stat label="mean" value={`${r.latency.meanMs.toFixed(3)} ms`} />
              <Stat label="p95" value={`${r.latency.p95Ms.toFixed(3)} ms`} />
              <Stat label="p99" value={`${r.latency.p99Ms.toFixed(3)} ms`} />
              <Stat label="max" value={`${r.latency.maxMs.toFixed(2)} ms`} />
            </div>
          </section>
        </div>

        <div>
          <section className="panel">
            <header>
              <h2>Detection by typology</h2>
              <span className="meta">hardest first</span>
            </header>
            <table className="data">
              <thead>
                <tr>
                  <th>Typology</th>
                  <th className="num">Cases</th>
                  <th className="num">Value</th>
                  <th className="num">By count</th>
                  <th className="num">By value</th>
                </tr>
              </thead>
              <tbody>
                {byTypology.map((t) => (
                  <tr key={t.typology}>
                    <td>{TYPOLOGY_LABEL[t.typology] ?? t.typology}</td>
                    <td className="num">{t.count}</td>
                    <td className="num">{formatINRCompact(t.valuePaise)}</td>
                    <td className="num">
                      <Bar value={t.detectionRate} />
                      {pct(t.detectionRate, 1)}
                    </td>
                    <td className="num">{pct(t.valueDetectionRate, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="tiny faint" style={{ marginTop: 6 }}>
              Marketplace purchase and impersonation of a known person are the weakest by design: a willing
              payer, a plausible amount, and few or no coercion indicators. What remains is the beneficiary
              side of the picture, and the default policy is conservative with it.
            </p>
          </section>

          <section className="panel">
            <header>
              <h2>Recall at a false-positive ceiling</h2>
              <span className="meta">held-out scoring, before the cost layer</span>
            </header>
            <table className="data">
              <thead>
                <tr>
                  <th className="num">FPR cap</th>
                  <th className="num">Recall</th>
                  <th className="num">Value recall</th>
                  <th className="num">Precision</th>
                </tr>
              </thead>
              <tbody>
                {ops.map((op) => (
                  <tr key={op.maxFpr}>
                    <td className="num">{pct(op.maxFpr, op.maxFpr < 0.01 ? 1 : 0)}</td>
                    <td className="num">{pct(op.point.recall, 1)}</td>
                    <td className="num">{pct(op.valueRecall, 1)}</td>
                    <td className="num">{pct(op.point.precision, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <header>
              <h2>Recoverability assumed</h2>
              <span className="meta">{pct(METRICS.recovery.atReportLag, 1)} at the report lag</span>
            </header>
            <p className="small muted">
              Time to full cash-out: p10 {METRICS.recovery.quantiles.p10.toFixed(0)} min, median{' '}
              {METRICS.recovery.quantiles.p50.toFixed(0)} min, p90 {METRICS.recovery.quantiles.p90.toFixed(0)} min.
              The lognormal and closed-form Markov estimators disagree by at most{' '}
              {pct(METRICS.recovery.estimatorGap.maxAbsDiff, 1)}, at {METRICS.recovery.estimatorGap.atMinutes} min.
              Liability avoided counts only value that would have been unrecoverable at the report lag; value
              that would have been frozen anyway is not claimed.
            </p>
          </section>

          <section className="panel">
            <header>
              <h2>Audit chain</h2>
              <span className="meta">{METRICS.auditChainValid ? 'intact' : 'BROKEN'}</span>
            </header>
            <p className="small muted">
              Every one of the {withCommas(r.screened.count)} assessments and every hold event in this window
              was sealed into the hash chain, and the chain verified intact at the end of the run.
            </p>
          </section>
        </div>
      </div>

      <LivePortfolio />
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

function Bar({ value }: { value: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 60,
        height: 6,
        background: 'var(--line)',
        marginRight: 8,
        verticalAlign: 'middle',
        position: 'relative',
      }}
    >
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${value * 100}%`, background: 'var(--fg-1)' }} />
    </span>
  );
}
