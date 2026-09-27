import assert from 'node:assert/strict';
import test from 'node:test';
import { browserCases, runPrivateBrowserCase } from '../.browser-build/browser.js';

// Every real-browser case is a Node TAP test, including prerequisite failures.
// A missing executable is never a passing skip or DOM mock.
for (const caseId of browserCases) {
  test(caseId, async t => {
    const result = await runPrivateBrowserCase(caseId);
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.status, 'passed', result.status);
    assert.equal(result.contextsClosed, caseId === 'B02_PARTIAL_BROWSER' ? 0 : caseId === 'B03_PARTIAL_CONTEXT' ? 1 : 2);
    assert.equal(result.browsersClosed, 1);
    assert.equal(result.listenersClosed, 3);
    assert.equal(result.artifactsRemoved, 1);
    assert.ok(result.checks > 0);
  });
}
