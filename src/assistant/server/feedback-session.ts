import { createRequestScopedMcpSession } from "../mcp/index.js";
import { parseToolDefinition, type JsonValue } from "../protocol.js";
import type { FeedbackContext, FeedbackKind } from "./feedback.js";

export interface FeedbackRuntime {
  readonly projectId: string;
  readonly serviceEnvId: string;
  readonly environment: "dev" | "staging" | "production";
}
export interface FeedbackReporters {
  readonly bug?: { apiBaseUrl: string; reportToken: string };
  readonly enhancement?: { apiUrl: string; capabilityId: string; token: string };
  readonly fetch?: typeof fetch;
}
export const operations = ["submit", "list", "lookup", "answer", "follow_up", "stop_follow_up"] as const;
export type Operation = (typeof operations)[number];
export const nameFor = (kind: FeedbackKind, op: Operation) => `handrail_${kind}_reporter_v1_${op}`;
export const catalog = new Map(
  (["bug", "enhancement"] as const).flatMap((kind) =>
    operations.map((op) => [nameFor(kind, op), { kind, op }] as const),
  ),
);

export function reporterConfig(runtime: FeedbackRuntime, credentials: FeedbackReporters) {
  return {
    fetch: credentials.fetch,
    bug: { ...credentials.bug, ...runtime, enabled: !!credentials.bug, transport: "server" },
    enhancement: {
      ...credentials.enhancement,
      ...runtime,
      enabled: !!credentials.enhancement,
      contractVersion: "v1",
    },
  };
}

export async function openSession(
  context: FeedbackContext,
  signal: AbortSignal,
  runtime: FeedbackRuntime,
  credentials: FeedbackReporters,
  current: (FeedbackContext & { sessionToken: string }) | null,
) {
  if (
    !current?.sessionToken ||
    current.tenantId !== context.tenantId ||
    current.principalId !== context.principalId ||
    current.scopeId !== context.scopeId
  )
    throw new Error("Feedback authentication required");
  return createRequestScopedMcpSession(
    {
      connectorId: "handrail-feedback",
      authorize: ({ toolName }) => (toolName === undefined || catalog.has(toolName) ? "allow" : "deny"),
      connect: async () => {
        // Optional server packages are loaded only for installations that enable Handrail Feedback.
        // @ts-expect-error The pinned public connector ships JavaScript without type declarations.
        const { createConnectorServer } = await import("@handrail/mcp");
        const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
        const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
        const { server, feedbackRuntime } = await createConnectorServer({
          profile: "feedback-only",
          env: {},
          feedbackConfig: { ...reporterConfig(runtime, credentials), sessionToken: current.sessionToken },
        });
        const client = new Client({ name: "handrail-feedback", version: "1" });
        const close = async () => {
          await Promise.allSettled([client.close(), server.close()]);
        };
        try {
          const enhancement = feedbackRuntime.readiness?.reporters.enhancement;
          if (enhancement?.ready && enhancement.discovery.capability.environment !== runtime.environment)
            throw new Error("Feedback environment mismatch");
          const [local, remote] = InMemoryTransport.createLinkedPair();
          await server.connect(remote);
          await client.connect(local);
          return {
            close,
            listTools: async () => ({
              tools: (await client.listTools()).tools
                .filter((t) => catalog.has(t.name))
                .map((t) => ({
                  name: t.name,
                  description: t.description ?? t.name,
                  inputSchema: parseToolDefinition({
                    name: t.name,
                    description: t.description ?? t.name,
                    input_schema: t.inputSchema,
                  }).input_schema,
                })),
            }),
            callTool: async ({ name, arguments: args, signal }) => {
              const result = await client.callTool({ name, arguments: args }, undefined, { signal });
              if (result.isError || !result.structuredContent)
                throw new Error("Feedback operation unconfirmed");
              return JSON.parse(JSON.stringify({ structuredContent: result.structuredContent })) as JsonValue;
            },
          };
        } catch (error) {
          await close();
          throw error;
        }
      },
    },
    context,
    signal,
  );
}
