import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay } from '../src/retry.js';
import { validateSettings } from '../src/settings.js';

test('Retry-After accepts seconds and HTTP dates with fallback for invalid values', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  assert.equal(retryDelay('20', 0, now, 0), 20000);
  assert.equal(retryDelay('Wed, 23 Sep 2026 12:00:30 GMT', 0, now, 0), 30000);
  assert.equal(retryDelay('0', 0, now, 0), 1000);
  assert.equal(retryDelay('-5', 1, now, 0.5), 15500);
  assert.equal(retryDelay('invalid', 2, now, 0), 45000);
  assert.equal(validateSettings().retryRateLimited, false);
  assert.throws(() => validateSettings({ retryRateLimited: 'true' }), /true or false/);
});
