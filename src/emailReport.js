import { prepareMailtrapTransport } from './emailTransport.js';

export const EMAIL_STORAGE_KEY = 'linkslope.email.v1';
export const DEFAULT_EMAIL = Object.freeze({ recipient: '', sender: '', endpoint: '', autoSend: false });
const validAddress = value => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value);

/**
 * Select a known provider adapter by exact hostname; all others use the custom contract.
 * @param {string} endpoint
 * @returns {'sandbox'|'sending'|null} Null also covers invalid URLs; validation is separate.
 */
export function mailtrapMode(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.hostname === 'sandbox.api.mailtrap.io') return 'sandbox';
    if (['send.api.mailtrap.io', 'bulk.api.mailtrap.io'].includes(url.hostname)) return 'sending';
  } catch { /* Validation supplies the actionable error. */ }
  return null;
}

/**
 * Load only persisted nonsecret fields, applying defaults for missing/wrong types.
 * @param {Storage} [storage=localStorage] Browser storage or compatible test double.
 * @returns {typeof DEFAULT_EMAIL}
 * @throws {Error} Storage access or JSON parsing fails; the UI must expose the failure.
 */
export function loadEmailSettings(storage = localStorage) {
  const saved = JSON.parse(storage.getItem(EMAIL_STORAGE_KEY) || '{}');
  return {
    recipient: typeof saved?.recipient === 'string' ? saved.recipient : '',
    sender: typeof saved?.sender === 'string' ? saved.sender : '',
    endpoint: typeof saved?.endpoint === 'string' ? saved.endpoint : '',
    autoSend: saved?.autoSend === true,
  };
}

/**
 * Persist an explicit settings allowlist; API tokens are never written here.
 * @param {typeof DEFAULT_EMAIL} settings
 * @param {Storage} [storage=localStorage]
 * @returns {void}
 * @throws {Error} Storage is unavailable or its quota is exceeded.
 */
export function saveEmailSettings(settings, storage = localStorage) {
  storage.setItem(EMAIL_STORAGE_KEY, JSON.stringify({ recipient: settings.recipient, sender: settings.sender || '', endpoint: settings.endpoint, autoSend: settings.autoSend }));
}

/**
 * Normalize recipient/endpoint and validate any recognized provider requirements.
 * @param {typeof DEFAULT_EMAIL} settings
 * @param {string} [token] When supplied, required provider tokens must be nonblank.
 * @returns {typeof DEFAULT_EMAIL} Fresh normalized settings.
 * @throws {Error} Invalid addresses, endpoint, or required token.
 */
export function validateEmailSettings(settings, token) {
  const recipient = settings.recipient.trim();
  if (!validAddress(recipient)) throw new Error('Enter one valid recipient email address.');
  let endpoint;
  try { endpoint = new URL(settings.endpoint.trim()); } catch { throw new Error('Enter a valid HTTPS email endpoint.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Use an HTTPS endpoint without embedded credentials or a fragment.');
  const mode = mailtrapMode(endpoint.href);
  const sender = (settings.sender || '').trim();
  if (mode) {
    if (endpoint.port || endpoint.search || !(mode === 'sandbox' ? /^\/api\/send\/[1-9]\d*\/?$/ : /^\/api\/send\/?$/).test(endpoint.pathname)) throw new Error('Enter the complete send endpoint URL provided by your email service.');
    if (!validAddress(sender)) throw new Error('Enter a valid sender email address.');
    if (token !== undefined && !token.trim()) throw new Error('Enter your email service API token for this session.');
  }
  return { recipient, sender, endpoint: endpoint.href, autoSend: settings.autoSend === true };
}

/**
 * Gate automatic delivery on completed or limited scans; never stopped/failed scans.
 * @param {typeof DEFAULT_EMAIL} settings
 * @param {string} status Scan lifecycle status, not a link outcome.
 * @returns {boolean}
 */
export function shouldAutoSend(settings, status) {
  return settings.autoSend && ['complete', 'limited'].includes(status);
}

// Keep email payload size independent of the number of scanned URLs.
/**
 * Build a fixed-field summary without URLs per link, excerpts, or CSV attachments.
 * Counts may overlap (e.g. a reachable page can fail content checks).
 * @param {object} data Full snapshot, exported report, or previously compacted summary.
 * @param {object} metadata Scan website, status, startedAt, and finishedAt.
 * @returns {object} Summary whose size does not scale with the URL list.
 */
export function createEmailSummary(data, metadata) {
  const summary = { discovered: data.records?.length ?? data.summary?.discovered ?? 0, checked: data.checked ?? data.summary?.checked ?? 0, pages: data.pages ?? data.summary?.pages ?? 0, issues: 0, working: 0, broken: 0, serverErrors: 0, unverified: 0, skipped: 0, redirects: 0, contentFailures: 0 };
  if (data.records) {
    for (const r of data.records) {
      const failed = r.contentChecks?.some(c => c.outcome === 'Failed');
      if (failed || ['Broken', 'Server error'].includes(r.outcome)) summary.issues++;
      if (failed) summary.contentFailures++;
      if (r.outcome === 'Working') summary.working++;
      if (r.outcome === 'Broken') summary.broken++;
      if (r.outcome === 'Server error') summary.serverErrors++;
      if (['Unverified', 'Restricted', 'Rate limited'].includes(r.outcome)) summary.unverified++;
      if (r.outcome === 'Skipped') summary.skipped++;
      if (r.finalUrl && r.finalUrl !== r.url) summary.redirects++;
    }
  } else {
    for (const key of Object.keys(summary)) summary[key] = data.summary?.[key] ?? summary[key];
  }
  return { website: metadata.website, status: metadata.status, partial: metadata.status !== 'complete', startedAt: metadata.startedAt, finishedAt: metadata.finishedAt, summary };
}

/**
 * Adapt a summary to the recognized provider or custom endpoint JSON contract.
 * Other providers require an adapter service; this is not a universal email API schema.
 * @param {typeof DEFAULT_EMAIL} settings Validated settings.
 * @param {object} report Full or compact report; individual records are stripped.
 * @returns {object} JSON-ready email body with plain text and no attachment.
 */
export function emailPayload(settings, report) {
  const compact = createEmailSummary(report, report);
  const s = compact.summary;
  const text = [
    'LinkSlope scan summary', `Website: ${compact.website}`, `Scan status: ${compact.status}${compact.partial ? ' (partial results)' : ''}`,
    `Started: ${compact.startedAt || 'Unavailable'}`, `Finished: ${compact.finishedAt || 'Unavailable'}`, '',
    `Discovered URLs: ${s.discovered}`, `Links checked: ${s.checked}`, `Pages crawled: ${s.pages}`, `Issues: ${s.issues}`,
    `Working: ${s.working}`, `Broken: ${s.broken}`, `Server errors: ${s.serverErrors}`, `Unverified / restricted / rate limited: ${s.unverified}`,
    `Skipped: ${s.skipped}`, `Redirects: ${s.redirects}`, `Content failures: ${s.contentFailures}`, '',
    'Open LinkSlope to inspect individual results or download the full report. No CSV is attached.',
  ].join('\n');
  const subject = `LinkSlope ${compact.status}: ${new URL(compact.website).hostname}`;
  return mailtrapMode(settings.endpoint)
    ? { from: { email: settings.sender, name: 'LinkSlope' }, to: [{ email: settings.recipient }], subject, text }
    : { to: settings.recipient, subject, text, report: compact };
}

/**
 * Send one summary request with no cookies, redirects, or automatic retries.
 * A 2xx confirms endpoint acceptance, not recipient inbox delivery. An ambiguous failure
 * may already have sent mail, so retry decisions belong to the user.
 * @param {typeof DEFAULT_EMAIL} settings
 * @param {object} report Full or compact report.
 * @param {string} [token=''] Session-only Bearer token.
 * @param {typeof fetch} [fetcher=fetch] Injectable transport.
 * @returns {Promise<string>} User-facing acceptance message.
 * @throws {Error} Validation, transport setup, timeout, network, or non-2xx failure.
 */
export async function sendEmailReport(settings, report, token = '', fetcher = fetch) {
  const configured = validateEmailSettings(settings, token);
  const mode = mailtrapMode(configured.endpoint);
  if (mode) await prepareMailtrapTransport();
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetcher(configured.endpoint, {
      method: 'POST', headers, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      body: JSON.stringify(emailPayload(configured, report)),
    });
    await response.body?.cancel();
    if (!response.ok) {
      const help = response.status === 401
        ? ' Authentication failed. Check your API token.'
        : response.status === 403 ? ' Access denied. Check your API token permissions and sender configuration.'
        : response.status === 400 ? ' Check the sender, recipient, and endpoint configuration.' : '';
      const error = new Error(`Email endpoint returned HTTP ${response.status}.${help} Delivery was not confirmed.`);
      error.deliveryResponse = true;
      throw error;
    }
    return 'Scan summary accepted by your email service for delivery.';
  } catch (error) {
    if (error.deliveryResponse) throw error;
    throw new Error('Email delivery could not be confirmed. Check the endpoint before retrying to avoid duplicates.');
  } finally { clearTimeout(timer); }
}
