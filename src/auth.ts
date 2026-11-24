// Signing in to each app and opening a signed-in account as a Provider. Runs in the browser:
// requests go straight from the page to Stremio, Nuvio and Trakt.

import * as nuvio from './providers/nuvio/api.ts';
import { type NuvioProfile, NuvioProvider } from './providers/nuvio/provider.ts';
import * as stremio from './providers/stremio/api.ts';
import { StremioProvider } from './providers/stremio/provider.ts';
import * as trakt from './providers/trakt/api.ts';
import { TraktProvider } from './providers/trakt/provider.ts';
import type { AppKind, Provider } from './providers/types.ts';

export type { AppKind };
export const APP_NAME: Record<AppKind, string> = { stremio: 'Stremio', nuvio: 'Nuvio', trakt: 'Trakt' };

export interface StremioAccount {
  id: string;
  app: 'stremio';
  who: string;
  auth: {
    authKey: string;
    /** True when this page created the session (password or link), so it may sign it out. */
    ownsSession: boolean;
  };
}

export interface NuvioAccount {
  id: string;
  app: 'nuvio';
  who: string;
  auth: { accessToken: string; refreshToken: string; expiresAt: number; clientId: string };
  profiles: { index: number; name: string; usesPrimaryAddons: boolean; pin: boolean }[];
}

export interface TraktAccount {
  id: string;
  app: 'trakt';
  who: string;
  /** The Trakt app it signed in with is kept alongside: refreshing the session needs it. */
  auth: trakt.TraktSession & trakt.TraktApp;
}

export type Account = StremioAccount | NuvioAccount | TraktAccount;

/** Which account, and for Nuvio which profile, one side of a sync uses. */
export interface Side {
  accountId: string;
  profileIndex?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const cancelled = () => reject(new DOMException('Cancelled', 'AbortError'));
    if (signal?.aborted) return cancelled();
    const onAbort = () => {
      clearTimeout(t);
      cancelled();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');

// ---------------- Stremio ----------------

async function stremioAccount(authKey: string, ownsSession: boolean): Promise<StremioAccount> {
  const user = await stremio.getUser(authKey);
  return { id: `stremio:${user._id}`, app: 'stremio', who: user.email || user._id, auth: { authKey, ownsSession } };
}

export async function stremioPassword(email: string, password: string): Promise<StremioAccount> {
  return stremioAccount(await stremio.login(email.trim(), password), true);
}

export async function stremioToken(token: string): Promise<StremioAccount> {
  const key = token.trim().replace(/^"|"$/g, '');
  if (!key) throw new Error('Paste your Stremio token first.');
  return stremioAccount(key, false);
}

export interface LinkCode {
  code: string;
  url: string;
  wait(signal: AbortSignal): Promise<Account>;
}

export async function stremioLink(): Promise<LinkCode> {
  const { code, link } = await stremio.linkCreate();
  return {
    code,
    url: link,
    async wait(signal) {
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await sleep(3000, signal);
        const key = await stremio.linkRead(code).catch(() => undefined);
        if (key) return stremioAccount(key, true);
      }
      throw new Error('The code expired before it was approved. Get a new one.');
    },
  };
}

// ---------------- Nuvio ----------------

async function nuvioAccount(s: nuvio.Session): Promise<NuvioAccount> {
  const auth = {
    accessToken: s.access_token,
    refreshToken: s.refresh_token,
    expiresAt: s.expires_at ?? Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600),
    clientId: `streaming-sync-${randomHex(16)}`,
  };
  const user = s.user ?? (await nuvio.getUser(s.access_token));
  const client = new nuvio.NuvioClient(auth, next => Object.assign(auth, next));
  const rows = await client.rpc<NuvioProfile[]>('sync_pull_profiles').catch(() => [] as NuvioProfile[]);
  const profiles = rows.length
    ? rows
        .map(p => ({ index: p.profile_index, name: p.name, usesPrimaryAddons: !!p.uses_primary_addons, pin: !!p.pin_enabled }))
        .sort((a, b) => a.index - b.index)
    : [{ index: 1, name: 'Main', usesPrimaryAddons: false, pin: false }];
  return { id: `nuvio:${user.id}`, app: 'nuvio', who: user.email ?? user.id, auth, profiles };
}

export async function nuvioPassword(email: string, password: string): Promise<NuvioAccount> {
  return nuvioAccount(await nuvio.passwordLogin(email.trim(), password));
}

export async function nuvioLink(): Promise<LinkCode> {
  const nonce = crypto.randomUUID();
  const start = await nuvio.startDeviceLogin(nonce, 'Streaming Sync (web)');
  const code = start.user_code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return {
    code: code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code,
    url: start.verification_uri_complete,
    async wait(signal) {
      const interval = Math.min(10, Math.max(2, start.poll_interval_seconds ?? 3)) * 1000;
      let errors = 0;
      for (let i = 0; i < 120; i++) {
        await sleep(interval, signal);
        let status: string;
        try {
          status = await nuvio.pollDeviceLogin(start.device_code, nonce);
          errors = 0;
        } catch (e) {
          if (++errors >= 3) throw e;
          continue;
        }
        if (status === 'pending') continue;
        if (status !== 'approved') throw new Error(`Sign-in ${status}. Get a new code.`);
        // Right after approval the exchange can briefly fail; retry a few times.
        for (let attempt = 0; ; attempt++) {
          try {
            return await nuvioAccount(await nuvio.exchangeDeviceLogin(start.device_code, nonce));
          } catch (e) {
            if (attempt >= 4) throw e;
            await sleep(3000, signal);
          }
        }
      }
      throw new Error('The code expired before it was approved. Get a new one.');
    },
  };
}

// ---------------- Trakt ----------------

async function traktAccount(app: trakt.TraktApp, session: trakt.TraktSession): Promise<TraktAccount> {
  const client = new trakt.TraktClient(app, session, () => {});
  const u = (await client.get<{ user: trakt.TraktUser }>('/users/settings')).user;
  return { id: `trakt:${u.ids.uuid ?? u.ids.slug}`, app: 'trakt', who: u.username, auth: { ...session, ...app } };
}

/** The sign-in window and this page talk over this channel (same origin), so it works even when Trakt's pages cut the window's link to its opener. */
const TRAKT_CHANNEL = 'streaming-sync:trakt-signin';
const STATE_PREFIX = 'trakt-';
interface TraktCallback {
  state: string;
  code?: string;
  error?: string;
}

/**
 * PKCE sign-in in a separate window, so this page (and accounts it holds only in memory) stays as
 * it is. Call it straight from a click, or the browser may block the window. `open` is for tests.
 */
export async function traktPkce(
  app: trakt.TraktApp,
  redirectUri: string,
  signal: AbortSignal,
  open: (url: string) => { location: { href: string } } | null = u =>
    window.open(u, 'trakt-signin', 'popup,width=520,height=760'),
): Promise<TraktAccount> {
  // Open the window first, while the click still counts; it's pointed at Trakt once the challenge is ready.
  const win = open('about:blank');
  if (!win) throw new Error('The browser blocked the Trakt window. Allow pop-ups for this page, or sign in with a code instead.');
  const { verifier, challenge } = await trakt.pkcePair();
  const state = STATE_PREFIX + randomHex(16);
  const channel = new BroadcastChannel(TRAKT_CHANNEL);
  try {
    const reply = new Promise<TraktCallback>((resolve, reject) => {
      channel.onmessage = (e: MessageEvent<TraktCallback>) => {
        if (e.data?.state === state) resolve(e.data);
      };
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
      if (signal.aborted) reject(new DOMException('Cancelled', 'AbortError'));
    });
    win.location.href = trakt.authorizeUrl(app, redirectUri, challenge, state);
    const r = await reply;
    if (!r.code)
      throw new Error(
        r.error === 'access_denied'
          ? 'The sign-in was declined on Trakt.'
          : `Trakt sign-in failed${r.error ? `: ${r.error}` : ''}.`,
      );
    return await traktAccount(app, await trakt.exchangeCode(app, r.code, verifier, redirectUri));
  } finally {
    channel.close();
  }
}

/**
 * In the sign-in window, after Trakt sends it back here: passes the code to the page that asked
 * for it and returns true. Returns false when the URL isn't a Trakt sign-in callback.
 */
export function relayTraktCallback(params: URLSearchParams): boolean {
  const state = params.get('state');
  if (!state?.startsWith(STATE_PREFIX) || !(params.has('code') || params.has('error'))) return false;
  const msg: TraktCallback = { state, code: params.get('code') ?? undefined, error: params.get('error') ?? undefined };
  const channel = new BroadcastChannel(TRAKT_CHANNEL);
  channel.postMessage(msg);
  channel.close();
  return true;
}

export async function traktLink(app: trakt.TraktApp): Promise<LinkCode> {
  const start = await trakt.deviceCode(app);
  return {
    code: start.user_code,
    // "/activate/<code>" opens Trakt's activation page with the code filled in (it survives
    // Trakt's sign-in redirect as ?user_code=).
    url: `${start.verification_url.replace(/\/+$/, '')}/${encodeURIComponent(start.user_code)}`,
    async wait(signal) {
      let interval = Math.max(1, start.interval || 5) * 1000;
      const deadline = Date.now() + (start.expires_in || 600) * 1000;
      while (Date.now() < deadline) {
        await sleep(interval, signal);
        const r = await trakt.pollDeviceCode(app, start.device_code);
        if (r === 'pending') continue;
        if (r === 'slow') {
          interval += 1000;
          continue;
        }
        return traktAccount(app, r);
      }
      throw new Error('The code expired before it was approved. Get a new one.');
    },
  };
}

// ---------------- Opening and signing out ----------------

// One Nuvio client per account: refresh tokens work once, so two clients refreshing the same
// session would knock each other out (e.g. when syncing between two profiles of one account).
const nuvioClients = new Map<string, nuvio.NuvioClient>();
// Same for Trakt, whose refresh tokens also work once.
const traktClients = new Map<string, trakt.TraktClient>();

export function profileName(account: Account, profileIndex: number | undefined): string | undefined {
  return account.app === 'nuvio' ? account.profiles.find(p => p.index === (profileIndex ?? 1))?.name : undefined;
}

/** The account's name as shown: the email, or "@username" for Trakt. */
export function accountName(account: Account): string {
  return account.app === 'trakt' && !account.who.startsWith('@') ? `@${account.who}` : account.who;
}

export function sideLabel(account: Account, profileIndex?: number): string {
  const app = APP_NAME[account.app];
  const profile = account.app === 'nuvio' && account.profiles.length > 1 ? ` · ${profileName(account, profileIndex)}` : '';
  return `${app} (${accountName(account)}${profile})`;
}

/**
 * Opens one side of a sync. `onAuthChange` is called whenever Nuvio rotates the session's tokens,
 * so the caller can save the new ones.
 */
export function openProvider(account: Account, profileIndex: number | undefined, onAuthChange: (a: Account) => void): Provider {
  const label = sideLabel(account, profileIndex);
  if (account.app === 'stremio') return new StremioProvider(account.auth.authKey, label);
  if (account.app === 'trakt') {
    let tc = traktClients.get(account.id);
    if (!tc) {
      tc = new trakt.TraktClient(account.auth, account.auth, next => {
        Object.assign(account.auth, next);
        onAuthChange(account);
      });
      traktClients.set(account.id, tc);
    }
    return new TraktProvider(tc, label);
  }
  let client = nuvioClients.get(account.id);
  if (!client) {
    client = new nuvio.NuvioClient(account.auth, next => {
      Object.assign(account.auth, next);
      onAuthChange(account);
    });
    nuvioClients.set(account.id, client);
  }
  const index = profileIndex ?? 1;
  const p = account.profiles.find(x => x.index === index);
  return new NuvioProvider({
    client,
    profileId: index,
    clientId: account.auth.clientId,
    label,
    profile: p && { profile_index: p.index, name: p.name, uses_primary_addons: p.usesPrimaryAddons, pin_enabled: p.pin },
  });
}

/** Drops the cached API client for an account, e.g. after signing in to it again. */
export function forgetClient(accountId: string): void {
  nuvioClients.delete(accountId);
  traktClients.delete(accountId);
}

/** Ends the session if this page created it. A pasted Stremio token's session is left alone. */
export async function signOut(account: Account): Promise<void> {
  nuvioClients.delete(account.id);
  traktClients.delete(account.id);
  if (account.app === 'trakt') {
    await trakt.revoke(account.auth, account.auth.accessToken).catch(() => {});
    return;
  }
  if (account.app === 'stremio') {
    if (account.auth.ownsSession) await stremio.logout(account.auth.authKey).catch(() => {});
    return;
  }
  let access = account.auth.accessToken;
  if (account.auth.expiresAt - 60 < Date.now() / 1000)
    access = (await nuvio.refreshSession(account.auth.refreshToken).catch(() => undefined))?.access_token ?? access;
  await nuvio.signOutSession(access).catch(() => {});
}
