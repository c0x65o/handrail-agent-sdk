import { describe, expect, it } from "vitest";

import {
  createDeferredToolDiscoveryPlan,
  findDeferredTool,
  findDeferredToolNamespace,
  type ToolDefinition,
} from "../../src/assistant/index.js";

const tool = (name: string): ToolDefinition => ({
  name,
  description: `Tool ${name}`,
  input_schema: { type: "object", properties: {}, additionalProperties: false },
});

describe("deferred tool discovery", () => {
  it("keeps a large actor-filtered catalog deferred by stable namespaces", () => {
    const tools = Array.from({ length: 89 }, (_, index) => tool(`erp_tool_${index}`));
    const plan = createDeferredToolDiscoveryPlan({
      tools,
      namespaces: Array.from({ length: 9 }, (_, namespaceIndex) => ({
        name: `erp_${namespaceIndex}`,
        description: `ERP namespace ${namespaceIndex}`,
        toolNames: tools
          .slice(namespaceIndex * 10, Math.min((namespaceIndex + 1) * 10, tools.length))
          .map((item) => item.name),
      })),
      includeUnassigned: false,
    });

    expect(plan.toolCount).toBe(89);
    expect(plan.eagerTools).toHaveLength(0);
    expect(findDeferredToolNamespace(plan, "erp_8")?.tools).toHaveLength(9);
    expect(findDeferredTool(plan, "erp_tool_88")?.name).toBe("erp_tool_88");
  });

  it("rejects namespace references that are not in the filtered catalog", () => {
    expect(() => createDeferredToolDiscoveryPlan({
      tools: [tool("allowed")],
      namespaces: [{
        name: "private_tools",
        description: "Private tools",
        toolNames: ["not_authorized"],
      }],
    })).toThrow(/undiscovered tool/u);
  });

  it("bounds eager fallback projection", () => {
    expect(() => createDeferredToolDiscoveryPlan({
      tools: [tool("one"), tool("two")],
      namespaces: [],
      maximumEagerTools: 1,
    })).toThrow(/maximumEagerTools/u);
  });

  it.each([
    [undefined, 256, true], [undefined, 257, false],
    [1, 1, true], [1, 2, false], [261, 261, true], [261, 262, false],
    [1024, 1024, true], [1024, 1025, false],
  ] as const)("bounds the complete catalog at %s for %s tools", (maximumTotalTools, count, accepted) => {
    const tools = Array.from({ length: count }, (_, index) => tool(`erp_tool_${index}`));
    const create = () => createDeferredToolDiscoveryPlan({ tools,
      namespaces: [{ name: "erp", description: "ERP", toolNames: tools.map(tool => tool.name) }],
      ...(maximumTotalTools === undefined ? {} : { maximumTotalTools }),
    });
    if (!accepted) expect(create).toThrow("Discovered tool catalog exceeds maximumTotalTools");
    else {
      const plan = create();
      expect(plan.toolCount).toBe(count);
      expect(plan.namespaces[0]?.tools).toEqual(tools);
      expect(plan.eagerTools).toEqual([]);
    }
  });

  it.each([0, -1, 1.5, Infinity, -Infinity, NaN, 1025, Number.MAX_SAFE_INTEGER])(
    "rejects invalid total limit %s", maximumTotalTools => {
      expect(() => createDeferredToolDiscoveryPlan({ tools: [], namespaces: [], maximumTotalTools }))
        .toThrow("maximumTotalTools must be an integer between 1 and 1024");
    },
  );

  it("keeps namespace integrity and schema validation with a larger limit", () => {
    const options = { tools: [tool("allowed")], maximumTotalTools: 512 };
    const namespace = { name: "erp", description: "ERP", toolNames: ["allowed"] };
    expect(() => createDeferredToolDiscoveryPlan({ ...options, tools: [...options.tools, tool("allowed")], namespaces: [] }))
      .toThrow(/Duplicate tool/u);
    expect(() => createDeferredToolDiscoveryPlan({ ...options, namespaces: [namespace, namespace] }))
      .toThrow(/Duplicate tool namespace/u);
    expect(() => createDeferredToolDiscoveryPlan({ ...options, namespaces: [namespace, { ...namespace, name: "other" }] }))
      .toThrow(/multiple namespaces/u);
    expect(() => createDeferredToolDiscoveryPlan({ ...options, namespaces: [{ ...namespace, toolNames: ["unauthorized"] }] }))
      .toThrow(/undiscovered tool/u);
    expect(() => createDeferredToolDiscoveryPlan({ ...options, namespaces: [],
      // Exercise malformed runtime input that a typed host would reject at compile time.
      tools: [{ ...tool("invalid"), input_schema: { type: "string" } as unknown as ToolDefinition["input_schema"] }] })).toThrow();
  });
});
