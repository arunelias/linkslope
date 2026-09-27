import { readFile } from 'node:fs/promises';
import { test, expect, configure, start, complete, row } from './fixtures.js';

test('loads the extension and validates settings before making requests', async ({ page, site }) => {
  await expect(page.getByRole('button', { name: 'Start scan', exact: true })).toBeEnabled();
  await expect(page.getByText('Preview mode.', { exact: false })).toHaveCount(0);
  await configure(page);
  await page.getByLabel('Timeout (seconds)', { exact: true }).fill('0');
  await start(page, site.url);
  await expect(page.getByLabel('Timeout (seconds)', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Please correct the highlighted settings before continuing.')).toBeVisible();
  expect(site.requests).toEqual([]);
  await page.getByLabel('Timeout (seconds)', { exact: true }).fill('10');
  await page.getByRole('button', { name: 'Start scan', exact: true }).click();
  await complete(page);
});

test('crawls, classifies, searches and filters real HTTP responses', async ({ page, site }) => {
  await configure(page);
  await start(page, site.url);
  await complete(page);
  await expect(row(page, `${site.url}/missing`)).toContainText('404 · Broken');
  await expect(row(page, `${site.url}/healthy`)).toContainText('200 · Working');
  await expect(row(page, `${site.url}/redirect`)).toContainText(`Redirects to ${site.url}/healthy`);
  await expect(row(page, 'https://external.invalid/')).toContainText('Skipped');
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await page.getByRole('button', { name: /^Issues/ }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: /^All links/ }).click();
  await page.getByRole('textbox', { name: 'Search URLs' }).fill('/healthy');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(row(page, `${site.url}/healthy`)).toBeVisible();
});

test('inspects source HTML and re-tests a repaired link', async ({ page, site }) => {
  await configure(page);
  await start(page, site.url);
  await complete(page);
  const inspect = page.getByRole('button', { name: `Inspect details for ${site.url}/missing`, exact: true });
  await inspect.click();
  const dialog = page.getByRole('dialog', { name: 'Link details', exact: true });
  await expect(dialog).toContainText('Source pages (4)');
  await dialog.locator('.source-excerpt summary').first().click();
  await expect(dialog.locator('code').first()).toContainText('href="/missing"');
  site.repair();
  await dialog.getByRole('button', { name: 'Re-test link' }).click();
  await expect(dialog.getByRole('status')).toContainText('Re-test complete: Working');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(inspect).toBeFocused();
  await expect(row(page, `${site.url}/missing`)).toContainText('200 · Working');
  await expect(page.getByRole('button', { name: /^Issues/ })).toHaveText('Issues (0)');
});

test('paginates and exports all results despite the active search', async ({ page, site }) => {
  await configure(page);
  await start(page, `${site.url}/many`);
  await complete(page);
  await page.getByLabel('Rows per page').selectOption('10');
  await expect(page.locator('tbody tr')).toHaveCount(10);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.getByRole('textbox', { name: 'Search URLs' }).fill('/item/11');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  for (const format of ['json', 'csv']) {
    await page.getByLabel('Report download format').selectOption(format);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
    const content = await readFile(await download.path(), 'utf8');
    if (format === 'json') {
      const report = JSON.parse(content);
      expect(report).toMatchObject({ status: 'complete', partial: false, summary: { discovered: 13, checked: 13 } });
      expect(report.records).toHaveLength(13);
    } else {
      expect(content).toContain('"HTTP status"');
      expect(content).toContain(`${site.url}/item/0`);
      expect(content).toContain(`${site.url}/item/11`);
    }
  }
});

test('pauses an active scan, allows edits, and resumes queued work', async ({ page, site }) => {
  await configure(page);
  await start(page, `${site.url}/slow`);
  await expect.poll(() => site.requests.includes('/slow')).toBe(true);
  await expect(page.getByLabel('Timeout (seconds)', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByLabel('Timeout (seconds)', { exact: true })).toBeEnabled();
  await page.getByLabel('Timeout (seconds)', { exact: true }).fill('15');
  site.release();
  await expect(row(page, `${site.url}/slow`)).toContainText('200 · Working');
  expect(site.requests).not.toContain('/after');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await complete(page);
  expect(site.requests).toContain('/after');
});

test('stops an in-flight request and preserves a downloadable partial report', async ({ page, site }) => {
  await configure(page);
  await start(page, `${site.url}/slow`);
  await expect.poll(() => site.requests.includes('/slow')).toBe(true);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Scan stopped.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start scan', exact: true })).toBeEnabled();
  await page.getByLabel('Report download format').selectOption('json');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await pending;
  expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toMatchObject({ status: 'stopped', partial: true });
  expect(site.requests).not.toContain('/after');
});

test('blocks excluded redirect destinations using Chrome redirect observation', async ({ page, site }) => {
  await configure(page);
  await page.locator('summary').filter({ hasText: 'Advanced crawl settings' }).click();
  await page.getByLabel('Ignore prefixes').fill('/healthy');
  await start(page, `${site.url}/redirect`);
  await complete(page);
  await expect(row(page, `${site.url}/redirect`)).toContainText('Skipped');
  expect(site.requests).toContain('/redirect');
  expect(site.requests).not.toContain('/healthy');
});

test('reports content failures even when the HTTP response is healthy', async ({ page, site }) => {
  await configure(page);
  await page.locator('summary').filter({ hasText: 'Content checks' }).click();
  await page.getByLabel('Check presence').fill('Required content');
  await start(page, `${site.url}/after`);
  await complete(page);
  await expect(row(page, `${site.url}/after`)).toContainText('200 · Working');
  await expect(row(page, `${site.url}/after`)).toContainText('Failed');
  await page.getByRole('button', { name: /^Issues/ }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
});

for (const external of [false, true]) {
  test(`checks local assets with external requests ${external ? 'enabled' : 'disabled'}`, async ({ page, site }) => {
    await configure(page);
    await page.getByLabel('Test external URLs', { exact: true }).setChecked(external);
    await page.locator('summary').filter({ hasText: 'Advanced crawl settings' }).click();
    await page.getByLabel('Crawl resources like images, stylesheets, and scripts', { exact: true }).check();
    await start(page, `${site.url}/resources`);
    await complete(page);
    await page.getByLabel('Rows per page').selectOption('100');
    for (const asset of ['landscape.svg', 'site.css', 'site.js']) {
      await expect(row(page, `${site.url}/assets/${asset}`)).toContainText('200 · Working');
    }
    for (const asset of ['missing.svg', 'missing.css', 'missing.js']) {
      await expect(row(page, `${site.url}/assets/${asset}`)).toContainText('404 · Broken');
      await expect(row(page, `${site.externalUrl}/assets/${asset}`)).toContainText(external ? '404 · Broken' : 'Skipped');
    }
    for (const asset of ['landscape.svg', 'external.css', 'external.js']) {
      await expect(row(page, `${site.externalUrl}/assets/${asset}`)).toContainText(external ? '200 · Working' : 'Skipped');
    }
    await expect(row(page, `${site.externalUrl}/page`)).toContainText(external ? '200 · Working' : 'Skipped');
    await expect(row(page, `${site.externalUrl}/missing`)).toContainText(external ? '404 · Broken' : 'Skipped');
    if (!external) expect(site.externalRequests).toEqual([]);
  });
}

test('the resource playground renders images and runs both scripts in a browser', async ({ page, site }) => {
  await page.goto(`${site.url}/resources`);
  await expect(page.locator('#local-script')).toHaveText('Local JavaScript loaded successfully.');
  await expect(page.locator('#external-script')).toHaveText('External JavaScript loaded successfully.');
  await page.getByRole('button', { name: 'Try local JavaScript' }).click();
  await expect(page.locator('#demo-result')).toContainText('The button works.');
  for (const alt of ['Blue mountain landscape', 'Green mountain landscape from external origin']) {
    await expect.poll(() => page.getByAltText(alt, { exact: true }).evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  }
  await expect(page.locator('.external-style')).toHaveCSS('border-top-color', 'rgb(19, 149, 121)');
});
