// Side-by-side view of two snapshots: one row per title (or add-on) saying what each side has
// and what would be copied. Pure functions, so the page and the tests share them.

import {
  type AddonEntry,
  addonKey,
  type ChangeSet,
  type LibraryEntry,
  type MediaType,
  type ProgressEntry,
  type Snapshot,
  videoKey,
  type WatchedEntry,
} from '../model.ts';
import type { Plan } from './plan.ts';

/**
 * copy: From has something To lacks. both: both have it and nothing needs copying.
 * toOnly: only To has it. fromOnly: From has something To lacks, but it won't be copied (To is
 * further along, or the To app can't take it; then `blocked` says why).
 */
export type RowState = 'copy' | 'both' | 'toOnly' | 'fromOnly';

export interface Row<T> {
  id: string;
  type: MediaType;
  name?: string;
  poster?: string;
  from?: T;
  to?: T;
  state: RowState;
  /** Why the To app can't take this title's entries, when it can't. */
  blocked?: string;
}

export type LibraryRow = Row<LibraryEntry>;
/** Watched rows hold every watched entry for the title, plus the ones that would be copied. */
export type WatchedRow = Row<WatchedEntry[]> & { missing: WatchedEntry[] };
/** Progress rows hold each side's latest progress for the title, and why it isn't copied. */
export type ProgressRow = Row<ProgressEntry> & { why?: string };

function state(copy: boolean, from: unknown, to: unknown): RowState {
  if (copy) return 'copy';
  if (from && to) return 'both';
  return to ? 'toOnly' : 'fromOnly';
}

/** Orders rows: things to copy first, then by name. */
const byStateThenName = (a: Row<unknown>, b: Row<unknown>) =>
  STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
  (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: 'base' });
const STATE_ORDER: Record<RowState, number> = { copy: 0, both: 1, toOnly: 2, fromOnly: 3 };

/** Marks rows whose entries the To app can't take (from the plan's notes). */
function markBlocked<R extends Row<unknown>>(rows: R[], plan: Plan | undefined, scope: 'library' | 'watched' | 'progress'): R[] {
  const reasons = new Map<string, string>();
  for (const n of plan?.notes ?? []) if (n.scope === scope && n.id && !reasons.has(n.id)) reasons.set(n.id, n.reason);
  for (const r of rows) {
    const reason = reasons.get(r.id);
    if (!reason) continue;
    r.blocked = reason;
    if (r.state !== 'copy') r.state = 'fromOnly';
  }
  return rows;
}

export function libraryRows(source: Snapshot | undefined, target: Snapshot | undefined, plan: Plan | undefined): LibraryRow[] {
  const rows = new Map<string, LibraryRow>();
  for (const [side, list] of [
    ['from', source?.library ?? []],
    ['to', target?.library ?? []],
  ] as const) {
    for (const e of list) {
      const r = rows.get(e.id) ?? { id: e.id, type: e.type, state: 'both' };
      r[side] ??= e;
      r.name ??= e.name || undefined;
      r.poster ??= e.poster;
      rows.set(e.id, r);
    }
  }
  const copy = new Set(plan?.changes.library.map(e => e.id));
  for (const r of rows.values()) r.state = state(copy.has(r.id), r.from, r.to);
  return markBlocked([...rows.values()], plan, 'library').sort(byStateThenName);
}

export function watchedRows(source: Snapshot | undefined, target: Snapshot | undefined, plan: Plan | undefined): WatchedRow[] {
  const rows = new Map<string, WatchedRow>();
  const row = (e: WatchedEntry) => {
    let r = rows.get(e.id);
    if (!r) {
      r = { id: e.id, type: e.type, missing: [], state: 'both' };
      rows.set(e.id, r);
    }
    r.name ??= e.name;
    return r;
  };
  for (const e of source?.watched ?? []) {
    const r = row(e);
    r.from ??= [];
    r.from.push(e);
  }
  for (const e of target?.watched ?? []) {
    const r = row(e);
    r.to ??= [];
    r.to.push(e);
  }
  for (const e of plan?.changes.watched ?? []) row(e).missing.push(e);
  for (const r of rows.values()) r.state = state(r.missing.length > 0, r.from, r.to);
  return markBlocked([...rows.values()], plan, 'watched').sort(byStateThenName);
}

export function progressRows(source: Snapshot | undefined, target: Snapshot | undefined, plan: Plan | undefined): ProgressRow[] {
  const latest = (list: ProgressEntry[]) => {
    const m = new Map<string, ProgressEntry>();
    for (const p of list) if (!m.has(p.id) || m.get(p.id)!.updatedAt < p.updatedAt) m.set(p.id, p);
    return m;
  };
  const from = latest(source?.progress ?? []);
  const to = latest(target?.progress ?? []);
  const copy = new Set(plan?.changes.progress.map(e => e.id));
  const rows = [...new Set([...from.keys(), ...to.keys()])].map((id): ProgressRow => {
    const f = from.get(id);
    const t = to.get(id);
    const e = (f ?? t)!;
    return {
      id,
      type: e.type,
      name: f?.name ?? t?.name,
      poster: f?.poster ?? t?.poster,
      from: f,
      to: t,
      state: state(copy.has(id), f, t),
      why: plan?.progressSkipped.get(id),
    };
  });
  return markBlocked(rows, plan, 'progress').sort(byStateThenName);
}

/** A display name for every title in the snapshots that has one. */
export function knownNames(...snaps: (Snapshot | undefined)[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const s of snaps) {
    if (!s) continue;
    for (const e of [...s.library, ...s.watched, ...s.progress]) if (e.name && !names.has(e.id)) names.set(e.id, e.name);
  }
  return names;
}

/** Selection is stored as what the user un-ticked, so anything new to copy starts ticked. */
export const selectionKey = (scope: 'library' | 'watched' | 'progress', id: string) => `${scope}:${id}`;

/** The plan's changes, minus the titles the user un-ticked. Add-ons are handled by the add-on list instead. */
export function selectedChanges(plan: Plan, excluded: ReadonlySet<string>): ChangeSet {
  const keep = (scope: 'library' | 'watched' | 'progress') => (e: { id: string }) => !excluded.has(selectionKey(scope, e.id));
  return {
    library: plan.changes.library.filter(keep('library')),
    watched: plan.changes.watched.filter(keep('watched')),
    progress: plan.changes.progress.filter(keep('progress')),
    addons: [],
  };
}

/**
 * The add-on list To should end up with, before any edits: To's own add-ons, then From's that it
 * lacks, in From's order. Where To can't switch add-ons off, From's switched-off ones are left out.
 */
export function initialAddonDraft(plan: Plan | undefined, target: Snapshot, canDisable: boolean): AddonEntry[] {
  const added = (plan?.changes.addons ?? [])
    .filter(a => canDisable || a.enabled !== false)
    .map(a => ({ ...a, enabled: canDisable ? a.enabled !== false : true, protected: false }));
  return [...target.addons.map(a => ({ ...a })), ...added];
}

export interface AddonDiff {
  added: AddonEntry[];
  removed: AddonEntry[];
  /** Add-ons on both lists whose on/off switch changed. */
  switched: AddonEntry[];
  reordered: boolean;
}

export function addonDiff(current: AddonEntry[], draft: AddonEntry[]): AddonDiff {
  const cur = new Map(current.map(a => [addonKey(a.manifestUrl), a]));
  const next = new Map(draft.map(a => [addonKey(a.manifestUrl), a]));
  const added = draft.filter(a => !cur.has(addonKey(a.manifestUrl)));
  const removed = current.filter(a => !next.has(addonKey(a.manifestUrl)));
  const switched = draft.filter(a => {
    const c = cur.get(addonKey(a.manifestUrl));
    return c && (c.enabled !== false) !== (a.enabled !== false);
  });
  const common = (list: AddonEntry[], other: Map<string, AddonEntry>) =>
    list.map(a => addonKey(a.manifestUrl)).filter(k => other.has(k));
  const reordered = common(current, next).join('\n') !== common(draft, cur).join('\n');
  return { added, removed, switched, reordered };
}

export const addonDiffSize = (d: AddonDiff) => d.added.length + d.removed.length + d.switched.length + (d.reordered ? 1 : 0);

/**
 * The entries of `fresh` (planned again just before writing) that were also in `confirmed` (what
 * the user saw in the confirmation). A write never sends anything the user didn't confirm.
 */
export function withinConfirmed(fresh: ChangeSet, confirmed: ChangeSet): ChangeSet {
  const keys = (list: { id: string; season?: number; episode?: number }[]) => new Set(list.map(videoKey));
  const lib = new Set(confirmed.library.map(e => e.id));
  const watched = keys(confirmed.watched);
  const progress = keys(confirmed.progress);
  return {
    library: fresh.library.filter(e => lib.has(e.id)),
    watched: fresh.watched.filter(e => watched.has(videoKey(e))),
    progress: fresh.progress.filter(e => progress.has(videoKey(e))),
    addons: [],
  };
}
