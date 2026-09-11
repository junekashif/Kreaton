'use client';

import type { Decision } from '../lib/session';
import { formatINR, istClock, prob } from '../lib/format';
import { riskColor } from '../lib/risk';
import { DecisionTag } from './DecisionTag';

interface Props {
  decisions: readonly Decision[];
  selectedTxnId: string | null;
  onSelect: (txnId: string) => void;
  limit?: number;
  interventionsOnly?: boolean;
}

/**
 * The most recent decisions, newest first.
 *
 * Almost every payment is approved, which is the point of the system and also
 * the problem with reading it: the one payment that was stopped arrives
 * looking exactly like the forty above it. Two things answer that -- the
 * filter, which drops the approvals entirely, and the entry wash on the newest
 * row, which is tinted by the decision so an interception announces itself.
 */
export function Feed({ decisions, selectedTxnId, onSelect, limit = 40, interventionsOnly = false }: Props) {
  const source = interventionsOnly
    ? decisions.filter((d) => d.result.assessment.decision !== 'APPROVE')
    : decisions;
  const rows = source.slice(-limit).reverse();

  if (rows.length === 0) {
    return (
      <div className="empty">
        {interventionsOnly
          ? 'Nothing has been held or blocked yet. Let the replay run, or try a scam scenario above.'
          : 'Press Watch it run, or try a scam scenario above.'}
      </div>
    );
  }

  return (
    <div className="scroll-x">
      <table className="data feed">
        <thead>
          <tr>
            <th>Time</th>
            <th>Paid by</th>
            <th>Paid to</th>
            <th className="num">Amount</th>
            <th className="num">
              Scam risk <span className="th-sub">p(fraud)</span>
            </th>
            <th>Decision</th>
            <th className="feed-why">
              Why <span className="th-sub">leading signal</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d, i) => {
            const a = d.result.assessment;
            const leading = a.reasonCodes[0];
            const top = a.signals.find((s) => s.reasonCode === leading);
            return (
              <tr
                key={d.txn.txnId}
                className={i === 0 ? 'selectable fresh' : 'selectable'}
                data-action={a.decision}
                aria-selected={d.txn.txnId === selectedTxnId}
                onClick={() => onSelect(d.txn.txnId)}
              >
                <td className="mono" data-label="Time">
                  {istClock(d.txn.ts)}
                </td>
                <td className="mono" data-label="Paid by">
                  {d.txn.payerVpa}
                  {d.injected ? (
                    <span className="faint"> · injected</span>
                  ) : d.txn.label.isFraud ? (
                    <span className="faint"> · known scam</span>
                  ) : null}
                </td>
                <td data-label="Paid to">
                  <span className="mono">{d.txn.payeeVpa}</span>
                  <span className="faint"> {d.txn.payeeName}</span>
                </td>
                <td className="num" data-label="Amount">
                  {formatINR(d.txn.amountPaise)}
                </td>
                <td className="num" data-label="Scam risk">
                  <span className="risk-chip" style={{ background: riskColor(a.calibratedP) }} />
                  {prob(a.calibratedP)}
                </td>
                <td data-label="Decision">
                  <DecisionTag action={a.decision} override={Boolean(a.protocolOverride)} />
                </td>
                <td className="feed-why small muted" data-label="Why">
                  {top ? `${top.reasonCode} ${top.evidence}` : 'No signal fired'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
