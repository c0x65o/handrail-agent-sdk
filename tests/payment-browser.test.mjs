import assert from 'node:assert/strict';
import test from 'node:test';
import { runPrivateBrowserCase } from '../.browser-build/browser.js';
test('C01_CARD_FILL: private card field and destination fixture', async t => {
  const result = await runPrivateBrowserCase('C01_CARD_FILL');
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.status, 'passed');
  assert.equal(result.stage, 'complete');
  assert.equal(result.contextsClosed, 1);
  assert.equal(result.browsersClosed, 1);
  assert.equal(result.listenersClosed, 3);
  assert.equal(result.artifactsRemoved, 1);
});
