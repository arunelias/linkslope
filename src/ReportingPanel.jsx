import React, { useRef, useState } from 'react';
import { mailtrapMode } from './emailReport.js';

function Icon({ name }) { return <i className={`fa-solid fa-${name}`} aria-hidden="true"/>; }

/**
 * Render local download actions and a controlled, native email dialog.
 * @param {object} props
 * @param {typeof import('./emailReport.js').DEFAULT_EMAIL} props.settings Nonsecret preferences.
 * @param {(settings: object) => void} props.onChange Persists each settings edit in the parent.
 * @param {string} props.token Session-only token; never persist it with settings.
 * @param {(token: string) => void} props.setToken
 * @param {boolean} props.locked Blocks exports/manual send, not editing automatic delivery.
 * @param {boolean} props.busy Blocks edits and repeat sends while delivery is pending.
 * @param {boolean} props.hasReport Whether results exist for manual delivery/download.
 * @param {() => void} props.onSend Send a summary of the full current report.
 * @param {(format: 'csv'|'json') => void} props.onDownload Download all rows, not filters.
 * @param {string} props.message Delivery status or validation error.
 * @param {string} props.storageMessage Persistence failure, if any.
 * @param {boolean} props.open
 * @param {() => void} props.onOpen
 * @param {() => void} props.onClose Closing does not cancel delivery.
 * @returns {React.JSX.Element}
 */
export default function ReportingPanel({ settings, onChange, token, setToken, locked, busy, hasReport, onSend, onDownload, message, storageMessage, open, onOpen, onClose }) {
  const mode = mailtrapMode(settings.endpoint);
  const dialog = useRef(null);
  const opener = useRef(null);
  const [format, setFormat] = useState('csv');
  React.useEffect(() => {
    if (open && !dialog.current.open) dialog.current.showModal();
    if (!open && dialog.current.open) dialog.current.close();
  }, [open]);
  function close() { onClose(); opener.current?.focus(); }
  return <>
    <div className="report-actions" aria-label="Report actions">
      <div className="report-download"><select aria-label="Report download format" value={format} onChange={e => setFormat(e.target.value)}><option value="csv">CSV</option><option value="json">JSON</option></select><button type="button" disabled={!hasReport || locked} onClick={() => onDownload(format)} title="Download all scan results"><Icon name="download"/> Download</button></div>
      <button type="button" className="email-report-button" ref={opener} onClick={onOpen} aria-haspopup="dialog"><Icon name="envelope"/> {busy ? 'Sending…' : 'Email report'}{settings.autoSend && <span className="auto-email-badge">Auto</span>}</button>
    </div>
    <dialog ref={dialog} className="email-dialog" aria-labelledby="email-report-title" onCancel={e => { e.preventDefault(); close(); }} onClose={onClose}>
      <header><div><div className="section-kicker">LINK REPORT</div><h2 id="email-report-title">Email report</h2></div><button type="button" aria-label="Close email report" onClick={close}><Icon name="xmark"/></button></header>
      <div className="email-dialog-body">
        <p className="hint">Email a compact scan summary now or when your scan finishes. Full results remain available to download.</p>
        <fieldset className="scan-options" disabled={busy}>
          <label htmlFor="report-recipient">Recipient email</label><input autoFocus id="report-recipient" type="email" placeholder="you@example.com" value={settings.recipient} onChange={e => onChange({ ...settings, recipient: e.target.value })}/>
          <label className="auto-email-option" htmlFor="report-auto"><input id="report-auto" type="checkbox" checked={settings.autoSend} onChange={e => onChange({ ...settings, autoSend: e.target.checked })}/><span>Automatically email when scan completes<small>Applies to the current scan and future scans. Keep this tab open until delivery finishes.</small></span></label>
          <details className="settings-disclosure email-connection"><summary>Email service setup</summary><div>
            <label htmlFor="report-endpoint">HTTPS email endpoint</label><input id="report-endpoint" type="url" placeholder="https://your-service.example/send-report" value={settings.endpoint} onChange={e => onChange({ ...settings, endpoint: e.target.value })}/>
            {mode && <><label htmlFor="report-sender">Sender email</label><input id="report-sender" type="email" placeholder="sender@example.com" value={settings.sender || ''} onChange={e => onChange({ ...settings, sender: e.target.value })}/></>}
            <label htmlFor="report-token">Endpoint access token <span className="hint">{mode ? '(required)' : '(optional)'}</span></label><input id="report-token" type="password" autoComplete="new-password" value={token} onChange={e => setToken(e.target.value)}/>
            <p className="hint">Use an HTTPS email service endpoint configured for your provider. The access token stays in memory for this session only.</p>
            {mode === 'sending' && <p className="hint">Use a sender address authorized by your email service.</p>}
          </div></details>
        </fieldset>
        <p className="hint">Recipient, sender, endpoint, and automatic delivery preference are saved in this browser. Emails contain the scanned website, scan status, timestamps, and totals. No link list or CSV attachment is sent.</p>
        {storageMessage && <p role="alert" className="error">{storageMessage}</p>}
        {message && <p role="status" className="email-feedback">{message}</p>}
      </div>
      <footer><span className="hint">{locked ? 'Send now is available when the scan or re-test finishes.' : !hasReport ? 'Run a scan to send a report now.' : 'Summary totals cover all results.'}</span><div><button type="button" onClick={close}>Done</button><button type="button" className="email-send-button" disabled={!hasReport || locked || busy} onClick={onSend}><Icon name="paper-plane"/> {busy ? 'Sending…' : 'Send now'}</button></div></footer>
    </dialog>
  </>;
}
