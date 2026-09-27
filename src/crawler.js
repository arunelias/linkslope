/**
 * @typedef {object} ScanRecord
 * @property {string} url Normalized target URL, without a fragment.
 * @property {string[]} sources Pages or discovery files referencing this target.
 * @property {string} outcome HTTP/request classification, independent of crawl coverage.
 * @property {number} [status] HTTP status; absent for unrequested/network-failed URLs.
 * @property {string} [finalUrl] Final response URL, potentially outside crawl scope.
 * @property {number} [timeMs] Time to response headers or to a failed request.
 * @property {string} [testedAt] ISO UTC timestamp of the last attempt.
 * @property {string} [detail] Request/skip explanation.
 * @property {'depth'|'pages'} [crawlLimit] Why HTML expansion was prevented.
 * @property {string} [crawlDetail] Human-readable crawl-limit explanation.
 * @property {Array<{label: string, outcome: string, detail: string}>} [contentChecks]
 * @property {Array<{source: string, pageUrl: string, html: string}>} [sourceExcerpts]
 * @property {boolean} [checkedOnce] Whether this URL contributed to checked totals.
 * @property {boolean} [resourceOnly] True until also discovered as an HTML link/page.
 * @property {'robots'|'sitemap'} [discoveryKind] Metadata parsing mode.
 * @property {number} [retries] Number of queued automatic retries after HTTP 429.
 * @property {boolean} [retryPending] A retry is still queued.
 */

/**
 * @typedef {object} ScanSnapshot
 * @property {ScanRecord[]} records All discovered URLs, including skipped entries.
 * @property {number} pages HTML pages admitted for crawling.
 * @property {number} checked Unique URLs attempted, not total HTTP attempts.
 * @property {number} queued Work remaining, including deferred retries.
 * @property {string} [waitingFor] Current cooldown status for the UI.
 * @property {{depth: number, pages: number}} [limits] Counts of limited pages.
 */

import { contentChecks, isTextResponse, readPageSource } from './content.js';
import { validateSettings, parseAcceptedHosts, createRequestHeaders, createIgnoreMatcher } from './settings.js';
import { parseDiscovery, readDiscoverySource } from './discovery.js';
import { fetchWithRedirects } from './redirects.js';
import { parseCrawlHtml } from './html.js';
import { resourceReferences } from './resources.js';
import { retryDelay } from './retry.js';

/**
 * Resolve an HTTP(S) URL, remove its fragment, and reject embedded credentials.
 * @param {string} value Absolute or relative URL.
 * @param {string} [base] Absolute base for relative URLs.
 * @returns {string|null} Canonical URL, or null for an unsupported/invalid input.
 */
export function normalize(value, base) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

/**
 * Classify HTTP status independently of content checks or crawl completeness.
 * @param {number} status HTTP response status; zero represents an opaque response.
 * @returns {string} Report outcome; only 404/410 are classified as broken.
 */
export function classify(status) {
  if (status >= 200 && status < 300) return 'Working';
  if (status === 404 || status === 410) return 'Broken';
  if (status === 401 || status === 403) return 'Restricted';
  if (status === 429) return 'Rate limited';
  if (status >= 500) return 'Server error';
  return 'Unverified';
}

function waitForRequest(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Crawl and check URLs serially, publishing snapshots after queue/request changes.
 * Settings are re-read between requests; edits never change an active request.
 * Stopping resolves with partial results; validation or callback failures reject.
 * @param {object} config Settings fields plus the scan controls below.
 * @param {string} config.start Normalized absolute HTTP(S) starting URL.
 * @param {AbortSignal} config.signal Cancels requests, pacing, cooldowns, and pause waits.
 * @param {(snapshot: ScanSnapshot) => void} config.onUpdate Receives the current full report.
 * @param {ReturnType<import('./pause.js').createPauseControl>} [config.pauseControl]
 * @param {() => object} [config.getSettings] Supplies settings for remaining work.
 * @param {Function} [config.observeRedirect] Creates a scoped redirect-header observer.
 * @returns {Promise<{limits: {depth: number, pages: number}}>} Final crawl-limit counts;
 * records are delivered through onUpdate, not the return value.
 */
export async function scan({ start, signal, onUpdate, pauseControl, getSettings, observeRedirect, ...options }) {
  const initialSettings = validateSettings(options);
  let lastRequestAt;
  const cooldowns = new Map();
  let waitingFor = ''; 
  const origin = new URL(start).origin;
  const queue = [start];
  // Breadth-first discovery gives each URL its shortest depth from the start.
  const depths = new Map([[start, 0]]);
  const records = new Map([[start, { url: start, sources: [], outcome: 'Pending' }]]);
  let discoverySeeded = false;
  let pages = 0;
  let checked = 0;
  const limits = () => ({ depth: [...records.values()].filter(r => r.crawlLimit === 'depth').length, pages: [...records.values()].filter(r => r.crawlLimit === 'pages').length });
  const publish = () => onUpdate({ records: [...records.values()].map(r => ({ ...r, sources: [...r.sources], sourceExcerpts: [...(r.sourceExcerpts || [])] })), pages, checked, queued: queue.length, waitingFor, limits: limits() });
  publish();
  while (queue.length && !signal.aborted) {
    // Give browser click events a turn even when responses arrive immediately.
    await waitForRequest(0, signal);
    await pauseControl?.wait(signal);
    if (signal.aborted) break;
    let settings;
    // Recalculate pacing after resume so edited request limits apply immediately.
    while (!signal.aborted) {
      await pauseControl?.wait(signal);
      if (signal.aborted) break;
      settings = validateSettings(getSettings ? getSettings() : initialSettings);
      const interval = settings.requestsPerMinute === 0 ? 0 : 60000 / settings.requestsPerMinute;
      const remaining = lastRequestAt === undefined ? 0 : interval - (performance.now() - lastRequestAt);
      if (remaining <= 0) break;
      await waitForRequest(remaining, signal);
    }
    if (signal.aborted) break;
    // Keep this snapshot for the whole active request, even if paused and edited.
    const { maxPages, testExternalUrls, acceptedHosts, timeoutSeconds } = settings;
    const maxDepth = settings.runOnce ? 0 : settings.unlimitedDepth ? Infinity : settings.crawlDepth;
    const requestHeaders = createRequestHeaders(settings, start);
    const ignored = createIgnoreMatcher(settings.ignorePrefixes);
    const hosts = new Set(parseAcceptedHosts(acceptedHosts));
    const canCrawl = value => {
      const url = new URL(value);
      return url.origin === origin || hosts.has(url.hostname);
    };
    const discover = settings.discoverSitemaps && !settings.runOnce;
    function addDiscovered(target, sourceUrl, kind, depth) {
      const skipReason = ignored(target) ? 'Excluded by ignore prefixes.' : !testExternalUrls && !canCrawl(target) ? 'External URL checks are disabled.' : null;
      if (!records.has(target)) {
        records.set(target, { url: target, sources: [], outcome: skipReason ? 'Skipped' : 'Pending', ...(kind && { discoveryKind: kind }), ...(skipReason && { detail: skipReason }) });
        depths.set(target, depth);
        if (!skipReason) queue.push(target);
      }
      const found = records.get(target);
      if (!kind) found.resourceOnly = false;
      if (!found.sources.includes(sourceUrl)) found.sources.push(sourceUrl);
    }
    if (discover && !discoverySeeded && !ignored(start)) {
      discoverySeeded = true;
      addDiscovered(new URL('/robots.txt', start).href, start, 'robots', 0);
      addDiscovered(new URL('/sitemap.xml', start).href, start, 'sitemap', 0);
    }
    if (!settings.retryRateLimited) {
      cooldowns.clear();
      for (let i = queue.length - 1; i >= 0; i--) {
        const item = records.get(queue[i]);
        if (item.retryPending) {
          item.retryPending = false;
          item.outcome = 'Rate limited';
          item.detail = 'Automatic retries disabled; the last response was HTTP 429.';
          queue.splice(i, 1);
        }
      }
      if (!queue.length) { waitingFor = ''; publish(); break; }
    }
    const available = queue.findIndex(value => (cooldowns.get(new URL(value).hostname) || 0) <= performance.now());
    if (available < 0) {
      const remaining = queue.reduce((minimum, value) => Math.min(minimum, cooldowns.get(new URL(value).hostname) - performance.now()), Infinity);
      waitingFor = 'Waiting before retry: rate-limited hosts are cooling down (' + Math.ceil(remaining / 1000) + ' seconds).';
      publish();
      await waitForRequest(Math.min(remaining, 1000), signal);
      continue;
    }
    waitingFor = '';
    const [url] = queue.splice(available, 1);
    const record = records.get(url);
    if (record.resourceOnly && !settings.crawlResources) {
      record.outcome = 'Skipped';
      record.detail = 'Resource crawling is disabled.';
      publish();
      continue;
    }
    if (record.discoveryKind && !discover) {
      record.outcome = 'Skipped';
      record.detail = 'Sitemap discovery is disabled.';
      publish();
      continue;
    }
    if (ignored(url)) {
      record.outcome = 'Skipped';
      record.detail = 'Excluded by ignore prefixes.';
      publish();
      continue;
    }
    if (url !== start && !testExternalUrls && !canCrawl(url)) {
      record.outcome = 'Skipped';
      record.detail = 'Excluded by updated crawl scope.';
      publish();
      continue;
    }
    record.contentChecks = record.discoveryKind ? [] : contentChecks(settings);
    record.outcome = 'Checking';
    record.retryPending = false;
    delete record.detail;
    delete record.timeMs;
    delete record.status;
    publish();
    if (signal.aborted) { record.outcome = 'Cancelled'; break; }
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutSeconds * 1000);
    try {
      lastRequestAt = performance.now();
      const response = await fetchWithRedirects({ url, headersForUrl: requestHeaders, signal: controller.signal, credentials: settings.useBrowserCookies ? 'include' : 'omit', ignored, observeRedirect });
      controller.signal.throwIfAborted();
      record.timeMs = performance.now() - lastRequestAt;
      record.status = response.status || undefined;
      record.finalUrl = response.url;
      record.outcome = classify(response.status);
      if (response.status === 429 && settings.retryRateLimited) {
        const delay = retryDelay(response.headers.get('retry-after'), record.retries || 0);
        const until = performance.now() + delay;
        for (const host of [new URL(url).hostname, new URL(response.url || url).hostname]) {
          cooldowns.set(host, Math.max(cooldowns.get(host) || 0, until));
        }
        await response.body?.cancel();
        if ((record.retries || 0) < 3) {
          record.retries = (record.retries || 0) + 1;
          record.retryPending = true;
          record.outcome = 'Pending';
          record.detail = 'Waiting before retry ' + record.retries + ' of 3 after HTTP 429.';
          queue.push(url);
        } else record.detail = 'Still rate limited after 3 automatic retries.';
        continue;
      }
      if (record.discoveryKind) {
        if (!response.ok) {
          await response.body?.cancel();
          if ([404, 410].includes(response.status)) {
            record.outcome = 'Skipped';
            record.detail = 'Optional discovery file is not available; HTML crawling continues.';
          }
        } else {
          const source = await readDiscoverySource(response, controller.signal);
          const entries = parseDiscovery(source, record.discoveryKind);
          for (const entry of entries) {
            const target = normalize(entry.value, response.url || url);
            if (target) addDiscovered(target, url, entry.kind, 1);
          }
          record.detail = 'URL discovery file processed.';
        }
      } else {
        const html = response.headers.get('content-type')?.includes('text/html');
        const crawlable = !record.resourceOnly && response.ok && html && canCrawl(response.url);
        const withinPages = maxPages === 0 || pages < maxPages;
        const withinDepth = depths.get(url) <= maxDepth;
        if (crawlable && (!withinDepth || !withinPages)) {
          record.crawlLimit = !withinDepth ? 'depth' : 'pages';
          record.crawlDetail = !withinDepth
            ? `Link checked, but page not crawled: depth ${depths.get(url)} exceeds the maximum depth ${maxDepth}.`
            : `Link checked, but page not crawled: the page limit of ${maxPages} was reached.`;
        }
        const shouldCrawl = crawlable && withinPages && withinDepth;
        const shouldCheck = record.contentChecks.length > 0 && isTextResponse(response);
        if (shouldCrawl) pages++;
        let source;
        if (shouldCrawl || shouldCheck) source = await readPageSource(response, controller.signal);
        else await response.body?.cancel();
        record.contentChecks = contentChecks(settings, shouldCheck ? source : undefined, 'Response is not HTML or text.');
        if (shouldCrawl) {
          const doc = parseCrawlHtml(source);
          const base = normalize(doc.querySelector('base[href]')?.getAttribute('href'), response.url) || response.url;
          const references = Array.from(doc.querySelectorAll('a[href]'), element => ({ element, value: element.getAttribute('href'), resource: false }));
          if (settings.crawlResources) references.push(...resourceReferences(doc));
          for (const { element: anchor, value, resource } of references) {
            const target = normalize(value, base);
            if (!target) continue;
            const skipReason = ignored(target) ? 'Excluded by ignore prefixes.' : !testExternalUrls && !canCrawl(target) ? 'External URL checks are disabled.' : null;
            if (!records.has(target)) {
              records.set(target, { url: target, sources: [], resourceOnly: resource, outcome: skipReason ? 'Skipped' : 'Pending', ...(skipReason && { detail: skipReason }) });
              depths.set(target, depths.get(url) + 1);
              if (!skipReason) queue.push(target);
            }
            const found = records.get(target);
            if (!resource) found.resourceOnly = false;
            if (found && !found.sources.includes(url)) found.sources.push(url);
            if (found) {
              found.sourceExcerpts ||= [];
              if (found.sourceExcerpts.length < 10 && !found.sourceExcerpts.some(item => item.source === url)) {
                const markup = anchor.outerHTML;
                found.sourceExcerpts.push({ source: url, pageUrl: response.url, html: markup.slice(0, 600) + (markup.length > 600 ? '…' : '') });
              }
            }
          }
        }
      }
    } catch (error) {
      record.outcome = signal.aborted ? 'Cancelled' : error.outcome || (record.status && !record.discoveryKind ? record.outcome : 'Unverified');
      if (error.status) record.status = error.status;
      if (error.finalUrl) record.finalUrl = error.finalUrl;
      if (error.redirectUrl) {
        if (!records.has(error.redirectUrl)) {
          records.set(error.redirectUrl, { url: error.redirectUrl, sources: [], outcome: 'Skipped', detail: 'Redirect destination excluded by ignore prefixes; it was not requested.' });
        }
        const destination = records.get(error.redirectUrl);
        if (destination && !destination.sources.includes(url)) destination.sources.push(url);
      }
      record.detail = signal.aborted ? 'Scan stopped' : error.outcome || error.message.startsWith('Redirect') || error.message === 'Page exceeds 2 MB parsing limit' || record.discoveryKind ? error.message : 'Request failed or timed out; this does not prove the link is broken.';
    } finally {
      record.timeMs ??= performance.now() - lastRequestAt;
      record.testedAt = new Date().toISOString();
      if (!record.checkedOnce) checked++;
      record.checkedOnce = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      publish();
    }
  }
  waitingFor = '';
  if (signal.aborted) {
    for (const record of records.values()) if (record.outcome === 'Pending') record.outcome = 'Cancelled';
    queue.length = 0;
  }
  publish();
  return { limits: limits() };
}


