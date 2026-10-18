import { expect, it, vi } from "vitest";
import { ToolRegistry, type ToolDefinition } from "../../src/assistant/index.js";
import { createOpenAIResponsesProviderAdapter, type OpenAIResponsesProviderOptions,
  type OpenAIResponsesRequest } from "../../src/assistant/providers/openai.js";
import type { ProviderAdapterInvocation } from "../../src/assistant/providers/index.js";

const tool = (name: string): ToolDefinition => ({ name, description: `Operation ${name}`,
  input_schema: { type: "object", properties: {}, additionalProperties: false } });
const domain = Array.from({ length: 259 }, (_, index) => tool(`erp_tool_${index}`));
const auxiliary = [tool("auxiliary_status"), tool("auxiliary_help")];
const unauthorized = [tool("private_actor"), tool("private_capability")];
const registry = new ToolRegistry<undefined, { administrator: boolean }>();
for (const definition of [...domain, ...auxiliary]) registry.register({ definition, executor: undefined });
registry.register({ definition: unauthorized[0]!, executor: undefined, discover: context => context.administrator });
registry.register({ definition: unauthorized[1]!, executor: undefined, capabilities: ["private"] });
const authorized = registry.discover({ context: { administrator: false }, capabilities: [] });
const namespaces = [{ name: "erp", description: "ERP operations", toolNames: [...domain, ...unauthorized].map(tool => tool.name) },
  { name: "private_only", description: "Private operations", toolNames: ["private_capability"] }];
const fact = <T extends string | null>(id: T) => ({ id, source: "server_derived" as const, trust: "authoritative" as const });
const attribution = { organization: fact("org"), project: fact("project"), service_environment: fact("test"),
  known_user: fact("user"), session: fact(null), automation: fact(null) };
const invocation = (tools = authorized): ProviderAdapterInvocation => ({ tools,
  messages: [{ role: "user", content: [{ type: "text", text: "Check ERP" }] }], tool_results: [],
  generation: { max_output_tokens: 100, temperature: 0 }, signal: new AbortController().signal,
  context: { request_id: "request", trace_id: "trace", attribution, correlation_hints: {} } });
const completed = { type: "response.completed", response: { status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "Ready." }] }],
  usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };

function expectCompleteCatalog(request: OpenAIResponsesRequest) {
  const functions = request.tools.flatMap(tool => tool.type === "namespace" ? tool.tools : tool.type === "function" ? [tool] : []);
  expect(functions.map(tool => tool.name).sort()).toEqual(authorized.map(tool => tool.name).sort());
  expect(functions).toHaveLength(261);
  expect(request.tools.filter(tool => tool.type === "function").map(tool => tool.name).sort()).toEqual(auxiliary.map(tool => tool.name).sort());
  expect(request.tools.filter(tool => tool.type === "namespace")).toEqual([{ type: "namespace", name: "erp",
    description: "ERP operations", tools: domain.map(tool => ({ type: "function", name: tool.name,
      description: tool.description, parameters: tool.input_schema, strict: true, defer_loading: true })) }]);
  expect(request.tools).toContainEqual({ type: "tool_search", execution: "server" });
  expect(request.tools).toContainEqual({ type: "web_search" });
  expect(JSON.stringify(request.tools)).not.toContain("private_");
  expect(request).toMatchObject({ store: false, parallel_tool_calls: false });
}

it.each([
  { limit: undefined, accepted: false }, { limit: 260, accepted: false },
  { limit: 261, accepted: true }, { limit: 512, accepted: true }, { limit: 1024, accepted: true },
  ...[0, -1, 1.5, Infinity, -Infinity, NaN, 1025, Number.MAX_SAFE_INTEGER].map(limit => ({ limit, accepted: false })),
])("enforces provider total limit $limit with 259 domain and two auxiliary tools", async ({ limit, accepted }) => {
  const request = vi.fn<OpenAIResponsesProviderOptions["request"]>(async function* () { yield completed; });
  const adapter = createOpenAIResponsesProviderAdapter({ model: "fixture", request, namespaces,
    hosted: { webSearch: {} }, ...(limit === undefined ? {} : { maximumTotalTools: limit }) });
  const invalidLimit = limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024);
  const stream = adapter.invoke(invocation(invalidLimit ? [] : authorized));
  let step = await stream.next();
  while (!step.done) step = await stream.next();
  expect(step.value.status).toBe(accepted ? "completed" : "failed");
  if (accepted) {
    expect(request).toHaveBeenCalledOnce();
    expectCompleteCatalog(request.mock.calls[0]![0]);
  } else expect(request).not.toHaveBeenCalled();
});

it("does not relax the eager bound when the total limit increases", async () => {
  const request = vi.fn<OpenAIResponsesProviderOptions["request"]>(async function* () { yield completed; });
  const adapter = createOpenAIResponsesProviderAdapter({ model: "fixture", request, maximumTotalTools: 512 });
  const stream = adapter.invoke(invocation(domain.slice(0, 17)));
  let step = await stream.next();
  while (!step.done) step = await stream.next();
  expect(step.value.status).toBe("failed");
  expect(request).not.toHaveBeenCalled();
});

it.each([
  { name: "private_actor", namespace: "erp" },
  { name: "private_capability", namespace: "erp" },
  { name: "erp_tool_258", namespace: "wrong_namespace" },
])("rejects unadvertised or misnamespaced calls: $name / $namespace", async identity => {
  const adapter = createOpenAIResponsesProviderAdapter({ model: "fixture", namespaces, maximumTotalTools: 512,
    request: async function* () {
      yield { type: "response.function_call_arguments.done", call_id: "forbidden", ...identity, arguments: "{}" };
      yield completed;
    } });
  const stream = adapter.invoke(invocation());
  const events = [];
  let step = await stream.next();
  while (!step.done) { events.push(step.value); step = await stream.next(); }
  expect(step.value.status).toBe("failed");
  expect(events.some(event => event.type === "response.tool_call")).toBe(false);
});

it.each([false, true])("preserves the eager-only fallback when tool search is disabled (supports=%s)", async supportsToolSearch => {
  const request = vi.fn<OpenAIResponsesProviderOptions["request"]>(async function* () { yield completed; });
  const adapter = createOpenAIResponsesProviderAdapter({ model: "fixture", request, namespaces, maximumTotalTools: 512,
    supportsToolSearch, ...(supportsToolSearch ? { hosted: { toolSearch: false } } : {}) });
  const stream = adapter.invoke(invocation());
  let step = await stream.next();
  while (!step.done) step = await stream.next();
  expect(step.value.status).toBe("completed");
  expect(request.mock.calls[0]?.[0].tools.map(tool => tool.type === "function" ? tool.name : tool.type).sort())
    .toEqual(auxiliary.map(tool => tool.name).sort());
});

it.each([undefined, 260, 261, 512])("forwards total limit %s through the public server provider", async maximumTotalTools => {
  const { openaiResponses } = await import("../../src/assistant/server/openai-responses.js");
  const { InMemoryOpenAIResponsesContinuationStore } = await import("../../src/assistant/providers/openai-responses.js");
  const request = vi.fn<OpenAIResponsesProviderOptions["request"]>(async function* () { yield completed; });
  const provider = openaiResponses({ model: "fixture", request, namespaces, hosted: { webSearch: {} },
    ...(maximumTotalTools === undefined ? {} : { maximumTotalTools }) });
  const execute = vi.fn();
  const input: Parameters<typeof provider.createTransport>[0] = {
    context: { principalId: "user", tenantId: "tenant", scopeId: "owner", attribution }, instructions: [],
    tools: { definitions: authorized, execute, awaitApproval: vi.fn() },
    persistence: { continuation: { forConversation: () => new InMemoryOpenAIResponsesContinuationStore() },
      usageAdmissions: null, usageReceiptSink: null } as unknown as Parameters<typeof provider.createTransport>[0]["persistence"],
    limits: { maxIterations: 4, maxTotalToolCalls: 4, maxElapsedMs: 10_000, parallelism: 1 },
    toolActivity: { waitForApproval: async () => { throw new Error("Unexpected approval"); },
      observe: async (_location, run) => (await run(async () => {})).value },
  };
  const transport = await provider.createTransport(input);
  const started = await transport.startTurn({ conversationId: "conversation", conversationTurnId: "turn" as never,
    mutationId: "mutation" as never, idempotencyKey: "request", request: {
      protocol_version: "handrail.ai-runtime.v1", continuation_of: null, messages: [...invocation().messages], tools: [], tool_results: [],
      generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {},
    } });
  if (!started.ok) throw new Error(started.error.message);
  for await (const event of started.value.observation.events) void event;
  const accepted = maximumTotalTools !== undefined && maximumTotalTools >= 261;
  expect(await started.value.observation.result).toMatchObject({ status: accepted ? "completed" : "failed" });
  expect(request).toHaveBeenCalledTimes(accepted ? 1 : 0);
  if (accepted) expectCompleteCatalog(request.mock.calls[0]![0]);
  expect(execute).not.toHaveBeenCalled();
});
