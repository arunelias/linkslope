import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { DOMParser } from 'linkedom';
import { parseDiscovery, readDiscoverySource } from '../src/discovery.js';
import { validateSettings } from '../src/settings.js';

test('discovery is enabled and external checks disabled by default; both require booleans', () => {
  assert.equal(validateSettings().discoverSitemaps, true);
  assert.equal(validateSettings().testExternalUrls, false);
  for (const key of ['discoverSitemaps', 'testExternalUrls']) {
    for (const value of ['false', null, 1]) assert.throws(() => validateSettings({ [key]: value }), /true or false/);
  }
});

test('robots discovery reads sitemap directives, not robots path patterns', () => {
  assert.deepEqual(parseDiscovery('User-agent: *\nDisallow: /private/*\nAllow: /public\n Sitemap: https://site.test/map.xml # comment\nSITEMAP: /second.xml', 'robots'), [
    { value: 'https://site.test/map.xml', kind: 'sitemap' }, { value: '/second.xml', kind: 'sitemap' },
  ]);
});

test('XML discovery handles namespaces and entities without importing image loc elements', t => {
  const original = globalThis.DOMParser;
  globalThis.DOMParser = DOMParser;
  t.after(() => { if (original) globalThis.DOMParser = original; else delete globalThis.DOMParser; });
  assert.deepEqual(parseDiscovery('<s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9"><s:url><s:loc>https://site.test/?a=1&amp;b=2</s:loc><image:image xmlns:image="urn:image"><image:loc>https://site.test/image.jpg</image:loc></image:image></s:url></s:urlset>', 'sitemap'), [{ value: 'https://site.test/?a=1&b=2', kind: null }]);
  assert.throws(() => parseDiscovery('<html><body>Not a sitemap</body></html>', 'sitemap'), /sitemap XML/);
});

test('discovery reads gzip files and bounds decompressed size', async () => {
  const signal = new AbortController().signal;
  assert.equal(await readDiscoverySource(new Response(gzipSync('<urlset/>')), signal), '<urlset/>');
  assert.equal(await readDiscoverySource(new Response('<urlset/>'), signal), '<urlset/>');
  await assert.rejects(readDiscoverySource(new Response(gzipSync('x'.repeat(2_000_001))), signal), /2 MB/);
});
