import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourcePreview } from '../src/sources.js';
import { createReport, reportCsv, reportFile } from '../src/reportExport.js';

for (const count of [0, 1, 10, 11, 25]) {
  test(`source references preserve totals and limit display/export at ${count} sources`, () => {
    const sources = Array.from({ length: count }, (_, i) => `https://example.test/source-${i + 1}`);
    const preview = sourcePreview(sources);
    assert.equal(preview.sources.length, Math.min(count, 10));
    assert.equal(preview.more, Math.max(0, count - 10));
    assert.equal(preview.summary, count > 10 ? `… ${count - 10} more ${count === 11 ? 'source' : 'sources'}` : '');
    const data = { records: [{ url: 'https://example.test/target', outcome: 'Working', sources }], checked: 1, pages: 1 };
    const report = createReport(data, { website: 'https://example.test/', status: 'complete' });
    const row = JSON.parse(reportFile(report, 'json').content).records[0];
    assert.deepEqual(row.sources, sources.slice(0, 10));
    assert.equal(row.sourceCount, count);
    assert.equal(row.sourcesSummary, preview.summary || undefined);
    const csv = reportCsv(report);
    if (count > 10) {
      assert.ok(csv.includes(preview.summary));
      assert.ok(!csv.includes('source-11'));
      assert.equal(csv.split(preview.summary).length, 2);
    } else assert.ok(!csv.includes('more source'));
    assert.equal(sources.length, count, 'UI/export truncation must not mutate crawl results');
    assert.deepEqual(sourcePreview(row.sources, row.sourceCount), preview);
  });
}
