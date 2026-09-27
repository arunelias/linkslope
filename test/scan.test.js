import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createPauseControl } from '../src/pause.js';
import { scan, normalize, classify } from '../src/crawler.js';

import { parseAcceptedHosts, createIgnoreMatcher } from '../src/settings.js';

const root = 'https://example.test/';

function pauseAfterFirst(pauseControl, held) {
  let didPause = false;
  return value => {
    if (!didPause && value.checked === 1 && value.queued) {
      didPause = true;
      pauseControl.pause();
      held.resolve();
    }
  };
}

for (const options of [{ crawlDepth: 0 }, { runOnce: true, crawlDepth: 5 }, {}, { crawlDepth: 2 }]) {
  test(`depth bounds crawling while checking boundary links: ${JSON.stringify(options)}`, async t => {
    const depth = options.runOnce ? 0 : options.crawlDepth ?? 1;
    const routes = {
      [root]: '<a href="/one">One</a><a href="/missing">Missing</a>',
      [root + 'one']: '<a href="/two">Two</a>',
      [root + 'two']: '<a href="/three">Three</a>',
      [root + 'three']: '<a href="/never">Never</a>',
      [root + 'missing']: { status: 404 },
    };
    const f = fixture(t, routes, { unlimitedDepth: false, ...options });
    const result = await f.run();
    assert.deepEqual(f.calls, [root, root + 'one', root + 'missing', ...[root + 'two', root + 'three'].slice(0, depth)]);
    assert.equal(result.pages, depth + 1);
    assert.equal(result.records.find(r => r.url === root + 'missing').outcome, 'Broken');
    assert.equal(result.queued, 0);
  });
}

test('depth uses the shortest discovered path despite cycles and duplicate links', async t => {
  const f = fixture(t, {
    [root]: '<a href="/one">One</a><a href="/two">Two</a>',
    [root + 'one']: '<a href="/two">Two again</a><a href="/">Home</a>',
    [root + 'two']: '<a href="/three">Three</a>',
    [root + 'three']: '<a href="/never">Never</a>',
  }, { unlimitedDepth: false });
  const result = await f.run();
  assert.deepEqual(f.calls, [root, root + 'one', root + 'two', root + 'three']);
  assert.equal(result.pages, 3);
  assert.deepEqual(result.records.find(r => r.url === root + 'two').sources, [root, root + 'one']);
});

test('accepted hosts are normalized, deduplicated, and validated', () => {
  assert.deepEqual(parseAcceptedHosts(), []);
  assert.deepEqual(parseAcceptedHosts(' Other.test, other.test\nsub.other.test '), ['other.test', 'sub.other.test']);
  for (const value of ['https://other.test', 'other.test/path', '*.other.test', 'user@other.test', 'other.test:443', '[', '-bad.test', 'bad..test', '%20']) {
    assert.throws(() => parseAcceptedHosts(value), /Invalid accepted host/);
  }
});

test('external checks can be disabled without skipping internal links', async t => {
  const f = fixture(t, {
    [root]: '<a href="/inside">Inside</a><a href="https://outside.test/">Outside</a>',
    [`${root}inside`]: '',
  }, { testExternalUrls: false });
  const result = await f.run();
  assert.deepEqual(f.calls, [root, `${root}inside`]);
  assert.equal(result.records.length, 3);
  assert.equal(result.records.find(r => r.url === 'https://outside.test/').outcome, 'Skipped');
});

for (const testExternalUrls of [true, false]) {
  test(`accepted hosts are crawled with external checks ${testExternalUrls ? 'on' : 'off'}`, async t => {
    const routes = {
      [root]: '<a href="https://other.test/">Other</a>',
      'https://other.test/': '<a href="/child">Child</a><a href="https://sub.other.test/">Subdomain</a><a href="https://other.test.evil.test/">Lookalike</a>',
      'https://other.test/child': '',
    };
    if (testExternalUrls) {
      routes['https://sub.other.test/'] = '<a href="/not-crawled">Child</a>';
      routes['https://other.test.evil.test/'] = '';
    }
    const f = fixture(t, routes, { acceptedHosts: 'OTHER.test', testExternalUrls, crawlDepth: 2 });
    const result = await f.run();
    assert.deepEqual(f.calls, Object.keys(routes));
    assert.equal(result.pages, 3);
  });
}

test('accepted hosts share the global page limit', async t => {
  const f = fixture(t, {
    [root]: '<a href="https://other.test/">Other</a>',
    'https://other.test/': '<a href="/child">Child</a>',
  }, { acceptedHosts: 'other.test', maxPages: 1 });
  const result = await f.run();
  assert.equal(result.pages, 1);
  assert.equal(result.checked, 2);
});

test('redirects to accepted hosts can be crawled', async t => {
  const f = fixture(t, {
    [root]: { finalUrl: 'https://other.test/', body: '<a href="/child">Child</a>' },
    'https://other.test/child': '',
  }, { acceptedHosts: 'other.test', testExternalUrls: false });
  const result = await f.run();
  assert.equal(result.pages, 2);
  assert.deepEqual(f.calls, [root, 'https://other.test/child']);
});

// Real HTML parsing and Fetch Response streams, with a deterministic network.
// Use a virtual clock for request pacing and expose request deadlines.
function fixture(t, routes, options = {}) {
  const calls = [];
  const sentHeaders = [];
  const credentialModes = [];
  const updates = [];
  const deadlines = new Set();
  const waits = [];
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const controller = new AbortController();
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    const timeout = (options.getSettings?.().timeoutSeconds ?? options.timeoutSeconds ?? 10) * 1000;
    if (ms !== timeout) {
      if (ms > 0) waits.push(ms);
      queueMicrotask(() => { now += ms; if (ms > 0) options.onWait?.(); if (options.stopWhileWaiting && ms > 0) controller.abort(); else callback(); });
    }
    else { assert.equal(ms, timeout); deadlines.add(callback); }
    return callback;
  });
  t.mock.method(globalThis, 'clearTimeout', callback => deadlines.delete(callback));
  const original = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  globalThis.DOMParser = DOMParser;
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'DOMParser', original);
    else delete globalThis.DOMParser;
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.cache, 'no-store', 'Every scan request must bypass the browser cache');
    calls.push(url);
    sentHeaders.push(new Headers(init.headers));
    credentialModes.push(init.credentials);
    assert.equal(init.credentials, (options.getSettings?.().useBrowserCookies ?? options.useBrowserCookies) ? 'include' : 'omit');
    assert.equal(init.redirect, createIgnoreMatcher(options.getSettings?.().ignorePrefixes ?? options.ignorePrefixes).hasRules ? 'manual' : 'follow');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.ok(Object.hasOwn(routes, url), `Unexpected request: ${url}`);
    const route = routes[url];
    if (typeof route === 'function') return route(init, { controller, deadlines });
    const config = typeof route === 'string' ? { body: route } : route;
    const response = new Response(config.body ?? '', {
      status: config.status ?? 200,
      headers: { 'content-type': config.type ?? 'text/html', ...config.headers },
    });
    Object.defineProperty(response, 'url', { value: config.finalUrl ?? url });
    return response;
  });
  return {
    calls, updates, controller, waits, sentHeaders, credentialModes,
    async run() {
      await scan({ start: root, discoverSitemaps: false, testExternalUrls: true, ...options, signal: controller.signal, onUpdate: value => { updates.push(value); options.onSnapshot?.(value); } });
      assert.equal(deadlines.size, 0, 'Request deadlines must be cleaned up');
      return updates.at(-1);
    },
  };
}

test('pause finishes the current page and resumes the same queue across multiple pauses', async t => {
  const pauseControl = createPauseControl();
  const held = [Promise.withResolvers(), Promise.withResolvers()];
  const f = fixture(t, {
    [root]: '<a href="/one">One</a><a href="/two">Two</a>',
    [root + 'one']: '',
    [root + 'two']: '',
  }, {
    pauseControl,
    onSnapshot(value) {
      if (value.checked > 0 && value.checked <= 2 && value.queued > 0) {
        pauseControl.pause();
        held[value.checked - 1].resolve();
      }
    },
  });
  const running = f.run();
  await held[0].promise;
  await nextTurn();
  assert.deepEqual(f.calls, [root]);
  assert.equal(f.updates.at(-1).records.filter(r => r.outcome === 'Pending').length, 2);
  pauseControl.resume();
  await held[1].promise;
  await nextTurn();
  assert.deepEqual(f.calls, [root, root + 'one']);
  pauseControl.resume();
  const result = await running;
  assert.deepEqual(f.calls, [root, root + 'one', root + 'two']);
  assert.equal(result.checked, 3);
  assert.ok(result.records.every(r => r.outcome === 'Working'));
});

test('stop while paused completes without resume and cancels the queue', async t => {
  const pauseControl = createPauseControl();
  const held = Promise.withResolvers();
  const f = fixture(t, { [root]: '<a href="/next">Next</a>' }, {
    pauseControl,
    onSnapshot: pauseAfterFirst(pauseControl, held),
  });
  const running = f.run();
  await held.promise;
  await nextTurn();
  f.controller.abort();
  const result = await running;
  assert.deepEqual(f.calls, [root]);
  assert.equal(result.records[1].outcome, 'Cancelled');
  assert.equal(result.queued, 0);
});

test('pause during pacing prevents the next request until resumed', async t => {
  const pauseControl = createPauseControl();
  const held = Promise.withResolvers();
  const f = fixture(t, { [root]: '<a href="/next">Next</a>', [root + 'next']: '' }, {
    pauseControl, requestsPerMinute: 30,
    onWait() { pauseControl.pause(); held.resolve(); },
  });
  const running = f.run();
  await held.promise;
  await nextTurn();
  assert.deepEqual(f.calls, [root]);
  pauseControl.resume();
  assert.equal((await running).checked, 2);
  assert.deepEqual(f.waits, [2000]);
});

test('resumed scan applies edited depth, headers, credentials, timeout, and pacing', async t => {
  const pauseControl = createPauseControl();
  const held = Promise.withResolvers();
  let settings = {};
  const f = fixture(t, {
    [root]: '<a href="/one">One</a><a href="https://other.test/">Other</a>',
    [root + 'one']: '<a href="/two">Two</a>',
    [root + 'two']: '',
    'https://other.test/': '<a href="/child">Child</a>',
    'https://other.test/child': '',
  }, {
    pauseControl, getSettings: () => ({ discoverSitemaps: false, testExternalUrls: true, ...settings }),
    onSnapshot: pauseAfterFirst(pauseControl, held),
  });
  const running = f.run();
  await held.promise;
  await nextTurn();
  settings = { unlimitedDepth: false, crawlDepth: 2, acceptedHosts: 'other.test', username: 'user', password: 'pass', headers: 'X-New: edited', timeoutSeconds: 3, requestsPerMinute: 30 };
  pauseControl.resume();
  const result = await running;
  assert.equal(result.checked, 5);
  assert.equal(result.pages, 5);
  assert.equal(f.sentHeaders[0].get('X-New'), null);
  for (const headers of f.sentHeaders.slice(1)) assert.equal(headers.get('X-New'), 'edited');
  assert.deepEqual(f.sentHeaders.map(h => h.get('Authorization')), [null, 'Basic dXNlcjpwYXNz', null, 'Basic dXNlcjpwYXNz', null]);
  assert.deepEqual(f.waits, [2000, 2000, 2000, 2000]);
});

for (const changed of [{ runOnce: true }, { crawlDepth: 0, unlimitedDepth: false }, { maxPages: 1 }]) {
  test(`resumed scan respects reduced crawl limits: ${JSON.stringify(changed)}`, async t => {
    const pauseControl = createPauseControl();
    const held = Promise.withResolvers();
    let settings = {};
    const f = fixture(t, {
      [root]: '<a href="/one">One</a>',
      [root + 'one']: '<a href="/never">Never</a>',
    }, {
      pauseControl, getSettings: () => ({ discoverSitemaps: false, testExternalUrls: true, ...settings }),
      onSnapshot: pauseAfterFirst(pauseControl, held),
    });
    const running = f.run();
    await held.promise;
    await nextTurn();
    settings = changed;
    pauseControl.resume();
    const result = await running;
    assert.equal(result.pages, 1);
    assert.deepEqual(f.calls, [root, root + 'one']);
  });
}

test('turning off external checks while paused skips queued external URLs', async t => {
  const pauseControl = createPauseControl();
  const held = Promise.withResolvers();
  let settings = { acceptedHosts: 'other.test' };
  const f = fixture(t, { [root]: '<a href="https://other.test/">Other</a><a href="/inside">Inside</a>', [root + 'inside']: '' }, {
    pauseControl, getSettings: () => ({ discoverSitemaps: false, testExternalUrls: true, ...settings }),
    onSnapshot: pauseAfterFirst(pauseControl, held),
  });
  const running = f.run();
  await held.promise;
  await nextTurn();
  settings = { acceptedHosts: '', testExternalUrls: false };
  pauseControl.resume();
  const result = await running;
  assert.deepEqual(f.calls, [root, root + 'inside']);
  assert.equal(result.records.find(r => r.url === 'https://other.test/').outcome, 'Skipped');
  assert.equal(result.checked, 2);
});

test('crawls internal HTML, deduplicates fragments and cycles, and retains all sources', async t => {
  const f = fixture(t, {
    [root]: '<a href="/about">About</a><a href="/missing#one">Missing</a><a href="/missing#two">Again</a><a href="mailto:hello@example.test">Mail</a><a href="https://outside.test/">Outside</a>',
    [`${root}about`]: '<a href="/">Home</a><a href="/missing">Missing</a>',
    [`${root}missing`]: { status: 404 },
    'https://outside.test/': '<a href="/must-not-crawl">External child</a>',
  });
  const result = await f.run();
  assert.deepEqual(f.calls, [root, `${root}about`, `${root}missing`, 'https://outside.test/']);
  assert.equal(result.pages, 2);
  assert.equal(result.checked, 4);
  assert.equal(result.queued, 0);
  assert.deepEqual(result.records.find(r => r.url.endsWith('/missing')).sources, [root, `${root}about`]);
  assert.equal(result.records.find(r => r.status === 404).outcome, 'Broken');
  assert.equal(f.updates[0].records[0].outcome, 'Pending', 'Earlier snapshots stay immutable');
  assert.deepEqual(f.updates[0].records[0].sources, []);
});

test('resolves base elements relative to the final redirected page URL', async t => {
  const f = fixture(t, {
    [root]: { finalUrl: `${root}docs/start`, body: '<base href="../assets/"><a href="help?lang=en#top">Help</a>' },
    [`${root}assets/help?lang=en`]: '',
  });
  const result = await f.run();
  assert.deepEqual(f.calls, [root, `${root}assets/help?lang=en`]);
  assert.equal(result.records[0].finalUrl, `${root}docs/start`);
});

test('checks discovered destinations without expanding pages beyond the crawl limit', async t => {
  const f = fixture(t, {
    [root]: '<a href="/second">Second</a>',
    [`${root}second`]: '<a href="/third">Third</a>',
  }, { maxPages: 1 });
  const result = await f.run();
  assert.equal(result.pages, 1);
  assert.equal(result.checked, 2);
  assert.deepEqual(f.calls, [root, `${root}second`]);
  assert.equal(result.limits.pages, 1);
  assert.equal(result.records[1].crawlLimit, 'pages');
});

test('default settings crawl beyond the former page and depth limits', async t => {
  const routes = { [root]: '<a href="/p1">Next</a>' };
  for (let i = 1; i <= 28; i++) routes[root + 'p' + i] = i < 28 ? `<a href="/p${i + 1}">Next</a>` : '<a href="/">Home</a>';
  const f = fixture(t, routes);
  const result = await f.run();
  assert.equal(result.pages, 29);
  assert.equal(result.checked, 29);
  assert.deepEqual(result.limits, { depth: 0, pages: 0 });
});

test('depth-limited pages retain their HTTP results and explain why further discovery stopped', async t => {
  const f = fixture(t, {
    [root]: '<a href="/one">One</a>',
    [root + 'one']: '<a href="/two">Two</a>',
    [root + 'two']: '<a href="/never">Never</a>',
  }, { unlimitedDepth: false });
  const result = await f.run();
  assert.equal(result.pages, 2);
  assert.equal(result.records[2].outcome, 'Working');
  assert.equal(result.records[2].crawlLimit, 'depth');
  assert.match(result.records[2].crawlDetail, /depth 2 exceeds the maximum depth 1/);
  assert.deepEqual(result.limits, { depth: 1, pages: 0 });
});

test('run once overrides unlimited depth', async t => {
  const f = fixture(t, { [root]: '<a href="/one">One</a>', [root + 'one']: '<a href="/never">Never</a>' }, { maxPages: 0, unlimitedDepth: true, runOnce: true });
  const result = await f.run();
  assert.equal(result.pages, 1);
  assert.equal(result.limits.depth, 1);
});

test('checks every discovered URL beyond the former 500 URL cap', async t => {
  const routes = { [root]: Array.from({ length: 510 }, (_, i) => `<a href="/p${i}">${i}</a>`).join('') };
  for (let i = 0; i < 510; i++) routes[`${root}p${i}`] = { type: 'text/plain' };
  const f = fixture(t, routes);
  const result = await f.run();
  assert.equal(result.records.length, 511);
  assert.equal(result.checked, 511);
  assert.equal(result.pages, 1);
});

test('does not crawl an external redirect destination or non-HTML resource', async t => {
  const f = fixture(t, {
    [root]: '<a href="/redirect">Redirect</a><a href="/file">File</a>',
    [`${root}redirect`]: { finalUrl: 'https://outside.test/', body: '<a href="https://example.test/hidden">Hidden</a>' },
    [`${root}file`]: { type: 'application/json', body: '{}' },
  });
  const result = await f.run();
  assert.equal(result.pages, 1);
  assert.equal(result.checked, 3);
  assert.ok(result.records.every(r => r.outcome === 'Working'));
});

test('network failures remain unverified and do not stop later checks', async t => {
  const f = fixture(t, {
    [root]: '<a href="/offline">Offline</a><a href="/ok">OK</a>',
    [`${root}offline`]: () => { throw new TypeError('Failed to fetch'); },
    [`${root}ok`]: '',
  });
  const result = await f.run();
  assert.equal(result.checked, 3);
  const failed = result.records.find(r => r.url.endsWith('/offline'));
  assert.equal(failed.outcome, 'Unverified');
  assert.match(failed.detail, /does not prove/);
  assert.equal(result.records.at(-1).outcome, 'Working');
});

test('request deadline aborts a stalled fetch and reports it as unverified', async t => {
  const f = fixture(t, {
    [root]: (init, { deadlines }) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      for (const deadline of deadlines) deadline();
    }),
  });
  const result = await f.run();
  assert.equal(result.records[0].outcome, 'Unverified');
  assert.equal(result.checked, 1);
  assert.equal(f.controller.signal.aborted, false);
});

test('stopping an active request cancels it and all queued work', async t => {
  const f = fixture(t, {
    [root]: '<a href="/slow">Slow</a><a href="/queued">Queued</a>',
    [`${root}slow`]: (init, { controller }) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      controller.abort();
    }),
  });
  const result = await f.run();
  assert.deepEqual(f.calls, [root, `${root}slow`]);
  assert.deepEqual(result.records.map(r => r.outcome), ['Working', 'Cancelled', 'Cancelled']);
  assert.equal(result.records[1].detail, 'Scan stopped');
});

test('an already cancelled scan makes no requests', async t => {
  const f = fixture(t, {});
  f.controller.abort();
  const result = await f.run();
  assert.deepEqual(f.calls, []);
  assert.equal(result.checked, 0);
  assert.equal(result.records[0].outcome, 'Cancelled');
});

test('stopping a stalled HTML download cancels its reader and skips queued URLs', async t => {
  let cancelled = false;
  const f = fixture(t, {
    [root]: '<a href="/slow">Slow</a><a href="/queued">Queued</a>',
    [root + 'slow']: (init, { controller }) => {
      let pulls = 0;
      const body = new ReadableStream({
        pull(stream) {
          if (++pulls === 1) stream.enqueue(new TextEncoder().encode('<a href="/hidden">Hidden</a>'));
          else queueMicrotask(() => controller.abort());
        },
        cancel() { cancelled = true; },
      });
      const response = new Response(body, { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: root + 'slow' });
      return response;
    },
  });
  const result = await f.run();
  assert.equal(cancelled, true);
  assert.deepEqual(f.calls, [root, root + 'slow']);
  assert.deepEqual(result.records.map(r => r.outcome), ['Working', 'Cancelled', 'Cancelled']);
  assert.equal(result.queued, 0);
});

test('fast responses let a scheduled stop event run before the queue finishes', async t => {
  const controller = new AbortController();
  const calls = [];
  const updates = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  globalThis.DOMParser = DOMParser;
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'DOMParser', original);
    else delete globalThis.DOMParser;
  });
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    // Simulate a UI event in the next task, rather than aborting inside fetch.
    if (url === root) setTimeout(() => controller.abort(), 0);
    const response = new Response('<a href="/next">Next</a>', { headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  });
  await scan({ start: root, signal: controller.signal, onUpdate: value => updates.push(value) });
  assert.deepEqual(calls, [root]);
  assert.equal(updates.at(-1).records.find(r => r.url === root + 'next').outcome, 'Cancelled');
  assert.equal(updates.at(-1).queued, 0);
});

test('oversized HTML is not parsed but its successful HTTP status is retained', async t => {
  const f = fixture(t, { [root]: 'x'.repeat(2_000_001) });
  const result = await f.run();
  assert.equal(result.records[0].outcome, 'Working');
  assert.equal(result.records[0].detail, 'Page exceeds 2 MB parsing limit');
  assert.equal(result.checked, 1);
});

test('invalid and absent URLs are rejected and response categories remain distinct', () => {
  assert.equal(normalize(undefined, root), null);
  assert.equal(normalize('http://['), null);
  assert.equal(classify(401), 'Restricted');
  assert.equal(classify(503), 'Server error');
  assert.equal(classify(302), 'Unverified');
});

 test('custom timeout aborts a stalled request', async t => {
  const f = fixture(t, {
    [root]: (init, { deadlines }) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      for (const deadline of deadlines) deadline();
    }),
  }, { timeoutSeconds: 3 });
  assert.equal((await f.run()).records[0].outcome, 'Unverified');
});

test('rate limit spaces request starts and does not wait after the last URL', async t => {
  const f = fixture(t, { [root]: '<a href="/next">Next</a>', [root + 'next']: '' }, { requestsPerMinute: 30 });
  assert.equal((await f.run()).checked, 2);
  assert.deepEqual(f.waits, [2000]);
});

test('unlimited requests have no pacing delay', async t => {
  const f = fixture(t, { [root]: '<a href="/next">Next</a>', [root + 'next']: '' });
  await f.run();
  assert.deepEqual(f.waits, []);
});

test('stopping during a rate limit wait cancels queued links without fetching them', async t => {
  const f = fixture(t, { [root]: '<a href="/next">Next</a>' }, { requestsPerMinute: 1, stopWhileWaiting: true });
  const result = await f.run();
  assert.deepEqual(f.calls, [root]);
  assert.equal(result.records[1].outcome, 'Cancelled');
  assert.equal(result.checked, 1);
});


test('scan applies Basic auth only to its origin and sends custom headers across hosts', async t => {
  const f = fixture(t, {
    [root]: '<a href="/inside">Inside</a><a href="https://other.test/">Accepted</a><a href="https://outside.test/">External</a>',
    [root + 'inside']: '',
    'https://other.test/': '',
    'https://outside.test/': '',
  }, { username: 'user', password: 'pass', acceptedHosts: 'other.test', headers: 'X-Scanned-By: LinkSlope\nX-Request-Test: yes' });
  const result = await f.run();
  assert.equal(result.checked, 4);
  assert.deepEqual(f.sentHeaders.map(h => h.get('Authorization')), ['Basic dXNlcjpwYXNz', 'Basic dXNlcjpwYXNz', null, null]);
  for (const headers of f.sentHeaders) {
    assert.equal(headers.get('X-Scanned-By'), 'LinkSlope');
    assert.equal(headers.get('X-Request-Test'), 'yes');
  }
  assert.ok(!JSON.stringify(f.updates).includes('dXNlcjpwYXNz'));
});

test('scan sends its default header without authentication', async t => {
  const f = fixture(t, { [root]: '' });
  await f.run();
  assert.deepEqual([...f.sentHeaders[0]], [['x-scanned-by', 'LinkSlope']]);
});

test('browser cookies use credentialed requests without adding a manual Cookie header', async t => {
  const f = fixture(t, {
    [root]: '<a href="/inside">Inside</a><a href="https://outside.test/">Outside</a>',
    [root + 'inside']: '',
    'https://outside.test/': '',
  }, { useBrowserCookies: true });
  assert.equal((await f.run()).checked, 3);
  assert.deepEqual(f.credentialModes, ['include', 'include', 'include']);
  for (const headers of f.sentHeaders) assert.equal(headers.has('Cookie'), false);
});

test('ignored logout links are never requested or expanded with browser cookies enabled', async t => {
  const f = fixture(t, {
    [root]: '<a href="/logout">Logout</a><a href="/logout?next=home">Logout again</a><a href="/safe">Safe</a><a href="https://other.test/signout">External logout</a>',
    [root + 'safe']: '<a href="/logout/child">Logout child</a>',
  }, { useBrowserCookies: true, ignorePrefixes: 'example.test/logout\nregex: other\\.test/signout' });
  const result = await f.run();
  assert.deepEqual(f.calls, [root, root + 'safe']);
  assert.equal(result.records.length, 6);
  assert.equal(result.records.filter(r => r.outcome === 'Skipped').length, 4);
  assert.equal(result.checked, 2);
});

test('/logout excludes nested tokenized logout links before credentialed requests', async t => {
  const f = fixture(t, {
    [root]: '<a href="/user/logout?token=test-token">Logout</a><a href="/account/user/logout">Nested logout</a><a href="/safe">Safe</a>',
    [root + 'safe']: '<a href="/user/logout?token=another-test-token">Logout</a>',
  }, { useBrowserCookies: true, ignorePrefixes: '/logout' });
  const result = await f.run();
  assert.deepEqual(f.calls, [root, root + 'safe']);
  assert.equal(result.records.length, 5);
  assert.ok(result.records.filter(r => r.url.includes('/logout')).every(r => r.outcome === 'Skipped'));
  assert.equal(result.checked, 2);
});

test('ignore rules edited while paused skip a previously queued logout URL', async t => {
  const pauseControl = createPauseControl();
  const held = Promise.withResolvers();
  let settings = {};
  const f = fixture(t, { [root]: '<a href="/logout">Logout</a><a href="/safe">Safe</a>', [root + 'safe']: '' }, {
    pauseControl, getSettings: () => ({ discoverSitemaps: false, testExternalUrls: true, ...settings }), onSnapshot: pauseAfterFirst(pauseControl, held),
  });
  const running = f.run();
  await held.promise;
  await nextTurn();
  settings = { ignorePrefixes: '/logout' };
  pauseControl.resume();
  const result = await running;
  assert.deepEqual(f.calls, [root, root + 'safe']);
  assert.equal(result.records.find(r => r.url === root + 'logout').outcome, 'Skipped');
  assert.equal(result.checked, 2);
});

test('an ignored starting URL makes no network requests', async t => {
  const f = fixture(t, {}, { ignorePrefixes: 'example.test/' });
  const result = await f.run();
  assert.deepEqual(f.calls, []);
  assert.equal(result.records[0].outcome, 'Skipped');
  assert.equal(result.checked, 0);
});

test('opaque redirects are not followed when destination inspection is unavailable', async t => {
  const f = fixture(t, {
    [root]: () => {
      const response = new Response(null);
      Object.defineProperties(response, { type: { value: 'opaqueredirect' }, status: { value: 0 }, url: { value: root } });
      return response;
    },
  }, { ignorePrefixes: '/logout', useBrowserCookies: true });
  const result = await f.run();
  assert.deepEqual(f.calls, [root]);
  assert.equal(result.records[0].outcome, 'Unverified');
  assert.match(result.records[0].detail, /could not be inspected/);
  assert.equal(result.pages, 0);
});

test('allowed redirects continue crawling while redirects to nested logout URLs are skipped', async t => {
  const f = fixture(t, {
    [root]: { status: 302, headers: { location: '/canonical/' } },
    [root + 'canonical/']: '<a href="child">Child</a><a href="/go-logout">Logout redirect</a>',
    [root + 'canonical/child']: '',
    [root + 'go-logout']: { status: 302, headers: { location: '/user/logout?token=test-token' } },
  }, { ignorePrefixes: '/logout', useBrowserCookies: true });
  const result = await f.run();
  assert.deepEqual(f.calls, [root, root + 'canonical/', root + 'canonical/child', root + 'go-logout']);
  assert.equal(result.records[0].outcome, 'Working');
  assert.equal(result.records[0].finalUrl, root + 'canonical/');
  assert.equal(result.records.find(r => r.url === root + 'go-logout').outcome, 'Skipped');
  assert.equal(result.records.find(r => r.url === root + 'user/logout?token=test-token').outcome, 'Skipped');
  assert.equal(result.pages, 2);
});

test('Drupal edit links are checked with logout exclusions and reported with sources when ignored', async t => {
  const f = fixture(t, {
    [root]: '<a href="/user/2/edit">Edit</a><a href="/user/3/edit">Other edit</a><a href="/safe">Safe</a>',
    [root + 'user/2/edit']: '',
    [root + 'safe']: '<a href="/user/3/edit">Other edit again</a>',
  }, { ignorePrefixes: '/logout\n/user/3/edit', useBrowserCookies: true });
  const result = await f.run();
  assert.deepEqual(f.calls, [root, root + 'user/2/edit', root + 'safe']);
  assert.equal(result.records.find(r => r.url === root + 'user/2/edit').outcome, 'Working');
  const skipped = result.records.find(r => r.url === root + 'user/3/edit');
  assert.equal(skipped.outcome, 'Skipped');
  assert.match(skipped.detail, /ignore prefixes/);
  assert.deepEqual(skipped.sources, [root, root + 'safe']);
});

test('invalid ignore patterns prevent network requests', async t => {
  const f = fixture(t, {}, { ignorePrefixes: 'regex: [' });
  await assert.rejects(f.run(), /Invalid ignore-prefix regex/);
  assert.deepEqual(f.calls, []);
});

test('browser cookie setting can be enabled while paused for remaining requests', async t => {
  const pauseControl = createPauseControl();
  const held = Promise.withResolvers();
  let settings = { useBrowserCookies: false };
  const f = fixture(t, { [root]: '<a href="/next">Next</a>', [root + 'next']: '' }, {
    pauseControl, getSettings: () => ({ discoverSitemaps: false, testExternalUrls: true, ...settings }), onSnapshot: pauseAfterFirst(pauseControl, held),
  });
  const running = f.run();
  await held.promise;
  await nextTurn();
  settings = { useBrowserCookies: true };
  pauseControl.resume();
  await running;
  assert.deepEqual(f.credentialModes, ['omit', 'include']);
});

test('scan can omit all custom headers', async t => {
  const f = fixture(t, { [root]: '' }, { headers: '' });
  await f.run();
  assert.deepEqual([...f.sentHeaders[0]], []);
});

test('invalid headers prevent all network requests', async t => {
  const f = fixture(t, {}, { headers: 'invalid' });
  await assert.rejects(f.run(), /Invalid custom header/);
  assert.deepEqual(f.calls, []);
});

test('content checks cover boundary and external pages without expanding crawl scope', async t => {
  const f = fixture(t, {
    [root]: '<title>Required</title><a href="/one">One</a><a href="https://outside.test/">Other</a>',
    [root + 'one']: '<a href="/never">Forbidden123</a>',
    'https://outside.test/': { body: 'Required', type: 'text/plain' },
  }, { unlimitedDepth: false, crawlDepth: 0, checkPresence: 'Required', checkAbsence: 'regex:Forbidden[0-9]+' });
  const result = await f.run();
  assert.equal(result.pages, 1);
  assert.equal(result.records.length, 3);
  assert.deepEqual(result.records.map(r => r.contentChecks.map(c => c.outcome)), [['Passed', 'Passed'], ['Failed', 'Failed'], ['Passed', 'Passed']]);
  assert.ok(result.records.every(r => r.outcome === 'Working'));
});

test('content checks distinguish binary and oversized responses from passes', async t => {
  const f = fixture(t, {
    [root]: '<a href="/binary">Binary</a><a href="/large">Large</a>',
    [root + 'binary']: { body: 'test', type: 'image/png' },
    [root + 'large']: 'x'.repeat(2_000_001),
  }, { checkAbsence: 'forbidden' });
  const result = await f.run();
  assert.deepEqual(result.records.map(r => r.contentChecks[0].outcome), ['Passed', 'Not checked', 'Not checked']);
});

test('default discovery follows robots sitemaps and nested indexes, deduplicates pages and skips external URLs', async t => {
  const f = fixture(t, {
    [root]: '<a href="/shared">Shared</a><a href="https://outside.test/">External</a>',
    [root + 'robots.txt']: 'User-agent: *\nDisallow: /private\nSitemap: https://example.test/index.xml',
    [root + 'sitemap.xml']: '<urlset><url><loc>https://example.test/shared</loc></url><url><loc>https://example.test/hidden?a=1&amp;b=2</loc></url><url><loc>https://outside.test/from-map</loc></url></urlset>',
    [root + 'index.xml']: '<sitemapindex><sitemap><loc>/child.xml</loc></sitemap></sitemapindex>',
    [root + 'child.xml']: '<sitemapindex><sitemap><loc>/index.xml</loc></sitemap><sitemap><loc>/leaf.xml</loc></sitemap></sitemapindex>',
    [root + 'leaf.xml']: '<urlset><url><loc>/deep</loc></url></urlset>',
    [root + 'shared']: '', [root + 'hidden?a=1&b=2']: '', [root + 'deep']: '',
  }, { discoverSitemaps: true, testExternalUrls: false });
  const result = await f.run();
  assert.equal(result.pages, 4);
  assert.equal(result.checked, 9);
  assert.equal(new Set(f.calls).size, f.calls.length);
  assert.ok(f.calls.includes(root + 'deep'));
  assert.ok(!f.calls.some(url => url.startsWith('https://outside.test/')));
  assert.deepEqual(result.records.find(r => r.url === root + 'shared').sources, [root, root + 'sitemap.xml']);
  assert.equal(result.records.filter(r => r.outcome === 'Skipped').length, 2);
});

test('discovery files share exclusions, credentials, pacing, and the page limit', async t => {
  const f = fixture(t, {
    [root]: '',
    [root + 'robots.txt']: 'Sitemap: https://other.test/map.xml\nSitemap: /logout.xml',
    [root + 'sitemap.xml']: { status: 404 },
    'https://other.test/map.xml': '<urlset><url><loc>https://example.test/hidden</loc></url><url><loc>https://example.test/logout</loc></url></urlset>',
    [root + 'hidden']: '<a href="/never">Never</a>',
  }, { discoverSitemaps: true, testExternalUrls: false, acceptedHosts: 'other.test', ignorePrefixes: '/logout', maxPages: 1, username: 'user', password: 'pass', useBrowserCookies: true, requestsPerMinute: 60 });
  const result = await f.run();
  assert.equal(result.pages, 1);
  assert.equal(result.limits.pages, 1);
  assert.deepEqual(f.waits, [1000, 1000, 1000, 1000]);
  assert.equal(f.sentHeaders[f.calls.indexOf('https://other.test/map.xml')].get('Authorization'), null);
  assert.equal(f.sentHeaders[1].get('Authorization'), 'Basic dXNlcjpwYXNz');
  assert.equal(result.records.find(r => r.url === root + 'sitemap.xml').outcome, 'Skipped');
  assert.ok(!f.calls.some(url => url.includes('logout')));
});

test('missing or invalid discovery files do not stop HTML crawling', async t => {
  const f = fixture(t, {
    [root]: '<a href="/inside">Inside</a>',
    [root + 'inside']: '',
    [root + 'robots.txt']: { status: 404 },
    [root + 'sitemap.xml']: '<html>Not XML sitemap</html>',
  }, { discoverSitemaps: true });
  const result = await f.run();
  assert.equal(result.pages, 2);
  assert.equal(result.records.find(r => r.url === root + 'sitemap.xml').outcome, 'Unverified');
});

test('run once suppresses enabled discovery', async t => {
  const f = fixture(t, { [root]: '' }, { discoverSitemaps: true, runOnce: true });
  await f.run();
  assert.deepEqual(f.calls, [root]);
});

test('discovery can be disabled while paused before its requests begin', async t => {
  const pauseControl = createPauseControl();
  const held = Promise.withResolvers();
  let settings = { discoverSitemaps: true };
  const f = fixture(t, { [root]: '' }, {
    discoverSitemaps: true, pauseControl, getSettings: () => settings,
    onSnapshot: pauseAfterFirst(pauseControl, held),
  });
  const running = f.run();
  await held.promise;
  settings = { discoverSitemaps: false };
  pauseControl.resume();
  const result = await running;
  assert.deepEqual(f.calls, [root]);
  assert.equal(result.records.filter(r => r.outcome === 'Skipped').length, 2);
});

for (const stop of [false, true]) {
  test(`stalled discovery respects ${stop ? 'stop' : 'timeout'} and cleans up its reader`, async t => {
    let cancelled = false;
    const f = fixture(t, {
      [root]: '',
      [root + 'robots.txt']: (init, { controller, deadlines }) => {
        let pulls = 0;
        const response = new Response(new ReadableStream({
          pull(stream) {
            if (++pulls === 1) stream.enqueue(new TextEncoder().encode('Sitemap: /never.xml'));
            else queueMicrotask(() => { if (stop) controller.abort(); else for (const deadline of deadlines) deadline(); });
          },
          cancel() { cancelled = true; },
        }));
        Object.defineProperty(response, 'url', { value: root + 'robots.txt' });
        return response;
      },
      [root + 'sitemap.xml']: '<urlset/>',
    }, { discoverSitemaps: true });
    const result = await f.run();
    assert.equal(cancelled, true);
    assert.equal(result.records.find(r => r.url === root + 'robots.txt').outcome, stop ? 'Cancelled' : 'Unverified');
    assert.equal(f.calls.includes(root + 'sitemap.xml'), !stop);
    assert.equal(result.queued, 0);
    assert.ok(!f.calls.includes(root + 'never.xml'));
  });
}

for (const crawlResources of [false, true]) {
  test(`resource discovery is ${crawlResources ? 'enabled' : 'disabled'} without rendering assets`, async t => {
    const f = fixture(t, {
      [root]: '<base href="/assets/"><a href="shared">Shared</a><img src="image.png"><img srcset="small.png 1x, large.png 2x"><picture><source srcset="wide.png 800w"></picture><img src="data:image/png;base64,AAAA"><link rel="stylesheet" href="site.css"><script src="app.js"></script><img src="shared"><img src="https://cdn.test/image.png">',
      [root + 'assets/shared']: '',
      [root + 'assets/image.png']: { status: 404, type: 'image/png' },
      [root + 'assets/small.png']: { type: 'image/png' },
      [root + 'assets/large.png']: { type: 'image/png' },
      [root + 'assets/wide.png']: { type: 'image/png' },
      [root + 'assets/site.css']: { type: 'text/css', body: '@import "never.css";' },
      [root + 'assets/app.js']: { type: 'text/html', body: '<a href="/never">Not a real page</a>' },
    }, { crawlResources, testExternalUrls: false });
    const result = await f.run();
    assert.equal(result.pages, 2);
    assert.equal(result.checked, crawlResources ? 8 : 2);
    assert.equal(new Set(f.calls).size, f.calls.length);
    if (crawlResources) {
      assert.equal(result.records.find(r => r.url === root + 'assets/image.png').outcome, 'Broken');
      assert.match(result.records.find(r => r.url === root + 'assets/site.css').sourceExcerpts[0].html, /stylesheet/);
      assert.equal(result.records.find(r => r.url === 'https://cdn.test/image.png').outcome, 'Skipped');
      assert.equal(result.records.find(r => r.url === root + 'assets/shared').resourceOnly, false);
    }
  });
}

test('resources honor exclusions and accepted hosts during a run-once scan', async t => {
  const f = fixture(t, {
    [root]: '<img src="/ignore.png"><script src="https://cdn.test/app.js"></script><img src="/local.png">',
    'https://cdn.test/app.js': { type: 'text/javascript' },
    [root + 'local.png']: { type: 'image/png' },
  }, { crawlResources: true, runOnce: true, testExternalUrls: false, acceptedHosts: 'cdn.test', ignorePrefixes: '/ignore', username: 'user', password: 'pass', requestsPerMinute: 60 });
  const result = await f.run();
  assert.equal(result.pages, 1);
  assert.deepEqual(f.calls, [root, 'https://cdn.test/app.js', root + 'local.png']);
  assert.deepEqual(f.sentHeaders.map(headers => headers.get('Authorization')), ['Basic dXNlcjpwYXNz', null, 'Basic dXNlcjpwYXNz']);
  assert.deepEqual(f.waits, [1000, 1000]);
});

test('turning resources off while paused skips queued resource-only requests', async t => {
  const pauseControl = createPauseControl();
  const held = Promise.withResolvers();
  let settings = { discoverSitemaps: false, crawlResources: true };
  const f = fixture(t, { [root]: '<img src="/queued.png">' }, {
    crawlResources: true, pauseControl, getSettings: () => settings,
    onSnapshot: pauseAfterFirst(pauseControl, held),
  });
  const running = f.run();
  await held.promise;
  settings = { discoverSitemaps: false, crawlResources: false };
  pauseControl.resume();
  const result = await running;
  assert.deepEqual(f.calls, [root]);
  assert.equal(result.records[1].outcome, 'Skipped');
});

function retryResponse(url, status, retryAfter) {
  const response = new Response('', { status, headers: { 'content-type': 'text/html', ...(retryAfter && { 'retry-after': retryAfter }) } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

test('429 cooldown allows other hosts to continue and counts retried URLs once', async t => {
  let attempts = 0;
  const times = [];
  const f = fixture(t, {
    [root]: '<a href="/limited">Limited</a><a href="/same-host">Same</a><a href="https://other.test/">Other</a>',
    [root + 'limited']: init => {
      times.push(performance.now());
      if (++attempts > 1) assert.equal(init.cache, 'no-store');
      return retryResponse(root + 'limited', attempts === 1 ? 429 : 200, '3');
    },
    [root + 'same-host']: '',
    'https://other.test/': '',
  }, { retryRateLimited: true });
  const result = await f.run();
  assert.deepEqual(f.calls, [root, root + 'limited', 'https://other.test/', root + 'same-host', root + 'limited']);
  assert.ok(times[1] - times[0] >= 3000);
  assert.equal(result.checked, 4);
  assert.equal(result.records.find(r => r.url === root + 'limited').outcome, 'Working');
  assert.ok(f.updates.some(update => update.waitingFor.includes('Waiting before retry')));
});

test('429 retries use bounded fallback delays and leave exhausted URLs rate limited', async t => {
  t.mock.method(Math, 'random', () => 0);
  const times = [];
  const f = fixture(t, { [root]: () => { times.push(performance.now()); return retryResponse(root, 429); } }, { retryRateLimited: true });
  const result = await f.run();
  assert.deepEqual(times, [0, 5000, 20000, 65000]);
  assert.equal(result.checked, 1);
  assert.equal(result.records[0].outcome, 'Rate limited');
  assert.match(result.records[0].detail, /3 automatic retries/);
});

test('429 automatic retries remain off by default', async t => {
  const f = fixture(t, { [root]: { status: 429 } });
  const result = await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(result.records[0].outcome, 'Rate limited');
});

test('stop interrupts a server-requested cooldown', async t => {
  const f = fixture(t, { [root]: () => retryResponse(root, 429, '600') }, { retryRateLimited: true, stopWhileWaiting: true });
  const result = await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(result.records[0].outcome, 'Cancelled');
  assert.equal(result.waitingFor, '');
});

test('disabling retries while paused preserves the 429 result without another request', async t => {
  const pauseControl = createPauseControl();
  const held = Promise.withResolvers();
  let settings = { discoverSitemaps: false, retryRateLimited: true };
  const f = fixture(t, { [root]: () => retryResponse(root, 429, '60') }, {
    retryRateLimited: true, pauseControl, getSettings: () => settings,
    onSnapshot: pauseAfterFirst(pauseControl, held),
  });
  const running = f.run();
  await held.promise;
  settings = { discoverSitemaps: false, retryRateLimited: false };
  pauseControl.resume();
  const result = await running;
  assert.equal(f.calls.length, 1);
  assert.equal(result.records[0].outcome, 'Rate limited');
});
