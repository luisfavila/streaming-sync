// Trakt as a sync side:
//   Library           ↔ watchlist, plus everything watched (Trakt takes titles off the
//                       watchlist once they're watched, so watched titles count as in the library)
//   Watched           ↔ watch history (movies and episodes)
//   Continue Watching ↔ paused playback (Trakt keeps a percentage; written through "scrobble pause")
//   Add-ons           — Trakt has none
//
// Titles are matched by IMDb id (or TMDB id, as "tmdb:123"), which is what Stremio and Nuvio use.

import { airedEpisodes, getMeta } from '../../meta/cinemeta.ts';
import {
  type AddonEntry,
  type ChangeSet,
  emptySnapshot,
  type LibraryEntry,
  type MediaType,
  type ProgressEntry,
  type Scope,
  type Snapshot,
  videoKey,
  type WatchedEntry,
} from '../../model.ts';
import { type ApplyReport, emptyReport, type Logger, mapLimit, type Provider, skippedTitle } from '../types.ts';
import type { TraktClient } from './api.ts';

interface Ids {
  trakt?: number;
  slug?: string;
  imdb?: string | null;
  tmdb?: number | null;
  tvdb?: number | null;
}
interface Media {
  title: string;
  year?: number | null;
  ids: Ids;
  runtime?: number | null;
}
interface WatchlistItem {
  listed_at: string;
  type: 'movie' | 'show';
  movie?: Media;
  show?: Media;
}
interface WatchedMovie {
  plays: number;
  last_watched_at: string;
  movie: Media;
}
/** One play from /sync/history/episodes. */
interface HistoryItem {
  watched_at: string;
  type: 'episode';
  episode?: { season: number; number: number };
  show?: Media;
}
interface Playback {
  progress: number;
  paused_at: string;
  type: 'movie' | 'episode';
  movie?: Media;
  show?: Media;
  episode?: { season: number; number: number; title?: string; runtime?: number | null };
}
interface SyncResult {
  added?: { movies?: number; shows?: number; episodes?: number };
  existing?: { movies?: number; shows?: number; episodes?: number };
  not_found?: { movies?: { ids: Ids }[]; shows?: { ids: Ids }[]; episodes?: { ids: Ids }[] };
}

/** Our id for a Trakt title: its IMDb id, else "tmdb:<id>". */
function idOf(ids: Ids): string | undefined {
  if (ids.imdb && /^tt\d+$/.test(ids.imdb)) return ids.imdb;
  return ids.tmdb ? `tmdb:${ids.tmdb}` : undefined;
}

/** Trakt ids for one of our ids, or undefined when Trakt can't look it up. */
function traktIds(id: string): Ids | undefined {
  if (/^tt\d+$/.test(id)) return { imdb: id };
  const tmdb = /^tmdb:(\d+)$/.exec(id)?.[1];
  return tmdb ? { tmdb: Number(tmdb) } : undefined;
}

const NO_IDS = 'Trakt needs an IMDb or TMDB id to find this title';

/** Plays (or titles) per write request. Trakt silently took far less than it was sent in big ones. */
const PLAYS_PER_REQUEST = 100;

/** One movie or show (for history: one show season) to send to a /sync endpoint. */
interface SyncItem {
  kind: 'movies' | 'shows';
  /** Our id, for reporting. */
  id: string;
  body: { ids: Ids; [k: string]: unknown };
  /** How many plays (or titles) it adds. */
  plays: number;
}

/** Groups items into requests of about `max` plays each, never splitting an item. */
function batchByPlays(items: SyncItem[], max: number): SyncItem[][] {
  const out: SyncItem[][] = [];
  let cur: SyncItem[] = [];
  let size = 0;
  for (const item of items) {
    if (cur.length && size + item.plays > max) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(item);
    size += item.plays;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** "an episode (IMDb tt123)" for Trakt's not-found episode ids. */
function describeIds(ids: Ids): string {
  if (ids.imdb) return `episode ${ids.imdb}`;
  if (ids.tmdb) return `episode tmdb:${ids.tmdb}`;
  if (ids.trakt) return `episode trakt:${ids.trakt}`;
  return 'an episode';
}

export class TraktProvider implements Provider {
  readonly app = 'trakt' as const;
  readonly label: string;
  readonly canDisableAddons = false;
  readonly addonsLocked = 'Trakt has no add-ons.';
  private readonly client: TraktClient;
  /** Watched movies and episodes from the last read, so a write doesn't add duplicate plays. */
  private watchedKeys = new Set<string>();
  /** Movies and shows with anything watched, from the last read. */
  private watchedTitles = new Set<string>();
  /** Whether watchedKeys/watchedTitles come from a read. Without one, a write would add plays twice. */
  private historyRead = false;

  constructor(client: TraktClient, label: string) {
    this.client = client;
    this.label = label;
  }

  async read(scopes: readonly Scope[], log: Logger): Promise<Snapshot> {
    const snap = emptySnapshot();
    const skipped = { count: 0 };
    const id = (m: Media | undefined) => {
      const x = m && idOf(m.ids);
      if (!x) skipped.count++;
      return x;
    };

    if (scopes.includes('library')) {
      const [movies, shows] = await Promise.all([
        this.client.getAll<WatchlistItem>('/sync/watchlist/movies'),
        this.client.getAll<WatchlistItem>('/sync/watchlist/shows'),
      ]);
      snap.library = [...movies, ...shows].flatMap((w): LibraryEntry[] => {
        const media = w.movie ?? w.show;
        const x = id(media);
        return x && media
          ? [{ id: x, type: w.type === 'movie' ? 'movie' : 'series', name: media.title, addedAt: w.listed_at }]
          : [];
      });
    }

    if (scopes.some(x => x !== 'addons')) {
      // Movies from the watched list; episodes from the history. (Since July 2026 Trakt's watched
      // list of shows leaves out seasons and episodes unless asked for a format it hasn't
      // documented; the history lists every play, with the show and episode.)
      if (scopes.includes('watched') || scopes.includes('library')) log.info('Trakt: reading your watch history…');
      const [movies, plays] = await Promise.all([
        this.client.getAll<WatchedMovie>('/sync/watched/movies'),
        this.client.getAll<HistoryItem>('/sync/history/episodes'),
      ]);
      const watched: WatchedEntry[] = [];
      for (const m of movies) {
        const x = id(m.movie);
        if (x) watched.push({ id: x, type: 'movie', watchedAt: m.last_watched_at, name: m.movie.title });
      }
      // Group plays by show; each episode keeps its latest watch time.
      const shows = new Map<
        string,
        { show: Media; last: string; episodes: Map<string, { season: number; episode: number; at: string }> }
      >();
      const noShowId = new Set<string>();
      for (const p of plays) {
        if (!p.show || !p.episode) continue;
        const x = idOf(p.show.ids);
        if (!x) {
          noShowId.add(String(p.show.ids.trakt ?? p.show.ids.slug ?? p.show.title));
          continue;
        }
        let s = shows.get(x);
        if (!s) {
          s = { show: p.show, last: p.watched_at, episodes: new Map() };
          shows.set(x, s);
        }
        if (p.watched_at > s.last) s.last = p.watched_at;
        const k = `${p.episode.season}:${p.episode.number}`;
        const cur = s.episodes.get(k);
        if (!cur || cur.at < p.watched_at)
          s.episodes.set(k, { season: p.episode.season, episode: p.episode.number, at: p.watched_at });
      }
      skipped.count += noShowId.size;
      for (const [x, s] of shows)
        for (const e of s.episodes.values())
          watched.push({ id: x, type: 'series', season: e.season, episode: e.episode, watchedAt: e.at, name: s.show.title });

      // Trakt has no "whole series watched" mark; report one when every aired episode is watched,
      // as Nuvio has such a mark.
      if (shows.size) log.info(`Trakt: checking ${shows.size} shows against their episode lists…`);
      const marks = await mapLimit([...shows], 8, async ([x, s]): Promise<WatchedEntry[]> => {
        const meta = await getMeta('series', x).catch(() => undefined);
        const aired = meta ? airedEpisodes(meta) : [];
        return aired.length && aired.every(v => s.episodes.has(`${v.season}:${v.episode}`))
          ? [{ id: x, type: 'series', watchedAt: s.last, name: s.show.title }]
          : [];
      });
      this.watchedKeys = new Set(watched.map(videoKey));
      this.watchedTitles = new Set(watched.map(w => w.id));
      this.historyRead = true;
      if (scopes.includes('watched')) snap.watched = watched.concat(marks.flat());
      // Watched titles are part of the library too: Trakt removes them from the watchlist.
      if (scopes.includes('library')) {
        const have = new Set(snap.library.map(e => e.id));
        for (const m of movies) {
          const x = idOf(m.movie.ids);
          if (!x || have.has(x)) continue;
          have.add(x);
          snap.library.push({ id: x, type: 'movie', name: m.movie.title, addedAt: m.last_watched_at });
        }
        for (const [x, s] of shows) {
          if (have.has(x)) continue;
          have.add(x);
          snap.library.push({ id: x, type: 'series', name: s.show.title, addedAt: s.last });
        }
      }
    }

    if (scopes.includes('progress')) {
      const items = await this.client.getAll<Playback>('/sync/playback?extended=full');
      let noRuntime = 0;
      snap.progress = items.flatMap((p): ProgressEntry[] => {
        const media = p.type === 'movie' ? p.movie : p.show;
        const x = id(media);
        if (!x || !media) return [];
        // Trakt keeps a percentage; the other apps need a position, so use the runtime.
        const minutes = p.type === 'movie' ? media.runtime : (p.episode?.runtime ?? media.runtime);
        if (!minutes) {
          noRuntime++;
          return [];
        }
        const durationMs = minutes * 60_000;
        const type: MediaType = p.type === 'movie' ? 'movie' : 'series';
        const ep = p.type === 'episode' && p.episode ? { season: p.episode.season, episode: p.episode.number } : {};
        return [
          {
            id: x,
            type,
            ...ep,
            positionMs: Math.round((p.progress / 100) * durationMs),
            durationMs,
            updatedAt: p.paused_at,
            name: media.title,
          },
        ];
      });
      if (noRuntime)
        log.warn(
          `Trakt: ${noRuntime} paused item(s) have no known length, so their position can't be worked out; they're left out`,
        );
    }

    if (skipped.count) log.warn(`Trakt: ${skipped.count} item(s) have no IMDb or TMDB id and are left out`);
    return snap;
  }

  unsupported(scope: 'library' | 'watched' | 'progress', e: LibraryEntry | WatchedEntry | ProgressEntry): string | undefined {
    if (!traktIds(e.id)) return NO_IDS;
    if (scope !== 'progress') return undefined;
    const p = e as ProgressEntry;
    if (!(p.durationMs > 0)) return 'its length is unknown, so Trakt’s percentage can’t be worked out';
    const pct = (p.positionMs / p.durationMs) * 100;
    // Trakt rejects pauses under 1%, and counts 80% or more as watched (adding a play).
    if (pct < 1) return 'under 1% in; Trakt doesn’t save playback that early';
    if (pct >= 80) return `${Math.round(pct)}% in; Trakt would count it as watched`;
    if (p.type === 'series' && (p.season === undefined || p.episode === undefined)) return 'no episode given';
    return undefined;
  }

  async apply(changes: ChangeSet, log: Logger): Promise<ApplyReport> {
    const report = emptyReport();
    if (!this.historyRead && (changes.watched.length || changes.library.length))
      throw new Error('Trakt: read the watch history before writing to it');

    // Watched → history. Each entry adds a play on Trakt, so nothing already watched is sent.
    if (changes.watched.length) {
      const episodes = new Map<string, WatchedEntry>();
      const movies: WatchedEntry[] = [];
      const add = (e: WatchedEntry) => {
        const k = videoKey(e);
        if (!this.watchedKeys.has(k) && !episodes.has(k)) episodes.set(k, e);
      };
      for (const e of changes.watched) {
        if (e.type === 'movie') {
          if (!this.watchedKeys.has(e.id)) movies.push(e);
        } else if (e.episode !== undefined) add(e);
      }
      // A "whole series" mark becomes every aired episode, with the mark's time.
      await mapLimit(
        changes.watched.filter(e => e.type === 'series' && e.episode === undefined),
        8,
        async mark => {
          const meta = await getMeta('series', mark.id).catch(() => undefined);
          const aired = meta ? airedEpisodes(meta) : [];
          if (!aired.length) {
            report.skipped.push(skippedTitle('watched', mark, 'no episode list available to mark the whole series watched'));
            return;
          }
          for (const v of aired)
            add({
              id: mark.id,
              type: 'series',
              season: v.season,
              episode: v.episode,
              watchedAt: mark.watchedAt,
              name: mark.name,
            });
        },
      );

      const items: SyncItem[] = [];
      for (const m of movies) {
        const ids = traktIds(m.id);
        if (!ids) report.skipped.push(skippedTitle('watched', m, NO_IDS));
        else items.push({ kind: 'movies', id: m.id, body: { ids, watched_at: m.watchedAt }, plays: 1 });
      }
      const byShow = new Map<string, WatchedEntry[]>();
      for (const e of episodes.values()) byShow.set(e.id, [...(byShow.get(e.id) ?? []), e]);
      for (const [id, eps] of byShow) {
        const ids = traktIds(id);
        if (!ids) {
          report.skipped.push(skippedTitle('watched', { id }, NO_IDS));
          continue;
        }
        // Long shows go out a season at a time, so every request stays small.
        const seasons = new Map<number, { number: number; watched_at: string }[]>();
        for (const e of eps)
          seasons.set(e.season!, [...(seasons.get(e.season!) ?? []), { number: e.episode!, watched_at: e.watchedAt }]);
        for (const [number, list] of seasons)
          items.push({ kind: 'shows', id, body: { ids, seasons: [{ number, episodes: list }] }, plays: list.length });
      }
      const sent = items.reduce((n, i) => n + i.plays, 0);
      if (sent) log.info(`Trakt: adding ${movies.length} movie(s) and ${episodes.size} episode(s) to the history…`);
      const r = await this.send('/sync/history', items, 'watched', report, log);
      report.written.watched += r.added;
      const missing = sent - r.added - r.notFound;
      if (missing > 0)
        log.warn(
          `Trakt reported adding ${r.added.toLocaleString()} of ${sent.toLocaleString()} plays sent (${r.notFound} not found). It may still be processing the rest; reload in a few minutes.`,
        );
      for (const e of [...movies, ...episodes.values()]) {
        this.watchedKeys.add(videoKey(e));
        this.watchedTitles.add(e.id);
      }
    }

    // Library → watchlist, after the history: Trakt takes watched titles off the watchlist, so
    // titles that are (or were just marked) watched aren't added; the history already has them.
    if (changes.library.length) {
      const items: SyncItem[] = [];
      for (const e of changes.library) {
        if (this.watchedTitles.has(e.id)) {
          report.written.library++;
          continue;
        }
        const ids = traktIds(e.id);
        if (!ids) report.skipped.push(skippedTitle('library', e, NO_IDS));
        else items.push({ kind: e.type === 'movie' ? 'movies' : 'shows', id: e.id, body: { ids }, plays: 1 });
      }
      const r = await this.send('/sync/watchlist', items, 'library', report, log);
      report.written.library += r.added + r.existing;
    }

    // Continue Watching → paused playback. Trakt only takes these one at a time, as a "pause".
    for (const p of changes.progress) {
      const ids = traktIds(p.id);
      if (!ids) {
        report.skipped.push(skippedTitle('progress', p, NO_IDS));
        continue;
      }
      const why = this.unsupported('progress', p);
      if (why) {
        report.skipped.push(skippedTitle('progress', p, why));
        continue;
      }
      const progress = Math.round((p.positionMs / p.durationMs) * 10000) / 100;
      const body =
        p.type === 'movie'
          ? { movie: { ids }, progress }
          : p.season !== undefined && p.episode !== undefined
            ? { show: { ids }, episode: { season: p.season, number: p.episode }, progress }
            : undefined;
      if (!body) {
        report.skipped.push(skippedTitle('progress', p, 'no episode given'));
        continue;
      }
      try {
        await this.client.post('/scrobble/pause', body);
        report.written.progress++;
      } catch (e) {
        report.skipped.push(skippedTitle('progress', p, (e as Error).message));
      }
    }

    for (const a of changes.addons)
      report.skipped.push({ scope: 'addons', key: a.name ?? a.manifestUrl, reason: 'Trakt has no add-ons' });
    return report;
  }

  /**
   * Sends items to a /sync endpoint in small batches. Titles Trakt can't find by IMDb/TMDB id are
   * looked up through Trakt's search and sent again by Trakt's own id.
   */
  private async send(
    path: string,
    items: SyncItem[],
    scope: Scope,
    report: ApplyReport,
    log: Logger,
  ): Promise<{ added: number; existing: number; notFound: number }> {
    const total = { added: 0, existing: 0, notFound: 0 };
    const batches = batchByPlays(items, PLAYS_PER_REQUEST);
    // Each title is reported once, even when sent a season at a time.
    const reported = new Set<string>();
    // In the history, Trakt also lists a show as not found when it can't match some of its episodes.
    const reason = (item: SyncItem) =>
      path === '/sync/history' && item.kind === 'shows'
        ? `Trakt didn’t match some of its episodes (season ${(item.body.seasons as { number: number }[] | undefined)?.[0]?.number ?? '?'}); its episode numbering may differ`
        : 'Trakt has no title with this id';
    const notFound = (item: SyncItem) => {
      total.notFound += item.plays;
      const key = `${item.id}|${reason(item)}`;
      if (!reported.has(key)) report.skipped.push(skippedTitle(scope, { id: item.id }, reason(item)));
      reported.add(key);
    };
    const retry: SyncItem[] = [];
    const post = async (batch: SyncItem[]) => {
      const body = {
        movies: batch.filter(i => i.kind === 'movies').map(i => i.body),
        shows: batch.filter(i => i.kind === 'shows').map(i => i.body),
      };
      const r = await this.client.post<SyncResult>(path, body);
      total.added += (r.added?.movies ?? 0) + (r.added?.shows ?? 0) + (r.added?.episodes ?? 0);
      total.existing += (r.existing?.movies ?? 0) + (r.existing?.shows ?? 0) + (r.existing?.episodes ?? 0);
      return r;
    };
    for (const [n, batch] of batches.entries()) {
      if (batches.length > 1) log.info(`Trakt: sending batch ${n + 1} of ${batches.length}…`);
      const r = await post(batch);
      const missingTitles = [...(r.not_found?.movies ?? []), ...(r.not_found?.shows ?? [])].map(nf => idOf(nf.ids));
      for (const item of batch) {
        if (!missingTitles.includes(item.id)) continue;
        // A show in the history can be "not found" when only some of its episodes didn't match;
        // the rest were added, so sending it again would add their plays twice. Only retry what
        // adds nothing twice: watchlist items, and movies (one play, which didn't happen).
        if (path === '/sync/history' && item.kind === 'shows') notFound(item);
        else retry.push(item);
      }
      for (const nf of r.not_found?.episodes ?? []) {
        total.notFound++;
        report.skipped.push({ scope, key: describeIds(nf.ids), reason: 'Trakt has no such episode' });
      }
    }
    if (!retry.length) return total;

    // Second chance: find Trakt's own id for each title it couldn't match.
    const again: SyncItem[] = [];
    for (const item of retry) {
      const trakt = await this.lookup(item.id, item.kind === 'movies' ? 'movie' : 'show');
      if (trakt) again.push({ ...item, body: { ...item.body, ids: { trakt } } });
      else notFound(item);
    }
    for (const batch of batchByPlays(again, PLAYS_PER_REQUEST)) {
      const r = await post(batch);
      const missing = new Set([...(r.not_found?.movies ?? []), ...(r.not_found?.shows ?? [])].map(nf => nf.ids.trakt));
      for (const item of batch) if (missing.has((item.body.ids as Ids).trakt)) notFound(item);
    }
    return total;
  }

  private lookups = new Map<string, Promise<number | undefined>>();
  /** Trakt's own id for a title, via its id search. */
  private lookup(id: string, type: 'movie' | 'show'): Promise<number | undefined> {
    const key = `${type}:${id}`;
    let p = this.lookups.get(key);
    if (!p) {
      const tmdb = /^tmdb:(\d+)$/.exec(id)?.[1];
      const path = /^tt\d+$/.test(id)
        ? `/search/imdb/${id}?type=${type}`
        : tmdb
          ? `/search/tmdb/${tmdb}?type=${type}`
          : undefined;
      p = path
        ? this.client
            .get<{ type: string; movie?: Media; show?: Media }[]>(path)
            .then(r => r.find(x => x.type === type)?.[type]?.ids.trakt)
            .catch(() => undefined)
        : Promise.resolve(undefined);
      this.lookups.set(key, p);
    }
    return p;
  }

  async saveAddons(_list: AddonEntry[], _log: Logger): Promise<ApplyReport> {
    throw new Error(this.addonsLocked);
  }
}
