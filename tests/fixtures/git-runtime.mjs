// Copied as TEST INPUT into the consumer, so all package imports resolve there.
// Host persistence uses the repository's existing real PostgreSQL reference.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createAgentRuntime } from 'handrail-agent-sdk/server/agents';
import * as server from 'handrail-agent-sdk/server';
import { OpenAIProvider } from '@openai/agents';
import OpenAI from 'openai';
import { createAssistance } from 'handrail-agent-sdk/server/assistance';
import { createPostgresAssistanceStore, assistancePostgresSchema } from 'handrail-agent-sdk/server/assistance/postgres';
import { createAgentCheckpointReader } from 'handrail-agent-sdk/server/application';
import { createApplicationAgentTools } from 'handrail-agent-sdk/server/application-tools';
import { createNotificationDelivery } from 'handrail-agent-sdk/server/assistance/notifications';
import { createHandrailFeedbackObserver } from 'handrail-agent-sdk/server/handrail-feedback';

export async function verifyInstalledRuntime(t, { createPostgresHarness, migrations, services, identity }) {
  const ok = result => { assert.equal(result.ok, true, result.code); return result.value; };
  const harness = await createPostgresHarness(); t.after(() => harness.cleanup());
  const db = await harness.client(); await migrations(t, harness, db);
  await db.query(`CREATE TABLE ${harness.table('synthetic_provider')}(id text PRIMARY KEY, receipt text NOT NULL, attempts integer NOT NULL DEFAULT 1)`);
  let requests = 0;
  const client = new OpenAI({ apiKey: 'synthetic-fixture-only', baseURL: 'https://model.fixture.invalid/v1', maxRetries: 0,
    fetch: async (url, options) => {
      assert.equal(String(url), 'https://model.fixture.invalid/v1/responses');
      const body = JSON.parse(options.body); requests++;
      assert.equal(body.stream, true); assert.equal(body.store, false);
      const n = body.input.filter(item => item.type === 'function_call_output').length;
      const args = n === 1 ? { itemRef: 'synthetic-item' } : { topic: n === 0 ? 'inventory' : 'receipt' };
      const output = n < 3
        ? [{ type: 'function_call', id: `fc-${n}`, call_id: `http-${n}`, name: n === 1 ? 'reserve' : 'lookup', arguments: JSON.stringify(args), status: 'completed' }]
        : [{ type: 'message', id: 'msg-final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Installed runtime completed.', annotations: [] }] }];
      const response = { id: `resp-${n}`, object: 'response', created_at: 1, status: 'completed', output,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response, sequence_number: 0 })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    } });
  const provider = new OpenAIProvider({ openAIClient: client, useResponses: true }); t.after(() => provider.close());
  const s = await services(harness.schema, randomBytes(32).toString('hex'), {
    sdk: { ...server, createAgentRuntime }, model: await provider.getModel('fixture-model'),
  });
  t.after(() => s.close());
  ok(await s.admission.admit({ namespaceRef: 'fixture', grantRevision: 1,
    operation: { operationRef: 'agent-task', inputRefs: {} },
    event: { kind: 'submitted', previousRevision: 0, snapshot: { identity, revision: 1, state: 'queued', effects: [] } } }));
  assert.equal(ok(await s.runtime.wake(identity)), 'succeeded');
  assert.equal(ok(await s.runtime.wake(identity)), 'succeeded');
  assert.equal(requests, 4); // Duplicate wake made no additional model request.
  const state = ok(await s.states.load(identity, s.authority()));
  assert.equal(state.output, 'Installed runtime completed.');
  assert.equal(state.usage.requests, 4);
  assert.equal(Object.keys(state.results).length, 3);
  assert.equal(ok(await s.journal.load(identity)).effects[0].outcome, 'verified');
  assert.equal((await db.query(`SELECT sum(attempts)::int AS attempts FROM ${harness.table('synthetic_provider')}`)).rows[0].attempts, 1);
  t.diagnostic('Installed Agent/Runner + official OpenAI client; mocked SSE transport; 4 responses, 3 tools, 1 effect; duplicate wake repeated neither model nor effect.');
  for (const factory of [createAgentCheckpointReader, createApplicationAgentTools, createNotificationDelivery, createHandrailFeedbackObserver]) assert.equal(typeof factory, 'function');
  await db.query(assistancePostgresSchema(harness.schema));
  const now = Date.parse('2027-01-01T00:00Z');
  const options = { host: { now: () => now, withAuthority: async (_key, _operation, run) => run() },
    batchSize: 10, readTimeoutMs: 1000, adapters: { machine: { read: async (_key, spec) => ({
      subjectRef: spec.subjectRef, status: 'matched', observedAt: now, evidenceRef: 'sensor:verified' }) } } };
  const assistance = createAssistance({ ...options, store: createPostgresAssistanceStore(db, harness.schema) });
  const key = { scope: identity.host, id: 'industrial-inspection' };
  await assistance.create(key, 'create-inspection', { kind: 'watch', adapterRef: 'machine', subjectRef: 'pump:inspection',
    contentRef: 'work-order', pollMs: 1000, maxAgeMs: 5000, expiresAt: now + 60000 });
  await assistance.tick();
  const rebuilt = createAssistance({ ...options, store: createPostgresAssistanceStore(await harness.client(), harness.schema) });
  await rebuilt.tick();
  assert.equal((await rebuilt.get(key)).state, 'completed');
  assert.equal((await rebuilt.facts(identity.host)).length, 1);
  t.diagnostic('Installed assistance exports + disposable PostgreSQL: industrial watch reconstructed with one durable notification fact. Sensor/model boundaries simulated.');
}
