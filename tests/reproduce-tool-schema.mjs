// Regression diagnosis for the published 0.1.6 adaptation algorithm. Does not
// execute tools or connect to a model/database. A zero exit reproduces failure.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { tool } from '@openai/agents';
const catalog = JSON.parse(readFileSync(new URL('./fixtures/installed/mills-catalog.json', import.meta.url), 'utf8'));
const reproduce = definitions => definitions.flatMap(d => {
  try {
    tool({ name: d.name, description: d.description, parameters: z.fromJSONSchema(d.input_schema), needsApproval: true, execute: async () => '' });
    return [];
  } catch (error) { return [{ name: d.name, message: error.message }]; }
});
const requested = reproduce(catalog.definitions.slice(0, catalog.requestedCount));
const current = reproduce(catalog.definitions);
assert.equal(requested.length, 22);
assert.equal(current.length, 26);
for (const failures of Object.values(catalog.failures)) {
  const actual = reproduce(failures.map(f => ({ name: f.name, description: 'Historical schema', input_schema: f.inputSchema })));
  assert.deepEqual(actual, failures.map(({ name, message }) => ({ name, message })));
}
console.log(JSON.stringify({ status: 'published-algorithm-failures-reproduced', requested: { count: catalog.requestedCount, failures: requested },
  current: { count: catalog.definitions.length, failures: current } }, null, 2));
