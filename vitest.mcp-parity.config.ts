import path from "node:path";
import { defineConfig } from "vitest/config";

const sourceBundlePath = path.resolve(__dirname, "dist/roxybrowser.bundle.js");

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
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
