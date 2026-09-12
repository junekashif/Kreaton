/**
 * @kreaton/sheets
 *
 * Durable persistence of the audit trail to a Google Sheet, behind the
 * decision path rather than in front of it. See sink.ts for why that
 * placement is the whole design, and docs/PERSISTENCE.md for setup.
 */

export { credentialsFromJson, signAssertion, TokenSource } from './auth.js';
export type { Fetcher, ServiceAccountCredentials } from './auth.js';

export { SheetsClient, SheetsError, WRITE_REQUESTS_PER_MINUTE } from './client.js';
export type { SheetsClientOptions } from './client.js';

export { GoogleSheetsSink, HEADERS, TABS } from './sink.js';
export type { SheetsSinkOptions, SinkStats } from './sink.js';
