import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createApplicationAgentTools } from 'handrail-agent-sdk/server/application-tools';
import { assistanceDigest } from 'handrail-agent-sdk/server/assistance';
import { createPostgresHarness, migrations } from './database.mjs';
import { services, identity, requirement } from './host.mjs';

const catalog = JSON.parse(readFileSync(new URL('./mills-catalog.json', import.meta.url), 'utf8'));
const ok = r => { assert.equal(r.ok, true, r.code); return r.value; };
const id = '12345678-1234-4234-8234-123456789abc';
const reminder = { title: 'Synthetic fixture only', localDate: '2028-02-29', localTime: '17:00', timeZone: 'America/Chicago', utcOffset: null };
const calendar = { eventId: id, expectedVersion: 1, patch: { title: 'Changed' } };
const trip = { id, expectedVersion: 1, patch: { destination: null } };

// Simulated model output, real Agent/Runner and real PostgreSQL authority,
// checkpoints and effects. No domain services or external effects are invoked.
function modelFor(calls, definitions, onRequest = () => {}) {
  let emitted = 0;
  return {
    async getResponse() { throw Error('STREAM_EXPECTED'); },
    async *getStreamedResponse(request) {
      assert.deepEqual(request.tools.map(t => t.name), definitions.map(t => t.name));
      for (const t of request.tools) {
        assert.equal(t.strict, false);
        assert.deepEqual(t.parameters, definitions.find(d => d.name === t.name).input_schema);
      }
      await onRequest(request);
      const n = (typeof request.input === 'string' ? [] : request.input).filter(i => i.type === 'function_call_result').length;
      const c = calls[Math.max(n, emitted++)];
      const output = c ? { type: 'function_call', name: c.name, callId: c.callId ?? `catalog-${n}`, arguments: c.raw ?? JSON.stringify(c.input) }
        : { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Controlled fixture complete.' }] };
      yield { type: 'response_started' };
      yield { type: 'response_done', response: { id: `catalog-response-${n}`, output: [output], usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 } } };
    },
  };
}

async function setup(t, calls, options = {}) {
  const definitions = options.definitions ?? catalog.definitions;
  const harness = await createPostgresHarness();
  let s;
  t.after(async () => { await s?.close(); await harness.cleanup(); });
  const client = await harness.client(); await migrations(t, harness, client);
  await client.query(`CREATE TABLE ${harness.table('synthetic_provider')}(id text PRIMARY KEY,receipt text NOT NULL,attempts integer NOT NULL DEFAULT 1)`);
  const seen = [], decisions = [], authorized = [];
  const tools = createApplicationAgentTools({ definitions,
    isReadOnly: name => options.readNames?.includes(name) ?? !catalog.effects.includes(name),
    read: async call => { seen.push(call); return 'authorized fixture read'; },
    bind: async call => {
      await options.businessValidate?.(call);
      seen.push(call);
      return { identity: call.identity, effectRef: call.effectRef, idempotencyRef: call.effectRef,
        actionRef: 'fixture', operationRef: 'fixture', providerRef: 'fixture', requestDigest: `sha256:${assistanceDigest(call.input)}` };
    },
    result: async call => options.result ? options.result(call) : 'verified fixture effect',
  });
  const key = randomBytes(32).toString('hex');
  const host = {
    decide: async call => { decisions.push(call); return options.decide ? options.decide(call) : 'approve'; },
    withToolAuthority: async (call, run) => {
      if (s.state.denied) throw Error('scope_revoked');
      authorized.push(call); return run();
    },
    ...options.host,
  };
  s = await services(harness.schema, key, { tools, model: modelFor(calls, definitions, options.onRequest), host,
    limits: { maxContextBytes: 1_000_000, maxElapsedMs: 15000 } });
  ok(await s.admission.admit({ namespaceRef: 'fixture', grantRevision: 1,
    operation: { operationRef: 'catalog', inputRefs: {} },
    event: { kind: 'submitted', previousRevision: 0, snapshot: { identity, revision: 1, state: 'queued', effects: [] } } }));
  return { ...s, tools, harness, key, client, seen, decisions, authorized, definitions,
    effectCount: async () => (await client.query(`SELECT coalesce(sum(attempts),0)::int AS n FROM ${harness.table('synthetic_provider')}`)).rows[0].n };
}

test('unchanged original 85, requested 92 and current 100 catalogs reach the actual Runner model boundary', async t => {
  assert.equal(catalog.originalNames.length, 85);
  assert.equal(catalog.requestedCount, 92);
  assert.equal(catalog.definitions.length, 100);
  const sets = [catalog.definitions.filter(d => catalog.originalNames.includes(d.name)),
    catalog.definitions.slice(0, catalog.requestedCount), catalog.definitions];
  for (const definitions of sets) await t.test(`${definitions.length} unchanged tools`, async t => {
    const s = await setup(t, [], { definitions });
    assert.equal(ok(await s.runtime.wake(identity)), 'succeeded');
    assert.equal(s.seen.length, 0);
  });
});

test('all retained historical 22/26 failure schemas reach Runner unchanged', async t => {
  for (const [report, failures] of Object.entries(catalog.failures)) await t.test(report, async t => {
    const definitions = failures.map(f => ({ name: f.name, description: 'Retained historical failure', input_schema: f.inputSchema }));
    const s = await setup(t, [], { definitions });
    assert.equal(ok(await s.runtime.wake(identity)), 'succeeded');
  });
});

test('full catalog read/effects preserve omissions, explicit null and nested defaults; duplicate delivery has one effect per call', async t => {
  const inputs = [
    { name: 'assistance_list', input: {} },
    { name: 'calendar_update_event', input: calendar },
    { name: 'travel_update_trip', input: trip },
    { name: 'travel_update_item', input: { id, tripId: id, expectedVersion: 1, patch: { start: { localDate: '2028-02-29', timeZone: 'UTC' }, end: null } } },
    { name: 'assistance_create_reminder', input: reminder },
    { name: 'travel_list', input: {} },
    { name: 'calendar_update_event', input: { ...calendar, patch: { recurrence: { frequency: 'weekly', interval: 1 } } } },
  ];
  const s = await setup(t, inputs);
  assert.equal(ok(await s.runtime.wake(identity)), 'succeeded');
  assert.equal(ok(await s.runtime.wake(identity)), 'succeeded');
  assert.deepEqual(s.seen.map(c => c.input), inputs.map(c => c.input));
  assert.deepEqual(s.decisions.map(c => c.input), inputs.map(c => c.input));
  assert.deepEqual(s.authorized.map(c => c.input), inputs.map(c => c.input));
  assert.equal(Object.hasOwn(s.seen[1].input.patch, 'location'), false);
  assert.equal(s.seen[2].input.patch.destination, null);
  assert.equal(Object.hasOwn(s.seen[3].input.patch.start, 'localTime'), false);
  assert.equal(await s.effectCount(), 5);
});

test('invalid catalog arguments never reach approval, authorized IO or effects', async t => {
  const invalid = [
    ['calendar_update_event', { ...calendar, patch: {} }],
    ['calendar_update_event', { ...calendar, eventId: 'bad-uuid' }],
    ['calendar_update_event', { ...calendar, expectedVersion: '1' }],
    ['calendar_update_event', { ...calendar, patch: { title: null } }],
    ['calendar_update_event', { ...calendar, patch: { title: '' } }],
    ['calendar_update_event', { ...calendar, patch: { title: 'x'.repeat(201) } }],
    ['calendar_update_event', { ...calendar, patch: { accentHex: 'red' } }],
    ['calendar_update_event', { ...calendar, patch: { startsAt: 'tomorrow' } }],
    ['calendar_update_event', { ...calendar, patch: { recurrence: { frequency: 'weekly', interval: 1, count: 101 } } }],
    ['calendar_update_event', { ...calendar, patch: { recurrence: { frequency: 'weekly', interval: 0 } } }],
    ['calendar_update_event', { ...calendar, patch: { unknown: true } }],
    ['assistance_create_reminder', { ...reminder, localDate: '2027-02-29' }],
    ['assistance_create_reminder', { ...reminder, localTime: '25:00' }],
    ['travel_update_trip', { ...trip, patch: { travelers: Array(51).fill('synthetic') } }],
    ['travel_update_trip', { ...trip, patch: { travelers: [null] } }],
    ['travel_update_trip', { ...trip, expectedVersion: 0 }],
    ['travel_update_trip', { ...trip, id: '12345678-1234-9234-8234-123456789abc' }],
    ['assistance_list', null],
    ['assistance_list', []],
    ['assistance_list', { unexpected: 1 }],
  ];
  // Each invalid input travels through a fresh Runner job using the actual
  // unmodified schema extracted from the full catalog.
  for (const [name, input] of invalid) await t.test(`${name} ${JSON.stringify(input).slice(0,100)}`, async t => {
    const s = await setup(t, [{ name, input }], { definitions: catalog.definitions.filter(d => d.name === name) });
    assert.equal(ok(await s.runtime.wake(identity)), 'retryable');
    assert.deepEqual(s.decisions, []); assert.deepEqual(s.authorized, []); assert.deepEqual(s.seen, []);
    assert.equal(await s.effectCount(), 0);
  });
  await t.test('malformed JSON', async t => {
    const s = await setup(t, [{ name: 'assistance_list', raw: '{' }], { definitions: catalog.definitions.filter(d => d.name === 'assistance_list') });
    // Upstream reports a JSON parse error as a tool result and lets the model
    // continue. It must never be promoted to an approval or application call.
    assert.equal(ok(await s.runtime.wake(identity)), 'succeeded');
    assert.equal(s.decisions.length, 0); assert.equal(s.authorized.length, 0);
    assert.equal(s.seen.length, 0); assert.equal(await s.effectCount(), 0);
  });
});

test('original business refinement remains authoritative before effects', async t => {
  const s = await setup(t, [{ name: 'assistance_create_reminder', input: { ...reminder, timeZone: 'not-an-iana-zone' } }], {
    businessValidate: call => { new Intl.DateTimeFormat('en', { timeZone: call.input.timeZone }); },
  });
  assert.equal(ok(await s.runtime.wake(identity)), 'retryable');
  assert.equal(s.decisions.length, 1); assert.equal(s.authorized.length, 1);
  assert.equal(s.seen.length, 0); assert.equal(await s.effectCount(), 0);
});

test('catalog approval recovery revalidates and retains null/omission and effect identity', async t => {
  const calls = [{ name: 'travel_update_trip', input: trip }];
  const s = await setup(t, calls, { decide: () => requirement('approval') });
  assert.equal(ok(await s.runtime.wake(identity)), 'waiting');
  assert.equal(await s.effectCount(), 0);
  s.state.resolution = { receiptRef: 'fixture-approved' };
  // This fixture host verifies an approval fact; production hosts retain their
  // existing approval service. Recovery uses a new runtime and DB connections.
  const next = await services(s.harness.schema, s.key, { tools: s.tools,
    model: modelFor(calls, s.definitions), limits: { maxContextBytes: 1_000_000 },
    host: { decide: () => 'approve', resolveWait: async () => s.state.resolution } });
  t.after(() => next.close());
  ok(await next.runtime.resume(identity));
  assert.equal(ok(await next.runtime.wake(identity)), 'succeeded');
  assert.deepEqual(s.seen[0].input, trip);
  assert.equal(s.seen[0].effectRef, s.decisions[0].effectRef);
  assert.equal(await s.effectCount(), 1);
});

test('catalog rejection, durable cancellation and scope revocation prevent effects', async t => {
  for (const mode of ['reject', 'cancel', 'scope']) await t.test(mode, async t => {
    const s = await setup(t, [{ name: 'travel_update_trip', input: trip }], {
      decide: () => mode === 'reject' ? 'reject' : requirement('approval'),
    });
    assert.equal(ok(await s.runtime.wake(identity)), mode === 'reject' ? 'succeeded' : 'waiting');
    if (mode === 'cancel') {
      const snapshot = ok(await s.journal.load(identity));
      ok(await s.cancel.stop({ command: 'cancel', identity, expectedRevision: snapshot.revision, reason: 'explicit_stop' }, 'actor'));
      assert.equal(ok(await s.runtime.wake(identity)), 'cancelled');
      assert.equal((await s.runtime.resume(identity)).ok, false);
    }
    if (mode === 'scope') {
      s.state.denied = true;
      assert.equal((await s.runtime.resume(identity)).ok, false);
      assert.equal((await s.runtime.wake(identity)).ok, false);
    }
    assert.equal(s.seen.length, 0); assert.equal(await s.effectCount(), 0);
  });
});

test('catalog effect result recovery and repeated model call ID do not duplicate dispatch', async t => {
  let reads = 0;
  const call = { name: 'travel_update_trip', input: trip, callId: 'same-call' };
  const s = await setup(t, [call, call], { result: () => { if (++reads === 1) throw Error('read unavailable'); return 'verified'; } });
  assert.equal(ok(await s.runtime.wake(identity)), 'retryable');
  assert.equal(ok(await s.runtime.wake(identity)), 'succeeded');
  assert.equal(await s.effectCount(), 1);
});

test('reused catalog call ID with different arguments cannot dispatch another effect', async t => {
  const s = await setup(t, [
    { name: 'travel_update_trip', input: trip, callId: 'conflicting-call' },
    { name: 'travel_update_trip', input: { ...trip, patch: { name: 'Different' } }, callId: 'conflicting-call' },
  ]);
  assert.equal(ok(await s.runtime.wake(identity)), 'retryable');
  assert.equal(await s.effectCount(), 1);
});

const laboratory = { name: 'calibrate_batch', description: 'Validate a synthetic laboratory calibration batch.', input_schema: {
  $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
  $defs: { measurement: { type: 'number', minimum: -5, maximum: 5, multipleOf: 0.5 } },
  properties: {
    samples: { type: 'array', minItems: 1, maxItems: 3, items: { $ref: '#/$defs/measurement' } },
    target: { oneOf: [{ type: 'string', pattern: '^LAB-[0-9]{3}$' }, { type: 'integer', minimum: 1 }] },
    metadata: { type: 'object', patternProperties: { '^x-': { type: ['string', 'null'], maxLength: 8 } }, additionalProperties: false },
    patch: { type: 'object', properties: { gain: { allOf: [{ type: 'number', exclusiveMinimum: 0 }, { maximum: 10 }] }, label: { type: ['string', 'null'] } }, additionalProperties: false },
  }, required: ['samples', 'target', 'patch'], additionalProperties: false,
} };
test('non-Mills laboratory schema executes refs, allOf, oneOf, arrays and open patterned metadata without rewriting', async t => {
  const input = { samples: [-5, 0.5, 5], target: 'LAB-123', metadata: { 'x-unit': null }, patch: { label: null } };
  const s = await setup(t, [{ name: laboratory.name, input }], { definitions: [laboratory], readNames: [] });
  assert.equal(ok(await s.runtime.wake(identity)), 'succeeded');
  assert.deepEqual(s.seen[0].input, input); assert.equal(await s.effectCount(), 1);
  for (const bad of [{ ...input, samples: [0.3] }, { ...input, target: true }, { ...input, patch: { gain: 0 } }, { ...input, metadata: { other: 'x' } }])
    assert.throws(() => s.tools[0].parameters.parse(bad), /agent_tool_arguments_invalid/);
});

test('invalid non-Mills allOf/oneOf input never reaches the effect boundary', async t => {
  const s = await setup(t, [{ name: laboratory.name, input: { samples: [1], target: true, patch: { gain: 0 } } }],
    { definitions: [laboratory], readNames: [] });
  assert.equal(ok(await s.runtime.wake(identity)), 'retryable');
  assert.equal(s.decisions.length, 0); assert.equal(s.seen.length, 0); assert.equal(await s.effectCount(), 0);
});

test('unsupported schema semantics fail construction; schema and input cannot be silently mutated', () => {
  const adapt = schema => createApplicationAgentTools({ definitions: [{ name: 'fixture', description: 'fixture', input_schema: schema }], isReadOnly: () => true,
    read: async () => '', bind: async () => { throw Error('unused'); }, result: async () => '' });
  for (const schema of [ { type: 'string' }, { type: 'object', madeUpValidation: true },
    { type: 'object', properties: { value: { type: 'string', format: 'unregistered' } } },
    { type: 'object', $schema: 'https://unknown.invalid/schema' }, { type: 'object', $async: true },
    { type: 'object', properties: { value: { $ref: 'https://unknown.invalid/remote' } } } ]) assert.throws(() => adapt(schema));
  for (const dialect of [undefined, 'http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema']) {
    const schema = { type: 'object', properties: { value: { type: ['string', 'null'], default: 'default' } }, ...dialect ? { $schema: dialect } : {} };
    const [tool] = adapt(schema);
    schema.properties.value.type = 'number';
    assert.deepEqual(tool.parameters.parse({}), {});
    assert.deepEqual(tool.parameters.parse({ value: null, extra: 'retained' }), { value: null, extra: 'retained' });
    assert.throws(() => { tool.parameters.jsonSchema.properties.value.type = 'number'; });
  }
});
