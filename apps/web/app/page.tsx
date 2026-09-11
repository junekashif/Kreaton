'use client';

import { useMemo, useState } from 'react';
import { POLICY_PRESETS } from '@kreaton/core';
import { AssessmentPanel } from '../components/AssessmentPanel';
import { Feed } from '../components/Feed';
import { Ribbon } from '../components/Ribbon';
import { formatINRCompact, pct, withCommas } from '../lib/format';
import { SCENARIOS } from '../lib/scenarios';
import { useSession } from '../lib/use-session';

export default function ConsolePage() {
  const { snap, session } = useSession();
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0]!.id);

  const stats = useMemo(() => summarise(snap.decisions), [snap.decisions]);

  const selected = useMemo(() => {
    if (snap.selectedTxnId) return session.decisionFor(snap.selectedTxnId);
    // Default to the most recent intervention, which is what an operator is here to see.
    for (let i = snap.decisions.length - 1; i >= 0; i--) {
      const d = snap.decisions[i]!;
      if (d.result.assessment.decision !== 'APPROVE') return d;
    }
    return snap.decisions[snap.decisions.length - 1];
    // decisions is replaced on every change, so this recomputes when it should.
  }, [snap.selectedTxnId, snap.decisions, session]);

  const recoveryAtLag = session.engine?.recovery.recoverableAt(snap.policy?.reportLagMinutes ?? 240) ?? 0;
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;

  if (snap.status === 'error') {
    return (
      <div className="loading">
        The engine could not load its data: <span className="mono">{snap.error}</span>
      </div>
    );
  }
  if (snap.status !== 'ready' || !snap.slice) {
    return (
      <div className="loading">
        Loading the fitted model and the replay window with warmed profiles.
        <div className="bar" />
      </div>
    );
  }

  return (
    <>
      <div className="row between mb" style={{ alignItems: 'flex-end' }}>
        <div>
          <h1>Interception console</h1>
          <p className="lede small">
            Every payment below is authorised by the engine running in this tab, against profiles warmed on
            the sixty days before the window. Marks sit at their amount and calibrated risk; the curves are
            the decision boundaries the current policy implies.
          </p>
        </div>
        <div className="btn-row">
          {snap.playing ? (
            <button className="btn primary" onClick={() => session.pause()}>
              Pause
            </button>
          ) : (
            <button className="btn primary" onClick={() => session.play()} disabled={snap.cursor >= snap.total}>
              Play
            </button>
          )}
          <button className="btn" onClick={() => session.step(1)} disabled={snap.cursor >= snap.total}>
            Step
          </button>
          <button className="btn" onClick={() => session.step(50)} disabled={snap.cursor >= snap.total}>
            +50
          </button>
          <select
            className="select"
            value={snap.speed}
            onChange={(e) => session.setSpeed(Number(e.target.value))}
            aria-label="Playback speed"
          >
            {[2, 6, 12, 30, 60].map((s) => (
              <option key={s} value={s}>
                {s}/s
              </option>
            ))}
          </select>
          <button className="btn quiet" onClick={() => session.reset()}>
            Rewind
          </button>
        </div>
      </div>

      <div className="stats panel" style={{ borderTop: '1px solid var(--line)' }}>
        <Stat label="screened" value={withCommas(stats.screened)} sub={`of ${withCommas(snap.total)} in window · ${formatINRCompact(stats.valuePaise)}`} />
        <Stat label="approved · held · blocked" value={`${stats.approve} · ${stats.stepUp} · ${stats.block}`} sub={`${pct(stats.interventionRate, 2)} intervened`} />
        <Stat
          label="fraud caught"
          value={stats.fraud > 0 ? `${stats.fraudCaught}/${stats.fraud}` : '—'}
          sub={stats.fraud > 0 ? `${pct(stats.fraudCaught / stats.fraud, 0)} of labelled fraud so far` : 'none in the stream yet'}
        />
        <Stat label="false positives" value={stats.legit > 0 ? pct(stats.legitIntervened / stats.legit, 2) : '—'} sub={`${stats.legitIntervened} of ${withCommas(stats.legit)} legitimate`} />
        <Stat label="liability avoided" value={formatINRCompact(stats.liabilityAvoidedPaise)} sub="conservative, net of recovery" />
        <Stat label="latency p99" value={`${stats.p99.toFixed(3)} ms`} sub={`mean ${stats.mean.toFixed(3)} ms`} />
        <Stat label="ledger" value={withCommas(session.storeRef.ledger.length)} sub={`head ${session.storeRef.ledger.head.slice(0, 10)}`} />
      </div>

      <div className="console-grid">
        <div>
          <section className="panel" style={{ paddingTop: 10 }}>
            <header>
              <h2>Interception ribbon</h2>
              <div className="row" style={{ gap: 8 }}>
                <span className="meta">policy</span>
                <select
                  className="select"
                  value={snap.policyId}
                  onChange={(e) => session.applyPreset(e.target.value)}
                  aria-label="Policy preset"
                >
                  {POLICY_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                  {snap.policyId === 'custom' ? <option value="custom">Custom (studio)</option> : null}
                </select>
              </div>
            </header>
            <Ribbon
              decisions={snap.decisions}
              policy={snap.policy}
              recoveryAtReportLag={recoveryAtLag}
              selectedTxnId={selected?.txn.txnId ?? null}
              onSelect={(id) => session.select(id)}
            />
          </section>

          <section className="panel">
            <header>
              <h2>Inject an episode</h2>
              <span className="meta">runs against a real payer from the feed, at the engine clock</span>
            </header>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <select className="select" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} aria-label="Scenario">
                {SCENARIOS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button className="btn" onClick={() => session.inject(scenarioId)}>
                Inject
              </button>
              <div className="small muted" style={{ flex: '1 1 320px' }}>
                <div>{scenario.summary}</div>
                <div className="faint" style={{ marginTop: 4 }}>
                  Expected: {scenario.expectation}
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <header>
              <h2>Feed</h2>
              <span className="meta">newest first · click a row to inspect</span>
            </header>
            <Feed decisions={snap.decisions} selectedTxnId={selected?.txn.txnId ?? null} onSelect={(id) => session.select(id)} />
          </section>
        </div>

        <aside>
          <section className="panel" style={{ paddingTop: 10 }}>
            <header>
              <h2>Assessment</h2>
              {selected ? (
                <button className="btn quiet small" onClick={() => session.select(null)}>
                  follow latest
                </button>
              ) : null}
            </header>
            {selected ? (
              <AssessmentPanel
                decision={selected}
                hold={session.holdFor(selected.txn.txnId)}
                onResolve={(holdId, outcome) =>
                  session.resolveHold(
                    holdId,
                    outcome === 'confirmed'
                      ? { kind: 'confirmed' }
                      : outcome === 'failed'
                        ? { kind: 'failed', reason: 'Payer did not complete re-confirmation.' }
                        : { kind: 'abandoned' },
                  )
                }
              />
            ) : (
              <div className="empty">Nothing assessed yet.</div>
            )}
          </section>
        </aside>
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

function summarise(decisions: readonly import('../lib/session').Decision[]) {
  let screened = 0;
  let valuePaise = 0;
  let approve = 0;
  let stepUp = 0;
  let block = 0;
  let fraud = 0;
  let fraudCaught = 0;
  let legit = 0;
  let legitIntervened = 0;
  let liabilityAvoidedPaise = 0;
  const latencies: number[] = [];
  for (const d of decisions) {
    if (d.injected) continue;
    const a = d.result.assessment;
    screened++;
    valuePaise += d.txn.amountPaise;
    if (a.decision === 'APPROVE') approve++;
    else if (a.decision === 'STEP_UP') stepUp++;
    else block++;
    const intervened = a.decision !== 'APPROVE';
    if (d.txn.label.isFraud) {
      fraud++;
      if (intervened) {
        fraudCaught++;
        const exposure = d.txn.amountPaise * (1 - a.recovery.fractionAtHorizon) * a.economics.byAction.APPROVE.components.liabilityShare;
        liabilityAvoidedPaise += exposure * (a.decision === 'BLOCK' ? 1 : a.economics.byAction.STEP_UP.components.stepUpCatchRate);
      }
    } else {
      legit++;
      if (intervened) legitIntervened++;
    }
    latencies.push(a.latencyMs);
  }
  latencies.sort((x, y) => x - y);
  const p99 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.99))] ?? 0;
  const mean = latencies.length ? latencies.reduce((s, x) => s + x, 0) / latencies.length : 0;
  return {
    screened,
    valuePaise,
    approve,
    stepUp,
    block,
    fraud,
    fraudCaught,
    legit,
    legitIntervened,
    interventionRate: screened > 0 ? (stepUp + block) / screened : 0,
    liabilityAvoidedPaise: Math.round(liabilityAvoidedPaise),
    p99,
    mean,
  };
}
