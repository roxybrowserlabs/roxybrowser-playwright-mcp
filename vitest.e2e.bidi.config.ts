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
    // A single externally provided Firefox BiDi endpoint can only service one
    // active client session at a time, so run the suite in a single worker.
    fileParallelism: false,
    // Keep a single module graph across files so the shared RoxyBrowser BiDi
    // connection cache in tests/helpers/bidi.ts is actually reused.
    isolate: false,
    globalSetup: [
      "tests/helpers/browser-process-cleanup.global-setup.ts",
      "tests/helpers/bidi.global-setup.ts"
    ],
    setupFiles: ["tests/helpers/browser-process-cleanup.setup.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 30_000
  }
});
