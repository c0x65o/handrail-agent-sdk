import assert from 'node:assert/strict';
import pg from 'pg';
import { createAgentConversationTransport, createAgentCheckpointReader } from 'handrail-agent-sdk/server/application';
import { services, identity } from '../installed/host.mjs';
export { identity };
export const aiEntry = process.env.HANDRAIL_OBSERVER_AI_ENTRY;
export const ai = await import(aiEntry ?? '@handrail/ai-assistant');
const postgres = await import(aiEntry ? new URL('./postgres/index.js', aiEntry).href : '@handrail/ai-assistant/persistence/postgres');
export const empty = { lastAppliedCursor: null, lastAppliedEventId: null, lastAppliedRevision: null };
export const start = { conversationId: 'observer-conversation', conversationTurnId: 'observer-turn', mutationId: 'observer-mutation', idempotencyKey: 'observer-start', request: { inputRef: 'saved-input' } };
const fact = { id: 'fixture', source: 'server_derived', trust: 'authoritative' };
export const attribution = { organization: fact, project: fact, service_environment: fact, known_user: fact, session: fact, automation: { ...fact, id: null } };
export async function composition(schema, key, options = {}) {
  assert.equal(process.env.HANDRAIL_TEST_POSTGRES_DISPOSABLE, '1');
  const s = await services(schema, key, options);
  const pool = new pg.Pool({ connectionString: process.env.HANDRAIL_TEST_POSTGRES_URL, max: 2 });
  const persistence = new postgres.PostgresAiPersistence(postgres.createPostgresSqlClientFromPool(pool));
  await persistence.migrate();
  const store = new postgres.PostgresDurableApplicationTurnStore(persistence, schema);
  const events = new postgres.PostgresConversationEventStore(persistence, schema);
  const binding = { identity, turnId: start.conversationTurnId, mutationId: start.mutationId };
  const authorize = input => { if (s.state.denied || input.conversationId !== start.conversationId || (input.turnId && input.turnId !== binding.turnId)) throw Error('scope denied'); };
  const read = createAgentCheckpointReader({ runtime: s.runtime, attribution: async () => attribution, pendingToolCallIds: async () => ['pending-effect'] });
  const host = {
    async admit(input) {
      authorize(input);
      assert.equal(input.conversationTurnId, binding.turnId); assert.equal(input.mutationId, binding.mutationId);
      const admitted = await s.admission.admit({ namespaceRef: 'fixture', grantRevision: 1,
        operation: { operationRef: 'agent-task', inputRefs: { inputRef: input.request.inputRef } },
        event: { kind: 'submitted', previousRevision: 0, snapshot: { identity, revision: 1, state: 'queued', effects: [] } } });
      assert.ok(admitted.ok, admitted.code); return binding;
    },
    async lookup(input) { authorize(input); return binding; }, read,
    async cancel() {
      authorize(start);
      const snap = (await s.journal.load(identity)).value;
      if (['cancelled', 'succeeded', 'failed'].includes(snap.state)) return 'already_terminal';
      const result = await s.cancel.stop({ command: 'cancel', identity, expectedRevision: snap.revision, reason: 'explicit_stop' }, 'actor');
      assert.ok(result.ok, result.code); return 'cancellation_requested';
    },
  };
  const delegate = createAgentConversationTransport({ runtime: s.runtime, host, capabilities: {}, pollMs: 5 });
  const diagnostics = [];
  const durable = ai.createDurableApplicationTransport({ delegate, store, workerId: `worker-${process.pid}-${options.worker ?? 'default'}`,
    authorizeRecovery: input => { try { authorize(input); return true; } catch { return false; } },
    leaseMilliseconds: 1000, pollMilliseconds: 25,
    requestCodec: { encode: x => x, decode: x => x, fingerprint: () => 'saved-input' },
    checkpointForEvent: e => ({ lastAppliedCursor: `${e.request_id}:${e.sequence}`, lastAppliedEventId: `${e.request_id}:${e.sequence}`, lastAppliedRevision: e.sequence }),
    diagnostics: e => diagnostics.push({ operation: e.operation, phase: e.phase, code: e.code, retryable: e.retryable }),
  });
  return { ...s, store, events, delegate, durable, diagnostics,
    document: () => store.load(start.conversationId, start.conversationTurnId),
    async close() { await s.runtime.stop(); await durable.stopWorkers(); await s.pool.end(); await pool.end(); } };
}
