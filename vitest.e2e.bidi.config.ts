import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

const envPath = resolve(process.cwd(), ".env");

if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

export default defineConfig({
  test: {
    include: ["tests/e2e/bidi/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
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
