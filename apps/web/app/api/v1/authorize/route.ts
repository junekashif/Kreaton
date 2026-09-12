import { NextResponse } from 'next/server';
import { challengePrompt } from '@kreaton/core';
import { exampleTransaction, getServerEngine, persistAfterResponse, parseTransaction } from '../../../../lib/server-engine';

/**
 * POST /api/v1/authorize
 *
 * Authorise one in-flight payment. The response carries the decision and the
 * complete assessment that justifies it: every signal, the fused score, the
 * calibrated probability, the expected cost of each action, the recoverability
 * estimate, the hold opened (if any) and the sealed ledger position.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const { txn, problems } = parseTransaction(body);
  if (problems.length > 0) {
    return NextResponse.json({ error: 'Invalid transaction.', problems }, { status: 400 });
  }

  const engine = getServerEngine();
  try {
    const result = engine.authorize(txn);
    const a = result.assessment;
    persistAfterResponse();
    return NextResponse.json({
      txnId: a.txnId,
      decision: a.decision,
      calibratedP: a.calibratedP,
      reasonCodes: a.reasonCodes,
      protocolOverride: a.protocolOverride ?? null,
      hold: result.hold
        ? {
            holdId: result.hold.holdId,
            state: result.hold.state,
            challengeType: result.hold.challengeType,
            prompt: challengePrompt(result.hold.challengeType, txn),
            expiresAtMs: result.hold.expiresAtMs,
          }
        : null,
      linkedTo: result.linkedTo ?? null,
      assessment: a,
      ledger: { seq: result.ledgerSeq, head: engine.store.ledger.head },
      model: { version: a.modelVersion, hash: a.modelHash },
      policyHash: a.policyHash,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Authorisation failed.', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/** GET returns a valid example body, so an integrator can start from a working request. */
export async function GET(): Promise<Response> {
  return NextResponse.json({
    usage: 'POST a transaction of this shape to /api/v1/authorize.',
    example: exampleTransaction(),
  });
}
