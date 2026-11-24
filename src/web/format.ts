import type { ProgressEntry, WatchedEntry } from '../model.ts';

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export const ep = (s?: number, e?: number) =>
  s !== undefined && e !== undefined ? `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}` : '';

/** "S01E01–S02E03" for a list of episodes (sorted here). */
export function episodeRange(list: WatchedEntry[]): string {
  const eps = list.filter(w => w.episode !== undefined).sort((a, b) => a.season! - b.season! || a.episode! - b.episode!);
  if (!eps.length) return '';
  const first = ep(eps[0]!.season, eps[0]!.episode);
  const last = ep(eps.at(-1)!.season, eps.at(-1)!.episode);
  return first === last ? first : `${first}–${last}`;
}

/** What a side has watched of one title, e.g. "12 episodes" or "Watched". */
export function watchedSummary(list: WatchedEntry[] | undefined): string {
  if (!list?.length) return '';
  if (list[0]!.type === 'movie') return 'Watched';
  const eps = list.filter(e => e.episode !== undefined).length;
  const whole = list.some(e => e.episode === undefined);
  if (!eps) return 'Whole series';
  return whole ? `${plural(eps, 'episode')}, all aired` : plural(eps, 'episode');
}

/** What would be copied for one title, e.g. "4 episodes (S01E05–S02E01)". */
export function watchedMissing(list: WatchedEntry[]): string {
  if (!list.length) return '';
  if (list[0]!.type === 'movie') return 'Watched mark';
  const eps = list.filter(e => e.episode !== undefined);
  const parts: string[] = [];
  if (eps.length) parts.push(`${plural(eps.length, 'episode')} (${episodeRange(eps)})`);
  if (list.some(e => e.episode === undefined)) parts.push('whole-series mark');
  return parts.join(' and ');
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function ago(iso: string): string {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (!Number.isFinite(s)) return '';
  const abs = Math.abs(s);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(Math.round(s / (86400 * 30)), 'month');
  return rtf.format(Math.round(s / (86400 * 365)), 'year');
}

/** "S02E03 · 45%" (or "45%" for movies). */
export function progressSummary(p: ProgressEntry | undefined): string {
  if (!p) return '';
  const pct = p.durationMs > 0 ? `${Math.min(100, Math.round((p.positionMs / p.durationMs) * 100))}%` : 'length unknown';
  return [ep(p.season, p.episode), pct].filter(Boolean).join(' · ');
}

/** Poster for a title: the app's own, else MetaHub's for IMDb ids. */
export function posterUrl(id: string, poster?: string): string | undefined {
  if (poster) return poster;
  const imdb = /^tt\d+$/.exec(id)?.[0];
  return imdb ? `https://images.metahub.space/poster/small/${imdb}/img` : undefined;
}
