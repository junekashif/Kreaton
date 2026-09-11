import { NextResponse } from 'next/server';
import { getServerEngine } from '../../../../lib/server-engine';

export async function GET(): Promise<Response> {
  const engine = getServerEngine();
  return NextResponse.json({
    ok: true,
    model: { version: engine.currentModel.version, hash: engine.modelDigest },
    policyHash: engine.policyDigest,
    ledger: { records: engine.store.ledger.length, head: engine.store.ledger.head },
  });
}
