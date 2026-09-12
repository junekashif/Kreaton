/**
 * The slice of the Google Sheets API this project uses.
 *
 * Four operations: find out which tabs a spreadsheet has, create the ones it
 * is missing, append rows to one, and empty one back to its header. Everything
 * else the API offers is out of scope, and leaving it out keeps the surface
 * small enough to read.
 */

import { TokenSource } from './auth.js';
import type { Fetcher, ServiceAccountCredentials } from './auth.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * Google's published write quota is sixty requests per minute per user.
 *
 * This is the reason every write in this package is batched. A replay at sixty
 * payments a second would exhaust a per-row quota in one second; the same run
 * appended in blocks costs a handful of requests a minute.
 */
export const WRITE_REQUESTS_PER_MINUTE = 60;

export interface SheetsClientOptions {
  credentials: ServiceAccountCredentials;
  spreadsheetId: string;
  /** Injectable so tests need no network. */
  fetcher?: Fetcher;
  now?: () => number;
}

export class SheetsClient {
  private readonly tokens: TokenSource;
  private readonly fetcher: Fetcher;
  readonly spreadsheetId: string;

  constructor(opts: SheetsClientOptions) {
    this.fetcher = opts.fetcher ?? fetch;
    this.spreadsheetId = opts.spreadsheetId;
    this.tokens = new TokenSource(opts.credentials, this.fetcher, opts.now ?? Date.now);
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.tokens.get();
    const res = await this.fetcher(`${API}/${this.spreadsheetId}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new SheetsError(res.status, `${init.method ?? 'GET'} ${path} failed (${res.status}). ${detail.slice(0, 400)}`);
    }
    return res.json();
  }

  /** Tab titles currently in the spreadsheet. */
  async listTabs(): Promise<string[]> {
    return (await this.tabs()).map((t) => t.title);
  }

  /** Tabs with the numeric ids the structural API addresses them by. */
  async tabs(): Promise<Array<{ title: string; sheetId: number; rowCount: number }>> {
    const json = (await this.request(
      '?fields=sheets.properties(title,sheetId,gridProperties.rowCount)',
    )) as {
      sheets?: Array<{ properties?: { title?: string; sheetId?: number; gridProperties?: { rowCount?: number } } }>;
    };
    return (json.sheets ?? [])
      .map((s) => ({
        title: s.properties?.title ?? '',
        sheetId: s.properties?.sheetId ?? -1,
        rowCount: s.properties?.gridProperties?.rowCount ?? 0,
      }))
      .filter((t) => t.title !== '' && t.sheetId >= 0);
  }

  /**
   * Delete every row below the header, leaving the header in place.
   *
   * Rows are removed, not cleared: an emptied cell still counts as part of
   * the table to the append endpoint, so a cleared tab would take new rows
   * after a block of blanks. Returns how many rows were removed.
   */
  async truncate(tab: string): Promise<number> {
    const meta = (await this.tabs()).find((t) => t.title === tab);
    if (!meta) throw new SheetsError(404, `No tab named "${tab}".`);
    const values = await this.read(tab, 'A:A');
    const dataRows = Math.max(0, values.length - 1);
    if (dataRows === 0) return 0;
    await this.request(':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          {
            deleteDimension: {
              range: { sheetId: meta.sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 1 + dataRows },
            },
          },
        ],
      }),
    });
    return dataRows;
  }

  /** Create any of these tabs that do not exist. Returns the ones created. */
  async ensureTabs(titles: readonly string[]): Promise<string[]> {
    const existing = new Set(await this.listTabs());
    const missing = titles.filter((t) => !existing.has(t));
    if (missing.length === 0) return [];
    await this.request(':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({
        requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
      }),
    });
    return missing;
  }

  /**
   * Append rows to a tab.
   *
   * `RAW` rather than `USER_ENTERED`, deliberately. A hash that begins with a
   * digit, an identifier that looks like a date, a reason code that starts
   * with a minus — under `USER_ENTERED` the spreadsheet would helpfully
   * reinterpret all three, and the audit trail would stop matching the ledger
   * it was copied from.
   */
  async append(tab: string, rows: ReadonlyArray<ReadonlyArray<string | number | boolean>>): Promise<number> {
    if (rows.length === 0) return 0;
    const range = encodeURIComponent(`${tab}!A1`);
    const json = (await this.request(
      `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values: rows }) },
    )) as { updates?: { updatedRows?: number } };
    return json.updates?.updatedRows ?? rows.length;
  }

  /** Read a tab back, for verification and for restoring a session. */
  async read(tab: string, a1 = 'A1:ZZ'): Promise<string[][]> {
    const range = encodeURIComponent(`${tab}!${a1}`);
    const json = (await this.request(`/values/${range}`)) as { values?: string[][] };
    return json.values ?? [];
  }
}

/** Carries the HTTP status so a caller can tell a rate limit from a bad key. */
export class SheetsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SheetsError';
  }

  /** True when backing off and retrying is the right response. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}
