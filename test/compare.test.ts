import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptySnapshot, SCOPES, type Snapshot } from '../src/model.ts';
import {
  addonDiff,
  addonDiffSize,
  initialAddonDraft,
  libraryRows,
  progressRows,
  selectedChanges,
  selectionKey,
  watchedRows,
  withinConfirmed,
} from '../src/sync/compare.ts';
import { plan } from '../src/sync/plan.ts';

const snap = (s: Partial<Snapshot>): Snapshot => ({ ...emptySnapshot(), ...s });
const at = (d: number) => new Date(Date.UTC(2024, 0, d)).toISOString();

const source = snap({
  library: [
    { id: 'tt1', type: 'movie', name: 'Both' },
    { id: 'tt2', type: 'series', name: 'From only' },
  ],
  watched: [
    { id: 'tt2', type: 'series', season: 1, episode: 1, watchedAt: at(1), name: 'From only' },
    { id: 'tt2', type: 'series', season: 1, episode: 2, watchedAt: at(2), name: 'From only' },
    { id: 'tt1', type: 'movie', watchedAt: at(1) },
  ],
  progress: [
    { id: 'tt5', type: 'movie', positionMs: 10, durationMs: 100, updatedAt: at(9) },
    { id: 'tt6', type: 'movie', positionMs: 10, durationMs: 100, updatedAt: at(1) },
  ],
  addons: [
    { manifestUrl: 'https://a.example/manifest.json', name: 'A', enabled: true },
    { manifestUrl: 'https://off.example/manifest.json', name: 'Off', enabled: false },
  ],
});
const target = snap({
  library: [
    { id: 'tt1', type: 'movie', name: 'Both' },
    { id: 'tt3', type: 'movie', name: 'To only' },
  ],
  watched: [
    { id: 'tt2', type: 'series', season: 1, episode: 1, watchedAt: at(3) },
    { id: 'tt1', type: 'movie', watchedAt: at(1) },
  ],
  progress: [{ id: 'tt6', type: 'movie', positionMs: 50, durationMs: 100, updatedAt: at(5) }],
  addons: [{ manifestUrl: 'https://mine.example/manifest.json', name: 'Mine', enabled: true }],
});
const p = plan(source, target, SCOPES);

test('library rows say which side has each title, things to copy first', () => {
  const rows = libraryRows(source, target, p);
  assert.deepEqual(
    rows.map(r => [r.name, r.state]),
    [
      ['From only', 'copy'],
      ['Both', 'both'],
      ['To only', 'toOnly'],
    ],
  );
});

test('watched rows group episodes per title and list the missing ones', () => {
  const rows = watchedRows(source, target, p);
  const show = rows.find(r => r.id === 'tt2')!;
  assert.equal(show.state, 'copy');
  assert.equal(show.from?.length, 2);
  assert.equal(show.to?.length, 1);
  assert.deepEqual(
    show.missing.map(e => e.episode),
    [2],
  );
  assert.equal(rows.find(r => r.id === 'tt1')!.state, 'both');
});

test('progress rows: newer on From is copied, newer on To is not', () => {
  const rows = progressRows(source, target, p);
  assert.equal(rows.find(r => r.id === 'tt5')!.state, 'copy');
  assert.equal(rows.find(r => r.id === 'tt6')!.state, 'both');
});

test('unticked titles are left out of the write, everything else stays in', () => {
  const all = selectedChanges(p, new Set());
  assert.deepEqual(
    all.library.map(e => e.id),
    ['tt2'],
  );
  assert.equal(all.watched.length, 1);
  const some = selectedChanges(p, new Set([selectionKey('library', 'tt2'), selectionKey('progress', 'tt5')]));
  assert.deepEqual(some.library, []);
  assert.equal(some.watched.length, 1, 'unticking the library entry leaves its watched episodes ticked');
  assert.deepEqual(some.progress, []);
  assert.deepEqual(some.addons, [], 'add-ons go through the add-on list instead');
});

test("add-on draft: To's own first, then From's missing; switched-off ones only where the app has a switch", () => {
  assert.deepEqual(
    initialAddonDraft(p, target, true).map(a => [a.name, a.enabled]),
    [
      ['Mine', true],
      ['A', true],
      ['Off', false],
    ],
  );
  assert.deepEqual(
    initialAddonDraft(p, target, false).map(a => a.name),
    ['Mine', 'A'],
  );
});

test('add-on diff counts installs, removals, switches and reordering', () => {
  const current = [
    { manifestUrl: 'https://one.example/manifest.json', name: 'One', enabled: true },
    { manifestUrl: 'https://two.example/manifest.json', name: 'Two', enabled: true },
    { manifestUrl: 'https://three.example/manifest.json', name: 'Three', enabled: true },
  ];
  assert.equal(addonDiffSize(addonDiff(current, current)), 0);
  const draft = [
    { ...current[2]!, enabled: false },
    current[0]!,
    { manifestUrl: 'https://new.example/manifest.json', name: 'New' },
  ];
  const d = addonDiff(current, draft);
  assert.deepEqual(
    d.added.map(a => a.name),
    ['New'],
  );
  assert.deepEqual(
    d.removed.map(a => a.name),
    ['Two'],
  );
  assert.deepEqual(
    d.switched.map(a => a.name),
    ['Three'],
  );
  assert.equal(d.reordered, true);
  assert.equal(addonDiffSize(d), 4);
  // Removing one without moving the rest isn't a reorder.
  assert.equal(addonDiff(current, [current[0]!, current[2]!]).reordered, false);
});

test("entries the To app can't take are left out of the write and shown as won't copy, with the reason", () => {
  const src = snap({
    progress: [
      { id: 'tt7', type: 'movie', positionMs: 10, durationMs: 100_000, updatedAt: at(9) }, // 0.01%
      { id: 'tt8', type: 'movie', positionMs: 50_000, durationMs: 100_000, updatedAt: at(9) },
    ],
  });
  const rules = (scope: string, e: { id: string; positionMs?: number; durationMs?: number }) =>
    scope === 'progress' && e.positionMs! / e.durationMs! < 0.01 ? 'under 1% in' : undefined;
  const p = plan(src, snap({}), SCOPES, rules);
  assert.deepEqual(
    p.changes.progress.map(e => e.id),
    ['tt8'],
  );
  assert.deepEqual(
    p.notes.map(n => [n.scope, n.id, n.reason]),
    [['progress', 'tt7', 'under 1% in']],
  );
  const rows = progressRows(src, snap({}), p);
  const blocked = rows.find(r => r.id === 'tt7')!;
  assert.equal(blocked.state, 'fromOnly');
  assert.equal(blocked.blocked, 'under 1% in');
  assert.equal(rows.find(r => r.id === 'tt8')!.state, 'copy');
  assert.equal(selectedChanges(p, new Set()).progress.length, 1, 'never ticked, never written');
});

test('a write only sends what the confirmation showed, even if To changed meanwhile', () => {
  const confirmed = { library: [{ id: 'tt1', type: 'movie' as const, name: 'A' }], watched: [], progress: [], addons: [] };
  const fresh = {
    library: [
      { id: 'tt1', type: 'movie' as const, name: 'A' },
      { id: 'tt9', type: 'movie' as const, name: 'Removed on To meanwhile' },
    ],
    watched: [],
    progress: [],
    addons: [],
  };
  assert.deepEqual(
    withinConfirmed(fresh, confirmed).library.map(e => e.id),
    ['tt1'],
  );
});

test('progress rows say why they are not copied, as the planner decided', () => {
  const src = snap({
    progress: [
      {
        id: 'tt9',
        type: 'series',
        season: 1,
        episode: 5,
        positionMs: 10,
        durationMs: 100,
        updatedAt: '2024-01-02T09:00:00.000Z',
      },
    ],
  });
  const dst = snap({
    progress: [
      {
        id: 'tt9',
        type: 'series',
        season: 1,
        episode: 3,
        positionMs: 10,
        durationMs: 100,
        updatedAt: '2023-12-20T00:00:00.000Z',
      },
    ],
    watched: [{ id: 'tt9', type: 'series', season: 1, episode: 5, watchedAt: '2024-01-03T00:00:00.000Z' }],
  });
  const p = plan(src, dst, SCOPES);
  assert.equal(progressRows(src, dst, p)[0]!.why, 'already watched on To');
});
