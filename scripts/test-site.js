import { startTestSite } from '../e2e/test-site.js';

const port = Number(process.env.PORT || 4174);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const externalPort = Number(process.env.EXTERNAL_PORT || 4175);
if (!Number.isInteger(externalPort) || externalPort < 1 || externalPort > 65535 || externalPort === port) {
  throw new Error('EXTERNAL_PORT must be between 1 and 65535 and different from PORT.');
}
const site = await startTestSite({ port, externalPort, slowDelayMs: 5000 });
console.log(`Test website: ${site.url}`);
console.log(`Resource playground: ${site.url}/resources`);
console.log(`External origin: ${site.externalUrl}`);
console.log('Routes: /healthy (200), /missing (404), /redirect (302), /many (pagination), /slow (5-second delay)');
console.log('For the same scan as Playwright, disable "Read URLs from robots.txt and sitemap.xml" in the extension settings.');
console.log('Press Ctrl+C to stop.');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await site.close(); process.exit(0); });
}
