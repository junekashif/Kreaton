'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { getSession } from './session';
import type { ConsoleSession, SessionSnapshot } from './session';

const SERVER_SNAPSHOT: SessionSnapshot = {
  status: 'idle',
  error: null,
  model: null,
  slice: null,
  cursor: 0,
  total: 0,
  playing: false,
  speed: 6,
  decisions: [],
  policy: null as unknown as SessionSnapshot['policy'],
  policyId: 'balanced',
  policyHash: '',
  selectedTxnId: null,
  clockMs: 0,
  version: -1,
};

/** Subscribe a component to the engine session, loading data on first use. */
export function useSession(): { snap: SessionSnapshot; session: ConsoleSession } {
  const session = getSession();
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot, () => SERVER_SNAPSHOT);
  useEffect(() => {
    void session.ensureLoaded();
  }, [session]);
  return { snap, session };
}
