import { readPageSource } from './content.js';
import { CRAWL_LIMITS } from './settings.js';

// Sniff the bytes, since Fetch already decompresses Content-Encoding: gzip,
// while a .xml.gz file may still have a compressed body.
/**
 * Read plain or gzip discovery data, bounding both compressed and decoded byte counts.
 * Fetch may already decompress Content-Encoding; gzip is detected by its magic bytes.
 * @param {Response} response Consumed once.
 * @param {AbortSignal} signal
 * @returns {Promise<string>} UTF-8 robots/XML source.
 * @throws {Error} Cancellation, decompression failure, or either size limit exceeded.
 */
export async function readDiscoverySource(response, signal) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks = [];
  let length = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.length;
      if (length > CRAWL_LIMITS.maxHtmlBytes) {
        await reader.cancel();
        throw new Error('Discovery file exceeds 2 MB parsing limit.');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body = new Blob([bytes]).stream();
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) body = body.pipeThrough(new DecompressionStream('gzip'));
  return readPageSource(new Response(body), signal);
}

// robots.txt advertises sitemaps; Allow/Disallow patterns are not page URLs.
/**
 * Extract sitemap directives or direct XML loc children without expanding robots rules.
 * Returned URLs may be relative; the caller resolves them and applies scope/exclusions.
 * @param {string} source
 * @param {'robots'|'sitemap'} kind
 * @returns {Array<{value: string, kind: 'sitemap'|null}>} Null kind denotes a page URL.
 * @throws {Error} Unsupported or invalid sitemap XML.
 */
export function parseDiscovery(source, kind) {
  if (kind === 'robots') {
    return source.split(/\r?\n/).flatMap(line => {
      const match = line.split('#')[0].match(/^\s*sitemap\s*:\s*(\S+)\s*$/i);
      return match ? [{ value: match[1], kind: 'sitemap' }] : [];
    });
  }
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  const name = element => (element.localName || element.nodeName).split(':').at(-1);
  const root = doc.documentElement;
  if (!root || doc.getElementsByTagName('parsererror').length || !['urlset', 'sitemapindex'].includes(name(root))) {
    throw new Error('Could not read sitemap XML.');
  }
  const index = name(root) === 'sitemapindex';
  return Array.from(root.children).filter(entry => name(entry) === (index ? 'sitemap' : 'url'))
    .flatMap(entry => Array.from(entry.children).filter(child => name(child) === 'loc')
      .map(child => ({ value: child.textContent.trim(), kind: index ? 'sitemap' : null })));
}
