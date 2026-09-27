import { contentChecks, isTextResponse, readPageSource } from './content.js';
import { classify, normalize } from './crawler.js';
import { validateSettings, createIgnoreMatcher, createRequestHeaders, parseAcceptedHosts } from './settings.js';
import { fetchWithRedirects } from './redirects.js';

/**
 * Format request duration for the UI; CSV has a separate formatting contract.
 * @param {number} ms
 * @returns {string} Missing/nonfinite times are shown as an em dash.
 */
export function formatTime(ms) {
  return Number.isFinite(ms) ? ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s` : '—';
}

/**
 * Suggest an action from link/content outcomes without treating unverified as broken.
 * @param {import('./crawler.js').ScanRecord} record
 * @returns {string}
 */
export function suggestedFix(record) {
  if (record.contentChecks?.some(check => check.outcome === 'Failed')) return 'Review the page source: add the required content or remove the forbidden content, then re-test.';
  switch (record.outcome) {
    case 'Broken': return 'Correct the href on the source page, restore the missing page, or replace the link with a valid destination.';
    case 'Server error': return 'Check the destination server logs and availability. Re-test after the server issue is resolved.';
    case 'Restricted': return 'Check whether this page requires login or blocks automated requests. Verify access before changing the link.';
    case 'Rate limited': return 'Wait before re-testing and lower the request rate in Settings.';
    case 'Skipped': return 'Review the ignore rules and external URL setting if this link should be checked.';
    case 'Working': return record.finalUrl && record.finalUrl !== record.url ? 'If the move is permanent, update the source href to the final destination to avoid the redirect.' : 'No fix is needed based on this HTTP check.';
    case 'Pending': case 'Checking': return 'Wait for the current scan to check this link.';
    case 'Cancelled': return 'Re-test this link to complete its interrupted check.';
    default: return 'Verify the destination in a browser and check connectivity or timeout settings. An unverified result does not prove the link is broken.';
  }
}

/**
 * Clamp the requested page after filtering and return a nonmutating window of rows.
 * @template T
 * @param {T[]} records Filtered rows.
 * @param {number} page One-based page number.
 * @param {number} size Positive integer page size.
 * @returns {{current: number, pages: number, rows: T[], first: number, last: number}}
 */
export function paginate(records, page, size) {
  const pages = Math.max(1, Math.ceil(records.length / size));
  const current = Math.max(1, Math.min(page, pages));
  const offset = (current - 1) * size;
  return { current, pages, rows: records.slice(offset, offset + size), first: records.length ? offset + 1 : 0, last: Math.min(offset + size, records.length) };
}

/**
 * Check a single URL without crawling or refreshing its stored source excerpts.
 * The caller enforces pacing and merges the returned fields into the existing row.
 * @param {object} options
 * @param {string} options.url URL to re-check.
 * @param {string} options.start Original scan URL, used for credential/scope decisions.
 * @param {object} options.settings Current settings; validated before any request.
 * @param {Function} [options.observeRedirect]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} Updated outcome/status/timing/content-check fields.
 * Validation rejects; request failures become report outcomes.
 */
export async function retestLink({ url, start, settings: values, observeRedirect, signal = new AbortController().signal }) {
  const settings = validateSettings(values);
  if (!normalize(url) || !normalize(start)) throw new Error('A valid target and scan origin are required.');
  const ignored = createIgnoreMatcher(settings.ignorePrefixes);
  const external = new URL(url).origin !== new URL(start).origin && !parseAcceptedHosts(settings.acceptedHosts).includes(new URL(url).hostname);
  const result = { contentChecks: contentChecks(settings), status: undefined, finalUrl: undefined, detail: undefined, timeMs: undefined, testedAt: new Date().toISOString() };
  if (ignored(url) || (url !== start && external && !settings.testExternalUrls)) {
    return { ...result, outcome: 'Skipped', detail: ignored(url) ? 'Excluded by ignore prefixes.' : 'External URL checks are disabled.' };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, settings.timeoutSeconds * 1000);
  const began = performance.now();
  try {
    const response = await fetchWithRedirects({ url, headersForUrl: createRequestHeaders(settings, start), ignored, observeRedirect, signal: controller.signal, credentials: settings.useBrowserCookies ? 'include' : 'omit' });
    controller.signal.throwIfAborted();
    result.timeMs = performance.now() - began;
    result.status = response.status || undefined;
    result.finalUrl = response.url;
    result.outcome = classify(response.status);
    if (result.contentChecks.length && isTextResponse(response)) {
      result.contentChecks = contentChecks(settings, await readPageSource(response, controller.signal));
    } else {
      await response.body?.cancel();
      result.contentChecks = contentChecks(settings, undefined, 'Response is not HTML or text.');
    }
  } catch (error) {
    result.outcome = signal.aborted ? 'Cancelled' : error.outcome || (result.status ? result.outcome : 'Unverified');
    result.status = error.status || result.status;
    result.finalUrl = error.finalUrl || result.finalUrl;
    result.detail = error.outcome || error.message.startsWith('Redirect') ? error.message : 'Request failed or timed out; this does not prove the link is broken.';
  } finally {
    result.timeMs ??= performance.now() - began;
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
  return result;
}

