import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // The nested app template resolves its public SDK import against our normal
  // build; tests do not install or rewrite the template's frozen dependency.
  resolve: { alias: {
    "handrail-agent-sdk/assistant/persistence/postgres": fileURLToPath(new URL("./dist/assistant/postgres/index.js", import.meta.url)),
  } },
  test: { env: { NODE_ENV: "test" }, environment: "node", include: ["tests/assistant/**/*.test.{ts,tsx}"], maxWorkers: 1, minWorkers: 1, fileParallelism: false },
});
