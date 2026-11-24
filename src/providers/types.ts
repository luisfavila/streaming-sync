import { type AddonEntry, type ChangeSet, type LibraryEntry, type ProgressEntry, type Scope, type Snapshot, type WatchedEntry, videoKey } from '../model.ts';

export type AppKind = 'stremio' | 'nuvio' | 'trakt';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface ApplyReport {
  /** Per scope: how many entries were written. */
  written: Record<Scope, number>;
  /** Entries that could not be written, with a reason. */
  skipped: Skipped[];
}

export interface Skipped {
  scope: Scope;
  /** What to show when there's no title name (e.g. an add-on URL, "tt123:1:2"). */
  key: string;
  reason: string;
  /** The title (and episode) it was about, so it can be shown by name. */
  id?: string;
  season?: number;
  episode?: number;
}

/** A skipped title or episode. */
export function skippedTitle(scope: Scope, e: { id: string; season?: number; episode?: number }, reason: string): Skipped {
  return { scope, key: videoKey(e), reason, id: e.id, season: e.season, episode: e.episode };
}

/** One signed-in account in one app. Reads into the neutral model and writes it back. */
export interface Provider {
  readonly app: AppKind;
  /** Short human label, e.g. "Stremio (me@example.com)". */
  readonly label: string;
  read(scopes: readonly Scope[], log: Logger): Promise<Snapshot>;
  /**
   * Additive: creates or updates entries, never deletes. Builds on what the last `read` saw (e.g.
   * Trakt skips plays it already has, Stremio updates the items it read), so call `read` right
   * before; runWrite does.
   */
  apply(changes: ChangeSet, log: Logger): Promise<ApplyReport>;
  /** Why this app can't take an entry at all (e.g. Trakt and playback under 1%), so it isn't offered. */
  unsupported?(scope: 'library' | 'watched' | 'progress', entry: LibraryEntry | WatchedEntry | ProgressEntry): string | undefined;
  /** Whether add-ons can be switched off without uninstalling them. */
  readonly canDisableAddons: boolean;
  /** Why this account's add-on list can't be edited here, if it can't. */
  readonly addonsLocked?: string;
  /**
   * Replaces the installed add-ons with `list`, in that order. Unlike `apply`, this can remove
   * and reorder add-ons. Protected add-ons missing from `list` are kept.
   */
  saveAddons(list: AddonEntry[], log: Logger): Promise<ApplyReport>;
}

export function emptyReport(): ApplyReport {
  return { written: { library: 0, watched: 0, progress: 0, addons: 0 }, skipped: [] };
}

/** Runs `fn` over `items` with at most `limit` in flight. Keeps order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
