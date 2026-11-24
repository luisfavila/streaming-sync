import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type Account, APP_NAME, type Side, forgetClient, openProvider, profileName, sideLabel, signOut } from '../auth.ts';
import { getMeta } from '../meta/cinemeta.ts';
import { type AddonEntry, type ChangeSet, SCOPES, type Snapshot } from '../model.ts';
import { type ApplyReport, type Provider, type Skipped, mapLimit } from '../providers/types.ts';
import { type AddonDiff, addonDiff, addonDiffSize, initialAddonDraft, knownNames, selectedChanges } from '../sync/compare.ts';
import { countChanges, plan as makePlan } from '../sync/plan.ts';
import { NO_CHANGES, runWrite } from '../sync/run.ts';
import { AccountSide } from './AccountSide.tsx';
import { AddonEditor } from './AddonEditor.tsx';
import { Compare } from './Compare.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { ago, ep, plural } from './format.ts';
import * as store from './store.ts';

type Load =
  | { status: 'loading'; message?: string }
  | { status: 'ready'; snap: Snapshot; provider: Provider; warnings: string[]; at: number }
  | { status: 'error'; error: string };
type Ready = Extract<Load, { status: 'ready' }>;

interface Result {
  report: ApplyReport;
  /** Ticked changes still missing after re-reading To. */
  left: number;
  /** Add-on list differences still there after re-reading To. */
  addonsLeft: number;
  toLabel: string;
  /** What the app said along the way (e.g. Trakt reporting fewer plays added than sent). */
  warnings: string[];
}

const keyOf = (s?: Side) => (s ? `${s.accountId}#${s.profileIndex ?? 1}` : '');
const sameSide = (a?: Side, b?: Side) => !!a && !!b && keyOf(a) === keyOf(b);
const SCOPE_LABEL = { library: 'Library', watched: 'Watched', progress: 'Continue Watching', addons: 'Add-ons' } as const;
/** The account, plus the profile when a Nuvio account has several. */
const whoLabel = (a: Account, profileIndex?: number) => (a.app === 'nuvio' && a.profiles.length > 1 ? `${a.who} · ${profileName(a, profileIndex)} profile` : a.who);
/** "The 100 S02E03" for a skipped episode, falling back to its key when the title has no known name. */
const skippedName = (s: Skipped, names: Map<string, string>) => {
  const name = s.id && names.get(s.id);
  return name ? [name, ep(s.season, s.episode)].filter(Boolean).join(' ') : s.key;
};

export function App() {
  const initial = useMemo(store.load, []);
  const [remember, setRemember] = useState(initial.remember);
  const [accounts, setAccounts] = useState<Account[]>(initial.accounts);
  const [from, setFrom] = useState<Side | undefined>(initial.from);
  const [to, setTo] = useState<Side | undefined>(initial.to);
  const [loads, setLoads] = useState<Record<string, Load>>({});
  const [names, setNames] = useState(new Map<string, string>());
  /** Titles the user un-ticked, as selectionKey()s. Anything else that can be copied is ticked. */
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<AddonEntry[]>([]);
  const [draftBase, setDraftBase] = useState<AddonEntry[]>([]);
  /** Whether To's draft add-on list starts with From's missing add-ons appended. Off after a write. */
  const [suggestAddons, setSuggestAddons] = useState(true);
  const [writing, setWriting] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<string>();
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const generation = useRef(new Map<string, number>());

  const exists = (s?: Side) => !!s && accounts.some((a) => a.id === s.accountId);
  const fromSide = exists(from) ? from : undefined;
  const toSide = exists(to) ? to : undefined;
  const fromKey = keyOf(fromSide);
  const toKey = keyOf(toSide);
  const same = sameSide(fromSide, toSide);

  useEffect(() => store.save({ remember, accounts, from: fromSide, to: toSide }), [remember, accounts, fromSide, toSide]);

  const account = (s: Side) => accounts.find((a) => a.id === s.accountId)!;
  const upsertAccount = (a: Account) => {
    // Signing in again to a known account: drop its old session's client and what was loaded with
    // it, so the side loads again with the new session.
    forgetClient(a.id);
    for (const [k, gen] of generation.current) if (k.startsWith(a.id + '#')) generation.current.set(k, gen + 1); // drop loads in flight
    setLoads((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => !k.startsWith(a.id + '#'))));
    setAccounts((list) => list.filter((x) => x.id !== a.id).concat(a));
  };
  // Nuvio rotates its tokens; keep the saved copy current.
  const onAuthChange = (a: Account) => setAccounts((list) => list.map((x) => (x.id === a.id ? { ...a } : x)));

  /** Reads everything from one side. Results of an older read of the same side are dropped. */
  const load = async (side: Side): Promise<Load | undefined> => {
    const key = keyOf(side);
    const acc = accountsRef.current.find((a) => a.id === side.accountId);
    if (!acc) return undefined;
    const gen = (generation.current.get(key) ?? 0) + 1;
    generation.current.set(key, gen);
    const set = (l: Load) => {
      if (generation.current.get(key) === gen) setLoads((cur) => ({ ...cur, [key]: l }));
      return l;
    };
    set({ status: 'loading' });
    const warnings: string[] = [];
    try {
      const provider = openProvider(acc, side.profileIndex, onAuthChange);
      const snap = await provider.read(SCOPES, { info: (message) => set({ status: 'loading', message }), warn: (w) => warnings.push(w) });
      return set({ status: 'ready', snap, provider, warnings, at: Date.now() });
    } catch (e) {
      return set({ status: 'error', error: (e as Error).message });
    }
  };

  // Load each side as soon as it's chosen.
  useEffect(() => {
    for (const s of [fromSide, toSide]) if (s && !loads[keyOf(s)]) void load(s);
  }, [fromKey, toKey, loads]);

  // A different pair of sides: start the selection over.
  useEffect(() => {
    setExcluded(new Set());
    setSuggestAddons(true);
    setConfirming(false);
    setResult(undefined);
  }, [fromKey, toKey]);

  const ready = (k: string) => (loads[k]?.status === 'ready' ? (loads[k] as Ready) : undefined);
  const src = fromSide && !same ? ready(fromKey) : undefined;
  const dst = toSide && !same ? ready(toKey) : undefined;
  /** What the To app can't take at all (e.g. Trakt and playback under 1%): shown as "won't copy". */
  const rules = dst?.provider.unsupported?.bind(dst.provider);
  const plan = useMemo(() => (src && dst ? makePlan(src.snap, dst.snap, SCOPES, rules) : undefined), [src?.snap, dst?.snap]);

  // To's add-on list as it would be written; starts as To's own plus From's missing ones.
  // Edits survive From (re)loading; a new To snapshot (other account, reload, after a write) starts over.
  const draftOrigin = useRef<{ snap?: Snapshot; base: AddonEntry[] }>({ base: [] });
  useEffect(() => {
    if (!dst) return;
    const base = initialAddonDraft(suggestAddons ? plan : undefined, dst.snap, dst.provider.canDisableAddons);
    const prev = draftOrigin.current;
    draftOrigin.current = { snap: dst.snap, base };
    setDraftBase(base);
    setDraft((cur) => (prev.snap === dst.snap && JSON.stringify(cur) !== JSON.stringify(prev.base) ? cur : base));
  }, [plan, dst?.snap, suggestAddons]);

  // Names for titles the apps don't name (e.g. Nuvio's Continue Watching), from Cinemeta.
  useEffect(() => {
    const snaps = [ready(fromKey)?.snap, ready(toKey)?.snap];
    const known = knownNames(...snaps);
    setNames(known);
    const missing = new Map<string, Snapshot['progress'][number]['type']>();
    for (const s of snaps) for (const e of [...(s?.watched ?? []), ...(s?.progress ?? [])]) if (!known.has(e.id) && /^tt\d+$/.test(e.id)) missing.set(e.id, e.type);
    if (!missing.size) return;
    let live = true;
    const found = new Map(known);
    void mapLimit([...missing].slice(0, 600), 8, async ([id, type], i) => {
      const meta = await getMeta(type, id).catch(() => undefined);
      if (meta?.name) found.set(id, meta.name);
      if (live && i % 25 === 24) setNames(new Map(found));
    }).then(() => live && setNames(new Map(found)));
    return () => {
      live = false;
    };
  }, [loads[fromKey], loads[toKey]]);

  const changes = plan ? selectedChanges(plan, excluded) : NO_CHANGES;
  const diff = dst && !dst.provider.addonsLocked ? addonDiff(dst.snap.addons, draft) : undefined;
  const addonChanges = diff ? addonDiffSize(diff) : 0;
  const total = countChanges(changes) + addonChanges;
  const busy = !!writing;

  const write = async () => {
    if (!dst || !toSide) return;
    const toLabel = sideLabel(account(toSide), toSide.profileIndex);
    setConfirming(false);
    setError(undefined);
    setResult(undefined);
    const warnings: string[] = [];
    try {
      const outcome = await runWrite({
        from: src?.snap,
        to: dst.provider,
        toLabel,
        confirmed: changes,
        excluded,
        addons: addonChanges > 0 ? draft : undefined,
        loadedAddons: dst.snap.addons,
        readAfter: async () => {
          const after = await load(toSide);
          if (after?.status !== 'ready') throw new Error(`Written, but re-reading ${toLabel} failed: ${after?.status === 'error' ? after.error : 'unknown error'}`);
          return after.snap;
        },
        log: { info: (m) => setWriting(m), warn: (m) => warnings.push(m) },
      });
      setSuggestAddons(false);
      setResult({ ...outcome, toLabel, warnings });
    } catch (e) {
      setError(`${(e as Error).message}. Some changes may have been written; reload To to see where it stands.`);
    } finally {
      setWriting(undefined);
    }
  };

  const forget = async (a: Account) => {
    await signOut(a);
    setAccounts((list) => list.filter((x) => x.id !== a.id));
    setLoads((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => !k.startsWith(a.id + '#'))));
  };

  /** Sets one side. Choosing what the other side has swaps them, so both never point at the same place. */
  const choose = (which: 'from' | 'to', s: Side | undefined) => {
    const mine = which === 'from' ? fromSide : toSide;
    const other = which === 'from' ? toSide : fromSide;
    const setMine = which === 'from' ? setFrom : setTo;
    const setOther = which === 'from' ? setTo : setFrom;
    if (s && other && sameSide(s, other)) setOther(mine);
    setMine(s);
  };

  const swap = () => {
    setFrom(toSide);
    setTo(fromSide);
  };

  const status = (side: Side | undefined) => {
    const l = side && loads[keyOf(side)];
    if (!side || !l) return undefined;
    return <SideStatus load={l} onReload={() => void load(side)} hasAddons={account(side).app !== 'trakt'} />;
  };
  const reload = (side: Side | undefined) =>
    side && loads[keyOf(side)]?.status === 'ready' ? (
      <button type="button" class="btn btn-small btn-icon" disabled={busy} onClick={() => void load(side)} aria-label="Reload" title="Reload">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    ) : undefined;
  const meta = (side: Side | undefined) => {
    const l = side && ready(keyOf(side));
    return l ? <SideMeta load={l} /> : undefined;
  };

  const anyLoaded = !!(fromSide && ready(fromKey)) || !!(toSide && ready(toKey));

  return (
    <div class="page">
      <header class="masthead">
        <h1>Streaming Sync</h1>
        <div class="masthead-text">
          <p class="lede">See what two Stremio, Nuvio or Trakt accounts each have, and copy across what you pick: library, watch history, Continue Watching and add-ons, in any direction.</p>
          <p class="privacy">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            </svg>
            This page runs in your browser. Sign-ins and data go straight to Stremio, Nuvio and Trakt, never to anyone else.
          </p>
        </div>
      </header>

      <div class="layout">
        <aside class="sidebar" aria-label="Accounts">
          <AccountSide
            title="From"
            side={fromSide}
            other={toSide}
            otherTitle="To"
            accounts={accounts}
            disabled={busy}
            status={status(fromSide)}
            actions={reload(fromSide)}
            meta={meta(fromSide)}
            onChange={(s) => choose('from', s)}
            onSignedIn={upsertAccount}
            onForget={forget}
          />
          <button type="button" class="swap" onClick={swap} disabled={busy || (!fromSide && !toSide)} aria-label="Swap From and To" title="Swap direction">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M5 9h13l-4-4M19 15H6l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <AccountSide
            title="To"
            side={toSide}
            other={fromSide}
            otherTitle="From"
            accounts={accounts}
            disabled={busy}
            status={status(toSide)}
            actions={reload(toSide)}
            meta={meta(toSide)}
            onChange={(s) => choose('to', s)}
            onSignedIn={upsertAccount}
            onForget={forget}
          />
          <label class="check remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
            Remember accounts on this device
          </label>
        </aside>

        <main class="content">
          {same && <p class="error">From and To are the same{account(fromSide!).app === 'nuvio' ? ' profile' : ' account'}. Pick a different one for one side.</p>}

          {!anyLoaded && !same && (
            <section class="card placeholder" aria-label="Compare">
              {(fromSide && loads[fromKey]?.status === 'loading') || (toSide && loads[toKey]?.status === 'loading') ? (
                <>
                  <span class="spinner" aria-hidden="true" />
                  <h2>Reading your account…</h2>
                  <p>Large libraries take a little while: watched episodes are matched against each series' episode list.</p>
                </>
              ) : (
                <>
                  <h2>Pick two accounts</h2>
                  <p>Sign in on the left. Their library, watch history, Continue Watching and add-ons show up here side by side, and you choose what to copy.</p>
                </>
              )}
            </section>
          )}

          {anyLoaded && !same && (
            <Compare
              source={fromSide ? ready(fromKey)?.snap : undefined}
              target={toSide ? ready(toKey)?.snap : undefined}
              plan={plan}
              names={names}
              excluded={excluded}
              onExcluded={setExcluded}
              disabled={busy}
              addonChanges={addonChanges}
              addonEditor={
                <AddonEditor
                  source={fromSide ? ready(fromKey)?.snap.addons : undefined}
                  current={dst?.snap.addons}
                  draft={dst ? draft : []}
                  initial={draftBase}
                  onDraft={setDraft}
                  canDisable={!!dst?.provider.canDisableAddons}
                  locked={dst ? dst.provider.addonsLocked : 'Sign in on the To side to edit its add-ons.'}
                  disabled={busy || !dst}
                />
              }
            />
          )}

          {dst && toSide && !same && (
            <section class="card actionbar" aria-label="Write">
              {writing ? (
                <p class="writing" aria-live="polite">
                  <span class="spinner" aria-hidden="true" /> {writing}
                </p>
              ) : (
                <div class="actions">
                  <p class="actionbar-text">
                    {total
                      ? summaryLines(changes, diff).join(' · ')
                      : src
                        ? 'Nothing ticked to copy.'
                        : "Choose a From account to copy from, or edit To's add-ons."}
                  </p>
                  <button type="button" class="btn btn-primary" disabled={!total} onClick={() => setConfirming(true)}>
                    Write to {APP_NAME[account(toSide).app]}…
                  </button>
                </div>
              )}
              <p class="hint">Copying only adds: titles, watched marks and newer progress. To's add-ons end up exactly as listed on the Add-ons tab.</p>
            </section>
          )}

          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}

          {result && <ResultView result={result} names={names} />}

          {confirming && dst && toSide && (
            <ConfirmDialog
              app={APP_NAME[account(toSide).app]}
              who={whoLabel(account(toSide), toSide.profileIndex)}
              changes={changes}
              addons={diff}
              onConfirm={write}
              onCancel={() => setConfirming(false)}
            />
          )}
        </main>
      </div>

      <footer class="footer">
        <p>
          Not affiliated with Stremio, Nuvio or Trakt. Uses Trakt's public API, and the same private APIs Stremio's and Nuvio's own apps use, which may change.{' '}
          {remember ? 'Signed-in accounts are kept in this browser only.' : 'Accounts are forgotten when you close this page.'}
        </p>
        <p class="credit">
          Made by{' '}
          <a href="https://luisavila.com" target="_blank" rel="noopener">
            Luis Ávila
          </a>{' '}
          with <span aria-label="love">💖</span> and Claude
        </p>
      </footer>
    </div>
  );
}

function SideStatus(props: { load: Load; onReload: () => void; hasAddons: boolean }) {
  const l = props.load;
  if (l.status === 'loading')
    return (
      <div class="side-status side-loading" aria-live="polite">
        <span class="spinner" aria-hidden="true" />
        <span>{l.message ?? 'Loading…'}</span>
      </div>
    );
  if (l.status === 'error')
    return (
      <div class="side-status error" role="alert">
        <p>Couldn't load: {l.error}.</p>
        <button type="button" class="btn btn-small" onClick={props.onReload}>
          Try again
        </button>
      </div>
    );
  const s = l.snap;
  const movies = s.watched.filter((w) => w.type === 'movie').length;
  const episodes = s.watched.filter((w) => w.episode !== undefined).length;
  return (
    <dl class={props.hasAddons ? 'stats' : 'stats stats-3'}>
      <Stat id="library" label="Library" n={s.library.length} />
      <Stat id="watched" label="Watched" n={movies + episodes} title={`${plural(movies, 'movie')} and ${plural(episodes, 'episode')}`} />
      <Stat id="progress" label="Progress" n={s.progress.length} title="Continue Watching" />
      {props.hasAddons && <Stat id="addons" label="Add-ons" n={s.addons.length} />}
    </dl>
  );
}

/** "Loaded 2 minutes ago · 4 notes", under a loaded side. */
function SideMeta({ load }: { load: Ready }) {
  return (
    <>
      <span>Loaded {ago(new Date(load.at).toISOString())}</span>
      {load.warnings.length > 0 && (
        <details class="notes notes-warn">
          <summary>{plural(load.warnings.length, 'note')}</summary>
          <ul class="items">
            {load.warnings.map((w) => (
              <li>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Stat(props: { id: string; label: string; n: number; title?: string }) {
  return (
    <div class="stat" data-stat={props.id} title={props.title}>
      <dt>{props.label}</dt>
      <dd class="stat-n">{props.n.toLocaleString()}</dd>
    </div>
  );
}

/** What a write would do, in short phrases for the write bar. */
function summaryLines(c: ChangeSet, d: AddonDiff | undefined): string[] {
  const out: string[] = [];
  if (c.library.length) out.push(plural(c.library.length, 'library title'));
  const movies = c.watched.filter((w) => w.type === 'movie').length;
  const eps = c.watched.filter((w) => w.episode !== undefined).length;
  const series = c.watched.filter((w) => w.type === 'series' && w.episode === undefined).length;
  const watched = [movies && plural(movies, 'movie'), eps && plural(eps, 'episode'), series && plural(series, 'whole series', 'whole series')].filter(Boolean).join(', ');
  if (watched) out.push(`${watched} watched`);
  if (c.progress.length) out.push(plural(c.progress.length, 'progress update'));
  if (d) {
    if (d.added.length) out.push(`${plural(d.added.length, 'add-on')} to install`);
    if (d.removed.length) out.push(`${plural(d.removed.length, 'add-on')} to remove`);
    if (d.switched.length) out.push(`${plural(d.switched.length, 'add-on')} switched ${d.switched.every((a) => a.enabled === false) ? 'off' : d.switched.every((a) => a.enabled !== false) ? 'on' : 'on or off'}`);
    if (d.reordered) out.push('add-ons reordered');
  }
  return out;
}

function ResultView({ result, names }: { result: Result; names: Map<string, string> }) {
  const { report, left, addonsLeft } = result;
  const written = SCOPES.filter((s) => report.written[s] > 0);
  const problems = left + addonsLeft;
  return (
    <section class="card result" aria-label="Result">
      <h2>{problems ? 'Done, with some items left over' : 'Done'}</h2>
      {written.length > 0 && (
        <ul class="tally">
          {written.map((s) => (
            <li>
              <span class="n">{report.written[s].toLocaleString()}</span> {SCOPE_LABEL[s]}
            </li>
          ))}
        </ul>
      )}
      {problems === 0 ? (
        <p class="ok">Checked: {result.toLabel} now has everything you picked.</p>
      ) : (
        <p class="warn">
          {left > 0 && `${plural(left, 'ticked item')} still missing after re-reading ${result.toLabel}. `}
          {addonsLeft > 0 && `The add-on list on ${result.toLabel} doesn't fully match what was saved. `}
          Usually these are the ones listed below; otherwise reload To in a minute, as the app may still be catching up.
        </p>
      )}
      {result.warnings.length > 0 && (
        <ul class="warn result-warnings">
          {result.warnings.map((w) => (
            <li>{w}</li>
          ))}
        </ul>
      )}
      {report.skipped.length > 0 && (
        <details open>
          <summary>Not written ({report.skipped.length})</summary>
          <ul class="items">
            {report.skipped.map((s) => (
              <li>
                <span class="item-name">{skippedName(s, names)}</span> <span class="muted">{s.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
