import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    exclude: ["tests/e2e/bidi/**/*.test.ts"],
    // Cleanup relies on real, distinct OS PIDs/process groups (ps scans +
    // process.kill(-pid, ...)) to isolate one worker's browsers from another's,
    // so this suite must run in separate processes, not worker threads.
    pool: "forks",
    maxWorkers: 4,
    globalSetup: ["tests/helpers/browser-process-cleanup.global-setup.ts"],
    setupFiles: [
      "tests/helpers/browser-process-cleanup.setup.ts",
      "tests/helpers/playwright-expect.setup.ts"
    ],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
