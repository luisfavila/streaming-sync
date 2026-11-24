// Provider edge cases, on the in-memory fakes.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SCOPES } from '../src/model.ts';
import { TraktClient } from '../src/providers/trakt/api.ts';
import { TraktProvider } from '../src/providers/trakt/provider.ts';
import { StremioProvider } from '../src/providers/stremio/provider.ts';
import { WatchedBitField, orderVideoIds } from '../src/providers/stremio/bitfield.ts';
import type { Logger } from '../src/providers/types.ts';
import { MOVIE, SERIES, TRAKT_APP, fakeFetch, past, seriesVideos, stremio } from './fakes.ts';

const quiet: Logger = { info: () => {}, warn: () => {} };
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = fakeFetch as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

const state = (s: Record<string, unknown>) => ({ lastWatched: past(5), timeWatched: 0, timeOffset: 0, overallTimeWatched: 0, timesWatched: 1, flaggedWatched: 0, duration: 0, video_id: null, watched: null, noNotif: false, ...s });
const changes = (c: Partial<Parameters<StremioProvider['apply']>[0]>) => ({ library: [], watched: [], progress: [], addons: [], ...c });

test("Stremio: a watched string that doesn't line up with Cinemeta is left alone, not overwritten", async () => {
  const bf = WatchedBitField.empty(orderVideoIds(seriesVideos));
  bf.setVideo(`${SERIES}:1:1`, true);
  // Same bits, but anchored on an episode Cinemeta no longer lists.
  const unaligned = `${SERIES}:9:9:7:${bf.toString().split(':').pop()}`;
  stremio.unaligned = { items: new Map([[SERIES, { _id: SERIES, name: 'Test Show', type: 'series', removed: false, temp: false, _ctime: past(50), _mtime: past(5), state: state({ watched: unaligned }) }]]), addons: [] };
  const S = new StremioProvider('unaligned', 'stremio');
  const warnings: string[] = [];
  const snap = await S.read(SCOPES, { info: () => {}, warn: (w) => warnings.push(w) });
  assert.deepEqual(snap.watched, []);
  assert.match(warnings.join('\n'), /don't match Cinemeta's episode list/);

  const report = await S.apply(changes({ watched: [{ id: SERIES, type: 'series', season: 2, episode: 1, watchedAt: past(1) }] }), quiet);
  assert.equal(report.written.watched, 0);
  assert.deepEqual(
    report.skipped.map((s) => [s.id, s.season, s.episode]),
    [[SERIES, 2, 1]],
  );
  assert.equal(stremio.unaligned.items.get(SERIES)!.state.watched, unaligned);
});

test('Stremio: a new watched movie keeps the name it was sent with', async () => {
  stremio.names = { items: new Map(), addons: [] };
  const S = new StremioProvider('names', 'stremio');
  await S.read(SCOPES, quiet);
  await S.apply(changes({ watched: [{ id: 'tmdb:603', type: 'movie', watchedAt: past(1), name: 'The Matrix' }] }), quiet);
  assert.equal(stremio.names.items.get('tmdb:603')!.name, 'The Matrix');
});

test("Trakt: lists are read to the end when the page-count header can't be read", async () => {
  const rows = Array.from({ length: 260 }, (_, i) => ({ n: i }));
  const pages: number[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get('page'));
    const limit = Number(url.searchParams.get('limit'));
    pages.push(page);
    // No X-Pagination-* headers, as when a browser hides them.
    return new Response(JSON.stringify(rows.slice((page - 1) * limit, page * limit)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = new TraktClient(TRAKT_APP, { accessToken: 'trakt-access', refreshToken: 'r', expiresAt: Date.now() / 1000 + 86400 }, () => {});
    const all = await client.getAll<{ n: number }>('/sync/history/episodes', 100);
    assert.equal(all.length, 260);
    assert.deepEqual(pages, [1, 2, 3, 4]);
  } finally {
    globalThis.fetch = fakeFetch as typeof fetch;
  }
});

test('Trakt: writing watched history without reading it first is refused (it would add plays twice)', async () => {
  const T = new TraktProvider(new TraktClient(TRAKT_APP, { accessToken: 'trakt-access', refreshToken: 'r', expiresAt: Date.now() / 1000 + 86400 }, () => {}, { writeIntervalMs: 0 }), 'trakt');
  await assert.rejects(T.apply(changes({ watched: [{ id: MOVIE, type: 'movie', watchedAt: past(1) }] }), quiet), /read the watch history before writing/);
});
