import { test as base, expect, chromium } from '@playwright/test';
import { startTestSite } from './test-site.js';
import { fileURLToPath } from 'node:url';

export const test = base.extend({
  // An empty userDataDir creates a temporary profile, isolated for every test.
  context: async ({ headless }, use) => {
    const extension = fileURLToPath(new URL('../dist', import.meta.url));
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless, acceptDownloads: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    try { await use(context); } finally { await context.close(); }
  },
  page: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await use(page);
  },
  site: async ({}, use) => {
    const site = await startTestSite();
    try { await use(site); } finally { await site.close(); }
  },
});
export { expect };

export async function configure(page) {
  await page.getByRole('button', { name: 'Scan settings' }).click();
  await page.getByLabel('Read URLs from robots.txt and sitemap.xml').uncheck();
}

export async function start(page, url) {
  await page.getByLabel('TARGET WEBSITE').fill(url);
  await page.getByRole('button', { name: 'Start scan', exact: true }).click();
}

export async function complete(page) {
  await expect(page.getByRole('status').filter({ hasText: 'Scan complete:' })).toBeVisible();
}

export function row(page, url) {
  return page.getByRole('row').filter({ has: page.getByRole('button', { name: `Inspect details for ${url}`, exact: true }) });
}

