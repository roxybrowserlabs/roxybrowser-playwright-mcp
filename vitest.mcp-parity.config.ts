import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { defineConfig } from "vitest/config";

const sourceBundlePath = path.resolve(__dirname, "dist/roxybrowser.bundle.js");
const envPath = path.resolve(process.cwd(), ".env");

if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^(\.\.\/)+src\/.+\.js$/,
        replacement: sourceBundlePath
      }
    ]
  },
  test: {
    include: ["tests/mcp-parity/**/*.test.ts"],
    fileParallelism: false,
    globalSetup: ["tests/helpers/browser-process-cleanup.global-setup.ts"],
    setupFiles: [
      "tests/helpers/browser-process-cleanup.setup.ts",
      "tests/helpers/playwright-expect.setup.ts"
    ],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
