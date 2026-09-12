/**
 * Delimited-text parsing.
 *
 * Written rather than taken from a library for the same reason the engine has
 * no dependencies: this code runs in the browser tab, in a route handler and
 * in a CLI script, and a parser is small enough that owning it is cheaper than
 * shipping three copies of somebody else's.
 *
 * RFC 4180 with the concessions real exports require: CRLF or LF, an optional
 * UTF-8 byte order mark, quoted fields containing the delimiter or a newline,
 * doubled quotes inside a quoted field, and a sniffed delimiter because banks
 * export semicolons and analysts export tabs.
 */

/** Delimiters the sniffer will consider, most common first. */
const CANDIDATE_DELIMITERS = [',', '\t', ';', '|'] as const;

export type Delimiter = (typeof CANDIDATE_DELIMITERS)[number];

export interface ParsedTable {
  header: string[];
  rows: string[][];
  delimiter: Delimiter;
  /** Rows whose cell count did not match the header, with their line numbers. */
  ragged: Array<{ line: number; cells: number }>;
}

/**
 * Guess the delimiter from the first few lines.
 *
 * The winner is the candidate that appears a consistent, non-zero number of
 * times on every sampled line. Consistency matters more than frequency: prose
 * in a notes column contains commas, but not the same count on every row.
 */
export function sniffDelimiter(text: string): Delimiter {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 20);
  if (lines.length === 0) return ',';
  let best: Delimiter = ',';
  let bestScore = -1;
  for (const d of CANDIDATE_DELIMITERS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    if (counts[0] === 0) continue;
    const first = counts[0]!;
    const consistent = counts.every((c) => c === first);
    // Consistency is worth more than raw frequency, hence the large multiplier.
    const score = (consistent ? 1000 : 0) + first;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') i += 1;
      else quoted = !quoted;
    } else if (!quoted && ch === delimiter) {
      count += 1;
    }
  }
  return count;
}

export interface ParseOptions {
  delimiter?: Delimiter;
  /** Stop after this many data rows. The header is not counted. */
  limit?: number;
}

/** Parse delimited text into a header and rows. */
export function parseDelimited(text: string, opts: ParseOptions = {}): ParsedTable {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = opts.delimiter ?? sniffDelimiter(body);
  const limit = opts.limit ?? Infinity;

  const rows: string[][] = [];
  const ragged: Array<{ line: number; cells: number }> = [];
  let header: string[] | null = null;

  let field = '';
  let row: string[] = [];
  let quoted = false;
  let line = 1;
  let started = false;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): boolean => {
    endField();
    // A trailing newline produces one empty cell; that is not a row.
    const empty = row.length === 1 && row[0]!.trim() === '';
    if (!empty) {
      if (header === null) {
        header = row.map((h) => h.trim());
      } else {
        if (row.length !== header.length) ragged.push({ line, cells: row.length });
        rows.push(row);
      }
    }
    row = [];
    line += 1;
    return header !== null && rows.length >= limit;
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !started) {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === delimiter) {
      endField();
      started = false;
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      if (endRow()) return { header: header ?? [], rows, delimiter, ragged };
      started = false;
      continue;
    }
    field += ch;
    started = true;
  }
  // Whatever is left after the last newline.
  if (field.length > 0 || row.length > 0) endRow();

  return { header: header ?? [], rows, delimiter, ragged };
}

/** Pair a row against the header, tolerating short and long rows. */
export function toRecord(header: readonly string[], row: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < header.length; i++) out[header[i]!] = row[i] ?? '';
  return out;
}
