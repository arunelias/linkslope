import { sourcePreview } from './sources.js';

/**
 * Snapshot an allowlist of scan metadata and row fields for local export.
 * Credentials and source HTML excerpts are deliberately excluded.
 * @param {import('./crawler.js').ScanSnapshot} data Full scan snapshot.
 * @param {object} metadata Website, lifecycle status, timestamps, and optional limits.
 * @returns {object} Versioned report; partial is true for every status except complete.
 */
export function createReport(data, metadata) {
  return {
    version: 1,
    ...metadata,
    partial: metadata.status !== 'complete',
    generatedAt: new Date().toISOString(),
    summary: {
      discovered: data.records.length, checked: data.checked, pages: data.pages,
      issues: data.records.filter(r => ['Broken', 'Server error'].includes(r.outcome) || r.contentChecks?.some(c => c.outcome === 'Failed')).length,
    },
    records: data.records.map(r => {
      const references = sourcePreview(r.sources);
      return {
      url: r.url, outcome: r.outcome, status: r.status ?? null,
      finalUrl: r.finalUrl || '', timeMs: r.timeMs ?? null,
      detail: r.detail || '', sources: references.sources, sourceCount: references.total,
      ...(references.more ? { sourcesSummary: references.summary } : {}),
      contentChecks: (r.contentChecks || []).map(c => ({ ...c })),
      testedAt: r.testedAt || '',
    }; }),
  };
}

function cell(value) {
  let text = String(value ?? '');
  // Prevent spreadsheet applications from executing untrusted cell formulas.
  if (/^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

/**
 * Serialize all report rows with a UTF-8 BOM, CRLF lines, and quoted formula-safe cells.
 * Content checks appear only if at least one row has a Passed or Failed check.
 * @param {ReturnType<typeof createReport>} report
 * @returns {string} CSV using seconds and the exporting device's local timestamps.
 */
export function reportCsv(report) {
  const includeContentChecks = report.records.some(r => r.contentChecks?.some(c => ['Passed', 'Failed'].includes(c.outcome)));
  const rows = [['URL', 'Outcome', 'HTTP status', 'Final URL', 'Time (s)', 'Details', 'Source pages', ...(includeContentChecks ? ['Content checks'] : []), 'Last tested (local time)']];
  for (const r of report.records) rows.push([
    r.url, r.outcome, r.status, r.finalUrl, formatCsvSeconds(r.timeMs), r.detail,
    sourceLines(r), ...(includeContentChecks ? [r.contentChecks?.length ? JSON.stringify(r.contentChecks) : ''] : []), formatCsvLocalTime(r.testedAt),
  ]);
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
}

/** Format references from either raw rows or already-limited JSON report rows. */
function sourceLines(record) {
  const references = sourcePreview(record.sources, record.sourceCount);
  return [...references.sources, ...(references.more ? [references.summary] : [])].join('\n');
}

/**
 * Format milliseconds as seconds: two decimals below 10 s, whole seconds otherwise.
 * @param {number|null|undefined} ms
 * @returns {string} Empty for missing, negative, or nonfinite durations.
 */
export function formatCsvSeconds(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  return (ms / 1000).toFixed(ms < 10000 ? 2 : 0);
}

/**
 * Format an instant in the exporting device's local timezone, including DST.
 * @param {string} value ISO timestamp, normally UTC from the crawler.
 * @returns {string} YYYY-MM-DD HH:mm:ss, or empty for a missing/invalid timestamp.
 */
export function formatCsvLocalTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Prepare a local export's filename, MIME type, and serialized contents.
 * @param {ReturnType<typeof createReport>} report
 * @param {'csv'|'json'} format
 * @returns {{name: string, type: string, content: string}}
 * @throws {Error} Unsupported format or invalid report website URL.
 */
export function reportFile(report, format) {
  if (!['csv', 'json'].includes(format)) throw new Error('Unsupported report format.');
  const host = new URL(report.website).hostname.replace(/[^a-z0-9.-]/gi, '_');
  return {
    name: `linkslope-${host}-${report.generatedAt.replace(/[:.]/g, '-')}.${format}`,
    type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8',
    content: format === 'csv' ? reportCsv(report) : JSON.stringify(report, null, 2),
  };
}

/**
 * Trigger a browser download and revoke the temporary Blob URL after dispatch.
 * @param {ReturnType<typeof createReport>} report
 * @param {'csv'|'json'} format
 * @returns {void}
 */
export function downloadReport(report, format) {
  const file = reportFile(report, format);
  const url = URL.createObjectURL(new Blob([file.content], { type: file.type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
