import assert from 'node:assert/strict';
import test from 'node:test';
import { publicSdkGitSpec, assertSdkGitLock, publicAssistantGitSpec, assertAssistantGitLock } from './helpers/git-consumer-contract.mjs';

const sha = '4d1f995e2bf337fb4ad9552bb675dade0f633fdb';
const spec = publicSdkGitSpec(sha);
const manifest = { dependencies: { 'handrail-agent-sdk': spec } };
const lock = resolved => ({ lockfileVersion: 3, packages: {
  '': structuredClone(manifest),
  'node_modules/handrail-agent-sdk': { version: '0.1.3', resolved },
} });

test('requires public HTTPS and full SHA in both manifest and resolved lock', () => {
  assertSdkGitLock(manifest, lock(spec), sha);
  for (const invalid of ['main', 'v0.1.3', sha.slice(0, 7), '', undefined]) {
    assert.throws(() => publicSdkGitSpec(invalid), /FULL_GIT_SHA_REQUIRED/);
  }
});

test('assistant consumer URL preserves the frozen public SHA with npm HTTPS resolution', () => {
  const bare = `git+https://github.com/c0x65o/handrail-sdk-ai-assistant-js.git#${sha}`;
  const https = bare.replace('https://', 'https://git@');
  assert.equal(publicAssistantGitSpec(bare), https);
  assert.equal(publicAssistantGitSpec(https), https);
  for (const invalid of [bare.replace('https:', 'ssh:'), bare.replace(sha, 'main'),
    bare.replace(sha, sha.slice(0, 7)), bare.replace('c0x65o', 'other'), 'file:../assistant', undefined]) {
    assert.throws(() => publicAssistantGitSpec(invalid), /ASSISTANT_PUBLIC_FULL_SHA_REQUIRED/);
  }
  const assistantLock = { packages: { 'node_modules/@handrail/ai-assistant': { resolved: https } } };
  assertAssistantGitLock(assistantLock, https);
  assert.throws(() => assertAssistantGitLock({ packages: {} }, https), /ASSISTANT_LOCK_MISSING/);
  for (const resolved of [bare, https.replace('https:', 'ssh:'), https.replace(sha, '0'.repeat(40))]) {
    assistantLock.packages['node_modules/handrail-agent-sdk/node_modules/@handrail/ai-assistant'] = { resolved };
    assert.throws(() => assertAssistantGitLock(assistantLock, https), /ASSISTANT_RESOLVED_LOCK_MISMATCH/);
  }
  assistantLock.packages['node_modules/handrail-agent-sdk/node_modules/@handrail/ai-assistant'] = { resolved: https };
  assert.throws(() => assertAssistantGitLock(assistantLock, https), /ASSISTANT_MUST_HAVE_SINGLE_IDENTITY/);
});

test('rejects SSH even with matching SHA, repository drift and alternate sources', () => {
  for (const invalid of [spec.replace('git+https:', 'git+ssh:'), spec.replace(/.$/, '0'),
    spec.replace('c0x65o', 'other'), spec.replace(/#[^#]+$/, '#main'), 'file:../sdk', 'https://example.com/sdk.tgz']) {
    assert.throws(() => assertSdkGitLock(manifest, lock(invalid), sha), /SDK_RESOLVED_LOCK_MISMATCH/);
  }
  assert.throws(() => assertSdkGitLock({ dependencies: {} }, lock(spec), sha), /SDK_MANIFEST_MISMATCH/);
  const mismatch = lock(spec);
  mismatch.packages[''].dependencies['handrail-agent-sdk'] = spec.replace(/.$/, '0');
  assert.throws(() => assertSdkGitLock(manifest, mismatch, sha), /SDK_ROOT_LOCK_MISMATCH/);
});
