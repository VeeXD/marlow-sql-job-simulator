import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    env: {
      ENABLE_WORKER: "false",
      LOG_LEVEL: "silent",
      LLM_PROVIDER: "mock",
      ALLOW_DEBUG_CLOCK: "true",
      STATEMENT_TIMEOUT_MS: "4000",
    },
  },
});
