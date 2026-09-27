import { createContentMatcher } from './content.js';

export const DEFAULT_SETTINGS = Object.freeze({
  checkPresence: '',
  checkAbsence: '',
  maxPages: 0,
  runOnce: false,
  crawlDepth: 1,
  unlimitedDepth: true,
  testExternalUrls: false,
  discoverSitemaps: true,
  crawlResources: false,
  retryRateLimited: false,
  acceptedHosts: '',
  ignorePrefixes: '',
  timeoutSeconds: 10,
  requestsPerMinute: 0,
  useBrowserCookies: false,
  username: '',
  password: '',
  headers: 'X-Scanned-By: LinkSlope',
});

export const CRAWL_LIMITS = Object.freeze({ maxHtmlBytes: 2_000_000 });

/**
 * Compile line-based host/path, path-segment, and anchored regex exclusions.
 * @param {string} [value=''] User-entered exclusion rules.
 * @returns {((url: string) => boolean) & {hasRules: boolean}} Predicate for absolute URLs.
 * @throws {Error} A rule cannot be parsed; the message identifies its line.
 */
export function createIgnoreMatcher(value = '') {
  if (typeof value !== 'string') throw new Error('Ignore prefixes must be text.');
  const rules = value.split(/\r?\n/).flatMap((line, index) => {
    const entry = line.trim();
    if (!entry) return [];
    // Explicit regex syntax avoids interpreting dots and query strings in plain prefixes.
    if (entry.startsWith('regex:') || entry.includes('\\') || entry.startsWith('^')) {
      const pattern = entry.startsWith('regex:') ? entry.slice(6).trim() : entry;
      if (!pattern) throw new Error(`Ignore prefixes on line ${index + 1}: enter a regex pattern after regex:.`);
      try {
        const regex = new RegExp(`^(?:${pattern})`);
        return [url => regex.test(url.host + url.pathname + url.search)];
      } catch { throw new Error(`Invalid ignore-prefix regex on line ${index + 1}. Check the pattern.`); }
    }
    if (entry.startsWith('/')) return [url => {
      const path = url.pathname + url.search;
      // Path-only rules apply at every segment, e.g. /logout matches /user/logout.
      for (let offset = 0; offset < url.pathname.length; offset++) {
        if (url.pathname[offset] === '/' && path.startsWith(entry, offset)) return true;
      }
      return false;
    }];
    let prefix;
    try {
      prefix = new URL(/^https?:\/\//i.test(entry) ? entry : `https://${entry}`);
      if (!['http:', 'https:'].includes(prefix.protocol) || prefix.username || prefix.password || prefix.hash) throw new Error();
    } catch { throw new Error(`Invalid ignore prefix on line ${index + 1}. Use a host/path, /path, or regex: pattern.`); }
    return [url => url.host === prefix.host && (url.pathname + url.search).startsWith(prefix.pathname + prefix.search)];
  });
  const matches = url => rules.length > 0 && rules.some(rule => rule(new URL(url)));
  matches.hasRules = rules.length > 0;
  return matches;
}

/**
 * Parse custom headers and reject browser-controlled names and malformed values.
 * Repeated names are combined by Headers; a blank string disables all custom headers.
 * @param {string} [value=''] One Header-Name: value per line.
 * @returns {Headers}
 * @throws {Error} Invalid or unsupported header input.
 */
export function parseHeaders(value = '') {
  if (typeof value !== 'string') throw new Error('Custom headers must be text.');
  const headers = new Headers();
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).trim();
    const content = line.slice(colon + 1).trim();
    if (colon < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[^\t\x20-\x7e\x80-\xff]/.test(content)) {
      throw new Error(`Invalid custom header on line ${index + 1}. Use Header-Name: value.`);
    }
    // These headers are controlled by the browser, not by Fetch callers.
    if (/^cookie2?$/i.test(name)) {
      throw new Error(`Cookie headers are controlled by the browser. Enable Use browser cookies in Settings to use your existing login.`);
    }
    if (/^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|permissions-policy|user-agent)$/i.test(name) || /^(proxy-|sec-)/i.test(name)) {
      throw new Error(`Custom header on line ${index + 1} is controlled by the browser.`);
    }
    headers.append(name, content);
  }
  return headers;
}

/**
 * Create fresh headers per URL, restricting Authorization to the starting origin.
 * Other custom headers remain global; callers must not place secrets in them.
 * @param {object} settings Validated settings, including optional Basic credentials.
 * @param {string} start Absolute scan origin URL.
 * @returns {(url: string) => Headers} Headers for an individual request/redirect hop.
 */
export function createRequestHeaders(settings, start) {
  const configured = parseHeaders(settings.headers);
  if (settings.username || settings.password) {
    const bytes = new TextEncoder().encode(`${settings.username}:${settings.password}`);
    const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
    configured.set('Authorization', `Basic ${encoded}`);
  }
  const origin = new URL(start).origin;
  return url => {
    const headers = new Headers(configured);
    // Accepted hosts expand crawling, not the scope of credentials.
    if (new URL(url).origin !== origin) headers.delete('Authorization');
    return headers;
  };
}

/**
 * Normalize and deduplicate exact hostnames; URLs, ports and wildcards are invalid.
 * @param {string} [value=''] Comma- or whitespace-separated hostnames.
 * @returns {string[]}
 * @throws {Error} An entry is not a supported hostname.
 */
export function parseAcceptedHosts(value = '') {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean).map(entry => {
    // Hostnames only: reject URLs, paths, ports, credentials and wildcards.
    if (/[:\/?#@*\\]/.test(entry)) throw new Error(`Invalid accepted host: ${entry}. Enter hostnames only.`);
    let hostname;
    try { hostname = new URL(`https://${entry}`).hostname; }
    catch { throw new Error(`Invalid accepted host: ${entry}. Enter hostnames only.`); }
    if (!/^[a-z0-9.-]+$/i.test(hostname) || hostname.split('.').some(label => !label || label.startsWith('-') || label.endsWith('-'))) {
      throw new Error(`Invalid accepted host: ${entry}. Enter hostnames only.`);
    }
    return hostname;
  }))];
}

/**
 * Validate all fields without mutating input or including credential values in errors.
 * @param {object} [values={}] Partial settings; numeric form fields may be strings.
 * @returns {Object<string, string>} Field-keyed errors for accessible inline feedback.
 */
export function getSettingsErrors(values = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...values };
  const errors = {};
  for (const [key, label] of [['checkPresence', 'Check presence'], ['checkAbsence', 'Check absence']]) {
    try { createContentMatcher(settings[key], label); }
    catch (error) { errors[key] = error.message; }
  }
  for (const [key, label, minimum, maximum] of [
    ['maxPages', 'Page limit', 0, Number.MAX_SAFE_INTEGER],
    ['crawlDepth', 'Crawl depth', 0, Number.MAX_SAFE_INTEGER],
    ['timeoutSeconds', 'Timeout', 1, 2147483],
    ['requestsPerMinute', 'Requests per minute', 0, Number.MAX_SAFE_INTEGER],
  ]) {
    const value = settings[key];
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) {
      errors[key] = Number.isFinite(Number(value)) && Number(value) > maximum
        ? `${label} is too large. Enter a smaller whole number.`
        : `${label} must be a whole number greater than or equal to ${minimum}.`;
    }
  }
  if (typeof settings.retryRateLimited !== 'boolean') errors.retryRateLimited = 'Retry rate-limited requests must be true or false.';
  if (typeof settings.crawlResources !== 'boolean') errors.crawlResources = 'Crawl resources must be true or false.';
  if (typeof settings.discoverSitemaps !== 'boolean') errors.discoverSitemaps = 'Sitemap discovery must be true or false.';
  if (typeof settings.testExternalUrls !== 'boolean') errors.testExternalUrls = 'Test external URLs must be true or false.';
  if (typeof settings.runOnce !== 'boolean') errors.runOnce = 'Run once must be true or false.';
  if (typeof settings.unlimitedDepth !== 'boolean') errors.unlimitedDepth = 'Unlimited crawl depth must be true or false.';
  if (typeof settings.useBrowserCookies !== 'boolean') errors.useBrowserCookies = 'Use browser cookies must be true or false.';
  try { parseAcceptedHosts(settings.acceptedHosts); }
  catch (error) { errors.acceptedHosts = error.message; }
  try { createIgnoreMatcher(settings.ignorePrefixes); }
  catch (error) { errors.ignorePrefixes = error.message; }
  for (const key of ['username', 'password']) {
    if (typeof settings[key] !== 'string') errors[key] = 'Username and password must be text.';
  }
  if (typeof settings.username === 'string' && (settings.username.includes(':') || /[\x00-\x1f\x7f]/.test(settings.username))) {
    errors.username = 'Basic authentication cannot contain control characters or a colon in the username.';
  }
  if (typeof settings.password === 'string' && /[\x00-\x1f\x7f]/.test(settings.password)) {
    errors.password = 'Basic authentication cannot contain control characters.';
  }
  try {
    const headers = parseHeaders(settings.headers);
    if ((settings.username || settings.password) && headers.has('Authorization')) {
      errors.headers = 'Use either Basic authentication or a custom Authorization header, not both.';
    }
  } catch (error) { errors.headers = error.message; }
  return errors;
}

/**
 * Merge defaults, validate, and coerce numeric fields into a fresh settings object.
 * @param {object} [values={}] Partial settings or current form values.
 * @returns {typeof DEFAULT_SETTINGS} Validated settings.
 * @throws {Error} The first validation error; use getSettingsErrors for all errors.
 */
export function validateSettings(values = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...values };
  const errors = getSettingsErrors(settings);
  if (Object.keys(errors).length) throw new Error(Object.values(errors)[0]);
  for (const key of ['maxPages', 'crawlDepth', 'timeoutSeconds', 'requestsPerMinute']) settings[key] = Number(settings[key]);
  return settings;
}
