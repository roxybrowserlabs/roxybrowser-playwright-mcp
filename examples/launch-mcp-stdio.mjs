import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Starts the RoxyBrowser MCP server over stdio with a custom `outputDir`,
 * then drives it from an in-process MCP client.
 *
 * `outputDir` is where the server writes snapshot/console artifacts for the
 * session, so we point it at a fresh temp directory for this run.
 */
async function run() {
  const outputDir = await mkdtemp(join(tmpdir(), "roxybrowser-mcp-stdio-"));
  console.error(`[example] outputDir = ${outputDir}`);

  // Spawn the built CLI as the server process, forwarding --output-dir.
  // (You could also call `startRoxyBrowserMcpStdio({ outputDir })` in-process;
  // spawning the bin keeps the example close to how a host would launch it.)
  const transport = new StdioClientTransport({
    command: "node",
    args: [
      join(repoRoot, "dist/bin/roxybrowser-mcp.js"),
      "--output-dir",
      outputDir
    ],
    cwd: repoRoot
  });

  const client = new Client(
    { name: "roxybrowser-stdio-example", version: "0.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);

    const serverInfo = client.getServerVersion();
    const capabilities = client.getServerCapabilities() ?? {};
    console.log("[example] connected to", serverInfo?.name, serverInfo?.version);
    console.log(
      "[example] server capabilities:",
      Object.keys(capabilities).join(", ")
    );

    const { tools } = await client.listTools();
    console.log(`[example] ${tools.length} tools available, e.g.`);
    for (const tool of tools.slice(0, 5)) {
      console.log(`  - ${tool.name}`);
    }
  } finally {
    await client.close();
    console.error("[example] cleaning up outputDir");
    await rm(outputDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error("Example failed.");
  console.error(error);
  process.exitCode = 1;
});
