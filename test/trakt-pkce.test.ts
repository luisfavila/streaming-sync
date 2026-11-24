// Trakt sign-in with PKCE: a Trakt window, the code relayed back, exchanged with the verifier.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { relayTraktCallback, traktPkce } from '../src/auth.ts';
import { pkcePair, TraktClient } from '../src/providers/trakt/api.ts';
import { fakeFetch, TRAKT_APP, trakt, traktAuthorize } from './fakes.ts';

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = fakeFetch as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

const REDIRECT = 'https://sync.example/';
/** A stand-in sign-in window: when the page points it at Trakt, `onTrakt` plays Trakt's part. */
function fakeWindow(onTrakt: (href: string) => void) {
  const opened: string[] = [];
  const open = (url: string) => {
    opened.push(url);
    return {
      location: {
        set href(v: string) {
          opened.push(v);
          setTimeout(() => onTrakt(v), 5);
        },
        get href() {
          return opened.at(-1)!;
        },
      },
    };
  };
  return { open, opened };
}

test('the PKCE verifier and challenge are well formed', async () => {
  const { verifier, challenge } = await pkcePair();
  assert.match(verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual((await pkcePair()).verifier, verifier);
});

test('signs in through the Trakt window, without a secret, and refreshes with the same redirect URI', async () => {
  const secrets = trakt.secretsSent;
  const win = fakeWindow(href => relayTraktCallback(traktAuthorize(href)));
  const account = await traktPkce(TRAKT_APP, REDIRECT, new AbortController().signal, win.open);
  assert.equal(win.opened[0], 'about:blank', 'the window opens before anything is awaited, so pop-up blockers allow it');
  assert.equal(account.who, 'traktuser');
  assert.equal(account.auth.redirectUri, REDIRECT);
  assert.equal(trakt.secretsSent, secrets, 'no client secret sent');

  await new TraktClient(account.auth, account.auth, () => {}).refresh();
  assert.equal(trakt.refreshRedirects.at(-1), REDIRECT);
  assert.equal(trakt.secretsSent, secrets, 'no client secret on refresh either');
});

test('a callback for another sign-in is ignored', async () => {
  const ctrl = new AbortController();
  const win = fakeWindow(href => {
    const q = traktAuthorize(href);
    relayTraktCallback(new URLSearchParams({ code: q.get('code')!, state: 'trakt-someone-else' }));
    setTimeout(() => ctrl.abort(), 20);
  });
  await assert.rejects(traktPkce(TRAKT_APP, REDIRECT, ctrl.signal, win.open), { name: 'AbortError' });
});

test('declining on Trakt, and a blocked window, give clear errors', async () => {
  const declined = fakeWindow(href =>
    relayTraktCallback(new URLSearchParams({ error: 'access_denied', state: new URL(href).searchParams.get('state')! })),
  );
  await assert.rejects(traktPkce(TRAKT_APP, REDIRECT, new AbortController().signal, declined.open), /declined/);
  await assert.rejects(
    traktPkce(TRAKT_APP, REDIRECT, new AbortController().signal, () => null),
    /blocked the Trakt window/,
  );
});

test("only Trakt sign-in callbacks are relayed, so the page's own links still load the app", () => {
  assert.equal(relayTraktCallback(new URLSearchParams('')), false);
  assert.equal(relayTraktCallback(new URLSearchParams({ code: 'x', state: 'other' })), false);
});
