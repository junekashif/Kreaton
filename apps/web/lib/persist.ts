'use client';

import type { ImportedDataset } from '@kreaton/ingest';

/**
 * Local persistence for the console session.
 *
 * The engine holds its working state in memory, which is what makes an
 * authorisation take microseconds, and that state has always been lost on a
 * full page reload. For the shipped corpus that costs nothing — it is a
 * committed file, refetched in a moment. For a dataset the operator supplied
 * it costs them their file, and having to find and re-map it after an
 * accidental refresh is the kind of small cruelty that makes a tool feel
 * unfinished.
 *
 * So the imported dataset is kept in IndexedDB, on this device, in this
 * browser. Not the engine state: that is derived, and replaying the file is
 * deterministic, so restoring the file and the cursor reproduces exactly the
 * state that was lost, for far less complexity than serialising profiles,
 * holds and a hash chain would take.
 *
 * IndexedDB rather than localStorage because a dataset is megabytes and
 * localStorage is both small and synchronous. Every operation here resolves
 * rather than rejects: private browsing, cleared site data and disabled
 * storage are all normal, and none of them is a reason for the console to
 * fail to start.
 */

const DB_NAME = 'kreaton';
const DB_VERSION = 1;
const STORE = 'session';
const KEY = 'imported';

export interface SavedSession {
  name: string;
  dataset: ImportedDataset;
  /** How far through the file the operator had replayed. */
  cursor: number;
  policyId: string;
  savedAtMs: number;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // A blocked upgrade means another tab holds an older version open. Rather
    // than wait indefinitely, carry on without persistence.
    request.onblocked = () => resolve(null);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
  fallback: T,
): Promise<T> {
  const db = await openDb();
  if (!db) return fallback;
  return new Promise<T>((resolve) => {
    let request: IDBRequest;
    try {
      request = fn(db.transaction(STORE, mode).objectStore(STORE));
    } catch {
      db.close();
      resolve(fallback);
      return;
    }
    request.onsuccess = () => {
      db.close();
      resolve((request.result as T) ?? fallback);
    };
    request.onerror = () => {
      db.close();
      resolve(fallback);
    };
  });
}

/** Keep the imported dataset for the next visit. Never throws. */
export async function saveSession(session: SavedSession): Promise<void> {
  await withStore('readwrite', (store) => store.put(session, KEY), undefined);
}

/** The dataset saved by a previous visit, if there is one. */
export async function loadSession(): Promise<SavedSession | null> {
  const saved = await withStore<SavedSession | null>('readonly', (store) => store.get(KEY), null);
  if (!saved || typeof saved !== 'object') return null;
  // A stored shape from an older build is not worth migrating; drop it.
  if (!Array.isArray(saved.dataset?.transactions) || saved.dataset.transactions.length === 0) {
    void clearSession();
    return null;
  }
  return saved;
}

/** Forget the imported dataset. */
export async function clearSession(): Promise<void> {
  await withStore('readwrite', (store) => store.delete(KEY), undefined);
}

/** Whether this browser will keep anything at all. */
export function persistenceAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}
