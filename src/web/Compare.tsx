import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { Snapshot } from '../model.ts';
import {
  type LibraryRow,
  type ProgressRow,
  type Row,
  type RowState,
  type WatchedRow,
  libraryRows,
  progressRows,
  selectionKey,
  watchedRows,
} from '../sync/compare.ts';
import type { Plan } from '../sync/plan.ts';
import { ago, plural, posterUrl, progressSummary, watchedMissing, watchedSummary } from './format.ts';

type TitleTab = 'library' | 'watched' | 'progress';
export type Tab = TitleTab | 'addons';
type Filter = 'copy' | 'skip' | 'toOnly' | 'both' | 'all';

const TAB_LABEL: Record<Tab, string> = { library: 'Library', watched: 'Watched', progress: 'Continue Watching', addons: 'Add-ons' };
const FILTER_LABEL: Record<Filter, string> = { copy: 'To copy', skip: 'Won’t copy', toOnly: 'Only on To', both: 'On both', all: 'All' };
const PAGE = 150;

export function Compare(props: {
  source?: Snapshot;
  target?: Snapshot;
  plan?: Plan;
  names: Map<string, string>;
  excluded: ReadonlySet<string>;
  onExcluded: (next: Set<string>) => void;
  disabled: boolean;
  /** Pending add-on list changes, shown on the Add-ons tab. */
  addonChanges: number;
  addonEditor: ComponentChildren;
}) {
  const [tab, setTab] = useState<Tab>('library');
  const [filter, setFilter] = useState<Filter>('copy');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const both = !!props.source && !!props.target;

  const rows = useMemo(
    () => ({
      library: libraryRows(props.source, props.target, props.plan),
      watched: watchedRows(props.source, props.target, props.plan),
      progress: progressRows(props.source, props.target, props.plan),
    }),
    [props.source, props.target, props.plan],
  );

  const selectedCount = (t: TitleTab) => rows[t].filter((r) => r.state === 'copy' && !props.excluded.has(selectionKey(t, r.id))).length;
  const name = (r: Row<unknown>) => r.name ?? props.names.get(r.id) ?? r.id;

  const switchTab = (t: Tab) => {
    setTab(t);
    setShown(PAGE);
  };

  let body: ComponentChildren;
  if (tab === 'addons') {
    body = props.addonEditor;
  } else {
    const all = rows[tab] as Row<unknown>[];
    const effective: Filter = both ? filter : 'all';
    const q = query.trim().toLowerCase();
    const matches = (r: Row<unknown>) => !q || name(r).toLowerCase().includes(q) || r.id.toLowerCase().includes(q);
    const searched = all.filter(matches);
    const count = (f: Filter) => searched.filter((r) => inFilter(r.state, f)).length;
    const list = searched.filter((r) => inFilter(r.state, effective));
    const copyable = list.filter((r) => r.state === 'copy');
    const allTicked = copyable.length > 0 && copyable.every((r) => !props.excluded.has(selectionKey(tab, r.id)));

    const setTicked = (ids: string[], on: boolean) => {
      const next = new Set(props.excluded);
      for (const id of ids) on ? next.delete(selectionKey(tab, id)) : next.add(selectionKey(tab, id));
      props.onExcluded(next);
    };

    body = (
      <>
        <div class="toolbar">
          <input type="search" class="search" placeholder="Search titles" aria-label="Search titles" value={query} onInput={(e) => (setQuery(e.currentTarget.value), setShown(PAGE))} />
          {both && (
            <div class="chips" role="group" aria-label="Show">
              {(Object.keys(FILTER_LABEL) as Filter[]).filter((f) => f !== 'skip' || count('skip') > 0 || effective === 'skip').map((f) => (
                <button type="button" class="chip" aria-pressed={effective === f} onClick={() => (setFilter(f), setShown(PAGE))}>
                  {FILTER_LABEL[f]} <span class="chip-n">{count(f).toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {both && copyable.length > 0 && (
          <label class="check select-all">
            <input type="checkbox" checked={allTicked} disabled={props.disabled} onChange={(e) => setTicked(copyable.map((r) => r.id), e.currentTarget.checked)} />
            Copy all {plural(copyable.length, 'title')} shown
          </label>
        )}

        {list.length === 0 ? (
          <p class="empty">
            {q ? 'No titles match your search.' : effective === 'copy' ? `Nothing to copy: To already has everything From has here.` : 'Nothing here.'}
            {effective !== 'all' && (
              <>
                {' '}
                <button type="button" class="link" onClick={() => setFilter('all')}>
                  Show all
                </button>
              </>
            )}
          </p>
        ) : (
          <ul
            class="rows"
            aria-label={TAB_LABEL[tab]}
            onScroll={(e) => {
              // Render more as the list scrolls near its end.
              const el = e.currentTarget;
              if (list.length > shown && el.scrollTop + el.clientHeight > el.scrollHeight - 400) setShown((n) => n + PAGE);
            }}
          >
            <li class="rows-head" aria-hidden="true">
              <span />
              <span>Title</span>
              <span>From</span>
              <span>To</span>
            </li>
            {list.slice(0, shown).map((r) => (
              <TitleRow
                key={r.id}
                tab={tab}
                row={r}
                name={name(r)}
                selectable={both}
                ticked={!props.excluded.has(selectionKey(tab, r.id))}
                disabled={props.disabled}
                onTick={(on) => setTicked([r.id], on)}
              />
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <section class="card compare" aria-label="Compare">
      <div class="tabs" role="tablist" aria-label="What to compare">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => {
          const n = t === 'addons' ? props.addonChanges : both ? selectedCount(t) : 0;
          return (
            <button type="button" role="tab" aria-selected={tab === t} onClick={() => switchTab(t)}>
              {TAB_LABEL[t]}
              {n > 0 && (
                <span class="tab-n" title={t === 'addons' ? 'Changes to the add-on list' : 'Ticked to copy'}>
                  {n.toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {body}
    </section>
  );
}

function inFilter(state: RowState, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'skip') return state === 'fromOnly';
  return state === f;
}

function TitleRow(props: { tab: TitleTab; row: Row<unknown>; name: string; selectable: boolean; ticked: boolean; disabled: boolean; onTick: (on: boolean) => void }) {
  const { tab, row } = props;
  const poster = posterUrl(row.id, row.poster);
  let from: string;
  let to: string;
  let note = '';
  if (tab === 'library') {
    const r = row as LibraryRow;
    from = r.from ? 'In library' : '';
    to = r.to ? 'In library' : '';
  } else if (tab === 'watched') {
    const r = row as WatchedRow;
    from = watchedSummary(r.from);
    to = watchedSummary(r.to);
    if (r.state === 'copy') note = `Copies ${watchedMissing(r.missing)}`;
  } else {
    const r = row as ProgressRow;
    from = r.from ? `${progressSummary(r.from)} · ${ago(r.from.updatedAt)}` : '';
    to = r.to ? `${progressSummary(r.to)} · ${ago(r.to.updatedAt)}` : '';
    // Why From's progress isn't copied, as the planner decided.
    if (r.state !== 'copy' && r.why) note = `Not copied: ${r.why}`;
  }
  if (row.blocked && row.state !== 'copy') note = `Can’t copy: ${row.blocked}`;
  const id = `row-${tab}-${row.id}`;
  return (
    <li class={`row row-${row.state}`}>
      <span class="row-check">
        {props.selectable && row.state === 'copy' && (
          <input type="checkbox" id={id} checked={props.ticked} disabled={props.disabled} onChange={(e) => props.onTick(e.currentTarget.checked)} aria-label={`Copy ${props.name}`} />
        )}
      </span>
      <label class="row-title" for={row.state === 'copy' && props.selectable ? id : undefined}>
        {poster ? <img class="poster" src={poster} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : <span class="poster" />}
        <span class="row-text">
          <span class="row-name">{props.name}</span>
          <span class="row-sub">
            {row.type === 'movie' ? 'Movie' : 'Series'}
            {note && ` · ${note}`}
          </span>
        </span>
      </label>
      <span class={`cell ${from ? '' : 'cell-none'}`} data-side="From">
        {from || 'Not there'}
      </span>
      <span class={`cell ${to ? '' : 'cell-none'}`} data-side="To">
        {to || 'Not there'}
      </span>
    </li>
  );
}
