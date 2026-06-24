import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configuredOutputDir, resolveOutputFilePath } from "../../src/mcp/output.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  delete process.env.ROXY_MCP_OUTPUT_DIR;
  delete process.env.PLAYWRIGHT_MCP_OUTPUT_DIR;

  while (cleanupPaths.length) {
    const target = cleanupPaths.pop();
    if (target) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

describe("mcp output dir", () => {
  it("prefers ROXY_MCP_OUTPUT_DIR", async () => {
    const explicit = await mkdtemp(path.join(tmpdir(), "roxy-output-explicit-"));
    cleanupPaths.push(explicit);
    process.env.ROXY_MCP_OUTPUT_DIR = explicit;
    process.env.PLAYWRIGHT_MCP_OUTPUT_DIR = "/tmp/ignored-playwright-output";

    expect(configuredOutputDir()).toBe(explicit);
  });

  it("falls back to PLAYWRIGHT_MCP_OUTPUT_DIR for compatibility", async () => {
    const explicit = await mkdtemp(path.join(tmpdir(), "roxy-output-playwright-"));
    cleanupPaths.push(explicit);
    process.env.PLAYWRIGHT_MCP_OUTPUT_DIR = explicit;

    expect(configuredOutputDir()).toBe(explicit);
  });

  it("uses cwd-relative .roxybrowser-mcp by default", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roxy-output-cwd-"));
    cleanupPaths.push(cwd);

    expect(configuredOutputDir({ cwd })).toBe(path.join(cwd, ".roxybrowser-mcp"));
  });

  it("falls back to tmpdir when cwd is not writable", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roxy-output-readonly-"));
    cleanupPaths.push(cwd);
    await chmod(cwd, 0o500);

    try {
      expect(configuredOutputDir({ cwd })).toBe(path.join(tmpdir(), ".roxybrowser-mcp"));
    } finally {
      await chmod(cwd, 0o700);
    }
  });

  it("resolves relative output files under the configured output dir", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "roxy-output-relative-"));
    cleanupPaths.push(outputDir);

    const resolved = await resolveOutputFilePath("nested/result.txt", { outputDir });

    expect(resolved).toBe(path.join(outputDir, "nested", "result.txt"));
  });

  it("keeps absolute output file paths unchanged", async () => {
    const absolute = path.join(tmpdir(), "roxy-absolute-output.txt");

    const resolved = await resolveOutputFilePath(absolute, {
      outputDir: "/tmp/ignored-output-dir"
    });

    expect(resolved).toBe(absolute);
  });
});
