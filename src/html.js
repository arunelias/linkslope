/**
 * Parse untrusted HTML into inert template contents without loading its resources.
 * @param {string} source Raw HTML, already bounded by the caller.
 * @returns {DocumentFragment} Detached fragment; never attach it to the live scanner DOM.
 */
export function parseCrawlHtml(source) {
  // Parse untrusted markup only inside template contents. Unlike a full HTML
  // document, this keeps preloads, images, frames and scripts inert. Never
  // attach this fragment to the scanner's live document.
  const document = new DOMParser().parseFromString('', 'text/html');
  const template = document.createElement('template');
  template.innerHTML = source;
  return template.content;
}
