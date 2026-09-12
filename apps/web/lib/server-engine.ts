import { DEFAULT_POLICY, Interceptor, MemoryStore, RecoveryModel } from '@kreaton/core';
import type { PersistenceSink, Transaction } from '@kreaton/core';
import { GoogleSheetsSink, credentialsFromJson } from '@kreaton/sheets';
import { MODEL } from './artefacts';

/**
 * The production-shaped authorisation engine behind /api/v1/authorize.
 *
 * Same compiled engine as the console, same committed model. State lives in
 * memory for the life of the process: on a serverless platform that means per
 * instance and per warm period, which is the documented first phase of the
 * persistence plan. The Store interface is what a durable backing implements;
 * nothing in the route depends on which one is in use.
 */

const globalRef = globalThis as unknown as {
  __kreatonEngine?: Interceptor;
  __kreatonSink?: GoogleSheetsSink | null;
};

/**
 * The durable sink, when this deployment has been given one.
 *
 * Two environment variables turn it on, and their absence is the normal case:
 * without them the engine behaves exactly as before, with its state in memory
 * for the life of the instance. docs/PERSISTENCE.md has the setup.
 *
 *   KREATON_SHEETS_ID              the spreadsheet id from its URL
 *   KREATON_SERVICE_ACCOUNT_JSON   the service account key file, as JSON
 *
 * Construction is deliberately tolerant. A malformed key should leave the
 * interceptor running and unpersisted, with a line in the log, rather than
 * taking the authorisation endpoint down with it.
 */
function buildSink(): GoogleSheetsSink | null {
  const spreadsheetId = process.env.KREATON_SHEETS_ID;
  const key = process.env.KREATON_SERVICE_ACCOUNT_JSON;
  if (!spreadsheetId || !key) return null;
  try {
    const sink = new GoogleSheetsSink({
      credentials: credentialsFromJson(key),
      spreadsheetId,
      flushIntervalMs: Number(process.env.KREATON_SHEETS_FLUSH_MS ?? 5_000),
    });
    // Create the tabs up front so the first decision is not also the first
    // schema change. A failure here is logged by the sink and retried later.
    void sink.start().catch(() => {});
    return sink;
  } catch (error) {
    console.error('[kreaton] Sheets persistence is configured but unusable:', error);
    return null;
  }
}

/** The sink in force, or null when this deployment has none. */
export function getSink(): GoogleSheetsSink | null {
  if (globalRef.__kreatonSink === undefined) globalRef.__kreatonSink = buildSink();
  return globalRef.__kreatonSink;
}

export function getServerEngine(): Interceptor {
  if (!globalRef.__kreatonEngine) {
    const sink = getSink() as PersistenceSink | null;
    globalRef.__kreatonEngine = new Interceptor({
      model: MODEL,
      policy: DEFAULT_POLICY,
      store: new MemoryStore(sink ?? undefined),
      recovery: new RecoveryModel({
        params: MODEL.recovery,
        freezeLatencyMinutes: DEFAULT_POLICY.freezeLatencyMinutes,
        seed: 'server',
      }),
    });
  }
  return globalRef.__kreatonEngine;
}

const ENTRY_METHODS = new Set(['typed', 'pasted', 'qr', 'contact', 'deeplink']);
const CHANNELS = new Set(['p2p', 'p2m', 'collect']);

/**
 * Validate an inbound payload into a Transaction.
 *
 * Returns a list of problems rather than throwing on the first, because a
 * caller integrating against the endpoint wants every field named at once.
 */
export function parseTransaction(input: unknown): { txn: Transaction; problems: string[] } {
  const problems: string[] = [];
  const o = (input ?? {}) as Record<string, unknown>;
  const c = (o.context ?? {}) as Record<string, unknown>;

  const str = (obj: Record<string, unknown>, key: string, required = true): string => {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (required) problems.push(`${key} must be a non-empty string`);
    return '';
  };
  const num = (obj: Record<string, unknown>, key: string, opts: { int?: boolean; min?: number } = {}): number => {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v) && (!opts.int || Number.isInteger(v)) && (opts.min === undefined || v >= opts.min)) {
      return v;
    }
    problems.push(`${key} must be a ${opts.int ? 'integer' : 'number'}${opts.min !== undefined ? ` >= ${opts.min}` : ''}`);
    return 0;
  };
  const bool = (obj: Record<string, unknown>, key: string): boolean => {
    const v = obj[key];
    if (typeof v === 'boolean') return v;
    problems.push(`context.${key} must be a boolean`);
    return false;
  };

  const channel = str(o, 'channel');
  if (channel && !CHANNELS.has(channel)) problems.push('channel must be p2p, p2m or collect');
  const entry = str(c, 'vpaEnteredBy');
  if (entry && !ENTRY_METHODS.has(entry)) problems.push('context.vpaEnteredBy must be typed, pasted, qr, contact or deeplink');

  const addedAt = c.beneficiaryAddedAtMs;
  if (addedAt !== null && addedAt !== undefined && typeof addedAt !== 'number') {
    problems.push('context.beneficiaryAddedAtMs must be a number or null');
  }

  const txn: Transaction = {
    txnId: str(o, 'txnId'),
    ts: num(o, 'ts', { int: true, min: 0 }),
    payerId: str(o, 'payerId'),
    payerVpa: str(o, 'payerVpa'),
    payeeId: str(o, 'payeeId'),
    payeeVpa: str(o, 'payeeVpa'),
    payeeName: str(o, 'payeeName'),
    amountPaise: num(o, 'amountPaise', { int: true, min: 1 }),
    channel: (channel || 'p2p') as Transaction['channel'],
    deviceId: str(o, 'deviceId'),
    ipHash: str(o, 'ipHash', false) || 'unknown',
    simSerialHash: str(o, 'simSerialHash', false) || 'unknown',
    note: typeof o.note === 'string' ? o.note : undefined,
    context: {
      activeCall: bool(c, 'activeCall'),
      activeCallSeconds: typeof c.activeCallSeconds === 'number' ? c.activeCallSeconds : 0,
      screenShareActive: bool(c, 'screenShareActive'),
      remoteAccessAppRunning: bool(c, 'remoteAccessAppRunning'),
      appSwitchCount: typeof c.appSwitchCount === 'number' ? c.appSwitchCount : 0,
      secondsFromOpenToAuthorize: typeof c.secondsFromOpenToAuthorize === 'number' ? c.secondsFromOpenToAuthorize : 30,
      vpaEnteredBy: (entry || 'typed') as Transaction['context']['vpaEnteredBy'],
      beneficiaryAddedAtMs: typeof addedAt === 'number' ? addedAt : null,
      sessionId: str(c, 'sessionId', false) || 'unknown',
      isNewDevice: bool(c, 'isNewDevice'),
      deviceBoundAtMs: typeof c.deviceBoundAtMs === 'number' ? c.deviceBoundAtMs : 0,
      simChangedRecently: bool(c, 'simChangedRecently'),
      foregroundApp: typeof c.foregroundApp === 'string' ? c.foregroundApp : undefined,
    },
  };

  return { txn, problems };
}

/** A complete, valid request body, returned by GET for integrators. */
export function exampleTransaction(): Transaction {
  const now = Date.now();
  return {
    txnId: `txn_${now}`,
    ts: now,
    payerId: 'payer_demo_001',
    payerVpa: 'ravi.k@okhdfcbank',
    payeeId: 'payee_new_9f2',
    payeeVpa: 'verify.cell@okaxis',
    payeeName: 'CYBER CELL VERIFICATION',
    amountPaise: 18_500_000,
    channel: 'p2p',
    deviceId: 'dev_ravi_primary',
    ipHash: 'ip_3a9c',
    simSerialHash: 'sim_77b1',
    context: {
      activeCall: true,
      activeCallSeconds: 2_700,
      screenShareActive: false,
      remoteAccessAppRunning: false,
      appSwitchCount: 5,
      secondsFromOpenToAuthorize: 14,
      vpaEnteredBy: 'pasted',
      beneficiaryAddedAtMs: null,
      sessionId: 'sess_demo',
      isNewDevice: false,
      deviceBoundAtMs: now - 400 * 86_400_000,
      simChangedRecently: false,
    },
  };
}
