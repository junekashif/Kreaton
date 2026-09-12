import { NextResponse } from 'next/server';
import { getServerEngine, parseTransaction } from '../../../../../lib/server-engine';

/**
 * POST /api/v1/authorize/batch
 *
 * Authorise an ordered run of payments in one call.
 *
 * This is not a convenience wrapper around the single endpoint. Several
 * signals are stateful across payments — the structuring window accumulates
 * value, a re-attempt is linked to the hold it is trying to defeat, and every
 * behavioural baseline is built from the payments that came before — so a run
 * scored together produces different, and correct, answers compared with the
 * same payments scored in isolation. Callers integrating a backfill or a
 * replay should use this rather than a loop.
 *
 * Payments are processed in the order given. A payment that fails validation
 * is reported in place and does not stop the run, because a backfill of ten
 * thousand rows should not be lost to one bad row.
 */

/** Ceiling per request, so one call cannot monopolise a serverless instance. */
const MAX_BATCH = 5_000;

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const items = Array.isArray(body)
    ? body
    : Array.isArray((body as { transactions?: unknown })?.transactions)
      ? ((body as { transactions: unknown[] }).transactions)
      : null;

  if (!items) {
    return NextResponse.json(
      { error: 'Body must be an array of transactions, or an object with a "transactions" array.' },
      { status: 400 },
    );
  }
  if (items.length === 0) {
    return NextResponse.json({ error: 'No transactions supplied.' }, { status: 400 });
  }
  if (items.length > MAX_BATCH) {
    return NextResponse.json(
      { error: `At most ${MAX_BATCH} transactions per request; ${items.length} were sent.` },
      { status: 413 },
    );
  }

  const engine = getServerEngine();
  const results: unknown[] = [];
  const problems: Array<{ index: number; problems: string[] }> = [];
  let authorised = 0;

  for (let i = 0; i < items.length; i++) {
    const parsed = parseTransaction(items[i]);
    if (parsed.problems.length > 0) {
      problems.push({ index: i, problems: parsed.problems });
      results.push(null);
      continue;
    }
    try {
      const result = engine.authorize(parsed.txn);
      const a = result.assessment;
      authorised += 1;
      results.push({
        txnId: a.txnId,
        decision: a.decision,
        calibratedP: a.calibratedP,
        reasonCodes: a.reasonCodes,
        holdId: result.hold?.holdId ?? null,
        linkedTo: result.linkedTo?.holdId ?? null,
        ledgerSeq: result.ledgerSeq,
      });
    } catch (error) {
      problems.push({ index: i, problems: [error instanceof Error ? error.message : String(error)] });
      results.push(null);
    }
  }

  const counts = { APPROVE: 0, STEP_UP: 0, BLOCK: 0 } as Record<string, number>;
  for (const r of results) {
    const d = (r as { decision?: string } | null)?.decision;
    if (d) counts[d] = (counts[d] ?? 0) + 1;
  }

  return NextResponse.json({
    submitted: items.length,
    authorised,
    rejected: problems.length,
    counts,
    results,
    problems,
    ledger: { head: engine.store.ledger.head },
  });
}

/** GET documents the shape, so an integrator can start from something that runs. */
export async function GET(): Promise<Response> {
  return NextResponse.json({
    usage:
      'POST an array of transactions, or {"transactions": [...]}, to authorise them as one ordered run. ' +
      'Each element takes the same shape as the body of POST /api/v1/authorize, which returns an example.',
    maxPerRequest: MAX_BATCH,
    ordering: 'Payments are scored in the order given; profiles, structuring windows and holds carry forward.',
  });
}
