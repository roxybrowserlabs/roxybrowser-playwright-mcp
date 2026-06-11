import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createRoxyBrowserMcpInMemory } from "../../src/mcp/index.js";
import { resolveRoxyBrowserEndpoint } from "../helpers/roxybrowser.js";

const VIEWPORT = { width: 1280, height: 720 };
const ONLINE_URLS = [
  "https://www.baidu.com",
  "https://www.bing.com",
  "https://www.google.com"
];
const ROXYBROWSER_API_PORT = process.env.ROXYBROWSER_API_PORT ?? "50000";
const ROXYBROWSER_API_TOKEN = process.env.ROXYBROWSER_API_TOKEN;
const LOCAL_FIXTURE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MCP Snapshot Parity</title>
  </head>
  <body>
    <main>
      <h1>Snapshot parity fixture</h1>
      <section aria-label="Controls">
        <label for="query">Search query</label>
        <input id="query" aria-label="Search query" value="roxy" />
        <label><input type="checkbox" checked /> Include archived</label>
        <button type="button">Run search</button>
        <a href="#details">Details</a>
      </section>
      <section id="details" aria-label="Nested content">
        <article>
          <h2>Results</h2>
          <ul>
            <li>First result</li>
            <li>Second result</li>
          </ul>
        </article>
      </section>
    </main>
  </body>
</html>`)}`;

const cleanupCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupCallbacks.length > 0) {
    const callback = cleanupCallbacks.pop();
    if (callback) {
      await callback();
    }
  }
});

describe("browser_snapshot MCP parity", () => {
  it("exposes the same browser_snapshot input schema as Playwright MCP", async () => {
    const run = await createParityRun();

    const [playwrightTool, roxyTool] = await Promise.all([
      browserSnapshotTool(run.playwrightClient),
      browserSnapshotTool(run.roxyClient)
    ]);

    expect(roxyTool.inputSchema).toEqual(playwrightTool.inputSchema);
  });

  for (const scenario of parityScenarios()) {
    it(`matches Playwright MCP for ${scenario.name}`, async () => {
      const run = await createParityRun();
      await navigateBoth(run, scenario.url());

      const snapshotArgs = await supportedSnapshotArgs(run);
      for (const args of snapshotArgs) {
        const [playwrightResult, roxyResult] = await Promise.all([
          callTool(run.playwrightClient, "browser_snapshot", args),
          callTool(run.roxyClient, "browser_snapshot", args)
        ]);

        expect(roxyResult).toEqual(playwrightResult);
      }
    });
  }
});

function parityScenarios(): Array<{ name: string; url(): string }> {
  return [
    {
      name: "local accessibility fixture",
      url: () => LOCAL_FIXTURE_URL
    },
    ...ONLINE_URLS.map((url) => ({
      name: url,
      url: () => url
    }))
  ];
}

async function createParityRun(): Promise<{
  playwrightClient: Client;
  roxyClient: Client;
  cdpEndpoint: string;
}> {
  const cdpEndpoint = await resolveCdpEndpoint();

  const playwright = await createPlaywrightMcpClient(cdpEndpoint);
  cleanupCallbacks.push(playwright.close);

  const roxyBundle = await createRoxyBrowserMcpInMemory();
  cleanupCallbacks.push(async () => roxyBundle.close());

  const roxyClient = createClient("roxy-mcp-parity-client");
  cleanupCallbacks.push(async () => roxyClient.close());
  await roxyClient.connect(roxyBundle.clientTransport);

  return {
    playwrightClient: playwright.client,
    roxyClient,
    cdpEndpoint
  };
}

async function navigateBoth(
  run: { playwrightClient: Client; roxyClient: Client; cdpEndpoint: string },
  url: string
): Promise<void> {
  const connectResult = await callTool(run.roxyClient, "roxy_browser_connect", {
    protocol: "cdp",
    endpoint: run.cdpEndpoint,
    browser: "chromium"
  });
  assertToolSucceeded("Roxy MCP roxy_browser_connect", connectResult);

  assertToolSucceeded(
    "Playwright MCP browser_navigate",
    await callTool(run.playwrightClient, "browser_navigate", { url })
  );
  assertToolSucceeded(
    "Playwright MCP browser_resize",
    await callTool(run.playwrightClient, "browser_resize", VIEWPORT)
  );

  assertToolSucceeded(
    "Roxy MCP browser_navigate",
    await callTool(run.roxyClient, "browser_navigate", { url })
  );
}

async function supportedSnapshotArgs(run: {
  playwrightClient: Client;
  roxyClient: Client;
}): Promise<Array<Record<string, unknown>>> {
  const [playwrightTool, roxyTool] = await Promise.all([
    browserSnapshotTool(run.playwrightClient),
    browserSnapshotTool(run.roxyClient)
  ]);

  expect(roxyTool.inputSchema).toEqual(playwrightTool.inputSchema);

  const properties = (playwrightTool.inputSchema.properties ?? {}) as Record<string, unknown>;
  const args: Array<Record<string, unknown>> = [{}];
  if ("depth" in properties) {
    args.push({ depth: 2 });
  }
  if ("boxes" in properties) {
    args.push({ boxes: true });
  }
  if ("depth" in properties && "boxes" in properties) {
    args.push({ depth: 2, boxes: true });
  }
  return args;
}

async function browserSnapshotTool(client: Client): Promise<Tool> {
  const tools = await client.listTools();
  const tool = tools.tools.find((candidate) => candidate.name === "browser_snapshot");
  if (!tool) {
    throw new Error(`browser_snapshot tool was not registered. Tools: ${tools.tools.map((item) => item.name).join(", ")}`);
  }
  return tool;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  return client.callTool({
    name,
    arguments: args
  }) as Promise<CallToolResult>;
}

function createClient(name: string): Client {
  return new Client({
    name,
    version: "1.0.0"
  });
}

async function createPlaywrightMcpClient(cdpEndpoint: string): Promise<{
  client: Client;
  close(): Promise<void>;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      playwrightMcpCliPath(),
      "--cdp-endpoint",
      cdpEndpoint,
      "--browser",
      "chromium",
      "--viewport-size",
      `${VIEWPORT.width}x${VIEWPORT.height}`
    ],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const stderrChunks: string[] = [];
  transport.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));

  const client = createClient("playwright-mcp-parity-client");
  try {
    await client.connect(transport);
  } catch (error) {
    const stderr = stderrChunks.join("").trim();
    throw new Error(
      `Unable to start Playwright MCP.${stderr ? `\n\nstderr:\n${stderr}` : ""}\n\n${String(error)}`
    );
  }

  return {
    client,
    close: async () => {
      await client.close();
      await transport.close();
    }
  };
}

function playwrightMcpCliPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
}

async function resolveCdpEndpoint(): Promise<string> {
  if (!ROXYBROWSER_API_TOKEN) {
    throw new Error(
      "Set ROXYBROWSER_API_TOKEN in .env so the test can open a Chrome profile through RoxyBrowser."
    );
  }

  return resolveRoxyBrowserEndpoint({
    protocol: "cdp",
    apiPort: ROXYBROWSER_API_PORT,
    apiToken: ROXYBROWSER_API_TOKEN,
    profileName: "RoxyBrowser Chrome MCP Parity",
    profileMatch: "chrome",
    windowRemark: "chrome mcp parity",
    debugScope: "roxybrowser:mcp-parity",
    useSingleProfileFallback: false,
    createMissingProfile: true
  });
}

function textFromResult(result: CallToolResult): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function assertToolSucceeded(label: string, result: CallToolResult): void {
  if (result.isError) {
    throw new Error(`${label} failed:\n${textFromResult(result)}`);
  }
}
