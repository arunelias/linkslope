import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { parseCrawlHtml } from '../src/html.js';

test('crawl markup stays in template contents while preserving base URLs and link excerpts', t => {
  const original = globalThis.DOMParser;
  globalThis.DOMParser = class extends DOMParser {
    parseFromString(source, type) {
      assert.equal(source, '', 'Untrusted markup must not enter document-level parsing');
      return super.parseFromString(source, type);
    }
  };
  t.after(() => { if (original) globalThis.DOMParser = original; else delete globalThis.DOMParser; });
  const fragment = parseCrawlHtml(`<!doctype html><html><head>
    <base href="/docs/">
    <link rel="preload" as="style" href="https://assets.test/style.css">
    <script src="https://assets.test/app.js"></script>
    </head><body><img src="https://assets.test/image.png">
    <iframe src="https://assets.test/frame"></iframe>
    <a href="guide?a=1&amp;b=2"><strong>Guide</strong></a></body></html>`);
  assert.equal(fragment.nodeType, 11);
  assert.equal(fragment.isConnected, false);
  assert.equal(fragment.querySelector('base').getAttribute('href'), '/docs/');
  const links = fragment.querySelectorAll('a[href]');
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), 'guide?a=1&b=2');
  assert.match(links[0].outerHTML, /<strong>Guide<\/strong>/);
});
