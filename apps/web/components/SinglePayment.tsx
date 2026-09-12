'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toPaise, toRupees } from '@kreaton/core';
import type { Millis, Transaction } from '@kreaton/core';
import { formatINR, prob } from '../lib/format';
import { useSession } from '../lib/use-session';
import { DecisionTag } from './DecisionTag';

/**
 * Compose one payment by hand.
 *
 * The importer answers "how does the engine behave on my data". This answers
 * the other question people ask at a demonstration, which is "what happens if
 * I change this one thing" — move the amount, put the payer on a call, paste
 * the identifier instead of choosing a contact, and watch the decision move.
 *
 * It runs through the same authorisation path as a replayed payment, so the
 * result appears in the feed and is sealed into the same ledger. The request
 * body for POST /api/v1/authorize is shown alongside, because the field an
 * operator just changed on screen is the field an integrator has to populate.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface Draft {
  payeeName: string;
  payeeVpa: string;
  amountRupees: number;
  entry: Transaction['context']['vpaEnteredBy'];
  activeCall: boolean;
  callMinutes: number;
  screenShare: boolean;
  remoteAccess: boolean;
  appSwitches: number;
  secondsToPay: number;
  newDevice: boolean;
  deviceAgeDays: number;
  simChanged: boolean;
  beneficiaryAgeHours: number | null;
  payeeAccountAgeDays: number;
  payeeVelocity: number;
  confirmedMule: boolean;
}

const ORDINARY: Draft = {
  payeeName: 'SHREE KIRANA STORE',
  payeeVpa: 'shree.kirana@okhdfcbank',
  amountRupees: 850,
  entry: 'qr',
  activeCall: false,
  callMinutes: 0,
  screenShare: false,
  remoteAccess: false,
  appSwitches: 1,
  secondsToPay: 24,
  newDevice: false,
  deviceAgeDays: 400,
  simChanged: false,
  beneficiaryAgeHours: 2_000,
  payeeAccountAgeDays: 900,
  payeeVelocity: 0.05,
  confirmedMule: false,
};

const PRESETS: Array<{ id: string; label: string; note: string; draft: Draft }> = [
  {
    id: 'ordinary',
    label: 'An ordinary payment',
    note: 'A shop the payer uses often, scanned in person, no call.',
    draft: ORDINARY,
  },
  {
    id: 'arrest',
    label: 'Digital arrest',
    note: 'Coached on a long call, identifier pasted from chat, savings-sized amount to an account opened days ago.',
    draft: {
      ...ORDINARY,
      payeeName: 'CYBER CELL VERIFICATION',
      payeeVpa: 'verify.cell@okaxis',
      amountRupees: 185_000,
      entry: 'pasted',
      activeCall: true,
      callMinutes: 45,
      appSwitches: 7,
      secondsToPay: 14,
      beneficiaryAgeHours: null,
      payeeAccountAgeDays: 3,
      payeeVelocity: 0.94,
    },
  },
  {
    id: 'hygienic',
    label: 'A careful attacker',
    note: 'The same extraction with every indicator the attacker controls turned off. This is the hard case the evidence cap exists for.',
    draft: {
      ...ORDINARY,
      payeeName: 'S KUMAR',
      payeeVpa: 's.kumar4471@ybl',
      amountRupees: 185_000,
      entry: 'typed',
      activeCall: false,
      callMinutes: 0,
      appSwitches: 2,
      secondsToPay: 95,
      beneficiaryAgeHours: null,
      payeeAccountAgeDays: 6,
      payeeVelocity: 0.9,
    },
  },
  {
    id: 'large-genuine',
    label: 'A large genuine payment',
    note: 'A builder the payer has paid for months. Big, but nothing else about it is unusual.',
    draft: {
      ...ORDINARY,
      payeeName: 'VERMA CONSTRUCTIONS',
      payeeVpa: 'verma.constructions@oksbi',
      amountRupees: 240_000,
      entry: 'contact',
      appSwitches: 2,
      secondsToPay: 48,
      beneficiaryAgeHours: 5_000,
      payeeAccountAgeDays: 1_600,
      payeeVelocity: 0.08,
    },
  },
];

export function SinglePayment() {
  const router = useRouter();
  const { snap, session } = useSession();
  const [draft, setDraft] = useState<Draft>(ORDINARY);
  const [presetId, setPresetId] = useState('ordinary');
  const [payerId, setPayerId] = useState<string>('');
  const [submitted, setSubmitted] = useState<string | null>(null);

  const set = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setPresetId('custom');
  }, []);

  /**
   * Payers the console has already seen, so a composed payment can be scored
   * against a real baseline rather than against an empty profile. A payment
   * from a payer with no history is a legitimate thing to test, and it is the
   * first option, but it is not the interesting one.
   */
  const payers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of snap.decisions) counts.set(d.txn.payerId, (counts.get(d.txn.payerId) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([id, n]) => ({ id, n }));
  }, [snap.decisions]);

  /**
   * The composed payment, timestamped just after the engine clock so it lands
   * at the head of the feed. The clock is used rather than the wall clock so
   * the payment sits in the same timeline as everything the engine has already
   * scored — and so this stays pure, and the request body below does not
   * change on every keystroke.
   */
  const txn = useMemo((): Transaction => {
    const now = snap.clockMs + 20_000;
    const payer = payerId || 'composed_payer';
    return {
      txnId: `cmp_${now}`,
      ts: now as Millis,
      payerId: payer,
      payerVpa: `${payer}@okhdfcbank`,
      payeeId: `payee_${draft.payeeVpa.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`,
      payeeVpa: draft.payeeVpa,
      payeeName: draft.payeeName,
      amountPaise: toPaise(Math.max(1, draft.amountRupees)),
      channel: 'p2p',
      deviceId: `dev_${payer}`,
      ipHash: 'ip_composed',
      simSerialHash: 'sim_composed',
      context: {
        activeCall: draft.activeCall,
        activeCallSeconds: draft.activeCall ? draft.callMinutes * 60 : 0,
        screenShareActive: draft.screenShare,
        remoteAccessAppRunning: draft.remoteAccess,
        appSwitchCount: draft.appSwitches,
        secondsFromOpenToAuthorize: draft.secondsToPay,
        vpaEnteredBy: draft.entry,
        beneficiaryAddedAtMs:
          draft.beneficiaryAgeHours === null ? null : ((now - draft.beneficiaryAgeHours * HOUR_MS) as Millis),
        sessionId: `sess_composed_${now}`,
        isNewDevice: draft.newDevice,
        deviceBoundAtMs: (now - draft.deviceAgeDays * DAY_MS) as Millis,
        simChangedRecently: draft.simChanged,
      },
    };
  }, [draft, payerId, snap.clockMs]);

  const decision = submitted ? session.decisionFor(submitted) : undefined;

  const run = useCallback(() => {
    const result = session.submit(txn, {
      outboundVelocityRatio: draft.payeeVelocity,
      firstSeenMs: (txn.ts - draft.payeeAccountAgeDays * DAY_MS) as Millis,
      confirmedMule: draft.confirmedMule,
    });
    if (result) setSubmitted(result.txn.txnId);
  }, [session, txn, draft]);

  const body = useMemo(() => JSON.stringify(txn, null, 2), [txn]);

  return (
    <div className="stack">
      <section className="panel">
        <header><h2>Start from</h2></header>
        <div className="sample-row">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`sample${presetId === p.id ? ' is-on' : ''}`}
              onClick={() => {
                setDraft(p.draft);
                setPresetId(p.id);
                setSubmitted(null);
              }}
            >
              <span className="sample-label">{p.label}</span>
              <span className="muted tiny">{p.note}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="two-col">
        <div className="stack">
          <section className="panel">
            <header><h2>Who is paying</h2></header>
            <div className="field">
              <label className="label" htmlFor="payer">Payer</label>
              <select className="select" id="payer" value={payerId} onChange={(e) => setPayerId(e.target.value)}>
                <option value="">Someone with no history here</option>
                {payers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} — {p.n} payments seen
                  </option>
                ))}
              </select>
              <p className="help">
                {payerId
                  ? 'The amount and hour are judged against this payer’s own history in the current run.'
                  : payers.length === 0
                    ? 'Run the console for a moment and payers with real baselines will appear here.'
                    : 'With no history, amount deviation and time-of-day surprisal have almost nothing to measure against.'}
              </p>
            </div>
          </section>

          <section className="panel">
            <header><h2>The payment</h2></header>
            <Text label="Beneficiary name" value={draft.payeeName} onChange={(v) => set('payeeName', v)} />
            <Text label="Beneficiary UPI ID" value={draft.payeeVpa} onChange={(v) => set('payeeVpa', v)} mono />
            <Num
              label="Amount"
              value={draft.amountRupees}
              onChange={(v) => set('amountRupees', v)}
              min={1}
              max={1_000_000}
              step={100}
              display={formatINR(toPaise(draft.amountRupees))}
            />
            <div className="field">
              <label className="label" htmlFor="entry">How the payee was entered</label>
              <select className="select" id="entry" value={draft.entry} onChange={(e) => set('entry', e.target.value as Draft['entry'])}>
                <option value="qr">Scanned a QR code</option>
                <option value="contact">Chose a saved contact</option>
                <option value="typed">Typed it out</option>
                <option value="pasted">Pasted it</option>
                <option value="deeplink">Followed a link</option>
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="benage">How long this beneficiary has been known to the payer</label>
              <select className="select"
                id="benage"
                value={draft.beneficiaryAgeHours === null ? 'new' : String(draft.beneficiaryAgeHours)}
                onChange={(e) => set('beneficiaryAgeHours', e.target.value === 'new' ? null : Number(e.target.value))}
              >
                <option value="new">Added in this session</option>
                <option value="1">About an hour</option>
                <option value="24">A day</option>
                <option value="168">A week</option>
                <option value="2000">A few months</option>
                <option value="9000">Over a year</option>
              </select>
            </div>
          </section>

          <section className="panel">
            <header><h2>What was happening at the time</h2></header>
            <Check label="On a call" value={draft.activeCall} onChange={(v) => set('activeCall', v)} />
            {draft.activeCall && (
              <Num label="Call length, minutes" value={draft.callMinutes} onChange={(v) => set('callMinutes', v)} min={0} max={180} step={1} />
            )}
            <Check label="Sharing their screen" value={draft.screenShare} onChange={(v) => set('screenShare', v)} />
            <Check label="Remote access app running" value={draft.remoteAccess} onChange={(v) => set('remoteAccess', v)} />
            <Num label="App switches before paying" value={draft.appSwitches} onChange={(v) => set('appSwitches', v)} min={0} max={20} step={1} />
            <Num label="Seconds from opening the app to paying" value={draft.secondsToPay} onChange={(v) => set('secondsToPay', v)} min={1} max={600} step={1} />
          </section>

          <section className="panel">
            <header><h2>Device, and what is known about the receiving account</h2></header>
            <Check label="Unrecognised device" value={draft.newDevice} onChange={(v) => set('newDevice', v)} />
            <Check label="SIM swapped recently" value={draft.simChanged} onChange={(v) => set('simChanged', v)} />
            <Num label="Days the device has been bound" value={draft.deviceAgeDays} onChange={(v) => set('deviceAgeDays', v)} min={0} max={2000} step={1} />
            <Num label="Days since the receiving account was opened" value={draft.payeeAccountAgeDays} onChange={(v) => set('payeeAccountAgeDays', v)} min={0} max={3000} step={1} />
            <Num
              label="Share of money in that leaves within the hour"
              value={draft.payeeVelocity}
              onChange={(v) => set('payeeVelocity', v)}
              min={0}
              max={1}
              step={0.01}
              display={`${Math.round(draft.payeeVelocity * 100)}%`}
            />
            <Check label="Already confirmed as a collection account" value={draft.confirmedMule} onChange={(v) => set('confirmedMule', v)} />
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <header><h2>The decision</h2></header>
            {decision ? (
              <>
                <div className="compose-verdict">
                  <DecisionTag action={decision.result.assessment.decision} />
                  <span className="compose-p">
                    {prob(decision.result.assessment.calibratedP)}
                    <span className="th-sub">scam risk</span>
                  </span>
                </div>
                <ul className="plain-list small mt">
                  {decision.result.assessment.reasonCodes.slice(0, 5).map((c) => (
                    <li key={c} className="mono tiny">
                      {c}
                    </li>
                  ))}
                </ul>
                <div className="btn-row mt">
                  <button type="button" className="btn" onClick={() => router.push(`/trace/${decision.txn.txnId}`)}>
                    Open the full assessment
                  </button>
                </div>
              </>
            ) : (
              <p className="muted small">
                Set the payment up on the left, then authorise it. The result lands in the feed and in the audit
                ledger like any other payment.
              </p>
            )}
            <div className="btn-row mt">
              <button type="button" className="btn primary" onClick={run} disabled={snap.status !== 'ready'}>
                Authorise this payment
              </button>
            </div>
            <p className="muted tiny mt">
              {toRupees(txn.amountPaise).toLocaleString('en-IN')} rupees to {draft.payeeName}.
            </p>
          </section>

          <section className="panel">
            <header><h2>The same payment as an API request
              <span className="th-sub">POST /api/v1/authorize</span>
            </h2></header>
            <pre className="code-block">{body}</pre>
            <div className="btn-row">
              <button
                type="button"
                className="btn"
                onClick={() => void navigator.clipboard?.writeText(body)}
              >
                Copy
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// --- small controls --------------------------------------------------------

function Text({ label, value, onChange, mono }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean }) {
  const id = `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} type="text" className={mono ? 'input mono' : 'input'} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function Num({
  label,
  value,
  onChange,
  min,
  max,
  step,
  display,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  display?: string;
}) {
  const id = `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="field">
      {/* The label and the value are siblings, not nested: .field is a grid
          whose first column is the label and whose second is the reading, and
          a value tucked inside the label would run on from it instead. */}
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {display ? <span className="value">{display}</span> : <span />}
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const id = `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="field check">
      <input id={id} type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <label className="label" htmlFor={id}>{label}</label>
    </div>
  );
}
