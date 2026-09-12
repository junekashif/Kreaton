'use client';

import { useState } from 'react';
import { ImportPanel } from '../../components/ImportPanel';
import { SinglePayment } from '../../components/SinglePayment';
import { useSession } from '../../lib/use-session';

/**
 * Data in.
 *
 * Two ways to put something of your own through the engine: a whole file, and
 * one payment composed by hand. They answer different questions — how the
 * engine behaves on your data, and what happens when you change one thing —
 * and both run through exactly the same authorisation path as the shipped
 * corpus, so nothing here is a simulation of the product.
 */

type Tab = 'file' | 'one';

export default function DataPage() {
  const [tab, setTab] = useState<Tab>('file');
  const { snap, session } = useSession();
  const imported = snap.dataset.kind === 'imported';

  return (
    <main>
      <header className="orient">
        <h1>Your own data</h1>
        <p className="lede">
          The console ships with a slice of a generated corpus. You can replace it with a file of your own, or
          compose a single payment and watch the decision move as you change it. Both run through the same
          authorisation path as everything else.
        </p>
      </header>

      {imported && (
        <div className="banner">
          <p>
            Currently replaying <strong>{snap.dataset.name}</strong>
            {snap.dataset.report
              ? `, ${snap.dataset.report.rowsKept.toLocaleString('en-IN')} payments.`
              : '.'}{' '}
            Every figure in the console is measured on this file.
          </p>
          <button type="button" className="btn" onClick={() => session.restoreShipped()}>
            Back to the shipped corpus
          </button>
        </div>
      )}

      <div className="segmented" role="group" aria-label="How to supply data">
        <button type="button" className="btn quiet" aria-pressed={tab === 'file'} onClick={() => setTab('file')}>
          A whole file
        </button>
        <button type="button" className="btn quiet" aria-pressed={tab === 'one'} onClick={() => setTab('one')}>
          One payment
        </button>
      </div>

      {tab === 'file' ? <ImportPanel /> : <SinglePayment />}
    </main>
  );
}
