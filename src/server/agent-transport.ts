import type { ConversationTransport, ConversationTransportCapabilities, StartTurnInput, ResumeTurnInput,
  TurnObservation, TurnObservationResult, TurnResumePoint, CancelTurnInput, TransportResult } from '@handrail/ai-assistant';
import type { JobIdentity } from '../contracts/job.js';
import type { createAgentRuntime } from './agent-runtime.js';
import type { AuthoritativeAttribution, StreamEvent, ChatRequest } from '@handrail/ai-assistant';

export interface AgentConversationBinding { readonly identity: JobIdentity; readonly turnId: string; readonly mutationId: string }
export interface AgentConversationPage<TEvent> {
  readonly events: readonly TEvent[];
  readonly checkpoint: TurnResumePoint;
  readonly result?: TurnObservationResult;
}
export interface AgentConversationHost<TEvent, TRequest> {
  /** Persist the exact turn/input binding and admit through createJobAdmission
   * atomically/idempotently. Derive identity from trusted context, not request.
   * Reuse the original job for duplicate start and reject changed input. */
  admit(input: StartTurnInput<TRequest>): Promise<AgentConversationBinding>;
  /** Current authenticated ownership check, including on every poll. */
  lookup(input: { conversationId: string; turnId: string }): Promise<AgentConversationBinding>;
  /** Read canonical conversation events after this cursor; project only filtered
   * authorized output/tool presentations/citations/normalized usage. Append
   * projection facts with stable IDs in the existing conversation event store.
   * Do not forward raw RunState, attachment bytes, or diagnostic events. */
  read(binding: AgentConversationBinding, after: TurnResumePoint): Promise<AgentConversationPage<TEvent>>;
  /** Invoke createJobCancellation with current actor and revision. */
  cancel(binding: AgentConversationBinding, input: CancelTurnInput): Promise<'cancellation_requested' | 'already_terminal'>;
}
const empty: TurnResumePoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
const failure = (): { ok: false; error: { code: 'unavailable'; message: string; retryable: true } } =>
  ({ ok: false, error: { code: 'unavailable', message: 'Assistant operation unavailable.', retryable: true } });

/** Drop-in provider.createTransport result for the existing application gateway.
 * Its local observation never owns execution. No second provider/tool loop,
 * conversation history, or process-local authority is introduced. */
export function createAgentConversationTransport<TEvent, TRequest>(deps: {
  readonly runtime: Pick<ReturnType<typeof createAgentRuntime>, 'wake' | 'resume'>;
  readonly host: AgentConversationHost<TEvent, TRequest>;
  readonly capabilities: Omit<ConversationTransportCapabilities, 'authoritativeCancellation'>;
  readonly pollMs: number;
}): ConversationTransport<TEvent, TRequest> {
  if (!Number.isSafeInteger(deps.pollMs) || deps.pollMs < 1) throw Error('invalid_observation_interval');
  function observe(input: { conversationId: string; turnId: string }, from: TurnResumePoint): TurnObservation<TEvent> {
    let disconnected = false, finished = false;
    let checkpoint = structuredClone(from);
    let wake: (() => void) | undefined;
    let settle!: (value: TurnObservationResult) => void;
    const result = new Promise<TurnObservationResult>(resolve => { settle = resolve; });
    const finish = (value: TurnObservationResult) => { if (!finished) { finished = true; settle(value); } };
    return {
      result,
      disconnect() { disconnected = true; wake?.(); finish({ status: 'disconnected', checkpoint }); },
      events: (async function* () {
        try {
          while (!disconnected) {
            // A reconnect/poll must never rely on the admission's old session.
            const binding = await deps.host.lookup(input);
            if (disconnected) break;
            const page = await deps.host.read(binding, checkpoint);
            if (disconnected) break;
            for (const event of page.events) { if (disconnected) break; yield event; }
            if (disconnected) break;
            checkpoint = page.checkpoint;
            if (page.result) { finish(page.result); return; }
            await new Promise<void>(resolve => {
              const timer = setTimeout(() => { wake = undefined; resolve(); }, deps.pollMs);
              wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
            });
          }
        } catch { finish({ status: 'disconnected', checkpoint }); }
        finally { finish({ status: 'disconnected', checkpoint }); }
      })(),
    };
  }
  const kick = (binding: AgentConversationBinding) => {
    void (async () => {
      // resume resolves only persisted host-verified answers. Reconnect itself
      // is never approval; missing answers leave the exact wait intact.
      await deps.runtime.resume(binding.identity);
      await deps.runtime.wake(binding.identity);
    })().catch(() => {});
  };
  return {
    capabilities: { ...deps.capabilities, authoritativeCancellation: { supported: true, capability: {
      async cancelTurn(input) {
        try { const binding = await deps.host.lookup(input); return { ok: true, value: { status: await deps.host.cancel(binding, input) } }; }
        catch { return failure(); }
      },
    } } },
    async startTurn(input) {
      try {
        const binding = await deps.host.admit(structuredClone(input));
        kick(binding);
        return { ok: true, value: { conversationId: input.conversationId, turnId: binding.turnId,
          mutationId: binding.mutationId, observation: observe({ conversationId: input.conversationId, turnId: binding.turnId }, empty) } };
      } catch { return failure(); }
    },
    async resumeTurn(input: ResumeTurnInput): Promise<TransportResult<TurnObservation<TEvent>>> {
      try {
        const binding = await deps.host.lookup(input);
        // Wake can recover execution but cannot resolve a durable approval wait.
        kick(binding);
        return { ok: true, value: observe(input, input.resumeFrom) };
      } catch { return failure(); }
    },
  };
}

/** Standard gateway stream projection. The existing application gateway's
 * durable turn writer records these stable frames and projects them into its
 * canonical conversation log. No extra transcript database is required.
 * Text is released only after host output verification. Tool renderers and
 * approval facts use the existing toolActivity observer at the execution seam. */
export function createAgentCheckpointReader(deps: {
  readonly runtime: Pick<ReturnType<typeof createAgentRuntime>, 'inspect'>;
  /** Stable server-derived job attribution; never client correlation hints. */
  readonly attribution: (binding: AgentConversationBinding) => Promise<AuthoritativeAttribution>;
  /** Map the saved requirement to existing native proposal call IDs. */
  readonly pendingToolCallIds: (binding: AgentConversationBinding, requirementRef: string) => Promise<readonly string[]>;
}): AgentConversationHost<StreamEvent, ChatRequest>['read'] {
  return async (binding, after) => {
    const inspected = await deps.runtime.inspect(binding.identity);
    if (!inspected.ok) throw Error('agent_projection_unavailable');
    const { snapshot, checkpoint: state } = inspected.value;
    const requestId = `agent:${binding.identity.jobId}`;
    const traceId = binding.identity.origin.correlationRef;
    const envelope = { protocol_version: 'handrail.ai-runtime.v1' as const, request_id: requestId, trace_id: traceId };
    const frames: StreamEvent[] = [{ ...envelope, sequence: 0, type: 'response.started', attribution: await deps.attribution(binding) }];
    if (snapshot.state === 'succeeded') {
      if (state?.output === undefined) throw Error('missing_verified_output');
      frames.push({ ...envelope, sequence: frames.length, type: 'response.text.delta', delta: state.output });
      if (state.usage) frames.push({ ...envelope, sequence: frames.length, type: 'response.usage',
        usage: { input_tokens: state.usage.inputTokens, output_tokens: state.usage.outputTokens, total_tokens: state.usage.totalTokens } });
      frames.push({ ...envelope, sequence: frames.length, type: 'response.completed', outcome: 'stop' });
    } else if (snapshot.state === 'cancelled') {
      frames.push({ ...envelope, sequence: 1, type: 'response.cancelled', reason: snapshot.cancellation.reason });
    } else if (snapshot.state === 'failed') {
      frames.push({ ...envelope, sequence: 1, type: 'response.error', error: { category: 'internal', code: 'internal_error',
        message: 'Assistant execution failed.', retryable: false } });
    }
    const prefix = `${requestId}:`;
    let cursor = -1;
    if (after.lastAppliedCursor !== null) {
      if (!after.lastAppliedCursor.startsWith(prefix)) throw Error('invalid_agent_cursor');
      cursor = Number(after.lastAppliedCursor.slice(prefix.length));
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= frames.length) throw Error('invalid_agent_cursor');
    }
    const checkpoint: TurnResumePoint = { lastAppliedCursor: `${prefix}${frames.length - 1}`,
      lastAppliedEventId: `${prefix}${frames.length - 1}`, lastAppliedRevision: frames.length - 1 };
    let result: TurnObservationResult | undefined;
    if (snapshot.state === 'succeeded') result = { status: 'completed', checkpoint };
    if (snapshot.state === 'cancelled') result = { status: 'cancelled', checkpoint };
    if (snapshot.state === 'failed') result = { status: 'failed', checkpoint, error: { ...failure().error, retryable: false } };
    if (snapshot.state === 'waiting') result = { status: 'waiting_for_approval', checkpoint,
      pendingToolCallIds: await deps.pendingToolCallIds(binding, snapshot.requirement.requirementRef) };
    return { events: frames.slice(cursor + 1), checkpoint, ...(result ? { result } : {}) };
  };
}
