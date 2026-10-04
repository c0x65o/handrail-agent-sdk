// Task-local reproduction of the observed SDK execution/observation mismatch.
// Uses installed SDKs and in-memory storage. No model, app DB or runtime writes.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentConversationTransport } from 'handrail-agent-sdk/server/application';
import { createDurableApplicationTransport, InMemoryDurableApplicationTurnStore } from '@handrail/ai-assistant';

globalThis.fetch = async () => { throw Error('Network forbidden in diagnostic'); };
const empty = { lastAppliedCursor: null, lastAppliedEventId: null, lastAppliedRevision: null };
const binding = { identity: { jobId: 'synthetic-observer-diagnostic' },
  turnId: 'synthetic-turn-8bcf3fc1', mutationId: 'synthetic-mutation-8bcf3fc1' };
let wakes = 0, reads = 0, delegateObservation;
const agent = createAgentConversationTransport({
  runtime: {
    async resume() { return { ok: false, code: 'invalid_transition' }; },
    async wake() { wakes++; return { ok: true, value: 'retryable' }; },
  },
  host: {
    async admit() { return binding; }, async lookup() { return binding; },
    async read() { reads++; return { events: [], checkpoint: empty }; },
    async cancel() { throw Error('Stop forbidden in diagnostic'); },
  },
  capabilities: {}, pollMs: 10,
});
const store = new InMemoryDurableApplicationTurnStore();
const durable = createDurableApplicationTransport({
  delegate: { ...agent, async startTurn(input) {
    const result = await agent.startTurn(input);
    assert.ok(result.ok);
    delegateObservation = result.value.observation;
    return result;
  } },
  store, requestCodec: { encode: x => x, decode: x => x, fingerprint: () => 'synthetic-fingerprint' },
  checkpointForEvent: () => empty, workerId: 'synthetic-worker',
  leaseMilliseconds: 1000, pollMilliseconds: 25,
});
const conversationId = 'synthetic-conversation-8bcf3fc1';
const within = async predicate => {
  const deadline = Date.now() + 3000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, 'Bounded diagnostic timed out'); await delay(20); }
};
try {
  const started = await durable.startTurn({ conversationId, conversationTurnId: binding.turnId,
    mutationId: binding.mutationId, idempotencyKey: 'synthetic-start', request: {} });
  assert.ok(started.ok);
  await within(() => reads >= 3);
  const before = await store.load(conversationId, binding.turnId);
  assert.ok(before?.record.lease);
  await within(async () => (await store.load(conversationId, binding.turnId)).version > before.version);
  const after = await store.load(conversationId, binding.turnId);
  assert.equal(after.record.status, 'running');
  assert.equal(after.record.terminal, null);
  assert.ok(Date.parse(after.record.lease.expiresAt) > Date.parse(before.record.lease.expiresAt));
  const resumed = await durable.resumeTurn({ conversationId, turnId: binding.turnId, resumeFrom: empty });
  assert.ok(resumed.ok);
  const recovery = await durable.recoverTurn(conversationId, binding.turnId);
  assert.deepEqual(recovery, { ok: true, value: { status: 'already_running' } });
  assert.equal(wakes, 1);
  assert.equal(durable.activeWorkerCount, 1);
  started.value.observation.disconnect(); resumed.value.disconnect();
  console.log(JSON.stringify({ verdict: 'SDK_DEFECT_REPRODUCED', runtimeWake: 'retryable',
    wakeCount: wakes, repeatedReads: reads, durableStatus: after.record.status,
    heartbeatRenewed: true, recovery: recovery.value.status, model: 'not invoked',
    database: 'in-memory only', runtimeAcceptance: false }));
} finally {
  // Release only this local diagnostic observer; never Stop or mutate a deployed turn.
  delegateObservation?.disconnect();
  await durable.stopWorkers();
}
