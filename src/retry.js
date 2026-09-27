/**
 * Interpret Retry-After seconds/date or use a bounded fallback sequence plus jitter.
 * Server delays have a one-second minimum; retry count is zero-based.
 * @param {string|null} value Retry-After header.
 * @param {number} retry Nonnegative retry index.
 * @param {number} [now] Current epoch milliseconds; injectable for tests.
 * @param {number} [random] Random fraction in [0, 1); injectable for tests.
 * @returns {number} Delay in milliseconds (server-supplied delays have no upper cap).
 */
export function retryDelay(value, retry, now = Date.now(), random = Math.random()) {
  const text = value?.trim();
  if (text && /^\d+$/.test(text)) {
    const delay = Number(text) * 1000;
    if (Number.isFinite(delay)) return Math.max(1000, delay);
  }
  if (text && !/^[\d.+-]+$/.test(text)) {
    const date = Date.parse(text);
    if (Number.isFinite(date)) return Math.max(1000, date - now);
  }
  return [5000, 15000, 45000][Math.min(retry, 2)] + Math.floor(random * 1000);
}
