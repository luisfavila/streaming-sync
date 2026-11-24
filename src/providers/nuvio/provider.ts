import { getMeta } from '../../meta/cinemeta.ts';
import {
  type AddonEntry,
  addonKey,
  type ChangeSet,
  emptySnapshot,
  type LibraryEntry,
  type MediaType,
  normalizeManifestUrl,
  type ProgressEntry,
  type Scope,
  type Snapshot,
  type WatchedEntry,
} from '../../model.ts';
import { type ApplyReport, chunk, emptyReport, type Logger, mapLimit, type Provider, skippedTitle } from '../types.ts';
import type { NuvioClient } from './api.ts';

// Row shapes, as in Nuvio's app (LibrarySyncItem, WatchedSyncItem, WatchProgressSyncEntry, AddonPushItem).
interface LibraryRow {
  content_id: string;
  content_type: string;
  name: string;
  poster?: string | null;
  poster_shape?: string;
  background?: string | null;
  logo?: string | null;
  description?: string | null;
  release_info?: string | null;
  imdb_rating?: number | null;
  genres?: string[];
  addon_base_url?: string | null;
  added_at: number;
}
interface WatchedRow {
  content_id: string;
  content_type: string;
  title: string;
  season: number | null;
  episode: number | null;
  watched_at: number;
}
interface ProgressRow {
  content_id: string;
  content_type: string;
  video_id: string;
  season: number | null;
  episode: number | null;
  position: number;
  duration: number;
  last_watched: number;
  progress_key: string;
}
interface AddonRow {
  url: string;
  name?: string | null;
  enabled?: boolean;
  sort_order?: number;
}
export interface NuvioProfile {
  profile_index: number;
  name: string;
  uses_primary_addons?: boolean;
  pin_enabled?: boolean;
}

const LIBRARY_PAGE = 500;
const WATCHED_PAGE = 900;

/** Nuvio's app also writes these spellings for series. */
const normType = (t: string): MediaType | undefined => {
  const x = t.toLowerCase();
  if (x === 'movie' || x === 'film') return 'movie';
  if (['series', 'show', 'tv', 'tvshow', 'anime'].includes(x)) return 'series';
  return undefined;
};
/** Media-server items (Jellyfin/Plex) never sync, in Nuvio's own app either. */
const syncable = (id: string) => !id.startsWith('srv1:');

/** Old rows may hold yyyyMMddHHmmss instead of epoch ms (Nuvio app: WatchedModels.kt). */
function watchedAtMs(v: number): number {
  if (v >= 19000101000000 && v <= 29991231235959) {
    const s = String(Math.trunc(v));
    return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
  }
  return v;
}
const toIso = (ms: number | null | undefined) => (ms && ms > 0 ? new Date(ms).toISOString() : new Date(0).toISOString());
const toMs = (iso: string | undefined) => (iso ? Date.parse(iso) || Date.now() : Date.now());

export class NuvioProvider implements Provider {
  readonly app = 'nuvio' as const;
  readonly label: string;
  private readonly client: NuvioClient;
  private readonly profileId: number;
  private readonly clientId: string;
  private readonly profile: NuvioProfile | undefined;
  /** Server-side progress keys, so updates replace the existing row. */
  private progressKeys = new Map<string, string>();

  constructor(o: { client: NuvioClient; profileId: number; clientId: string; label: string; profile?: NuvioProfile }) {
    this.client = o.client;
    this.profileId = o.profileId;
    this.clientId = o.clientId;
    this.label = o.label;
    this.profile = o.profile;
  }

  /** A secondary profile set to "use the main profile's add-ons" has none of its own. */
  private get addonsProfileId(): number {
    return this.profileId !== 1 && this.profile?.uses_primary_addons ? 1 : this.profileId;
  }

  async read(scopes: readonly Scope[], _log: Logger): Promise<Snapshot> {
    const snap = emptySnapshot();
    const p = this.profileId;

    if (scopes.includes('library')) {
      const rows: LibraryRow[] = [];
      for (let offset = 0; ; offset += LIBRARY_PAGE) {
        const page = await this.client.rpc<LibraryRow[]>('sync_pull_library', {
          p_profile_id: p,
          p_limit: LIBRARY_PAGE,
          p_offset: offset,
        });
        rows.push(...page);
        if (page.length < LIBRARY_PAGE) break;
      }
      snap.library = rows.flatMap((r): LibraryEntry[] => {
        const type = normType(r.content_type);
        if (!type || !syncable(r.content_id)) return [];
        return [
          {
            id: r.content_id,
            type,
            name: r.name,
            poster: r.poster ?? undefined,
            addedAt: r.added_at ? toIso(r.added_at) : undefined,
          },
        ];
      });
    }

    if (scopes.includes('watched')) {
      const rows: WatchedRow[] = [];
      for (let page = 1; ; page++) {
        const batch = await this.client.rpc<WatchedRow[]>('sync_pull_watched_items', {
          p_profile_id: p,
          p_page: page,
          p_page_size: WATCHED_PAGE,
        });
        rows.push(...batch);
        if (batch.length < WATCHED_PAGE) break;
      }
      snap.watched = rows.flatMap((r): WatchedEntry[] => {
        const type = normType(r.content_type);
        if (!type || !syncable(r.content_id)) return [];
        const ep = r.season !== null && r.episode !== null ? { season: r.season, episode: r.episode } : {};
        return [{ id: r.content_id, type, ...ep, watchedAt: toIso(watchedAtMs(r.watched_at)), name: r.title || undefined }];
      });
    }

    if (scopes.includes('progress')) {
      // The server caps this list by default; ask for plenty.
      const rows = await this.client.rpc<ProgressRow[]>('sync_pull_watch_progress', { p_profile_id: p, p_limit: 10000 });
      this.progressKeys.clear();
      snap.progress = rows.flatMap((r): ProgressEntry[] => {
        const type = normType(r.content_type);
        if (!type || !syncable(r.content_id)) return [];
        const ep = r.season !== null && r.episode !== null ? { season: r.season, episode: r.episode } : {};
        this.progressKeys.set(progressIdentity(r.content_id, r.season, r.episode), r.progress_key);
        return [
          { id: r.content_id, type, ...ep, positionMs: r.position, durationMs: r.duration, updatedAt: toIso(r.last_watched) },
        ];
      });
    }

    if (scopes.includes('addons')) {
      const seen = new Set<string>();
      snap.addons = (await this.addonRows(this.addonsProfileId)).flatMap(r => {
        const k = addonKey(r.url);
        if (seen.has(k)) return [];
        seen.add(k);
        return [{ manifestUrl: normalizeManifestUrl(r.url), name: r.name || undefined, enabled: r.enabled ?? true }];
      });
    }
    return snap;
  }

  async apply(changes: ChangeSet, log: Logger): Promise<ApplyReport> {
    const report = emptyReport();
    const p = this.profileId;
    const origin = { p_origin_client_id: this.clientId };

    // Names and artwork: Nuvio shows what's stored on the row, so fill gaps from Cinemeta.
    const names = new Map<string, string>();
    for (const e of [...changes.library, ...changes.progress, ...changes.watched])
      if (e.name && !names.has(e.id)) names.set(e.id, e.name);
    const metaFor = async (type: MediaType, id: string) => getMeta(type, id).catch(() => undefined);

    if (changes.library.length) {
      const rows = await mapLimit(changes.library, 8, async (e): Promise<LibraryRow> => {
        const meta = !e.name || !e.poster ? await metaFor(e.type, e.id) : undefined;
        return {
          content_id: e.id,
          content_type: e.type,
          name: e.name || meta?.name || '',
          poster: e.poster || meta?.poster || null,
          poster_shape: 'POSTER',
          background: meta?.background ?? null,
          release_info: meta?.year ?? null,
          genres: [],
          added_at: toMs(e.addedAt),
        };
      });
      for (const part of chunk(rows, 500))
        await this.client.rpc('sync_push_library_items', { p_profile_id: p, p_items: part, ...origin });
      report.written.library = rows.length;
    }

    if (changes.watched.length) {
      const ids = [...new Map(changes.watched.map(w => [w.id, w.type])).entries()].filter(([id]) => !names.has(id));
      await mapLimit(ids, 8, async ([id, type]) => {
        const meta = await metaFor(type, id);
        if (meta?.name) names.set(id, meta.name);
      });
      const rows: WatchedRow[] = changes.watched.map(w => ({
        content_id: w.id,
        content_type: w.type,
        title: names.get(w.id) ?? '',
        season: w.season ?? null,
        episode: w.episode ?? null,
        watched_at: toMs(w.watchedAt),
      }));
      for (const part of chunk(rows, 300))
        await this.client.rpc('sync_push_watched_items', { p_profile_id: p, p_items: part, ...origin });
      report.written.watched = rows.length;
    }

    if (changes.progress.length) {
      const rows: ProgressRow[] = [];
      for (const e of changes.progress) {
        if (!(e.durationMs > 0)) {
          report.skipped.push(skippedTitle('progress', e, 'length of the video is unknown, so Nuvio would show it at 0%'));
          continue;
        }
        const season = e.season ?? null;
        const episode = e.episode ?? null;
        const identity = progressIdentity(e.id, season, episode);
        rows.push({
          content_id: e.id,
          content_type: e.type,
          video_id: season !== null && episode !== null ? `${e.id}:${season}:${episode}` : e.id,
          season,
          episode,
          position: Math.round(e.positionMs),
          duration: Math.round(e.durationMs),
          last_watched: toMs(e.updatedAt),
          progress_key:
            this.progressKeys.get(identity) ?? (season !== null && episode !== null ? `${e.id}_s${season}e${episode}` : e.id),
        });
      }
      for (const part of chunk(rows, 100))
        await this.client.rpc('sync_push_watch_progress', { p_profile_id: p, p_entries: part, ...origin });
      report.written.progress = rows.length;
    }

    if (changes.addons.length) {
      if (this.addonsProfileId !== p) {
        for (const a of changes.addons)
          report.skipped.push({
            scope: 'addons',
            key: a.name ?? a.manifestUrl,
            reason: "this Nuvio profile uses the main profile's add-ons; sync add-ons to profile 1 instead",
          });
      } else {
        // Nuvio replaces the whole list on every push, so send the current list plus the new ones.
        const list = (await this.addonRows(p)).map(r => ({ url: r.url, name: r.name ?? '', enabled: r.enabled ?? true }));
        const have = new Set(list.map(a => addonKey(a.url)));
        let added = 0;
        for (const a of changes.addons) {
          if (have.has(addonKey(a.manifestUrl))) continue;
          have.add(addonKey(a.manifestUrl));
          list.push({ url: normalizeManifestUrl(a.manifestUrl), name: a.name ?? '', enabled: true });
          added++;
        }
        if (added) {
          await this.client.rpc('sync_push_addons', {
            p_profile_id: p,
            p_addons: list.map((a, i) => ({ ...a, sort_order: i })),
            ...origin,
          });
          report.written.addons = added;
        }
      }
    }

    const total = report.written.library + report.written.watched + report.written.progress + report.written.addons;
    if (total) log.info(`Nuvio: wrote ${total} item(s) to profile ${p}`);
    return report;
  }

  readonly canDisableAddons = true;

  get addonsLocked(): string | undefined {
    return this.addonsProfileId !== this.profileId
      ? "This profile uses the main profile's add-ons. Edit them on the main profile."
      : undefined;
  }

  async saveAddons(list: AddonEntry[], log: Logger): Promise<ApplyReport> {
    const report = emptyReport();
    if (this.addonsLocked) throw new Error(this.addonsLocked);
    const p = this.profileId;
    // Keep existing rows' URLs exactly as stored; only new add-ons get the normalised URL.
    const current = new Map((await this.addonRows(p)).map(r => [addonKey(r.url), r]));
    const seen = new Set<string>();
    const rows = list.flatMap(a => {
      const k = addonKey(a.manifestUrl);
      if (seen.has(k)) return [];
      seen.add(k);
      const have = current.get(k);
      if (!have) report.written.addons++;
      return [
        { url: have?.url ?? normalizeManifestUrl(a.manifestUrl), name: a.name ?? have?.name ?? '', enabled: a.enabled ?? true },
      ];
    });
    await this.client.rpc('sync_push_addons', {
      p_profile_id: p,
      p_addons: rows.map((a, i) => ({ ...a, sort_order: i })),
      p_origin_client_id: this.clientId,
    });
    log.info(`Nuvio: saved ${rows.length} add-on(s) to profile ${p}`);
    return report;
  }

  private addonRows(profileId: number): Promise<AddonRow[]> {
    return this.client.select<AddonRow[]>(
      'addons',
      `select=url,name,enabled,sort_order&profile_id=eq.${profileId}&order=sort_order.asc`,
    );
  }
}

function progressIdentity(id: string, season: number | null | undefined, episode: number | null | undefined): string {
  return `${id}|${season ?? -1}|${episode ?? -1}`;
}
