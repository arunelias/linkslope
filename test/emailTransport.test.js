import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailtrapHeaderRule, prepareMailtrapTransport } from '../src/emailTransport.js';
import { sendEmailReport } from '../src/emailReport.js';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

test('Mailtrap Origin rule is limited to extension mail POSTs on exact API routes', () => {
  const rule = mailtrapHeaderRule(extensionId);
  assert.deepEqual(rule.condition.initiatorDomains, [extensionId]);
  assert.deepEqual(rule.condition.requestMethods, ['post']);
  assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest']);
  assert.deepEqual(rule.action.requestHeaders, [{ header: 'origin', operation: 'remove' }]);
  const matches = new RegExp(rule.condition.regexFilter);
  for (const url of ['https://sandbox.api.mailtrap.io/api/send/2894320', 'https://send.api.mailtrap.io/api/send', 'https://bulk.api.mailtrap.io/api/send/']) assert.ok(matches.test(url));
  for (const url of ['https://example.com/api/send', 'https://sandbox.api.mailtrap.io.evil.test/api/send/2894320', 'http://sandbox.api.mailtrap.io/api/send/2894320', 'https://sandbox.api.mailtrap.io/api/send/0', 'https://sandbox.api.mailtrap.io/api/send/1/extra', 'https://sandbox.api.mailtrap.io/api/send/1?secret=x', 'https://send.api.mailtrap.io/api/batch']) assert.equal(matches.test(url), false);
});

test('transport installs an idempotent session rule and reports missing permission', async () => {
  const updates = [];
  const api = { runtime: { id: extensionId }, declarativeNetRequest: { async updateSessionRules(update) { updates.push(update); } } };
  await prepareMailtrapTransport(api);
  await prepareMailtrapTransport(api);
  assert.deepEqual(updates[0], updates[1]);
  assert.deepEqual(updates[0].removeRuleIds, [updates[0].addRules[0].id]);
  await assert.rejects(prepareMailtrapTransport({ runtime: { id: extensionId } }), /Reload LinkSlope/);
  await assert.rejects(prepareMailtrapTransport({ ...api, declarativeNetRequest: { updateSessionRules() { throw new Error('Denied'); } } }), /Could not enable/);
  await prepareMailtrapTransport({});
});

test('Mailtrap waits for the rule before sending; setup failure sends nothing', async t => {
  const previous = globalThis.chrome;
  t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; });
  const calls = [];
  globalThis.chrome = { runtime: { id: extensionId }, declarativeNetRequest: { async updateSessionRules() { calls.push('rule'); } } };
  const settings = { recipient: 'reader@example.test', sender: 'sender@example.test', endpoint: 'https://sandbox.api.mailtrap.io/api/send/2894320' };
  const report = { website: 'https://example.test/', status: 'complete', summary: {} };
  const fetcher = async () => { calls.push('fetch'); return new Response(null, { status: 200 }); };
  await sendEmailReport(settings, report, 'test-token', fetcher);
  assert.deepEqual(calls, ['rule', 'fetch']);
  delete globalThis.chrome.declarativeNetRequest;
  await assert.rejects(sendEmailReport(settings, report, 'test-token', fetcher), /Reload LinkSlope/);
  assert.deepEqual(calls, ['rule', 'fetch']);
  await sendEmailReport({ ...settings, endpoint: 'https://custom.example.test/send' }, report, 'test-token', fetcher);
  assert.deepEqual(calls, ['rule', 'fetch', 'fetch']);
});
