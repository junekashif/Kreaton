import { NextResponse } from 'next/server';
import { DEFAULT_POLICY, Interceptor, MemoryStore, RecoveryModel, refreshPayeeWindow } from '@kreaton/core';
import type { Millis } from '@kreaton/core';
import { buildDataset, detectMapping, readSource } from '@kreaton/ingest';
import type { Mapping } from '@kreaton/ingest';
import { MODEL } from '../../../../lib/artefacts';

/**
 * POST /api/v1/import
 *
 * Put a delimited or JSON dataset through the engine without a browser.
 *
 * Two things are on offer and they are separable. Sent without `authorize`,
 * this answers "what would you make of this file" — the proposed column
 * mapping, and the report of everything the file cannot supply — which is the
 * cheap way for an integrator to find out that their export has no session
 * context before they build anything around it. Sent with `authorize`, it
 * replays the file and returns what the engine decided.
 *
 * The replay runs on a scratch engine, never the one behind
 * /api/v1/authorize. A file sent here to be understood must not leave its
 * payers, its beneficiaries or its ledger entries behind in the live one.
 */

/** Ceiling per request. The command-line importer has no such limit. */
const MAX_ROWS = 20_000;

interface ImportRequest {
  /** The file contents. */
  text?: string;
  format?: 'delimited' | 'json';
  delimiter?: ',' | '\t' | ';' | '|';
  /** Column bindings. Omit to use the mapping detected from the header. */
  mapping?: Mapping;
  /** Replay the file and return decisions. */
  authorize?: boolean;
  /** Cap the rows read. */
  limit?: number;
}

export async function POST(request: Request): Promise<Response> {
  let body: ImportRequest;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    body = parsed as ImportRequest;
  } catch {
    return NextResponse.json({ error: 'Body must be a JSON object.' }, { status: 400 });
  }

  if (typeof body.text !== 'string' || body.text.trim() === '') {
    return NextResponse.json({ error: 'Supply the file contents as a "text" string.' }, { status: 400 });
  }

  const limit = Math.min(Math.max(1, body.limit ?? MAX_ROWS), MAX_ROWS);

  let source;
  try {
    source = readSource(body.text, {
      ...(body.format ? { format: body.format } : {}),
      ...(body.delimiter ? { delimiter: body.delimiter } : {}),
      limit,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'The file could not be read.', detail: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }

  if (source.header.length === 0) {
    return NextResponse.json(
      { error: 'No column headings were found. The first row should name the columns.' },
      { status: 400 },
    );
  }

  const detected = detectMapping(source.header);
  const mapping = body.mapping ?? detected.mapping;
  const dataset = buildDataset(source.rows, mapping, { baseMs: Date.now() as Millis, limit });

  const base = {
    columns: source.header,
    format: source.format,
    ...(source.delimiter ? { delimiter: source.delimiter } : {}),
    detectedPreset: detected.preset?.id ?? null,
    mapping,
    unmatchedColumns: detected.unmatched,
    report: dataset.report,
  };

  if (!body.authorize) {
    return NextResponse.json({
      ...base,
      note: 'Nothing was scored. Send authorize: true to replay the file and get decisions back.',
    });
  }

  // A scratch engine, discarded when the request ends.
  const store = new MemoryStore();
  const engine = new Interceptor({
    model: MODEL,
    policy: DEFAULT_POLICY,
    store,
    recovery: new RecoveryModel({
      params: MODEL.recovery,
      freezeLatencyMinutes: DEFAULT_POLICY.freezeLatencyMinutes,
      seed: 'import',
    }),
  });

  const attributes = new Map(dataset.payees.map((p) => [p.payeeId, p]));
  const confirmedFrom = new Map(dataset.intel.map((e) => [e.payeeId, e.ts]));
  const counts: Record<string, number> = { APPROVE: 0, STEP_UP: 0, BLOCK: 0 };
  const decisions: unknown[] = [];
  let caught = 0;
  let falsePositives = 0;

  for (const txn of dataset.transactions) {
    const attrs = attributes.get(txn.payeeId);
    const existing = store.ensurePayee(txn.payeeId, txn.payeeVpa, txn.ts);
    const confirmedAt = confirmedFrom.get(txn.payeeId);
    store.putPayee({
      ...refreshPayeeWindow(existing, txn.ts),
      firstSeenMs: attrs?.firstSeenMs ?? existing.firstSeenMs,
      outboundVelocityRatio: attrs?.outboundVelocityRatio ?? existing.outboundVelocityRatio,
      // Intelligence is released at the timestamp it was asserted, never before.
      confirmedMule: existing.confirmedMule || (confirmedAt !== undefined && confirmedAt <= txn.ts),
    });

    const observed = dataset.balanceBefore[txn.txnId];
    if (observed !== undefined && observed > 0) {
      const payer = store.ensurePayer(txn.payerId, txn.ts);
      store.putPayer({ ...payer, observedBalancePaise: observed, balanceProxyPaise: observed });
    }

    const result = engine.authorize(txn);
    const a = result.assessment;
    counts[a.decision] = (counts[a.decision] ?? 0) + 1;
    const intervened = a.decision !== 'APPROVE';
    if (txn.label.isFraud && intervened) caught += 1;
    if (!txn.label.isFraud && intervened) falsePositives += 1;
    decisions.push({
      txnId: a.txnId,
      ts: txn.ts,
      payerId: txn.payerId,
      payeeId: txn.payeeId,
      amountPaise: txn.amountPaise,
      decision: a.decision,
      calibratedP: a.calibratedP,
      reasonCodes: a.reasonCodes,
      ...(dataset.report.labelled ? { isFraud: txn.label.isFraud } : {}),
    });
  }

  const fraud = dataset.report.fraudCount;
  const genuine = dataset.transactions.length - fraud;

  return NextResponse.json({
    ...base,
    counts,
    decisions,
    // Accuracy is reported only when the file said what the truth was. An
    // unlabelled file gets decisions and nothing that looks like a score.
    accuracy: dataset.report.labelled
      ? {
          fraud,
          genuine,
          caught,
          detectionRate: fraud > 0 ? caught / fraud : null,
          falsePositives,
          falsePositiveRate: genuine > 0 ? falsePositives / genuine : null,
          caveat:
            'Measured on the file as supplied. Where it carries no session context the engine is in the ' +
            'suppressed-indicator position described in the import report, and these figures are a floor.',
        }
      : null,
    model: { version: MODEL.version, fittedAt: MODEL.fittedAt },
    ledgerHead: store.ledger.head,
  });
}

/** GET documents the request shape and what comes back. */
export async function GET(): Promise<Response> {
  return NextResponse.json({
    usage: 'POST a file as {"text": "...csv or json..."} to have its columns matched and reported on.',
    fields: {
      text: 'Required. The file contents.',
      format: 'Optional. "delimited" or "json". Sniffed from the first character otherwise.',
      delimiter: 'Optional. Sniffed from the header otherwise.',
      mapping: 'Optional. Field path to {column, unit, mode}. The detected mapping is returned, so a caller can adjust and resend it.',
      authorize: 'Optional. When true the file is replayed on a scratch engine and decisions are returned.',
      limit: `Optional. Rows to read, up to ${MAX_ROWS}.`,
    },
    example: {
      text: 'date,payer,payee,payee_name,amount,is_fraud\n2026-04-01,ravi.k,shop1,SHREE KIRANA,480,0\n',
      authorize: true,
    },
  });
}
