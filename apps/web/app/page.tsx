'use client';

import Link from 'next/link';
import { useCallback, useMemo, useRef, useState } from 'react';
import { POLICY_PRESETS } from '@kreaton/core';
import { AnimatedNumber } from '../components/AnimatedNumber';
import { AssessmentPanel } from '../components/AssessmentPanel';
import { DecisionKey } from '../components/DecisionKey';
import { Feed } from '../components/Feed';
import { Ribbon } from '../components/Ribbon';
import { formatINRCompact, pct, withCommas } from '../lib/format';
import { SCENARIOS } from '../lib/scenarios';
import { useSession } from '../lib/use-session';

export default function ConsolePage() {
  const { snap, session } = useSession();
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0]!.id);
  const [interventionsOnly, setInterventionsOnly] = useState(false);
  const asideRef = useRef<HTMLElement>(null);

  /* Above 1100px the aside is sticky and the answer is already on screen.
     Below that it is stacked under a feed of up to forty cards, so choosing
     a row would update a panel thousands of pixels away; bring it into view
     instead. The sticky breakpoint and this one must stay in step. */
  const selectAndReveal = useCallback(
    (id: string) => {
      session.select(id);
      if (typeof window !== 'undefined' && window.innerWidth <= 1100) {
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        asideRef.current?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
      }
    },
    [session],
  );

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
      {/* Once a file of the operator's own is loaded, every counter, chart and
          rate on this page is measured on it rather than on the corpus the
          console ships with. Saying so here is the difference between a figure
          and a misread figure. */}
      {snap.dataset.kind === 'imported' && (
        <div className="banner">
          <p>
            Replaying <strong>{snap.dataset.name}</strong>
            {snap.dataset.report ? `, ${withCommas(snap.dataset.report.rowsKept)} payments` : ''}. Everything below
            is measured on that file
            {snap.dataset.report && !snap.dataset.report.labelled
              ? ', which carries no ground truth, so the scams-caught and false-positive figures cannot be filled in'
              : ''}
            .
          </p>
          <Link href="/data" className="btn">
            What this file can and cannot show
          </Link>
        </div>
      )}

      <section className="orient">
        <h1>Scam payments, stopped before the money moves</h1>
        <p className="lede">
          In an authorised push payment scam the victim is talked into paying, so the bank sees an
          ordinary transfer and lets it through. Kreaton reads every payment at the instant it is
          authorised &mdash; in well under a millisecond &mdash; and decides what happens to it.
        </p>

        <DecisionKey counts={{ APPROVE: stats.approve, STEP_UP: stats.stepUp, BLOCK: stats.block }} />

        <div className="transport">
          {snap.playing ? (
            <button className="btn cta" onClick={() => session.pause()}>
              <span className="cta-glyph" aria-hidden>
                <svg viewBox="0 0 10 10" width={11} height={11}>
                  <rect x={1.5} y={1} width={2.5} height={8} fill="currentColor" />
                  <rect x={6} y={1} width={2.5} height={8} fill="currentColor" />
                </svg>
              </span>
              Pause
            </button>
          ) : (
            <button
              className="btn cta"
              data-attention={snap.cursor === 0 ? 'true' : undefined}
              onClick={() => session.play()}
              disabled={snap.cursor >= snap.total}
            >
              <span className="cta-glyph" aria-hidden>
                <svg viewBox="0 0 10 10" width={11} height={11}>
                  <path d="M2,1 L9,5 L2,9 Z" fill="currentColor" />
                </svg>
              </span>
              {snap.cursor === 0 ? 'Watch it run' : 'Resume'}
            </button>
          )}
          <button className="btn" onClick={() => session.step(1)} disabled={snap.cursor >= snap.total}>
            One payment
          </button>
          <button className="btn" onClick={() => session.step(50)} disabled={snap.cursor >= snap.total}>
            Skip 50
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
          <span className="transport-progress small faint">
            {withCommas(snap.cursor)} of {withCommas(snap.total)} payments replayed
          </span>
        </div>
      </section>

      <div className="stats panel" style={{ borderTop: '1px solid var(--line)' }}>
        <Stat
          label="Payments screened"
          animate={stats.screened}
          format={(n) => withCommas(Math.round(n))}
          sub={`of ${withCommas(snap.total)} in this window · ${formatINRCompact(stats.valuePaise)}`}
        />
        <Stat
          label="Scams caught"
          value={stats.fraud > 0 ? `${stats.fraudCaught} of ${stats.fraud}` : '—'}
          sub={stats.fraud > 0 ? `${pct(stats.fraudCaught / stats.fraud, 0)} of the scams in the stream so far` : 'none in the stream yet'}
        />
        <Stat
          label="Genuine payments stopped"
          value={stats.legit > 0 ? pct(stats.legitIntervened / stats.legit, 2) : '—'}
          sub={`${withCommas(stats.legitIntervened)} of ${withCommas(stats.legit)} genuine · false positive rate`}
        />
        <Stat
          label="Money protected"
          animate={stats.liabilityAvoidedPaise}
          format={(n) => formatINRCompact(Math.round(n))}
          sub="conservative, after expected recovery"
        />
        <Stat label="Decision time" value={`${stats.p99.toFixed(3)} ms`} sub={`99th percentile · mean ${stats.mean.toFixed(3)} ms`} />
        <Stat
          label="Audit entries"
          animate={session.storeRef.ledger.length}
          format={(n) => withCommas(Math.round(n))}
          sub={`tamper-evident chain · head ${session.storeRef.ledger.head.slice(0, 8)}`}
        />
      </div>

      <div className="console-grid">
        <div>
          <section className="panel" style={{ paddingTop: 10 }}>
            <header>
              <h2>Every payment, placed by size and risk</h2>
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
              <h2>Try a scam on it yourself</h2>
              <span className="meta">runs a known scam pattern against a payer from the feed, at the engine clock</span>
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
              <h2>What the engine just did</h2>
              <div className="segmented" role="group" aria-label="Filter the feed">
                <button
                  className="btn quiet"
                  aria-pressed={!interventionsOnly}
                  onClick={() => setInterventionsOnly(false)}
                >
                  Every payment
                </button>
                <button
                  className="btn quiet"
                  aria-pressed={interventionsOnly}
                  onClick={() => setInterventionsOnly(true)}
                >
                  Only the ones it stopped
                </button>
              </div>
            </header>
            <Feed
              decisions={snap.decisions}
              selectedTxnId={selected?.txn.txnId ?? null}
              onSelect={selectAndReveal}
              interventionsOnly={interventionsOnly}
            />
          </section>
        </div>

        <aside ref={asideRef}>
          <section className="panel" style={{ paddingTop: 10 }}>
            <header>
              <h2>Why it decided that</h2>
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

function Stat({
  label,
  value,
  animate,
  format,
  sub,
}: {
  label: string;
  value?: string;
  animate?: number;
  format?: (n: number) => string;
  sub?: string;
}) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">
        {animate !== undefined && format ? <AnimatedNumber value={animate} format={format} /> : value}
      </div>
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
