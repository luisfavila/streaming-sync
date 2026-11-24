import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { AddonEntry, ChangeSet } from '../model.ts';
import type { AddonDiff } from '../sync/compare.ts';
import { countChanges } from '../sync/plan.ts';
import { plural } from './format.ts';

const ICONS = {
  library: 'M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z',
  watched: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.5 2.5L16 9.5',
  progress: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM10 8.5v7l6-3.5z',
  addons: 'M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4h2a2 2 0 1 0 0-4H6V6h4z',
} as const;

/**
 * Asks before writing, listing everything that will change on the To side. A modal dialog:
 * Escape or the backdrop cancels.
 */
export function ConfirmDialog(props: { app: string; who: string; changes: ChangeSet; addons?: AddonDiff; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.open && d.close();
  }, []);

  const c = props.changes;
  const d = props.addons;
  const movies = c.watched.filter((w) => w.type === 'movie').length;
  const episodes = c.watched.filter((w) => w.episode !== undefined).length;
  const series = c.watched.filter((w) => w.type === 'series' && w.episode === undefined).length;
  const off = d?.switched.filter((a) => a.enabled === false) ?? [];
  const on = d?.switched.filter((a) => a.enabled !== false) ?? [];
  const addonCount = d ? d.added.length + d.removed.length + d.switched.length : 0;
  const total = countChanges(c) + addonCount + (d?.reordered ? 1 : 0);

  return (
    <dialog
      ref={ref}
      class="modal confirm"
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
      onClick={(e) => e.target === ref.current && props.onCancel()}
    >
      <div class="modal-inner">
        <header class="modal-head">
          <h2 id="confirm-title">Write to {props.app}?</h2>
          <p class="muted">{props.who}</p>
        </header>

        <ul class="changes">
          {c.library.length > 0 && <Change icon="library" title="Library" count={c.library.length} detail={`Add ${plural(c.library.length, 'title')}`} />}
          {c.watched.length > 0 && (
            <Change
              icon="watched"
              title="Watched"
              count={c.watched.length}
              detail={[movies && plural(movies, 'movie'), episodes && plural(episodes, 'episode'), series && plural(series, 'whole series', 'whole series')].filter(Boolean).join(' · ')}
            />
          )}
          {c.progress.length > 0 && (
            <Change icon="progress" title="Continue Watching" count={c.progress.length} detail={`Update progress for ${plural(c.progress.length, 'title')}`} />
          )}
          {d && (addonCount > 0 || d.reordered) && (
            <Change icon="addons" title="Add-ons" count={addonCount || undefined}>
              <AddonGroup label="Install" kind="add" list={d.added} />
              <AddonGroup label="Remove" kind="remove" list={d.removed} />
              <AddonGroup label="Switch off" kind="off" list={off} />
              <AddonGroup label="Switch on" kind="on" list={on} />
              {d.reordered && <p class="change-detail">New order, as on the Add-ons tab</p>}
            </Change>
          )}
        </ul>

        {d && d.removed.length > 0 ? (
          <p class="modal-note modal-note-warn">
            {plural(d.removed.length, 'add-on')} will be removed from {props.app}. Everything else only adds.
          </p>
        ) : (
          <p class="modal-note">Nothing on {props.app} is removed or marked unwatched.</p>
        )}

        <footer class="modal-foot">
          <button type="button" class="btn btn-quiet" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" class="btn btn-primary" onClick={props.onConfirm} autofocus>
            Write {plural(total, 'change')}
          </button>
        </footer>
      </div>
    </dialog>
  );
}

function Change(props: { icon: keyof typeof ICONS; title: string; count?: number; detail?: string; children?: ComponentChildren }) {
  return (
    <li class={`change change-${props.icon}`}>
      <span class="change-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path d={ICONS[props.icon]} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
      <div class="change-text">
        <p class="change-title">{props.title}</p>
        {props.detail && <p class="change-detail">{props.detail}</p>}
        {props.children}
      </div>
      {props.count !== undefined && <span class="change-count">{props.count.toLocaleString()}</span>}
    </li>
  );
}

function AddonGroup(props: { label: string; kind: 'add' | 'remove' | 'off' | 'on'; list: AddonEntry[] }) {
  if (!props.list.length) return null;
  const sign = { add: '+', remove: '−', off: '○', on: '●' }[props.kind];
  return (
    <div class="addon-group">
      <span class="addon-group-label">{props.label}</span>
      <ul class="pills" aria-label={props.label}>
        {props.list.map((a) => (
          <li class={`pill pill-${props.kind}`}>
            <span aria-hidden="true">{sign}</span> {a.name || a.manifestUrl.replace(/^https?:\/\//, '')}
          </li>
        ))}
      </ul>
    </div>
  );
}
