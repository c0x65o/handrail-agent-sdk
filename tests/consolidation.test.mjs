import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNoAssistantDependency } from './helpers/git-consumer-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('the complete installed dependency graph contains no separate Assistant SDK', () => {
  assertNoAssistantDependency(JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url))));
  const files = readdirSync(new URL('../dist', import.meta.url), { recursive: true });
  for (const file of files.filter(file => /\.(?:js|ts)$/.test(file))) {
    const source = readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /@handrail\/ai-assistant/, file);
  }
});

test('gateway, clients, React and native agent entrypoints import from one inert package', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const core = await import('handrail-agent-sdk/assistant');
    const client = await import('handrail-agent-sdk/assistant/client');
    const server = await import('handrail-agent-sdk/assistant/server/assistant');
    const ui = await import('handrail-agent-sdk/assistant/react/styled');
    const runtime = await import('handrail-agent-sdk/server/agents');
    const usage = await import('handrail-agent-sdk/server/usage');
    assert.equal(typeof core.createConversationRuntime, 'function');
    assert.equal(typeof client.createHandrailAiClient, 'function');
    assert.equal(typeof server.createHandrailAssistant, 'function');
    assert.equal(typeof ui.HandrailAssistantWorkspace, 'function');
    assert.equal(typeof runtime.createAgentRuntime, 'function');
    assert.equal(typeof usage.createUsageTrackedAgentModel, 'function');
  `], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
