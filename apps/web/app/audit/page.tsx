'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { AuditLedger, policyDiff, renderCaseNarrative } from '@kreaton/core';
import type { Action, LedgerEntry, LedgerQuery, LedgerRecord } from '@kreaton/core';
import { DecisionTag } from '../../components/DecisionTag';
import { formatINR, istClock, istDateTime, prob, withCommas } from '../../lib/format';
import { useSession } from '../../lib/use-session';

/**
 * The compliance trail.
 *
 * Every record the engine sealed in this session, queryable the way a
 * reviewer would query it, with the chain verifiable on demand and a case
 * file rendered for any transaction. The tamper check is here because a
 * hash chain nobody has watched break is a claim rather than a control.
 */
export default function AuditPage() {
  return (
    <Suspense fallback={<div className="loading">Loading.</div>}>
      <AuditInner />
    </Suspense>
  );
}

const KINDS: Array<LedgerEntry['kind']> = [
  'ASSESSMENT',
  'HOLD_OPENED',
  'HOLD_RESOLVED',
  'ATTEMPT_LINKED',
  'POLICY_CHANGED',
  'MODEL_LOADED',
];

function AuditInner() {
  const { snap, session } = useSession();
  const search = useSearchParams();
  const [txnId, setTxnId] = useState(search.get('txn') ?? '');
  const [kind, setKind] = useState<LedgerEntry['kind'] | ''>('');
  const [decision, setDecision] = useState<Action | ''>('');
  const [reason, setReason] = useState('');
  const [minP, setMinP] = useState('');
  const [verification, setVerification] = useState<{ valid: boolean; brokenAt: number | null; checked: number } | null>(null);
  const [tamper, setTamper] = useState<{ seq: number; brokenAt: number | null } | null>(null);

  const ledger = session.storeRef.ledger;
  // snap.version changes on every engine write, which is what should refresh the query.
  const records = useMemo(() => {
    const q: LedgerQuery = {};
    if (txnId.trim()) q.txnId = txnId.trim();
    if (kind) q.kind = kind;
    if (decision) q.decision = decision;
    if (reason.trim()) q.reasonCode = reason.trim().toUpperCase();
    if (minP.trim()) q.minProbability = Number(minP) / 100;
    return ledger.query(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledger, txnId, kind, decision, reason, minP, snap.version]);

  const shown = records.slice(-200).reverse();
  const narrative = txnId.trim() ? renderCaseNarrative(ledger.all(), txnId.trim()) : null;

  const runVerify = () => setVerification(ledger.verify());
  const runTamper = () => {
    const copy = AuditLedger.fromJsonl(ledger.toJsonl());
    const all = copy.all();
    if (all.length < 2) return;
    const victim = all[Math.floor(all.length / 2)]!;
    if (victim.entry.kind === 'ASSESSMENT') {
      const a = victim.entry.assessment as { decision: string };
      a.decision = a.decision === 'APPROVE' ? 'BLOCK' : 'APPROVE';
    } else {
      (victim as { ts: number }).ts += 1;
    }
    setTamper({ seq: victim.seq, brokenAt: copy.verify().brokenAt });
  };
  const exportJsonl = () => {
    const blob = new Blob([ledger.toJsonl()], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kreaton-ledger-${Date.now()}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (snap.status !== 'ready') {
    return (
      <div className="loading">
        Loading engine. <div className="bar" />
      </div>
    );
  }

  return (
    <>
      <div className="row between mb" style={{ alignItems: 'flex-end' }}>
        <div>
          <h1>Compliance trail</h1>
          <p className="lede small">
            Append-only, hash-chained. Each record commits to the digest of the one before it, so altering any
            entry invalidates every later digest and the verifier reports where.
          </p>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={runVerify}>
            Verify chain
          </button>
          <button className="btn" onClick={runTamper}>
            Tamper a copy
          </button>
          <button className="btn quiet" onClick={exportJsonl}>
            Export JSONL
          </button>
        </div>
      </div>

      <div className="stats panel">
        <Stat label="records sealed" value={withCommas(ledger.length)} />
        <Stat label="head digest" value={ledger.head.slice(0, 16)} sub="commits to the whole history" />
        <Stat
          label="verification"
          value={verification ? (verification.valid ? 'intact' : `broken at ${verification.brokenAt}`) : 'not run'}
          sub={verification ? `${withCommas(verification.checked)} records checked` : 'recomputes every digest'}
        />
        <Stat
          label="tamper check"
          value={tamper ? (tamper.brokenAt === tamper.seq ? 'detected' : 'missed') : 'not run'}
          sub={tamper ? `altered seq ${tamper.seq}, verifier broke at ${tamper.brokenAt}` : 'alters one record in a copy'}
        />
      </div>

      <div className="side-first" style={{ display: 'grid' }}>
        <div>
          <section className="panel">
            <header>
              <h2>Query</h2>
              <span className="meta">filters are conjunctive</span>
            </header>
            <div className="stack">
              <label className="stack" style={{ gap: 3 }}>
                <span className="small muted">Transaction id</span>
                <input className="input mono" value={txnId} onChange={(e) => setTxnId(e.target.value)} placeholder="txn_…" />
              </label>
              <label className="stack" style={{ gap: 3 }}>
                <span className="small muted">Record kind</span>
                <select className="select" value={kind} onChange={(e) => setKind(e.target.value as LedgerEntry['kind'] | '')}>
                  <option value="">any</option>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </label>
              <label className="stack" style={{ gap: 3 }}>
                <span className="small muted">Decision</span>
                <select className="select" value={decision} onChange={(e) => setDecision(e.target.value as Action | '')}>
                  <option value="">any</option>
                  <option value="APPROVE">APPROVE</option>
                  <option value="STEP_UP">STEP_UP</option>
                  <option value="BLOCK">BLOCK</option>
                </select>
              </label>
              <label className="stack" style={{ gap: 3 }}>
                <span className="small muted">Reason code</span>
                <input className="input mono" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="APP-CALL-3" />
              </label>
              <label className="stack" style={{ gap: 3 }}>
                <span className="small muted">Minimum p(fraud), percent</span>
                <input className="input mono" value={minP} onChange={(e) => setMinP(e.target.value)} placeholder="1" inputMode="decimal" />
              </label>
              <div className="small faint">
                {withCommas(records.length)} record{records.length === 1 ? '' : 's'} match
              </div>
            </div>
          </section>
        </div>

        <div>
          {narrative ? (
            <section className="panel">
              <header>
                <h2>Case file</h2>
                <span className="meta mono">{txnId.trim()}</span>
              </header>
              <pre className="doc">{narrative}</pre>
            </section>
          ) : null}

          <section className="panel">
            <header>
              <h2>Records</h2>
              <span className="meta">newest first, up to 200</span>
            </header>
            {shown.length === 0 ? (
              <div className="empty">No records match.</div>
            ) : (
              <div className="scroll-x">
                <table className="data">
                  <thead>
                    <tr>
                      <th className="num">Seq</th>
                      <th>Time</th>
                      <th>Kind</th>
                      <th>Summary</th>
                      <th>Digest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.seq}>
                        <td className="num">{r.seq}</td>
                        <td className="mono">{istClock(r.ts)}</td>
                        <td className="mono small">{r.entry.kind}</td>
                        <td>
                          <Summary record={r} onPick={(id) => setTxnId(id)} />
                        </td>
                        <td className="mono tiny faint">{r.hash.slice(0, 12)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function Summary({ record, onPick }: { record: LedgerRecord; onPick: (txnId: string) => void }) {
  const e = record.entry;
  switch (e.kind) {
    case 'ASSESSMENT':
      return (
        <span className="row" style={{ gap: 8 }}>
          <DecisionTag action={e.assessment.decision} override={Boolean(e.assessment.protocolOverride)} />
          <span className="mono">{formatINR(e.txn.amountPaise)}</span>
          <span className="faint">p {prob(e.assessment.calibratedP)}</span>
          <button className="btn quiet tiny" style={{ height: 22 }} onClick={() => onPick(e.txn.txnId)}>
            {e.txn.txnId}
          </button>
          <Link className="tiny faint" href={`/trace/${e.txn.txnId}`}>
            trace
          </Link>
        </span>
      );
    case 'HOLD_OPENED':
      return (
        <span>
          <span className="mono">{e.challengeType}</span> for{' '}
          <button className="btn quiet tiny" style={{ height: 22 }} onClick={() => onPick(e.txnId)}>
            {e.txnId}
          </button>
          {e.disqualified.length > 0 ? <span className="faint"> · ruled out {e.disqualified.map((d) => d.type).join(', ')}</span> : null}
        </span>
      );
    case 'HOLD_RESOLVED':
      return (
        <span>
          <span className="mono">{e.state}</span> after {e.heldMinutes} min · {e.detail}
        </span>
      );
    case 'ATTEMPT_LINKED':
      return (
        <span>
          <span className="mono">{e.disposition}</span> · {e.explanation}
        </span>
      );
    case 'POLICY_CHANGED': {
      const diff = policyDiff(e.before, e.after);
      return (
        <span>
          by {e.changedBy}: {diff.map((d) => `${d.key} ${String(d.from)} → ${String(d.to)}`).join('; ') || 'no field changed'}
          {e.note ? <span className="faint"> · {e.note}</span> : null}
        </span>
      );
    }
    case 'MODEL_LOADED':
      return (
        <span>
          {e.version} <span className="faint mono">{e.modelHash.slice(0, 12)}</span> fitted {e.fittedAt.slice(0, 10)} · {istDateTime(record.ts)}
        </span>
      );
  }
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 16 }}>
        {value}
      </div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}
