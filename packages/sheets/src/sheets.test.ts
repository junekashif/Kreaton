import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TokenSource, credentialsFromJson, signAssertion } from './auth.js';
import { SheetsClient, SheetsError } from './client.js';
import { GoogleSheetsSink, HEADERS, TABS } from './sink.js';
import type { HoldRecord, LedgerRecord, Millis, Paise } from '@kreaton/core';

/**
 * Everything here runs against a fake transport.
 *
 * No credentials and no network are involved, so the tests exercise what this
 * package is actually responsible for — the shape of the requests, the
 * batching, and the promise that a failure never reaches the engine — rather
 * than Google's availability.
 */

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const CREDENTIALS = { clientEmail: 'kreaton@example.iam.gserviceaccount.com', privateKey };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A stand-in for the Sheets API that records what it was asked to do. */
function fakeGoogle(
  options: { tabs?: string[]; contents?: Record<string, string[][]>; fail?: (call: Call) => number | null } = {},
) {
  const calls: Call[] = [];
  const deletions: Array<{ sheetId: number; dimension: string; startIndex: number; endIndex: number }> = [];
  let tabs = options.tabs ?? [];

  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
    const call: Call = { url, method: init.method ?? 'GET', body };
    calls.push(call);

    const forcedStatus = options.fail?.(call) ?? null;
    if (forcedStatus !== null) {
      return new Response('nope', { status: forcedStatus });
    }

    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'tok_test', expires_in: 3600 });
    }
    if (url.includes(':batchUpdate')) {
      for (const r of (body as {
        requests: Array<{
          addSheet?: { properties: { title: string } };
          deleteDimension?: { range: { sheetId: number; dimension: string; startIndex: number; endIndex: number } };
        }>;
      }).requests) {
        if (r.addSheet) tabs.push(r.addSheet.properties.title);
        if (r.deleteDimension) deletions.push(r.deleteDimension.range);
      }
      return Response.json({});
    }
    if (url.includes(':append')) {
      const rows = (body as { values: unknown[][] }).values;
      return Response.json({ updates: { updatedRows: rows.length } });
    }
    if (url.includes('/values/')) {
      const tab = decodeURIComponent(/values\/([^!]+)!/.exec(url)?.[1] ?? '');
      return Response.json({ values: options.contents?.[tab] ?? [] });
    }
    return Response.json({
      sheets: tabs.map((title, i) => ({ properties: { title, sheetId: 100 + i, gridProperties: { rowCount: 1000 } } })),
    });
  };

  return {
    fetcher,
    calls,
    deletions,
    get tabs() {
      return tabs;
    },
    appends: () => calls.filter((c) => c.url.includes(':append')),
    tokenCalls: () => calls.filter((c) => c.url.includes('oauth2.googleapis.com')),
    reset: () => {
      calls.length = 0;
      tabs = options.tabs ?? [];
    },
  };
}

/**
 * A ledger record shaped the way the engine actually emits one.
 *
 * An earlier version of this fixture invented a flat entry with `txnId`,
 * `decision` and `calibratedP` at the top level. No arm of `LedgerEntry` looks
 * like that: on an ASSESSMENT they sit under `assessment`. The tests passed
 * and the real ledger tab came out with four empty columns, which is the one
 * defect a fake transport will happily hide. Fixtures here are built from the
 * real union.
 */
const ledgerRecord = (seq: number, decision = 'BLOCK'): LedgerRecord =>
  ({
    seq,
    ts: (1_700_000_000_000 + seq) as Millis,
    prevHash: 'p'.repeat(64),
    hash: 'h'.repeat(64),
    entry: {
      kind: 'ASSESSMENT',
      txn: { txnId: `t${seq}`, ts: 1_700_000_000_000, amountPaise: 150_000, payeeName: 'A PAYEE', channel: 'p2p', deviceId: 'd1' },
      assessment: {
        txnId: `t${seq}`,
        decision,
        calibratedP: 0.97,
        reasonCodes: ['APP-CAL-4', 'APP-NOV-0'],
      },
      policy: {},
    },
  }) as unknown as LedgerRecord;

const holdOpenedRecord = (seq: number): LedgerRecord =>
  ({
    seq,
    ts: (1_700_000_000_000 + seq) as Millis,
    prevHash: 'p'.repeat(64),
    hash: 'h'.repeat(64),
    entry: {
      kind: 'HOLD_OPENED',
      holdId: 'h_1',
      txnId: `t${seq}`,
      challengeType: 'NAMED_PAYEE_CONFIRMATION',
      rationale: 'because',
      disqualified: [],
      expiresAtMs: 1_700_000_100_000,
    },
  }) as unknown as LedgerRecord;

const modelLoadedRecord = (): LedgerRecord =>
  ({
    seq: 0,
    ts: 1_700_000_000_000 as Millis,
    prevHash: '0'.repeat(64),
    hash: 'm'.repeat(64),
    entry: { kind: 'MODEL_LOADED', version: '1.0.0-kreaton', modelHash: 'abc123', fittedAt: '2026-09-11' },
  }) as unknown as LedgerRecord;

describe('service account authentication', () => {
  it('reads a key file and restores escaped newlines', () => {
    const creds = credentialsFromJson(
      JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'line1\\nline2' }),
    );
    expect(creds.clientEmail).toBe('a@b.iam.gserviceaccount.com');
    expect(creds.privateKey).toBe('line1\nline2');
  });

  it('says which field is missing rather than failing later', () => {
    expect(() => credentialsFromJson('{"client_email":"a@b"}')).toThrow(/private_key/);
    expect(() => credentialsFromJson('{"private_key":"x"}')).toThrow(/client_email/);
  });

  it('signs an assertion with the claims Google requires', () => {
    const jwt = signAssertion(CREDENTIALS, 1_700_000_000);
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const parsed = JSON.parse(Buffer.from(claims!, 'base64url').toString());
    expect(parsed.iss).toBe(CREDENTIALS.clientEmail);
    expect(parsed.aud).toBe('https://oauth2.googleapis.com/token');
    expect(parsed.scope).toBe('https://www.googleapis.com/auth/spreadsheets');
    expect(parsed.exp - parsed.iat).toBe(3600);
    expect(signature!.length).toBeGreaterThan(300);
  });

  it('caches the token instead of exchanging one per request', async () => {
    const google = fakeGoogle();
    let now = 1_700_000_000_000;
    const tokens = new TokenSource(CREDENTIALS, google.fetcher, () => now);
    expect(await tokens.get()).toBe('tok_test');
    await tokens.get();
    await tokens.get();
    expect(google.tokenCalls()).toHaveLength(1);

    // Past the renewal margin it fetches once more, not once per caller.
    now += 3_600_000;
    await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
    expect(google.tokenCalls()).toHaveLength(2);
  });

  it('reports a refused assertion with the status', async () => {
    const google = fakeGoogle({ fail: (c) => (c.url.includes('oauth2') ? 401 : null) });
    const tokens = new TokenSource(CREDENTIALS, google.fetcher);
    await expect(tokens.get()).rejects.toThrow(/401/);
  });
});

describe('the client', () => {
  const client = (google: ReturnType<typeof fakeGoogle>) =>
    new SheetsClient({ credentials: CREDENTIALS, spreadsheetId: 'sheet_1', fetcher: google.fetcher });

  it('creates only the tabs that are missing', async () => {
    const google = fakeGoogle({ tabs: ['ledger'] });
    const created = await client(google).ensureTabs(['ledger', 'holds', 'transactions']);
    expect(created).toEqual(['holds', 'transactions']);
  });

  it('creates nothing when every tab is there', async () => {
    const google = fakeGoogle({ tabs: ['ledger', 'holds'] });
    expect(await client(google).ensureTabs(['ledger', 'holds'])).toEqual([]);
    expect(google.calls.some((c) => c.url.includes(':batchUpdate'))).toBe(false);
  });

  it('appends RAW, so a hash is never reinterpreted as a number or a date', async () => {
    const google = fakeGoogle({ tabs: ['ledger'] });
    await client(google).append('ledger', [['00123', '2026-04-01', '-APP-CAL-4']]);
    const call = google.appends()[0]!;
    expect(call.url).toContain('valueInputOption=RAW');
    expect(call.url).toContain('insertDataOption=INSERT_ROWS');
    expect((call.body as { values: string[][] }).values[0]).toEqual(['00123', '2026-04-01', '-APP-CAL-4']);
  });

  it('escapes the tab name in the range', async () => {
    const google = fakeGoogle();
    await client(google).append('my ledger', [['a']]);
    expect(google.appends()[0]!.url).toContain(encodeURIComponent('my ledger!A1'));
  });

  it('sends no request for an empty batch', async () => {
    const google = fakeGoogle();
    expect(await client(google).append('ledger', [])).toBe(0);
    expect(google.appends()).toHaveLength(0);
  });

  it('truncates by deleting rows below the header, never the header itself', async () => {
    const google = fakeGoogle({
      tabs: ['ledger', 'holds'],
      contents: { ledger: [['seq'], ['1'], ['2'], ['3']] },
    });
    const removed = await client(google).truncate('ledger');
    expect(removed).toBe(3);
    expect(google.deletions).toEqual([{ sheetId: 100, dimension: 'ROWS', startIndex: 1, endIndex: 4 }]);
  });

  it('does nothing to a tab that only has its header', async () => {
    const google = fakeGoogle({ tabs: ['ledger'], contents: { ledger: [['seq']] } });
    expect(await client(google).truncate('ledger')).toBe(0);
    expect(google.deletions).toHaveLength(0);
  });

  it('refuses to truncate a tab that does not exist', async () => {
    const google = fakeGoogle({ tabs: ['ledger'] });
    await expect(client(google).truncate('nope')).rejects.toThrow(/No tab named/);
  });

  it('marks rate limits and server errors retryable, and a bad key not', () => {
    expect(new SheetsError(429, 'x').retryable).toBe(true);
    expect(new SheetsError(503, 'x').retryable).toBe(true);
    expect(new SheetsError(403, 'x').retryable).toBe(false);
    expect(new SheetsError(404, 'x').retryable).toBe(false);
  });
});

describe('the write-behind sink', () => {
  const makeSink = (google: ReturnType<typeof fakeGoogle>, opts: Record<string, unknown> = {}) =>
    new GoogleSheetsSink({
      credentials: CREDENTIALS,
      spreadsheetId: 'sheet_1',
      fetcher: google.fetcher,
      onError: () => {},
      ...opts,
    });

  it('writes a header row into each tab it creates', async () => {
    const google = fakeGoogle();
    const sink = makeSink(google);
    await sink.start();
    const headers = google.appends().map((c) => (c.body as { values: string[][] }).values[0]);
    expect(headers).toContainEqual([...HEADERS[TABS.ledger]!]);
    expect(headers).toContainEqual([...HEADERS[TABS.holds]!]);
    await sink.close();
  });

  it('buffers rather than sending one request per payment', async () => {
    const google = fakeGoogle({ tabs: Object.values(TABS) });
    const sink = makeSink(google, { maxBufferedRows: 1000 });
    await sink.start();
    google.reset();

    for (let i = 0; i < 200; i++) sink.onLedgerRecord(ledgerRecord(i));
    expect(google.appends()).toHaveLength(0);
    expect(sink.stats().buffered).toBe(200);

    await sink.flush();
    expect(google.appends()).toHaveLength(1);
    expect((google.appends()[0]!.body as { values: unknown[][] }).values).toHaveLength(200);
    expect(sink.stats().written).toBe(200);
    await sink.close();
  });

  it('flushes on its own once the buffer fills', async () => {
    const google = fakeGoogle({ tabs: Object.values(TABS) });
    const sink = makeSink(google, { maxBufferedRows: 50 });
    await sink.start();
    for (let i = 0; i < 50; i++) sink.onLedgerRecord(ledgerRecord(i));
    await sink.flush();
    expect(sink.stats().written).toBe(50);
    await sink.close();
  });

  it('reads an assessment out of the nested entry, not off the top level', async () => {
    const google = fakeGoogle({ tabs: Object.values(TABS) });
    const sink = makeSink(google);
    await sink.start();
    google.reset();
    sink.onLedgerRecord(ledgerRecord(7));
    await sink.flush();
    const row = (google.appends()[0]!.body as { values: unknown[][] }).values[0]!;
    expect(row[0]).toBe(7);
    expect(row[2]).toBe('ASSESSMENT');
    // These four are the columns that silently came out empty in production
    // when they were read straight off the entry.
    expect(row[3]).toBe('t7');
    expect(row[4]).toBe('BLOCK');
    expect(row[5]).toBe(0.97);
    expect(row[6]).toBe('APP-CAL-4 APP-NOV-0');
    expect(row[8]).toBe('h'.repeat(64));
    await sink.close();
  });

  it('summarises every other kind of ledger entry too', async () => {
    const google = fakeGoogle({ tabs: Object.values(TABS) });
    const sink = makeSink(google);
    await sink.start();
    google.reset();
    sink.onLedgerRecord(holdOpenedRecord(4));
    sink.onLedgerRecord(modelLoadedRecord());
    await sink.flush();
    const rows = (google.appends()[0]!.body as { values: unknown[][] }).values;

    const hold = rows[0]!;
    expect(hold[2]).toBe('HOLD_OPENED');
    expect(hold[3]).toBe('t4');
    expect(hold[4]).toBe('NAMED_PAYEE_CONFIRMATION');
    expect(hold[6]).toBe('h_1');

    const model = rows[1]!;
    expect(model[2]).toBe('MODEL_LOADED');
    expect(model[3]).toBe('');
    expect(model[4]).toBe('1.0.0-kreaton');
    // No probability belongs on a non-decision entry, and an empty cell is the
    // honest rendering of that rather than a zero.
    expect(model[5]).toBe('');
    await sink.close();
  });

  it('never lets a failure reach the caller', async () => {
    const google = fakeGoogle({ tabs: Object.values(TABS), fail: (c) => (c.url.includes(':append') ? 500 : null) });
    const onError = vi.fn();
    const sink = makeSink(google, { onError });

    // Every sink method is called on the decision path; none may throw.
    expect(() => sink.onLedgerRecord(ledgerRecord(1))).not.toThrow();
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
    expect(sink.stats().failed).toBeGreaterThan(0);
    await sink.close();
  });

  it('keeps rows after a rate limit and lets them go after a permanent refusal', async () => {
    const rateLimited = fakeGoogle({ tabs: Object.values(TABS), fail: (c) => (c.url.includes(':append') ? 429 : null) });
    const a = makeSink(rateLimited);
    await a.start();
    a.onLedgerRecord(ledgerRecord(1));
    await a.flush();
    expect(a.stats().buffered).toBe(1);
    expect(a.stats().dropped).toBe(0);
    await a.close();

    // 403 is what a sheet not shared with the service account returns; it
    // would fail identically forever, so the rows are not held.
    const refused = fakeGoogle({ tabs: Object.values(TABS), fail: (c) => (c.url.includes(':append') ? 403 : null) });
    const b = makeSink(refused);
    await b.start();
    b.onLedgerRecord(ledgerRecord(1));
    await b.flush();
    expect(b.stats().buffered).toBe(0);
    expect(b.stats().dropped).toBe(1);
    await b.close();
  });

  it('bounds memory when the network is gone for a long time', async () => {
    const google = fakeGoogle({ tabs: Object.values(TABS) });
    const sink = makeSink(google, { maxQueuedRows: 100, maxBufferedRows: 10_000 });
    await sink.start();
    for (let i = 0; i < 500; i++) sink.onLedgerRecord(ledgerRecord(i));
    expect(sink.stats().buffered).toBeLessThanOrEqual(100);
    expect(sink.stats().dropped).toBeGreaterThan(0);
    await sink.close();
  });

  it('does not spend the quota on profile churn', async () => {
    const google = fakeGoogle({ tabs: Object.values(TABS) });
    const sink = makeSink(google);
    await sink.start();
    google.reset();
    sink.onPayer({ payerId: 'p1' } as never);
    sink.onPayee({ payeeId: 'e1' } as never);
    await sink.flush();
    expect(google.appends()).toHaveLength(0);
    await sink.close();
  });

  it('records a hold with its linked re-attempts', async () => {
    const google = fakeGoogle({ tabs: Object.values(TABS) });
    const sink = makeSink(google);
    await sink.start();
    google.reset();
    sink.onHold({
      holdId: 'h1',
      txnId: 't1',
      payerId: 'p1',
      payeeId: 'e1',
      amountPaise: 150_000 as Paise,
      state: 'OPEN',
      challengeType: 'NAMED_PAYEE_CONFIRMATION',
      openedAtMs: 1 as Millis,
      expiresAtMs: 2 as Millis,
      resolvedAtMs: null,
      attemptsUsed: 1,
      attemptBudget: 2,
      linkedAttempts: ['t2', 't3'],
      timeline: [],
    } as unknown as HoldRecord);
    await sink.flush();
    const row = (google.appends()[0]!.body as { values: unknown[][] }).values[0]!;
    expect(row[0]).toBe('h1');
    expect(row[9]).toBe('');
    expect(row[12]).toBe('t2 t3');
    await sink.close();
  });

  it('can be told not to copy the payments themselves', async () => {
    const google = fakeGoogle({ tabs: Object.values(TABS) });
    const sink = makeSink(google, { writeTransactions: false });
    await sink.start();
    google.reset();
    sink.onTransaction({ txnId: 't1', context: {} } as never);
    await sink.flush();
    expect(google.appends()).toHaveLength(0);
    await sink.close();
  });
});
