// Round trip through in-memory fakes of the Stremio and Nuvio APIs (request shapes as in the apps'
// own source): Stremio A → Nuvio → Stremio B. Checks that nothing is lost on the way, that writes
// use the right shapes, and that syncing again finds nothing left to do.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { SCOPES, type Snapshot } from '../src/model.ts';
import { NuvioClient } from '../src/providers/nuvio/api.ts';
import { NuvioProvider } from '../src/providers/nuvio/provider.ts';
import { orderVideoIds, WatchedBitField } from '../src/providers/stremio/bitfield.ts';
import { StremioProvider } from '../src/providers/stremio/provider.ts';
import type { Logger, Provider } from '../src/providers/types.ts';
import { countChanges, plan } from '../src/sync/plan.ts';
import { fakeFetch, type Item, MOVIE, nuvio, past, SERIES, seriesVideos, stremio } from './fakes.ts';

const quiet: Logger = { info: () => {}, warn: () => {} };

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = fakeFetch as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

function stremioAccount(key: string, items: Item[] = [], addons: any[] = []) {
  stremio[key] = { items: new Map(items.map(i => [i._id, i])), addons };
  return new StremioProvider(key, `stremio:${key}`);
}
const nuvioProvider = () =>
  new NuvioProvider({
    client: new NuvioClient({ accessToken: 'fake-access', refreshToken: 'r', expiresAt: Date.now() / 1000 + 3600 }, () => {}),
    profileId: 1,
    clientId: 'streaming-sync-test-client',
    label: 'nuvio',
  });

async function sync(from: Provider, to: Provider) {
  const p = plan(await from.read(SCOPES, quiet), await to.read(SCOPES, quiet), SCOPES);
  const report = await to.apply(p.changes, quiet);
  return { plan: p, report };
}

function baseState(i: Partial<Item>): Item['state'] {
  return {
    lastWatched: null,
    timeWatched: 0,
    timeOffset: 0,
    overallTimeWatched: 0,
    timesWatched: 0,
    flaggedWatched: 0,
    duration: 0,
    video_id: null,
    watched: null,
    noNotif: false,
    ...i,
  };
}

test('Stremio → Nuvio → Stremio keeps library, watched, progress and add-ons', async () => {
  // Source: the show is fully watched up to S1E3 plus S2E1 (all aired regular episodes), with
  // progress mid-way through a rewatch of S1E2; a movie watched and in the library; an extra
  // movie only in Continue Watching; three add-ons, one local-only.
  const ids = orderVideoIds(seriesVideos);
  const bf = WatchedBitField.empty(ids);
  for (const id of [`${SERIES}:1:1`, `${SERIES}:1:2`, `${SERIES}:1:3`, `${SERIES}:2:1`]) bf.setVideo(id, true);
  const A = stremioAccount(
    'A',
    [
      {
        _id: SERIES,
        name: 'Test Show',
        type: 'series',
        poster: 'https://img.example/show.jpg',
        removed: false,
        temp: false,
        _ctime: past(500),
        _mtime: past(10),
        state: baseState({ watched: bf.toString(), lastWatched: past(10), video_id: `${SERIES}:2:1`, timesWatched: 4 }),
      },
      {
        _id: MOVIE,
        name: 'Test Movie',
        type: 'movie',
        poster: 'https://img.example/movie.jpg',
        removed: false,
        temp: false,
        _ctime: past(300),
        _mtime: past(20),
        state: baseState({ timesWatched: 1, flaggedWatched: 1, lastWatched: past(20) }),
      },
      {
        _id: 'tt0000300',
        name: 'Half Watched',
        type: 'movie',
        poster: null,
        removed: true,
        temp: true,
        _ctime: past(5),
        _mtime: past(2),
        state: baseState({ timeOffset: 1_800_000, duration: 6_000_000, video_id: 'tt0000300', lastWatched: past(2) }),
      },
      { _id: 'yt_id:abc', name: 'A channel', type: 'other', removed: false, temp: false, _mtime: past(1), state: baseState({}) },
    ],
    [
      { transportUrl: 'https://addons.example/one/manifest.json', manifest: { id: 'one', name: 'One', version: '1' } },
      { transportUrl: 'https://addons.example/two/manifest.json', manifest: { id: 'two', name: 'Two', version: '1' } },
      {
        transportUrl: 'http://127.0.0.1:11470/local-addon/manifest.json',
        manifest: { id: 'local', name: 'Local Files', version: '1' },
      },
    ],
  );
  const N = nuvioProvider();

  const first = await sync(A, N);
  assert.deepEqual(first.report.skipped, []);
  assert.deepEqual(
    first.plan.notes.map(n => n.key),
    ['Local Files'],
  );
  // Nuvio rows look like the app's.
  assert.deepEqual([...nuvio.library.keys()].sort(), [`movie:${MOVIE}`, `series:${SERIES}`]);
  assert.equal(nuvio.library.get(`series:${SERIES}`).name, 'Test Show');
  assert.ok(nuvio.watched.has(`${SERIES}|null|null`), 'series-level watched mark for a fully watched show');
  assert.ok(nuvio.watched.has(`${SERIES}|1|2|`.slice(0, -1)));
  assert.equal(nuvio.watched.get(`${MOVIE}|null|null`).title, 'Test Movie');
  const prog = nuvio.progress.get('tt0000300');
  assert.deepEqual([prog.video_id, prog.position, prog.duration], ['tt0000300', 1_800_000, 6_000_000]);
  assert.deepEqual(
    nuvio.addons.map(a => [a.url, a.sort_order, a.enabled]),
    [
      ['https://addons.example/one/manifest.json', 0, true],
      ['https://addons.example/two/manifest.json', 1, true],
    ],
  );

  // Syncing again finds nothing to do.
  const again = await sync(A, N);
  assert.equal(countChanges(again.plan.changes), 0);

  // Nuvio → a fresh Stremio account.
  const B = stremioAccount('B');
  const third = await sync(N, B);
  assert.deepEqual(third.report.skipped, []);
  const bItems = stremio.B!.items;
  const show = bItems.get(SERIES)!;
  assert.equal(show.removed, false);
  assert.deepEqual(WatchedBitField.parse(show.state.watched, ids).watchedVideoIds(), [
    `${SERIES}:1:1`,
    `${SERIES}:1:2`,
    `${SERIES}:1:3`,
    `${SERIES}:2:1`,
  ]);
  assert.equal(bItems.get(MOVIE)!.state.flaggedWatched, 1);
  const half = bItems.get('tt0000300')!;
  assert.deepEqual([half.removed, half.temp, half.state.timeOffset, half.state.duration], [true, true, 1_800_000, 6_000_000]);
  assert.deepEqual(
    stremio.B!.addons.map((a: any) => a.manifest.name),
    ['Example one', 'Example two'],
  );

  // And B now matches A for everything that can move between apps.
  const a: Snapshot = await A.read(SCOPES, quiet);
  const b: Snapshot = await stremioAccount('B2', [...bItems.values()], stremio.B!.addons).read(SCOPES, quiet);
  assert.equal(countChanges(plan(a, b, SCOPES).changes), 0);
});

test('a Nuvio series-level mark becomes every aired episode on Stremio', async () => {
  nuvio.library.clear();
  nuvio.watched.clear();
  nuvio.progress.clear();
  nuvio.addons = [];
  nuvio.watched.set(`${SERIES}|null|null`, {
    content_id: SERIES,
    content_type: 'series',
    title: 'Test Show',
    season: null,
    episode: null,
    watched_at: Date.now() - 1000,
  });
  const C = stremioAccount('C');
  const r = await sync(nuvioProvider(), C);
  assert.deepEqual(r.report.skipped, []);
  const show = stremio.C!.items.get(SERIES)!;
  // Specials (season 0) are not part of "watched the series".
  assert.deepEqual(WatchedBitField.parse(show.state.watched, orderVideoIds(seriesVideos)).watchedVideoIds(), [
    `${SERIES}:1:1`,
    `${SERIES}:1:2`,
    `${SERIES}:1:3`,
    `${SERIES}:2:1`,
  ]);
  assert.equal(show.removed, true, 'watching something does not add it to the library');
});

test('saving an add-on list: Stremio keeps built-in add-ons, Nuvio keeps the on/off switch', async () => {
  const cinemeta = {
    transportUrl: 'https://v3-cinemeta.strem.io/manifest.json',
    manifest: { id: 'cinemeta', name: 'Cinemeta', version: '1' },
    flags: { official: true, protected: true },
  };
  const one = { transportUrl: 'https://addons.example/one/manifest.json', manifest: { id: 'one', name: 'One', version: '1' } };
  const two = { transportUrl: 'https://addons.example/two/manifest.json', manifest: { id: 'two', name: 'Two', version: '1' } };
  const S = stremioAccount('SAVE', [], [cinemeta, one, two]);
  const before = (await S.read(['addons'], quiet)).addons;
  assert.equal(before[0]!.protected, true);
  // Drop Cinemeta (not allowed) and One, move Two up, add Three, and one that's switched off.
  const r = await S.saveAddons(
    [
      { manifestUrl: two.transportUrl },
      { manifestUrl: 'https://addons.example/three/manifest.json' },
      { manifestUrl: 'https://addons.example/off/manifest.json', enabled: false },
    ],
    quiet,
  );
  assert.equal(r.written.addons, 1);
  assert.deepEqual(
    stremio.SAVE!.addons.map((a: any) => a.manifest.id),
    ['cinemeta', 'two', 'three'],
  );
  assert.deepEqual(stremio.SAVE!.addons[1], two, 'existing descriptors are kept as they were');

  nuvio.addons = [{ url: 'https://addons.example/one/manifest.json', name: 'One', enabled: true, sort_order: 0 }];
  const N = nuvioProvider();
  assert.equal(N.addonsLocked, undefined);
  await N.saveAddons(
    [
      { manifestUrl: 'https://addons.example/two/manifest.json', name: 'Two', enabled: false },
      { manifestUrl: 'https://addons.example/one/manifest.json', name: 'One', enabled: true },
    ],
    quiet,
  );
  assert.deepEqual(
    nuvio.addons.map((a: any) => [a.name, a.enabled, a.sort_order]),
    [
      ['Two', false, 0],
      ['One', true, 1],
    ],
  );
  assert.deepEqual(
    (await N.read(['addons'], quiet)).addons.map(a => a.enabled),
    [false, true],
  );
  nuvio.addons = [];
});

test('Stremio reads fetch the library afresh, so a write builds on current data', async () => {
  const S = stremioAccount('FRESH', [
    {
      _id: MOVIE,
      name: 'Test Movie',
      type: 'movie',
      removed: false,
      temp: false,
      _ctime: past(10),
      _mtime: past(10),
      state: baseState({}),
    },
  ]);
  assert.equal((await S.read(['library'], quiet)).library.length, 1);
  stremio.FRESH!.items.get(MOVIE)!.removed = true; // removed on another device meanwhile
  assert.equal((await S.read(['library'], quiet)).library.length, 0);
});

test('concurrent Nuvio requests with an expired token share one refresh', async () => {
  let refreshes = 0;
  const counting = (async (input: any, init?: RequestInit) => {
    if (String(input).includes('grant_type=refresh_token')) refreshes++;
    return fakeFetch(input, init);
  }) as typeof fetch;
  globalThis.fetch = counting;
  try {
    let rotated = 0;
    const client = new NuvioClient(
      { accessToken: 'old', refreshToken: 'single-use', expiresAt: Date.now() / 1000 - 10 },
      () => rotated++,
    );
    await Promise.all([
      client.rpc('sync_pull_profiles'),
      client.rpc('sync_pull_profiles'),
      client.select('addons', 'select=url&profile_id=eq.1'),
    ]);
    assert.equal(refreshes, 1);
    assert.equal(rotated, 1);
  } finally {
    globalThis.fetch = fakeFetch as typeof fetch;
  }
});

test('Stremio → Trakt → Nuvio: watchlist, history (no duplicate plays) and paused playback', async () => {
  const { TraktClient } = await import('../src/providers/trakt/api.ts');
  const { TraktProvider } = await import('../src/providers/trakt/provider.ts');
  const { trakt, TRAKT_APP } = await import('./fakes.ts');
  const traktSide = () =>
    new TraktProvider(
      new TraktClient(
        TRAKT_APP,
        { accessToken: 'trakt-access', refreshToken: 'r', expiresAt: Date.now() / 1000 + 86400 },
        () => {},
        { writeIntervalMs: 0 },
      ),
      'trakt',
    );

  // Stremio: a show with every aired episode watched (so it also carries a whole-series mark), a
  // watched movie, and a movie 30% in.
  const bf = WatchedBitField.empty(orderVideoIds(seriesVideos));
  for (const id of [`${SERIES}:1:1`, `${SERIES}:1:2`, `${SERIES}:1:3`, `${SERIES}:2:1`]) bf.setVideo(id, true);
  const S = stremioAccount('TRAKTSRC', [
    {
      _id: SERIES,
      name: 'Test Show',
      type: 'series',
      removed: false,
      temp: false,
      _ctime: past(500),
      _mtime: past(10),
      state: baseState({ watched: bf.toString(), lastWatched: past(10), video_id: `${SERIES}:2:1`, timesWatched: 4 }),
    },
    {
      _id: MOVIE,
      name: 'Test Movie',
      type: 'movie',
      removed: false,
      temp: false,
      _ctime: past(300),
      _mtime: past(20),
      state: baseState({ timesWatched: 1, flaggedWatched: 1, lastWatched: past(20) }),
    },
    {
      _id: 'tt0000300',
      name: 'Half Watched',
      type: 'movie',
      removed: true,
      temp: true,
      _ctime: past(5),
      _mtime: past(2),
      state: baseState({ timeOffset: 1_800_000, duration: 6_000_000, video_id: 'tt0000300', lastWatched: past(2) }),
    },
  ]);

  const first = await sync(S, traktSide());
  assert.deepEqual(first.report.skipped, []);
  // Both titles are watched, so they're in Trakt's history rather than on its watchlist (Trakt
  // would take them off it anyway); Trakt's library is the watchlist plus everything watched.
  assert.deepEqual(trakt.watchlist, []);
  const traktLibrary = (await traktSide().read(['library'], quiet)).library.map(e => e.id).sort();
  assert.deepEqual(traktLibrary, [SERIES, MOVIE].sort());
  // The whole-series mark and the four episodes overlap: each episode gets exactly one play.
  assert.deepEqual(trakt.history.map(h => `${h.imdb}:${h.season ?? ''}:${h.episode ?? ''}`).sort(), [
    `${SERIES}:1:1`,
    `${SERIES}:1:2`,
    `${SERIES}:1:3`,
    `${SERIES}:2:1`,
    `${MOVIE}::`,
  ]);
  assert.deepEqual(
    trakt.playback.map(p => [p.imdb, p.progress]),
    [['tt0000300', 30]],
  );

  // Again: nothing left to do, and no plays added.
  const again = await sync(S, traktSide());
  assert.equal(countChanges(again.plan.changes), 0, JSON.stringify(again.plan.changes));
  assert.equal(trakt.history.length, 5);

  // Trakt → Nuvio: the whole-series mark comes from Trakt's history, the position from the runtime.
  nuvio.library.clear();
  nuvio.watched.clear();
  nuvio.progress.clear();
  const toNuvio = await sync(traktSide(), nuvioProvider());
  assert.deepEqual(toNuvio.report.skipped, []);
  assert.ok(nuvio.watched.has(`${SERIES}|null|null`), 'whole-series mark');
  assert.ok(nuvio.watched.has(`${SERIES}|2|1`));
  assert.ok(nuvio.watched.has(`${MOVIE}|null|null`));
  assert.equal(nuvio.progress.get('tt0000300')?.position, 1_800_000);
  assert.equal(nuvio.progress.get('tt0000300')?.duration, 6_000_000);
  assert.deepEqual(
    [...nuvio.library.values()].map((r: any) => r.content_id).sort(),
    [SERIES, MOVIE].sort(),
    'watched titles count as Trakt library',
  );
});

test('Trakt link code opens the activation page with the code filled in, and signs in without a secret', async () => {
  const { traktLink } = await import('../src/auth.ts');
  const { trakt } = await import('./fakes.ts');
  const before = trakt.secretsSent;
  const link = await traktLink({ clientId: 'test-client' });
  assert.equal(link.code, 'ABCD1234');
  assert.equal(link.url, 'https://trakt.tv/activate/ABCD1234');
  const account = await link.wait(new AbortController().signal);
  assert.equal(account.who, 'traktuser');
  assert.equal(trakt.secretsSent, before, 'no secret sent');
});

test('Trakt writes: small batches, a search for titles Trakt can’t match by IMDb id, and playback limits', async () => {
  const { TraktClient } = await import('../src/providers/trakt/api.ts');
  const { TraktProvider } = await import('../src/providers/trakt/provider.ts');
  const { trakt, TRAKT_APP } = await import('./fakes.ts');
  trakt.watchlist = [];
  trakt.history = [];
  trakt.playback = [];
  trakt.writes = [];
  const T = new TraktProvider(
    new TraktClient(
      TRAKT_APP,
      { accessToken: 'trakt-access', refreshToken: 'r', expiresAt: Date.now() / 1000 + 86400 },
      () => {},
      { writeIntervalMs: 0 },
    ),
    'trakt',
  );
  await T.read(SCOPES, quiet);
  const warnings: string[] = [];
  const log: Logger = { info: () => {}, warn: w => warnings.push(w) };

  // 250 episodes over 5 seasons, plus a movie Trakt only finds through search.
  const watched = Array.from({ length: 250 }, (_, i) => ({
    id: SERIES,
    type: 'series' as const,
    season: Math.floor(i / 50) + 1,
    episode: (i % 50) + 1,
    watchedAt: past(30),
  }));
  const r = await T.apply(
    {
      library: [{ id: 'tt0000400', type: 'movie', name: 'Search Only' }],
      watched: [...watched, { id: 'tt0000400', type: 'movie', watchedAt: past(3) }],
      progress: [
        { id: MOVIE, type: 'movie', positionMs: 10_000, durationMs: 6_000_000, updatedAt: past(1) }, // under 1%
        { id: 'tt0000300', type: 'movie', positionMs: 5_400_000, durationMs: 6_000_000, updatedAt: past(1) }, // 90%
      ],
      addons: [],
    },
    log,
  );

  assert.deepEqual(trakt.watchlist, [], 'watched, so in the history rather than on the watchlist');
  assert.equal(trakt.history.length, 251, 'every episode, and the movie found through search');
  assert.ok(trakt.history.some(h => h.imdb === 'tt0000400'));
  assert.equal(r.written.watched, 251);
  const historyWrites = trakt.writes.filter(w => w.path === '/sync/history');
  assert.ok(historyWrites.length >= 3, `sent in several requests (${historyWrites.length})`);
  assert.ok(
    historyWrites.every(w => w.size <= 100),
    `each request carries at most 100 plays: ${historyWrites.map(w => w.size)}`,
  );
  assert.deepEqual(trakt.playback, [], 'nothing under 1% or at 80%+ is sent');
  // Reading back goes through every page of the history (the fake pages at 100).
  const after = await T.read(SCOPES, quiet);
  assert.equal(after.watched.filter(w => w.episode !== undefined).length, 250, 'all 250 episodes read back');
  assert.deepEqual(
    r.skipped.map(s => s.scope),
    ['progress', 'progress'],
  );
  assert.deepEqual(warnings, []);
});

test('Trakt: an unwatched library title goes on the watchlist (found through search) and stays there', async () => {
  const { TraktClient } = await import('../src/providers/trakt/api.ts');
  const { TraktProvider } = await import('../src/providers/trakt/provider.ts');
  const { trakt, TRAKT_APP } = await import('./fakes.ts');
  trakt.watchlist = [];
  trakt.history = [];
  const T = new TraktProvider(
    new TraktClient(
      TRAKT_APP,
      { accessToken: 'trakt-access', refreshToken: 'r', expiresAt: Date.now() / 1000 + 86400 },
      () => {},
      { writeIntervalMs: 0 },
    ),
    'trakt',
  );
  await T.read(SCOPES, quiet);
  await T.apply(
    {
      library: [
        { id: 'tt0000400', type: 'movie', name: 'Search Only' },
        { id: MOVIE, type: 'movie', name: 'Test Movie' },
      ],
      watched: [{ id: MOVIE, type: 'movie', watchedAt: past(1) }],
      progress: [],
      addons: [],
    },
    quiet,
  );
  assert.deepEqual(
    trakt.watchlist.map(w => w.imdb),
    ['tt0000400'],
    'found through search; the watched movie is in the history instead',
  );
  const lib = (await T.read(SCOPES, quiet)).library.map(e => e.id).sort();
  assert.deepEqual(lib, [MOVIE, 'tt0000400'].sort());
});

test('Trakt: a show with an unmatched episode is not sent again (no duplicate plays)', async () => {
  const { TraktClient } = await import('../src/providers/trakt/api.ts');
  const { TraktProvider } = await import('../src/providers/trakt/provider.ts');
  const { trakt, TRAKT_APP } = await import('./fakes.ts');
  trakt.history = [];
  const T = new TraktProvider(
    new TraktClient(
      TRAKT_APP,
      { accessToken: 'trakt-access', refreshToken: 'r', expiresAt: Date.now() / 1000 + 86400 },
      () => {},
      { writeIntervalMs: 0 },
    ),
    'trakt',
  );
  await T.read(SCOPES, quiet);
  const r = await T.apply(
    {
      library: [],
      watched: [1, 2, 3, 99].map(episode => ({ id: SERIES, type: 'series' as const, season: 1, episode, watchedAt: past(2) })),
      progress: [],
      addons: [],
    },
    quiet,
  );
  assert.equal(trakt.history.length, 3, 'each matched episode gets one play');
  assert.deepEqual(
    r.skipped.map(s => [s.key, s.reason]),
    [[SERIES, 'Trakt didn’t match some of its episodes (season 1); its episode numbering may differ']],
  );
});
