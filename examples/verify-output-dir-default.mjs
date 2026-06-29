// Child helper for verify-output-dir.mjs — runs with NO outputDir so the
// server falls back to `<cwd>/.roxybrowser-playwright-mcp/`. Asserts the file lands there.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createRoxyBrowserMcpInMemory } from "@roxybrowser/playwright/mcp";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function textOf(result) {
  return (result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

async function main() {
  const expectedDir = join(process.cwd(), ".roxybrowser-playwright-mcp");
  console.log(`[default] expecting default dir = ${expectedDir}`);

  const bundle = await createRoxyBrowserMcpInMemory({
    sessionFactory: async () => makeFakeSession()
  });
  const client = new Client(
    { name: "verify-output-dir-default", version: "0.0.0" },
    { capabilities: {} }
  );
  await client.connect(bundle.clientTransport);

  try {
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: { endpoint: "ws://fake.test", browser: "chrome" }
    });
    const result = await client.callTool({
      name: "browser_snapshot",
      arguments: { filename: "snap.md" }
    });
    const match = textOf(result).match(/Saved snapshot to "(.+)"\./);
    if (!match) throw new Error("no saved-path echo in response");
    const resolvedPath = resolve(match[1]);
    console.log(`[default] server wrote to: ${resolvedPath}`);

    if (!resolvedPath.startsWith(expectedDir)) {
      throw new Error(`FAIL: expected under ${expectedDir}, got ${resolvedPath}`);
    }
    const entries = await readdir(expectedDir);
    if (!entries.includes("snap.md")) {
      throw new Error(`FAIL: snap.md missing in default dir: ${entries}`);
    }
    console.log("[default] PASS — file landed in default .roxybrowser-playwright-mcp/");
  } finally {
    await client.close();
    await bundle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
