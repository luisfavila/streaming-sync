import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptySnapshot, SCOPES, type Snapshot } from '../src/model.ts';
import { plan } from '../src/sync/plan.ts';

const snap = (s: Partial<Snapshot>): Snapshot => ({ ...emptySnapshot(), ...s });

test('adds only what the target is missing, deduplicated', () => {
  const source = snap({
    library: [
      { id: 'tt1', type: 'movie', name: 'A' },
      { id: 'tt2', type: 'series', name: 'B' },
      { id: 'tt2', type: 'series', name: 'B' },
    ],
    watched: [
      { id: 'tt1', type: 'movie', watchedAt: '2024-01-01T00:00:00.000Z' },
      { id: 'tt2', type: 'series', season: 1, episode: 1, watchedAt: '2024-01-01T00:00:00.000Z' },
      { id: 'tt2', type: 'series', season: 1, episode: 2, watchedAt: '2024-01-02T00:00:00.000Z' },
    ],
  });
  const target = snap({
    library: [{ id: 'tt1', type: 'movie', name: 'A' }],
    watched: [{ id: 'tt2', type: 'series', season: 1, episode: 1, watchedAt: '2023-01-01T00:00:00.000Z' }],
  });
  const { changes } = plan(source, target, SCOPES);
  assert.deepEqual(
    changes.library.map(e => e.id),
    ['tt2'],
  );
  assert.deepEqual(
    changes.watched.map(e => `${e.id}:${e.season ?? ''}:${e.episode ?? ''}`),
    ['tt1::', 'tt2:1:2'],
  );
});

test('progress moves forward only', () => {
  const p = (id: string, updatedAt: string, episode?: number) => ({
    id,
    type: (episode ? 'series' : 'movie') as 'series' | 'movie',
    season: episode ? 1 : undefined,
    episode,
    positionMs: 1000,
    durationMs: 5000,
    updatedAt,
  });
  const source = snap({
    progress: [
      p('tt1', '2024-05-01T00:00:00.000Z'),
      p('tt2', '2024-05-01T00:00:00.000Z', 3),
      p('tt3', '2024-05-01T00:00:00.000Z'),
    ],
  });
  const target = snap({
    progress: [p('tt1', '2024-04-01T00:00:00.000Z'), p('tt2', '2024-06-01T00:00:00.000Z', 5)],
  });
  const { changes } = plan(source, target, ['progress']);
  // tt1: source newer → update. tt2: target already further along → skip. tt3: new → add.
  assert.deepEqual(
    changes.progress.map(e => e.id),
    ['tt1', 'tt3'],
  );
});

test('add-ons match across URL spellings and skip local-only ones', () => {
  const source = snap({
    addons: [
      { manifestUrl: 'https://v3-cinemeta.strem.io/manifest.json', name: 'Cinemeta' },
      { manifestUrl: 'https://torrentio.strem.fun/manifest.json', name: 'Torrentio' },
      { manifestUrl: 'http://127.0.0.1:11470/local-addon/manifest.json', name: 'Local Files' },
    ],
  });
  const target = snap({ addons: [{ manifestUrl: 'https://V3-CINEMETA.strem.io/' }] });
  const { changes, notes } = plan(source, target, ['addons']);
  assert.deepEqual(
    changes.addons.map(a => a.name),
    ['Torrentio'],
  );
  assert.deepEqual(
    notes.map(n => n.key),
    ['Local Files'],
  );
});

test('only the requested scopes are planned', () => {
  const source = snap({
    library: [{ id: 'tt1', type: 'movie', name: 'A' }],
    addons: [{ manifestUrl: 'https://a.example/manifest.json' }],
  });
  const { changes } = plan(source, emptySnapshot(), ['addons']);
  assert.equal(changes.library.length, 0);
  assert.equal(changes.addons.length, 1);
});

test('progress for a video To finished after it is not brought back, even if To has older progress', () => {
  const source = snap({
    progress: [
      {
        id: 'tt9',
        type: 'series',
        season: 1,
        episode: 3,
        positionMs: 10,
        durationMs: 100,
        updatedAt: '2024-01-01T09:00:00.000Z',
      },
    ],
  });
  const target = snap({
    progress: [
      {
        id: 'tt9',
        type: 'series',
        season: 1,
        episode: 2,
        positionMs: 10,
        durationMs: 100,
        updatedAt: '2024-01-01T08:00:00.000Z',
      },
    ],
    watched: [{ id: 'tt9', type: 'series', season: 1, episode: 3, watchedAt: '2024-01-01T10:00:00.000Z' }],
  });
  assert.deepEqual(plan(source, target, SCOPES).changes.progress, []);
  // Watched long before From's progress (a rewatch): copied.
  target.watched[0]!.watchedAt = '2023-06-01T00:00:00.000Z';
  assert.equal(plan(source, target, SCOPES).changes.progress.length, 1);
});

test('add-on URLs match across http/https and host case, but not path case', () => {
  const add = (manifestUrl: string) => snap({ addons: [{ manifestUrl }] });
  assert.equal(
    plan(add('https://Host.example/abc/manifest.json'), add('http://host.example/abc/manifest.json'), SCOPES).changes.addons
      .length,
    0,
  );
  assert.equal(
    plan(add('https://host.example/AbC/manifest.json'), add('https://host.example/abc/manifest.json'), SCOPES).changes.addons
      .length,
    1,
  );
});

test('add-on URLs without manifest.json keep their query (often the add-on config)', async () => {
  const { normalizeManifestUrl } = await import('../src/model.ts');
  assert.equal(normalizeManifestUrl('https://addon.example/?config=abc'), 'https://addon.example/manifest.json?config=abc');
  assert.equal(normalizeManifestUrl('https://addon.example/abc/'), 'https://addon.example/abc/manifest.json');
  assert.equal(normalizeManifestUrl('stremio://addon.example/abc/manifest.json'), 'https://addon.example/abc/manifest.json');
});
