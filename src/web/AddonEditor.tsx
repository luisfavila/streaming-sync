import { useState } from 'preact/hooks';
import { type AddonEntry, addonKey, isLocalOnlyAddon, normalizeManifestUrl } from '../model.ts';

/**
 * From's add-ons next to the list To will have after saving. The To list is a draft: add, remove,
 * reorder and (where the app supports it) switch add-ons off, then write it with everything else.
 */
export function AddonEditor(props: {
  source?: AddonEntry[];
  /** To's add-ons as they are now. */
  current?: AddonEntry[];
  draft: AddonEntry[];
  /** The draft before any edits, for "Undo changes". */
  initial: AddonEntry[];
  onDraft: (next: AddonEntry[]) => void;
  canDisable: boolean;
  locked?: string;
  disabled: boolean;
}) {
  const { draft, current = [] } = props;
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string>();
  const [dragFrom, setDragFrom] = useState<number>();

  const inDraft = new Set(draft.map((a) => addonKey(a.manifestUrl)));
  const inCurrent = new Set(current.map((a) => addonKey(a.manifestUrl)));
  const removed = current.filter((a) => !inDraft.has(addonKey(a.manifestUrl)));
  const editable = !props.locked && !props.disabled;
  const missing = (props.source ?? []).filter((a) => !inDraft.has(addonKey(a.manifestUrl)) && !isLocalOnlyAddon(a.manifestUrl));
  const dirty = JSON.stringify(draft) !== JSON.stringify(props.initial);

  const set = (next: AddonEntry[]) => props.onDraft(next);
  const append = (list: AddonEntry[]) =>
    set([...draft, ...list.filter((a) => !inDraft.has(addonKey(a.manifestUrl))).map((a) => ({ ...a, protected: false, enabled: props.canDisable ? a.enabled !== false : true }))]);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= draft.length || from === to) return;
    const next = [...draft];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    set(next);
  };
  const putBack = (a: AddonEntry) => {
    // Back where it was in To's current list, as near as the draft allows.
    const i = current.indexOf(a);
    const before = current.slice(0, i).map((x) => addonKey(x.manifestUrl));
    const at = Math.max(0, ...before.map((k) => draft.findIndex((d) => addonKey(d.manifestUrl) === k) + 1));
    set([...draft.slice(0, at), a, ...draft.slice(at)]);
  };

  const addByUrl = async (e: Event) => {
    e.preventDefault();
    setAddError(undefined);
    let manifestUrl: string;
    try {
      manifestUrl = normalizeManifestUrl(url);
      new URL(manifestUrl);
    } catch {
      setAddError("That doesn't look like an add-on URL.");
      return;
    }
    if (inDraft.has(addonKey(manifestUrl))) {
      setAddError("It's already on the list.");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch(manifestUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`the add-on answered HTTP ${res.status}`);
      const m = (await res.json()) as { id?: string; name?: string; logo?: string };
      if (!m?.id || !m.name) throw new Error("that URL isn't an add-on manifest");
      append([{ manifestUrl, name: m.name, logo: typeof m.logo === 'string' ? m.logo : undefined, enabled: true }]);
      setUrl('');
    } catch (err) {
      setAddError(`Couldn't load it: ${(err as Error).message}.`);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div class="addons">
      <div class="addon-col">
        <h3>
          On From <span class="muted">({(props.source ?? []).length})</span>
        </h3>
        {!props.source ? (
          <p class="empty">Sign in on the From side to see its add-ons.</p>
        ) : props.source.length === 0 ? (
          <p class="empty">No add-ons.</p>
        ) : (
          <ul class="addon-list">
            {props.source.map((a) => {
              const k = addonKey(a.manifestUrl);
              const local = isLocalOnlyAddon(a.manifestUrl);
              return (
                <li class="addon">
                  <AddonInfo a={a} />
                  {a.enabled === false && <span class="tag">Off</span>}
                  {inCurrent.has(k) ? (
                    <span class="tag tag-ok">On To</span>
                  ) : inDraft.has(k) ? (
                    <span class="tag tag-new">Will be added</span>
                  ) : local ? (
                    <span class="tag" title="Runs on the From device only, so it can't be copied">
                      Device only
                    </span>
                  ) : (
                    <button type="button" class="btn btn-small" disabled={!editable} onClick={() => append([a])}>
                      Add
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {missing.length > 0 && editable && (
          <button type="button" class="btn" onClick={() => append(missing)}>
            Add all {missing.length} missing
          </button>
        )}
      </div>

      <div class="addon-col">
        <div class="addon-col-head">
          <h3>
            On To after writing <span class="muted">({draft.length})</span>
          </h3>
          {dirty && editable && (
            <button type="button" class="btn btn-quiet btn-small" onClick={() => set(props.initial.map((a) => ({ ...a })))}>
              Undo edits
            </button>
          )}
        </div>
        {props.locked && <p class="hint">{props.locked}</p>}
        <ul class="addon-list">
          {draft.map((a, i) => {
            const isNew = !inCurrent.has(addonKey(a.manifestUrl));
            return (
              <li
                class={`addon ${dragFrom === i ? 'dragging' : ''} ${a.enabled === false ? 'addon-off' : ''}`}
                draggable={editable}
                onDragStart={(e) => {
                  setDragFrom(i);
                  e.dataTransfer?.setData('text/plain', String(i));
                }}
                onDragEnd={() => setDragFrom(undefined)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom !== undefined) move(dragFrom, i);
                  setDragFrom(undefined);
                }}
              >
                {editable && (
                  <span class="order">
                    <button type="button" class="icon-btn" aria-label={`Move ${a.name ?? 'add-on'} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                      ↑
                    </button>
                    <button type="button" class="icon-btn" aria-label={`Move ${a.name ?? 'add-on'} down`} disabled={i === draft.length - 1} onClick={() => move(i, i + 1)}>
                      ↓
                    </button>
                  </span>
                )}
                <AddonInfo a={a} />
                {isNew && <span class="tag tag-new">New</span>}
                {props.canDisable && (
                  <label class="switch" title={a.enabled === false ? 'Off: installed but not used' : 'On'}>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={a.enabled !== false}
                      disabled={!editable}
                      aria-label={`${a.name ?? 'Add-on'} on`}
                      onChange={(e) => set(draft.map((x, j) => (j === i ? { ...x, enabled: e.currentTarget.checked } : x)))}
                    />
                    <span class="switch-track" aria-hidden="true" />
                  </label>
                )}
                {a.protected ? (
                  <span class="tag" title="Built into the app, can't be removed">
                    Built in
                  </span>
                ) : (
                  editable && (
                    <button type="button" class="icon-btn" aria-label={`Remove ${a.name ?? a.manifestUrl}`} title="Remove" onClick={() => set(draft.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  )
                )}
              </li>
            );
          })}
        </ul>
        {removed.length > 0 && (
          <div class="removed">
            <p class="warn-text">Will be removed from To:</p>
            <ul class="addon-list">
              {removed.map((a) => (
                <li class="addon addon-removed">
                  <AddonInfo a={a} />
                  {editable && (
                    <button type="button" class="btn btn-small" onClick={() => putBack(a)}>
                      Keep
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {editable && (
          <form class="add-addon" onSubmit={addByUrl}>
            <input type="url" placeholder="https://…/manifest.json" aria-label="Add-on URL" value={url} onInput={(e) => setUrl(e.currentTarget.value)} required />
            <button type="submit" class="btn" disabled={adding}>
              {adding ? 'Loading…' : 'Add by URL'}
            </button>
          </form>
        )}
        {addError && <p class="error">{addError}</p>}
      </div>
    </div>
  );
}

function AddonInfo({ a }: { a: AddonEntry }) {
  const [broken, setBroken] = useState<string>();
  const host = a.manifestUrl.replace(/^https?:\/\//, '').replace(/\/manifest\.json$/, '');
  const label = a.name || host.split('/')[0]!;
  return (
    <>
      {a.logo && broken !== a.logo ? (
        <img class="addon-logo" src={a.logo} alt="" loading="lazy" onError={() => setBroken(a.logo)} />
      ) : (
        <span class="addon-logo addon-logo-fb" aria-hidden="true">
          {label[0]?.toUpperCase() ?? '?'}
        </span>
      )}
      <span class="addon-text">
        <span class="addon-name">{label}</span>
        <span class="addon-url" title={a.manifestUrl}>
          {host}
        </span>
      </span>
    </>
  );
}
