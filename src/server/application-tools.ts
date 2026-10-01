import { applicationToolParameters } from './agent-tool-schema.js';
import type { ToolDefinition } from '@handrail/ai-assistant';
import type { HandrailAssistantToolObserver } from '@handrail/ai-assistant/server/assistant';
import type { AgentCall, AgentRuntimeTool } from './agent-runtime.js';
import type { EffectRequest, EffectObservation } from './effects.js';

export interface ApplicationAgentTools {
  /** Trusted server catalog, already filtered for the current principal. */
  readonly definitions: readonly ToolDefinition[];
  /** Domain classification; unknown/mutation tools must never become reads. */
  readonly isReadOnly: (name: string) => boolean;
  readonly read: (call: AgentCall, signal: AbortSignal) => Promise<string>;
  /** Bind to the existing immutable domain intent and effect adapter. */
  readonly bind: (call: AgentCall) => Promise<EffectRequest>;
  readonly result: (call: AgentCall, receipt: Extract<EffectObservation, { outcome: 'verified' }>, signal: AbortSignal) => Promise<string>;
}
/** Compile the unchanged application JSON-schema catalog once on the server.
 * The runtime sends non-strict JSON Schema and validates before approval and IO.
 * Unsupported dialects, keywords and formats fail construction.
 * Change definitionRef when the catalog/schema or business meaning changes. */
export function createApplicationAgentTools(adapter: ApplicationAgentTools): readonly AgentRuntimeTool[] {
  return adapter.definitions.map(definition => {
    const parameters = applicationToolParameters(definition.input_schema);
    const base = { name: definition.name, description: definition.description, parameters };
    return adapter.isReadOnly(definition.name)
      ? { ...base, kind: 'read', execute: adapter.read }
      : { ...base, kind: 'effect', bind: adapter.bind, readResult: adapter.result };
  });
}

/** Preserve native web/Flutter tool result presentation and activity. Call from
 * the authorized tool boundary. The observer owns canonical tool event writes;
 * it does not grant approval or replace the SDK effect ledger. */
export function observeApplicationAgentTool<T>(observer: HandrailAssistantToolObserver,
  location: { conversationId: string; turnId: string }, call: AgentCall, signal: AbortSignal,
  execute: () => Promise<T>): Promise<T> {
  return observer.observe({ ...location, signal, call: { name: call.toolName, tool_call_id: call.effectRef,
    arguments: call.input as Parameters<HandrailAssistantToolObserver['observe']>[0]['call']['arguments'] } },
  async () => ({ value: await execute() }));
}
