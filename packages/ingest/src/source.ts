/**
 * Reading a file into rows, whatever shape it arrived in.
 *
 * Delimited text and JSON are folded into one representation — a header list
 * and a list of string-keyed rows — so that mapping, coercion and reporting
 * have a single code path. A JSON object is flattened to dotted keys, which
 * means a nested `context.activeCall` in an export of this engine's own shape
 * presents exactly like a column of the same name in a spreadsheet.
 */

import { parseDelimited, toRecord } from './delimited.js';
import type { Delimiter } from './delimited.js';

export type SourceFormat = 'delimited' | 'json';

export interface SourceTable {
  format: SourceFormat;
  header: string[];
  rows: Array<Record<string, string>>;
  delimiter?: Delimiter;
  /** Rows whose cell count did not match the header. */
  ragged: Array<{ line: number; cells: number }>;
  /** Total rows in the file, before any limit was applied. */
  truncatedAt?: number;
}

export interface ReadOptions {
  format?: SourceFormat;
  delimiter?: Delimiter;
  limit?: number;
}

/** Guess the format from the first non-whitespace character. */
export function sniffFormat(text: string): SourceFormat {
  const head = text.trimStart().slice(0, 1);
  return head === '[' || head === '{' ? 'json' : 'delimited';
}

/** Read a file's text into a header and string rows. */
export function readSource(text: string, opts: ReadOptions = {}): SourceTable {
  const format = opts.format ?? sniffFormat(text);
  if (format === 'json') return readJson(text, opts.limit);

  const parsed = parseDelimited(text, {
    ...(opts.delimiter ? { delimiter: opts.delimiter } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });
  return {
    format: 'delimited',
    header: parsed.header,
    rows: parsed.rows.map((r) => toRecord(parsed.header, r)),
    delimiter: parsed.delimiter,
    ragged: parsed.ragged,
  };
}

function readJson(text: string, limit?: number): SourceTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Accept a bare array, or an object with the array under a familiar key.
  let items: unknown[];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const key = ['transactions', 'rows', 'data', 'items', 'payments', 'records'].find((k) => Array.isArray(obj[k]));
    if (!key) {
      throw new Error('The JSON is an object with no array of records in it. Expected an array, or a key such as "transactions".');
    }
    items = obj[key] as unknown[];
  } else {
    throw new Error('The JSON is neither an array nor an object.');
  }

  const total = items.length;
  const capped = limit !== undefined ? items.slice(0, limit) : items;

  const header: string[] = [];
  const seen = new Set<string>();
  const rows = capped.map((item) => {
    const flat: Record<string, string> = {};
    flatten(item, '', flat);
    for (const k of Object.keys(flat)) {
      if (!seen.has(k)) {
        seen.add(k);
        header.push(k);
      }
    }
    return flat;
  });

  return {
    format: 'json',
    header,
    rows,
    ragged: [],
    ...(limit !== undefined && total > limit ? { truncatedAt: total } : {}),
  };
}

/** Flatten nested objects to dotted keys; arrays become JSON text. */
function flatten(value: unknown, prefix: string, out: Record<string, string>): void {
  if (value === null || value === undefined) {
    if (prefix) out[prefix] = '';
    return;
  }
  if (Array.isArray(value)) {
    if (prefix) out[prefix] = JSON.stringify(value);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  if (prefix) out[prefix] = String(value);
}
