import { createServer } from 'node:http';
import { once } from 'node:events';
import { stylesheet, script, externalScript, illustration, resourcePage } from './site-content.js';

// Shared by Playwright and the standalone website. Port 0 isolates test runs.
export async function startTestSite({ port = 0, externalPort = 0, slowDelayMs } = {}) {
  const requests = [];
  const externalRequests = [];
  const externalServer = createServer((req, res) => {
    externalRequests.push(req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (body, type, status = 200) => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
    switch (req.url) {
      case '/assets/landscape.svg': return send(illustration(true), 'image/svg+xml');
      case '/assets/external.css': return send('.external-style { border: 2px solid #139579; padding: 12px; border-radius: 8px; }', 'text/css');
      case '/assets/external.js': return send(externalScript, 'text/javascript');
      case '/page': return send('<!doctype html><title>External page</title><h1>Working external page</h1><p>This page is served from a separate local origin.</p>', 'text/html');
      case '/redirect': res.writeHead(302, { Location: '/page' }); return res.end();
      default: return send('Deliberately missing external resource', 'text/plain', 404);
    }
  });
  externalServer.listen(externalPort, '127.0.0.1');
  await once(externalServer, 'listening');
  const externalUrl = `http://127.0.0.1:${externalServer.address().port}`;
  const heldResponses = new Set();
  let fixed = false;
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const send = (body, status = 200) => { res.statusCode = status; res.end(body); };
    switch (req.url) {
      case '/': return send('<!doctype html><title>LinkSlope test website</title><h1>LinkSlope test website</h1><p><a href="/resources">Open the images, CSS, JavaScript and external resources playground</a></p><a href="/healthy">Healthy</a> <a href="/missing">Missing</a> <a href="/redirect">Redirect</a> <a href="https://external.invalid/">External</a>');
      case '/resources': return send(resourcePage(externalUrl));
      case '/assets/site.css': res.setHeader('Content-Type', 'text/css'); return send(stylesheet);
      case '/assets/site.js': res.setHeader('Content-Type', 'text/javascript'); return send(script);
      case '/assets/landscape.svg': res.setHeader('Content-Type', 'image/svg+xml'); return send(illustration());
      case '/healthy': return send('<title>Healthy</title><a href="/missing">Another missing link</a>');
      case '/missing': return send(fixed ? 'Repaired' : 'Not found', fixed ? 200 : 404);
      case '/redirect': res.writeHead(302, { Location: '/healthy' }); return res.end();
      case '/many': return send(Array.from({ length: 12 }, (_, i) => `<a href="/item/${i}">Item ${i}</a>`).join(' '));
      case '/slow': {
        heldResponses.add(res);
        const timer = slowDelayMs === undefined ? undefined : setTimeout(() => res.end('<a href="/after">Next page</a>'), slowDelayMs);
        res.on('close', () => { clearTimeout(timer); heldResponses.delete(res); });
        return;
      }
      case '/after': return send('Finished');
      default: return /^\/item\/\d+$/.test(req.url) ? send('Healthy item') : send('Not found', 404);
    }
  });
  server.listen(port, '127.0.0.1');
  try { await once(server, 'listening'); }
  catch (error) { await new Promise(resolve => externalServer.close(resolve)); throw error; }
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    externalUrl,
    externalRequests,
    repair: () => { fixed = true; },
    release: () => { for (const response of heldResponses) response.end('<a href="/after">Next page</a>'); },
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      externalServer.closeAllConnections();
      await new Promise(resolve => externalServer.close(resolve));
    },
  };
}
