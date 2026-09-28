import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { recipeTable, validateMetaRecipe } from '../scripts/validate-meta-v1.mjs';

const baseline = JSON.parse(readFileSync(new URL('../docs/providers/meta-v1.recipe.json', import.meta.url), 'utf8'));
const document = readFileSync(new URL('../docs/providers/meta-v1.md', import.meta.url), 'utf8');
function reject(change, code) {
  const m = structuredClone(baseline);
  change(m);
  assert.deepEqual(validateMetaRecipe(m), { ok: false, code });
}

test('frozen recipe and document agree; validation grants no readiness', () => {
  assert.deepEqual(validateMetaRecipe(baseline, document), {
    ok: true, operationCount: 8, proof: 'recipe_consistency_only',
  });
  assert.equal(baseline.account.ready, false);
  assert.ok(baseline.operations.every(o => !o.enabled));
});
test('local prerequisite digests bind the inspected source bytes', () => {
  for (const source of baseline.provenance.localSources) {
    const bytes = readFileSync(new URL(`../${source.path}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
  }
});
test('all public evidence is linked in the document', () => {
  for (const s of baseline.publicSources) assert.ok(document.includes(`[${s.id}]: ${s.retrievedUrl}`));
});
test('missing, duplicate or relabelled public provenance fails closed', () => {
  reject(m => m.publicSources.pop(), 'missing_provenance');
  reject(m => m.publicSources[1] = m.publicSources[0], 'missing_provenance');
  reject(m => m.publicSources[0].sha256 = '', 'missing_provenance');
  reject(m => m.publicSources[0].reviewedAt = '2020-01-01', 'missing_provenance');
  reject(m => m.publicSources[0].retrievedUrl = 'https://example.invalid/docs', 'missing_provenance');
  reject(m => m.publicSources[0].httpStatus = 429, 'missing_provenance');
  reject(m => m.provenance.kind = 'provider', 'missing_provenance');
});
test('unknown host source cannot become claimed current source', () => {
  reject(m => m.provenance.hostSource.currentRevision = '0'.repeat(40), 'missing_provenance');
  reject(m => m.provenance.hostSource.dirtySourceDigests = [], 'missing_provenance');
  reject(m => m.provenance.hostSource.unresolvedPaths.pop(), 'missing_provenance');
});
test('missing SDK source or changed original authority is rejected', () => {
  reject(m => m.provenance.localSources.pop(), 'missing_provenance');
  reject(m => m.authority.itemId = 'fixture.other-item', 'invalid_authority');
});
for (const field of ['reference', 'environment', 'authorityRef', 'ready', 'status']) {
  test(`no guessed account readiness: ${field}`, () => reject(m => {
    m.account[field] = field === 'ready' ? true : 'fixture.claimed';
  }, 'guessed_account_readiness'));
}
for (const [name, change] of [
  ['extra scope', m => m.tokenPolicy.requestedScopes.push('ads_management')],
  ['missing ads_read', m => m.tokenPolicy.requestedScopes = []],
  ['Page token substitution', m => m.tokenPolicy.class = 'page'],
  ['guessed TTL', m => m.tokenPolicy.lifetime = 5184000],
  ['background refresh', m => m.tokenPolicy.refresh = 'automatic'],
  ['token-presence reconnect', m => m.tokenPolicy.reconnect = 'reuse_cached_token'],
]) test(name, () => reject(change, 'unsupported_token_policy'));
test('source inventory cannot qualify or select an adapter', () => {
  reject(m => m.adapters[0].qualification = 'qualified', 'unqualified_adapter');
  reject(m => m.adapters[0].selected = true, 'unqualified_adapter');
  reject(m => m.adapters[0].seam = 'invented qualified browser executor', 'unqualified_adapter');
  reject(m => m.adapters.pop(), 'unqualified_adapter');
});
test('prerequisite ownership and citations cannot be waived or swapped', () => {
  reject(m => m.prerequisites.pop(), 'invalid_prerequisite');
  reject(m => m.prerequisites[0].sourceRefs = [], 'invalid_prerequisite');
  reject(m => m.prerequisites[1].owner = 'model', 'invalid_prerequisite');
  reject(m => m.prerequisites[0].localRefs = [], 'invalid_prerequisite');
  reject(m => m.prerequisites[3].requirement = 'Consent is optional', 'invalid_prerequisite');
});
for (const operation of baseline.operations) {
  test(`${operation.id}: capability, prerequisites, authority and source mapping are fixed`, () => {
    for (const [field, value] of [
      ['capability', 'meta.ads.create'], ['prerequisiteRefs', []], ['sourceRefs', []],
      ['authorizationOwner', 'model'], ['adapterRef', 'browser'], ['enabled', true],
      ['endpoint', 'https://example.invalid/collect'], ['method', 'POST'], ['parameters', 'unbounded'],
    ]) reject(m => { m.operations.find(o => o.id === operation.id)[field] = value; }, 'unsupported_operation');
  });
}
test('missing, duplicate and invented operations cannot change the coverage floor', () => {
  reject(m => m.operations.pop(), 'unsupported_operation');
  reject(m => m.operations[1] = m.operations[0], 'unsupported_operation');
  reject(m => m.operations.push({ id: 'create-ad' }), 'unsupported_operation');
});
test('readiness requires both API reads and cannot claim setup as verification', () => {
  reject(m => m.minimumCapabilities = ['meta.setup.inspect'], 'unsupported_operation');
  reject(m => m.minimumCapabilities.pop(), 'unsupported_operation');
  reject(m => m.minimumCapabilities.push('meta.ads.create'), 'unsupported_operation');
});
for (const field of Object.keys(baseline.boundaries)) {
  test(`fail-closed boundary cannot be weakened: ${field}`, () => reject(m => {
    m.boundaries[field] = 'allow_retry_or_skip_check';
  }, 'unsafe_boundary'));
}
test('unsafe unknown exchange retry cannot hide in an extra property', () => reject(m => {
  m.boundaries.retryUnknownExchange = true;
}, 'unsafe_boundary'));
test('live-proof dependencies remain unresolved', () => reject(m => m.liveProofRequired.pop(), 'missing_live_prerequisite'));
test('document drift is detected independently of valid JSON', () => {
  for (const d of [document.replace('meta-v1.2026-09-28', 'meta-v2'),
    document.replace('Graph API pin: `v25.0`', 'Graph API pin: `v99.0`'),
    document.replace(recipeTable(baseline), 'Missing operation mapping')]) {
    assert.deepEqual(validateMetaRecipe(baseline, d), { ok: false, code: 'document_mismatch' });
  }
});
test('unknown fields and provider payloads are rejected with fixed safe errors', () => reject(m => {
  m.rawProviderResponse = 'synthetic-sensitive-value';
}, 'invalid_manifest'));
test('null, malformed, sparse, cyclic and executable inputs fail without invoking getters', () => {
  let invoked = false;
  const getter = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { invoked = true; throw new Error('synthetic'); } });
  const hidden = Object.defineProperty(structuredClone(baseline), 'hidden', { value: 'synthetic' });
  const cycle = {}; cycle.self = cycle;
  const sparse = structuredClone(baseline); delete sparse.operations[1];
  for (const input of [null, [], {}, getter, hidden, cycle, sparse]) {
    assert.deepEqual(validateMetaRecipe(input), { ok: false, code: 'invalid_manifest' });
  }
  assert.equal(invoked, false);
});
