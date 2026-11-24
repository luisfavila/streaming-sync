// Public metadata from Cinemeta (Stremio's official metadata add-on). Used for a series' episode
// list (needed to read and write Stremio's watched-episode field) and for names/posters when a
// target app needs them but the source didn't carry them.

import type { MediaType } from '../model.ts';
import type { CinemetaVideo } from '../providers/stremio/bitfield.ts';

const BASE = 'https://v3-cinemeta.strem.io/meta';

export interface Meta {
  id: string;
  type: MediaType;
  name: string;
  poster?: string;
  background?: string;
  year?: string;
  videos: CinemetaVideo[];
}

const cache = new Map<string, Promise<Meta | undefined>>();

/** Only IMDb ids are covered by Cinemeta. */
export function hasCinemeta(id: string): boolean {
  return /^tt\d+$/.test(id);
}

export function getMeta(type: MediaType, id: string): Promise<Meta | undefined> {
  if (!hasCinemeta(id)) return Promise.resolve(undefined);
  const key = `${type}/${id}`;
  let p = cache.get(key);
  if (!p) {
    p = fetchMeta(type, id);
    cache.set(key, p);
    // Keep successes (and "not found"), but let a failed lookup be tried again later.
    p.catch(() => cache.delete(key));
  }
  return p;
}

async function fetchMeta(type: MediaType, id: string): Promise<Meta | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/${type}/${encodeURIComponent(id)}.json`, { signal: AbortSignal.timeout(15000) });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { meta?: Record<string, unknown> };
      const m = data.meta;
      if (!m || typeof m.name !== 'string') return undefined;
      const videos = Array.isArray(m.videos)
        ? (m.videos as Record<string, unknown>[])
            .filter((v) => typeof v.id === 'string')
            .map((v) => ({
              id: v.id as string,
              season: typeof v.season === 'number' ? v.season : undefined,
              episode: typeof v.episode === 'number' ? v.episode : typeof v.number === 'number' ? v.number : undefined,
              released: typeof v.released === 'string' ? v.released : undefined,
            }))
        : [];
      return {
        id,
        type,
        name: m.name,
        poster: typeof m.poster === 'string' ? m.poster : undefined,
        background: typeof m.background === 'string' ? m.background : undefined,
        year: typeof m.year === 'string' ? m.year : typeof m.releaseInfo === 'string' ? m.releaseInfo : undefined,
        videos,
      };
    } catch (e) {
      if (attempt === 2) throw new Error(`Cinemeta ${type}/${id}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return undefined;
}

/** Finds the episode's video in a series' list. */
export function findEpisode(meta: Meta, season: number, episode: number): CinemetaVideo | undefined {
  return meta.videos.find((v) => v.season === season && v.episode === episode);
}

/** Regular-season episodes that have aired (specials in season 0 and future episodes don't count). */
export function airedEpisodes(meta: Meta): CinemetaVideo[] {
  const now = Date.now();
  return meta.videos.filter((v) => (v.season ?? 0) > 0 && v.episode !== undefined && (!v.released || Date.parse(v.released) <= now));
}
