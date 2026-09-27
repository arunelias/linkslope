import React, { useState } from 'react';
import { getSettingsErrors } from './settings.js';

/**
 * Edit scan settings with touched-field feedback and a caller-controlled disabled state.
 * @param {object} props
 * @param {object} props.settings Current form values; numbers may still be strings.
 * @param {(update: Function) => void} props.onChange Accepts a settings updater function.
 * @param {boolean} props.disabled True during active requests except when paused.
 * @param {boolean} props.open Controls panel visibility, not whether values persist.
 * @param {boolean} props.validationAttempted Reveals errors on untouched fields.
 * @returns {React.JSX.Element}
 */
export default function SettingsPanel({ settings, onChange, disabled, open, validationAttempted }) {
  const [touched, setTouched] = useState({});
  const errors = getSettingsErrors(settings);
  const invalid = key => (validationAttempted || touched[key]) && errors[key];
  const field = (key, help) => ({
    className: invalid(key) ? 'is-invalid' : undefined,
    'aria-invalid': invalid(key) ? true : undefined,
    'aria-describedby': [help, invalid(key) && `${key}-feedback`].filter(Boolean).join(' ') || undefined,
    onBlur: () => setTouched(previous => ({ ...previous, [key]: true })),
  });
  const feedback = key => invalid(key) && <div id={`${key}-feedback`} className="invalid-feedback" role="alert">{errors[key]}</div>;
  const update = (key, value) => onChange(previous => ({ ...previous, [key]: value }));
  return <div id="scan-settings" className="settings-panel" hidden={!open}>
    <fieldset className="scan-options" disabled={disabled}>
      <legend>Crawl scope</legend>
      <p className="settings-description">Choose how far to crawl and which links to check.</p>
      <div className="settings-fields"><div className="settings-field">
      <label htmlFor="crawl-depth">Maximum crawl depth</label>
      <input id="crawl-depth" {...field('crawlDepth', 'depth-help')} type="number" min="0" max={Number.MAX_SAFE_INTEGER} step="1" required disabled={settings.runOnce || settings.unlimitedDepth} value={settings.crawlDepth} onChange={e => update('crawlDepth', e.target.value)}/>
      {feedback('crawlDepth')}
      <p id="depth-help" className="hint">Unlimited depth is enabled by default in Advanced crawl settings. Disable it to use this limit (default: 1). The starting page is depth 0; links beyond the limit are checked without further crawling.</p>
</div><div className="settings-field">
      <label htmlFor="max-pages">Maximum pages to crawl</label>
      <input id="max-pages" {...field('maxPages', 'pages-help')} type="number" min="0" max={Number.MAX_SAFE_INTEGER} step="1" required value={settings.maxPages} onChange={e => update('maxPages', e.target.value)}/>
      {feedback('maxPages')}
      <p id="pages-help" className="hint">Default: 0 (no page limit). Set a positive number to limit crawling.</p>
</div></div>
      <div className="settings-fields scope-toggles"><div className="settings-field">
      <label className="checkbox-label"><input type="checkbox" checked={settings.testExternalUrls} onChange={e => update('testExternalUrls', e.target.checked)}/>Test external URLs</label>
      <p className="hint">Default: off. Check links outside the crawl scope without following links on those pages.</p>

      </div><div className="settings-field">
      <label className="checkbox-label"><input id="discover-sitemaps" {...field('discoverSitemaps', 'sitemaps-help')} type="checkbox" disabled={settings.runOnce} checked={settings.discoverSitemaps} onChange={e => update('discoverSitemaps', e.target.checked)}/>Read URLs from robots.txt and sitemap.xml</label>
      {feedback('discoverSitemaps')}
      <p id="sitemaps-help" className="hint">Default: on. Read Sitemap entries in robots.txt, sitemap.xml, and nested sitemap indexes for this site. Discovered pages follow your crawl scope and exclusions. Run once disables discovery. Robots Allow/Disallow rules are not imported.</p>
      </div></div>

      <details className="settings-disclosure">
        <summary>Advanced crawl settings <span>Run once, unlimited depth, resources, retries, hosts & exclusions</span></summary>
        <div className="settings-fields disclosure-body"><div className="settings-field">
      <label className="checkbox-label"><input id="run-once" {...field('runOnce', 'run-once-help')} type="checkbox" checked={settings.runOnce} onChange={e => update('runOnce', e.target.checked)}/>Run once</label>
      {feedback('runOnce')}
      <p id="run-once-help" className="hint">Only crawl the starting page and check its links. Overrides crawl depth to 0. Default: off.</p>
</div><div className="settings-field">
      <label className="checkbox-label"><input id="unlimited-depth" {...field('unlimitedDepth', 'unlimited-depth-help')} type="checkbox" disabled={settings.runOnce} checked={settings.unlimitedDepth} onChange={e => update('unlimitedDepth', e.target.checked)}/>Unlimited crawl depth</label>
      {feedback('unlimitedDepth')}
      <p id="unlimited-depth-help" className="hint">Follow discovered pages at any depth. Default: on. Run once still limits crawling to the starting page.</p>
</div><div className="settings-field">
      <label className="checkbox-label"><input id="crawl-resources" {...field('crawlResources', 'resources-help')} type="checkbox" checked={settings.crawlResources} onChange={e => update('crawlResources', e.target.checked)}/>Crawl resources like images, stylesheets, and scripts</label>
      {feedback('crawlResources')}
      <p id="resources-help" className="hint">Default: off. Check image URLs (including srcset), linked stylesheets, and script files referenced in crawled HTML. Resources are never rendered or executed. External resources follow Test external URLs and Accepted hosts. URLs inside CSS or JavaScript are not followed.</p>
</div><div className="settings-field">
      <label className="checkbox-label"><input id="retry-rate-limited" {...field('retryRateLimited', 'retry-help')} type="checkbox" checked={settings.retryRateLimited} onChange={e => update('retryRateLimited', e.target.checked)}/>Automatically retry rate-limited requests (429)</label>
      {feedback('retryRateLimited')}
      <p id="retry-help" className="hint">Default: off. Retry up to 3 times, respecting Retry-After when supplied. Otherwise wait 5, 15, then 45 seconds plus a small random delay. Requests to the affected host wait while other hosts continue. Pause and Stop remain available.</p>
</div><div className="settings-field">
      <label htmlFor="accepted-hosts">Accepted hosts <span className="hint">(optional)</span></label>
      <input id="accepted-hosts" {...field('acceptedHosts', 'hosts-help')} type="text" value={settings.acceptedHosts} onChange={e => update('acceptedHosts', e.target.value)} placeholder="example.com, subdomain.another.com"/>
      {feedback('acceptedHosts')}
      <p id="hosts-help" className="hint">Additional exact hostnames to crawl, separated by commas or spaces. Subdomains must be listed separately. These hosts are crawled even when external URL checks are off.</p>
</div><div className="settings-field">
      <label htmlFor="ignore-prefixes">Ignore prefixes <span className="hint">(optional)</span></label>
      <textarea id="ignore-prefixes" {...field('ignorePrefixes', 'ignore-help')} rows="4" spellCheck={false} value={settings.ignorePrefixes} onChange={e => update('ignorePrefixes', e.target.value)} placeholder={'example.com/logout\n/logout\nregex: example\\.com/(logout|signout)'}/>
      {feedback('ignorePrefixes')}
      <p id="ignore-help" className="hint">One prefix per line. Plain host/path prefixes are supported. A /path rule matches at any path segment: /logout also ignores /user/logout. For regex, use regex: followed by a pattern matching the beginning of host/path. Escaped patterns such as www\.example.com/logout also work. Default: blank. Matching URLs are never requested. Redirects are followed only when their destination does not match an ignore rule.</p>
</div></div>
      </details>
    </fieldset>

    <fieldset className="scan-options" disabled={disabled}>
      <legend>Requests</legend>
      <div className="settings-fields"><div className="settings-field"><label htmlFor="timeout">Timeout (seconds)</label>
      <input id="timeout" {...field('timeoutSeconds', '')} type="number" min="1" max="2147483" step="1" required value={settings.timeoutSeconds} onChange={e => update('timeoutSeconds', e.target.value)}/>
      {feedback('timeoutSeconds')}
      <p className="hint">Maximum time for each request, including downloading the page. Default: 10 seconds.</p>
      </div><div className="settings-field"><label htmlFor="request-rate">Rate limit (requests per minute)</label>
      <input id="request-rate" {...field('requestsPerMinute', '')} type="number" min="0" max={Number.MAX_SAFE_INTEGER} step="1" required value={settings.requestsPerMinute} onChange={e => update('requestsPerMinute', e.target.value)}/>
      {feedback('requestsPerMinute')}
      <p className="hint">0 means unlimited. Otherwise, requests are spaced evenly across all hosts. Automatic redirects may make additional requests.</p>
      </div></div>
    </fieldset>
    <details className="settings-disclosure settings-section">
      <summary>Content checks<span>Require or forbid text and HTML content</span></summary>
      <div className="disclosure-body">
    <fieldset className="scan-options" disabled={disabled}>
      <legend>Content checks</legend>
      <p className="settings-description">Require or forbid content on fetched pages. Leave blank to disable.</p>
      <div className="settings-fields">{['checkPresence', 'checkAbsence'].map(key => <div className="settings-field" key={key}>
        <label htmlFor={key}>{key === 'checkPresence' ? 'Check presence' : 'Check absence'} <span className="hint">(optional)</span></label>
        <textarea id={key} {...field(key, 'content-help')} rows="3" spellCheck={false} value={settings[key]} onChange={e => update(key, e.target.value)} placeholder={key === 'checkPresence' ? '<title>Example</title>' : 'regex:Error|Exception'}/>
        {feedback(key)}
      </div>)}</div>
      <p id="content-help" className="hint">Enter plain text, HTML, or regex:pattern. Matching is case-sensitive against raw source, including whitespace and newlines. Checks include external pages when enabled. Scripts are not rendered; non-text responses and downloads over 2 MB are not checked.</p>
    </fieldset>
      </div>
    </details>
    <details className="settings-disclosure settings-section">
      <summary>Authentication<span>Browser cookies & HTTP credentials</span></summary>
      <div className="disclosure-body">    <fieldset className="scan-options" disabled={disabled}>
      <legend>HTTP authentication</legend>
      <label className="checkbox-label"><input id="browser-cookies" {...field('useBrowserCookies', 'cookies-help')} type="checkbox" checked={settings.useBrowserCookies} onChange={e => update('useBrowserCookies', e.target.checked)}/>Use browser cookies</label>
      {feedback('useBrowserCookies')}
      <p id="cookies-help" className="hint">Use existing logins from this Chrome profile. Each checked site, including external links and redirects, receives its own matching cookies. Default: off. Browser cookie rules still apply; log in to the website first.</p>
      <label htmlFor="auth-username">Username</label>
      <input id="auth-username" {...field('username', 'auth-help')} type="text" autoComplete="off" spellCheck={false} value={settings.username} onChange={e => update('username', e.target.value)}/>
      {feedback('username')}
      <p className="hint">Default: blank (not used).</p>
      <label htmlFor="auth-password">Password</label>
      <input id="auth-password" {...field('password', 'auth-help')} type="password" autoComplete="new-password" value={settings.password} onChange={e => update('password', e.target.value)}/>
      {feedback('password')}
      <p id="auth-help" className="hint">Leave both blank to disable Basic HTTP authentication. Credentials apply only to the starting origin (same scheme, host, and port), and reset when this page reloads. Use an HTTPS starting URL for authenticated scans.</p>
    </fieldset></div>
    </details>
    <details className="settings-disclosure settings-section">
      <summary>Custom headers<span>Additional request headers</span></summary>
      <div className="disclosure-body">    <fieldset className="scan-options" disabled={disabled}>
      <legend>Custom headers</legend>
      <label htmlFor="custom-headers">Request headers</label>
      <textarea id="custom-headers" {...field('headers', 'headers-help')} rows="5" spellCheck={false} autoComplete="off" value={settings.headers} onChange={e => update('headers', e.target.value)}/>
      {feedback('headers')}
      <p id="headers-help" className="hint">One Header-Name: value per line. Default: X-Scanned-By: LinkSlope. Clear to send no custom headers. Headers go to all checked URLs, including external links and redirects; avoid secrets here. Authorization is limited to the starting origin and cannot be combined with Basic authentication. Browser-controlled headers are unavailable.</p>
    </fieldset></div>
    </details>
  </div>;
}
