import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { portalHeaders, portalPage } from '../dist/server/managed/portal.js';
import { hostedApprovalPage } from '../dist/server/managed/hosted-approval.js';

test('real browser private forms preserve CSRF origin without disclosing the private link', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const origin = 'https://private-portal.example.test';
    const path = `/agent-access/${'a'.repeat(64)}`;
    const csrf = 'test-only-csrf';
    const submissions = [];
    let html;
    await context.route(`${origin}/**`, async route => {
      const request = route.request();
      if (request.method() === 'POST') {
        submissions.push({ headers: await request.allHeaders(), form: new URLSearchParams(request.postData()) });
        await route.fulfill({ status: 200, body: 'Saved' });
      } else await route.fulfill({ status: 200, headers: portalHeaders('fixture-nonce'), body: html });
    });
    const page = await context.newPage();
    html = hostedApprovalPage({ csrf, path, nonce: 'fixture-nonce', action: {
      type: 'computer_use_approval_request', request_id: 'original-request', turn_id: 'original-turn',
      request: { type: 'browser_origin_access', origin: 'https://example.com', reason: null },
    } });
    await page.goto(origin + path);
    await page.getByRole('button', { name: 'Allow this website', exact: true }).click();
    await page.waitForLoadState();
    assert.equal(submissions[0].form.get('decision'), 'approve');
    html = portalPage({ csrf, path, nonce: 'fixture-nonce', kind: 'credentials', label: 'Test account', url: 'https://example.com' });
    await page.goto(origin + path);
    await page.getByLabel('Username or membership number').fill('test-user');
    await page.getByLabel('Password', { exact: true }).fill('test-only-secret');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Save securely and continue' }).click();
    await page.waitForLoadState();
    assert.equal(submissions.length, 2);
    for (const { headers, form } of submissions) {
      assert.equal(headers.origin, origin);
      assert.equal(headers.referer, `${origin}/`);
      assert.equal(form.get('csrf'), csrf);
    }
  } finally { await browser.close(); }
});
