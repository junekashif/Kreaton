import type { Metadata } from 'next';
import { ADVERSARIAL, ADVERSARIAL_LIABILITY_FIRST, DEFENCE_ORDER } from '../../lib/artefacts';
import { formatINRCompact, pct, withCommas } from '../../lib/format';

export const metadata: Metadata = { title: 'Adversarial' };

/**
 * Adversarial countermeasure evaluation.
 *
 * Six attacks on the system's own assumptions, each run against three whole
 * defences calibrated to interrupt the same share of legitimate payments. The
 * headline is the comparison with a tuned rule, because a tuned rule is what
 * is usually deployed; the ablation is reported alongside because a suite
 * that only lists wins is marketing.
 */
export default function AdversarialPage() {
  const a = ADVERSARIAL;
  const b = ADVERSARIAL_LIABILITY_FIRST;
  const total = a.summary.expected_cost.episodes;
  const weakest = [...a.results].sort(
    (x, y) => x.byDefence.expected_cost.rate - y.byDefence.expected_cost.rate,
  )[0]!;

  return (
    <>
      <div className="mb">
        <h1>Adversarial evaluation</h1>
        <p className="lede small">
          {a.results.length} attacks, {a.episodesPerAttack} episodes each, launched against three defences tuned
          to the same friction budget of {pct(a.calibration.referenceFpr, 2)} of legitimate payments (measured
          on {withCommas(a.calibration.legitimateSampleSize)} held-out legitimate payments). An episode counts
          as caught when any payment in it is held or blocked. Model {a.modelVersion}, policy{' '}
          {a.policyPreset.label.toLowerCase()}.
        </p>
      </div>

      <div className="stats panel">
        {DEFENCE_ORDER.map((id) => (
          <div key={id} className="stat">
            <div className="label">{a.defences[id].label}</div>
            <div className="value">{pct(a.summary[id].caught / a.summary[id].episodes, 1)}</div>
            <div className="sub">
              {a.summary[id].caught} of {total} episodes · leaked {formatINRCompact(a.summary[id].leaked)}
            </div>
          </div>
        ))}
        <div className="stat">
          <div className="label">weakest position</div>
          <div className="value">{pct(weakest.byDefence.expected_cost.rate, 1)}</div>
          <div className="sub">{weakest.label}</div>
        </div>
      </div>

      <section className="panel">
        <header>
          <h2>Defences under test</h2>
          <span className="meta">calibrated to a common friction budget</span>
        </header>
        <table className="data">
          <thead>
            <tr>
              <th>Defence</th>
              <th>What it is</th>
              <th className="num">Measured FPR</th>
            </tr>
          </thead>
          <tbody>
            {DEFENCE_ORDER.map((id) => (
              <tr key={id}>
                <td style={{ whiteSpace: 'nowrap' }}>{a.defences[id].label}</td>
                <td className="muted small">
                  {a.defences[id].description}
                  {id === 'rule_baseline' ? (
                    <span className="faint">
                      {' '}
                      Fitted: intervene above {formatINRCompact(a.calibration.params.ruleHighAmount)}, or above{' '}
                      {formatINRCompact(a.calibration.params.ruleNewPayeeAmount)} for a beneficiary under{' '}
                      {a.calibration.params.ruleNoveltyHours} h old.
                    </span>
                  ) : null}
                  {id === 'fixed_threshold' ? (
                    <span className="faint"> Fitted: intervene at p ≥ {a.calibration.params.fixedThreshold.toFixed(4)}.</span>
                  ) : null}
                </td>
                <td className="num">{pct(a.defences[id].falsePositiveRate, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <header>
          <h2>Episodes caught, by attack</h2>
          <span className="meta">95% Wilson intervals</span>
        </header>
        <div className="scroll-x">
          <table className="data">
            <thead>
              <tr>
                <th>Attack</th>
                {DEFENCE_ORDER.map((id) => (
                  <th key={id} className="num">
                    {a.defences[id].label}
                  </th>
                ))}
                <th className="num">Gain over rule</th>
                <th className="num">Ablation</th>
              </tr>
            </thead>
            <tbody>
              {a.results.map((r) => {
                const gain = (r.byDefence.expected_cost.rate - r.byDefence.rule_baseline.rate) * 100;
                const disjoint = r.byDefence.expected_cost.interval.lo > r.byDefence.rule_baseline.interval.hi;
                return (
                  <tr key={r.id}>
                    <td>
                      <a href={`#${r.id}`}>{r.label}</a>
                    </td>
                    {DEFENCE_ORDER.map((id) => {
                      const d = r.byDefence[id];
                      return (
                        <td key={id} className="num">
                          <Bar value={d.rate} />
                          {pct(d.rate, 1)}
                          <div className="tiny faint">
                            {pct(d.interval.lo, 0)}–{pct(d.interval.hi, 0)} · {formatINRCompact(d.valueLeakedPaise)}
                          </div>
                        </td>
                      );
                    })}
                    <td className="num">
                      {gain >= 0 ? '+' : ''}
                      {gain.toFixed(1)} pp
                      <div className="tiny faint">{disjoint ? 'intervals disjoint' : 'intervals overlap'}</div>
                    </td>
                    <td className="num">
                      {r.ablation.improvementPp >= 0 ? '+' : ''}
                      {r.ablation.improvementPp.toFixed(1)} pp
                      <div className="tiny faint">{r.ablation.significant ? 'significant' : 'not significant'}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="tiny faint" style={{ marginTop: 6 }}>
          Ablation removes only the countermeasure the attack targets from the full system. With twelve signals
          fused, one removal usually leaves enough evidence to catch the episode anyway, so the ablation
          measures marginal contribution, not importance.
        </p>
      </section>

      <section className="panel">
        <header>
          <h2>The same attacks under a different stance</h2>
          <span className="meta">
            {b.policyPreset.label.toLowerCase()} preset · friction budget {pct(b.calibration.referenceFpr, 2)} against{' '}
            {pct(a.calibration.referenceFpr, 2)}
          </span>
        </header>
        <p className="small muted" style={{ maxWidth: '78ch' }}>
          The policy interface is the lever for the weak positions above. Re-running the whole suite under the
          liability-first preset re-prices friction, which moves every boundary down and re-calibrates the
          other two defences to the higher budget. What that buys, and what it costs in interruptions, is the
          trade the operator makes.
        </p>
        <div className="scroll-x">
          <table className="data" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Attack</th>
                <th className="num">{a.policyPreset.label}</th>
                <th className="num">{b.policyPreset.label}</th>
                <th className="num">Rule at matched friction</th>
              </tr>
            </thead>
            <tbody>
              {a.results.map((r) => {
                const other = b.results.find((x) => x.id === r.id);
                return (
                  <tr key={r.id}>
                    <td>{r.label}</td>
                    <td className="num">{pct(r.byDefence.expected_cost.rate, 1)}</td>
                    <td className="num">{other ? pct(other.byDefence.expected_cost.rate, 1) : '—'}</td>
                    <td className="num faint">{other ? pct(other.byDefence.rule_baseline.rate, 1) : '—'}</td>
                  </tr>
                );
              })}
              <tr style={{ color: 'var(--fg-0)' }}>
                <td>All attacks</td>
                <td className="num">{pct(a.summary.expected_cost.caught / a.summary.expected_cost.episodes, 1)}</td>
                <td className="num">{pct(b.summary.expected_cost.caught / b.summary.expected_cost.episodes, 1)}</td>
                <td className="num faint">{pct(b.summary.rule_baseline.caught / b.summary.rule_baseline.episodes, 1)}</td>
              </tr>
              <tr>
                <td className="muted">Legitimate payments interrupted</td>
                <td className="num">{pct(a.calibration.referenceFpr, 2)}</td>
                <td className="num">{pct(b.calibration.referenceFpr, 2)}</td>
                <td className="num faint">{pct(b.defences.rule_baseline.falsePositiveRate, 2)}</td>
              </tr>
              <tr>
                <td className="muted">Value leaked</td>
                <td className="num">{formatINRCompact(a.summary.expected_cost.leaked)}</td>
                <td className="num">{formatINRCompact(b.summary.expected_cost.leaked)}</td>
                <td className="num faint">{formatINRCompact(b.summary.rule_baseline.leaked)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {a.results.map((r) => (
        <section key={r.id} className="panel" id={r.id}>
          <header>
            <h2>{r.label}</h2>
            <span className="meta">
              full system {pct(r.byDefence.expected_cost.rate, 1)} · rule {pct(r.byDefence.rule_baseline.rate, 1)}
            </span>
          </header>
          <div className="two-col" style={{ display: 'grid', gap: '0 28px' }}>
            <div className="small">
              <p className="muted">{r.description}</p>
              <p style={{ marginTop: 8 }}>
                <span className="faint">Why it works. </span>
                {r.premise}
              </p>
            </div>
            <div className="small">
              <p>
                <span className="faint">Countermeasure. </span>
                {r.countermeasure}
              </p>
              <p className="faint" style={{ marginTop: 8 }}>
                Removed for the ablation: {r.removedForComparison.join(', ')}. Hardened{' '}
                {pct(r.ablation.hardenedRate, 1)}, ablated {pct(r.ablation.ablatedRate, 1)}; value leaked{' '}
                {formatINRCompact(r.ablation.valueLeakedHardenedPaise)} against{' '}
                {formatINRCompact(r.ablation.valueLeakedAblatedPaise)}.
              </p>
            </div>
          </div>
        </section>
      ))}
    </>
  );
}

function Bar({ value }: { value: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 48,
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
