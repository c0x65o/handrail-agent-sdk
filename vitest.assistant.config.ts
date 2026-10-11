import { defineConfig } from "vitest/config";

export default defineConfig({ test: { env: { NODE_ENV: "test" }, environment: "node", include: ["tests/assistant/**/*.test.{ts,tsx}"], maxWorkers: 1, minWorkers: 1, fileParallelism: false } });
