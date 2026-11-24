import {
  addonKey,
  type ChangeSet,
  isLocalOnlyAddon,
  type LibraryEntry,
  type ProgressEntry,
  type Scope,
  type Snapshot,
  videoKey,
  type WatchedEntry,
} from '../model.ts';

export interface PlanNote {
  scope: Scope;
  key: string;
  reason: string;
  /** The title it's about, when it's about one. */
  id?: string;
}

/** Why the target app can't take an entry (e.g. Trakt and playback under 1%), or undefined if it can. */
export type Unsupported = (
  scope: 'library' | 'watched' | 'progress',
  entry: LibraryEntry | WatchedEntry | ProgressEntry,
) => string | undefined;

export interface Plan {
  changes: ChangeSet;
  /** Things deliberately left out, so the user can see why. */
  notes: PlanNote[];
  /** Per title: why From's Continue Watching progress isn't copied (when it isn't). */
  progressSkipped: Map<string, string>;
}

/** Progress only counts if it's newer than the target's by this much (clock skew, rounding). */
const PROGRESS_SLACK_MS = 60_000;

/**
 * Works out what the target is missing compared with the source. Additive only: titles,
 * watched marks and add-ons are added, progress is updated when the source's is newer.
 * Nothing on the target is removed or un-watched.
 */
export function plan(source: Snapshot, target: Snapshot, scopes: readonly Scope[], unsupported?: Unsupported): Plan {
  const changes: ChangeSet = { library: [], watched: [], progress: [], addons: [] };
  const notes: PlanNote[] = [];
  const progressSkipped = new Map<string, string>();
  /** Entries the target can't take become notes instead of changes. */
  const accepts = (scope: 'library' | 'watched' | 'progress', e: LibraryEntry | WatchedEntry | ProgressEntry) => {
    const reason = unsupported?.(scope, e);
    if (reason) notes.push({ scope, key: scope === 'library' ? e.id : videoKey(e as WatchedEntry), reason, id: e.id });
    return !reason;
  };

  if (scopes.includes('library')) {
    const have = new Set(target.library.map(e => e.id));
    const seen = new Set<string>();
    for (const e of source.library) {
      if (have.has(e.id) || seen.has(e.id)) continue;
      seen.add(e.id);
      if (accepts('library', e)) changes.library.push(e);
    }
  }

  if (scopes.includes('watched')) {
    const have = new Set(target.watched.map(videoKey));
    const seen = new Set<string>();
    for (const e of source.watched) {
      const k = videoKey(e);
      if (have.has(k) || seen.has(k)) continue;
      seen.add(k);
      if (accepts('watched', e)) changes.watched.push(e);
    }
  }

  if (scopes.includes('progress')) {
    // Compare per title: if the target has newer progress anywhere in the title (e.g. a later
    // episode), it's further along and the source's progress would move it backwards.
    const latest = (list: ProgressEntry[]) => {
      const m = new Map<string, ProgressEntry>();
      for (const p of list) {
        const cur = m.get(p.id);
        if (!cur || cur.updatedAt < p.updatedAt) m.set(p.id, p);
      }
      return m;
    };
    const targetLatest = latest(target.progress);
    const watchedOnTarget = new Map<string, string>();
    for (const w of target.watched)
      if ((watchedOnTarget.get(videoKey(w)) ?? '') < w.watchedAt) watchedOnTarget.set(videoKey(w), w.watchedAt);
    for (const p of latest(source.progress).values()) {
      const t = targetLatest.get(p.id);
      if (t && Date.parse(t.updatedAt) + PROGRESS_SLACK_MS >= Date.parse(p.updatedAt)) {
        progressSkipped.set(
          p.id,
          Date.parse(t.updatedAt) >= Date.parse(p.updatedAt) ? 'To’s is newer' : 'about as recent as To’s',
        );
        continue;
      }
      // Finished on To: skip, unless To has progress elsewhere in the title and finished this
      // video before From's progress (a rewatch).
      const watchedAt = watchedOnTarget.get(videoKey(p));
      if (watchedAt !== undefined && (!t || watchedAt >= p.updatedAt)) {
        progressSkipped.set(p.id, 'already watched on To');
        continue;
      }
      if (!(p.positionMs > 0)) {
        progressSkipped.set(p.id, 'no position');
        continue;
      }
      if (accepts('progress', p)) changes.progress.push(p);
    }
  }

  if (scopes.includes('addons')) {
    const have = new Set(target.addons.map(a => addonKey(a.manifestUrl)));
    const seen = new Set<string>();
    for (const a of source.addons) {
      const k = addonKey(a.manifestUrl);
      if (have.has(k) || seen.has(k)) continue;
      seen.add(k);
      if (isLocalOnlyAddon(a.manifestUrl)) {
        notes.push({ scope: 'addons', key: a.name ?? a.manifestUrl, reason: 'runs only on the source device' });
        continue;
      }
      changes.addons.push(a);
    }
  }

  return { changes, notes, progressSkipped };
}

export function countChanges(c: ChangeSet): number {
  return c.library.length + c.watched.length + c.progress.length + c.addons.length;
}
