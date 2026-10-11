import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryConversationEventStore, parseConversationEvent, replayConversation } from 'handrail-agent-sdk/assistant';
import { InMemoryDurableApplicationTurnStore } from 'handrail-agent-sdk/assistant/server/application';
import { createAgentConversationContinuation } from '../dist/server/agent-transport.js';

const ref = `managed:${'a'.repeat(64)}`, conversationId = 'conversation', turnId = 'turn';
const identity = { jobId: 'job', native: { turnRef: turnId } };
const empty = { lastAppliedCursor: null, lastAppliedEventId: null, lastAppliedRevision: null };
async function setup() {
  const events = new InMemoryConversationEventStore(), turns = new InMemoryDurableApplicationTurnStore();
  const payloads = [
    { type: 'message.created', message_id: 'user-message', role: 'user', content: [{ type: 'text', text: 'Check my account' }] },
    { type: 'turn.started', turn_id: turnId, input_message_ids: ['user-message'] },
    { type: 'turn.status_changed', turn_id: turnId, status: 'running' },
    { type: 'turn.status_changed', turn_id: turnId, status: 'waiting_for_approval' },
  ];
  await events.append({ conversationId, expectedRevision: null, events: payloads.map((payload, n) => parseConversationEvent({
    version: 1, conversation_id: conversationId, event_id: `event-${n}`, revision: n + 1, occurred_at: '2026-10-11T00:00:00Z',
    actor: { type: 'system' }, source: { type: 'runtime' }, payload,
  })) });
  await turns.create({ schemaVersion: 1, conversationId, turnId, mutationId: 'mutation', idempotencyKey: 'request',
    requestFingerprint: 'request', request: {}, delegateTurnId: turnId, status: 'waiting_for_approval', attempt: 1,
    events: [], terminal: { status: 'waiting_for_approval', pendingToolCallIds: [ref], checkpoint: empty },
    cancellation: null, lease: null, createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' });
  let denied = false, state = 'running', receiptRef = `managed-answer:${'a'.repeat(64)}`;
  const resume = createAgentConversationContinuation({ turns, events,
    runtime: { inspect: async () => ({ ok: true, value: { snapshot: { identity, state }, checkpoint: { resolution: { receiptRef } } } }) },
    authorize: async () => { if (denied) throw Error('denied'); },
  });
  return { turns, events, resume: () => resume({ identity, conversationId, turnId }),
    deny: () => { denied = true; }, state: value => { state = value; }, receipt: value => { receiptRef = value; } };
}
test('a verified private answer resumes canonical conversation and the same durable observer exactly once', async () => {
  const s = await setup();
  assert.deepEqual(await Promise.all([s.resume(), s.resume()]), ['resumed', 'resumed']);
  assert.equal(await s.resume(), 'unchanged');
  const saved = await s.turns.load(conversationId, turnId);
  assert.equal(saved.record.status, 'pending'); assert.equal(saved.record.approvalResumes, 1);
  const replay = await replayConversation({ conversationId, eventStore: s.events });
  assert.equal(replay.state.active_turn_id, turnId); replay.store.destroy();
});
test('pending, cancelled, failed, or mismatched answers never resume a conversation', async () => {
  for (const state of ['waiting', 'cancelled', 'failed']) {
    const s = await setup(); s.state(state);
    assert.equal(await s.resume(), 'unchanged');
    assert.equal((await s.turns.load(conversationId, turnId)).record.status, 'waiting_for_approval');
  }
  const s = await setup(); s.receipt('unrelated-answer'); assert.equal(await s.resume(), 'unchanged');
});
test('current authorization is required even with a verified SDK answer', async () => {
  const s = await setup(); s.deny(); await assert.rejects(s.resume());
  assert.equal((await s.turns.load(conversationId, turnId)).record.status, 'waiting_for_approval');
});
test('a private answer cannot clear a native proposal wait or a concurrent cancellation', async () => {
  for (const cancelled of [false, true]) {
    const s = await setup();
    const saved = await s.turns.load(conversationId, turnId);
    await s.turns.compareAndSet({ conversationId, turnId, expectedVersion: saved.version,
      record: { ...saved.record,
        ...(cancelled ? { cancellation: { requestedAt: '2026-10-11T00:01:00Z' } }
          : { terminal: { ...saved.record.terminal, pendingToolCallIds: [ref, 'native-proposal'] } }),
      } });
    assert.equal(await s.resume(), 'unchanged');
    assert.equal((await s.turns.load(conversationId, turnId)).record.status, 'waiting_for_approval');
  }
});
