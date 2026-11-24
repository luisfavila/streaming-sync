// In-memory fakes of the Stremio, Nuvio, Trakt, Cinemeta and add-on APIs, with request shapes as in
// the apps' own source (Trakt: its API documentation). Used by the round-trip test and the browser end-to-end test.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const past = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();

// ---- Cinemeta fixtures ----
export const SERIES = 'tt0000100';
export const MOVIE = 'tt0000200';
export const seriesVideos = [
  { id: `${SERIES}:0:1`, season: 0, episode: 1, released: past(900) },
  { id: `${SERIES}:1:1`, season: 1, episode: 1, released: past(800) },
  { id: `${SERIES}:1:2`, season: 1, episode: 2, released: past(790) },
  { id: `${SERIES}:1:3`, season: 1, episode: 3, released: past(780) },
  { id: `${SERIES}:2:1`, season: 2, episode: 1, released: past(400) },
];
const metas: Record<string, unknown> = {
  [`series/${SERIES}`]: { id: SERIES, type: 'series', name: 'Test Show', poster: 'https://img.example/show.jpg', videos: seriesVideos },
  [`movie/${MOVIE}`]: { id: MOVIE, type: 'movie', name: 'Test Movie', poster: 'https://img.example/movie.jpg' },
};

// ---- Fake Stremio ----
export type Item = Record<string, any>;
export const stremio: Record<string, { items: Map<string, Item>; addons: any[] }> = {};
// ---- Fake Nuvio ----
export const nuvio = { library: new Map<string, any>(), watched: new Map<string, any>(), progress: new Map<string, any>(), addons: [] as any[], calls: [] as string[] };

// ---- Fake Trakt ----
/** Titles Trakt knows, with runtimes in minutes. */
const TRAKT_TITLES: Record<string, { title: string; runtime: number }> = {
  [SERIES]: { title: 'Test Show', runtime: 50 },
  [MOVIE]: { title: 'Test Movie', runtime: 100 },
  tt0000300: { title: 'Half Watched', runtime: 100 },
  // Trakt has this one, but only matches it by its own id (found through /search/imdb).
  tt0000400: { title: 'Search Only', runtime: 90 },
};
const TRAKT_SEARCH_ONLY = new Set(['tt0000400']);
/** Trakt's own ids for the titles above. */
const TRAKT_IDS: Record<string, number> = { [SERIES]: 100, [MOVIE]: 200, tt0000300: 300, tt0000400: 4000 };
export const TRAKT_APP = { clientId: 'test-client', clientSecret: 'test-secret' };
export const trakt = {
  approved: true,
  watchlist: [] as { type: 'movie' | 'show'; imdb: string; listed_at: string }[],
  /** One row per play. */
  history: [] as { imdb: string; season?: number; episode?: number; watched_at: string }[],
  playback: [] as { imdb: string; type: 'movie' | 'episode'; season?: number; episode?: number; progress: number; paused_at: string }[],
  refreshes: 0,
  /** /oauth calls that carried a client secret. */
  secretsSent: 0,
  /** Writes to /sync endpoints, with how many titles or plays each carried. */
  writes: [] as { path: string; size: number }[],
  /** Codes Trakt's authorize page handed out (PKCE), with what they were asked for with. */
  codes: new Map<string, { challenge: string; redirectUri: string }>(),
  /** redirect_uri of each refresh. */
  refreshRedirects: [] as string[],
};

/**
 * Trakt's authorize page, approved: checks the URL the page opened and returns the query Trakt
 * sends the window back with.
 */
export function traktAuthorize(href: string): URLSearchParams {
  const url = new URL(href);
  assert.equal(url.origin + url.pathname, 'https://auth.trakt.tv/oauth/authorize');
  const q = url.searchParams;
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('client_id'), TRAKT_APP.clientId);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
  const code = `code-${trakt.codes.size + 1}`;
  trakt.codes.set(code, { challenge: q.get('code_challenge')!, redirectUri: q.get('redirect_uri')! });
  return new URLSearchParams({ code, state: q.get('state')! });
}
const media = (imdb: string) => ({ title: TRAKT_TITLES[imdb]?.title ?? imdb, year: 2020, ids: { trakt: TRAKT_IDS[imdb] ?? 1, slug: imdb, imdb }, runtime: TRAKT_TITLES[imdb]?.runtime });

/** One page of a list, with Trakt's pagination headers (Trakt pages its lists; at most 100 here). */
function paged(url: URL, list: unknown[]): Response {
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 100);
  const page = Number(url.searchParams.get('page')) || 1;
  const pages = Math.max(1, Math.ceil(list.length / limit));
  // Like Trakt, a page past the end repeats the last one rather than coming back empty.
  const slice = list.slice((Math.min(page, pages) - 1) * limit, Math.min(page, pages) * limit);
  return new Response(JSON.stringify(slice), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Pagination-Page': String(page), 'X-Pagination-Page-Count': String(pages), 'X-Pagination-Limit': String(limit), 'X-Pagination-Item-Count': String(list.length) },
  });
}

function fakeTrakt(url: URL, method: string, headers: Headers, body: any): Response {
  const path = url.pathname;
  assert.equal(headers.get('trakt-api-key'), TRAKT_APP.clientId);
  assert.equal(headers.get('trakt-api-version'), '2');
  if (path.startsWith('/oauth/') && body?.client_secret !== undefined) trakt.secretsSent++;
  if (path === '/oauth/device/code') return reply({ device_code: 'dev-code', user_code: 'ABCD1234', verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 1 });
  if (path === '/oauth/device/token') {
    // The secret is optional since Trakt stopped issuing them; when sent, it must match.
    if (body.client_secret !== undefined) assert.equal(body.client_secret, TRAKT_APP.clientSecret);
    return trakt.approved ? reply({ access_token: 'trakt-access', refresh_token: 'trakt-refresh', expires_in: 86400, created_at: Math.floor(Date.now() / 1000) }) : reply({}, 400);
  }
  if (path === '/oauth/token' && body.grant_type === 'authorization_code') {
    // PKCE: the verifier proves it's the page that started the sign-in; no secret.
    assert.equal(body.client_secret, undefined, 'no client secret with PKCE');
    const issued = trakt.codes.get(body.code);
    if (!issued || createHash('sha256').update(body.code_verifier).digest('base64url') !== issued.challenge || body.redirect_uri !== issued.redirectUri) return reply({ error: 'invalid_grant' }, 400);
    trakt.codes.delete(body.code);
    return reply({ access_token: 'trakt-access', refresh_token: 'trakt-refresh', expires_in: 86400, created_at: Math.floor(Date.now() / 1000) });
  }
  if (path === '/oauth/token') {
    trakt.refreshes++;
    trakt.refreshRedirects.push(body.redirect_uri);
    return reply({ access_token: 'trakt-access', refresh_token: 'trakt-refresh-2', expires_in: 86400, created_at: Math.floor(Date.now() / 1000) });
  }
  if (path === '/oauth/revoke') return reply({});
  assert.equal(headers.get('authorization'), 'Bearer trakt-access');
  /** The imdb id Trakt resolves `ids` to, if any: by imdb (except search-only titles) or by Trakt id. */
  const resolve = (ids: any): string | undefined => {
    if (typeof ids?.imdb === 'string' && ids.imdb in TRAKT_TITLES && !TRAKT_SEARCH_ONLY.has(ids.imdb)) return ids.imdb;
    return Object.entries(TRAKT_IDS).find(([, t]) => t === ids?.trakt)?.[0];
  };
  const known = (ids: any) => resolve(ids) !== undefined;
  if (method === 'POST' && path.startsWith('/sync/')) {
    const plays = (body.movies?.length ?? 0) + (body.shows ?? []).reduce((n: number, s: any) => n + (s.seasons ? s.seasons.reduce((m: number, se: any) => m + se.episodes.length, 0) : 1), 0);
    trakt.writes.push({ path, size: plays });
  }
  const search = /^\/search\/imdb\/(tt\d+)$/.exec(path);
  if (search) {
    const type = url.searchParams.get('type');
    const id = search[1]!;
    return reply(id in TRAKT_TITLES ? [{ type, [type!]: media(id) }] : []);
  }
  if (path === '/users/settings') return reply({ user: { username: 'traktuser', ids: { slug: 'traktuser', uuid: 'trakt-uuid' } } });
  if (method === 'GET' && path.startsWith('/sync/watchlist/')) {
    const type = path.endsWith('movies') ? 'movie' : 'show';
    return paged(url, trakt.watchlist.filter((w) => w.type === type).map((w) => ({ listed_at: w.listed_at, type, [type]: media(w.imdb) })));
  }
  if (method === 'POST' && path === '/sync/watchlist') {
    const added = { movies: 0, shows: 0 };
    const not_found = { movies: [] as any[], shows: [] as any[] };
    for (const kind of ['movies', 'shows'] as const)
      for (const m of body[kind] ?? []) {
        if (!known(m.ids)) not_found[kind].push(m);
        else if (!trakt.watchlist.some((w) => w.imdb === resolve(m.ids))) {
          trakt.watchlist.push({ type: kind === 'movies' ? 'movie' : 'show', imdb: resolve(m.ids)!, listed_at: new Date().toISOString() });
          added[kind]++;
        }
      }
    return reply({ added, existing: { movies: 0, shows: 0 }, not_found }, 201);
  }
  if (path === '/sync/watched/movies') {
    const by = new Map<string, any>();
    for (const h of trakt.history.filter((h) => h.season === undefined)) {
      const cur = by.get(h.imdb) ?? { plays: 0, last_watched_at: h.watched_at, movie: media(h.imdb) };
      cur.plays++;
      if (h.watched_at > cur.last_watched_at) cur.last_watched_at = h.watched_at;
      by.set(h.imdb, cur);
    }
    return paged(url, [...by.values()]);
  }
  if (path === '/sync/history/episodes') {
    const plays = trakt.history.filter((h) => h.season !== undefined).sort((a, b) => b.watched_at.localeCompare(a.watched_at));
    return paged(url, plays.map((h, i) => ({ id: i + 1, watched_at: h.watched_at, action: 'watch', type: 'episode', episode: { season: h.season, number: h.episode, ids: { trakt: i } }, show: media(h.imdb) })));
  }
  if (path === '/sync/watched/shows') {
    // Since July 2026: no seasons unless extended=progress. The page shouldn't rely on it.
    assert.fail('the page reads episodes from /sync/history, not /sync/watched/shows');
  }
  if (method === 'POST' && path === '/sync/history') {
    const added = { movies: 0, episodes: 0 };
    const not_found = { movies: [] as any[], shows: [] as any[], episodes: [] as any[] };
    for (const m of body.movies ?? []) {
      if (!known(m.ids)) not_found.movies.push(m);
      else trakt.history.push({ imdb: resolve(m.ids)!, watched_at: m.watched_at }), added.movies++;
    }
    for (const sh of body.shows ?? []) {
      if (!known(sh.ids)) not_found.shows.push(sh);
      else {
        assert.ok(sh.seasons?.length, 'shows are sent with their episodes, never as a whole (that would add plays to every episode)');
        // Episode 99 doesn't exist here. Like Trakt, the rest are added and the show is still
        // listed as not found.
        let missed = false;
        for (const se of sh.seasons)
          for (const e of se.episodes) {
            if (e.number === 99) missed = true;
            else trakt.history.push({ imdb: resolve(sh.ids)!, season: se.number, episode: e.number, watched_at: e.watched_at }), added.episodes++;
          }
        if (missed) not_found.shows.push(sh);
      }
    }
    // Like Trakt: watched titles leave the watchlist.
    const watchedNow = new Set(trakt.history.map((h) => h.imdb));
    trakt.watchlist = trakt.watchlist.filter((w) => !watchedNow.has(w.imdb));
    return reply({ added, not_found }, 201);
  }
  if (path === '/sync/playback') {
    assert.equal(url.searchParams.get('extended'), 'full');
    return paged(
      url,
      trakt.playback.map((p) =>
        p.type === 'movie'
          ? { progress: p.progress, paused_at: p.paused_at, type: 'movie', movie: media(p.imdb) }
          : { progress: p.progress, paused_at: p.paused_at, type: 'episode', show: media(p.imdb), episode: { season: p.season, number: p.episode, runtime: TRAKT_TITLES[p.imdb]?.runtime } },
      ),
    );
  }
  if (method === 'POST' && path === '/scrobble/pause') {
    const imdb = (body.movie ?? body.show)?.ids?.imdb;
    if (!(imdb in TRAKT_TITLES)) return reply({}, 404);
    const entry = { imdb, type: body.movie ? ('movie' as const) : ('episode' as const), season: body.episode?.season, episode: body.episode?.number, progress: body.progress, paused_at: new Date().toISOString() };
    trakt.playback = trakt.playback.filter((p) => !(p.imdb === imdb && p.season === entry.season && p.episode === entry.episode)).concat(entry);
    return reply({ id: 1, action: 'pause', progress: body.progress }, 201);
  }
  throw new Error(`unexpected Trakt request ${method} ${url.href}`);
}

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

export async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (url.hostname === 'v3-cinemeta.strem.io') {
      const m = url.pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
      const meta = m && metas[`${m[1]}/${decodeURIComponent(m[2]!)}`];
      return meta ? reply({ meta }) : reply({}, 404);
    }
    if (url.hostname === 'addons.example') return reply({ id: url.pathname.split('/')[1], name: 'Example ' + url.pathname.split('/')[1], version: '1.0.0' });

    if (url.hostname === 'api.trakt.tv') return fakeTrakt(url, init?.method ?? 'GET', new Headers(init?.headers), body);

    if (url.hostname === 'api.strem.io') {
      const method = url.pathname.replace('/api/', '');
      if (method === 'login') return stremio[body.password] ? reply({ result: { authKey: body.password } }) : reply({ error: { code: 3, message: 'Wrong password' } });
      const acct = stremio[body.authKey];
      if (!acct) return reply({ error: { code: 1, message: 'Session does not exist' } });
      switch (method) {
        case 'getUser':
          return reply({ result: { _id: `user-${body.authKey}`, email: `${body.authKey.toLowerCase()}@stremio.test` } });
        case 'logout':
          return reply({ result: { success: true } });
        case 'datastoreGet':
          return reply({ result: [...acct.items.values()].map((i) => structuredClone(i)) });
        case 'datastorePut':
          for (const i of body.changes) acct.items.set(i._id, structuredClone(i));
          return reply({ result: { success: true } });
        case 'addonCollectionGet':
          return reply({ result: { addons: structuredClone(acct.addons) } });
        case 'addonCollectionSet':
          acct.addons = structuredClone(body.addons);
          return reply({ result: { success: true } });
      }
    }

    if (url.hostname === 'api.nuvio.tv') {
      if (url.pathname === '/auth/v1/token') {
        if (url.searchParams.get('grant_type') === 'password' && body.password !== 'nuvio-pass') return reply({ error_description: 'Invalid login credentials' }, 400);
        return reply({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600, user: { id: 'nuvio-user', email: 'me@nuvio.test' } });
      }
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake-access');
      if (url.pathname === '/rest/v1/addons') {
        assert.match(url.search, /profile_id=eq\.1/);
        return reply([...nuvio.addons].sort((a, b) => a.sort_order - b.sort_order));
      }
      const rpc = url.pathname.replace('/rest/v1/rpc/', '');
      nuvio.calls.push(rpc);
      if (rpc.startsWith('sync_push_')) {
        assert.equal(body.p_profile_id, 1);
        assert.match(body.p_origin_client_id, /^[A-Za-z0-9_-]{16,96}$/);
      }
      switch (rpc) {
        case 'sync_pull_profiles':
          return reply([{ profile_index: 1, name: 'Main', uses_primary_addons: false, pin_enabled: false }]);
        case 'sync_pull_library':
          return reply([...nuvio.library.values()].slice(body.p_offset, body.p_offset + body.p_limit));
        case 'sync_push_library_items':
          for (const r of body.p_items) nuvio.library.set(`${r.content_type}:${r.content_id}`, r);
          return reply(null);
        case 'sync_pull_watched_items':
          return reply([...nuvio.watched.values()].slice((body.p_page - 1) * body.p_page_size, body.p_page * body.p_page_size));
        case 'sync_push_watched_items':
          for (const r of body.p_items) {
            assert.equal(typeof r.watched_at, 'number');
            nuvio.watched.set(`${r.content_id}|${r.season}|${r.episode}`, r);
          }
          return reply(null);
        case 'sync_pull_watch_progress':
          return reply([...nuvio.progress.values()]);
        case 'sync_push_watch_progress':
          for (const r of body.p_entries) nuvio.progress.set(r.progress_key, r);
          return reply(null);
        case 'sync_push_addons':
          nuvio.addons = body.p_addons;
          return reply(null);
      }
    }
    throw new Error(`unexpected request ${url.href}`);
  }
}
