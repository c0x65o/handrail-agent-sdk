import { isDeepStrictEqual } from 'node:util';
import { replayConversation, parseConversationEvent, ConversationEventStoreConflictError,
  type ConversationEventStore, type ConversationId, type DurableApplicationTurnStore } from '../assistant/index.js';
import type { JobIdentity } from '../contracts/job.js';
import type { createAgentRuntime } from './agent-runtime.js';

/** Bridge SDK-owned private interaction answers into the existing conversation
 * writer. This requeues observation of the SAME job, never grants authority,
 * creates a proposal, or executes a browser/model action. Call before resumed
 * model-input preparation, then wake the existing conversation recovery worker.
 * Projects supply only their existing stores, binding, and fresh authorization. */
export function createAgentConversationContinuation<TRequest, TEvent>(options: {
  turns: DurableApplicationTurnStore<TRequest, TEvent>;
  events: ConversationEventStore;
  runtime: Pick<ReturnType<typeof createAgentRuntime>, 'inspect'>;
  authorize(identity: JobIdentity, conversationId: string, turnId: string): Promise<void>;
  now?: () => Date;
}) {
  const pending = new Map<string, Promise<'resumed' | 'unchanged'>>();
  async function resume(input: { identity: JobIdentity; conversationId: string; turnId: string }): Promise<'resumed' | 'unchanged'> {
    const { identity, turnId } = input, conversationId = input.conversationId as ConversationId;
    for (let attempt = 0; attempt < 4; attempt++) {
      await options.authorize(identity, conversationId, turnId);
      const saved = await options.turns.load(conversationId, turnId);
      if (!saved || saved.record.status !== 'waiting_for_approval' || saved.record.cancellation ||
        saved.record.terminal?.status !== 'waiting_for_approval' || saved.record.terminal.pendingToolCallIds.length !== 1) return 'unchanged';
      const refs = saved.record.terminal.pendingToolCallIds.filter(ref => /^managed:[a-f0-9]{64}$/.test(ref));
      if (refs.length !== 1) return 'unchanged';
      const ref = refs[0]!;
      const inspected = await options.runtime.inspect(identity);
      if (!inspected.ok || !isDeepStrictEqual(inspected.value.snapshot.identity, identity) ||
        ['cancelled', 'failed', 'waiting'].includes(inspected.value.snapshot.state) ||
        inspected.value.checkpoint?.resolution?.receiptRef !== `managed-answer:${ref.slice(8)}`) return 'unchanged';
      const replay = await replayConversation({ eventStore: options.events, conversationId, checkpointPolicy: false });
      const state = replay.state; replay.store.destroy();
      const turn = state.turns.find(t => t.turn_id === turnId);
      if (state.replay_error || !turn || turn.cancellation_status !== null ||
        (state.active_turn_id !== null && state.active_turn_id !== turnId)) throw Error('CONVERSATION_CONTINUATION_UNAVAILABLE');
      await options.authorize(identity, conversationId, turnId);
      const time = (options.now?.() ?? new Date()).toISOString();
      if (turn.status === 'waiting_for_approval') {
        try {
          await options.events.append({ conversationId, expectedRevision: state.revision,
            events: [parseConversationEvent({ version: 1, conversation_id: conversationId,
              event_id: `managed-resume:${turnId}:${ref.slice(8)}`, revision: (state.revision ?? 0) + 1,
              occurred_at: time, actor: { type: 'system' }, source: { type: 'runtime' },
              payload: { type: 'turn.status_changed', turn_id: turnId, status: 'running' } })] });
        } catch (error) { if (error instanceof ConversationEventStoreConflictError) continue; throw error; }
      } else if (turn.status !== 'running') return 'unchanged';
      await options.authorize(identity, conversationId, turnId);
      const result = await options.turns.compareAndSet({ conversationId, turnId, expectedVersion: saved.version,
        record: { ...saved.record, status: 'pending', terminal: null, lease: null,
          approvalResumes: (saved.record.approvalResumes ?? 0) + 1, updatedAt: time } });
      if (result.status === 'updated') return 'resumed';
    }
    throw Error('CONVERSATION_CONTINUATION_CONFLICT');
  }
  return (input: { identity: JobIdentity; conversationId: string; turnId: string }) => {
    // Include the full authority in the key; callers with changed scope cannot
    // borrow an in-flight authorization from another request.
    const key = JSON.stringify(input);
    const current = pending.get(key); if (current) return current;
    const work = resume(input); pending.set(key, work);
    void work.finally(() => { if (pending.get(key) === work) pending.delete(key); }).catch(() => {});
    return work;
  };
}
