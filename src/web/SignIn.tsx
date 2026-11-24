import { useEffect, useRef, useState } from 'preact/hooks';
import * as auth from '../auth.ts';
import { type Account, APP_NAME, type AppKind, type LinkCode } from '../auth.ts';
import { BUILT_IN_APP, BUILT_IN_REDIRECT_URI, type TraktApp } from '../providers/trakt/api.ts';

const TRAKT_APP_KEY = 'streaming-sync:trakt-app';
const TRAKT_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';

/** The Trakt app to sign in with: the one this page was built with, else the user's own (kept in this browser). */
function loadTraktApp(): TraktApp | undefined {
  if (BUILT_IN_APP) return BUILT_IN_APP;
  try {
    const a = JSON.parse(localStorage.getItem(TRAKT_APP_KEY) ?? 'null') as TraktApp | null;
    return a?.clientId ? a : undefined;
  } catch {
    return undefined;
  }
}
function saveTraktApp(a: TraktApp | undefined) {
  try {
    if (a) localStorage.setItem(TRAKT_APP_KEY, JSON.stringify(a));
    else localStorage.removeItem(TRAKT_APP_KEY);
  } catch {
    // storage blocked: it's kept for this visit only
  }
}

type Method = 'link' | 'password' | 'token';

/** PKCE sign-in works when the page is built with a redirect URI that points back to where it's served. */
const PKCE_REDIRECT = (() => {
  try {
    return BUILT_IN_REDIRECT_URI && new URL(BUILT_IN_REDIRECT_URI).origin === location.origin ? BUILT_IN_REDIRECT_URI : undefined;
  } catch {
    return undefined;
  }
})();

const STREMIO_SNIPPET = 'copy(JSON.parse(localStorage.profile).auth.key)';

export function SignIn(props: { onSignedIn: (a: Account) => void; onCancel?: () => void }) {
  const [app, setApp] = useState<AppKind>('stremio');
  const [method, setMethod] = useState<Method>('link');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [link, setLink] = useState<LinkCode>();
  const abort = useRef<AbortController>();
  const [traktApp, setTraktApp] = useState<TraktApp | undefined>(loadTraktApp);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  /** Trakt with a "Sign in with Trakt" window, unless the user asked for a code. */
  const [traktCode, setTraktCode] = useState(false);
  const traktWindow = app === 'trakt' && !!PKCE_REDIRECT && !!traktApp && traktApp === BUILT_IN_APP && !traktCode;
  const linkOnly = app === 'trakt';
  const shownMethod: Method = linkOnly ? 'link' : method;

  const stopLink = () => {
    abort.current?.abort();
    abort.current = undefined;
    setLink(undefined);
  };
  useEffect(() => stopLink, []);
  useEffect(() => {
    stopLink();
    setError(undefined);
  }, [app, method]);

  const run = async (fn: () => Promise<Account>) => {
    setBusy(true);
    setError(undefined);
    try {
      props.onSignedIn(await fn());
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startLink = async () => {
    stopLink();
    setError(undefined);
    setBusy(true);
    // Set up cancelling before asking for a code, so switching app meanwhile cancels this one.
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const code = app === 'stremio' ? await auth.stremioLink() : app === 'nuvio' ? await auth.nuvioLink() : await auth.traktLink(traktApp!);
      if (ctrl.signal.aborted) return;
      setLink(code);
      setBusy(false);
      const account = await code.wait(ctrl.signal);
      props.onSignedIn(account);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      setLink(undefined);
    } finally {
      setBusy(false);
    }
  };

  const startTraktWindow = async () => {
    stopLink();
    setError(undefined);
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      // traktPkce opens the window before its first await, so it still counts as part of the click.
      props.onSignedIn(await auth.traktPkce(traktApp!, PKCE_REDIRECT!, ctrl.signal));
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      if (abort.current === ctrl) abort.current = undefined;
      setBusy(false);
    }
  };

  const appName = APP_NAME[app];

  return (
    <div class="signin">
      <div class="segmented" role="group" aria-label="App">
        {(['stremio', 'nuvio', 'trakt'] as const).map((a) => (
          <button type="button" aria-pressed={app === a} onClick={() => setApp(a)}>
            <span class={`dot dot-${a}`} aria-hidden="true" />
            {APP_NAME[a]}
          </button>
        ))}
      </div>

      {!linkOnly && (
        <div class="tabs" role="tablist" aria-label="Sign-in method">
          {(
            [
              ['link', 'Link code'],
              ['password', 'Email & password'],
              ['token', 'Token'],
            ] as const
          ).map(([m, label]) => (
            <button type="button" role="tab" aria-selected={method === m} onClick={() => setMethod(m)}>
              {label}
            </button>
          ))}
        </div>
      )}

      {app === 'trakt' && !traktApp && (
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const a: TraktApp = { clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) };
            saveTraktApp(a);
            setTraktApp(a);
          }}
        >
          <p class="hint">Signing in to Trakt goes through a Trakt API app. Setting one up takes a minute, once:</p>
          <ol class="steps">
            <li>
              Create an app at{' '}
              <a href="https://trakt.tv/oauth/applications/new" target="_blank" rel="noopener noreferrer">
                trakt.tv/oauth/applications/new
              </a>
              . Any name will do. For <em>Redirect uri</em>, enter:
              <CopyCode text={TRAKT_REDIRECT} />
            </li>
            <li>Save it, then copy its Client ID here.</li>
          </ol>
          <label class="field">
            <span>Client ID</span>
            <input autocomplete="off" spellcheck={false} required value={clientId} onInput={(e) => setClientId(e.currentTarget.value)} />
          </label>
          <label class="field">
            <span>
              Client Secret <span class="muted">(optional, only older apps have one)</span>
            </span>
            <input type="password" autocomplete="off" spellcheck={false} value={clientSecret} onInput={(e) => setClientSecret(e.currentTarget.value)} />
          </label>
          <button class="btn btn-primary">Continue</button>
          <p class="hint">Kept in this browser and sent only to Trakt.</p>
        </form>
      )}

      {traktWindow && (
        <div class="stack">
          {!busy ? (
            <>
              <p class="hint">A Trakt window opens: sign in there (Google and Apple work too) and approve. No password is typed here.</p>
              <button type="button" class="btn btn-primary" onClick={() => void startTraktWindow()}>
                Sign in with Trakt
              </button>
              <button type="button" class="link" onClick={() => setTraktCode(true)}>
                Use a code instead
              </button>
            </>
          ) : (
            <div class="link-code">
              <p class="hint waiting">
                <span class="spinner" aria-hidden="true" /> Waiting for you to approve in the Trakt window…
              </p>
              <button type="button" class="btn btn-quiet" onClick={stopLink}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {!traktWindow && shownMethod === 'link' && (app !== 'trakt' || traktApp) && (
        <div class="stack">
          {!link ? (
            <>
              <p class="hint">
                Approve a code in a browser where you're signed in to {appName}. Works with any sign-in
                {app === 'stremio' ? ', including Facebook and Apple' : app === 'trakt' ? ', including Google and Apple' : ''}, and no password is typed here.
              </p>
              {app === 'trakt' && !BUILT_IN_APP && (
                <p class="hint">
                  Using your Trakt app <code>{traktApp!.clientId.slice(0, 8)}…</code>.{' '}
                  <button
                    type="button"
                    class="link"
                    onClick={() => {
                      saveTraktApp(undefined);
                      setTraktApp(undefined);
                      setClientId('');
                      setClientSecret('');
                    }}
                  >
                    Use a different app
                  </button>
                </p>
              )}
              <button type="button" class="btn btn-primary" disabled={busy} onClick={startLink}>
                {busy ? 'Getting a code…' : 'Get a code'}
              </button>
              {app === 'trakt' && traktCode && (
                <button type="button" class="link" onClick={() => setTraktCode(false)}>
                  Sign in with the Trakt window instead
                </button>
              )}
            </>
          ) : (
            <div class="link-code">
              <span class="label">Your code</span>
              <span class="code">{link.code}</span>
              <a class="btn btn-primary" href={link.url} target="_blank" rel="noopener noreferrer">
                Open {appName} to approve it ↗
              </a>
              {app === 'trakt' && <p class="hint">The code is filled in there; check it matches, then approve.</p>}
              <p class="hint waiting">
                <span class="spinner" aria-hidden="true" /> Waiting for approval…
              </p>
              <button type="button" class="btn btn-quiet" onClick={stopLink}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {shownMethod === 'password' && (
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => (app === 'stremio' ? auth.stremioPassword(email, password) : auth.nuvioPassword(email, password)));
          }}
        >
          <label class="field">
            <span>{appName} email</span>
            <input type="email" autocomplete="username" required value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
          </label>
          <label class="field">
            <span>Password</span>
            <input type="password" autocomplete="current-password" required value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
          </label>
          <button class="btn btn-primary" disabled={busy}>
            {busy ? 'Signing in…' : `Sign in to ${appName}`}
          </button>
          <p class="hint">Your password goes only to {appName}. Only the session token it returns is kept.</p>
        </form>
      )}

      {shownMethod === 'token' && (
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => (app === 'stremio' ? auth.stremioToken(token) : auth.nuvioToken(token)));
          }}
        >
          {app === 'stremio' ? (
            <p class="hint">
              On <a href="https://web.stremio.com" target="_blank" rel="noopener noreferrer">web.stremio.com</a>, signed in, open the browser console and run:
              <CopyCode text={STREMIO_SNIPPET} />
              Then paste what it copied below.
            </p>
          ) : (
            <p class="hint">
              Paste a Nuvio refresh token, or session JSON that contains <code>refresh_token</code>. This takes over that session: the app or website you copied it from
              will be signed out. A link code avoids this.
            </p>
          )}
          <label class="field">
            <span>{appName} token</span>
            <input type="password" autocomplete="off" spellcheck={false} required value={token} onInput={(e) => setToken(e.currentTarget.value)} />
          </label>
          <button class="btn btn-primary" disabled={busy}>
            {busy ? 'Checking…' : 'Use this token'}
          </button>
        </form>
      )}

      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {props.onCancel && (
        <button type="button" class="btn btn-quiet" onClick={props.onCancel}>
          Back
        </button>
      )}
    </div>
  );
}

function CopyCode(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span class="copy-code">
      <code>{props.text}</code>
      <button
        type="button"
        class="btn btn-small"
        onClick={async () => {
          await navigator.clipboard.writeText(props.text).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
