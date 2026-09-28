import assert from 'node:assert/strict';
import test from 'node:test';
import { boundaryCases, runPrivateBrowserCase } from '../.browser-build/browser.js';

// These prove harness boundaries only; they do not count as browser evidence.
for (const caseId of boundaryCases) {
  test(caseId, async t => {
    const result = await runPrivateBrowserCase(caseId);
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.status, 'passed');
    assert.equal(result.stage, caseId === 'F01_NETWORK_POLICY' ? 'complete' : caseId === 'F02_PARTIAL_LISTENER' ? 'fixtures' : 'output_gate');
    assert.deepEqual(Object.keys(result).sort(), [
      'artifactsRemoved', 'browsersClosed', 'caseId', 'checks', 'contextsClosed', 'listenersClosed', 'stage', 'status',
    ]);
    assert.equal(result.contextsClosed, 0);
    assert.equal(result.browsersClosed, 0);
    assert.equal(result.listenersClosed, caseId === 'F01_NETWORK_POLICY' ? 3 : caseId === 'F02_PARTIAL_LISTENER' ? 1 : 0);
    assert.equal(result.artifactsRemoved, 1);
    assert.ok(result.checks > 0);
  });
}
