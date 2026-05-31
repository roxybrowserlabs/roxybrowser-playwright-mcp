import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/bidi/**/*.test.ts"],
    // A single externally provided Firefox BiDi endpoint can only service one
    // active client session at a time, so run the suite in a single worker.
    fileParallelism: false,
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 30_000
  }
});
