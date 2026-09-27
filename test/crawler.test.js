import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, classify } from '../src/crawler.js';
test('normalizes relative URLs and fragments without removing meaningful queries', () => {
  assert.equal(normalize('../help?q=1#section', 'https://example.com/docs/page'), 'https://example.com/help?q=1');
  assert.equal(normalize('mailto:a@example.com'), null);
  assert.equal(normalize('https://user:password@example.com'), null);
});
test('does not label restricted, rate-limited or unknown responses as broken', () => {
  assert.equal(classify(404), 'Broken');
  assert.equal(classify(410), 'Broken');
  assert.equal(classify(403), 'Restricted');
  assert.equal(classify(429), 'Rate limited');
  assert.equal(classify(0), 'Unverified');
  assert.equal(classify(200), 'Working');
});
