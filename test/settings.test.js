import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, validateSettings, getSettingsErrors, parseHeaders, createRequestHeaders, createIgnoreMatcher } from '../src/settings.js';

test('ignore prefixes support literal hosts and paths without treating dots or queries as regex', () => {
  assert.equal(validateSettings().ignorePrefixes, '');
  assert.equal(createIgnoreMatcher(' \n').hasRules, false);
  const ignored = createIgnoreMatcher('EXAMPLE.test/logout\n/SignOut\nhttps://other.test/ignore/\nexample.test/action?do=logout');
  for (const url of ['https://example.test/logout?next=home', 'http://example.test/logout/child', 'https://other.test/ignore/child', 'https://any.test/SignOut', 'https://example.test/action?do=logout']) assert.equal(ignored(url), true, url);
  for (const url of ['https://example.test.evil.test/logout', 'https://other.test/ignore', 'https://any.test/signout', 'https://exampleXtest/logout', 'https://example.test/action?do=login']) assert.equal(ignored(url), false, url);
});

test('ignore regex patterns are anchored to host/path and validated with line feedback', () => {
  const ignored = createIgnoreMatcher('regex: example\\.test/(logout|signout)(?:[/?]|$)\nwww\\.example.com/ignore_this_and_after/');
  assert.equal(ignored('https://example.test/logout?now=1'), true);
  assert.equal(ignored('https://www.example.com/ignore_this_and_after/child'), true);
  assert.equal(ignored('https://example.test/logout-other'), false);
  assert.equal(ignored('https://evil.test/example.test/logout'), false);
  assert.match(getSettingsErrors({ ignorePrefixes: '/logout\nregex: [' }).ignorePrefixes, /line 2/);
  assert.throws(() => validateSettings({ ignorePrefixes: 'regex:' }), /enter a regex/);
  assert.throws(() => validateSettings({ ignorePrefixes: null }), /Ignore prefixes/);
});

test('path-only ignore prefixes match nested path segments without matching queries or partial segments', () => {
  const ignored = createIgnoreMatcher('/logout');
  for (const path of ['/logout', '/user/logout?token=test-token', '/account/user/logout/confirm']) {
    assert.equal(ignored('https://example.test' + path), true, path);
  }
  for (const path of ['/user/mylogout', '/user/profile?next=/logout', '/user/Logout']) {
    assert.equal(ignored('https://example.test' + path), false, path);
  }
  assert.equal(createIgnoreMatcher('example.test/logout')('https://example.test/user/logout'), false);
});

test('field validation reports all invalid settings without exposing credentials', () => {
  const values = { timeoutSeconds: '', requestsPerMinute: -1, crawlDepth: 1.5, acceptedHosts: '*.example.test', username: 'secret:user', password: 'secret\npassword', headers: 'X-Secret: secret\rvalue' };
  const errors = getSettingsErrors(values);
  assert.deepEqual(Object.keys(errors).sort(), ['acceptedHosts', 'crawlDepth', 'headers', 'password', 'requestsPerMinute', 'timeoutSeconds', 'username']);
  assert.ok(!JSON.stringify(errors).includes('secret'));
  assert.throws(() => validateSettings(values), { message: errors.crawlDepth });
  assert.deepEqual(getSettingsErrors(), {});
});

test('field validation removes corrected errors and identifies authorization conflicts', () => {
  assert.ok(getSettingsErrors({ timeoutSeconds: 0, headers: 'bad' }).timeoutSeconds);
  const corrected = getSettingsErrors({ timeoutSeconds: 10, headers: 'bad' });
  assert.equal(corrected.timeoutSeconds, undefined);
  assert.ok(corrected.headers);
  assert.deepEqual(getSettingsErrors({ timeoutSeconds: 10, headers: 'X-Valid: yes' }), {});
  assert.match(getSettingsErrors({ username: 'user', headers: 'Authorization: Bearer secret' }).headers, /either Basic authentication/);
});

test('crawl settings default to unlimited pages and depth with run once off, and reject invalid values', () => {
  assert.equal(validateSettings().runOnce, false);
  assert.equal(validateSettings().maxPages, 0);
  assert.equal(validateSettings().unlimitedDepth, true);
  assert.equal(validateSettings().crawlDepth, 1);
  assert.equal(validateSettings({ crawlDepth: '0' }).crawlDepth, 0);
  assert.equal(validateSettings({ runOnce: true }).runOnce, true);
  for (const value of ['', ' ', -1, 1.5, Infinity, NaN, null, false, 'abc']) {
    assert.throws(() => validateSettings({ crawlDepth: value }), /Crawl depth/);
  }
  for (const value of ['false', 0, null]) {
    assert.throws(() => validateSettings({ runOnce: value }), /Run once/);
  }
});

test('settings default to ten seconds and unlimited requests', () => {
  assert.deepEqual(validateSettings(), DEFAULT_SETTINGS);
  assert.equal(validateSettings().timeoutSeconds, 10);
  assert.equal(validateSettings().requestsPerMinute, 0);
  assert.equal(validateSettings({ requestsPerMinute: '30' }).requestsPerMinute, 30);
});

test('invalid request settings are rejected before scanning', () => {
  for (const value of ['', ' ', -1, 1.5, Infinity, NaN, null, false, 'abc']) {
    assert.throws(() => validateSettings({ timeoutSeconds: value }), /Timeout/);
    assert.throws(() => validateSettings({ requestsPerMinute: value }), /Requests per minute/);
  }
  assert.throws(() => validateSettings({ timeoutSeconds: 0 }), /Timeout/);
  assert.throws(() => validateSettings({ timeoutSeconds: 2147484 }), /Timeout/);
});


test('authentication is disabled by default and scanner identification is included', () => {
  const settings = validateSettings();
  assert.equal(settings.username, '');
  assert.equal(settings.password, '');
  assert.equal(settings.useBrowserCookies, false);
  const headers = createRequestHeaders(settings, 'https://example.test/')('https://example.test/page');
  assert.equal(headers.get('Authorization'), null);
  assert.equal(headers.get('X-Scanned-By'), 'LinkSlope');
});

test('browser cookie settings are validated and manual Cookie headers give actionable feedback', () => {
  assert.equal(validateSettings({ useBrowserCookies: true }).useBrowserCookies, true);
  for (const value of ['true', 1, null]) assert.throws(() => validateSettings({ useBrowserCookies: value }), /Use browser cookies/);
  assert.match(getSettingsErrors({ headers: 'Cookie: session=secret' }).headers, /Enable Use browser cookies/);
  assert.ok(!getSettingsErrors({ headers: 'Cookie: session=secret' }).headers.includes('secret'));
});

test('custom headers support multiple lines, CRLF, colons in values, and clearing', () => {
  const headers = parseHeaders('X-One: first\r\n\r\nX-Two: https://example.test:443/\nX-One: second');
  assert.equal(headers.get('x-one'), 'first, second');
  assert.equal(headers.get('x-two'), 'https://example.test:443/');
  assert.deepEqual([...parseHeaders('')], []);
});

test('malformed and browser-controlled headers fail without exposing values', () => {
  for (const value of ['missing colon', ': secret', 'Bad Name: secret', 'X-Test: bad\rvalue', 'X-Test: \u0000', 'X-Test: 😀', 'Host: secret', 'Cookie: secret', 'Sec-Fetch-Site: secret']) {
    assert.throws(() => validateSettings({ headers: value }), error => {
      assert.match(error.message, /header/i);
      assert.ok(!error.message.includes('secret'));
      return true;
    });
  }
});

test('Basic credentials use UTF-8 and preserve spaces and password colons', () => {
  const settings = validateSettings({ username: 'üser ', password: 'päss: word' });
  const headers = createRequestHeaders(settings, 'https://example.test/')('https://example.test/page');
  assert.equal(headers.get('Authorization'), 'Basic ' + Buffer.from('üser :päss: word').toString('base64'));
  for (const credentials of [{ username: 'user', password: '' }, { username: '', password: 'pass' }]) {
    const get = createRequestHeaders(validateSettings(credentials), 'https://example.test/');
    assert.equal(get('https://example.test/').get('Authorization'), 'Basic ' + Buffer.from(credentials.username + ':' + credentials.password).toString('base64'));
  }
});

test('Authorization is scoped to the starting origin for Basic and custom headers', () => {
  for (const options of [{ username: 'user', password: 'pass' }, { headers: 'Authorization: Bearer secret\nX-One: public' }]) {
    const get = createRequestHeaders(validateSettings(options), 'https://example.test/');
    assert.ok(get('https://example.test/page').has('Authorization'));
    for (const url of ['http://example.test/', 'https://example.test:444/', 'https://sub.example.test/', 'https://other.test/']) {
      assert.equal(get(url).has('Authorization'), false);
    }
    assert.ok(get('https://example.test/again').has('Authorization'));
  }
});

test('invalid Basic credentials and conflicting authorization are rejected', () => {
  for (const options of [{ username: 'user:name' }, { password: 'bad\nvalue' }, { username: null }, { password: false }, { username: 'user', headers: 'authorization: Bearer secret' }]) {
    assert.throws(() => validateSettings(options));
  }
});

test('content settings reject malformed regex before requesting pages', () => {
  assert.equal(validateSettings().checkPresence, '');
  assert.equal(validateSettings().checkAbsence, '');
  for (const key of ['checkPresence', 'checkAbsence']) {
    for (const value of ['regex:[', 'regex:', null, 123]) assert.ok(getSettingsErrors({ [key]: value })[key]);
  }
});

test('resource crawling defaults to off and validates its toggle', () => {
  assert.equal(validateSettings().crawlResources, false);
  assert.equal(validateSettings({ crawlResources: true }).crawlResources, true);
  for (const value of ['false', null, 0]) assert.throws(() => validateSettings({ crawlResources: value }), /Crawl resources/);
});
