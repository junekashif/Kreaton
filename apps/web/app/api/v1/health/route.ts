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
     * `failed` and `dropped` are the numbers to watch.
     */
    persistence: sink
      ? { backing: 'google-sheets', ...sink.stats() }
      : { backing: 'memory', note: 'State lives in this instance and is lost when it recycles. See docs/PERSISTENCE.md.' },
  });
}
