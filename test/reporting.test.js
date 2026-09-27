import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReport, reportCsv, reportFile, formatCsvSeconds, formatCsvLocalTime } from '../src/reportExport.js';
import { createEmailSummary, emailPayload, loadEmailSettings, saveEmailSettings, validateEmailSettings, shouldAutoSend, sendEmailReport } from '../src/emailReport.js';

const settings = { sender: '', recipient: 'reader@example.test', endpoint: 'https://mail.example.test/send', autoSend: true };
const report = () => createReport({ checked: 1, pages: 1, records: [{ url: 'https://example.test/', outcome: 'Working', sources: ['https://example.test/source'], detail: '=FORMULA("x")', contentChecks: [{ label: 'Presence', outcome: 'Failed' }], sourceExcerpts: [{ html: 'private markup' }] }] }, { website: 'https://example.test/', status: 'complete', startedAt: '2026-09-24T00:00:00Z', finishedAt: '2026-09-24T00:01:00Z' });

test('report exports all records, metadata and content failures without source markup', () => {
  const result = report();
  assert.equal(result.summary.issues, 1);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].sourceExcerpts, undefined);
  assert.deepEqual(JSON.parse(reportFile(result, 'json').content), result);
  const csv = reportCsv(result);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=FORMULA(""x"")"'));
  assert.ok(csv.includes('https://example.test/source'));
  assert.throws(() => reportFile(result, 'html'));
});

test('email preferences persist with an explicit allowlist and safe defaults', () => {
  let value;
  const storage = { getItem: () => value, setItem: (key, next) => { value = next; } };
  assert.equal(loadEmailSettings(storage).autoSend, false);
  saveEmailSettings({ ...settings, token: 'secret', password: 'secret' }, storage);
  assert.deepEqual(loadEmailSettings(storage), settings);
  assert.ok(!value.includes('secret'));
  value = '{"autoSend":"false","recipient":4}';
  assert.equal(loadEmailSettings(storage).autoSend, false);
  assert.equal(loadEmailSettings(storage).recipient, '');
  assert.throws(() => saveEmailSettings(settings, { setItem() { throw new Error('full'); } }));
});

test('automatic email only runs for completed or limited scans', () => {
  for (const status of ['running', 'stopped', 'failed']) assert.equal(shouldAutoSend(settings, status), false);
  for (const status of ['complete', 'limited']) assert.equal(shouldAutoSend(settings, status), true);
  assert.equal(shouldAutoSend({ ...settings, autoSend: false }, 'complete'), false);
});

test('email validates recipients and rejects unsafe endpoints', () => {
  for (const endpoint of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/#secret', 'invalid']) assert.throws(() => validateEmailSettings({ ...settings, endpoint }));
  for (const recipient of ['', 'a@example.test,b@example.test', 'a\nb@example.test']) assert.throws(() => validateEmailSettings({ ...settings, recipient }));
});

test('custom endpoint receives only a compact summary without cookies or redirects', async () => {
  let calls = 0;
  await sendEmailReport(settings, report(), 'session-token', async (url, options) => {
    calls++;
    assert.equal(url, settings.endpoint);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer session-token');
    const body = JSON.parse(options.body);
    assert.equal(body.to, settings.recipient);
    assert.equal(body.report.records, undefined);
    assert.equal(body.attachment, undefined);
    assert.equal(body.report.summary.issues, 1);
    assert.match(body.text, /Issues: 1/);
    return new Response(null, { status: 202 });
  });
  assert.equal(calls, 1);
});

test('delivery errors are surfaced without automatic retries', async () => {
  let calls = 0;
  await assert.rejects(sendEmailReport(settings, report(), '', async () => { calls++; throw new Error('timeout'); }), /could not be confirmed/);
  assert.equal(calls, 1);
  await assert.rejects(sendEmailReport(settings, report(), '', async () => new Response(null, { status: 401 })), /HTTP 401.*Authentication failed.*API token/);
});

test('Mailtrap uses sender and recipient objects and summary text only', async () => {
  const configured = { ...settings, endpoint: 'https://sandbox.api.mailtrap.io/api/send/2894320', sender: 'sender@example.test' };
  const result = await sendEmailReport(configured, report(), 'test-token', async (url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.from, { email: configured.sender, name: 'LinkSlope' });
    assert.deepEqual(body.to, [{ email: configured.recipient }]);
    assert.deepEqual(Object.keys(body).sort(), ['from', 'subject', 'text', 'to']);
    assert.match(body.text, /Links checked: 1/);
    assert.ok(!options.body.includes('/source'));
    assert.ok(!options.body.includes('FORMULA'));
    return new Response(null, { status: 200 });
  });
  assert.equal(result, 'Scan summary accepted by your email service for delivery.');
  await assert.rejects(sendEmailReport(configured, report(), '', () => { throw new Error('Must not fetch'); }), /API token/);
  assert.throws(() => validateEmailSettings({ ...configured, sender: '' }), /sender/);
  assert.throws(() => validateEmailSettings({ ...configured, endpoint: 'https://sandbox.api.mailtrap.io/api/send' }), /complete send endpoint/);
  await assert.rejects(sendEmailReport(configured, report(), 'test-token', async () => new Response(null, { status: 403 })), /HTTP 403.*Access denied/);
});

test('summary payload stays small for large sites and includes aggregate outcomes', () => {
  const records = Array.from({ length: 100000 }, (_, i) => ({ url: `https://example.test/private/${i}`, outcome: 'Broken', sources: ['https://example.test/source'] }));
  const compact = createEmailSummary({ records, pages: 40, checked: 100000 }, { website: 'https://example.test/', status: 'limited' });
  assert.equal(compact.summary.broken, 100000);
  assert.equal(compact.summary.issues, 100000);
  assert.equal(compact.partial, true);
  const payload = JSON.stringify(emailPayload(settings, compact));
  assert.ok(payload.length < 2000);
  assert.ok(!payload.includes('/private/'));
  assert.ok(!payload.includes('records'));
  assert.match(JSON.parse(payload).text, /partial results/);
});

test('old settings migrate with blank sender and production Mailtrap uses its API format', () => {
  const old = loadEmailSettings({ getItem: () => '{"recipient":"reader@example.test","autoSend":true}' });
  assert.equal(old.sender, '');
  const configured = { ...settings, endpoint: 'https://send.api.mailtrap.io/api/send', sender: 'sender@example.test' };
  assert.deepEqual(emailPayload(configured, report()).to, [{ email: settings.recipient }]);
  assert.equal(validateEmailSettings(configured, 'token').sender, configured.sender);
});

test('CSV seconds round on either side of the ten-second boundary and leave missing times blank', () => {
  for (const [ms, expected] of [[0, '0.00'], [582, '0.58'], [9994, '9.99'], [9999, '10.00'], [10000, '10'], [10500, '11'], [null, ''], [undefined, ''], [NaN, '']]) assert.equal(formatCsvSeconds(ms), expected);
});

test('CSV last tested converts UTC to the device timezone, including a date rollover', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Kolkata';
    assert.equal(formatCsvLocalTime('2026-09-24T23:30:45Z'), '2026-09-25 05:00:45');
    assert.equal(formatCsvLocalTime(''), '');
    assert.equal(formatCsvLocalTime('invalid'), '');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('CSV omits unused content column while keeping rows aligned and meaningful checks', () => {
  const base = { url: 'https://example.test/', outcome: 'Working', sources: [], timeMs: 582, testedAt: '' };
  const csv = reportCsv({ records: [base, { ...base, contentChecks: [{ outcome: 'Not checked' }] }] });
  const lines = csv.slice(1).split('\r\n');
  assert.ok(!lines[0].includes('Content checks'));
  assert.ok(lines[0].includes('"Time (s)"'));
  assert.ok(lines[0].includes('"Last tested (local time)"'));
  for (const line of lines) assert.equal(line.split('","').length, 8);
  assert.equal(lines[1].split('","')[4], '0.58');
  const mixed = reportCsv({ records: [base, { ...base, contentChecks: [{ outcome: 'Passed' }] }] });
  assert.ok(mixed.includes('"Content checks"'));
  assert.equal(mixed.split('\r\n')[1].split('","').length, 9);
  assert.ok(mixed.includes('Passed'));
});
