// End-to-end check of the web page in a real (headless) Chromium. Requests to Stremio, Nuvio,
// Cinemeta and add-ons are answered by the in-memory fakes, so no real account is touched.
// Signs in through the real forms, compares both sides, picks what to copy, edits the add-on
// list, writes, checks the result, then reloads and swaps.
//
//   npm run e2e   (builds into dist-e2e without a built-in Trakt app, then runs this)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orderVideoIds, WatchedBitField } from '../src/providers/stremio/bitfield.ts';
import { fakeFetch, MOVIE, nuvio, past, SERIES, seriesVideos, stremio, trakt } from './fakes.ts';

const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'ss-e2e-'));
const PORT = 4317;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- Seed: a Stremio account with a fully watched show, a watched movie, one in progress, add-ons.
const state = (s: object) => ({
  lastWatched: null,
  timeWatched: 0,
  timeOffset: 0,
  overallTimeWatched: 0,
  timesWatched: 0,
  flaggedWatched: 0,
  duration: 0,
  video_id: null,
  watched: null,
  noNotif: false,
  ...s,
});
const bf = WatchedBitField.empty(orderVideoIds(seriesVideos));
for (const id of [`${SERIES}:1:1`, `${SERIES}:1:2`, `${SERIES}:1:3`, `${SERIES}:2:1`]) bf.setVideo(id, true);
stremio.A = {
  items: new Map(
    [
      {
        _id: SERIES,
        name: 'Test Show',
        type: 'series',
        poster: 'https://img.example/show.jpg',
        removed: false,
        temp: false,
        _ctime: past(500),
        _mtime: past(10),
        state: state({ watched: bf.toString(), lastWatched: past(10), video_id: `${SERIES}:2:1`, timesWatched: 4 }),
      },
      {
        _id: MOVIE,
        name: 'Test Movie',
        type: 'movie',
        poster: null,
        removed: false,
        temp: false,
        _ctime: past(300),
        _mtime: past(20),
        state: state({ timesWatched: 1, flaggedWatched: 1, lastWatched: past(20) }),
      },
      {
        _id: 'tt0000300',
        name: 'Half Watched',
        type: 'movie',
        removed: true,
        temp: true,
        _ctime: past(5),
        _mtime: past(2),
        state: state({ timeOffset: 1_800_000, duration: 6_000_000, video_id: 'tt0000300', lastWatched: past(2) }),
      },
    ].map(i => [i._id, i]),
  ),
  addons: [
    { transportUrl: 'https://addons.example/one/manifest.json', manifest: { id: 'one', name: 'One', version: '1' } },
    {
      transportUrl: 'http://127.0.0.1:11470/local-addon/manifest.json',
      manifest: { id: 'local', name: 'Local Files', version: '1' },
    },
  ],
};

// ---- Nuvio already has a title and an add-on of its own.
nuvio.library.set('movie:tt0000400', {
  content_id: 'tt0000400',
  content_type: 'movie',
  name: 'Nuvio Only',
  poster: null,
  added_at: Date.parse(past(50)),
});
nuvio.addons = [{ url: 'https://addons.example/existing/manifest.json', name: 'Existing', enabled: true, sort_order: 0 }];

// ---- Serve the built page and start Chromium.
// Run Vite directly (not through npx), so killing it really stops the server.
const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--outDir', 'dist-e2e', '--port', String(PORT), '--strictPort'],
  { stdio: 'ignore' },
);
const chrome = spawn(
  'chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=9335',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ss-chrome-'))}`,
    '--window-size=1200,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const cleanup = () => {
  chrome.kill();
  server.kill();
};

try {
  let ws: WebSocket | undefined;
  for (let i = 0; i < 60 && !ws; i++) {
    try {
      const page = (
        (await (await fetch('http://127.0.0.1:9335/json')).json()) as { type: string; webSocketDebuggerUrl: string }[]
      ).find(t => t.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch {
      await sleep(250);
    }
  }
  assert.ok(ws, 'Chromium did not start');
  await new Promise(r => (ws!.onopen = r));
  let nextId = 0;
  const pending = new Map<number, (m: any) => void>();
  const errors: string[] = [];
  const send = (method: string, params: object = {}) =>
    new Promise<any>(resolve => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws!.send(JSON.stringify({ id, method, params }));
    });

  ws.onmessage = async e => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    }
    if (m.method === 'Runtime.exceptionThrown')
      errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Fetch.requestPaused') {
      const { requestId, request } = m.params;
      const cors = [
        { name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'Access-Control-Allow-Headers', value: '*' },
        { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
      ];
      if (request.method === 'OPTIONS')
        return send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors });
      if (/img\.example|images\.metahub\.space/.test(request.url))
        return send('Fetch.fulfillRequest', { requestId, responseCode: 404, responseHeaders: cors });
      let res: Response;
      try {
        res = await fakeFetch(request.url, { method: request.method, headers: request.headers, body: request.postData });
      } catch (err) {
        errors.push(`fake API: ${(err as Error).message}`);
        res = new Response(JSON.stringify({ message: (err as Error).message }), { status: 500 });
      }
      const body = Buffer.from(await res.arrayBuffer()).toString('base64');
      // Pass Trakt's paging headers through, exposed to the page as the real API does.
      const paging = [...res.headers].filter(([k]) => k.startsWith('x-pagination')).map(([name, value]) => ({ name, value }));
      const expose = paging.length ? [{ name: 'Access-Control-Expose-Headers', value: paging.map(h => h.name).join(', ') }] : [];
      await send('Fetch.fulfillRequest', {
        requestId,
        responseCode: res.status,
        responseHeaders: [...cors, ...expose, ...paging, { name: 'Content-Type', value: 'application/json' }],
        body,
      });
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Fetch.enable', {
    patterns: [
      '*api.strem.io*',
      '*link.stremio.com*',
      '*api.nuvio.tv*',
      '*api-two.nuvioapp.space*',
      '*v3-cinemeta.strem.io*',
      '*addons.example*',
      '*img.example*',
      '*images.metahub.space*',
      '*api.trakt.tv*',
    ].map(urlPattern => ({ urlPattern })),
  });

  const evaluate = async (expression: string) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails)
      throw new Error(`page: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
    return r.result.result.value;
  };
  const shot = async (name: string) => {
    const r = await send('Page.captureScreenshot', { captureBeyondViewport: true });
    writeFileSync(join(shots, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  const waitFor = async (what: string, expression: string, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate(expression)) return;
      await sleep(150);
    }
    await shot('timeout');
    throw new Error(
      `timed out waiting for ${what}. Page errors: ${JSON.stringify(errors)}. Text: ${await evaluate('document.querySelector("main").innerText').catch(() => '?')}`,
    );
  };
  // Helpers inside the page: click a button by its text within a section, type into an input.
  const HELPERS = `
    window.$side = (title) => [...document.querySelectorAll('section.side')].find(s => s.querySelector('h2')?.textContent === title);
    window.$click = (root, text) => { const b = [...root.querySelectorAll('button,a')].find(b => b.textContent.trim().startsWith(text)); if (!b) throw new Error('no button ' + text); b.click(); };
    window.$type = (el, value) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); };
    true`;

  await send('Page.navigate', { url: `http://localhost:${PORT}/` });
  for (let i = 0; i < 60; i++) {
    try {
      if (await evaluate(`!!document.querySelector('section.side')`)) break;
    } catch {}
    await sleep(250);
  }
  await evaluate(HELPERS);
  await shot('1-start');

  // The sign-in tabs row must fit its own height (it once showed a vertical scrollbar).
  const tabsOverflow: number = await evaluate(
    `Math.max(...[...document.querySelectorAll('.tabs')].map(t => t.scrollHeight - t.clientHeight))`,
  );
  assert.ok(tabsOverflow <= 0, `sign-in tabs overflow vertically by ${tabsOverflow}px`);

  const tab = (name: string) =>
    evaluate(
      `(() => { [...document.querySelectorAll('.compare [role=tab]')].find(t => t.textContent.startsWith(${JSON.stringify(name)})).click(); return true })()`,
    );
  const text = (sel: string): Promise<string> => evaluate(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);

  // From: Stremio by email and password (the fake's password is the account key). It loads straight
  // away and the Compare panel shows what it has.
  await evaluate(`(() => { const s = $side('From'); $click(s, 'Email & password'); return true })()`);
  await sleep(100);
  await evaluate(
    `(() => { const s = $side('From'); $type(s.querySelector('input[type=email]'), 'a@stremio.test'); $type(s.querySelector('input[type=password]'), 'A'); return true })()`,
  );
  await sleep(100);
  await evaluate(`(() => { $side('From').querySelector('form').requestSubmit(); return true })()`);
  await waitFor('From signed in', `$side('From').querySelector('.account .who')?.textContent === 'a@stremio.test'`);
  await waitFor('From loaded', `$side('From').querySelector('[data-stat=library] .stat-n')?.textContent === '2'`);
  await waitFor('From-only compare', `document.querySelector('.compare .rows')?.innerText.includes('Test Show')`);

  // To: Nuvio by email and password (first a wrong password, which must show an error).
  assert.match(
    await evaluate(`$side('To').innerText`),
    /Use the From account here[\s\S]*a@stremio\.test/,
    "To offers From's account too",
  );
  await shot('1b-to-side');
  await evaluate(`(() => { const s = $side('To'); $click(s, 'Nuvio'); return true })()`);
  await sleep(100);
  await evaluate(`(() => { const s = $side('To'); s.querySelector('[role=tab]:nth-child(2)').click(); return true })()`);
  await sleep(100);
  await evaluate(
    `(() => { const s = $side('To'); $type(s.querySelector('input[type=email]'), 'me@nuvio.test'); $type(s.querySelector('input[type=password]'), 'wrong'); return true })()`,
  );
  await sleep(100);
  await evaluate(`(() => { $side('To').querySelector('form').requestSubmit(); return true })()`);
  await waitFor('sign-in error', `$side('To').querySelector('.error')?.textContent.includes('Invalid login credentials')`);
  await evaluate(
    `(() => { const s = $side('To'); $type(s.querySelector('input[type=password]'), 'nuvio-pass'); return true })()`,
  );
  await sleep(100);
  await evaluate(`(() => { $side('To').querySelector('form').requestSubmit(); return true })()`);
  await waitFor('To signed in', `$side('To').querySelector('.account .who')?.textContent === 'me@nuvio.test'`);
  await waitFor('To loaded', `$side('To').querySelector('[data-stat=library] .stat-n')?.textContent === '1'`);
  await waitFor('comparison', `!!document.querySelector('.compare .chips')`);
  await shot('2-compare');

  // Long lists scroll inside their box instead of stretching the page.
  const listStyle = await evaluate(
    `(() => { const s = getComputedStyle(document.querySelector('.compare .rows')); return s.overflowY + ' ' + s.maxHeight })()`,
  );
  assert.match(listStyle, /^auto \d+px$/, listStyle);

  // Library: both of From's titles are ticked to copy; untick the movie. Nuvio's own title shows under "Only on To".
  let lib = await text('.compare .rows');
  assert.match(lib, /Test Show/);
  assert.match(lib, /Test Movie/);
  assert.doesNotMatch(lib, /Nuvio Only/);
  await evaluate(`(() => { document.querySelector('input[aria-label="Copy Test Movie"]').click(); return true })()`);
  await sleep(100);
  await evaluate(
    `(() => { [...document.querySelectorAll('.chip')].find(c => c.textContent.startsWith('Only on To')).click(); return true })()`,
  );
  await sleep(100);
  lib = await text('.compare .rows');
  assert.match(lib, /Nuvio Only/);
  assert.doesNotMatch(lib, /Test Show/);

  // Watched and Continue Watching say what would be copied.
  await tab('Watched');
  await evaluate(
    `(() => { [...document.querySelectorAll('.chip')].find(c => c.textContent.startsWith('To copy')).click(); return true })()`,
  );
  await sleep(100);
  const watched = await text('.compare .rows');
  assert.match(watched, /Test Show[\s\S]*Copies 4 episodes \(S01E01–S02E01\) and whole-series mark/, watched);
  await tab('Continue Watching');
  await sleep(100);
  assert.match(await text('.compare .rows'), /Half Watched[\s\S]*30%/);

  // Add-ons: From's "One" is already queued for To, Local Files can't move; switch To's own add-on off.
  await tab('Add-ons');
  await sleep(100);
  const addons = await text('.addons');
  assert.match(addons, /One[\s\S]*Will be added/, addons);
  assert.match(addons, /Local Files[\s\S]*Device only/, addons);
  await evaluate(`(() => { document.querySelector('input[aria-label="Existing on"]').click(); return true })()`);
  await sleep(100);
  await shot('3-addons');

  // Write: the confirmation lists exactly what was picked.
  await evaluate(`(() => { $click(document.querySelector('.actionbar'), 'Write to'); return true })()`);
  await sleep(100);
  await shot('3b-confirm');
  const confirmText = await text('.confirm');
  for (const expected of [
    'Write to Nuvio?',
    'Add 1 title',
    '1 movie · 4 episodes · 1 whole series',
    'Update progress for 1 title',
    'Install',
    'One',
    'Switch off',
    'Existing',
    'Nothing on Nuvio is removed',
  ]) {
    assert.ok(
      confirmText.toLowerCase().includes(expected.toLowerCase()),
      `confirmation should say "${expected}"\n---\n${confirmText}`,
    );
  }
  assert.ok(await evaluate(`document.querySelector('dialog.confirm').open`), 'the confirmation is a modal dialog');
  await evaluate(`(() => { $click(document.querySelector('.confirm'), 'Write '); return true })()`);
  await waitFor('done', `document.querySelector('.result h2')?.textContent.startsWith('Done')`, 30000);
  const doneText = await text('.result');
  assert.match(doneText, /now has everything you picked/, doneText);
  assert.deepEqual([...nuvio.library.values()].map((r: any) => r.content_id).sort(), [SERIES, 'tt0000400']);
  assert.ok(nuvio.watched.has(`${SERIES}|null|null`));
  assert.ok(nuvio.watched.has(`${MOVIE}|null|null`), 'watched movie is copied even though its library entry was unticked');
  assert.equal(nuvio.progress.get('tt0000300')?.position, 1_800_000);
  assert.deepEqual(
    nuvio.addons.map((a: any) => [a.url, a.enabled, a.sort_order]),
    [
      ['https://addons.example/existing/manifest.json', false, 0],
      ['https://addons.example/one/manifest.json', true, 1],
    ],
  );
  // The unticked movie is the only thing left, and stays unticked.
  await waitFor('nothing ticked', `document.querySelector('.actionbar-text')?.textContent === 'Nothing ticked to copy.'`);
  await shot('4-done');

  // Reload: accounts are remembered and load again. Swap: Nuvio → Stremio offers Nuvio's own title.
  await send('Page.reload');
  await sleep(1500);
  await evaluate(HELPERS);
  await waitFor('remembered accounts', `$side('From').querySelector('.account .who')?.textContent === 'a@stremio.test'`);
  await waitFor('reloaded comparison', `!!document.querySelector('.compare .chips')`);
  await evaluate(`(() => { document.querySelector('.swap').click(); return true })()`);
  await waitFor('swapped comparison', `document.querySelector('.compare .rows')?.innerText.includes('Nuvio Only')`);
  const swapped = await text('.compare .rows');
  assert.doesNotMatch(swapped, /Test Show/, 'Stremio already has everything else from Nuvio');

  // Either side can pick the other's account; doing so swaps them back.
  await evaluate(`(() => { $click($side('From'), 'Change account'); return true })()`);
  await sleep(100);
  assert.match(await evaluate(`$side('From').innerText`), /a@stremio\.test\s*On To/);
  await evaluate(`(() => { $click($side('From'), 'Stremio'); return true })()`);
  await waitFor(
    'sides swapped by picking',
    `$side('From').querySelector('.account .who')?.textContent === 'a@stremio.test' && $side('To').querySelector('.account .who')?.textContent === 'me@nuvio.test'`,
  );

  // A long account name is cut short inside its card instead of pushing the list past the edge.
  const LONG = 'AVERYLONGACCOUNTNAMETHATKEEPSGOING1234567890';
  stremio[LONG] = { items: new Map(), addons: [] };
  await evaluate(`(() => { $click($side('From'), 'Change account'); return true })()`);
  await sleep(100);
  await evaluate(`(() => { $click($side('From'), '+ Sign in to another account'); return true })()`);
  await sleep(100);
  await evaluate(`(() => { $click($side('From'), 'Email & password'); return true })()`);
  await sleep(100);
  await evaluate(
    `(() => { const s = $side('From'); $type(s.querySelector('input[type=email]'), 'long@stremio.test'); $type(s.querySelector('input[type=password]'), ${JSON.stringify(LONG)}); return true })()`,
  );
  await sleep(100);
  await evaluate(`(() => { $side('From').querySelector('form').requestSubmit(); return true })()`);
  await waitFor(
    'long account signed in',
    `$side('From').querySelector('.account .who')?.textContent === ${JSON.stringify(`${LONG.toLowerCase()}@stremio.test`)}`,
  );
  await evaluate(`(() => { $click($side('From'), 'Change account'); return true })()`);
  await sleep(200);
  const sticksOut: number = await evaluate(
    `(() => { const card = $side('From').getBoundingClientRect(); return Math.max(...[...$side('From').querySelectorAll('*')].map(e => e.getBoundingClientRect().right - card.right)); })()`,
  );
  assert.ok(sticksOut <= 0, `the From card's account list sticks out by ${sticksOut}px`);
  await shot('4b-accounts');

  // Trakt: set up the Trakt app once (client ID only, as Trakt issues no secrets to new apps), then
  // sign in with a code (the fake approves it straight away).
  await evaluate(`(() => { $click($side('From'), '+ Sign in to another account'); return true })()`);
  await sleep(100);
  await evaluate(`(() => { $click($side('From').querySelector('.segmented'), 'Trakt'); return true })()`);
  await sleep(100);
  assert.match(await evaluate(`$side('From').innerText`), /goes through a Trakt API app/);
  await evaluate(
    `(() => { const i = $side('From').querySelectorAll('.signin form input'); $type(i[0], 'test-client'); return true })()`,
  );
  await sleep(100);
  await evaluate(`(() => { $side('From').querySelector('.signin form').requestSubmit(); return true })()`);
  await sleep(100);
  await evaluate(`(() => { $click($side('From'), 'Get a code'); return true })()`);
  await waitFor('Trakt signed in', `$side('From').querySelector('.account .who')?.textContent === '@traktuser'`);
  await waitFor('Trakt loaded', `!!$side('From').querySelector('[data-stat=library]')`);
  assert.equal(await evaluate(`$side('From').querySelectorAll('.stat').length`), 3, 'Trakt has no add-ons tile');
  assert.equal(trakt.secretsSent, 0, 'no client secret is sent when the app has none');
  await shot('4c-trakt');

  // Phone width: no sideways scrolling.
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  const overflow = await evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px at 375px wide`);
  await shot('5-phone');

  assert.deepEqual(errors, [], 'page errors');
  console.log(`e2e ok. Screenshots in ${shots}`);
} finally {
  cleanup();
}
process.exit(0);
