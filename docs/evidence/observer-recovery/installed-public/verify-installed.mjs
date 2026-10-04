import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.env.HANDRAIL_OBSERVER_AI_ENTRY, undefined, 'Source override must be absent');
const sha = '5c59f2f71830eb1f23cec28d56db51ca23d7cc3e';
const pin = `git+https://git@github.com/c0x65o/handrail-sdk-ai-assistant-js.git#${sha}`;
const root = process.cwd();
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const installed = JSON.parse(readFileSync('node_modules/@handrail/ai-assistant/package.json', 'utf8'));
assert.equal(pkg.dependencies['@handrail/ai-assistant'], pin);
assert.equal(lock.packages[''].dependencies['@handrail/ai-assistant'], pin);
assert.equal(lock.packages['node_modules/@handrail/ai-assistant'].resolved, pin);
assert.equal(installed.version, '0.2.75');
const installedLock = JSON.parse(readFileSync('node_modules/.package-lock.json', 'utf8'));
assert.equal(installedLock.packages['node_modules/@handrail/ai-assistant'].resolved, pin);
assert.equal(lock.packages['node_modules/@handrail/ai-assistant'].version, installed.version);
const reviewed = JSON.parse(readFileSync('docs/evidence/observer-recovery/SHA256SUMS.json', 'utf8'));
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(digest('src/server/agent-transport.ts'), reviewed.files['agent/src/server/agent-transport.ts']);
assert.equal(digest('node_modules/@handrail/ai-assistant/dist/transports/durable.js'), reviewed.files['ai/dist/transports/durable.js']);
const exports = {};
for (const [specifier, member] of [
  ['@handrail/ai-assistant', 'createDurableApplicationTransport'],
  ['@handrail/ai-assistant/server/application', 'createDurableApplicationTransport'],
  ['@handrail/ai-assistant/persistence/postgres', 'PostgresDurableApplicationTurnStore'],
  ['handrail-agent-sdk/server/application', 'createAgentConversationTransport'],
  ['handrail-agent-sdk/server/agents', 'createAgentRuntime'],
  ['handrail-agent-sdk/server/postgres', 'createPostgresAgentStores'],
]) {
  const location = realpathSync(fileURLToPath(import.meta.resolve(specifier)));
  const expected = specifier.startsWith('@handrail/') ? resolve(root, 'node_modules/@handrail/ai-assistant/dist') : resolve(root, 'dist');
  assert.ok(location.startsWith(`${expected}/`), `Unexpected module resolution: ${specifier}`);
  assert.equal(typeof (await import(specifier))[member], 'function');
  exports[specifier] = { location, sha256: createHash('sha256').update(readFileSync(location)).digest('hex') };
}
console.log(JSON.stringify({ verdict: 'installed-public-pin-verified', aiVersion: installed.version, pin,
  sourceOverride: false, reviewedAgentSourceAndInstalledAiRuntimeMatch: true, agent: 'current source built through normal prepare/build; not yet published', exports }, null, 2));
