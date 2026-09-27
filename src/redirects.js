const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Create a redirect observer scoped to the current extension scanner document/tab.
 * @param {object} [chromeApi=globalThis.chrome] Chrome API or a test double.
 * @returns {Promise<Function>} Factory taking a URL and returning read()/dispose().
 * @throws {Error} Required extension APIs or a scanner tab are unavailable.
 * Listeners must be disposed after every request, including failed requests.
 */
export async function createChromeRedirectObserver(chromeApi = globalThis.chrome) {
  if (!chromeApi?.webRequest?.onHeadersReceived) throw new Error('Reload the extension to enable redirect inspection.');
  const tab = await chromeApi.tabs.getCurrent();
  if (!Number.isInteger(tab?.id)) throw new Error('Open the scanner in its extension tab to inspect redirects.');
  const contexts = await chromeApi.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [tab.id] });
  const documentId = contexts.find(context => context.frameId === 0)?.documentId;
  const initiator = `chrome-extension://${chromeApi.runtime.id}`;
  return url => {
    let headers;
    const listener = details => {
      const ownDocument = documentId && details.documentId === documentId;
      const ownTab = details.tabId === tab.id && details.initiator === initiator;
      if (details.url !== url || (!ownDocument && !ownTab) || !REDIRECT_STATUSES.has(details.statusCode)) return;
      headers = {
        status: details.statusCode,
        location: details.responseHeaders?.find(header => header.name.toLowerCase() === 'location')?.value,
      };
    };
    chromeApi.webRequest.onHeadersReceived.addListener(listener, { urls: ['http://*/*', 'https://*/*'], types: ['xmlhttprequest'] }, ['responseHeaders']);
    return {
      read: () => headers,
      dispose: () => chromeApi.webRequest.onHeadersReceived.removeListener(listener),
    };
  };
}

/**
 * Fetch with native redirects unless exclusions require inspecting every destination.
 * Manual redirect hops recalculate credential scope and stop before excluded URLs.
 * @param {object} options
 * @param {string} options.url Absolute URL, already checked against exclusions by caller.
 * @param {(url: string) => Headers} options.headersForUrl
 * @param {AbortSignal} options.signal Bounds the entire redirect chain.
 * @param {RequestCredentials} options.credentials Browser cookie policy.
 * @param {((url: string) => boolean) & {hasRules: boolean}} options.ignored
 * @param {Function} [options.observeRedirect] Reads otherwise-opaque redirect metadata.
 * @param {typeof fetch} [options.fetchImpl=globalThis.fetch]
 * @returns {Promise<Response>} Caller owns consumption or cancellation of the final body.
 * @throws {Error} Network/abort failure, unsafe redirect, loop, or hop-limit violation.
 * Excluded destinations throw an error carrying outcome, status, finalUrl, and redirectUrl.
 */
export async function fetchWithRedirects({ url, headersForUrl, signal, credentials, ignored, observeRedirect, fetchImpl = globalThis.fetch }) {
  if (!ignored.hasRules) {
    return fetchImpl(url, { headers: headersForUrl(url), signal, credentials, redirect: 'follow', referrerPolicy: 'no-referrer', cache: 'no-store' });
  }
  const visited = new Set();
  for (let hop = 0; hop <= 20; hop++) {
    signal.throwIfAborted();
    if (visited.has(url)) throw new Error('Redirect loop detected.');
    visited.add(url);
    const observation = observeRedirect?.(url);
    let response;
    let metadata;
    try {
      response = await fetchImpl(url, { headers: headersForUrl(url), signal, credentials, redirect: 'manual', referrerPolicy: 'no-referrer', cache: 'no-store' });
      metadata = observation?.read();
    } finally { observation?.dispose(); }
    signal.throwIfAborted();
    const status = metadata?.status ?? response.status;
    if (response.type !== 'opaqueredirect' && !REDIRECT_STATUSES.has(status)) return response;
    await response.body?.cancel();
    const location = metadata?.location ?? response.headers.get('location');
    if (!location) throw new Error('Redirect destination could not be inspected. Reload the extension and scanner tab; the redirect was not followed.');
    let destination;
    try {
      destination = new URL(location, url);
      if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) throw new Error();
      destination.hash = '';
    } catch { throw new Error('Redirect destination is not a valid HTTP or HTTPS URL.'); }
    if (ignored(destination.href)) {
      const error = new Error('Redirect destination excluded by ignore prefixes; it was not requested.');
      error.outcome = 'Skipped';
      error.status = status;
      error.finalUrl = url;
      error.redirectUrl = destination.href;
      throw error;
    }
    url = destination.href;
  }
  throw new Error('Redirect limit exceeded (20 redirects).');
}

