export const SOURCE_DISPLAY_LIMIT = 10;

/**
 * Limit displayed/exported references without changing the crawler's source list.
 * @param {string[]} [sources=[]] Sources in discovery order.
 * @param {number} [total=sources.length] Original count for an already-limited export.
 * @returns {{sources: string[], total: number, more: number, summary: string}}
 */
export function sourcePreview(sources = [], total = sources.length) {
  const visible = sources.slice(0, SOURCE_DISPLAY_LIMIT);
  const more = Math.max(0, total - visible.length);
  return { sources: visible, total, more, summary: more ? `… ${more} more ${more === 1 ? 'source' : 'sources'}` : '' };
}
