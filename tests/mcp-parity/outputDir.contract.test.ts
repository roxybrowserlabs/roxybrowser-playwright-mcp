import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import * as cdpModule from "chrome-remote-interface";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createRoxyBrowserMcpInMemory } from "../../src/mcp/index.js";
import { resolveRoxyBrowserEndpoint } from "../helpers/roxybrowser.js";

const VIEWPORT = { width: 1280, height: 720 };
const HAS_REAL_CDP_ENV = Boolean(process.env.ROXY_CDP_WS_ENDPOINT) || process.env.ROXY_USE_ROXYBROWSER_API === "1";
const FIXTURE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Roxy MCP Output Dir</title>
  </head>
  <body>
    <main>
      <h1>Output directory fixture</h1>
      <button type="button">Take screenshot</button>
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

describe("mcp output dir", () => {
  (HAS_REAL_CDP_ENV ? it : it.skip)("writes relative screenshot filenames under the configured output dir", async ({}, testInfo) => {
    const cdpEndpoint = await createPreparedPage(FIXTURE_URL);
    const outputDir = testInfo.outputPath("output");
    const roxy = await createRoxyMcpClient(outputDir);

    await connectRoxyToCdp(roxy.client, cdpEndpoint);

    const result = await callTool(roxy.client, "browser_take_screenshot", {
      filename: "images/page.png"
    });

    const resolved = join(outputDir, "images", "page.png");
    expect(result.isError).toBeUndefined();
    expect(textFromResult(result)).toContain(resolved);

    const buffer = await readFile(resolved);
    expect(buffer.length).toBeGreaterThan(0);
  });
});

async function createPreparedPage(url: string): Promise<string> {
  const cdpEndpoint = await resolveCdpEndpoint();
  await resetCdpPages(cdpEndpoint);
  await preparePageWithPlaywright(cdpEndpoint, url);
  return cdpEndpoint;
}

async function createRoxyMcpClient(outputDir: string): Promise<{ client: Client }> {
  const roxyBundle = await createRoxyBrowserMcpInMemory({
    snapshotMode: "none",
    outputDir
  });
  cleanupCallbacks.push(async () => roxyBundle.close());

  const roxyClient = createClient("roxy-mcp-output-dir-client");
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
    throw new Error("CDP version endpoint did not include webSocketDebuggerUrl.");
  }
  const ws = new URL(version.webSocketDebuggerUrl);
  return {
    host: ws.hostname,
    port: Number(ws.port),
    target: version.webSocketDebuggerUrl
  };
}

async function preparePageWithPlaywright(cdpEndpoint: string, url: string): Promise<void> {
  const browser = await chromium.connectOverCDP(cdpEndpoint);
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

async function connectRoxyToCdp(roxyClient: Client, cdpEndpoint: string): Promise<void> {
  const connectResult = await callTool(roxyClient, "roxy_browser_connect", {
    endpoint: cdpEndpoint,
    browser: "chrome"
  });
  if (connectResult.isError) {
    throw new Error(textFromResult(connectResult));
  }
}

async function resolveCdpEndpoint(): Promise<string> {
  const explicit = process.env.ROXY_CDP_WS_ENDPOINT;
  if (explicit) {
    return explicit;
  }

  if (process.env.ROXY_USE_ROXYBROWSER_API === "1") {
    return resolveRoxyBrowserEndpoint({
      protocol: "cdp",
      apiPort: process.env.ROXYBROWSER_API_PORT ?? "50000",
      apiToken: process.env.ROXYBROWSER_API_TOKEN ?? "",
      workspaceId: process.env.ROXYBROWSER_WORKSPACE_ID,
      projectId: process.env.ROXYBROWSER_PROJECT_ID,
      profileId: process.env.ROXYBROWSER_PROFILE_ID,
      profileName: process.env.ROXYBROWSER_PROFILE_NAME ?? "Roxy MCP Parity",
      profileMatch: process.env.ROXYBROWSER_PROFILE_MATCH ?? "playwright",
      windowRemark: "roxybrowser-playwright-mcp",
      debugScope: "mcp-output-dir"
    });
  }

  const require = createRequire(import.meta.url);
  const modulePath = require.resolve("../../tests/helpers/roxybrowser-openai.mjs");
  throw new Error(`A CDP endpoint is required for this test. Set ROXY_CDP_WS_ENDPOINT or ROXY_USE_ROXYBROWSER_API=1. Helper: ${dirname(modulePath)}`);
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

function textFromResult(result: CallToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}
