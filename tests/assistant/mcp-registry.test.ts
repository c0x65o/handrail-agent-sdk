import { expect, it, vi } from "vitest";
import { createAssistantMcpRegistry } from "../../src/assistant/mcp/index.js";
import { createAiApplication } from "../../src/assistant/server/application.js";

it("uses signed-in permissions immediately, confirms risky actions and rechecks permission on replay", async () => {
  const context = { user: "scott" };
  const common = { inputSchema: { type: "object" as const }, scopes: [], mutation: false };
  const callTool = vi.fn(async () => ({ ok: true }));
  const authorize = vi.fn(async () => true);
  const audit = vi.fn(async () => {});
  const bridge = createAssistantMcpRegistry<typeof context>({ id: "erp", tools: [
    { ...common, name: "send", scopes: ["mail"], mutation: true, confirmation: args => `Send quote ${args.quote} to ${args.recipient}?` },
    { ...common, name: "lookup" },
    { ...common, name: "edit", mutation: true },
    { ...common, name: "remove", confirmation: args => `Delete record ${args.id}?`, annotations: { destructiveHint: true } },
    { ...common, name: "private" },
  ], visible: (_, name) => name !== "private", authorize, audit, callTool });
  const app = await createAiApplication({ plugins: [bridge.plugin], installContext: context,
    policy: () => ({ outcome: "allow" }), toolAdmission: bridge.admission });
  const execute = (name: string) => app.executeTool({ applicationContext: context, discovery: { context },
    call: { name, arguments: {}, tool_call_id: name }, executionKey: name + "-scoped" });
  expect(app.discover({ context }).map(tool => tool.name).sort()).toEqual(["edit", "lookup", "remove", "send"]);
  expect(bridge.review(context)).toEqual({ additions: [], mutationTools: ["send", "edit", "remove"] });
  expect(await bridge.confirmation("send", { quote: "2026-617", recipient: "Scott Murphy Daniel" }, context))
    .toBe("Send quote 2026-617 to Scott Murphy Daniel?");
  for (const name of ["send", "remove"]) expect(await execute(name)).toMatchObject({ status: "external_approval_required" });
  expect(audit).not.toHaveBeenCalled();
  expect(callTool).not.toHaveBeenCalled();
  expect(await execute("lookup")).toMatchObject({ result: { is_error: false } });
  expect(callTool).toHaveBeenCalledWith(expect.objectContaining({ context, idempotencyKey: "lookup-scoped" }));
  expect(audit).toHaveBeenCalledOnce();
  expect(await execute("edit")).toMatchObject({ result: { is_error: false } });
  authorize.mockResolvedValue(false);
  expect(await execute("lookup")).toMatchObject({ result: { is_error: true } });
  expect(callTool).toHaveBeenCalledTimes(2);
});
