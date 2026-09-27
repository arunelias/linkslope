import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { scan } from '../src/crawler.js';
import { retestLink, paginate } from '../src/report.js';

const start = 'https://example.test/';
function response(url, status = 200, body = '') {
  const result = new Response(body, { status, headers: { 'content-type': 'text/html' } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}
test('scan captures a bounded source excerpt, resolved base URL, and timing', async t => {
  t.mock.method(globalThis, 'fetch', async url => response(url, 200, url === start ? '<base href="/docs/"><a href="guide">' + 'x'.repeat(700) + '</a>' : ''));
  const originalParser = globalThis.DOMParser;
  globalThis.DOMParser = DOMParser;
  t.after(() => { if (originalParser) globalThis.DOMParser = originalParser; else delete globalThis.DOMParser; });
  let data;
  await scan({ start, runOnce: true, signal: new AbortController().signal, onUpdate: value => { data = value; } });
  const record = data.records.find(item => item.url === start + 'docs/guide');
  assert.equal(record.sourceExcerpts[0].source, start);
  assert.match(record.sourceExcerpts[0].html, /^<a href="guide">/);
  assert.ok(record.sourceExcerpts[0].html.length <= 601);
  assert.ok(record.timeMs >= 0);
  assert.ok(record.testedAt);
});
test('re-test bypasses cache, preserves original credential scope and refreshes status', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.get('Authorization'), null);
    assert.equal(options.cache, 'no-store');
    return response(url);
  });
  const result = await retestLink({ start, url: 'https://outside.test/', settings: { testExternalUrls: true, username: 'user', password: 'password' } });
  assert.equal(result.outcome, 'Working');
  assert.equal(result.status, 200);
  assert.equal(result.detail, undefined);
  assert.ok(result.timeMs >= 0);
});
test('re-test respects ignored targets and disabled external checks without requests', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Should not fetch'); });
  for (const settings of [{ ignorePrefixes: '/logout' }, { testExternalUrls: false }]) {
    const result = await retestLink({ start, url: 'https://outside.test/logout', settings });
    assert.equal(result.outcome, 'Skipped');
    assert.equal(result.timeMs, undefined);
  }
});
test('re-test respects excluded redirect destinations', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return new Response(null, { status: 302, headers: { location: '/logout' } });
  });
  const result = await retestLink({ start, url: start, settings: { ignorePrefixes: '/logout' } });
  assert.equal(result.outcome, 'Skipped');
  assert.equal(calls.length, 1);
});
test('pagination clamps shrinking results and handles empty and final pages', () => {
  const rows = Array.from({ length: 26 }, (_, i) => i);
  assert.deepEqual(paginate(rows, 2, 25).rows, [25]);
  assert.equal(paginate(rows.slice(0, 3), 2, 25).current, 1);
  assert.equal(paginate([], 8, 25).first, 0);
  assert.equal(paginate([], 8, 25).last, 0);
});


test('re-test refreshes content checks and clears them when disabled', async t => {
  t.mock.method(globalThis, 'fetch', async url => response(url, 200, '<title>Example</title>\n a.b '));
  const result = await retestLink({ url: start, start, settings: { checkPresence: '<title>Example</title>\n a.b ', checkAbsence: 'regex:Exam[a-z]+' } });
  assert.equal(result.outcome, 'Working');
  assert.deepEqual(result.contentChecks.map(c => c.outcome), ['Passed', 'Failed']);
  const literal = await retestLink({ url: start, start, settings: { checkPresence: 'a+b', checkAbsence: 'example' } });
  assert.deepEqual(literal.contentChecks.map(c => c.outcome), ['Failed', 'Passed']);
  const cleared = await retestLink({ url: start, start, settings: {} });
  assert.deepEqual(cleared.contentChecks, []);
});
