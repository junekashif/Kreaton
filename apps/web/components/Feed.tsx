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
}

/** The most recent decisions, newest first. */
export function Feed({ decisions, selectedTxnId, onSelect, limit = 40 }: Props) {
  const rows = decisions.slice(-limit).reverse();
  if (rows.length === 0) {
    return <div className="empty">Press play, or inject an episode.</div>;
  }
  return (
    <div className="scroll-x">
      <table className="data feed">
        <thead>
          <tr>
            <th>Time</th>
            <th>Payer</th>
            <th>Beneficiary</th>
            <th className="num">Amount</th>
            <th className="num">p(fraud)</th>
            <th>Decision</th>
            <th className="hide-narrow">Leading reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const a = d.result.assessment;
            const leading = a.reasonCodes[0];
            const top = a.signals.find((s) => s.reasonCode === leading);
            return (
              <tr
                key={d.txn.txnId}
                className="selectable"
                aria-selected={d.txn.txnId === selectedTxnId}
                onClick={() => onSelect(d.txn.txnId)}
              >
                <td className="mono">{istClock(d.txn.ts)}</td>
                <td className="mono">
                  {d.txn.payerVpa}
                  {d.injected ? (
                    <span className="faint"> · injected</span>
                  ) : d.txn.label.isFraud ? (
                    <span className="faint"> · labelled fraud</span>
                  ) : null}
                </td>
                <td>
                  <span className="mono">{d.txn.payeeVpa}</span>
                  <span className="faint"> {d.txn.payeeName}</span>
                </td>
                <td className="num">{formatINR(d.txn.amountPaise)}</td>
                <td className="num">
                  <span className="risk-chip" style={{ background: riskColor(a.calibratedP) }} />
                  {prob(a.calibratedP)}
                </td>
                <td>
                  <DecisionTag action={a.decision} override={Boolean(a.protocolOverride)} />
                </td>
                <td className="hide-narrow small muted">
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
