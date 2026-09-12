/**
 * Turning spreadsheet cells into typed values.
 *
 * Every function here returns a value and a note rather than throwing. An
 * import of fifty thousand rows with four bad dates should report the four,
 * not fail on the first, and the operator should be told which convention was
 * assumed when a cell was ambiguous.
 */

import { PAISE_PER_RUPEE } from '@kreaton/core';
import type { Millis, Paise } from '@kreaton/core';

export interface Coerced<T> {
  ok: boolean;
  value: T;
  /** Set when the cell could not be read, or was read under an assumption. */
  note?: string;
}

const TRUE_WORDS = new Set(['1', 'true', 't', 'yes', 'y', 'fraud', 'debit', 'dr', 'on', 'active']);
const FALSE_WORDS = new Set(['0', 'false', 'f', 'no', 'n', 'legit', 'legitimate', 'genuine', 'credit', 'cr', 'off', 'inactive', '']);

export function coerceBoolean(raw: string): Coerced<boolean> {
  const v = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(v)) return { ok: true, value: true };
  if (FALSE_WORDS.has(v)) return { ok: true, value: false };
  const n = Number(v);
  if (Number.isFinite(n)) return { ok: true, value: n !== 0 };
  return { ok: false, value: false, note: `"${raw}" is not a yes/no value` };
}

export function coerceNumber(raw: string): Coerced<number> {
  const v = raw.trim();
  if (v === '') return { ok: false, value: 0, note: 'empty' };
  const n = Number(v.replace(/[,\s]/g, ''));
  if (!Number.isFinite(n)) return { ok: false, value: 0, note: `"${raw}" is not a number` };
  return { ok: true, value: n };
}

/** How the amount column should be read. */
export type AmountUnit = 'rupees' | 'paise';

/**
 * Read a money column.
 *
 * Handles the shapes exports actually use: thousands separators in either the
 * Indian or the Western grouping, a leading currency symbol or code, a
 * trailing Dr/Cr marker, and accounting parentheses for negatives. The sign is
 * discarded — direction is a separate field, and a statement that writes
 * outgoing money as a negative should not produce a negative payment.
 */
export function coerceAmount(raw: string, unit: AmountUnit): Coerced<Paise> {
  let v = raw.trim();
  if (v === '') return { ok: false, value: 0, note: 'empty' };
  const parenthesised = /^\(.*\)$/.test(v);
  v = v
    .replace(/^\(|\)$/g, '')
    .replace(/(?:inr|rs\.?|₹|\$)/gi, '')
    .replace(/\b(?:dr|cr)\b\.?/gi, '')
    .replace(/[,\s]/g, '')
    .trim();
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false, value: 0, note: `"${raw}" is not an amount` };
  const magnitude = Math.abs(n);
  const paise = unit === 'paise' ? Math.round(magnitude) : Math.round(magnitude * PAISE_PER_RUPEE);
  const note = parenthesised || n < 0 ? 'read as an outgoing amount; the sign was dropped' : undefined;
  return { ok: true, value: paise as Paise, ...(note ? { note } : {}) };
}

/**
 * How a timestamp column should be read.
 *
 * `auto` is the default and covers everything below. The explicit modes exist
 * because two conventions are genuinely ambiguous from the data — 03/04/2026
 * is a different day in Kolkata and in New York, and a bare integer can be a
 * Unix time or a sequence step — and an operator who knows which one their
 * file uses should be able to say so.
 */
export type TimestampMode = 'auto' | 'epoch_ms' | 'epoch_s' | 'iso' | 'day_first' | 'month_first' | 'step_hours';

const MIN_PLAUSIBLE_MS = Date.UTC(1990, 0, 1);
const MAX_PLAUSIBLE_MS = Date.UTC(2100, 0, 1);

/**
 * Read a timestamp.
 *
 * `base` anchors relative formats: PaySim-style step numbers count hours from
 * it. It is also what an unreadable cell falls back to.
 */
export function coerceTimestamp(raw: string, mode: TimestampMode, base: Millis): Coerced<Millis> {
  const v = raw.trim();
  if (v === '') return { ok: false, value: base, note: 'empty' };

  if (mode === 'step_hours') {
    const n = Number(v);
    if (!Number.isFinite(n)) return { ok: false, value: base, note: `"${raw}" is not a step number` };
    return { ok: true, value: (base + n * 3_600_000) as Millis };
  }

  if (mode === 'epoch_ms' || mode === 'epoch_s') {
    const n = Number(v);
    if (!Number.isFinite(n)) return { ok: false, value: base, note: `"${raw}" is not a number` };
    return { ok: true, value: Math.round(mode === 'epoch_s' ? n * 1000 : n) as Millis };
  }

  if (mode === 'day_first' || mode === 'month_first') {
    const parsed = parseSlashDate(v, mode === 'day_first');
    if (parsed === null) return { ok: false, value: base, note: `"${raw}" is not a date` };
    return { ok: true, value: parsed };
  }

  if (mode === 'iso') {
    const t = Date.parse(v);
    if (Number.isNaN(t)) return { ok: false, value: base, note: `"${raw}" is not an ISO date` };
    return { ok: true, value: t as Millis };
  }

  // --- auto --------------------------------------------------------------
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    // A bare number large enough to be a plausible millisecond time is one.
    if (n >= MIN_PLAUSIBLE_MS && n <= MAX_PLAUSIBLE_MS) return { ok: true, value: Math.round(n) as Millis };
    // Otherwise seconds, if that lands in range.
    const asSeconds = n * 1000;
    if (asSeconds >= MIN_PLAUSIBLE_MS && asSeconds <= MAX_PLAUSIBLE_MS) {
      return { ok: true, value: Math.round(asSeconds) as Millis, note: 'read as seconds since 1970' };
    }
    // A small integer is a sequence step, which is how PaySim encodes hours.
    return { ok: true, value: (base + n * 3_600_000) as Millis, note: 'read as a step number, one hour per step' };
  }

  const slash = parseSlashDate(v, true);
  if (slash !== null) {
    const ambiguous = /^(\d{1,2})[/\-.](\d{1,2})/.exec(v);
    const note =
      ambiguous && Number(ambiguous[1]) <= 12 && Number(ambiguous[2]) <= 12
        ? 'day/month order assumed; set it explicitly if the file is month-first'
        : undefined;
    return { ok: true, value: slash, ...(note ? { note } : {}) };
  }

  const t = Date.parse(v);
  if (!Number.isNaN(t)) return { ok: true, value: t as Millis };
  return { ok: false, value: base, note: `"${raw}" is not a date` };
}

/** Parse dd/mm/yyyy and mm/dd/yyyy with an optional time, in either separator. */
function parseSlashDate(v: string, dayFirst: boolean): Millis | null {
  const m = /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  if (!m) return null;
  let day: number;
  let month: number;
  let year: number;
  if (m[1]!.length === 4) {
    // yyyy-mm-dd, which is unambiguous.
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else {
    const a = Number(m[1]);
    const b = Number(m[2]);
    year = Number(m[3]);
    // A value above twelve can only be the day, whatever the stated order.
    if (a > 12) { day = a; month = b; }
    else if (b > 12) { month = a; day = b; }
    else if (dayFirst) { day = a; month = b; }
    else { month = a; day = b; }
    if (year < 100) year += year < 70 ? 2000 : 1900;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const hour = m[4] ? Number(m[4]) : 0;
  const minute = m[5] ? Number(m[5]) : 0;
  const second = m[6] ? Number(m[6]) : 0;
  const t = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isNaN(t) ? null : (t as Millis);
}

export function coerceEnum(raw: string, values: readonly string[]): Coerced<string> {
  const v = raw.trim().toLowerCase();
  if (v === '') return { ok: false, value: values[0]!, note: 'empty' };
  const exact = values.find((x) => x.toLowerCase() === v);
  if (exact) return { ok: true, value: exact };
  // Accept the common spellings a file is likely to carry.
  const loose = values.find((x) => v.startsWith(x.toLowerCase()) || x.toLowerCase().startsWith(v));
  if (loose) return { ok: true, value: loose, note: `"${raw}" read as ${loose}` };
  return { ok: false, value: values[0]!, note: `"${raw}" is not one of ${values.join(', ')}` };
}
