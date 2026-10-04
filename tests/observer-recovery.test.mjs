import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentConversationTransport } from 'handrail-agent-sdk/server/application';
// Candidate source composition only; dependency manifests and locks stay pinned.
const { createDurableApplicationTransport, InMemoryDurableApplicationTurnStore } = await import(
  process.env.HANDRAIL_OBSERVER_AI_ENTRY ?? '@handrail/ai-assistant');
const empty = { lastAppliedCursor: null, lastAppliedEventId: null, lastAppliedRevision: null };
const binding = { identity: { jobId: 'synthetic-observer' }, turnId: 'turn', mutationId: 'mutation' };
const start = { conversationId: 'conversation', conversationTurnId: 'turn', mutationId: 'mutation', idempotencyKey: 'start', request: {} };
const within = async predicate => {
  const deadline = Date.now() + 2000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, 'execution exit retained an observer worker'); await delay(10); }
};
const consume = async observation => { const events = []; for await (const event of observation.events) events.push(event); return { events, result: await observation.result }; };

test('composed retryable wake releases idle observer lease and recovers the same turn', { timeout: 5000 }, async t => {
  let wakes = 0, reads = 0, observation, completed = false;
  const agent = createAgentConversationTransport({
    runtime: { async resume() { return { ok: false, code: 'invalid_transition' }; },
      async wake() { wakes++; return { ok: true, value: completed ? 'succeeded' : 'retryable' }; } },
    host: { async admit() { return binding; }, async lookup() { return binding; },
      async read() { reads++; return { events: [], checkpoint: empty, ...(completed ? { result: { status: 'completed', checkpoint: empty } } : {}) }; },
      async cancel() { throw Error('unexpected Stop'); } }, capabilities: {}, pollMs: 5,
  });
  const store = new InMemoryDurableApplicationTurnStore();
  const durable = createDurableApplicationTransport({ delegate: { ...agent, async startTurn(input) {
    const r = await agent.startTurn(input); observation = r.value.observation; return r;
  } }, store, workerId: 'first', leaseMilliseconds: 1000, pollMilliseconds: 25,
    requestCodec: { encode: x => x, decode: x => x, fingerprint: () => 'request' }, checkpointForEvent: () => empty });
  t.after(async () => { observation?.disconnect(); await durable.stopWorkers(); });
  const opened = await durable.startTurn(start); assert.ok(opened.ok);
  await within(() => wakes === 1 && durable.activeWorkerCount === 0);
  const pending = await store.load('conversation', 'turn');
  assert.equal(pending.record.status, 'pending'); assert.equal(pending.record.terminal, null); assert.equal(pending.record.lease, null);
  assert.equal((await consume(opened.value.observation)).result.status, 'disconnected');
  await delay(550); // Beyond the old heartbeat-renewal threshold.
  assert.equal((await store.load('conversation', 'turn')).version, pending.version);
  completed = true;
  assert.deepEqual(await durable.recoverTurn('conversation', 'turn'), { ok: true, value: { status: 'started' } });
  await within(() => durable.activeWorkerCount === 0);
  assert.equal((await store.load('conversation', 'turn')).record.status, 'completed');
  assert.equal(wakes, 2); assert.ok(reads <= 4);
  console.log(JSON.stringify({ scenario: 'composed-retryable', idleLease: false, recovery: 'started', wakes, reads, model: 'simulated runtime boundary' }));
});

for (const exit of ['retryable', 'busy', 'stopped', 'not_authorized', 'throw']) test(`direct consumer bounds ${exit} exit with a final fresh projection`, { timeout: 3000 }, async t => {
  let end, reads = 0, wakeCalls = 0;
  const exited = new Promise(resolve => { end = resolve; });
  const agent = createAgentConversationTransport({
    runtime: { async resume() { return { ok: false, code: 'invalid_transition' }; }, async wake() {
      wakeCalls++; await exited; if (exit === 'throw') throw Error('private diagnostic');
      return exit === 'not_authorized' ? { ok: false, code: exit } : { ok: true, value: exit };
    } },
    host: { async admit() { return binding; }, async lookup() { return binding; }, async read() {
      reads++; if (reads === 1) { end(); await delay(10); } // Exit during an old read requires another read.
      return { events: [reads], checkpoint: { ...empty, lastAppliedRevision: reads } };
    }, async cancel() { throw Error('unexpected'); } }, capabilities: {}, pollMs: 1000,
  });
  const opened = await agent.startTurn(start); const observation = opened.value.observation;
  t.after(() => observation.disconnect());
  const result = await consume(observation);
  assert.equal(result.result.status, 'disconnected'); assert.deepEqual(result.events, [1, 2]);
  assert.equal(result.result.checkpoint.lastAppliedRevision, 2); assert.equal(wakeCalls, 1);
});

for (const status of ['completed', 'cancelled', 'waiting_for_approval', 'failed']) test(`canonical ${status} wins over a rejected resume`, async () => {
  let wakes = 0;
  const result = { status, checkpoint: empty, ...(status === 'waiting_for_approval' ? { pendingToolCallIds: ['call'] } : {}),
    ...(status === 'failed' ? { error: { code: 'unavailable', message: 'Execution failed.', retryable: false } } : {}) };
  const agent = createAgentConversationTransport({
    runtime: { async resume() { return { ok: false, code: 'not_authorized' }; }, async wake() { wakes++; throw Error('must not dispatch'); } },
    host: { async admit() { return binding; }, async lookup() { return binding; },
      async read() { return { events: [], checkpoint: empty, result }; }, async cancel() { throw Error('unused'); } },
    capabilities: {}, pollMs: 5,
  });
  const opened = await agent.resumeTurn({ conversationId: 'conversation', turnId: 'turn', resumeFrom: empty });
  assert.deepEqual((await consume(opened.value)).result, result); assert.equal(wakes, 0);
});

test('permission loss on the final lookup closes observation without reading or dispatching again', async () => {
  let reads = 0, allowed = true;
  const agent = createAgentConversationTransport({
    runtime: { async resume() { return { ok: false, code: 'invalid_transition' }; },
      async wake() { allowed = false; return { ok: false, code: 'not_authorized' }; } },
    host: { async admit() { return binding; }, async lookup() { if (!allowed) throw Error('private scope detail'); return binding; },
      async read() { reads++; return { events: [], checkpoint: empty }; }, async cancel() { throw Error('unused'); } }, capabilities: {}, pollMs: 5,
  });
  const opened = await agent.startTurn(start); const observed = await consume(opened.value.observation);
  assert.equal(observed.result.status, 'disconnected'); assert.ok(reads <= 1);
  assert.ok(!JSON.stringify(observed).includes('private scope'));
});
