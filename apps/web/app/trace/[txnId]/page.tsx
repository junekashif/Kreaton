'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import { splitRecoverable } from '@kreaton/core';
import { DecisionTag } from '../../../components/DecisionTag';
import { RecoveryCurve } from '../../../components/RecoveryCurve';
import { formatINR, istDateTime, pct, prob } from '../../../lib/format';
import { riskColor } from '../../../lib/risk';
import { useSession } from '../../../lib/use-session';

const FREEZE_TIMES = [0, 5, 15, 30, 60, 120, 240, 480, 1440];

/**
 * One payment's recoverability, and the network it would have entered.
 *
 * Two questions a fraud desk asks the moment a scam is reported: how much of
 * it can still be frozen, and where has it gone. The first is answered by the
 * survival model with the operational freeze latency added; the second by
 * the beneficiary intelligence available for the collection account and the
 * chain it belongs to.
 */
export default function TracePage() {
  const params = useParams<{ txnId: string }>();
  const txnId = decodeURIComponent(params.txnId);
  const { snap, session } = useSession();

  // A direct visit has no replay state; run the window through so the payment exists.
  useEffect(() => {
    if (snap.status === 'ready' && !session.decisionFor(txnId) && snap.cursor < snap.total) {
      const idx = snap.slice?.transactions.findIndex((t) => t.txnId === txnId) ?? -1;
      if (idx >= snap.cursor) session.step(idx - snap.cursor + 1);
    }
  }, [snap.status, snap.cursor, snap.total, snap.slice, session, txnId]);

  const decision = snap.status === 'ready' ? session.decisionFor(txnId) : undefined;
  const engine = session.engine;

  const chain = useMemo(() => {
    if (!decision || !snap.slice) return null;
    const payee = session.payeeInfo(decision.txn.payeeId);
    const chainId = payee?.chainId ?? decision.txn.label.chainId ?? null;
    if (!chainId) return { payee, chainId: null, members: [], intel: [] };
    const members = session.chainMembers(chainId);
    const intel = snap.slice.intel.filter((e) => e.chainId === chainId).sort((a, b) => a.ts - b.ts);
    return { payee, chainId, members, intel };
  }, [decision, snap.slice, session]);

  if (snap.status !== 'ready') {
    return (
      <div className="loading">
        Loading engine. <div className="bar" />
      </div>
    );
  }
  if (!decision || !engine) {
    return (
      <>
        <h1>Trace</h1>
        <div className="empty">
          No assessment for <span className="mono">{txnId}</span> in this session.{' '}
          <Link href="/trace" className="muted">
            Choose another.
          </Link>
        </div>
      </>
    );
  }

  const { txn, result } = decision;
  const a = result.assessment;
  const rec = engine.recovery;
  const q = rec.cashOutQuantiles;
  const policy = snap.policy;
  const hold = session.holdFor(txnId);
  const payee = session.storeRef.getPayee(txn.payeeId);

  return (
    <>
      <div className="row between mb" style={{ alignItems: 'flex-end' }}>
        <div>
          <h1 className="mono" style={{ fontSize: 18 }}>
            {txn.txnId}
          </h1>
          <div className="small muted" style={{ marginTop: 4 }}>
            {formatINR(txn.amountPaise)} from <span className="mono">{txn.payerVpa}</span> to{' '}
            <span className="mono">{txn.payeeVpa}</span> <span className="faint">{txn.payeeName}</span> ·{' '}
            {istDateTime(txn.ts)}
          </div>
        </div>
        <div className="row" style={{ gap: 16 }}>
          <DecisionTag action={a.decision} override={Boolean(a.protocolOverride)} />
          <span className="mono" style={{ color: riskColor(a.calibratedP) }}>
            p {prob(a.calibratedP)}
          </span>
          <Link className="btn quiet" href={`/audit?txn=${txn.txnId}`}>
            case file
          </Link>
        </div>
      </div>

      <div className="stats panel">
        <Stat label="recoverable if reported at lag" value={pct(a.recovery.fractionAtHorizon, 1)} sub={`${policy.reportLagMinutes} min lag + ${policy.freezeLatencyMinutes} min freeze latency`} />
        <Stat label="value still freezable" value={formatINR(splitRecoverable(txn.amountPaise, a.recovery.fractionAtHorizon).recoverablePaise)} sub={`of ${formatINR(txn.amountPaise)}`} />
        <Stat label="expected onward hops" value={a.recovery.expectedHops.toFixed(2)} sub={`${rec.expectedFreezeOrders.toFixed(1)} freeze orders per case`} />
        <Stat label="time to cash-out" value={`${q.p50.toFixed(0)} min`} sub={`p10 ${q.p10.toFixed(0)} · p90 ${q.p90.toFixed(0)} min`} />
        <Stat label="estimator" value={a.recovery.method === 'monte_carlo' ? 'lognormal MC' : 'CTMC'} sub={a.recovery.interval ? `95% ${pct(a.recovery.interval.lo, 1)} to ${pct(a.recovery.interval.hi, 1)}` : 'closed form'} />
      </div>

      <div className="two-col" style={{ display: 'grid' }}>
        <section className="panel">
          <header>
            <h2>Recoverability against time</h2>
            <span className="meta">minutes after funds land, square-root axis</span>
          </header>
          <RecoveryCurve
            estimate={a.recovery}
            height={240}
            markers={[
              { minutes: policy.holdWindowMinutes, label: 'hold window' },
              { minutes: 60, label: 'golden hour' },
            ]}
          />
          <table className="data" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Freeze order raised at</th>
                <th className="num">Still in chain</th>
                <th className="num">Reachable</th>
                <th className="num">Value</th>
                <th className="num">Lost</th>
              </tr>
            </thead>
            <tbody>
              {FREEZE_TIMES.map((m) => {
                const r = rec.recoverableAt(m);
                const s = rec.survivingAt(m);
                const split = splitRecoverable(txn.amountPaise, r);
                return (
                  <tr key={m}>
                    <td className="mono">{m === 0 ? 'instantly' : m >= 60 ? `${m / 60} h` : `${m} min`}</td>
                    <td className="num faint">{pct(s, 1)}</td>
                    <td className="num">{pct(r, 1)}</td>
                    <td className="num">{formatINR(split.recoverablePaise)}</td>
                    <td className="num faint">{formatINR(split.lostPaise)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="tiny faint" style={{ marginTop: 6 }}>
            Still in chain is the share not yet cashed out. Reachable also discounts each layer by the
            probability a freeze order actually lands there within the window, which is why the two diverge
            as funds go deeper.
          </p>
        </section>

        <section className="panel">
          <header>
            <h2>Collection network</h2>
            <span className="meta">{chain?.chainId ? `chain ${chain.chainId}` : 'no chain intelligence'}</span>
          </header>
          {payee ? (
            <table className="data mb">
              <tbody>
                <tr>
                  <td className="muted">Beneficiary account age</td>
                  <td className="num">{((txn.ts - payee.firstSeenMs) / 86_400_000).toFixed(1)} days</td>
                </tr>
                <tr>
                  <td className="muted">Distinct payers, 24 h / all time</td>
                  <td className="num">
                    {payee.distinctPayers24h} / {payee.distinctPayersAllTime}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Inbound value, 24 h</td>
                  <td className="num">{formatINR(payee.inboundValue24h)}</td>
                </tr>
                <tr>
                  <td className="muted">Forwarded within the hour</td>
                  <td className="num">{pct(payee.outboundVelocityRatio, 0)}</td>
                </tr>
                <tr>
                  <td className="muted">Confirmed mule at decision time</td>
                  <td className="num">
                    {payee.confirmedMule ? 'yes' : payee.muleHopDistance !== null ? `${payee.muleHopDistance} hop${payee.muleHopDistance === 1 ? '' : 's'} from one` : 'no'}
                  </td>
                </tr>
              </tbody>
            </table>
          ) : null}

          {chain?.chainId ? (
            <>
              <ChainDiagram
                members={chain.members}
                current={txn.payeeId}
                traceability={snap.model!.recovery.traceabilityByLayer}
                dwell={snap.model!.recovery.layerDwellMinutes}
              />
              <p className="tiny faint" style={{ marginTop: 6 }}>
                Accounts shown are the members of this network that appear in the replay window. Per-layer
                figures are the model&apos;s estimates, not observations of this chain.
              </p>
              {chain.intel.length > 0 ? (
                <>
                  <h3 className="mt">Intelligence timeline</h3>
                  <ul className="small stack" style={{ gap: 4, listStyle: 'none', marginTop: 6 }}>
                    {chain.intel.map((e, i) => (
                      <li key={i}>
                        <span className="mono faint">{istDateTime(e.ts)}</span>{' '}
                        <span className="mono">{e.payeeId}</span>{' '}
                        {e.hopDistance === 0 ? 'confirmed as a mule' : `linked at ${e.hopDistance} hop${e.hopDistance === 1 ? '' : 's'}`}
                        {e.ts > txn.ts ? <span className="faint"> · after this payment, not used</span> : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="small faint mt">No investigation had linked this network at any point in the window.</p>
              )}
            </>
          ) : (
            <p className="small muted">
              This beneficiary is not associated with any collection network in the intelligence available to the
              engine. The curve on the left is the population estimate for a payment that does turn out to be
              fraudulent; a payment that is not fraudulent has nothing to recover.
            </p>
          )}

          {hold ? (
            <>
              <h3 className="mt">Hold</h3>
              <p className="small">
                <span className="mono">{hold.holdId}</span> · {hold.state.replace(/_/g, ' ').toLowerCase()} ·{' '}
                {hold.challengeType}
              </p>
            </>
          ) : null}
        </section>
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

/**
 * Layers of a collection network, left to right, with the model's dwell and
 * traceability per layer beneath. The victim's payment enters at the marked
 * account.
 */
function ChainDiagram({
  members,
  current,
  traceability,
  dwell,
}: {
  members: Array<{ payeeId: string; name: string; layer: number | null }>;
  current: string;
  traceability: number[];
  dwell: number[];
}) {
  const layers = Math.max(1, ...members.map((m) => (m.layer ?? 1)), 3);
  const cols = Array.from({ length: layers }, (_, i) => i + 1);
  return (
    <div className="scroll-x">
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${layers}, minmax(120px, 1fr))`, gap: 0, minWidth: layers * 120 }}>
        {cols.map((layer) => {
          const here = members.filter((m) => (m.layer ?? 1) === layer);
          return (
            <div key={layer} style={{ borderLeft: layer === 1 ? 0 : '1px dashed var(--line-strong)', padding: '0 10px' }}>
              <div className="tiny faint mono">layer {layer}</div>
              <div className="tiny faint">
                dwell ~{dwell[layer - 1] ?? '—'} min · reach {traceability[layer - 1] !== undefined ? pct(traceability[layer - 1]!, 0) : '—'}
              </div>
              <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                {here.length === 0 ? (
                  <div className="tiny faint">no account observed</div>
                ) : (
                  here.map((m) => (
                    <div
                      key={m.payeeId}
                      className="plane small mono"
                      style={{
                        padding: '4px 6px',
                        borderColor: m.payeeId === current ? 'var(--fg-0)' : undefined,
                      }}
                      title={m.name}
                    >
                      {m.payeeId}
                      {m.payeeId === current ? <span className="faint"> ← this payment</span> : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
