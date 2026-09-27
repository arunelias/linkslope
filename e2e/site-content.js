export const stylesheet = `
* { box-sizing: border-box; }
body { margin: 0; background: #f1f5f9; color: #172b43; font: 17px/1.6 system-ui, sans-serif; }
main { max-width: 1040px; margin: auto; padding: 48px 24px; }
h1 { font-size: clamp(32px, 5vw, 52px); line-height: 1.1; margin: 12px 0; }
h2 { margin-top: 0; } a { color: #0759b8; } li { margin: 8px 0; }
.eyebrow { color: #52647b; text-transform: uppercase; letter-spacing: .12em; font-size: 13px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; }
section { background: white; border: 1px solid #d7e1ec; border-radius: 16px; padding: 24px; margin-top: 24px; }
img { max-width: 100%; border-radius: 12px; } figure { margin: 16px 0; }
figcaption, .hint { font-size: 14px; color: #52647b; }
button { background: #0759b8; color: white; border: 0; padding: 12px 20px; border-radius: 8px; cursor: pointer; font: inherit; }
code { overflow-wrap: anywhere; } .status { padding: 12px; background: #eef6ff; border-radius: 8px; }
`;

export const script = `
document.querySelector('#local-script').textContent = 'Local JavaScript loaded successfully.';
document.querySelector('#demo-button').addEventListener('click', () => {
  document.querySelector('#demo-result').textContent = 'The button works. This text was added by JavaScript.';
});
`;

export const externalScript = `document.querySelector('#external-script').textContent = 'External JavaScript loaded successfully.';`;

export function illustration(external = false) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="260" viewBox="0 0 560 260"><rect width="560" height="260" fill="${external ? '#d9f5eb' : '#dceaff'}"/><circle cx="430" cy="65" r="32" fill="${external ? '#139579' : '#377ee8'}"/><path d="M0 260 160 65 290 210 375 125 560 260" fill="${external ? '#167d70' : '#254d89'}"/><text x="24" y="235" font-family="sans-serif" font-size="20" fill="white">${external ? 'External origin' : 'Local image'} · SVG landscape</text></svg>`;
}

export function resourcePage(externalUrl) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LinkSlope resource playground</title>
<link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="${externalUrl}/assets/external.css">
<link rel="stylesheet" href="/assets/missing.css"><link rel="stylesheet" href="${externalUrl}/assets/missing.css">
<script defer src="/assets/site.js"></script><script defer src="${externalUrl}/assets/external.js"></script>
<script defer src="/assets/missing.js"></script><script defer src="${externalUrl}/assets/missing.js"></script>
</head><body><main><div class="eyebrow">LinkSlope / local test website</div><h1>Links & resources playground</h1>
<p>A mix of working and deliberately broken images, stylesheets, scripts, and links.</p>
<p class="hint">Enable <strong>Crawl resources like images, stylesheets, and scripts</strong> in Advanced crawl settings. Enable <strong>Test external URLs</strong> to check the second origin.</p>
<div class="grid"><section><h2>Local resources</h2><figure><img src="/assets/landscape.svg" alt="Blue mountain landscape" width="560" height="260"><figcaption>Working local SVG image (200)</figcaption></figure>
<p><img src="/assets/missing.svg" alt="Deliberately missing local image (404)"></p>
<p id="local-script" class="status">Local JavaScript has not loaded.</p><button id="demo-button">Try local JavaScript</button><p id="demo-result" aria-live="polite"></p>
<p>Local CSS styles this page. Missing CSS and JS files intentionally return 404.</p></section>
<section><h2>External resources</h2><figure><img src="${externalUrl}/assets/landscape.svg" alt="Green mountain landscape from external origin" width="560" height="260"><figcaption>Working external SVG image (200)</figcaption></figure>
<p><img src="${externalUrl}/assets/missing.svg" alt="Deliberately missing external image (404)"></p>
<p id="external-script" class="status">External JavaScript has not loaded.</p><p class="external-style">A green border here confirms external CSS loaded.</p>
<p class="hint">External origin: <code>${externalUrl}</code>. A different port makes this a separate origin, even though both servers run locally.</p></section></div>
<section><h2>Links to check</h2><ul><li><a href="/healthy">Working local page</a></li><li><a href="/missing">Missing local page (404)</a></li><li><a href="/redirect">Local redirect (302)</a></li><li><a href="${externalUrl}/page">Working external page</a></li><li><a href="${externalUrl}/missing">Missing external page (404)</a></li><li><a href="${externalUrl}/redirect">External redirect (302)</a></li></ul></section>
</main></body></html>`;
}
