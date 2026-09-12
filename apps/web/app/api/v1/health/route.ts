import { NextResponse } from 'next/server';
import { getServerEngine, getSink } from '../../../../lib/server-engine';

export async function GET(): Promise<Response> {
  const engine = getServerEngine();
  const sink = getSink();
  return NextResponse.json({
    ok: true,
    model: { version: engine.currentModel.version, hash: engine.modelDigest },
    policyHash: engine.policyDigest,
    ledger: { records: engine.store.ledger.length, head: engine.store.ledger.head },
    /**
     * Whether decisions are being copied anywhere durable.
     *
     * Reported rather than assumed: a sink that is configured but failing is
     * worse than none at all, because it looks like a record is being kept.
     * `failed` and `dropped` are the numbers to watch, and `lastError` says
     * why. The counters are per instance: on a serverless platform this
     * request may be answered by an instance other than the one that just
     * flushed, so a `written: 0` here does not mean nothing was written. The
     * sheet is the source of truth; these are a health signal.
     */
    persistence: sink
      ? { backing: 'google-sheets', ...sink.stats() }
      : { backing: 'memory', note: 'State lives in this instance and is lost when it recycles. See docs/PERSISTENCE.md.' },
  });
}
