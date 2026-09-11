'use client';

import { useMemo } from 'react';
import { formatINRCompact, pct, withCommas } from '../../lib/format';
import { useSession } from '../../lib/use-session';

/**
 * The same figures for this browser session, so the committed report and the
 * live engine can be read side by side. Injected episodes are excluded from
 * the rates, because they are chosen rather than sampled.
 */
export function LivePortfolio() {
  const { snap } = useSession();
  const s = useMemo(() => {
    let screened = 0;
    let value = 0;
    let fraud = 0;
    let caught = 0;
    let legit = 0;
    let fp = 0;
    let held = 0;
    let blocked = 0;
    let avoided = 0;
    let friction = 0;
    for (const d of snap.decisions) {
      if (d.injected) continue;
      const a = d.result.assessment;
      screened++;
      value += d.txn.amountPaise;
      const intervened = a.decision !== 'APPROVE';
      if (a.decision === 'STEP_UP') held++;
      if (a.decision === 'BLOCK') blocked++;
      if (intervened) friction += a.economics.byAction[a.decision].expectedFrictionPaise;
      if (d.txn.label.isFraud) {
        fraud++;
        if (intervened) {
          caught++;
          const c = a.economics.byAction.APPROVE.components;
          const exposure = d.txn.amountPaise * (1 - c.recoveryFraction) * c.liabilityShare;
          avoided += exposure * (a.decision === 'BLOCK' ? 1 : a.economics.byAction.STEP_UP.components.stepUpCatchRate);
        }
      } else {
        legit++;
        if (intervened) fp++;
      }
    }
    return { screened, value, fraud, caught, legit, fp, held, blocked, avoided, friction };
  }, [snap.decisions]);

  if (snap.status !== 'ready' || s.screened === 0) return null;

  return (
    <section className="panel">
      <header>
        <h2>This session</h2>
        <span className="meta">
          {withCommas(s.screened)} replayed so far under policy {snap.policyHash.slice(0, 8)}
        </span>
      </header>
      <div className="stats">
        <div className="stat">
          <div className="label">screened</div>
          <div className="value">{withCommas(s.screened)}</div>
          <div className="sub">{formatINRCompact(s.value)}</div>
        </div>
        <div className="stat">
          <div className="label">held · blocked</div>
          <div className="value">
            {s.held} · {s.blocked}
          </div>
        </div>
        <div className="stat">
          <div className="label">fraud caught</div>
          <div className="value">{s.fraud > 0 ? `${s.caught}/${s.fraud}` : '—'}</div>
        </div>
        <div className="stat">
          <div className="label">false-positive rate</div>
          <div className="value">{s.legit > 0 ? pct(s.fp / s.legit, 2) : '—'}</div>
          <div className="sub">
            {s.fp} of {withCommas(s.legit)}
          </div>
        </div>
        <div className="stat">
          <div className="label">liability avoided</div>
          <div className="value">{formatINRCompact(Math.round(s.avoided))}</div>
          <div className="sub">friction {formatINRCompact(s.friction)}</div>
        </div>
      </div>
    </section>
  );
}
