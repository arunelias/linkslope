import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { normalize, scan } from './crawler.js';
import { DEFAULT_SETTINGS, validateSettings, getSettingsErrors } from './settings.js';
import { createPauseControl } from './pause.js';
import { createChromeRedirectObserver } from './redirects.js';
import SettingsPanel from './SettingsPanel.jsx';
import ReportTable from './ReportTable.jsx';
import ReportingPanel from './ReportingPanel.jsx';
import { createReport, downloadReport } from './reportExport.js';
import { DEFAULT_EMAIL, createEmailSummary, loadEmailSettings, saveEmailSettings, validateEmailSettings, shouldAutoSend, sendEmailReport } from './emailReport.js';
import { retestLink } from './report.js';
import { scanProgress } from './progress.js';
import '@fontsource-variable/inter';
import '@fortawesome/fontawesome-free/css/fontawesome.css';
import '@fortawesome/fontawesome-free/css/solid.css';
import './tailwind.css';
import './style.css';

function Icon({ name }) {
  return <i className={`fa-solid fa-${name}`} aria-hidden="true"/>;
}

/**
 * Own the scanner lifecycle, immutable report metadata, and session-only secrets.
 * Refs serialize scan/re-test/email actions and provide current settings to async work;
 * React state drives presentation. Full snapshots feed downloads; compact summaries
 * alone cross the email boundary. Closing this tab ends its in-memory scan state.
 * @returns {React.JSX.Element}
 */
function App() {
  const [url, setUrl] = useState('');
  const [urlTouched, setUrlTouched] = useState(false);
  const urlInput = useRef(null);
  const website = url.trim();
  const websiteTarget = normalize(/^https?:\/\//i.test(website) ? website : `https://${website}`);
  const urlError = urlTouched && !websiteTarget ? 'Enter a valid HTTP or HTTPS website URL.' : '';
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [paused, setPaused] = useState(false);
  const [message, setMessage] = useState('');
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [validationFailed, setValidationFailed] = useState(false);
  const [filter, setFilter] = useState('All links');
  const [query, setQuery] = useState('');
  const [data, setData] = useState({ records: [], pages: 0, checked: 0, queued: 0 });
  const scanStart = useRef(null);
  const [emailSettings, setEmailSettings] = useState({ ...DEFAULT_EMAIL });
  const [emailToken, setEmailToken] = useState('');
  const [emailOpen, setEmailOpen] = useState(false);
  const emailPreferences = useRef({ settings: { ...DEFAULT_EMAIL }, token: '' });
  function updateEmailToken(token) { emailPreferences.current.token = token; setEmailToken(token); }
  const [emailBusy, setEmailBusy] = useState(false);
  const emailSending = useRef(false);
  const [emailMessage, setEmailMessage] = useState('');
  const [storageMessage, setStorageMessage] = useState('');
  const [reportMetadata, setReportMetadata] = useState(null);
  useEffect(() => {
    try { const saved = loadEmailSettings(); emailPreferences.current.settings = saved; setEmailSettings(saved); }
    catch { setStorageMessage('Email settings could not be loaded. Re-enter them below.'); }
  }, []);
  function updateEmailSettings(next) {
    emailPreferences.current.settings = next;
    setEmailSettings(next);
    try { saveEmailSettings(next); setStorageMessage(''); }
    catch { setStorageMessage('Email settings could not be saved. They only apply to this session.'); }
  }
  async function deliverReport(report, preferences = emailSettings, token = emailToken) {
    if (emailSending.current) return;
    emailSending.current = true;
    setEmailBusy(true);
    setEmailMessage('Sending report…');
    try {
      const deliveryMessage = await sendEmailReport(preferences, report, token);
      setEmailMessage(deliveryMessage);
    } catch (error) { setEmailMessage(error.message); }
    finally { emailSending.current = false; setEmailBusy(false); }
  }
  const retestActive = useRef(false);
  const lastRetest = useRef(0);
  const [retesting, setRetesting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const controller = useRef(null);
  const pauseControl = useRef(null);
  const settingsRef = useRef(settings);
  useEffect(() => {
    if (!running || paused || stopped) return;
    const timer = setInterval(() => setElapsed(seconds => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [running, paused, stopped]);
  function updateSettings(update) {
    const next = update(settingsRef.current);
    settingsRef.current = next;
    setSettings(next);
    if (validationFailed && !Object.keys(getSettingsErrors(next)).length) {
      setValidationFailed(false);
      setMessage('');
    }
  }
  function checkSettings() {
    setValidationAttempted(true);
    try {
      const valid = validateSettings(settingsRef.current);
      setValidationFailed(false);
      return valid;
    } catch {
      setValidationFailed(true);
      setMessage('Please correct the highlighted settings before continuing.');
      setSettingsOpen(true);
      requestAnimationFrame(() => {
        const input = document.querySelector('#scan-settings [aria-invalid="true"]:not(:disabled)');
        for (let parent = input?.parentElement; parent; parent = parent.parentElement) {
          if (parent.tagName === 'DETAILS') parent.open = true;
        }
        input?.focus();
      });
      return null;
    }
  }
  const extension = !!globalThis.chrome?.runtime?.id;
  async function start(event) {
    event.preventDefault();
    if (controller.current || retestActive.current || emailSending.current) return;
    const target = websiteTarget;
    setUrlTouched(true);
    if (!target) { setMessage(''); urlInput.current?.focus(); return; }
    const scanSettings = checkSettings();
    if (!scanSettings) return;
    if (emailSettings.autoSend) {
      try { validateEmailSettings(emailSettings, emailToken); }
      catch (error) { setEmailMessage(error.message); setEmailOpen(true); return; }
    }
    const metadata = { website: target, startedAt: new Date().toISOString(), finishedAt: null, status: 'running' };
    setReportMetadata(metadata);
    setEmailMessage('');
    let latestData = { records: [], pages: 0, checked: 0 };
    const scanController = new AbortController();
    controller.current = scanController;
    scanStart.current = target;
    lastRetest.current = 0;
    const scanPause = createPauseControl();
    pauseControl.current = scanPause;
    setMessage('');
    setStopped(false);
    setPaused(false);
    setRunning(true);
    setElapsed(0);
    setData({ records: [], pages: 0, checked: 0, queued: 0 });
    try {
      if (scanController.signal.aborted) { setMessage('Scan stopped.'); return; }
      const observeRedirect = await createChromeRedirectObserver();
      const result = await scan({ start: target, ...scanSettings, signal: scanController.signal, pauseControl: scanPause, getSettings: () => settingsRef.current, observeRedirect, onUpdate: value => { latestData = value; setData(value); } });
      const finished = { ...metadata, finishedAt: new Date().toISOString(), status: scanController.signal.aborted ? 'stopped' : result.limits.depth || result.limits.pages ? 'limited' : 'complete', limits: result.limits };
      setReportMetadata(finished);
      const delivery = emailPreferences.current;
      if (shouldAutoSend(delivery.settings, finished.status)) void deliverReport(createEmailSummary(latestData, finished), delivery.settings, delivery.token);
      const reasons = [];
      if (result.limits.depth) reasons.push('crawl depth prevented crawling ' + result.limits.depth + ' linked pages');
      if (result.limits.pages) reasons.push('the page limit prevented crawling ' + result.limits.pages + ' linked pages');
      setMessage(scanController.signal.aborted ? 'Scan stopped. Partial results are shown below.' : reasons.length ? 'Scan limited: ' + reasons.join('; ') + '. Increase limits in Settings and start a new scan to discover more pages.' : 'Scan complete: no more links were discovered in the crawled HTML.');
    } catch (error) { setReportMetadata({ ...metadata, finishedAt: new Date().toISOString(), status: 'failed' }); setMessage(`Could not complete scan: ${error.message}`); }
    finally { controller.current = null; pauseControl.current = null; setPaused(false); setRunning(false); }
  }
  async function retest(record) {
    if (controller.current || retestActive.current) throw new Error('Wait for the active scan or re-test to finish.');
    const currentSettings = validateSettings(settingsRef.current);
    retestActive.current = true;
    setRetesting(true);
    try {
      const interval = currentSettings.requestsPerMinute ? 60000 / currentSettings.requestsPerMinute : 0;
      const remaining = interval - (Date.now() - lastRetest.current);
      if (remaining > 0) throw new Error(`Rate limit: wait ${Math.ceil(remaining / 1000)} seconds before re-testing.`);
      const observeRedirect = await createChromeRedirectObserver();
      lastRetest.current = Date.now();
      const result = await retestLink({ url: record.url, start: scanStart.current, settings: currentSettings, observeRedirect });
      setData(previous => ({ ...previous, records: previous.records.map(item => item.url === record.url ? { ...item, ...result, checkedOnce: item.checkedOnce || result.timeMs !== undefined } : item), checked: previous.checked + (!record.checkedOnce && result.timeMs !== undefined ? 1 : 0) }));
      return result;
    } finally { retestActive.current = false; setRetesting(false); }
  }
  function togglePause(event) {
    event.preventDefault();
    const control = pauseControl.current;
    if (!control || controller.current?.signal.aborted) return;
    if (control.paused) {
      if (!checkSettings()) return;
      setMessage('');
      control.resume();
    }
    else control.pause();
    setPaused(control.paused);
  }
  const issues = data.records.filter(r => (['Broken', 'Server error'].includes(r.outcome) || r.contentChecks?.some(check => check.outcome === 'Failed')));
  const working = data.records.filter(r => r.outcome === 'Working').length;
  const redirects = data.records.filter(r => r.finalUrl && r.finalUrl !== r.url).length;
  const { completed, skipped, pending, percent: progress } = scanProgress(data.records);
  const activeUrl = data.records.find(r => r.outcome === 'Checking')?.url || websiteTarget || 'Preparing scan…';
  const matchingSearch = data.records.filter(r => r.url.toLowerCase().includes(query.toLowerCase()));
  const filters = [
    { label: 'All links', tone: 'neutral', matches: () => true },
    { label: 'Issues', tone: 'issues', matches: r => (['Broken', 'Server error'].includes(r.outcome) || r.contentChecks?.some(check => check.outcome === 'Failed')) },
    { label: 'Working', tone: 'healthy', matches: r => r.outcome === 'Working' },
    { label: 'Redirects', tone: 'redirects', matches: r => r.finalUrl && r.finalUrl !== r.url },
    { label: 'Unverified', tone: 'unverified', matches: r => ['Unverified', 'Restricted', 'Rate limited'].includes(r.outcome) },
    { label: 'Skipped', tone: 'skipped', matches: r => r.outcome === 'Skipped' },
  ].map(option => ({ ...option, count: matchingSearch.filter(option.matches).length }));
  const visible = matchingSearch.filter(filters.find(option => option.label === filter).matches);
  return <div className="app-shell min-h-screen font-sans antialiased">
    <header className="topbar"><div className="topbar-inner"><a className="brand" href="index.html"><img className="logo" src="./icons/linkslope.svg" alt="" width="36" height="36"/><span>Link<span className="brand-accent">Slope</span></span></a><span className="topbar-meta"><span className="live-dot"/> LOCAL WEBSITE SCANNER</span></div></header>
    <main className="dashboard">
      <section className="hero panel"><div className="hero-glow" aria-hidden="true"/><div className="eyebrow">WEBSITE HEALTH MONITOR <span> / </span> LINK AUDIT</div><h1>Find every broken link.<br/><span>Keep your site in motion.</span></h1><p className="hero-copy">Scan your website, follow discovered pages, and pinpoint the links that need attention.</p>
        <form noValidate onSubmit={start}><label htmlFor="url">TARGET WEBSITE</label><div className="form-row"><div className="website-field"><span className="field-icon" aria-hidden="true"><Icon name="globe"/></span><input ref={urlInput} id="url" type="text" required placeholder="https://example.com" value={url} disabled={running} className={urlError ? 'is-invalid' : undefined} aria-invalid={urlError ? true : undefined} aria-describedby={urlError ? 'url-feedback' : undefined} onBlur={() => setUrlTouched(true)} onChange={e => setUrl(e.target.value)}/>{urlError && <div id="url-feedback" className="invalid-feedback" role="alert">{urlError}</div>}</div><button type="button" className="settings-toggle" aria-label="Scan settings" aria-expanded={settingsOpen} aria-controls="scan-settings" onClick={() => setSettingsOpen(open => !open)}><span aria-hidden="true"><Icon name="gear"/></span> Settings</button><button type="submit" className="primary-button" disabled={!extension || running || retesting || emailBusy}><span aria-hidden="true"><Icon name="link"/></span> Start scan</button></div><SettingsPanel validationAttempted={validationAttempted} settings={settings} onChange={updateSettings} disabled={running && (!paused || stopped)} open={settingsOpen}/></form>
        <div className="hero-foot"><span>No fixed URL limit · HTML & sitemap discovery</span><span>LOCAL SCAN <span className="foot-spark"><Icon name="bolt"/></span> NO ACCOUNT</span></div>{!extension && <p className="error">Preview mode. Load the built extension in Chrome to enable scanning.</p>}{validationFailed && message && <p className="validation-summary" role="alert">{message}</p>}</section>
      {(running || data.checked > 0 || message) && <section className={`progress-panel panel ${running && !paused && !stopped ? 'is-scanning' : ''}`} aria-live="polite"><div className="progress-top"><div className="scan-identity"><div className="radar" aria-hidden="true"><span/></div><div><div className="section-kicker">{running ? stopped ? 'STOPPING SCAN' : paused ? 'SCAN PAUSED' : 'SCANNING TARGET' : 'SCAN ACTIVITY'}</div><div className="active-url" title={activeUrl}>{running ? activeUrl : websiteTarget || 'Last scan'}</div></div></div><div className="scan-actions"><span className="timer"><Icon name="clock"/> {String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</span>{running && <><button type="button" className="secondary-button" disabled={stopped} onClick={togglePause}><Icon name={paused ? "play" : "pause"}/> {paused ? 'Resume' : 'Pause'}</button><button type="button" className="stop" disabled={stopped} onClick={event => { event.preventDefault(); controller.current?.abort(); setStopped(true); }}><Icon name="stop"/> Stop</button></>}</div></div><div className="progress-label"><span>{completed} of {data.records.length} discovered links processed · {data.checked} checked · {skipped} skipped{pending > 0 ? ` · ${pending} in progress` : ''}</span><strong>{progress}%</strong></div><div className="progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin="0" aria-valuemax="100" aria-label="Scan progress"><div style={{ width: `${progress}%` }}/></div>{running && data.waitingFor && !paused && !stopped && <p role="status">{data.waitingFor}</p>}{paused && !stopped && <p role="status">Paused. Active requests may finish. You can edit Settings before resuming.</p>}{message && !validationFailed && <p className="scan-message" role="status">{message}</p>}</section>}
      <section className="stats" aria-label="Scan summary" aria-live="polite"><article><div className="stat-label">LINKS CHECKED <span><Icon name="arrow-up-right-from-square"/></span></div><strong>{data.checked}</strong><small>of {data.records.length} discovered</small></article><article className="healthy"><div className="stat-label">HEALTHY <span><Icon name="circle-check"/></span></div><strong>{working}</strong><small>Reachable links</small></article><article className="issues"><div className="stat-label">ISSUES FOUND <span><Icon name="triangle-exclamation"/></span></div><strong>{issues.length}</strong><small>Link or content failures</small></article><article className="redirects"><div className="stat-label">REDIRECTS <span><Icon name="shuffle"/></span></div><strong>{redirects}</strong><small>Changed destinations</small></article><article><div className="stat-label">PAGES CRAWLED <span><Icon name="file-lines"/></span></div><strong>{data.pages}</strong><small>{running ? paused ? 'Scan paused' : 'Scan in progress' : data.checked ? 'Scan finished' : 'Ready to scan'}</small></article></section>
      <section className="results panel overflow-hidden"><div className="results-heading"><div><div className="section-kicker">SCAN OUTPUT</div><h2>Link report <span>{data.records.length}</span></h2></div><div className="tools"><ReportingPanel open={emailOpen} onOpen={() => setEmailOpen(true)} onClose={() => setEmailOpen(false)} settings={emailSettings} onChange={updateEmailSettings} token={emailToken} setToken={updateEmailToken} locked={running || retesting} busy={emailBusy} hasReport={!!reportMetadata && data.records.length > 0} message={emailMessage} storageMessage={storageMessage} onSend={() => deliverReport(createEmailSummary(data, reportMetadata))} onDownload={format => downloadReport(createReport(data, reportMetadata), format)}/><label className="search-field"><span aria-hidden="true"><Icon name="magnifying-glass"/></span><input aria-label="Search URLs" placeholder="Search URLs..." value={query} onChange={e => setQuery(e.target.value)}/></label></div></div>{!emailOpen && (emailMessage || storageMessage) && <p className="report-feedback" role="status">{storageMessage || emailMessage}</p>}<div className="filter-tabs" role="group" aria-label="Filter results">{filters.map(option => <button key={option.label} type="button" className={filter === option.label ? 'active' : ''} aria-pressed={filter === option.label} title={query ? 'Count matches the current URL search' : 'Count includes all scan results'} onClick={() => setFilter(option.label)}>{option.label} <span className={`filter-count ${option.tone}`}>({option.count})</span></button>)}</div>{!data.records.length ? <div className="empty"><div className="empty-icon" aria-hidden="true"><Icon name="link"/></div><h3>Your link report starts here</h3><p>Enter a website above to see link health as the scan runs.</p></div> : <ReportTable records={visible} allRecords={data.records} filter={filter} query={query} running={running} busy={retesting} onRetest={retest}/>}</section>
      <footer>Runs on your device · No account needed <span>HTML & sitemap discovery · JavaScript-rendered links are not crawled</span></footer>
    </main>
  </div>;
}
createRoot(document.getElementById('root')).render(<App/>);





