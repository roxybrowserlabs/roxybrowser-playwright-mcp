import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import * as cdpModule from "chrome-remote-interface";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright";
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
const LOCAL_CONSOLE_FIXTURE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MCP Console Parity</title>
    <script>
      window.__emitMcpParityConsole = () => {
        console.warn("mcp parity warning");
        console.error("mcp parity error");
        setTimeout(() => {
          throw new Error("mcp parity page error");
        }, 0);
      };
    </script>
  </head>
  <body>
    <main>
      <h1>Console parity fixture</h1>
      <button type="button">Stable button</button>
    </main>
  </body>
</html>`)}`;

const cleanupCallbacks: Array<() => Promise<void>> = [];
const chromeRemoteInterface = ("default" in cdpModule
  ? cdpModule.default
  : cdpModule) as unknown as {
  (options: {
    host?: string;
    port?: number;
    target?: string;
  }): Promise<CdpBrowserClient>;
};

type CdpBrowserClient = {
  close(): Promise<void>;
  Target: {
    getTargets(): Promise<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>;
    createTarget(options: { url: string }): Promise<{ targetId: string }>;
    activateTarget(options: { targetId: string }): Promise<void>;
    closeTarget(options: { targetId: string }): Promise<void>;
  };
};

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
      const snapshotArgs = await supportedSnapshotArgs(scenario.name);
      for (const args of snapshotArgs) {
        const cdpEndpoint = await createPreparedPage(scenario.url());
        const playwright = await createPlaywrightMcpClient(cdpEndpoint);
        cleanupCallbacks.push(playwright.close);
        const playwrightResult = await callTool(playwright.client, "browser_snapshot", args);
        const roxy = await createRoxyMcpClient();
        const roxyResult = await snapshotWithRoxy({ roxyClient: roxy.client, cdpEndpoint }, args);

        expect(
          comparableSnapshotResult(roxyResult, scenario.compareConsoleEvents),
          `browser_snapshot args ${JSON.stringify(args)}`
        ).toEqual(comparableSnapshotResult(playwrightResult, scenario.compareConsoleEvents));
      }
    });
  }

  it("matches Playwright MCP console summary and log entries for deterministic fixture", async () => {
    const cdpEndpoint = await createPreparedPage(LOCAL_CONSOLE_FIXTURE_URL);
    const playwright = await createPlaywrightMcpClient(cdpEndpoint);
    cleanupCallbacks.push(playwright.close);

    const roxy = await createRoxyMcpClient();
    await connectRoxyToCdp(roxy.client, cdpEndpoint);

    await emitDeterministicConsole(cdpEndpoint);

    const playwrightResult = await callTool(playwright.client, "browser_snapshot", {});
    const roxyResult = await callTool(roxy.client, "browser_snapshot", {});

    expect(consoleSummaryLine(roxyResult)).toEqual(consoleSummaryLine(playwrightResult));
    expect(await consoleLogEntries(roxyResult)).toEqual(await consoleLogEntries(playwrightResult));
  });
});

function parityScenarios(): Array<{ name: string; url(): string; compareConsoleEvents: boolean }> {
  return [
    {
      name: "local accessibility fixture",
      url: () => LOCAL_FIXTURE_URL,
      compareConsoleEvents: true
    },
    ...ONLINE_URLS.map((url) => ({
      name: url,
      url: () => url,
      compareConsoleEvents: false
    }))
  ];
}

async function createPreparedPage(url: string): Promise<string> {
  const cdpEndpoint = await resolveCdpEndpoint();
  await resetCdpPages(cdpEndpoint);
  await preparePageWithPlaywright(cdpEndpoint, url);
  return cdpEndpoint;
}

async function createParityRun(): Promise<{
  playwrightClient: Client;
  roxyClient: Client;
  cdpEndpoint: string;
}> {
  const cdpEndpoint = await resolveCdpEndpoint();
  await resetCdpPages(cdpEndpoint);

  const playwright = await createPlaywrightMcpClient(cdpEndpoint);
  cleanupCallbacks.push(playwright.close);

  const roxy = await createRoxyMcpClient();

  return {
    playwrightClient: playwright.client,
    roxyClient: roxy.client,
    cdpEndpoint
  };
}

async function createRoxyMcpClient(): Promise<{ client: Client }> {
  const roxyBundle = await createRoxyBrowserMcpInMemory({ snapshotMode: "none" });
  cleanupCallbacks.push(async () => roxyBundle.close());

  const roxyClient = createClient("roxy-mcp-parity-client");
  cleanupCallbacks.push(async () => roxyClient.close());
  await roxyClient.connect(roxyBundle.clientTransport);

  return {
    client: roxyClient
  };
}

async function resetCdpPages(cdpEndpoint: string): Promise<void> {
  const connection = await cdpBrowserConnection(cdpEndpoint);
  const client = await chromeRemoteInterface(connection);
  try {
    const before = await client.Target.getTargets();
    const fresh = await client.Target.createTarget({ url: "about:blank" });
    await client.Target.activateTarget({ targetId: fresh.targetId });

    await Promise.all(
      before.targetInfos
        .filter((target) => target.type === "page" && target.targetId !== fresh.targetId)
        .map((target) => client.Target.closeTarget({ targetId: target.targetId }).catch(() => undefined))
    );
  } finally {
    await client.close();
  }
}

async function cdpBrowserConnection(endpoint: string): Promise<{
  host: string;
  port: number;
  target?: string;
}> {
  const url = new URL(endpoint);
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    return {
      host: url.hostname,
      port: Number(url.port),
      target: endpoint
    };
  }

  const versionUrl = new URL("/json/version", url);
  const response = await fetch(versionUrl);
  if (!response.ok) {
    throw new Error(`Unable to read CDP version endpoint at ${versionUrl.toString()}.`);
  }
  const version = await response.json() as { webSocketDebuggerUrl?: unknown };
  if (typeof version.webSocketDebuggerUrl !== "string") {
    throw new Error(`CDP version endpoint did not include webSocketDebuggerUrl.`);
  }
  const ws = new URL(version.webSocketDebuggerUrl);
  return {
    host: ws.hostname,
    port: Number(ws.port),
    target: version.webSocketDebuggerUrl
  };
}

async function preparePageWithPlaywright(cdpEndpoint: string, url: string): Promise<void> {
  const browser = await chromium.connect(cdpEndpoint);
  try {
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();
    await page.setViewportSize(VIEWPORT);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => undefined);
  } finally {
    await browser.close();
  }
}

async function emitDeterministicConsole(cdpEndpoint: string): Promise<void> {
  const browser = await chromium.connect(cdpEndpoint);
  try {
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) {
      throw new Error("No page is available for deterministic console fixture.");
    }
    await page.evaluate(() => {
      (globalThis as typeof globalThis & { __emitMcpParityConsole(): void }).__emitMcpParityConsole();
    });
    await page.waitForTimeout(250);
  } finally {
    await browser.close();
  }
}

async function snapshotWithRoxy(run: {
  roxyClient: Client;
  cdpEndpoint: string;
}, args: Record<string, unknown>): Promise<CallToolResult> {
  await connectRoxyToCdp(run.roxyClient, run.cdpEndpoint);
  return callTool(run.roxyClient, "browser_snapshot", args);
}

async function connectRoxyToCdp(roxyClient: Client, cdpEndpoint: string): Promise<void> {
  const connectResult = await callTool(roxyClient, "roxy_browser_connect", {
    endpoint: cdpEndpoint,
    browser: "chrome"
  });
  assertToolSucceeded("Roxy MCP roxy_browser_connect", connectResult);
}

async function supportedSnapshotArgs(scenarioName: string): Promise<Array<Record<string, unknown>>> {
  const properties = await browserSnapshotInputSchemaProperties();
  const args: Array<Record<string, unknown>> = [{}];
  if (scenarioName !== "local accessibility fixture") {
    return args;
  }
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

let browserSnapshotPropertiesPromise: Promise<Record<string, unknown>> | undefined;

async function browserSnapshotInputSchemaProperties(): Promise<Record<string, unknown>> {
  browserSnapshotPropertiesPromise ??= (async () => {
    const run = await createParityRun();
    const [playwrightTool, roxyTool] = await Promise.all([
      browserSnapshotTool(run.playwrightClient),
      browserSnapshotTool(run.roxyClient)
    ]);

    expect(roxyTool.inputSchema).toEqual(playwrightTool.inputSchema);
    return (playwrightTool.inputSchema.properties ?? {}) as Record<string, unknown>;
  })();
  return browserSnapshotPropertiesPromise;
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
      "--snapshot-mode",
      "none",
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

function comparableSnapshotResult(result: CallToolResult, compareConsoleEvents: boolean): CallToolResult {
  if (compareConsoleEvents) {
    return result;
  }

  return {
    ...result,
    content: result.content.map((item) => {
      if (item.type !== "text") {
        return item;
      }
      return {
        ...item,
        text: stripConsoleEvents(item.text)
      };
    })
  };
}

function stripConsoleEvents(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("- Console: ")) {
      continue;
    }
    if (line === "### Events") {
      while (index + 1 < lines.length && !lines[index + 1].startsWith("### ")) {
        index++;
      }
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function consoleSummaryLine(result: CallToolResult): string | undefined {
  return textFromResult(result).split("\n").find((line) => line.startsWith("- Console: "));
}

async function consoleLogEntries(result: CallToolResult): Promise<string[]> {
  const link = textFromResult(result)
    .split("\n")
    .find((line) => line.startsWith("- New console entries: "))
    ?.slice("- New console entries: ".length);
  if (!link) {
    return [];
  }

  const match = /^(.*)#L(\d+)(?:-L(\d+))?$/.exec(link);
  if (!match) {
    throw new Error(`Unexpected console log link: ${link}`);
  }
  const [, filePath, fromLineText, toLineText] = match;
  const fromLine = Number(fromLineText);
  const toLine = Number(toLineText ?? fromLineText);
  const text = await readFile(filePath, "utf8");
  return text
    .split("\n")
    .slice(fromLine - 1, toLine)
    .filter(Boolean)
    .map((line) => line.replace(/^\[\s*-?\d+ms\] /, ""));
}
