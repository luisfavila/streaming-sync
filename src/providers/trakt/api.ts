// Trakt's public API (https://trakt.docs.apiary.io). It accepts requests from any web page.
//
// Every request names a Trakt "app" by its client ID. Since October 2026 Trakt issues no client
// secret to new apps and makes it optional on every /oauth call (trakt/trakt-api#974), so a
// client ID is all a browser page needs, and it's public by design. Either the page is built with
// one (VITE_TRAKT_CLIENT_ID) or users create their own at trakt.tv/oauth/applications. Older apps
// that still have a secret keep sending it.
//
// Two ways to sign in: Trakt's recommended authorization code flow with PKCE (a Trakt window
// opens, the user approves, Trakt sends the window back to this page with a code), when the page
// is built with a redirect URI (VITE_TRAKT_REDIRECT_URI); and the device code flow (approve a
// code at trakt.tv/activate), which needs no redirect and works anywhere.

const API = 'https://api.trakt.tv';
const AUTHORIZE = 'https://auth.trakt.tv/oauth/authorize';
/** Trakt's value for "no redirect" (device and pasted-code sign-ins). */
const OOB = 'urn:ietf:wg:oauth:2.0:oob';

export interface TraktApp {
  clientId: string;
  /** Only older apps have one; Trakt no longer issues them. */
  clientSecret?: string;
}

/** The secret, only when the app has one. */
const secret = (app: TraktApp) => (app.clientSecret ? { client_secret: app.clientSecret } : {});

export interface TraktSession {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. */
  expiresAt: number;
  /** The redirect URI it was signed in with (PKCE); device-code sessions have none. Refreshes send the same. */
  redirectUri?: string;
}

const env: Record<string, string | undefined> = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
/**
 * The app this page was built with, if any. Client ID only: anything read from the build env ends
 * up in the public JavaScript, so a secret is never taken from there (only from the optional field).
 */
export const BUILT_IN_APP: TraktApp | undefined = env.VITE_TRAKT_CLIENT_ID ? { clientId: env.VITE_TRAKT_CLIENT_ID } : undefined;
/**
 * Where Trakt sends the sign-in window back to (this page's URL, as registered on the built-in
 * app), enabling PKCE sign-in. Unset: sign-in uses device codes only.
 */
export const BUILT_IN_REDIRECT_URI: string | undefined = (BUILT_IN_APP && env.VITE_TRAKT_REDIRECT_URI) || undefined;

export class TraktError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STATUS_HINTS: Record<number, string> = {
  401: 'Trakt rejected the sign-in; sign in again',
  403: "Trakt rejected the app's client ID",
  420: 'the Trakt account is over its free limit (e.g. watchlist size)',
  423: 'the Trakt account is locked',
};

async function request<T>(path: string, init: { method?: string; body?: unknown; clientId: string; token?: string }): Promise<{ status: number; data: T; headers: Headers }> {
  const method = init.method ?? 'GET';
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': init.clientId,
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(60_000),
    });
    // Rate limited: nothing was done, so waiting and retrying is safe for any method.
    if (res.status === 429 && attempt < 5) {
      await sleep(Math.min(Number(res.headers.get('retry-after')) || 2 ** attempt, 30) * 1000);
      continue;
    }
    // Outages: retry reads only (a write may have gone through).
    if ([502, 503, 504, 520, 521, 522].includes(res.status) && method === 'GET' && attempt < 3) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    if (res.ok) return { status: res.status, data: data as T, headers: res.headers };
    const d = data as { error_description?: string; error?: string } | null;
    throw new TraktError(`Trakt: ${d?.error_description || d?.error || STATUS_HINTS[res.status] || `HTTP ${res.status}`}`, res.status);
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at: number;
}
const toSession = (t: TokenResponse, redirectUri?: string): TraktSession => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token,
  expiresAt: (t.created_at || Math.floor(Date.now() / 1000)) + t.expires_in,
  ...(redirectUri ? { redirectUri } : {}),
});

// ---- PKCE sign-in: Trakt's page approves, then redirects back with a code ----

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A fresh code verifier (64 characters) and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function authorizeUrl(app: TraktApp, redirectUri: string, challenge: string, state: string): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: app.clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' });
  return `${AUTHORIZE}?${q}`;
}

/** Trades the code from the redirect for a session. The verifier stands in for a client secret, so none is sent. */
export async function exchangeCode(app: TraktApp, code: string, verifier: string, redirectUri: string): Promise<TraktSession> {
  try {
    const r = await request<TokenResponse>('/oauth/token', {
      method: 'POST',
      body: { code, client_id: app.clientId, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' },
      clientId: app.clientId,
    });
    return toSession(r.data, redirectUri);
  } catch (e) {
    const status = (e as TraktError).status;
    if (status === 400 || status === 401) throw new TraktError("Trakt didn't accept the sign-in (it may have expired). Try again.", status);
    throw e;
  }
}

// ---- Device sign-in: show a code, the user approves it at trakt.tv/activate ----

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export async function deviceCode(app: TraktApp): Promise<DeviceCode> {
  return (await request<DeviceCode>('/oauth/device/code', { method: 'POST', body: { client_id: app.clientId }, clientId: app.clientId })).data;
}

/** One poll: the session once approved, 'pending' while waiting, 'slow' when asked to poll less often. */
export async function pollDeviceCode(app: TraktApp, code: string): Promise<TraktSession | 'pending' | 'slow'> {
  try {
    const r = await request<TokenResponse>('/oauth/device/token', {
      method: 'POST',
      body: { code, client_id: app.clientId, ...secret(app) },
      clientId: app.clientId,
    });
    return toSession(r.data);
  } catch (e) {
    const status = (e as TraktError).status;
    if (status === 400) return 'pending';
    if (status === 429) return 'slow';
    const reason: Record<number, string> = {
      401: "Trakt rejected the app's client ID or secret. Check them and try again.",
      404: 'Trakt didn’t recognise the code. Get a new one.',
      409: 'That code was already used. Get a new one.',
      410: 'The code expired before it was approved. Get a new one.',
      418: 'The sign-in was declined on Trakt.',
    };
    throw new TraktError(reason[status] ?? (e as Error).message, status);
  }
}

export async function refreshSession(app: TraktApp, session: Pick<TraktSession, 'refreshToken' | 'redirectUri'>): Promise<TraktSession> {
  // A PKCE session refreshes as a public client: same redirect URI, no secret.
  const r = await request<TokenResponse>('/oauth/token', {
    method: 'POST',
    body: { refresh_token: session.refreshToken, client_id: app.clientId, ...(session.redirectUri ? {} : secret(app)), redirect_uri: session.redirectUri ?? OOB, grant_type: 'refresh_token' },
    clientId: app.clientId,
  });
  return toSession(r.data, session.redirectUri);
}

export async function revoke(app: TraktApp, accessToken: string): Promise<void> {
  await request('/oauth/revoke', { method: 'POST', body: { token: accessToken, client_id: app.clientId, ...secret(app) }, clientId: app.clientId });
}

export interface TraktUser {
  username: string;
  name?: string;
  ids: { slug: string; uuid?: string };
}

/** A signed-in Trakt session: refreshes tokens as needed and keeps writes to Trakt's pace. */
export class TraktClient {
  private session: TraktSession;
  private readonly app: TraktApp;
  private readonly onRotate: (s: TraktSession) => void;
  private refreshing: Promise<void> | undefined;
  private nextWrite = 0;
  /** Trakt allows one write per second per user. */
  private readonly writeIntervalMs: number;

  constructor(app: TraktApp, session: TraktSession, onRotate: (s: TraktSession) => void, opts: { writeIntervalMs?: number } = {}) {
    this.app = app;
    this.session = { ...session };
    this.onRotate = onRotate;
    this.writeIntervalMs = opts.writeIntervalMs ?? 1100;
  }

  get accessToken(): string {
    return this.session.accessToken;
  }

  /** Refresh tokens work once, so concurrent callers share one refresh. */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        this.session = await refreshSession(this.app, this.session);
        this.onRotate(this.session);
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ data: T; headers: Headers }> {
    if (this.session.expiresAt - 300 < Date.now() / 1000) await this.refresh();
    if (method !== 'GET') {
      const wait = this.nextWrite - Date.now();
      this.nextWrite = Math.max(Date.now(), this.nextWrite) + this.writeIntervalMs;
      if (wait > 0) await sleep(wait);
    }
    const token = this.session.accessToken;
    try {
      return await request<T>(path, { method, body, clientId: this.app.clientId, token });
    } catch (e) {
      if ((e as TraktError).status !== 401) throw e;
      if (this.session.accessToken === token) await this.refresh();
      return await request<T>(path, { method, body, clientId: this.app.clientId, token: this.session.accessToken });
    }
  }

  async get<T>(path: string): Promise<T> {
    return (await this.call<T>('GET', path)).data;
  }

  /**
   * Every page of a list endpoint. Trakt pages its lists (watched lists since July 2026 return
   * only 100 items unless asked for more pages), so lists are always read page by page, stopping
   * at the last page Trakt reports (X-Pagination-Page-Count) or, when that header can't be read,
   * at an empty page. Stopping early would make titles look missing on Trakt and get them added again.
   */
  async getAll<T>(path: string, limit = 250): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= 1000; page++) {
      const { data, headers } = await this.call<T[]>('GET', `${path}${sep}page=${page}&limit=${limit}`);
      if (!Array.isArray(data) || !data.length) break;
      out.push(...data);
      const pages = Number(headers.get('x-pagination-page-count'));
      if (pages && page >= pages) break;
    }
    return out;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.call<T>('POST', path, body)).data;
  }
}
