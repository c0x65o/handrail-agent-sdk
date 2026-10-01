// Read-only consumer source capture. Run with the consumer's tsx loader and
// checkout path; no business services, provider calls, or consumer writes.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(process.argv[2]);
const load = path => import(pathToFileURL(resolve(root, path)).href);
const { createAssistantToolRuntime, ASSISTANT_PROPOSAL_TOOL_NAMES } = await load('src/server/assistant/tools.ts');
const { withAssistanceTools } = await load('src/server/assistant/assistance-tools.ts');
const { withTravelTools } = await load('src/server/travel/tools.ts');
const unavailable = () => { throw Error('CATALOG_CAPTURE_MUST_NOT_EXECUTE'); };
const service = new Proxy(unavailable, { get: () => unavailable });
const ports = new Proxy({}, { get: () => service });
const domain = createAssistantToolRuntime(ports);
const requested = withAssistanceTools(domain, service);
const current = withTravelTools(requested, service);
const original = JSON.parse(await readFile(resolve(root, 'docs/qa/agent-sdk-assistance-2026-09-30/domain-tool-inventory.json'), 'utf8'));
assert.equal(original.length, 85);
assert.ok(original.every(d => current.definitions.some(c => c.name === d.name)));
const effects = [...new Set([...ASSISTANT_PROPOSAL_TOOL_NAMES, ...(current.approvalToolNames ?? [])])];
const definitions = current.definitions.map(d => ({ name: d.name, description: d.description, input_schema: d.parameters }));
const failures = {};
const changedSinceReport = [];
for (const name of ['mills-catalog', 'current-main-catalog']) {
  const report = JSON.parse(await readFile(resolve(root, `docs/qa/agent-runtime-public-2026-09-30/${name}.json`), 'utf8'));
  for (const f of report.strictFailures) {
    if (JSON.stringify(definitions.find(d => d.name === f.name)?.input_schema) !== JSON.stringify(f.inputSchema))
      changedSinceReport.push({ report: name, name: f.name });
  }
  failures[name] = report.strictFailures;
}
const fixture = { originalNames: original.map(d => d.name), domainCount: domain.definitions.length,
  requestedCount: requested.definitions.length, effects, definitions, failures, changedSinceReport };
const serialized = JSON.stringify(fixture, null, 2) + '\n';
await writeFile(process.argv[3], serialized);
console.log(JSON.stringify({ original: original.length, requested: requested.definitions.length, current: definitions.length,
  sha256: createHash('sha256').update(serialized).digest('hex') }));
