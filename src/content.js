import { CRAWL_LIMITS } from './settings.js';

/**
 * Compile a case-sensitive literal or regex: matcher against raw response source.
 * @param {string} [value=''] Empty disables the check.
 * @param {string} [label='Content'] Human-readable validation label.
 * @returns {((text: string) => boolean)|null}
 * @throws {Error} Non-text input or an invalid regular expression.
 */
export function createContentMatcher(value = '', label = 'Content') {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  if (!value) return null;
  if (!value.startsWith('regex:')) return text => text.includes(value);
  const pattern = value.slice(6);
  if (!pattern.trim()) throw new Error(`${label}: enter a pattern after regex:.`);
  try {
    const regex = new RegExp(pattern);
    return text => regex.test(text);
  } catch { throw new Error(`${label}: invalid regex pattern.`); }
}

/**
 * Evaluate enabled presence/absence checks; unavailable content never counts as passing.
 * @param {object} settings Settings containing checkPresence and checkAbsence.
 * @param {string} [text] Complete raw response text; undefined means not evaluated.
 * @param {string} [reason] Explanation used when content was not evaluated.
 * @returns {Array<{label: string, outcome: string, detail: string}>}
 */
export function contentChecks(settings, text, reason = 'Content could not be checked.') {
  return [['checkPresence', 'Presence'], ['checkAbsence', 'Absence']].flatMap(([key, label]) => {
    const matches = createContentMatcher(settings[key], `Check ${label.toLowerCase()}`);
    if (!matches) return [];
    if (text === undefined) return [{ label, outcome: 'Not checked', detail: reason }];
    const found = matches(text);
    return [{ label, outcome: (key === 'checkPresence' ? found : !found) ? 'Passed' : 'Failed', detail: found ? 'Content found.' : 'Content not found.' }];
  });
}

/**
 * Determine whether a declared response MIME type supports source content checks.
 * @param {Response} response
 * @returns {boolean} True for text/*, JSON, or XML media types.
 */
export function isTextResponse(response) {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
  return type.startsWith('text/') || /(?:\/|\+)(?:json|xml)$/.test(type);
}

/**
 * Consume UTF-8 source with an abortable reader and a byte limit, not a character limit.
 * The response body is consumed; oversized input is cancelled, never silently truncated.
 * @param {Response} response
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 * @throws {Error} Aborted request, stream failure, or source above the 2 MB limit.
 */
export async function readPageSource(response, signal) {
  signal.throwIfAborted();
  if (!response.body) return '';
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder();
  let length = 0;
  let source = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.length;
      if (length > CRAWL_LIMITS.maxHtmlBytes) {
        await reader.cancel();
        throw new Error('Page exceeds 2 MB parsing limit');
      }
      source += decoder.decode(value, { stream: true });
    }
    return source + decoder.decode();
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
