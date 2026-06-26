import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createRoxyBrowserMcpInMemory } from "@roxybrowser/playwright/mcp";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * Verifies that the `outputDir` option actually routes file-producing tool
 * output to the requested directory — no real browser needed.
 *
 * Strategy:
 *   - Inject a fake `sessionFactory` that returns a stub `ConnectedBrowserSession`
 *     (only `listTabs` / `version` / `snapshot` / `close` are exercised).
 *   - Call `roxy_browser_connect` then `browser_snapshot` with a `filename`.
 *   - `browser_snapshot` with a filename writes the snapshot text to
 *     `outputDir/filename` and echoes `Saved snapshot to "<abs path>".` back.
 *   - Assert the file exists INSIDE the custom outputDir (and NOT in the cwd
 *     default `.roxybrowser-mcp/`).
 */

function makeFakeSession() {
  return {
    protocol: "cdp",
    browserName: "chromium",
    version: async () => "fake-1.0.0",
    listTabs: async () => [
      { id: "tab-1", title: "Fake", url: "https://example.test", active: true }
    ],
    snapshot: async () => ({
      text: "# Fake snapshot\n\n- hello from stub",
      refs: {},
      title: "Fake",
      url: "https://example.test"
    }),
    close: async () => {}
  };
}

async function snapshotWithFilename(client, outputDir, filename) {
  const connect = await client.callTool({
    name: "roxy_browser_connect",
    arguments: { endpoint: "ws://fake.test", browser: "chrome" }
  });
  console.log("[verify] connect ok:", textOf(connect).trim().split("\n")[0]);

  const result = await client.callTool({
    name: "browser_snapshot",
    arguments: { filename }
  });
  return textOf(result);
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

async function runOne({ label, outputDir }) {
  const filename = "snap.md";
  const bundle = await createRoxyBrowserMcpInMemory({
    sessionFactory: async () => makeFakeSession(),
    ...(outputDir !== undefined ? { outputDir } : {})
  });

  const client = new Client(
    { name: "verify-output-dir", version: "0.0.0" },
    { capabilities: {} }
  );
  await client.connect(bundle.clientTransport);

  let resolvedPath;
  try {
    const responseText = await snapshotWithFilename(client, outputDir, filename);
    const match = responseText.match(/Saved snapshot to "(.+)"\./);
    if (!match) {
      throw new Error(`server did not echo saved path. response:\n${responseText}`);
    }
    resolvedPath = match[1];
    console.log(`[${label}] server wrote to: ${resolvedPath}`);

    const body = await readFile(resolvedPath, "utf8");
    if (!body.includes("hello from stub")) {
      throw new Error(`unexpected file content:\n${body}`);
    }
    return { label, resolvedPath };
  } finally {
    await client.close();
    await bundle.close();
  }
}

async function main() {
  // Case 1: custom outputDir — file MUST land inside it.
  const customDir = await mkdtemp(join(tmpdir(), "roxy-verify-custom-"));
  console.log(`\n=== Case 1: custom outputDir = ${customDir} ===`);
  const custom = await runOne({ label: "custom", outputDir: customDir });

  if (!custom.resolvedPath.startsWith(customDir)) {
    throw new Error(
      `FAIL: expected path under ${customDir}, got ${custom.resolvedPath}`
    );
  }
  const customEntries = await readdir(customDir);
  if (!customEntries.includes("snap.md")) {
    throw new Error(`FAIL: snap.md not found in ${customDir}: ${customEntries}`);
  }
  console.log("[custom] PASS — file landed inside custom outputDir");

  // Case 2: no outputDir — file MUST default to cwd's `.roxybrowser-mcp/`.
  // Run in a throwaway cwd so we don't pollute the repo.
  console.log(`\n=== Case 2: no outputDir (default cwd basedir) ===`);
  const defaultDir = await mkdtemp(join(tmpdir(), "roxy-verify-default-"));
  await runInChild(defaultDir);

  console.log("\nAll checks passed ✓");
  await rm(customDir, { recursive: true, force: true });
  await rm(defaultDir, { recursive: true, force: true });
}

// Run case 2 in a child process so `process.cwd()` is the throwaway dir,
// matching how `configuredOutputDir` picks the default `.roxybrowser-mcp/`.
function runInChild(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("./verify-output-dir-default.mjs", import.meta.url).pathname], {
      cwd,
      stdio: "inherit"
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`child exited with ${code}`))
    );
    child.on("error", reject);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
