import path from "node:path";
import { defineConfig } from "vitest/config";

const sourceBundlePath = path.resolve(__dirname, "dist/roxybrowser.bundle.js");

export default defineConfig({
  resolve: {
    alias: [
      {
        // Redirect unit tests that import source files to the built source bundle instead.
        find: /^(\.\.\/)+src\/.+\.js$/,
        replacement: sourceBundlePath
      }
    ]
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node"
  }
});
