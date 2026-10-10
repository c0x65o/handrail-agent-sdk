import { applicationToolParameters } from './agent-tool-schema.js';
import type { ToolDefinition } from '@handrail/ai-assistant';
import type { HandrailAssistantToolObserver } from '@handrail/ai-assistant/server/assistant';
import type { AgentCall, AgentRuntimeTool } from './agent-runtime.js';
import type { EffectRequest, EffectObservation } from './effects.js';
import type { MCPServer } from '@openai/agents';

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

export interface McpAgentTools {
  /** Connected, authenticated server owned by the host. Standard OpenAI Agents
   * HTTP/SSE/stdio MCP transports implement this interface. Close it on shutdown. */
  readonly server: Pick<MCPServer, 'listTools' | 'callToolResult'>;
  /** Trusted host selection and classification; remote annotations alone are
   * not permission and must not silently classify unknown tools as reads. */
  readonly allowTool: (name: string) => boolean;
  readonly isReadOnly: (name: string) => boolean;
  /** Mutations use the same durable effect path as application tools. The host
   * effect adapter performs MCP IO with the original idempotency identity and
   * reconciles uncertain results; this helper never retries a mutation. */
  readonly bind: ApplicationAgentTools['bind'];
  readonly result: ApplicationAgentTools['result'];
}

/** Import a scoped MCP catalog into the durable runtime, preserving schemas
 * and the full serializable result (content, structuredContent and isError).
 * Transport credentials, connection ownership and effect reconciliation remain
 * with the host. The same tool authority check protects MCP and local tools. */
export async function createMcpAgentTools(adapter: McpAgentTools): Promise<readonly AgentRuntimeTool[]> {
  if (typeof adapter.server.callToolResult !== 'function') throw Error('MCP_FULL_RESULT_REQUIRED');
  const definitions = (await adapter.server.listTools()).filter(tool => adapter.allowTool(tool.name));
  return createApplicationAgentTools({
    definitions: definitions.map(tool => ({ name: tool.name, description: tool.description ?? tool.name,
      input_schema: tool.inputSchema })),
    isReadOnly: adapter.isReadOnly,
    read: async (call, signal) => JSON.stringify(await adapter.server.callToolResult!(call.toolName, call.input,
      { 'handrail/callRef': call.effectRef }, { signal })),
    bind: adapter.bind,
    result: adapter.result,
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
