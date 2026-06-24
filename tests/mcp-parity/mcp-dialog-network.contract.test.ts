import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as cdpModule from "chrome-remote-interface";
import { chromium } from "playwright";
import { createRoxyBrowserMcpInMemory } from "../../src/mcp/index.js";
import { createHistoryPageFixture } from "../helpers/server.js";
import { resolveRoxyBrowserEndpoint } from "../helpers/roxybrowser.js";

const ROXYBROWSER_API_PORT = process.env.ROXYBROWSER_API_PORT ?? "50000";
const ROXYBROWSER_API_TOKEN = process.env.ROXYBROWSER_API_TOKEN;
const VIEWPORT = { width: 1280, height: 720 };
const describeWithCdp = ROXYBROWSER_API_TOKEN ? describe : describe.skip;
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describeWithCdp("MCP dialog and network contracts", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;
  const cleanupCallbacks: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  beforeEach(() => {
    fixture.server.reset();
  });

  afterAll(async () => {
    while (cleanupCallbacks.length > 0) {
      await cleanupCallbacks.pop()?.();
    }
    await fixture.close();
  });

  it("handles an alert dialog after click", async () => {
    fixture.server.setContent(
      "/",
      `<title>Dialog test</title><button onclick="alert('Alert')">Button</button>`,
      "text/html"
    );

    const cdpEndpoint = await createPreparedPage(fixture.server.PREFIX);
    const roxy = await createRoxyMcpClient(cleanupCallbacks);
    await connectRoxyToCdp(roxy.client, cdpEndpoint);

    const snapshot = await callTool(roxy.client, "browser_snapshot", {});
    const snapshotText = textFromResult(snapshot);
    expect(snapshotText).toContain(`- button "Button"`);
    const buttonRef = refForButton(snapshotText, "Button");

    const click = await callTool(roxy.client, "browser_click", { target: buttonRef, element: "Button" });
    expect(click.isError).toBeUndefined();

    const handle = await callTool(roxy.client, "browser_handle_dialog", { accept: true });
    expect(handle.isError).toBeUndefined();
    expect(textFromResult(handle)).toContain("### Snapshot");

    const handleAgain = await callTool(roxy.client, "browser_handle_dialog", { accept: true });
    expect(handleAgain.isError).toBe(true);
    expect(textFromResult(handleAgain)).toContain("[no_dialog]");
  });

  it("lists and expands network requests like the upstream MCP contract", async () => {
    fixture.server.setContent(
      "/",
      `
        <button onclick="fetch('/api', {
          method: 'POST',
          headers: { 'X-Custom-Header': 'test-value' },
          body: JSON.stringify({ key: 'value' })
        })">Click me</button>
        <img src="/image.png" />
      `,
      "text/html"
    );
    fixture.server.setRoute("/api", async (request, response) => {
      const body = await request.postBody;
      response.setHeader("X-Custom-Response", "response-value");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ echoed: body.toString("utf8") }));
    });

    const cdpEndpoint = await createPreparedPage(fixture.server.PREFIX);
    const roxy = await createRoxyMcpClient(cleanupCallbacks);
    await connectRoxyToCdp(roxy.client, cdpEndpoint);

    const snapshot = await callTool(roxy.client, "browser_snapshot", {});
    const snapshotText = textFromResult(snapshot);
    expect(snapshotText).toContain(`- button "Click me"`);
    const buttonRef = refForButton(snapshotText, "Click me");

    const click = await callTool(roxy.client, "browser_click", {
      target: buttonRef,
      element: "Click me button"
    });
    expect(click.isError).toBeUndefined();

    const list = await callTool(roxy.client, "browser_network_requests", {});
    const listText = textFromResult(list);
    expect(listText).not.toContain(`[GET] ${fixture.server.PREFIX}/ => [200] OK`);
    expect(listText).toMatch(new RegExp(String.raw`^\d+\. \[POST\] ${escapeRegExp(`${fixture.server.PREFIX}/api`)} => \[200\] OK$`, "m"));
    expect(listText).toMatch(new RegExp(String.raw`^\d+\. \[GET\] ${escapeRegExp(`${fixture.server.PREFIX}/image.png`)} => \[404\]`, "m"));
    expect(listText).toContain("Note: 1 static request not shown");

    const listWithStatic = await callTool(roxy.client, "browser_network_requests", { static: true });
    const listWithStaticText = textFromResult(listWithStatic);
    expect(listWithStaticText).toMatch(new RegExp(String.raw`^\d+\. \[GET\] ${escapeRegExp(`${fixture.server.PREFIX}/`)} => \[200\] OK$`, "m"));

    const match = listText.match(/^(\d+)\. \[POST\] [^ ]+\/api =>/m);
    expect(match).not.toBeNull();
    const index = Number(match![1]);

    const detail = await callTool(roxy.client, "browser_network_request", { index });
    const detailText = textFromResult(detail);
    expect(detailText).toContain(`#${index} [POST] ${fixture.server.PREFIX}/api`);
    expect(detailText).toContain("Request headers");
    expect(detailText).toContain("x-custom-header: test-value");
    expect(detailText).toContain("Response headers");
    expect(detailText).toContain("x-custom-response: response-value");
    expect(detailText).toContain(`Call browser_network_request with part="request-body"`);
    expect(detailText).toContain(`Call browser_network_request with part="response-body"`);

    const requestBody = await callTool(roxy.client, "browser_network_request", {
      index,
      part: "request-body"
    });
    expect(textFromResult(requestBody)).toBe(`{"key":"value"}`);

    const responseBody = await callTool(roxy.client, "browser_network_request", {
      index,
      part: "response-body"
    });
    expect(textFromResult(responseBody)).toContain(`{"echoed":"{\\"key\\":\\"value\\"}"}`);

    const invalidRegex = await callTool(roxy.client, "browser_network_requests", {
      filter: "[invalid("
    });
    expect(invalidRegex.isError).toBe(true);
  });
});

async function createPreparedPage(url: string): Promise<string> {
  const cdpEndpoint = await resolveCdpEndpoint();
  await resetCdpPages(cdpEndpoint);
  await preparePageWithPlaywright(cdpEndpoint, url);
  return cdpEndpoint;
}

async function createRoxyMcpClient(cleanupCallbacks: Array<() => Promise<void>>): Promise<{ client: Client }> {
  const roxyBundle = await createRoxyBrowserMcpInMemory({ snapshotMode: "full" });
  cleanupCallbacks.push(async () => roxyBundle.close());

  const roxyClient = createClient("roxy-mcp-contract-client");
  cleanupCallbacks.push(async () => roxyClient.close());
  await roxyClient.connect(roxyBundle.clientTransport);

  return { client: roxyClient };
}

async function connectRoxyToCdp(roxyClient: Client, cdpEndpoint: string): Promise<void> {
  const connectResult = await callTool(roxyClient, "roxy_browser_connect", {
    endpoint: cdpEndpoint,
    browser: "chrome"
  });
  assertToolSucceeded("Roxy MCP roxy_browser_connect", connectResult);
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

async function resolveCdpEndpoint(): Promise<string> {
  return resolveRoxyBrowserEndpoint({
    protocol: "cdp",
    apiPort: ROXYBROWSER_API_PORT,
    apiToken: ROXYBROWSER_API_TOKEN!,
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
    .map((item) => item.text ?? "")
    .join("\n");
}

function assertToolSucceeded(label: string, result: CallToolResult): void {
  if (result.isError) {
    throw new Error(`${label} failed:\n${textFromResult(result)}`);
  }
}

function refForButton(snapshotText: string, name: string): string {
  const line = snapshotText
    .split("\n")
    .find((candidate) => candidate.includes(`button "${name}"`) && candidate.includes("[ref="));
  const ref = line?.match(/\[ref=((?:f\d+)?e\d+)\]/)?.[1];
  if (!ref) {
    throw new Error(`Unable to find ref for button "${name}" in snapshot:\n${snapshotText}`);
  }
  return ref;
}
