import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanProgress } from '../src/progress.js';

test('completed scans include skipped links in progress without counting them twice', () => {
  const records = [
    ...Array.from({ length: 3 }, () => ({ outcome: 'Working', checkedOnce: true })),
    ...Array.from({ length: 7 }, () => ({ outcome: 'Skipped' })),
  ];
  assert.deepEqual(scanProgress(records), { completed: 10, skipped: 7, pending: 0, percent: 100 });
  records[3].checkedOnce = true; // A requested URL can also be skipped on redirect.
  assert.equal(scanProgress(records).percent, 100);
  assert.equal(scanProgress([{ outcome: 'Skipped' }]).percent, 100);
});

test('pending and cancelled work does not report completion', () => {
  assert.equal(scanProgress([]).percent, 0);
  assert.deepEqual(scanProgress([
    { outcome: 'Working' }, { outcome: 'Skipped' },
    { outcome: 'Pending' }, { outcome: 'Checking' }, { outcome: 'Cancelled', checkedOnce: true },
  ]), { completed: 2, skipped: 1, pending: 2, percent: 40 });
  const records = Array.from({ length: 500 }, () => ({ outcome: 'Working' }));
  records.push({ outcome: 'Checking' });
  assert.equal(scanProgress(records).percent, 99);
});

test('finished checks count as complete regardless of HTTP outcome', () => {
  const records = ['Working', 'Broken', 'Server error', 'Restricted', 'Rate limited', 'Unverified']
    .map(outcome => ({ outcome }));
  assert.equal(scanProgress(records).percent, 100);
});
