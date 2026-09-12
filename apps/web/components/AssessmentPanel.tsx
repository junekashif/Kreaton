'use client';

import Link from 'next/link';
import { SIGNAL_SPECS, challengePrompt, isOpen } from '@kreaton/core';
import type { Action, HoldRecord } from '@kreaton/core';
import type { Decision } from '../lib/session';
import { ACTION_LABEL, formatINR, istClock, istDateTime, prob, signed } from '../lib/format';
import { riskColor } from '../lib/risk';
import { useSession } from '../lib/use-session';
import { DecisionTag } from './DecisionTag';
import { RecoveryCurve } from './RecoveryCurve';

/**
 * Everything the engine knew and did for one payment, laid out so that a
 * reviewer can check the arithmetic: the contributions sum to the fused score,
 * the fused score maps to the probability, and the probability and amount
 * price the three actions.
 */
export function AssessmentPanel({
  decision,
  hold,
  onResolve,
}: {
  decision: Decision;
  hold: HoldRecord | undefined;
  onResolve?: (holdId: string, outcome: 'confirmed' | 'failed' | 'abandoned') => void;
}) {
  const { txn, result } = decision;
  const a = result.assessment;
  const { snap } = useSession();
  // The generated corpus is labelled throughout; an imported file may carry no
  // ground truth at all.
  const labelled = snap.dataset.kind === 'shipped' || snap.dataset.report?.labelled === true;
  const ordered = [...a.signals].sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution));
  const maxAbs = Math.max(0.5, ...ordered.map((s) => Math.abs(s.contribution)));
  const sum = a.signals.reduce((s, x) => s + x.contribution, 0);

  return (
    <div className="assessment">
      <header className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="row" style={{ gap: 12 }}>
            <DecisionTag action={a.decision} override={Boolean(a.protocolOverride)} />
            <span className="mono" style={{ fontSize: 18 }}>
              {formatINR(txn.amountPaise)}
            </span>
          </div>
          <div className="small muted mt" style={{ marginTop: 6 }}>
            <span className="mono">{txn.payerVpa}</span> → <span className="mono">{txn.payeeVpa}</span>{' '}
            <span className="faint">{txn.payeeName}</span>
          </div>
          <div className="tiny faint mono">
            {txn.txnId} · {istDateTime(txn.ts)} · {txn.channel} · device {txn.deviceId}
            {decision.injected ? ` · injected scenario ${decision.injected}` : ''}
            {/* A dataset with no ground-truth column never said this payment was
                legitimate; it said nothing. Printing "labelled legitimate" there
                would be asserting the file's silence as a fact. */}
            {labelled
              ? txn.label.isFraud
                ? ` · labelled ${txn.label.typology ?? 'fraud'}`
                : ' · labelled legitimate'
              : ' · no ground truth'}
          </div>
        </div>
        <div className="stat" style={{ textAlign: 'right', padding: 0 }}>
          <div className="label">calibrated p(fraud)</div>
          <div className="value" style={{ color: riskColor(a.calibratedP) }}>
            {prob(a.calibratedP)}
          </div>
          <div className="sub">
            log-odds {a.fusedLogOdds.toFixed(2)} · latency {a.latencyMs.toFixed(3)} ms
          </div>
        </div>
      </header>

      {a.protocolOverride ? (
        <p className="small mt" style={{ borderLeft: '2px solid var(--stepup)', paddingLeft: 10 }}>
          <strong>Protocol override.</strong> Economics chose {ACTION_LABEL[a.protocolOverride.from]}; the hold
          protocol took precedence and {ACTION_LABEL[a.protocolOverride.to].toLowerCase()}ed it.{' '}
          {a.protocolOverride.reason}
        </p>
      ) : null}
      {result.linkedTo && !a.protocolOverride ? (
        <p className="small mt" style={{ borderLeft: '2px solid var(--stepup)', paddingLeft: 10 }}>
          Linked to open hold <span className="mono">{result.linkedTo.holdId}</span>: {result.linkedTo.explanation}
        </p>
      ) : null}

      <section className="panel">
        <header>
          <h3>Evidence</h3>
          <span className="meta">
            prior {a.priorLogOdds.toFixed(2)} {signed(sum)} = {a.fusedLogOdds.toFixed(2)} nats
          </span>
        </header>
        <div className="scroll-x">
          <table className="data evidence">
            <thead>
              <tr>
                <th>Signal</th>
                <th className="num">Measured</th>
                <th className="num">LLR × w·s</th>
                <th>Contribution</th>
                <th className="num">nats</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((s) => {
                const spec = SIGNAL_SPECS[s.id];
                const frac = Math.abs(s.contribution) / maxAbs;
                return (
                  <tr key={s.id} title={s.evidence}>
                    <td>
                      <div>{spec.label}</div>
                      <div className="tiny faint">
                        {s.fired ? <span className="mono">{s.reasonCode}</span> : 'quiet'} · {spec.group}
                      </div>
                    </td>
                    <td className="num">
                      {formatRaw(s.raw)}
                      <div className="tiny faint">{spec.unit}</div>
                    </td>
                    <td className="num">
                      {s.llr.toFixed(2)}
                      <div className="tiny faint">× {(s.weight * s.shrinkage).toFixed(2)}</div>
                    </td>
                    <td>
                      <div className="contrib">
                        <div className="axis" />
                        <div
                          className={`bar ${s.contribution >= 0 ? 'pos' : 'neg'}`}
                          style={{
                            left: s.contribution >= 0 ? '50%' : `${50 - frac * 50}%`,
                            width: `${frac * 50}%`,
                          }}
                        />
                      </div>
                    </td>
                    <td className="num">{signed(s.contribution)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="tiny faint mt" style={{ marginTop: 8 }}>
          Hover a row for the measurement in words. Contributions are exactly additive in log-odds; the
          calibrated probability is the isotonic map of the total.
        </p>
      </section>

      <section className="panel">
        <header>
          <h3>Expected cost of each action</h3>
          <span className="meta">margin {formatINR(a.economics.marginPaise)} over runner-up</span>
        </header>
        <table className="data">
          <thead>
            <tr>
              <th>Action</th>
              <th className="num">Liability</th>
              <th className="num">Friction</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {(['APPROVE', 'STEP_UP', 'BLOCK'] as Action[]).map((action) => {
              const c = a.economics.byAction[action];
              const chosen = action === a.economics.chosen;
              return (
                <tr key={action} style={chosen ? { color: 'var(--fg-0)' } : { color: 'var(--fg-1)' }}>
                  <td>
                    <DecisionTag action={action} />
                    {chosen ? <span className="faint tiny"> cheapest</span> : null}
                  </td>
                  <td className="num">{formatINR(c.expectedLiabilityPaise)}</td>
                  <td className="num">{formatINR(c.expectedFrictionPaise)}</td>
                  <td className="num">{formatINR(c.expectedTotalPaise)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="tiny faint" style={{ marginTop: 8 }}>
          Liability = p × amount × unrecovered share × liability share. Recovery at the report lag of{' '}
          {a.recovery.horizonMinutes} min is {prob(a.recovery.fractionAtHorizon)}.
        </p>
      </section>

      <section className="panel">
        <header>
          <h3>Mule chain recoverability</h3>
          <Link className="small muted" href={`/trace/${txn.txnId}`}>
            open trace
          </Link>
        </header>
        <RecoveryCurve estimate={a.recovery} height={130} compact />
      </section>

      {hold ? (
        <section className="panel">
          <header>
            <h3>Step-up hold</h3>
            <span className="meta mono">{hold.holdId}</span>
          </header>
          <HoldView hold={hold} txn={txn} onResolve={onResolve} />
        </section>
      ) : null}

      <section className="panel">
        <header>
          <h3>Audit record</h3>
          <Link className="small muted" href={`/audit?txn=${txn.txnId}`}>
            open case file
          </Link>
        </header>
        <div className="tiny mono faint" style={{ wordBreak: 'break-all' }}>
          ledger seq {result.ledgerSeq} · model {a.modelVersion} ({a.modelHash.slice(0, 12)}) · policy{' '}
          {a.policyHash.slice(0, 12)}
        </div>
      </section>
    </div>
  );
}

function formatRaw(x: number): string {
  if (Number.isInteger(x)) return String(x);
  if (Math.abs(x) >= 100) return x.toFixed(0);
  if (Math.abs(x) >= 10) return x.toFixed(1);
  return x.toFixed(2);
}

function HoldView({
  hold,
  txn,
  onResolve,
}: {
  hold: HoldRecord;
  txn: Decision['txn'];
  onResolve?: (holdId: string, outcome: 'confirmed' | 'failed' | 'abandoned') => void;
}) {
  const open = isOpen(hold);
  return (
    <div className="stack">
      <div className="row between">
        <span className="mono" data-state={hold.state}>
          {hold.state.replace(/_/g, ' ').toLowerCase()}
        </span>
        <span className="small faint">
          attempts {hold.attemptsUsed}/{hold.attemptBudget} · expires {istClock(hold.expiresAtMs)}
        </span>
      </div>
      <div className="plane" style={{ padding: '10px 12px' }}>
        <div className="tiny faint mono">{hold.challengeType}</div>
        <div className="small" style={{ marginTop: 4 }}>
          {challengePrompt(hold.challengeType, txn)}
        </div>
      </div>
      <ol className="small stack" style={{ gap: 4, paddingLeft: 18 }}>
        {hold.timeline.map((e, i) => (
          <li key={i}>
            <span className="mono faint">{istClock(e.ts)}</span> {e.detail}
          </li>
        ))}
      </ol>
      {open && onResolve ? (
        <div className="btn-row">
          <button className="btn" onClick={() => onResolve(hold.holdId, 'confirmed')}>
            Payer confirms
          </button>
          <button className="btn" onClick={() => onResolve(hold.holdId, 'failed')}>
            Confirmation fails
          </button>
          <button className="btn quiet" onClick={() => onResolve(hold.holdId, 'abandoned')}>
            Payer abandons
          </button>
        </div>
      ) : null}
    </div>
  );
}
