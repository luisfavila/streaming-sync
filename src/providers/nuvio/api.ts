// Client for Nuvio's sync backend: a Supabase instance (GoTrue auth + PostgREST RPCs).
// RPC names and payloads follow Nuvio's official app (NuvioMedia/NuvioMobile), e.g.
// features/library/sync/SupabaseLibrarySyncAdapter.kt, features/watching/sync/*, features/addons/AddonRepository.kt,
// core/auth/DeviceLinkAuthRepository.kt.

const env: Record<string, string | undefined> = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

// The backup host doesn't allow requests from web pages, so a browser only uses the main one
// (failing over there would just hide the main host's real error).
const inBrowser = typeof document !== 'undefined';
export const NUVIO_HOSTS = (env.NUVIO_API_URL ? [env.NUVIO_API_URL] : inBrowser ? ['https://api.nuvio.tv'] : ['https://api.nuvio.tv', 'https://api-two.nuvioapp.space']).map((h) =>
  h.replace(/\/$/, ''),
);

// Nuvio's public client key (a Supabase "anon" key: it identifies the app, not a user, and ships
// inside every Nuvio client). Taken from the open-source YungZanji/nuvio-trakt-importer.
export const NUVIO_ANON_KEY =
  env.NUVIO_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI';

export class NuvioError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'NuvioError';
    this.status = status;
  }
}

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number;
  user?: { id: string; email?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAILOVER_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);

/** One HTTP call, trying the fallback host on outages and waiting out rate limits. */
async function request(path: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Response> {
  let lastError: unknown;
  for (const host of NUVIO_HOSTS) {
    for (let attempt = 0; attempt < 4; attempt++) {
      let res: Response;
      try {
        res = await fetch(host + path, { ...init, signal: AbortSignal.timeout(60_000) });
      } catch (e) {
        lastError = e;
        break; // network error: try the next host
      }
      if (res.status === 429) {
        lastError = new NuvioError('rate limited (HTTP 429); try again in a few minutes', 429);
        // Rate limited: the request was not processed, so waiting and retrying is safe.
        const wait = Number(res.headers.get('retry-after')) || 2 ** attempt * 2;
        await sleep(Math.min(wait, 60) * 1000);
        continue;
      }
      if (FAILOVER_STATUS.has(res.status)) {
        lastError = new NuvioError(`HTTP ${res.status}`, res.status);
        break;
      }
      return res;
    }
  }
  throw new NuvioError(`Nuvio is unreachable: ${(lastError as Error)?.message ?? 'unknown error'}`);
}

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new NuvioError(`${what}: HTTP ${res.status}: ${text.slice(0, 160)}`, res.status);
  }
  if (!res.ok) {
    const d = data as { message?: string; msg?: string; error_description?: string; error?: string } | null;
    throw new NuvioError(`${what}: ${d?.error_description || d?.msg || d?.message || d?.error || 'HTTP ' + res.status}`, res.status);
  }
  return data as T;
}

const anonHeaders = { apikey: NUVIO_ANON_KEY, 'Content-Type': 'application/json' };

export async function passwordLogin(email: string, password: string): Promise<Session> {
  const res = await request('/auth/v1/token?grant_type=password', { method: 'POST', headers: anonHeaders, body: JSON.stringify({ email, password }) });
  return json<Session>(res, 'Nuvio sign-in');
}

export async function refreshSession(refreshToken: string): Promise<Session> {
  const res = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: anonHeaders, body: JSON.stringify({ refresh_token: refreshToken }) });
  return json<Session>(res, 'Nuvio session refresh');
}

export async function getUser(accessToken: string): Promise<{ id: string; email?: string }> {
  const res = await request('/auth/v1/user', { method: 'GET', headers: { apikey: NUVIO_ANON_KEY, Authorization: `Bearer ${accessToken}` } });
  return json(res, 'Nuvio user');
}

export async function signOutSession(accessToken: string): Promise<void> {
  // scope=local ends only this session, not the user's other devices.
  await request('/auth/v1/logout?scope=local', { method: 'POST', headers: { ...anonHeaders, Authorization: `Bearer ${accessToken}` } });
}

// ---- Device-link sign-in (approve a code at nuvio.tv/link) ----

export interface DeviceLoginStart {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  poll_interval_seconds?: number;
}

export async function startDeviceLogin(nonce: string, deviceName: string): Promise<DeviceLoginStart> {
  const res = await request('/rest/v1/rpc/start_device_login_session', {
    method: 'POST',
    headers: anonHeaders,
    body: JSON.stringify({ p_device_nonce: nonce, p_redirect_base_url: 'https://nuvio.tv/link', p_device_name: deviceName, p_device_type: 'mobile' }),
  });
  const rows = await json<DeviceLoginStart[] | DeviceLoginStart>(res, 'Nuvio device sign-in');
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row?.device_code || !row.verification_uri_complete) throw new NuvioError('Nuvio device sign-in: unexpected response');
  return row;
}

export async function pollDeviceLogin(code: string, nonce: string): Promise<string> {
  const res = await request('/rest/v1/rpc/poll_tv_login_session', { method: 'POST', headers: anonHeaders, body: JSON.stringify({ p_code: code, p_device_nonce: nonce }) });
  const rows = await json<{ status: string }[] | { status: string }>(res, 'Nuvio device sign-in');
  return (Array.isArray(rows) ? rows[0]?.status : rows?.status) ?? 'pending';
}

export async function exchangeDeviceLogin(code: string, nonce: string): Promise<Session> {
  const res = await request('/functions/v1/tv-logins-exchange', { method: 'POST', headers: anonHeaders, body: JSON.stringify({ code, device_nonce: nonce }) });
  return json<Session>(res, 'Nuvio device sign-in');
}

// ---- Authenticated calls ----

/** Holds a session, refreshes it before it expires, and reports rotated tokens so they can be saved. */
export class NuvioClient {
  private session: { accessToken: string; refreshToken: string; expiresAt: number };
  private readonly onRotate: (s: { accessToken: string; refreshToken: string; expiresAt: number }) => void;

  constructor(session: { accessToken: string; refreshToken: string; expiresAt: number }, onRotate: NuvioClient['onRotate']) {
    this.session = session;
    this.onRotate = onRotate;
  }

  get accessToken(): string {
    return this.session.accessToken;
  }

  private refreshing: Promise<void> | undefined;

  /**
   * Swaps the refresh token for a new session. Refresh tokens work once, so concurrent callers
   * share one refresh instead of each spending the same token.
   */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const s = await refreshSession(this.session.refreshToken);
        this.session = {
          accessToken: s.access_token,
          refreshToken: s.refresh_token,
          expiresAt: s.expires_at ?? Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600),
        };
        this.onRotate(this.session);
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  private async ensureFresh(): Promise<void> {
    if (this.session.expiresAt - 120 < Date.now() / 1000) await this.refresh();
  }

  private async authed(path: string, method: string, body?: unknown): Promise<Response> {
    await this.ensureFresh();
    const send = () =>
      request(path, {
        method,
        headers: { ...anonHeaders, Authorization: `Bearer ${this.session.accessToken}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const token = this.session.accessToken;
    let res = await send();
    if (res.status === 401) {
      // Another request may already have refreshed; only refresh if the token is still the one that failed.
      if (this.session.accessToken === token) await this.refresh();
      res = await send();
    }
    return res;
  }

  async rpc<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    return json<T>(await this.authed(`/rest/v1/rpc/${name}`, 'POST', params), `Nuvio ${name}`);
  }

  async select<T>(table: string, query: string): Promise<T> {
    return json<T>(await this.authed(`/rest/v1/${table}?${query}`, 'GET'), `Nuvio ${table}`);
  }
}
