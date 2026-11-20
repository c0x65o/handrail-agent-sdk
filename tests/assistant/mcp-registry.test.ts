import { expect, it, vi } from "vitest";
import { createAssistantMcpRegistry, type McpToolGrant } from "../../src/assistant/mcp/index.js";
import { createAiApplication } from "../../src/assistant/server/application.js";

it("requires grant expansion and confirmation independently and rechecks permission on replay", async () => {
  const context = { grant: [{ name: "send", scopes: [] }] as readonly McpToolGrant[] };
  const common = { inputSchema: { type: "object" as const }, scopes: [], mutation: false };
  const callTool = vi.fn(async () => ({ ok: true }));
  const authorize = vi.fn(async () => true);
  const audit = vi.fn(async () => {});
  const bridge = createAssistantMcpRegistry<typeof context>({ id: "erp", tools: [
    { ...common, name: "send", scopes: ["mail"], mutation: true, confirmRequired: true },
    { ...common, name: "lookup" },
    { ...common, name: "remove", annotations: { destructiveHint: true } },
    { ...common, name: "private" },
  ], visible: (_, name) => name !== "private", grant: c => c.grant, authorize, audit, callTool });
  const app = await createAiApplication({ plugins: [bridge.plugin], installContext: context,
    policy: () => ({ outcome: "allow" }), toolAdmission: bridge.admission });
  const execute = (name: string) => app.executeTool({ applicationContext: context, discovery: { context },
    call: { name, arguments: {}, tool_call_id: name }, executionKey: name + "-scoped" });
  expect(app.discover({ context })).toEqual([]);
  const { additions, mutationTools } = bridge.review(context);
  expect(additions).toEqual([{ name: "send", scopes: ["mail"] }, { name: "lookup", scopes: [] }, { name: "remove", scopes: [] }]);
  expect(mutationTools).toEqual(["send", "remove"]);
  expect(() => bridge.acceptReviewed(context, [...additions, { name: "private", scopes: [] }])).toThrow();
  context.grant = bridge.acceptReviewed(context, additions);
  expect(bridge.review(context).additions).toEqual([]);
  for (const name of ["send", "remove"]) expect(await execute(name)).toMatchObject({ status: "external_approval_required" });
  expect(audit).not.toHaveBeenCalled();
  expect(callTool).not.toHaveBeenCalled();
  expect(await execute("lookup")).toMatchObject({ result: { is_error: false } });
  expect(callTool).toHaveBeenCalledWith(expect.objectContaining({ context, idempotencyKey: "lookup-scoped" }));
  expect(audit).toHaveBeenCalledOnce();
  authorize.mockResolvedValue(false);
  expect(await execute("lookup")).toMatchObject({ result: { is_error: true } });
  expect(callTool).toHaveBeenCalledTimes(1);
});
