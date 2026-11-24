// The neutral data model. Every provider (Stremio, Nuvio, ...) reads its own data into these
// shapes and writes these shapes back out, so any provider can sync with any other.
//
// Content ids are the ids addons use: IMDb ids ("tt0944947") for most titles, or an addon's own
// prefixed id ("kitsu:123", "tmdb:456"). Episodes are addressed by series id + season + episode.

export type MediaType = 'movie' | 'series';
export const isMediaType = (t: string): t is MediaType => t === 'movie' || t === 'series';

/** A title saved to the user's library. */
export interface LibraryEntry {
  id: string;
  type: MediaType;
  name: string;
  poster?: string;
  /** ISO 8601. */
  addedAt?: string;
}

/** A watched movie, or one watched episode of a series. */
export interface WatchedEntry {
  id: string;
  type: MediaType;
  /** Set for episodes only. */
  season?: number;
  episode?: number;
  /** ISO 8601. Best known time it was watched. */
  watchedAt: string;
  /** Title name, when the app stores one. */
  name?: string;
}

/** Unfinished playback: what shows up in Continue Watching. */
export interface ProgressEntry {
  id: string;
  type: MediaType;
  season?: number;
  episode?: number;
  /** Playback position and total length, in milliseconds. */
  positionMs: number;
  durationMs: number;
  /** ISO 8601. When this progress was last updated. */
  updatedAt: string;
  name?: string;
  poster?: string;
}

/** An installed add-on, identified by its manifest URL. */
export interface AddonEntry {
  manifestUrl: string;
  name?: string;
  logo?: string;
  /** False when the app has it installed but switched off (Nuvio only; Stremio has no switch). */
  enabled?: boolean;
  /** Built into the app and can't be removed (Stremio's Cinemeta, Local Files). */
  protected?: boolean;
}

export interface Snapshot {
  library: LibraryEntry[];
  watched: WatchedEntry[];
  progress: ProgressEntry[];
  addons: AddonEntry[];
}

export const SCOPES = ['library', 'watched', 'progress', 'addons'] as const;
export type Scope = (typeof SCOPES)[number];

/** What to change on the target. Sync is additive: nothing here deletes data. */
export interface ChangeSet {
  library: LibraryEntry[];
  watched: WatchedEntry[];
  progress: ProgressEntry[];
  addons: AddonEntry[];
}

export function emptySnapshot(): Snapshot {
  return { library: [], watched: [], progress: [], addons: [] };
}

/** Stable key for a watched/progress entry: "tt123" for movies, "tt123:1:2" for episodes. */
export function videoKey(e: { id: string; season?: number; episode?: number }): string {
  return e.season !== undefined && e.episode !== undefined ? `${e.id}:${e.season}:${e.episode}` : e.id;
}

/** Normalises a manifest URL so the same add-on matches across apps. */
export function normalizeManifestUrl(url: string): string {
  let u = url.trim().replace(/^stremio:\/\//i, 'https://');
  try {
    // Add "manifest.json" to the path, keeping any query (often the add-on's config) intact.
    const parsed = new URL(u);
    if (!/manifest\.json$/i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/\/?$/, '/manifest.json');
      u = parsed.toString();
    }
  } catch {
    if (!/manifest\.json(\?.*)?$/i.test(u)) u = u.replace(/\/?$/, '/manifest.json');
  }
  return u;
}

/** Same add-on across apps: ignores http/https and the host's letter case, but not the path's (it often holds per-user config). */
export function addonKey(url: string): string {
  const rest = normalizeManifestUrl(url).replace(/^https?:\/\//i, '');
  const slash = rest.indexOf('/');
  return slash < 0 ? rest.toLowerCase() : rest.slice(0, slash).toLowerCase() + rest.slice(slash);
}

/** Add-ons that only run on the user's own device (e.g. Stremio's Local Files) can't move between apps. */
export function isLocalOnlyAddon(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(url.trim());
}
