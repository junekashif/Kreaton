import { formatINR, formatINRCompact } from '@kreaton/core';
import type { Action, Paise } from '@kreaton/core';

export { formatINR, formatINRCompact };

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

/** Probability for display. Small values keep enough digits to be legible. */
export function prob(p: number): string {
  if (p >= 0.1) return `${(p * 100).toFixed(1)}%`;
  if (p >= 0.01) return `${(p * 100).toFixed(2)}%`;
  if (p >= 0.001) return `${(p * 100).toFixed(3)}%`;
  if (p >= 0.00001) return `${(p * 100).toFixed(4)}%`;
  return '<0.001%';
}

export function signed(x: number, digits = 2): string {
  const s = x.toFixed(digits);
  return x > 0 ? `+${s}` : s;
}

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** HH:MM:SS in Indian Standard Time, which is where the payments happen. */
export function istClock(ts: number): string {
  const d = new Date(ts + IST_OFFSET_MS);
  return d.toISOString().slice(11, 19);
}

export function istDate(ts: number): string {
  const d = new Date(ts + IST_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

export function istDateTime(ts: number): string {
  return `${istDate(ts)} ${istClock(ts)} IST`;
}

export function minutes(ms: number): string {
  const m = ms / 60_000;
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 90) return `${m.toFixed(0)} min`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

export function rupeesShort(p: Paise): string {
  return formatINRCompact(p);
}

export const ACTION_LABEL: Record<Action, string> = {
  APPROVE: 'Approve',
  STEP_UP: 'Hold',
  BLOCK: 'Block',
};

export function shortId(id: string, keep = 10): string {
  return id.length <= keep ? id : `${id.slice(0, keep)}…`;
}

export function withCommas(n: number): string {
  return n.toLocaleString('en-IN');
}
