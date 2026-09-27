/**
 * Count resolved work, including skipped URLs but excluding cancelled URLs.
 * @param {Array<{outcome: string}>} records Entire scan, not filtered table rows.
 * @returns {{completed: number, skipped: number, pending: number, percent: number}}
 */
export function scanProgress(records) {
  let completed = 0;
  let skipped = 0;
  let pending = 0;
  for (const record of records) {
    if (record.outcome === 'Skipped') skipped++;
    if (['Pending', 'Checking'].includes(record.outcome)) pending++;
    // Skipped URLs are resolved work; cancelled requests remain incomplete.
    if (record.outcome && !['Pending', 'Checking', 'Cancelled'].includes(record.outcome)) completed++;
  }
  return { completed, skipped, pending, percent: records.length ? Math.floor(completed / records.length * 100) : 0 };
}
