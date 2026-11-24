// Minimal client for Stremio's (undocumented) API, as used by Stremio's own apps.
// Shapes follow stremio-core: src/types/api/request.rs and src/types/library/library_item.rs.

const API = 'https://api.strem.io/api/';
const LINK_API = 'https://link.stremio.com/api/v2/';

export class StremioError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'StremioError';
    this.code = code;
  }
}

export interface StremioLibraryItemState {
  lastWatched?: string | null;
  timeWatched: number;
  timeOffset: number;
  overallTimeWatched: number;
  timesWatched: number;
  flaggedWatched: number;
  duration: number;
  video_id?: string | null;
  watched?: string | null;
  noNotif: boolean;
  [extra: string]: unknown;
}

export interface StremioLibraryItem {
  _id: string;
  name: string;
  type: string;
  poster?: string | null;
  posterShape?: string;
  removed: boolean;
  temp: boolean;
  _ctime?: string | null;
  _mtime: string;
  state: StremioLibraryItemState;
  behaviorHints?: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface StremioAddonDescriptor {
  transportUrl: string;
  manifest: { id: string; name: string; version: string; [extra: string]: unknown };
  flags?: { official?: boolean; protected?: boolean };
  [extra: string]: unknown;
}

const ERROR_HINTS: Record<number, string> = {
  1: 'the Stremio token is invalid or expired',
  2: 'no Stremio account uses that email',
  3: "the password doesn't match",
  33: 'this account signs in with Facebook or Apple, so it has no password. Use a link code or a token instead',
};

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(API + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: { result?: T; error?: { code?: number; message?: string } };
  try {
    data = JSON.parse(text);
  } catch {
    throw new StremioError(`Stremio ${method}: HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  if (data.error) {
    const code = data.error.code;
    const hint = code !== undefined ? ERROR_HINTS[code] : undefined;
    throw new StremioError(`Stremio ${method}: ${hint ?? data.error.message ?? 'error ' + code}`, code);
  }
  if (!res.ok) throw new StremioError(`Stremio ${method}: HTTP ${res.status}`);
  return data.result as T;
}

export async function login(email: string, password: string): Promise<string> {
  const r = await call<{ authKey: string }>('login', { type: 'Login', email, password, facebook: false });
  return r.authKey;
}

export async function logout(authKey: string): Promise<void> {
  await call('logout', { type: 'Logout', authKey });
}

export async function getUser(authKey: string): Promise<{ _id: string; email?: string; [k: string]: unknown }> {
  return call('getUser', { type: 'GetUser', authKey });
}

/** Starts a link-code sign-in: the user opens `link` in a browser where they're signed in to Stremio. */
export async function linkCreate(): Promise<{ code: string; link: string; qrcode: string }> {
  const res = await fetch(`${LINK_API}create?type=Create`);
  const data = (await res.json()) as { result?: { code: string; link: string; qrcode: string }; error?: { message?: string } };
  if (!data.result) throw new StremioError(`Stremio link: ${data.error?.message ?? 'HTTP ' + res.status}`);
  return data.result;
}

/** Polls a link code; returns the authKey once the user approves it, otherwise undefined. */
export async function linkRead(code: string): Promise<string | undefined> {
  const res = await fetch(`${LINK_API}read?type=Read&code=${encodeURIComponent(code)}`);
  const data = (await res.json()) as { result?: { authKey?: string } };
  return data.result?.authKey || undefined;
}

export async function libraryMeta(authKey: string): Promise<[string, string][]> {
  return call('datastoreMeta', { authKey, collection: 'libraryItem' });
}

export async function libraryGet(authKey: string, ids?: string[]): Promise<StremioLibraryItem[]> {
  return call('datastoreGet', { authKey, collection: 'libraryItem', ids: ids ?? [], all: !ids });
}

export async function libraryPut(authKey: string, changes: StremioLibraryItem[]): Promise<void> {
  await call('datastorePut', { authKey, collection: 'libraryItem', changes });
}

export async function addonsGet(authKey: string): Promise<StremioAddonDescriptor[]> {
  const r = await call<{ addons: StremioAddonDescriptor[] }>('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true });
  return r.addons ?? [];
}

export async function addonsSet(authKey: string, addons: StremioAddonDescriptor[]): Promise<void> {
  await call('addonCollectionSet', { type: 'AddonCollectionSet', authKey, addons });
}
