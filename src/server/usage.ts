import { createHash, randomUUID } from 'node:crypto';
import type { Model } from '@openai/agents';
import type { Turn } from 'openai/resources/beta/agents/sessions/turns/turns';
import type { AuthoritativeAttribution } from '../assistant/protocol.js';
import { parseNormalizedUsageReceipt, type NormalizedTokenUsage,
  type NormalizedUsageQuantity, type UsageReceiptTerminalStatus } from '../assistant/usage.js';
import type { AIRuntimeUsageReceiptSink } from '../assistant/server/usage-control.js';

export { createAIRuntimeUsageClient, createAIRuntimeUsageClientFromEnv,
  createAIRuntimeUsageReceiptSink, createAIRuntimeUsageDelivery } from '../assistant/server/usage-control.js';
export type { AIRuntimeUsageClient, AIRuntimeUsageOutbox, AIRuntimeUsageReceiptSink } from '../assistant/server/usage-control.js';

export interface AgentUsageScope {
  readonly conversationId: string;
  readonly turnId: string;
  readonly logicalRequestId: string;
  readonly traceId: string;
  readonly providerId: string;
  readonly modelId: string;
  /** Resolve on the trusted server, never from the chat request. */
  readonly attribution: AuthoritativeAttribution;
}

export interface AgentUsageOptions {
  readonly model: Model;
  readonly scope: AgentUsageScope;
  readonly sink: Pick<AIRuntimeUsageReceiptSink, 'capture'>;
  /** A Handrail-managed provider already reports usage at its gateway. */
  readonly settlementOwner: 'application' | 'handrail';
  readonly now?: () => Date;
  readonly invocationId?: () => string;
  /** Non-OpenAI adapters may project their own raw provider usage. */
  readonly projectUsage?: (raw: Readonly<Record<string, unknown>> | undefined) => NormalizedTokenUsage;
}

const quantity = (value: unknown): NormalizedUsageQuantity =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { status: 'reported', value } : { status: 'unavailable' };
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Preserve unknown versus reported zero. Never use the Runner's synthesized
 * zero defaults or accumulated totals as per-invocation provider evidence. */
export function projectAgentProviderUsage(raw: Readonly<Record<string, unknown>> | undefined): NormalizedTokenUsage {
  return {
    input_tokens: quantity(raw?.input_tokens ?? raw?.prompt_tokens),
    cached_input_tokens: quantity(object(raw?.input_tokens_details ?? raw?.prompt_tokens_details).cached_tokens),
    output_tokens: quantity(raw?.output_tokens ?? raw?.completion_tokens),
    reasoning_tokens: quantity(object(raw?.output_tokens_details ?? raw?.completion_tokens_details).reasoning_tokens),
    total_tokens: quantity(raw?.total_tokens),
  };
}

/** Meter the provider's saved root turn, not SSE deltas or session cumulative
 * totals. Persist this receipt with the turn checkpoint before outbox delivery;
 * recovery must reuse that frozen receipt because provider usage may settle
 * later. A missing usage value stays unavailable rather than becoming zero. */
export function createHostedTurnUsageReceipt(options: { turn: Turn; sessionId: string; scope: AgentUsageScope }) {
  const { turn, scope } = options;
  if (turn.session_id !== options.sessionId || turn.subagent_id !== null
    || !['completed', 'failed', 'cancelled'].includes(turn.status)) throw new Error('HOSTED_USAGE_TURN_INVALID');
  const identity = createHash('sha256').update(JSON.stringify([
    scope.attribution, scope.conversationId, scope.turnId, scope.providerId, scope.modelId, options.sessionId, turn.id,
  ])).digest('hex');
  return parseNormalizedUsageReceipt({
    version: 1, usage_receipt_id: `hosted-agent:${identity}`,
    ...(turn.completed_at === null ? {} : { occurred_at: new Date(turn.completed_at * 1000).toISOString() }),
    conversation_id: scope.conversationId, turn_id: scope.turnId,
    logical_request_id: scope.logicalRequestId, trace_id: scope.traceId,
    attempt: { id: turn.id, index: 0 }, continuation: { id: turn.id, index: 0 },
    provider_id: scope.providerId, model_id: scope.modelId, attribution: scope.attribution,
    source: 'provider', terminal_status: turn.status,
    tokens: projectAgentProviderUsage(turn.usage ? { ...turn.usage } : undefined),
    provider_cost: { status: 'unavailable' },
  });
}

/** Capture before exposing model completion, then let the existing durable
 * outbox deliver/retry. Import/construction starts no worker or network call.
 * A process loss before the durable capture remains unmeasured; this wrapper
 * never replays the provider to manufacture missing billing evidence. */
export function createUsageTrackedAgentModel(options: AgentUsageOptions): Model {
  if (!['application', 'handrail'].includes(options.settlementOwner)) throw new TypeError('Invalid settlement owner');
  if (options.settlementOwner === 'handrail') return options.model;
  const scope = structuredClone(options.scope);
  const now = options.now ?? (() => new Date());
  const project = options.projectUsage ?? projectAgentProviderUsage;
  const start = () => {
    const invocation = (options.invocationId ?? randomUUID)();
    const occurredAt = now().toISOString();
    let captured = false;
    return {
      get captured() { return captured; },
      async capture(status: UsageReceiptTerminalStatus, response?: { id?: string | undefined; rawUsage?: Record<string, unknown> | undefined }) {
        if (captured) return;
        // One persistence attempt per invocation; failures propagate without
        // substituting an unmeasured receipt or retrying under a new identity.
        captured = true;
        const responseId = response?.id ?? invocation;
        const identity = createHash('sha256').update(JSON.stringify([
          scope.attribution, scope.conversationId, scope.turnId, scope.providerId, scope.modelId, responseId,
        ])).digest('hex');
        await options.sink.capture(parseNormalizedUsageReceipt({
          version: 1, occurred_at: occurredAt, usage_receipt_id: `agent:${identity}`,
          conversation_id: scope.conversationId, turn_id: scope.turnId,
          logical_request_id: scope.logicalRequestId, trace_id: scope.traceId,
          attempt: { id: invocation, index: 0 }, continuation: { id: responseId, index: 0 },
          provider_id: scope.providerId, model_id: scope.modelId, attribution: scope.attribution,
          source: 'provider', terminal_status: status, tokens: project(response?.rawUsage),
          provider_cost: { status: 'unavailable' },
        }));
      },
    };
  };
  const requestWithUsage = (request: Parameters<Model['getResponse']>[0]) =>
    ({ ...request, modelSettings: { ...request.modelSettings, preserveRawUsage: true } });
  return {
    ...(options.model.supportsPromptModelSelection === undefined ? {} :
      { supportsPromptModelSelection: options.model.supportsPromptModelSelection }),
    ...(options.model.getRetryAdvice ? { getRetryAdvice: options.model.getRetryAdvice.bind(options.model) } : {}),
    async getResponse(request) {
      const invocation = start();
      try {
        const response = await options.model.getResponse(requestWithUsage(request));
        await invocation.capture('completed', {
          ...(response.responseId === undefined ? {} : { id: response.responseId }),
          ...(response.rawUsage === undefined ? {} : { rawUsage: response.rawUsage }),
        });
        return response;
      } finally {
        if (!invocation.captured) await invocation.capture(request.signal?.aborted ? 'cancelled' : 'failed');
      }
    },
    async *getStreamedResponse(request) {
      const invocation = start();
      try {
        for await (const event of options.model.getStreamedResponse(requestWithUsage(request))) {
          if (event.type === 'response_done') await invocation.capture('completed', event.response);
          yield event;
        }
      } finally {
        if (!invocation.captured) await invocation.capture(request.signal?.aborted ? 'cancelled' : 'failed');
      }
    },
  };
}
