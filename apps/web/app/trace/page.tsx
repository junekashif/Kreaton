'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DecisionTag } from '../../components/DecisionTag';
import { formatINR, istClock, prob } from '../../lib/format';
import { riskColor } from '../../lib/risk';
import { useSession } from '../../lib/use-session';

/** Pick a payment to trace: anything intercepted, or anything that scored above one percent. */
export default function TraceIndex() {
  const { snap } = useSession();
  const router = useRouter();
  const [id, setId] = useState('');

  const candidates = snap.decisions
    .filter((d) => d.result.assessment.decision !== 'APPROVE' || d.result.assessment.calibratedP >= 0.01)
    .slice(-60)
    .reverse();

  return (
    <>
      <h1>Mule chain trace</h1>
      <p className="lede small mb">
        Time-decay recoverability for one payment: how much of it a freeze order can still reach, minute by
        minute, and the collection network it entered.
      </p>
      <form
        className="row mb"
        onSubmit={(e) => {
          e.preventDefault();
          if (id.trim()) router.push(`/trace/${id.trim()}`);
        }}
      >
        <input className="input mono" placeholder="transaction id" value={id} onChange={(e) => setId(e.target.value)} style={{ width: 260 }} />
        <button className="btn" type="submit">
          Open
        </button>
      </form>
      <section className="panel">
        <header>
          <h2>Recent payments worth tracing</h2>
          <span className="meta">intercepted, or scored above 1%</span>
        </header>
        {snap.status !== 'ready' ? (
          <div className="loading">
            Loading engine. <div className="bar" />
          </div>
        ) : candidates.length === 0 ? (
          <div className="empty">Nothing yet. Play the console or inject an episode, then come back.</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Time</th>
                <th>Transaction</th>
                <th>Beneficiary</th>
                <th className="num">Amount</th>
                <th className="num">p(fraud)</th>
                <th>Decision</th>
                <th className="num">Recoverable at report lag</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((d) => {
                const a = d.result.assessment;
                return (
                  <tr key={d.txn.txnId} className="selectable" onClick={() => router.push(`/trace/${d.txn.txnId}`)}>
                    <td className="mono">{istClock(d.txn.ts)}</td>
                    <td className="mono">
                      <Link href={`/trace/${d.txn.txnId}`}>{d.txn.txnId}</Link>
                    </td>
                    <td>
                      <span className="mono">{d.txn.payeeVpa}</span> <span className="faint">{d.txn.payeeName}</span>
                    </td>
                    <td className="num">{formatINR(d.txn.amountPaise)}</td>
                    <td className="num">
                      <span className="risk-chip" style={{ background: riskColor(a.calibratedP) }} />
                      {prob(a.calibratedP)}
                    </td>
                    <td>
                      <DecisionTag action={a.decision} />
                    </td>
                    <td className="num">{prob(a.recovery.fractionAtHorizon)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
