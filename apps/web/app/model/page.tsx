import type { Metadata } from 'next';
import { SIGNAL_ORDER, SIGNAL_SPECS, hashObject } from '@kreaton/core';
import { FIT, METRICS, MODEL } from '../../lib/artefacts';
import { pct, prob, withCommas } from '../../lib/format';

export const metadata: Metadata = { title: 'Model' };

/**
 * Model card.
 *
 * Everything a reviewer needs to judge the fitted model without reading the
 * source: what each signal measures and why, what weight it carries, how well
 * it separates on its own, how the fused score is calibrated, and what the
 * recoverability model assumes. Rationale text is the same text the engine
 * writes into the regulator export.
 */
export default function ModelPage() {
  const m = MODEL;
  const d = FIT.diagnostics;
  const cal = METRICS.heldOut.calibration;
  const bins = cal.bins.filter((b) => b.count > 0);
  const digest = hashObject(m);
  const strongest = [...SIGNAL_ORDER].sort((a, b) => d.marginalAuc[b] - d.marginalAuc[a])[0]!;

  return (
    <>
      <div className="mb">
        <h1>Model card</h1>
        <p className="lede small">
          {m.version}, fitted {m.fittedAt.slice(0, 10)}, digest <span className="mono">{digest.slice(0, 16)}</span>. Twelve
          weight-of-evidence signals fused additively in log-odds with group correlation shrinkage and an
          asymmetric cap on attacker-controllable evidence, then calibrated by isotonic regression. Fitted on{' '}
          {withCommas(FIT.split.trainRows)} payments ({d.trainFraud} fraudulent) and evaluated on the{' '}
          {withCommas(FIT.split.testRows)} that followed in time.
        </p>
      </div>

      <div className="stats panel">
        <Stat label="held-out ROC AUC" value={m.metrics.rocAuc.toFixed(4)} />
        <Stat label="PR AUC" value={m.metrics.prAuc.toFixed(4)} sub={`prevalence ${pct(FIT.corpus.observedFraudRate, 2)}`} />
        <Stat label="KS" value={m.metrics.ks.toFixed(3)} />
        <Stat label="recall at 1% FPR" value={pct(m.metrics.recallAt1PctFpr, 1)} />
        <Stat label="Brier" value={m.metrics.brier.toFixed(5)} />
        <Stat label="calibration error" value={m.metrics.ece.toFixed(4)} sub={`worst bin ${cal.mce.toFixed(3)}`} />
        <Stat label="strongest single signal" value={d.marginalAuc[strongest].toFixed(3)} sub={SIGNAL_SPECS[strongest].label} />
      </div>

      <section className="panel">
        <header>
          <h2>Signals</h2>
          <span className="meta">weights fitted by IRLS in {d.irlsIterations} iterations; standalone AUC is a guard against the corpus, not a ranking</span>
        </header>
        <div className="scroll-x">
          <table className="data">
            <thead>
              <tr>
                <th>Signal</th>
                <th>Group</th>
                <th>Measures</th>
                <th className="num">Weight</th>
                <th className="num">Shrink</th>
                <th className="num">LLR range</th>
                <th className="num">Alone AUC</th>
              </tr>
            </thead>
            <tbody>
              {SIGNAL_ORDER.map((id) => {
                const spec = SIGNAL_SPECS[id];
                const woe = m.signals.find((s) => s.id === id)!;
                const lo = Math.min(...woe.llrByBin);
                const hi = Math.max(...woe.llrByBin);
                return (
                  <tr key={id}>
                    <td>
                      <details>
                        <summary style={{ cursor: 'pointer' }}>{spec.label}</summary>
                        <div className="small muted" style={{ marginTop: 6, maxWidth: '60ch' }}>
                          {spec.rationale}
                        </div>
                        <table className="data tiny" style={{ marginTop: 8, maxWidth: 420 }}>
                          <thead>
                            <tr>
                              <th>Bin</th>
                              <th className="num">Upper edge</th>
                              <th className="num">LLR</th>
                              <th className="num">Fraud</th>
                              <th className="num">Legit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {woe.llrByBin.map((llr, i) => (
                              <tr key={i} style={i >= woe.firedFromBin ? { color: 'var(--fg-0)' } : { color: 'var(--fg-2)' }}>
                                <td className="mono">
                                  {i}
                                  {i >= woe.firedFromBin ? ' •' : ''}
                                </td>
                                <td className="num">{spec.binEdges[i] !== undefined ? spec.binEdges[i] : '∞'}</td>
                                <td className="num">{llr.toFixed(2)}</td>
                                <td className="num">{woe.fraudCountByBin[i]}</td>
                                <td className="num">{withCommas(woe.legitCountByBin[i] ?? 0)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="tiny faint" style={{ marginTop: 4 }}>
                          • bins at or above this index count as fired and produce reason code {spec.reasonCodePrefix}-n.
                        </div>
                      </details>
                    </td>
                    <td className="mono small">{spec.group}</td>
                    <td className="small muted" style={{ maxWidth: 360 }}>
                      {spec.description} <span className="faint">({spec.unit})</span>
                    </td>
                    <td className="num">{woe.weight.toFixed(3)}</td>
                    <td className="num">{m.groupShrinkage[spec.group].toFixed(3)}</td>
                    <td className="num">
                      {lo.toFixed(2)} to {hi.toFixed(2)}
                    </td>
                    <td className="num">{d.marginalAuc[id].toFixed(3)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="two-col" style={{ display: 'grid' }}>
        <div>
          <section className="panel">
            <header>
              <h2>Fusion</h2>
              <span className="meta">base rate {pct(m.baseRate, 3)}</span>
            </header>
            <table className="data">
              <thead>
                <tr>
                  <th>Group</th>
                  <th className="num">Intra-group ρ</th>
                  <th className="num">Shrinkage</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(m.groupShrinkage) as Array<keyof typeof m.groupShrinkage>).map((g) => (
                  <tr key={g}>
                    <td className="mono">{g}</td>
                    <td className="num">{d.groupCorrelation[g].toFixed(3)}</td>
                    <td className="num">{m.groupShrinkage[g].toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted" style={{ marginTop: 10 }}>
              Correlated signals in one group are discounted as a block so that four related behavioural
              signals firing together do not count as four independent pieces of evidence. Negative evidence from
              the <span className="mono">{m.asymmetricEvidence.cappedGroups.join(', ')}</span> group
              {m.asymmetricEvidence.cappedGroups.length === 1 ? ' is' : 's are'} floored at{' '}
              {m.asymmetricEvidence.negativeFloor.toFixed(2)} nats: an attacker can suppress a call or a paste for
              free, so absence of those indicators is not allowed to argue for the payment as strongly as their
              presence argues against it.
            </p>
            {d.filledBins.length > 0 ? (
              <p className="tiny faint" style={{ marginTop: 6 }}>
                {d.filledBins.length} bin{d.filledBins.length === 1 ? '' : 's'} never observed in training were filled
                by smoothing: {d.filledBins.map((b) => `${b.signal}[${b.bin}]`).join(', ')}.
              </p>
            ) : null}
          </section>

          <section className="panel">
            <header>
              <h2>Recoverability parameters</h2>
              <span className="meta">documented estimates, not measurements</span>
            </header>
            <table className="data">
              <thead>
                <tr>
                  <th>Layer</th>
                  <th className="num">Median dwell</th>
                  <th className="num">Hops onward</th>
                  <th className="num">Reachable</th>
                </tr>
              </thead>
              <tbody>
                {m.recovery.layerDwellMinutes.map((dwell, i) => (
                  <tr key={i}>
                    <td className="mono">{i + 1}</td>
                    <td className="num">{dwell} min</td>
                    <td className="num">{pct(m.recovery.hopProbability[i] ?? 0, 0)}</td>
                    <td className="num">{pct(m.recovery.traceabilityByLayer[i] ?? 0, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="tiny faint" style={{ marginTop: 6 }}>
              Lognormal dwell with σ = {m.recovery.dwellSigma}, mean fan-out {m.recovery.meanFanOut}, up to{' '}
              {m.recovery.maxLayers} layers. The Monte Carlo estimate drives decisions; the closed-form Markov chain
              is reported alongside and disagrees by at most {pct(METRICS.recovery.estimatorGap.maxAbsDiff, 1)}.
            </p>
          </section>
        </div>

        <div>
          <section className="panel">
            <header>
              <h2>Reliability</h2>
              <span className="meta">held-out, {bins.length} populated bins</span>
            </header>
            <ReliabilityChart bins={bins} />
            <table className="data" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th className="num">Predicted</th>
                  <th className="num">Observed</th>
                  <th className="num">Payments</th>
                </tr>
              </thead>
              <tbody>
                {bins.map((b, i) => (
                  <tr key={i}>
                    <td className="num">{prob(b.meanPredicted)}</td>
                    <td className="num">{prob(b.observedRate)}</td>
                    <td className="num">{withCommas(b.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <header>
              <h2>Corpus</h2>
              <span className="meta">typology-grounded synthetic, reproducible from the seed</span>
            </header>
            <table className="data">
              <tbody>
                <tr>
                  <td className="muted">Payments</td>
                  <td className="num">{withCommas(FIT.corpus.totalTransactions)}</td>
                </tr>
                <tr>
                  <td className="muted">Fraudulent</td>
                  <td className="num">
                    {withCommas(FIT.corpus.fraudulentTransactions)} ({pct(FIT.corpus.observedFraudRate, 2)})
                  </td>
                </tr>
                <tr>
                  <td className="muted">Chronological split</td>
                  <td className="num">
                    {withCommas(FIT.split.trainRows)} / {withCommas(FIT.split.testRows)}
                  </td>
                </tr>
                {Object.entries(FIT.corpus.byTypology)
                  .sort((a, b) => b[1].count - a[1].count)
                  .map(([t, v]) => (
                    <tr key={t}>
                      <td className="mono small">{t}</td>
                      <td className="num">{v.count}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <p className="tiny faint" style={{ marginTop: 6 }}>
              The evaluation fails if any single signal separates the held-out classes with AUC above 0.98,
              because on a generated corpus that is how a leak looks. Three such leaks were found and fixed
              during the build; the generator changes are described in the modelling document.
            </p>
          </section>
        </div>
      </div>
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

/** Predicted against observed, on square-root axes so the low-probability bins are legible. */
function ReliabilityChart({ bins }: { bins: Array<{ meanPredicted: number; observedRate: number; count: number }> }) {
  const w = 420;
  const h = 200;
  const pad = { top: 8, right: 10, bottom: 22, left: 40 };
  const sx = (p: number) => pad.left + Math.sqrt(p) * (w - pad.left - pad.right);
  const sy = (p: number) => pad.top + (1 - Math.sqrt(p)) * (h - pad.top - pad.bottom);
  const ticks = [0, 0.01, 0.1, 0.25, 0.5, 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="Reliability diagram" style={{ maxWidth: 520 }}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={sx(t)} x2={sx(t)} y1={pad.top} y2={h - pad.bottom} stroke="var(--line)" />
          <line x1={pad.left} x2={w - pad.right} y1={sy(t)} y2={sy(t)} stroke="var(--line)" />
          <text x={sx(t)} y={h - 6} textAnchor="middle" fill="var(--fg-2)" fontSize={10} fontFamily="var(--font-mono)">
            {pct(t, 0)}
          </text>
          <text x={pad.left - 6} y={sy(t) + 3.5} textAnchor="end" fill="var(--fg-2)" fontSize={10} fontFamily="var(--font-mono)">
            {pct(t, 0)}
          </text>
        </g>
      ))}
      <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke="var(--fg-3)" strokeDasharray="3 3" />
      {bins.map((b, i) => (
        <circle key={i} cx={sx(b.meanPredicted)} cy={sy(b.observedRate)} r={Math.max(2.5, Math.min(7, Math.log10(b.count + 1) * 1.6))} fill="var(--fg-0)" fillOpacity={0.85}>
          <title>{`predicted ${pct(b.meanPredicted, 2)}, observed ${pct(b.observedRate, 2)}, n=${b.count}`}</title>
        </circle>
      ))}
      <text x={w - pad.right} y={h - 6} textAnchor="end" fill="var(--fg-3)" fontSize={10} fontFamily="var(--font-mono)">
        predicted →
      </text>
      <text x={pad.left + 4} y={pad.top + 10} fill="var(--fg-3)" fontSize={10} fontFamily="var(--font-mono)">
        observed
      </text>
    </svg>
  );
}
