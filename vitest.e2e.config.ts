import { defineConfig } from "vitest/config";

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

const E2E_MAX_WORKERS = positiveIntegerEnv("ROXY_E2E_MAX_WORKERS", 4);

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    exclude: ["tests/e2e/bidi/**/*.test.ts"],
    // Cleanup relies on real, distinct OS PIDs/process groups (ps scans +
    // process.kill(-pid, ...)) to isolate one worker's browsers from another's,
    // so this suite must run in separate processes, not worker threads.
    pool: "forks",
    maxWorkers: E2E_MAX_WORKERS,
    globalSetup: ["tests/helpers/browser-process-cleanup.global-setup.ts"],
    setupFiles: [
      "tests/helpers/browser-process-cleanup.setup.ts",
      "tests/helpers/playwright-expect.setup.ts"
    ],
    environment: "node",
    // Keep the test harness timeout above Playwright-style operation timeouts
    // so page/navigation APIs can reject and run cleanup instead of Vitest
    // aborting the worker at the same 30s boundary.
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
