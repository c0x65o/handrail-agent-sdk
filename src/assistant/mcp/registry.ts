import type { McpListedTool } from "./index.js";
import { createToolPlugin } from "../tools/plugin.js";
import type { ApplicationToolAdmission, ApplicationToolExecutor } from "../tools/executor.js";
import type { JsonObject, JsonValue } from "../protocol.js";

export interface McpRegistryTool extends McpListedTool {
  readonly scopes: readonly string[];
  readonly mutation: boolean;
  readonly confirmRequired?: boolean;
}

/** A grant belongs to one registry, client, tenant and principal. Scope acceptance is per tool. */
export interface McpToolGrant {
  readonly name: string;
  readonly scopes: readonly string[];
}

export interface AssistantMcpRegistry<C> {
  readonly id: string;
  readonly tools: readonly McpRegistryTool[];
  readonly visible: (context: C, name: string) => boolean;
  readonly grant: (context: C) => readonly McpToolGrant[];
  /** Resolve current permissions AND consent, including on receipt replay and approval resume. */
  readonly authorize: (context: C, tool: McpRegistryTool, args: JsonObject) => Promise<boolean>;
  /** Invoke the same audited handler as /mcp. Throw for an unsuccessful domain operation. */
  readonly callTool: (input: { context: C; name: string; arguments: JsonObject;
    idempotencyKey: string; signal: AbortSignal }) => Promise<JsonValue>;
  /** Called before domain IO. Use the idempotency key to correlate the registry's completion audit. */
  readonly audit?: (input: { context: C; name: string; idempotencyKey: string }) => Promise<void>;
}

function missing(tool: McpRegistryTool, grant: readonly McpToolGrant[]): McpToolGrant | undefined {
  const accepted = grant.find(entry => entry.name === tool.name);
  const scopes = [...new Set(tool.scopes.filter(scope => !accepted?.scopes.includes(scope)))].sort();
  if (!accepted || scopes.length) return { name: tool.name, scopes };
}

/** Build once for each trusted registry revision. No HTTP loopback or OAuth credential forwarding. */
export function createAssistantMcpRegistry<C>(registry: AssistantMcpRegistry<C>) {
  const tools = registry.tools.map(tool => Object.freeze({ ...tool, scopes: Object.freeze([...tool.scopes]),
    annotations: Object.freeze({ ...tool.annotations }) }));
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const allowed = (context: C, tool: McpRegistryTool) => registry.visible(context, tool.name) &&
    !missing(tool, registry.grant(context));
  const admission: ApplicationToolAdmission<C> = async input => {
    const tool = byName.get(input.definition.name);
    if (!tool) return { outcome: "allow" };
    return { outcome: allowed(input.applicationContext, tool) &&
      await registry.authorize(input.applicationContext, tool, input.arguments) === true ? "allow" : "deny" };
  };
  const requiresConfirmation = (tool: McpRegistryTool) => tool.confirmRequired || tool.annotations?.destructiveHint === true;
  const plugin = createToolPlugin<ApplicationToolExecutor<C>, C, C, C>({
    pluginId: registry.id, version: "1.0.0", displayName: registry.id,
    registrations: tools.map(tool => ({
      definition: { name: tool.name, description: tool.description || tool.name, input_schema: tool.inputSchema },
      discover: context => allowed(context, tool),
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
    approvals: tools.filter(requiresConfirmation).map(tool => ({
      toolName: tool.name, mode: "always", summarize: () => tool.description || tool.name,
    })),
  });
  function review(context: C) {
    const visible = tools.filter(tool => registry.visible(context, tool.name));
    const grant = registry.grant(context);
    return { additions: visible.flatMap(tool => missing(tool, grant) ?? []),
      mutationTools: visible.filter(tool => tool.mutation || tool.annotations.destructiveHint === true).map(tool => tool.name) };
  }
  return { plugin, admission,
    /** Return only this session's display metadata to the browser. */
    review,
    /** Call inside the host grant-store transaction, with its freshly loaded context.
     * The host commits this value to that same locked/versioned grant only. */
    acceptReviewed(context: C, reviewed: readonly McpToolGrant[]): readonly McpToolGrant[] {
      const additions = review(context).additions;
      if (reviewed.length !== additions.length || additions.some((entry, index) => {
        const submitted = reviewed[index];
        return submitted?.name !== entry.name || submitted.scopes.length !== entry.scopes.length ||
          entry.scopes.some((scope, offset) => scope !== submitted.scopes[offset]);
      })) throw new Error("Registry access request changed; review current permissions");
      const grant = new Map(registry.grant(context).map(entry => [entry.name, entry]));
      for (const entry of additions) {
        grant.set(entry.name, { name: entry.name, scopes: [...new Set([...(grant.get(entry.name)?.scopes ?? []), ...entry.scopes])] });
      }
      return [...grant.values()];
    },
  };
}
