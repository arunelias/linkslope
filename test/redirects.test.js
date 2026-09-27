import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeRedirectObserver, fetchWithRedirects } from '../src/redirects.js';
import { createIgnoreMatcher, createRequestHeaders, validateSettings } from '../src/settings.js';

const start = 'https://example.test/';

function network(routes, controller = new AbortController()) {
  const calls = [];
  const observations = new Map();
  const open = new Set();
  return {
    calls, open,
    async run(options = {}) {
      return fetchWithRedirects({
        url: start, headersForUrl: createRequestHeaders(validateSettings({ username: 'user', password: 'pass' }), start),
        ignored: createIgnoreMatcher('/logout'), signal: controller.signal, credentials: 'include',
        observeRedirect(url) {
          open.add(url);
          return { read: () => observations.get(url), dispose: () => open.delete(url) };
        },
        async fetchImpl(url, init) {
          calls.push({ url, init });
          assert.equal(init.redirect, 'manual');
          assert.ok(open.has(url));
          const route = routes[url];
          assert.ok(route, `Unexpected request ${url}`);
          if (route.error) throw new Error(route.error);
          if (route.abort) controller.abort();
          if (route.location) {
            observations.set(url, { status: route.status ?? 302, location: route.location });
            const response = new Response(null);
            Object.defineProperties(response, { type: { value: 'opaqueredirect' }, status: { value: 0 } });
            return response;
          }
          const response = new Response(route.body ?? 'done');
          Object.defineProperty(response, 'url', { value: url });
          return response;
        },
        ...options,
      });
    },
  };
}

test('observed opaque redirect chains follow allowed URLs and scope Authorization on every hop', async () => {
  const f = network({
    [start]: { location: '/relative' },
    [start + 'relative']: { location: 'https://other.test/final' },
    'https://other.test/final': {},
  });
  const response = await f.run();
  assert.equal(response.url, 'https://other.test/final');
  assert.deepEqual(f.calls.map(call => call.url), [start, start + 'relative', 'https://other.test/final']);
  assert.deepEqual(f.calls.map(call => call.init.headers.get('Authorization')), ['Basic dXNlcjpwYXNz', 'Basic dXNlcjpwYXNz', null]);
  assert.ok(f.calls.every(call => call.init.credentials === 'include'));
  assert.equal(f.open.size, 0);
});

test('observed redirect to ignored logout is never requested', async () => {
  const f = network({ [start]: { location: '/user/logout?token=test-token' } });
  await assert.rejects(f.run(), error => error.outcome === 'Skipped' && error.status === 302);
  assert.equal(f.calls.length, 1);
  assert.equal(f.open.size, 0);
});

test('redirect loops, unsupported URLs, aborts and failures release observers', async () => {
  for (const [routes, message] of [
    [{ [start]: { location: '/' } }, /Redirect loop/],
    [{ [start]: { location: 'javascript:logout()' } }, /not a valid HTTP/],
    [{ [start]: { location: 'https://user:pass@other.test/' } }, /not a valid HTTP/],
    [{ [start]: { error: 'network failure' } }, /network failure/],
    [{ [start]: { abort: true, location: '/next' } }, /abort/i],
  ]) {
    const f = network(routes);
    await assert.rejects(f.run(), message);
    assert.equal(f.open.size, 0);
    assert.equal(f.calls.length, 1);
  }
});

test('Chrome observer isolates the scanner document and removes its listener', async () => {
  const listeners = new Set();
  const chromeApi = {
    tabs: { getCurrent: async () => ({ id: 7 }) },
    runtime: { id: 'test-extension', getContexts: async () => [{ frameId: 0, documentId: 'scanner-document' }] },
    webRequest: { onHeadersReceived: {
      addListener(listener, filter, extras) { listeners.add(listener); assert.deepEqual(extras, ['responseHeaders']); },
      removeListener: listener => listeners.delete(listener),
    } },
  };
  const observe = await createChromeRedirectObserver(chromeApi);
  const observation = observe(start);
  const fire = details => { for (const listener of listeners) listener({ url: start, statusCode: 302, responseHeaders: [{ name: 'Location', value: '/safe' }], ...details }); };
  fire({ documentId: 'other-document', tabId: 8, initiator: 'chrome-extension://test-extension' });
  assert.equal(observation.read(), undefined);
  fire({ documentId: 'scanner-document', url: start + 'other' });
  assert.equal(observation.read(), undefined);
  fire({ documentId: 'scanner-document', tabId: -1 });
  assert.deepEqual(observation.read(), { status: 302, location: '/safe' });
  observation.dispose();
  assert.equal(listeners.size, 0);
});
