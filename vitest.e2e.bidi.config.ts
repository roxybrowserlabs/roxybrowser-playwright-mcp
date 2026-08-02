import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

const envPath = resolve(process.cwd(), ".env");

if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

const BIDI_MAX_WORKERS = 1;

if (process.env.ROXYBROWSER_PROFILE_ID && BIDI_MAX_WORKERS > 1) {
  throw new Error(
    "ROXYBROWSER_PROFILE_ID pins every BiDi e2e worker to the same RoxyBrowser profile, " +
      "which breaks under parallel workers (maxWorkers > 1) because workers would race to " +
      "open/close the same profile concurrently. Unset ROXYBROWSER_PROFILE_ID (each worker " +
      "creates its own per-worker profile automatically) or use ROXYBROWSER_PROFILE_MATCH " +
      "instead if you need to target a specific existing profile by name/kernel."
  );
}

export default defineConfig({
  test: {
    include: ["tests/e2e/bidi/**/*.test.ts"],
    // Cleanup and per-worker RoxyBrowser profile naming rely on real, distinct OS
    // PIDs/process groups (ps scans + process.kill(-pid, ...)) and on VITEST_POOL_ID,
    // so this suite must run in separate processes, not worker threads.
    pool: "forks",
    maxWorkers: BIDI_MAX_WORKERS,
    isolate: false,
    globalSetup: [
      "tests/helpers/browser-process-cleanup.global-setup.ts",
      "tests/helpers/bidi.global-setup.ts"
    ],
    setupFiles: [
      "tests/helpers/bidi-process-cleanup.setup.ts",
      "tests/helpers/playwright-expect.setup.ts"
    ],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 30_000
  }
});
