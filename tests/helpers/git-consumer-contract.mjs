import assert from 'node:assert/strict';

export function publicSdkGitSpec(sha) {
  assert.match(sha ?? '', /^[a-f0-9]{40}$/, 'FULL_GIT_SHA_REQUIRED');
  // Literal public username (no password/token). In npm 10/pacote this preserves
  // HTTPS instead of canonicalizing a recognized GitHub URL to SSH.
  return `git+https://git@github.com/c0x65o/handrail-agent-sdk.git#${sha}`;
}

export function publicAssistantGitSpec(spec) {
  // Preserve the frozen dependency identity while selecting npm's HTTPS form.
  const match = /^git\+https:\/\/(?:git@)?github\.com\/c0x65o\/handrail-sdk-ai-assistant-js\.git#([a-f0-9]{40})$/.exec(spec ?? '');
  assert.ok(match, 'ASSISTANT_PUBLIC_FULL_SHA_REQUIRED');
  return `git+https://git@github.com/c0x65o/handrail-sdk-ai-assistant-js.git#${match[1]}`;
}

export function assertAssistantGitLock(lock, spec) {
  assert.equal(spec, publicAssistantGitSpec(spec), 'ASSISTANT_HTTPS_FORM_REQUIRED');
  const entries = Object.entries(lock.packages ?? {}).filter(([path]) => path.endsWith('node_modules/@handrail/ai-assistant'));
  assert.ok(entries.length > 0, 'ASSISTANT_LOCK_MISSING');
  for (const [, entry] of entries) {
    assert.equal(entry.resolved, spec, 'ASSISTANT_RESOLVED_LOCK_MISMATCH');
    assert.ok(!entry.link, 'ASSISTANT_MUST_NOT_BE_LINKED');
  }
}

export function assertSdkGitLock(manifest, lock, sha) {
  const spec = publicSdkGitSpec(sha);
  assert.equal(manifest.dependencies?.['handrail-agent-sdk'], spec, 'SDK_MANIFEST_MISMATCH');
  assert.equal(lock.packages?.['']?.dependencies?.['handrail-agent-sdk'], spec, 'SDK_ROOT_LOCK_MISMATCH');
  assert.equal(lock.packages?.['node_modules/handrail-agent-sdk']?.resolved, spec, 'SDK_RESOLVED_LOCK_MISMATCH');
  assert.ok(!lock.packages['node_modules/handrail-agent-sdk'].link, 'SDK_MUST_NOT_BE_LINKED');
}
