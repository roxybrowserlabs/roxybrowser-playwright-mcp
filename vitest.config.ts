import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90
      },
      include: [
        "src/**/*.ts"
      ],
      exclude: [
        "dist/**",
        "src/types/**",
        "src/protocol/adapter.ts",
        "src/protocol/capabilities.ts",
        "src/protocol/bidi/**",
        "src/protocol/cdp/backend.ts"
      ]
    }
  }
});
