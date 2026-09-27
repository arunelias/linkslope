// Read references only; these elements stay in the inert parsing fragment.
/**
 * Collect supported image, stylesheet, and script references without executing them.
 * Does not recurse into CSS, JavaScript, or dynamically generated resources.
 * @param {DocumentFragment} doc Inert HTML fragment.
 * @returns {Array<{element: Element, value: string, resource: boolean}>} Unresolved URLs.
 */
export function resourceReferences(doc) {
  const references = [];
  const add = (element, value) => { if (value?.trim()) references.push({ element, value: value.trim(), resource: true }); };
  for (const element of doc.querySelectorAll('img[src], script[src], input[type="image"][src]')) add(element, element.getAttribute('src'));
  for (const element of doc.querySelectorAll('link[href]')) {
    const rel = (element.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    if (rel.includes('stylesheet')) add(element, element.getAttribute('href'));
  }
  for (const element of doc.querySelectorAll('img[srcset], picture source[srcset]')) {
    // URLs are followed by optional width/density descriptors. Commas inside
    // a URL (notably data URLs) must not become separate relative requests.
    let rest = element.getAttribute('srcset') || '';
    while (rest) {
      rest = rest.replace(/^[\s,]+/, '');
      if (!rest) break;
      const token = rest.match(/^\S+/)[0];
      add(element, token.replace(/,+$/, ''));
      rest = rest.slice(token.length);
      if (!token.endsWith(',')) {
        const separator = rest.indexOf(',');
        rest = separator < 0 ? '' : rest.slice(separator + 1);
      }
    }
  }
  return references;
}
