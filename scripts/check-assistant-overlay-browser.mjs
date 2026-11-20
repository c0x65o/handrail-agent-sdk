import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const fixture = 'tests/assistant/fixtures/single-conversation-browser.html';
const server = await createServer({ configFile: false, optimizeDeps: { entries: [fixture] }, server: { host: '127.0.0.1', port: 0 } });
const screenshots = process.env.HANDRAIL_TEST_SCREENSHOTS;
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.HANDRAIL_TEST_CHROMIUM });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const url = server.resolvedUrls.local[0] + fixture;
  const button = name => page.getByRole('button', { name, exact: true });
  const capture = async name => {
    if (screenshots) await page.screenshot({ path: screenshots + '/' + name + '.png' });
  };
  if (screenshots) await mkdir(screenshots, { recursive: true });
  await page.goto(url);
  await button('Clear conversation').waitFor();
  await capture('reference');
  await page.goto(url + '?overlay');
  const width = () => page.locator('#page').evaluate(node => node.getBoundingClientRect().width);
  const initialWidth = await width();
  const open = async () => {
    await page.locator('.hr-chat__launcher-trigger').click();
    await button('Clear conversation').waitFor();
    await page.getByText('Your saved conversation is ready.').waitFor();
  };
  const panel = page.getByRole('dialog');
  await open();
  assert.equal(await page.getByText(/^(History|Threads)$/).count(), 0);
  assert.equal(await width(), initialWidth);
  assert.equal(await panel.evaluate(node => getComputedStyle(node).position), 'fixed');
  assert.notEqual(await panel.evaluate(node => getComputedStyle(node).boxShadow), 'none');
  const normal = await panel.boundingBox();
  assert.ok(normal.x > 0 && normal.x + normal.width <= initialWidth);
  await capture('overlay');
  await button('Expand').click();
  assert.ok((await panel.boundingBox()).width > normal.width);
  assert.equal(await width(), initialWidth);
  await button('Collapse').click();
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  await open();
  await page.locator('.hr-chat__backdrop').click({ position: { x: 4, y: 4 } });
  await panel.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  const mobile = await panel.boundingBox();
  assert.equal(mobile.x, 0);
  assert.equal(mobile.width, 390);
  await capture('mobile');
  await button('Close assistant').click();
  await panel.waitFor({ state: 'hidden' });
  console.log('Desktop, expanded, mobile, dismissal and single-conversation checks passed.');
} finally {
  await browser?.close();
  await server.close();
}
