import type { McpListedTool } from "./index.js";
import { createToolPlugin } from "../tools/plugin.js";
import type { ApplicationToolAdmission, ApplicationToolExecutor } from "../tools/executor.js";
import type { JsonObject, JsonValue } from "../protocol.js";

export interface McpRegistryTool<C = unknown> extends McpListedTool {
  readonly scopes: readonly string[];
  readonly mutation: boolean;
  /** Supply for sending email, quotes or Spectrum packages, deletion, and money/accounting.
   * Name the actual record and recipient using the reviewed arguments. */
  readonly confirmation?: (args: JsonObject, context: C) => string | Promise<string>;
  readonly confirmRequired?: boolean;
}

/** A grant belongs to one registry, client, tenant and principal. Scope acceptance is per tool. */
export interface McpToolGrant {
  readonly name: string;
  readonly scopes: readonly string[];
}

export interface AssistantMcpRegistry<C> {
  readonly id: string;
  readonly tools: readonly McpRegistryTool<C>[];
  /** Use the durable turn approval preference for optional action confirmations. */
  readonly confirmationMode?: "always" | "policy";
  readonly visible: (context: C, name: string) => boolean;
  /** Resolve current app permissions, including on receipt replay and approval resume. */
  readonly authorize: (context: C, tool: McpRegistryTool<C>, args: JsonObject) => Promise<boolean>;
  /** Invoke the same audited handler as /mcp. Throw for an unsuccessful domain operation. */
  readonly callTool: (input: { context: C; name: string; arguments: JsonObject;
    idempotencyKey: string; signal: AbortSignal }) => Promise<JsonValue>;
  /** Called before domain IO. Use the idempotency key to correlate the registry's completion audit. */
  readonly audit?: (input: { context: C; name: string; idempotencyKey: string }) => Promise<void>;
}

/** Build once for each trusted registry revision. No HTTP loopback or OAuth credential forwarding. */
export function createAssistantMcpRegistry<C>(registry: AssistantMcpRegistry<C>) {
  const tools = registry.tools.map(tool => Object.freeze({ ...tool, scopes: Object.freeze([...tool.scopes]),
    annotations: Object.freeze({ ...tool.annotations }) }));
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  for (const tool of tools) {
    if ((tool.confirmRequired || tool.annotations.destructiveHint) && !tool.confirmation)
      throw new TypeError(`Supply an action-specific confirmation for ${tool.name}`);
  }
  const admission: ApplicationToolAdmission<C> = async input => {
    const tool = byName.get(input.definition.name);
    if (!tool) return { outcome: "allow" };
    return { outcome: registry.visible(input.applicationContext, tool.name) &&
      await registry.authorize(input.applicationContext, tool, input.arguments) === true ? "allow" : "deny" };
  };
  const plugin = createToolPlugin<ApplicationToolExecutor<C>, C, C, C>({
    pluginId: registry.id, version: "1.0.0", displayName: registry.id,
    registrations: tools.map(tool => ({
      definition: { name: tool.name, description: tool.description || tool.name, input_schema: tool.inputSchema },
      discover: context => registry.visible(context, tool.name),
      executor: async (args, execution) => {
        const context = execution.applicationContext;
        const idempotencyKey = execution.executionKey ?? execution.toolCallId;
        await registry.audit?.({ context, name: tool.name, idempotencyKey });
        execution.signal.throwIfAborted();
        const result = await registry.callTool({ context, name: tool.name, arguments: args, idempotencyKey, signal: execution.signal });
        if (result && typeof result === "object" && !Array.isArray(result) && result.isError === true)
          throw new Error("MCP tool reported an error");
        return result;
      },
    })),
    approvals: tools.flatMap(tool => tool.confirmation ? [{
      toolName: tool.name, mode: tool.confirmRequired ? "always" as const : registry.confirmationMode ?? "always", summarize: (args: JsonObject, context: unknown) => tool.confirmation!(args, context as C),
    }] : []),
  });
  return { plugin, admission,
    async confirmation(name: string, args: JsonObject, context: C) {
      const format = byName.get(name)?.confirmation;
      if (!format) return undefined;
      const question = await format(args, context);
      if (typeof question !== "string" || !question.trim() || question.length > 512 || /[\u0000-\u001f\u007f]/u.test(question))
        throw new TypeError("Provide a single-line action confirmation of up to 512 characters");
      return question;
    },
    review: (context: C) => ({ additions: [], mutationTools: tools.filter(tool =>
      registry.visible(context, tool.name) && (tool.mutation || tool.annotations.destructiveHint)).map(tool => tool.name) }),
  };
}
