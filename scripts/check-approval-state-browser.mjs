import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const destination = process.env.HANDRAIL_TEST_SCREENSHOTS ?? '/tmp/handrail-approval-state';
await mkdir(destination, { recursive: true });
const server = await createServer({ configFile: false, optimizeDeps: { entries: ['tests/assistant/fixtures/approval-reliability-browser.html'] }, server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true,
    ...(process.env.HANDRAIL_TEST_CHROMIUM ? { executablePath: process.env.HANDRAIL_TEST_CHROMIUM } : {}) });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const viewport of [{ width: 1000, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${server.resolvedUrls.local[0]}tests/assistant/fixtures/approval-reliability-browser.html`);
    const status = page.getByRole('region', { name: 'Current request' });
    await status.getByText('Waiting for approval', { exact: true }).waitFor();
    await page.screenshot({ path: `${destination}/${viewport.width}-pending.png`, fullPage: true });
    await page.getByRole('button', { name: 'confirmed', exact: true }).click();
    await status.getByText('Approved · awaiting execution', { exact: true }).waitFor();
    assert.equal(await page.getByText('Waiting for approval', { exact: true }).count(), 0);
    assert.equal(await status.getAttribute('data-phase'), 'waiting');
    await page.screenshot({ path: `${destination}/${viewport.width}-confirmed.png`, fullPage: true });
    await page.getByRole('button', { name: 'failed', exact: true }).click();
    await status.getByText('Request failed', { exact: true }).waitFor();
    assert.equal(await status.getAttribute('data-phase'), 'attention');
    assert.equal(await page.getByText('Approved · execution interrupted', { exact: true }).count(), 2);
    assert.equal(await page.locator('[data-tool-status=approval_interrupted]').count(), 1);
    assert.equal(await page.getByText('Continuing…', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${destination}/${viewport.width}-failed.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('Desktop and mobile-width approval/action/footer states passed; screenshots:', destination);
} finally { await browser?.close(); await server.close(); }
