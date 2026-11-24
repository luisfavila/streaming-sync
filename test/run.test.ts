// runWrite: the whole write to To, on an in-memory provider.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type AddonEntry, type ChangeSet, SCOPES, type Snapshot, emptySnapshot } from '../src/model.ts';
import { type ApplyReport, type Logger, type Provider, emptyReport } from '../src/providers/types.ts';
import { selectionKey, selectedChanges } from '../src/sync/compare.ts';
import { plan } from '../src/sync/plan.ts';
import { runWrite } from '../src/sync/run.ts';

const at = '2024-01-01T00:00:00.000Z';
const snap = (s: Partial<Snapshot>): Snapshot => ({ ...emptySnapshot(), ...s });
const addon = (name: string): AddonEntry => ({ manifestUrl: `https://addons.example/${name}/manifest.json`, name, enabled: true });

/** A To app kept in memory. `between` runs once after the first read, as if To changed elsewhere. */
function memoryProvider(state: Snapshot, between?: (s: Snapshot) => void) {
  const calls = { reads: 0, applied: [] as ChangeSet[], savedAddons: [] as AddonEntry[][] };
  const provider: Provider = {
    app: 'stremio',
    label: 'memory',
    canDisableAddons: false,
    async read() {
      calls.reads++;
      const copy = structuredClone(state);
      if (calls.reads === 1) between?.(state);
      return copy;
    },
    async apply(changes): Promise<ApplyReport> {
      calls.applied.push(changes);
      state.library.push(...changes.library);
      state.watched.push(...changes.watched);
      const r = emptyReport();
      r.written.library = changes.library.length;
      r.written.watched = changes.watched.length;
      return r;
    },
    async saveAddons(list): Promise<ApplyReport> {
      calls.savedAddons.push(list);
      state.addons = list.filter((a) => a.enabled !== false);
      return emptyReport();
    },
  };
  return { provider, calls, state };
}

const quiet = (): Logger & { warnings: string[] } => {
  const warnings: string[] = [];
  return { warnings, info: () => {}, warn: (m) => warnings.push(m) };
};

const from = snap({
  library: [
    { id: 'tt1', type: 'movie', name: 'One' },
    { id: 'tt2', type: 'movie', name: 'Two' },
    { id: 'tt3', type: 'movie', name: 'Three' },
  ],
  watched: [{ id: 'tt1', type: 'movie', watchedAt: at }],
});

test('writes only the confirmed, still-ticked changes, then reports nothing left', async () => {
  const to = memoryProvider(snap({}));
  const excluded = new Set([selectionKey('library', 'tt3')]);
  const confirmed = selectedChanges(plan(from, await to.provider.read(SCOPES, quiet()), SCOPES), excluded);
  // A title added on From after the confirmation is not written.
  const fromLater = snap({ ...from, library: [...from.library, { id: 'tt4', type: 'movie', name: 'Four' }] });
  const log = quiet();
  const out = await runWrite({ from: fromLater, to: to.provider, toLabel: 'To', confirmed, excluded, loadedAddons: [], readAfter: () => to.provider.read(SCOPES, log), log, settleMs: 0 });
  assert.deepEqual(to.state.library.map((e) => e.id), ['tt1', 'tt2']);
  assert.deepEqual(to.state.watched.map((e) => e.id), ['tt1']);
  assert.equal(out.report.written.library, 2);
  assert.equal(out.left, 0);
  assert.equal(to.calls.savedAddons.length, 0, 'add-ons left alone when not asked');
});

test('reads To again before writing, and skips what To got in the meantime', async () => {
  // tt2 lands on To (e.g. from a phone) between the page's read and the write.
  const to = memoryProvider(snap({}), (s) => s.library.push({ id: 'tt2', type: 'movie', name: 'Two' }));
  const confirmed = selectedChanges(plan(from, await to.provider.read(SCOPES, quiet()), SCOPES), new Set());
  const log = quiet();
  await runWrite({ from, to: to.provider, toLabel: 'To', confirmed, excluded: new Set(), loadedAddons: [], readAfter: () => to.provider.read(SCOPES, log), log, settleMs: 0 });
  assert.deepEqual(to.calls.applied[0]!.library.map((e) => e.id), ['tt1', 'tt3']);
});

test("doesn't save the add-on list when To's add-ons changed since they were loaded", async () => {
  const to = memoryProvider(snap({ addons: [addon('a')] }));
  const loaded = (await to.provider.read(SCOPES, quiet())).addons;
  to.state.addons.push(addon('installed-elsewhere'));
  const log = quiet();
  const out = await runWrite({ to: to.provider, toLabel: 'To', confirmed: selectedChanges(plan(snap({}), snap({}), SCOPES), new Set()), excluded: new Set(), addons: [addon('a'), addon('b')], loadedAddons: loaded, readAfter: () => to.provider.read(SCOPES, log), log, settleMs: 0 });
  assert.equal(to.calls.savedAddons.length, 0);
  assert.equal(out.addonsLeft, 0);
  assert.match(log.warnings[0]!, /add-ons changed since the page loaded them/);
});

test('saves the add-on list and checks it landed', async () => {
  const to = memoryProvider(snap({ addons: [addon('a')] }));
  const loaded = (await to.provider.read(SCOPES, quiet())).addons;
  const log = quiet();
  const wanted = [addon('b'), addon('a'), { ...addon('off'), enabled: false }];
  const out = await runWrite({ to: to.provider, toLabel: 'To', confirmed: selectedChanges(plan(snap({}), snap({}), SCOPES), new Set()), excluded: new Set(), addons: wanted, loadedAddons: loaded, readAfter: () => to.provider.read(SCOPES, log), log, settleMs: 0 });
  assert.deepEqual(to.calls.savedAddons, [wanted]);
  // This app can't switch add-ons off, so the switched-off one isn't expected.
  assert.equal(out.addonsLeft, 0);
});
