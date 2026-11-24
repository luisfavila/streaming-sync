import { airedEpisodes, getMeta, findEpisode, type Meta } from '../../meta/cinemeta.ts';
import {
  type AddonEntry,
  type ChangeSet,
  type LibraryEntry,
  type MediaType,
  type ProgressEntry,
  type Scope,
  type Snapshot,
  type WatchedEntry,
  addonKey,
  emptySnapshot,
  isMediaType,
  normalizeManifestUrl,
} from '../../model.ts';
import { type ApplyReport, type Logger, type Provider, chunk, emptyReport, mapLimit, skippedTitle } from '../types.ts';
import * as api from './api.ts';
import { WatchedBitField, orderVideoIds } from './bitfield.ts';

const iso = (d: string | null | undefined) => (d && !Number.isNaN(Date.parse(d)) ? new Date(d).toISOString() : undefined);
const later = (a: string | null | undefined, b: string | null | undefined) => {
  const x = iso(a);
  const y = iso(b);
  return !x ? y : !y ? x : x > y ? x : y;
};

/** "tt123:1:2" → {season:1, episode:2}. Works for prefixed ids too ("kitsu:1:5" has no season → undefined). */
function parseVideoId(seriesId: string, videoId: string | null | undefined): { season: number; episode: number } | undefined {
  if (!videoId || !videoId.startsWith(seriesId + ':')) return undefined;
  const [s, e] = videoId.slice(seriesId.length + 1).split(':').map(Number);
  return Number.isInteger(s) && Number.isInteger(e) ? { season: s!, episode: e! } : undefined;
}

export class StremioProvider implements Provider {
  readonly app = 'stremio' as const;
  readonly label: string;
  private readonly authKey: string;
  private items: Map<string, api.StremioLibraryItem> | undefined;

  constructor(authKey: string, label: string) {
    this.authKey = authKey;
    this.label = label;
  }

  private async loadItems(): Promise<Map<string, api.StremioLibraryItem>> {
    if (!this.items) {
      const list = await api.libraryGet(this.authKey);
      this.items = new Map(list.map((i) => [i._id, i]));
    }
    return this.items;
  }

  async read(scopes: readonly Scope[], log: Logger): Promise<Snapshot> {
    const snap = emptySnapshot();
    if (scopes.some((s) => s !== 'addons')) {
      // Always fetch afresh: apply() writes back these copies, so they must be current.
      this.items = undefined;
      const items = [...(await this.loadItems()).values()].filter((i) => isMediaType(i.type));
      if (scopes.includes('library')) snap.library = items.filter((i) => !i.removed).map(toLibraryEntry);
      if (scopes.includes('watched')) snap.watched = await this.readWatched(items, log);
      if (scopes.includes('progress')) snap.progress = items.flatMap((i) => toProgress(i));
    }
    if (scopes.includes('addons')) {
      snap.addons = (await api.addonsGet(this.authKey)).map(toAddonEntry);
    }
    return snap;
  }

  private async readWatched(items: api.StremioLibraryItem[], log: Logger): Promise<WatchedEntry[]> {
    const out: WatchedEntry[] = [];
    for (const i of items) {
      if (i.type === 'movie' && (i.state.timesWatched > 0 || i.state.flaggedWatched > 0)) {
        out.push({ id: i._id, type: 'movie', watchedAt: iso(i.state.lastWatched) ?? iso(i._mtime)!, name: i.name || undefined });
      }
    }
    const series = items.filter((i) => i.type === 'series' && i.state.watched);
    if (series.length) log.info(`Stremio: reading watched episodes for ${series.length} series (episode lists from Cinemeta)…`);
    const perSeries = await mapLimit(series, 8, async (i): Promise<WatchedEntry[]> => {
      let meta: Meta | undefined;
      try {
        meta = await getMeta('series', i._id);
      } catch (e) {
        log.warn(`${i.name}: ${(e as Error).message}`);
      }
      if (!meta?.videos.length) {
        log.warn(`${i.name} (${i._id}): no episode list available, its watched episodes are skipped`);
        return [];
      }
      const bf = WatchedBitField.tryParse(i.state.watched, orderVideoIds(meta.videos));
      if (!bf) {
        log.warn(`${i.name} (${i._id}): Stremio's watched episodes don't match Cinemeta's episode list, so they're skipped`);
        return [];
      }
      const lastWatched = iso(i.state.lastWatched) ?? iso(i._mtime)!;
      const byId = new Map(meta.videos.map((v) => [v.id, v]));
      // Every aired episode watched → also report the series itself as watched (Nuvio has a
      // separate series-level mark for this; Stremio doesn't).
      const aired = airedEpisodes(meta);
      const name = i.name || meta.name || undefined;
      const seriesMark: WatchedEntry[] = aired.length && aired.every((v) => bf.getVideo(v.id)) ? [{ id: i._id, type: 'series', watchedAt: lastWatched, name }] : [];
      return seriesMark.concat(bf.watchedVideoIds().flatMap((vid) => {
        const v = byId.get(vid);
        if (v?.season === undefined || v.episode === undefined) return [];
        // Stremio keeps one timestamp per series. Use it for the latest episode, and the air date
        // (when earlier) for the rest, so history stays in a sensible order.
        const released = iso(v.released);
        const watchedAt = vid === i.state.video_id || !released || released > lastWatched ? lastWatched : released;
        return [{ id: i._id, type: 'series' as const, season: v.season, episode: v.episode, watchedAt, name }];
      }));
    });
    return out.concat(perSeries.flat());
  }

  async apply(changes: ChangeSet, log: Logger): Promise<ApplyReport> {
    const report = emptyReport();
    const now = new Date().toISOString();
    const items = await this.loadItems();
    const touched = new Map<string, api.StremioLibraryItem>();

    const getOrCreate = async (id: string, type: MediaType, hint?: { name?: string; poster?: string }) => {
      let item = touched.get(id) ?? (items.has(id) ? structuredClone(items.get(id)!) : undefined);
      if (!item) {
        let name = hint?.name;
        let poster = hint?.poster;
        if (!name || !poster) {
          const meta = await getMeta(type, id).catch(() => undefined);
          name ||= meta?.name;
          poster ||= meta?.poster;
        }
        // New items start outside the library ("removed" + "temp"), which is how Stremio keeps
        // titles you watched without adding them. Library adds flip these below.
        item = {
          _id: id,
          name: name ?? id,
          type,
          poster: poster ?? null,
          posterShape: 'poster',
          removed: true,
          temp: true,
          _ctime: now,
          _mtime: now,
          state: { lastWatched: null, timeWatched: 0, timeOffset: 0, overallTimeWatched: 0, timesWatched: 0, flaggedWatched: 0, duration: 0, video_id: null, watched: null, noNotif: false },
          behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false },
        };
      }
      touched.set(id, item);
      return item;
    };

    for (const e of changes.library) {
      const item = await getOrCreate(e.id, e.type, e);
      item.removed = false;
      item.temp = false;
      if (e.addedAt && (!item._ctime || item._ctime > e.addedAt)) item._ctime = e.addedAt;
      report.written.library++;
    }

    for (const e of changes.watched.filter((w) => w.type === 'movie')) {
      const item = await getOrCreate(e.id, 'movie', e);
      item.state.timesWatched = Math.max(1, item.state.timesWatched);
      item.state.flaggedWatched = 1;
      item.state.lastWatched = later(item.state.lastWatched, e.watchedAt) ?? e.watchedAt;
      report.written.watched++;
    }

    const episodesBySeries = Map.groupBy(changes.watched.filter((w) => w.type === 'series'), (w) => w.id);
    for (const [id, eps] of episodesBySeries) {
      const meta = await getMeta('series', id).catch(() => undefined);
      if (!meta?.videos.length) {
        for (const e of eps) report.skipped.push(skippedTitle('watched', e, 'no episode list for this series on Cinemeta'));
        continue;
      }
      // Can't read To's watched episodes against Cinemeta's list: writing would replace them
      // with only the new ones, un-watching the rest. Leave the series alone.
      const existing = touched.get(id) ?? items.get(id);
      const bf = WatchedBitField.tryParse(existing?.state.watched, orderVideoIds(meta.videos));
      if (!bf) {
        for (const e of eps) report.skipped.push(skippedTitle('watched', e, "Stremio's watched episodes for this series don't match Cinemeta's episode list"));
        continue;
      }
      const item = await getOrCreate(id, 'series', meta);
      for (const e of eps) {
        if (e.season === undefined || e.episode === undefined) {
          // Whole series marked watched: Stremio tracks this per episode, so mark every aired one.
          for (const v of airedEpisodes(meta)) if (bf.setVideo(v.id, true)) item.state.timesWatched++;
          item.state.lastWatched = later(item.state.lastWatched, e.watchedAt) ?? e.watchedAt;
          report.written.watched++;
          continue;
        }
        const v = findEpisode(meta, e.season, e.episode);
        if (!v) {
          report.skipped.push(skippedTitle('watched', e, 'episode not in Cinemeta episode list'));
          continue;
        }
        if (bf.setVideo(v.id, true)) item.state.timesWatched++;
        item.state.lastWatched = later(item.state.lastWatched, e.watchedAt) ?? e.watchedAt;
        report.written.watched++;
      }
      item.state.watched = bf.toString();
    }

    for (const p of changes.progress) {
      const item = await getOrCreate(p.id, p.type, p);
      let videoId = p.id;
      if (p.type === 'series' && p.season !== undefined && p.episode !== undefined) {
        const meta = await getMeta('series', p.id).catch(() => undefined);
        videoId = (meta && findEpisode(meta, p.season, p.episode)?.id) ?? `${p.id}:${p.season}:${p.episode}`;
      }
      item.state.video_id = videoId;
      item.state.timeOffset = Math.max(1, Math.round(p.positionMs));
      item.state.duration = Math.round(p.durationMs);
      item.state.lastWatched = later(item.state.lastWatched, p.updatedAt) ?? p.updatedAt;
      // Continue Watching shows items that are in the library, or temporary ones.
      if (item.removed) item.temp = true;
      report.written.progress++;
    }

    if (touched.size) {
      const list = [...touched.values()].map((i) => ({ ...i, _mtime: now }));
      for (const part of chunk(list, 50)) await api.libraryPut(this.authKey, part);
      for (const i of list) items.set(i._id, i);
      log.info(`Stremio: wrote ${list.length} library item(s)`);
    }

    if (changes.addons.length) {
      const current = await api.addonsGet(this.authKey);
      const have = new Set(current.map((a) => addonKey(a.transportUrl)));
      const added = (await mapLimit(changes.addons, 4, async (a) => (have.has(addonKey(a.manifestUrl)) ? undefined : this.descriptor(a.manifestUrl, report)))).filter(
        (d): d is api.StremioAddonDescriptor => !!d,
      );
      if (added.length) {
        await api.addonsSet(this.authKey, [...current, ...added]);
        report.written.addons = added.length;
      }
    }
    return report;
  }

  readonly canDisableAddons = false;

  async saveAddons(list: AddonEntry[], log: Logger): Promise<ApplyReport> {
    const report = emptyReport();
    const current = await api.addonsGet(this.authKey);
    const byKey = new Map(current.map((d) => [addonKey(d.transportUrl), d]));
    // Stremio can't switch add-ons off, so a switched-off add-on isn't installed here.
    const wanted = list.filter((a) => a.enabled !== false);
    const out = (
      await mapLimit(wanted, 4, async (a) => {
        const have = byKey.get(addonKey(a.manifestUrl));
        if (have) return have;
        const d = await this.descriptor(a.manifestUrl, report);
        if (d) report.written.addons++;
        return d;
      })
    ).filter((d): d is api.StremioAddonDescriptor => !!d);
    // Protected add-ons can't be removed: put back any the list left out, where they were.
    const keep = new Set(out.map((d) => addonKey(d.transportUrl)));
    current.forEach((d, i) => {
      if (d.flags?.protected && !keep.has(addonKey(d.transportUrl))) out.splice(Math.min(i, out.length), 0, d);
    });
    await api.addonsSet(this.authKey, out);
    log.info(`Stremio: saved ${out.length} add-on(s)`);
    return report;
  }

  /** Builds an add-on descriptor by loading its manifest. Records a skip and returns undefined if it can't. */
  private async descriptor(manifestUrl: string, report: ApplyReport): Promise<api.StremioAddonDescriptor | undefined> {
    const url = normalizeManifestUrl(manifestUrl);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = (await res.json()) as api.StremioAddonDescriptor['manifest'];
      if (!manifest?.id || !manifest.name) throw new Error('not an add-on manifest');
      return { transportUrl: url, manifest, flags: { official: false, protected: false } };
    } catch (e) {
      report.skipped.push({ scope: 'addons', key: url, reason: `manifest could not be loaded: ${(e as Error).message}` });
      return undefined;
    }
  }
}

function toAddonEntry(d: api.StremioAddonDescriptor): AddonEntry {
  const logo = typeof d.manifest?.logo === 'string' ? d.manifest.logo : undefined;
  return { manifestUrl: normalizeManifestUrl(d.transportUrl), name: d.manifest?.name, logo, enabled: true, protected: !!d.flags?.protected };
}

function toLibraryEntry(i: api.StremioLibraryItem): LibraryEntry {
  return {
    id: i._id,
    type: i.type as MediaType,
    name: i.name,
    poster: i.poster ?? undefined,
    addedAt: iso(i._ctime) ?? iso(i._mtime),
  };
}

function toProgress(i: api.StremioLibraryItem): ProgressEntry[] {
  // Same rule as Stremio's Continue Watching.
  if (!(i.state.timeOffset > 0) || (i.removed && !i.temp)) return [];
  const type = i.type as MediaType;
  const ep = type === 'series' ? parseVideoId(i._id, i.state.video_id) : undefined;
  if (type === 'series' && !ep) return [];
  return [
    {
      id: i._id,
      type,
      season: ep?.season,
      episode: ep?.episode,
      positionMs: i.state.timeOffset,
      durationMs: i.state.duration,
      updatedAt: iso(i.state.lastWatched) ?? iso(i._mtime)!,
      name: i.name,
      poster: i.poster ?? undefined,
    },
  ];
}
