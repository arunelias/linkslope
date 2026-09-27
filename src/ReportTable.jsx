import React, { useEffect, useRef, useState } from 'react';
import { formatTime, paginate, suggestedFix } from './report.js';
import { sourcePreview } from './sources.js';

function Icon({ name }) { return <i className={`fa-solid fa-${name}`} aria-hidden="true"/>; }
function ContentResults({ record }) {
  return record.contentChecks?.map(check => <small key={check.label}>Check {check.label.toLowerCase()}: <strong>{check.outcome}</strong> — {check.detail}</small>);
}
function Status({ record }) { return <span className={`badge ${record.outcome.toLowerCase().replaceAll(' ', '-')}`}>{record.status ? `${record.status} · ` : ''}{record.outcome}</span>; }

/**
 * Paginate filtered rows and inspect live records without copying selection state.
 * @param {object} props
 * @param {import('./crawler.js').ScanRecord[]} props.records Filter/search matches.
 * @param {import('./crawler.js').ScanRecord[]} props.allRecords Full live scan.
 * @param {string} props.filter Changing the filter resets pagination.
 * @param {string} props.query Changing the search resets pagination.
 * @param {boolean} props.running Disables re-tests during a scan.
 * @param {boolean} props.busy Serializes re-tests across all rows.
 * @param {(record: import('./crawler.js').ScanRecord) => Promise<object>} props.onRetest
 * @returns {React.JSX.Element}
 */
export default function ReportTable({ records, allRecords, filter, query, running, busy, onRetest }) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [selected, setSelected] = useState(null);
  const [feedback, setFeedback] = useState('');
  const dialog = useRef(null);
  const opener = useRef(null);
  const record = allRecords.find(item => item.url === selected);
  const paging = paginate(records, page, size);
  useEffect(() => { setPage(1); }, [filter, query, size]);
  useEffect(() => { setPage(previous => Math.min(previous, paging.pages)); }, [paging.pages]);
  useEffect(() => {
    if (record && !dialog.current.open) dialog.current.showModal();
    if (!record && dialog.current.open) dialog.current.close();
  }, [record]);
  async function copy(url) {
    try { await navigator.clipboard.writeText(url); setFeedback('URL copied.'); }
    catch { setFeedback('Could not copy automatically. Select and copy the URL text.'); }
  }
  function inspect(item, event) {
    opener.current = event.currentTarget;
    setFeedback('');
    setSelected(item.url);
  }
  function close() { dialog.current.close(); setSelected(null); opener.current?.focus(); }
  async function retest() {
    setFeedback('Re-testing link…');
    try { const result = await onRetest(record); setFeedback(`Re-test complete: ${result.outcome}. Table and summary updated.`); }
    catch (error) { setFeedback(error.message); }
  }
  return <>
    <div className="table-wrap overflow-x-auto"><table className="report-table"><thead><tr><th>STATUS</th><th>DESTINATION URL</th><th>FOUND ON</th><th title="Elapsed request time to response headers, including redirects">TIME</th><th>ACTIONS</th></tr></thead>
      <tbody>{paging.rows.map(item => <tr key={item.url}>
        <td><Status record={item}/><ContentResults record={item}/></td>
        <td><a href={item.url} target="_blank" rel="noreferrer">{item.url} <Icon name="arrow-up-right-from-square"/></a>{item.finalUrl && item.finalUrl !== item.url && <small>Redirects to {item.finalUrl}</small>}{item.detail && <small>{item.detail}</small>}{item.crawlDetail && <small>{item.crawlDetail}</small>}</td>
        <td>{item.sources.length ? <details><summary>{item.sources.length} source {item.sources.length === 1 ? 'page' : 'pages'}</summary>{sourcePreview(item.sources).sources.map(source => <a key={source} href={source} target="_blank" rel="noreferrer">{source}</a>)}{sourcePreview(item.sources).more > 0 && <small className="more-sources">{sourcePreview(item.sources).summary}</small>}</details> : <span className="hint">Starting URL</span>}</td>
        <td className="request-time">{formatTime(item.timeMs)}</td>
        <td><div className="row-actions"><button type="button" title="Inspect details" aria-label={`Inspect details for ${item.url}`} onClick={event => inspect(item, event)}><Icon name="magnifying-glass"/></button><button type="button" title="Copy URL" aria-label={`Copy URL ${item.url}`} onClick={() => copy(item.url)}><Icon name="copy"/></button></div></td>
      </tr>)}</tbody></table>{!records.length && <p className="empty">No links match this filter.</p>}</div>
    <div className="results-footer pagination">
      <div>Showing {paging.first}–{paging.last} of {records.length} matching links</div>
      <label>Rows per page <select value={size} onChange={event => setSize(Number(event.target.value))}>{[10,25,50,100].map(count => <option key={count}>{count}</option>)}</select></label>
      <nav aria-label="Result pages"><button type="button" disabled={paging.current === 1} onClick={() => setPage(1)} aria-label="First page"><Icon name="angles-left"/></button><button type="button" disabled={paging.current === 1} onClick={() => setPage(paging.current - 1)} aria-label="Previous page"><Icon name="chevron-left"/></button><span>Page {paging.current} of {paging.pages}</span><button type="button" disabled={paging.current === paging.pages} onClick={() => setPage(paging.current + 1)} aria-label="Next page"><Icon name="chevron-right"/></button><button type="button" disabled={paging.current === paging.pages} onClick={() => setPage(paging.pages)} aria-label="Last page"><Icon name="angles-right"/></button></nav>
    </div>
    {!selected && feedback && <p className="report-feedback" role="status">{feedback}</p>}
    <dialog ref={dialog} className="link-dialog" aria-labelledby="link-details-title" onCancel={event => { event.preventDefault(); close(); }}>
      {record && <><header><div><div className="section-kicker">LINK INSPECTION</div><h2 id="link-details-title">Link details</h2></div><button type="button" aria-label="Close details" onClick={close} autoFocus><Icon name="xmark"/></button></header>
        <div key={record.url} className="detail-body" tabIndex="0" role="region" aria-label="Link details and source excerpts"><div className="detail-status"><Status record={record}/><span>{formatTime(record.timeMs)}</span>{record.testedAt && <span>Checked {new Date(record.testedAt).toLocaleString()}</span>}</div>
        <ContentResults record={record}/><h3>Target URL</h3><a className="detail-url" href={record.url} target="_blank" rel="noreferrer">{record.url} <Icon name="arrow-up-right-from-square"/></a>
        {record.finalUrl && record.finalUrl !== record.url && <><h3>Final destination</h3><a className="detail-url" href={record.finalUrl} target="_blank" rel="noreferrer">{record.finalUrl} <Icon name="arrow-up-right-from-square"/></a></>}
        {record.detail && <p>{record.detail}</p>}{record.crawlDetail && <p>{record.crawlDetail}</p>}
        <section className="suggested-fix"><h3>Suggested Action / Fix</h3><p>{suggestedFix(record)}</p></section>
        <h3>Source pages ({record.sources.length})</h3><p className="hint">Showing up to 10 sources. Expand a source to view its captured link HTML. Excerpts are shortened to 600 characters, for up to 10 source pages.</p>
        {!record.sources.length && <p className="hint">This is the starting URL; no source link was discovered.</p>}
        {sourcePreview(record.sources).sources.map(source => {
          const excerpt = record.sourceExcerpts?.find(item => item.source === source);
          return <details className="source-excerpt" key={source}><summary><span>{source}</span><Icon name="chevron-down"/></summary><div className="source-content"><a className="detail-url" href={excerpt?.pageUrl || source} target="_blank" rel="noreferrer">Open source page <Icon name="arrow-up-right-from-square"/></a>{excerpt?.pageUrl !== source && excerpt?.pageUrl && <p className="hint">Source redirected to {excerpt.pageUrl}</p>}{excerpt ? <pre><code>{excerpt.html}</code></pre> : <p className="hint">No HTML excerpt captured for this source (it may be an HTTP redirect or beyond the excerpt limit).</p>}</div></details>;
        })}
        {sourcePreview(record.sources).more > 0 && <p className="hint more-sources">{sourcePreview(record.sources).summary}</p>}
        </div><footer className="detail-footer"><div className="detail-actions"><button className="retest-button" type="button" disabled={running || busy} onClick={retest}><Icon name="rotate-right"/> {busy ? 'Re-testing…' : 'Re-test link'}</button><button type="button" onClick={() => copy(record.url)}><Icon name="copy"/> Copy URL</button><a href={record.url} target="_blank" rel="noreferrer"><Icon name="arrow-up-right-from-square"/> Open target</a></div>
        {running && <p className="hint">Re-testing is available after the scan finishes or stops.</p>}
        <p className="detail-feedback" role="status">{feedback}</p></footer>
      </>}
    </dialog>
  </>;
}


