// Public installed API qualification, based on the released provider-tool-loop
// deadline regression. Only the provider boundary is simulated.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStreamEvent, createConversationRuntime, InMemoryConversationEventStore } from '@handrail/ai-assistant';
import { createProviderToolLoopTransport } from '@handrail/ai-assistant/server/assistant';

const fact = id => ({ id, source: 'server_derived', trust: 'authoritative' });
const attribution = { organization: fact('org'), project: fact('project'), service_environment: fact('fixture'),
  known_user: fact('user'), session: fact(null), automation: fact(null) };
const request = { protocol_version: 'handrail.ai-runtime.v1', continuation_of: null,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic request' }] }],
  tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} };
const usage = { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0,
  total_tokens: 3, provider_cost: { known: false } };

for (const [wire, canonical] of [['explicit_stop', 'user'], ['deadline_exceeded', 'timeout'],
  ['policy_revoked', 'superseded'], ['runtime_shutdown', 'runtime_shutdown']]) {
  test(`installed execution preserves ${wire} through cancellation and reload`, { timeout: 5000 }, async () => {
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    let actualSignal;
    const adapter = {
      metadata: { provider_id: 'fake', model_id: 'fake-model', capabilities: {
        streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
        document_input: { supported: false }, provider_context: { supported: false, reason: 'provider_not_supported' },
        context_window_tokens: null, max_output_tokens: null } },
      provider_context: { supported: false, reason: 'provider_not_supported' },
      async *invoke(input) {
        actualSignal = input.signal;
        yield { protocol_version: 'handrail.ai-runtime.v1', request_id: input.context.request_id,
          trace_id: input.context.trace_id, sequence: 0, type: 'response.started', attribution };
        enter();
        await new Promise(resolve => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener('abort', resolve, { once: true });
        });
        // Match the released adapters' typed abort contract. Only the genuine
        // deadline case reports generic shutdown; the host owns its budget.
        return { status: 'cancelled', reason: typeof input.signal.reason === 'string'
          ? input.signal.reason : 'runtime_shutdown', usage };
      },
    };
    const transport = createProviderToolLoopTransport({ adapter, tools: [],
      limits: { maxIterations: 2, maxTotalToolCalls: 4, maxElapsedMs: wire === 'deadline_exceeded' ? 25 : 2000, parallelism: 1 },
      createContext: () => ({ request_id: 'reason', trace_id: 'reason', attribution, correlation_hints: {} }),
      executeTool: async () => { throw Error('No tools requested'); } });
    const eventStore = new InMemoryConversationEventStore();
    const runtime = await createConversationRuntime({ conversationId: 'reason', clientId: 'fixture', transport, eventStore });
    try {
      const pending = runtime.sendMessage({ content: 'Synthetic request', request });
      await entered;
      if (wire !== 'deadline_exceeded') {
        const turnId = runtime.getSnapshot().active_turn_id;
        assert.ok(turnId);
        await runtime.cancelTurn(turnId, canonical);
      }
      assert.equal((await pending).status, 'cancelled');
      assert.equal(actualSignal.aborted, true);
      if (wire === 'deadline_exceeded') {
        assert.equal(actualSignal.reason.name, 'TimeoutError');
        assert.equal(actualSignal.reason.code, 'ETIMEDOUT');
      } else assert.equal(actualSignal.reason, wire);
      assert.equal(runtime.getSnapshot().turns[0].cancellation_reason, canonical);
      runtime.destroy();
      const reloaded = await createConversationRuntime({ conversationId: 'reason', clientId: 'fixture', transport, eventStore });
      try {
        assert.equal(reloaded.getSnapshot().turns[0].status, 'cancelled');
        assert.equal(reloaded.getSnapshot().turns[0].cancellation_reason, canonical);
      } finally { reloaded.destroy(); }
    } finally { runtime.destroy(); }
  });
}
test('installed strict decoder rejects unsupported cancellation values', () => {
  for (const reason of ['user', 'unknown', '']) assert.throws(() => parseStreamEvent({
    protocol_version: 'handrail.ai-runtime.v1', request_id: 'reason', trace_id: 'reason', sequence: 1,
    type: 'response.cancelled', reason }));
  assert.equal(parseStreamEvent({ protocol_version: 'handrail.ai-runtime.v1', request_id: 'reason', trace_id: 'reason',
    sequence: 1, type: 'response.cancelled', reason: 'explicit_stop' }).reason, 'explicit_stop');
});
