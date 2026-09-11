import type {
  LabelledTransaction,
  Millis,
  ModelSpec,
  Paise,
  PayeeProfile,
  PayerProfile,
} from '@kreaton/core';

/**
 * Shape of the slice the seed script writes to public/data/slice.json.
 *
 * Kept in step with packages/sim/src/scripts/seed.ts by hand: the slice is a
 * committed artefact rather than a live API, so a type mismatch shows up at
 * build time in the console rather than at runtime in a browser.
 */

export interface SlicePayee {
  payeeId: string;
  name: string;
  kind: 'merchant' | 'personal' | 'mule';
  outboundVelocityRatio: number;
  firstSeenMs: Millis;
  chainId: string | null;
  layer: number | null;
}

export interface IntelEvent {
  ts: Millis;
  payeeId: string;
  chainId: string;
  hopDistance: number;
}

export interface WarmState {
  payers: Array<Omit<PayerProfile, 'hourHistogram'>>;
  payees: PayeeProfile[];
  recentTxns: Array<{ payerId: string; ts: Millis; amountPaise: Paise }>;
}

export interface Slice {
  generatedAt: string;
  modelVersion: string;
  note: string;
  windowFromMs: Millis;
  windowToMs: Millis;
  transactions: LabelledTransaction[];
  payees: SlicePayee[];
  intel: IntelEvent[];
  warm: WarmState;
}

export interface LoadedData {
  model: ModelSpec;
  slice: Slice;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export async function loadData(): Promise<LoadedData> {
  const [model, slice] = await Promise.all([
    fetchJson<ModelSpec>('/data/model.json'),
    fetchJson<Slice>('/data/slice.json'),
  ]);
  return { model, slice };
}
