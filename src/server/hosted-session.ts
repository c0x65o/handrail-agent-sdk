export { retainHostedArtifacts } from './hosted-artifacts.js';
import { createHash } from 'node:crypto';
import { canonicalAgentJson } from './agent-state-binding.js';
export { attachHostedFile, type HostedFileReceipt, type HostedFileSource } from './hosted-files.js';
export { createHostedConversationStore } from './hosted-conversation.js';
import type OpenAI from 'openai';
import type { AgentSession, AgentSessionEvent, AgentSessionInputMessageParam, AgentSessionInputParam,
  AgentSessionItem } from 'openai/resources/beta/agents/agents';
import type { SessionCreateParamsNonStreaming } from 'openai/resources/beta/agents/sessions/sessions';
import type { Turn } from 'openai/resources/beta/agents/sessions/turns/turns';

export type HostedAction = AgentSession['required_actions'][number];
export type HostedActionResult = Extract<AgentSessionInputParam,
  { type: 'agent.session.input.tool_result' | 'agent.session.input.computer_use_approval_request_result' }>;

/** Persist in the application's existing scoped conversation store. The host
 * must hold its conversation writer lease through every operation below. */
export interface HostedSessionBinding {
  creationKey: string;
  scopeDigest: string;
  configurationDigest: string;
  creationAttempted?: boolean;
  sessionId?: string;
  bootstrapJobId?: string;
}
/** Persist with the original admitted turn, before submitting any provider IO. */
export interface HostedTurnBinding {
  submissionKey: string;
  baseline?: string | null;
  submissionAttempted?: boolean;
  turnId?: string;
}
export class HostedSessionError extends Error {
  constructor(readonly code: 'creation_uncertain' | 'binding_conflict' | 'session_failed' |
    'concurrent_turn' | 'stream_disconnected' | 'invalid_action_result' | 'submission_uncertain') { super(code); }
}
const hash = (value: unknown) => createHash('sha256').update(canonicalAgentJson(value)).digest('hex');
const terminal = (turn: Turn) => ['completed', 'failed', 'cancelled'].includes(turn.status);

/** OpenAI runs the harness, context compaction and browser. This adapter owns
 * transport/recovery only. Native function authorization and effects remain in
 * the application's existing admitted-job machinery. Never log events: browser
 * screenshots and tool arguments can contain private data. */
export function createHostedSessionClient(options: {
  client: OpenAI;
  model: string;
  instructions: string;
  tools?: NonNullable<SessionCreateParamsNonStreaming['agent']>['tools'];
  browser?: boolean;
}) {
  const sessions = options.client.beta.agents.sessions;
  const browser = options.browser !== false;
  const tools = options.tools ?? [];
  if (tools.some(tool => tool.type === 'computer_use')) throw new Error('HOSTED_BROWSER_CONFIG_DUPLICATE');
  const configuration: SessionCreateParamsNonStreaming = {
    agent: { model: options.model, instructions: options.instructions,
      tools: [...tools, ...(browser ? [{ type: 'computer_use' as const, include_screenshots: true }] : [])] },
    environment: { type: 'openai_hosted', desktop: { enabled: browser }, network: { access: 'enabled' } },
  };
  // Model settings are mutable on the original session; tools/environment are not.
  const configurationDigest = hash({ instructions: options.instructions, tools: configuration.agent?.tools, environment: configuration.environment });
  const requestOptions = (signal: AbortSignal) => ({ signal, maxRetries: 0 });
  const verify = (session: AgentSession, binding: HostedSessionBinding) => {
    if (session.metadata.handrail_scope !== binding.scopeDigest || session.metadata.handrail_creation !== binding.creationKey
      || session.metadata.handrail_configuration !== binding.configurationDigest)
      throw new HostedSessionError('binding_conflict');
  };

  return {
    binding(scope: unknown, creationKey: string): HostedSessionBinding {
      if (!creationKey) throw new Error('HOSTED_CREATION_KEY_REQUIRED');
      return { creationKey, scopeDigest: hash(scope), configurationDigest };
    },
    /** Creation has no documented replay guarantee. Save intent first, recover
     * by its exact metadata on uncertainty, and never create a replacement. */
    async connect(ports: { binding: HostedSessionBinding; signal: AbortSignal;
      authorize(): Promise<void>; save(binding: HostedSessionBinding): Promise<void> }): Promise<string> {
      await ports.authorize();
      let binding = structuredClone(ports.binding);
      if (binding.configurationDigest !== configurationDigest) throw new HostedSessionError('binding_conflict');
      if (binding.sessionId) {
        const existing = await sessions.retrieve(binding.sessionId, requestOptions(ports.signal));
        verify(existing, binding);
        if (existing.agent?.model && existing.agent.model !== options.model && existing.status === 'idle') {
          const latest = (await sessions.turns.list(existing.id, { limit: 1, order: 'desc' }, requestOptions(ports.signal))).data[0];
          if (!latest || terminal(latest)) {
            await ports.authorize();
            await sessions.update(existing.id, { agent: { model: options.model } }, requestOptions(ports.signal));
          }
        }
        return binding.sessionId;
      }
      if (binding.creationAttempted) {
        let match: AgentSession | undefined;
        for await (const session of sessions.list({ limit: 100 }, requestOptions(ports.signal))) {
          if (session.metadata.handrail_creation !== binding.creationKey) continue;
          verify(session, binding);
          if (match) throw new HostedSessionError('binding_conflict');
          match = session;
        }
        if (!match) throw new HostedSessionError('creation_uncertain');
        binding.sessionId = match.id;
      } else {
        binding = { ...binding, creationAttempted: true };
        await ports.save(binding);
        await ports.authorize();
        const session = await sessions.create({ ...configuration, metadata: {
          handrail_creation: binding.creationKey, handrail_scope: binding.scopeDigest,
          handrail_configuration: binding.configurationDigest,
        } }, requestOptions(ports.signal));
        verify(session, binding);
        binding = { ...binding, sessionId: session.id };
      }
      await ports.save(binding);
      return binding.sessionId!;
    },
    /** One writer per session. A disconnected observer does not cancel remote
     * work. Re-enter with the same durable binding, not a fresh submission key. */
    async run(ports: {
      session: HostedSessionBinding; turn: HostedTurnBinding; input: AgentSessionInputMessageParam[];
      signal: AbortSignal; authorize(): Promise<void>; save(turn: HostedTurnBinding): Promise<void>;
      action(action: HostedAction): Promise<HostedActionResult | null>;
      /** Only independent native reads may batch; mutations retain provider order. */
      parallelRead?(action: HostedAction): boolean;
      event?(event: AgentSessionEvent): Promise<void>;
      item?(item: AgentSessionItem): Promise<void>;
    }): Promise<{ status: 'waiting' } | { status: 'terminal'; turn: Turn; items: AgentSessionItem[]; outputText: string }> {
      const sessionId = ports.session.sessionId;
      if (!sessionId || !ports.turn.submissionKey) throw new HostedSessionError('binding_conflict');
      await ports.authorize();
      let turn = structuredClone(ports.turn);
      const stream = await sessions.events.stream(sessionId, requestOptions(ports.signal));
      const save = async (next: HostedTurnBinding) => { await ports.save(next); turn = next; };
      const latest = async () => (await sessions.turns.list(sessionId, { limit: 1, order: 'desc' }, requestOptions(ports.signal))).data[0];
      const result = async (saved: Turn) => {
        const items: AgentSessionItem[] = [];
        for await (const item of sessions.turns.items.list(saved.id, { session_id: sessionId, order: 'asc', limit: 100 }, requestOptions(ports.signal))) {
          await ports.authorize();
          await ports.item?.(item);
          items.push(item);
        }
        const outputText = items.filter(item => item.type === 'message' && item.role === 'assistant' && item.phase !== 'commentary')
          .flatMap(item => item.type === 'message' ? item.content.filter(part => part.type === 'output_text') : [])
          .map(part => part.type === 'output_text' ? part.text : '').join('\n');
        return { status: 'terminal' as const, turn: saved, items, outputText };
      };
      const reconcile = async (): Promise<Awaited<ReturnType<typeof result>> | { status: 'waiting' } | undefined> => {
        await ports.authorize();
        const session = await sessions.retrieve(sessionId, requestOptions(ports.signal));
        verify(session, ports.session);
        if (session.status === 'failed') throw new HostedSessionError('session_failed');
        const current = turn.turnId
          ? await sessions.turns.retrieve(turn.turnId, { session_id: sessionId }, requestOptions(ports.signal))
          : await latest();
        if (current && current.id !== turn.baseline) {
          if (!turn.turnId) await save({ ...turn, turnId: current.id });
          if (terminal(current)) return result(current);
        }
        const respond = async (action: HostedAction, response: HostedActionResult) => {
          const matches = action.type === 'function_call'
            ? response.type === 'agent.session.input.tool_result' && response.call_id === action.call_id && response.turn_id === action.turn_id
            : action.type === 'computer_use_approval_request' && response.type === 'agent.session.input.computer_use_approval_request_result'
              && response.request_id === action.request_id && response.response.type === action.request.type;
          if (!matches) throw new HostedSessionError('invalid_action_result');
          await ports.authorize();
          await sessions.events.create(sessionId, { events: [response],
            'Idempotency-Key': hash([turn.submissionKey, response]) }, requestOptions(ports.signal));
        };
        for (let n = 0; n < session.required_actions.length;) {
          const actions = [session.required_actions[n++]!];
          if (ports.parallelRead?.(actions[0]!)) while (n < session.required_actions.length && ports.parallelRead(session.required_actions[n]!))
            actions.push(session.required_actions[n++]!);
          // Validate the entire batch's turn before dispatching any native work.
          for (const action of actions) if ('turn_id' in action && action.turn_id !== turn.turnId) throw new HostedSessionError('concurrent_turn');
          const results = await Promise.allSettled(actions.map(async action => {
            await ports.authorize();
            return ports.action(action);
          }));
          const failure = results.find(r => r.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
          for (let i = 0; i < actions.length; i++) {
            const result = results[i]!;
            if (result.status !== 'fulfilled') throw new Error('HOSTED_ACTION_FAILED');
            if (!result.value) return { status: 'waiting' };
            await respond(actions[i]!, result.value);
          }
        }
      };
      try {
        const session = await sessions.retrieve(sessionId, requestOptions(ports.signal));
        verify(session, ports.session);
        if (session.status === 'failed') throw new HostedSessionError('session_failed');
        if (turn.baseline === undefined) {
          if (session.status !== 'idle') throw new HostedSessionError('concurrent_turn');
          const previous = await latest();
          if (previous && !terminal(previous)) throw new HostedSessionError('concurrent_turn');
          await save({ ...turn, baseline: previous?.id ?? null });
        }
        if (!turn.submissionAttempted) {
          await save({ ...turn, submissionAttempted: true });
          await ports.authorize();
          await sessions.events.create(sessionId, { 'Idempotency-Key': turn.submissionKey,
            events: [{ type: 'agent.session.input.message', input: ports.input }] }, requestOptions(ports.signal));
        }
        // Recover saved results BEFORE interpreting live events or considering
        // any retry. An uncertain submission never gets a new message identity.
        const recovered = await reconcile();
        if (recovered) return recovered;
        if (!turn.turnId) {
          await ports.authorize();
          await sessions.events.create(sessionId, { 'Idempotency-Key': turn.submissionKey,
            events: [{ type: 'agent.session.input.message', input: ports.input }] }, requestOptions(ports.signal));
        }
        for await (const event of stream) {
          await ports.authorize();
          if ('turn' in event && event.turn.subagent_id === null && event.turn.id !== turn.baseline) {
            if (turn.turnId && event.turn.id !== turn.turnId) throw new HostedSessionError('concurrent_turn');
            if (!turn.turnId) await save({ ...turn, turnId: event.turn.id });
          }
          // Persist screenshots while the stream contains bytes; history can
          // omit them. Host item storage must upsert by item id, retaining bytes.
          if (event.type === 'agent.session.turn.item.done') await ports.item?.(event.item);
          await ports.event?.(event);
          if (event.type === 'agent.session.requires_action' || event.type === 'agent.session.turn.completed'
            || event.type === 'agent.session.turn.failed' || event.type === 'agent.session.turn.cancelled'
            || event.type === 'agent.session.failed') {
            const outcome = await reconcile();
            if (outcome) return outcome;
          }
        }
        const outcome = await reconcile();
        if (outcome) return outcome;
        throw new HostedSessionError('stream_disconnected');
      } finally { stream.controller.abort(); }
    },
    /** Acceptance is not settlement. The host must observe the original turn's
     * terminal state before acknowledging Stop or deleting the session. */
    async cancel(binding: HostedSessionBinding, turn: HostedTurnBinding, authorize: () => Promise<void>, signal: AbortSignal): Promise<void> {
      if (!binding.sessionId) return;
      await authorize();
      verify(await sessions.retrieve(binding.sessionId, requestOptions(signal)), binding);
      const latest = (await sessions.turns.list(binding.sessionId, { limit: 1, order: 'desc' }, requestOptions(signal))).data[0];
      if (!turn.turnId && !turn.submissionAttempted) return;
      if (!turn.turnId && (turn.baseline === undefined || !latest || latest.id === turn.baseline))
        throw new HostedSessionError('submission_uncertain');
      const current = turn.turnId
        ? await sessions.turns.retrieve(turn.turnId, { session_id: binding.sessionId }, requestOptions(signal)) : latest!;
      if (terminal(current)) return;
      if (latest?.id !== current.id) throw new HostedSessionError('concurrent_turn');
      await authorize();
      await sessions.events.create(binding.sessionId, { events: [{ type: 'agent.session.input.cancel' }] }, requestOptions(signal));
    },
    async remove(binding: HostedSessionBinding, authorize: () => Promise<void>, signal: AbortSignal): Promise<void> {
      if (!binding.sessionId) return;
      await authorize();
      const session = await sessions.retrieve(binding.sessionId, requestOptions(signal));
      verify(session, binding);
      if (session.status !== 'idle' && session.status !== 'failed') throw new HostedSessionError('concurrent_turn');
      const latest = (await sessions.turns.list(binding.sessionId, { limit: 1, order: 'desc' }, requestOptions(signal))).data[0];
      if (latest && !terminal(latest)) throw new HostedSessionError('concurrent_turn');
      await sessions.delete(binding.sessionId, requestOptions(signal));
    },
    async artifact(binding: HostedSessionBinding, turnId: string, artifactId: string,
      authorize: () => Promise<void>, signal: AbortSignal): Promise<Response> {
      if (!binding.sessionId) throw new HostedSessionError('binding_conflict');
      await authorize();
      verify(await sessions.retrieve(binding.sessionId, requestOptions(signal)), binding);
      const artifact = await sessions.artifacts.retrieve(artifactId, { session_id: binding.sessionId }, requestOptions(signal));
      if (artifact.session_id !== binding.sessionId || artifact.turn_id !== turnId) throw new HostedSessionError('binding_conflict');
      await authorize();
      return sessions.artifacts.content(artifactId, { session_id: binding.sessionId }, requestOptions(signal));
    },
  };
}
