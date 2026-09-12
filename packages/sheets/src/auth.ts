/**
 * Service-account authentication for the Google Sheets API.
 *
 * Written against the OAuth 2.0 JWT bearer flow directly rather than through
 * the official client library, for the same reason the engine has no
 * dependencies: the whole exchange is one signed assertion and one POST, and
 * `googleapis` is a large tree to pull in for that. Node's crypto module signs
 * the assertion; nothing else is needed.
 *
 * The flow, for a reader checking it against Google's documentation:
 *
 *   1. Build a JWT whose issuer is the service account's email, whose audience
 *      is the token endpoint, and whose scope is the Sheets API.
 *   2. Sign it RS256 with the service account's private key.
 *   3. POST it to the token endpoint as a `jwt-bearer` grant.
 *   4. Receive an access token, good for an hour, and cache it.
 */

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** How early to renew, so a request never carries a token that expires mid-flight. */
const RENEW_MARGIN_MS = 60_000;

export interface ServiceAccountCredentials {
  /** `client_email` from the service account JSON key. */
  clientEmail: string;
  /** `private_key` from the same file, PEM encoded, newlines intact. */
  privateKey: string;
}

/**
 * Read credentials out of the JSON key file Google hands you.
 *
 * Accepts the file's text, or the same object already parsed. The private key
 * commonly arrives with literal `\n` sequences when it has been through an
 * environment variable, so those are restored.
 */
export function credentialsFromJson(json: string | Record<string, unknown>): ServiceAccountCredentials {
  const obj = typeof json === 'string' ? (JSON.parse(json) as Record<string, unknown>) : json;
  const clientEmail = obj.client_email ?? obj.clientEmail;
  const privateKey = obj.private_key ?? obj.privateKey;
  if (typeof clientEmail !== 'string' || clientEmail === '') {
    throw new Error('The service account key has no client_email.');
  }
  if (typeof privateKey !== 'string' || privateKey === '') {
    throw new Error('The service account key has no private_key.');
  }
  return { clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build and sign the bearer assertion. */
export function signAssertion(credentials: ServiceAccountCredentials, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${base64url(signer.sign(credentials.privateKey))}`;
}

/** The HTTP surface this module needs, so a test can supply its own. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Caches an access token and renews it before it expires.
 *
 * Concurrent callers share one in-flight renewal rather than each starting
 * their own, because a burst of flushes arriving at the same moment should
 * not turn into a burst of token requests.
 */
export class TokenSource {
  private token: string | null = null;
  private expiresAtMs = 0;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly credentials: ServiceAccountCredentials,
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<string> {
    if (this.token && this.now() < this.expiresAtMs - RENEW_MARGIN_MS) return this.token;
    if (this.pending) return this.pending;
    this.pending = this.renew().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async renew(): Promise<string> {
    const assertion = signAssertion(this.credentials, Math.floor(this.now() / 1000));
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
    const res = await this.fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Google refused the service account assertion (${res.status}). ${detail.slice(0, 300)}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('The token response carried no access_token.');
    this.token = json.access_token;
    this.expiresAtMs = this.now() + (json.expires_in ?? 3600) * 1000;
    return this.token;
  }
}
