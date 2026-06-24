import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createRoxyBrowserMcpInMemory, createRoxyBrowserMcpServer } from "../../src/mcp/index.js";
import { createHistoryPageFixture } from "../helpers/server.js";
import {
  closeRoxyBrowserFirefoxBidiProfile,
  openRoxyBrowserFirefoxBidiProfile
} from "../../scripts/roxybrowser-firefox-bidi.mjs";

const ROXYBROWSER_API_PORT = process.env.ROXYBROWSER_API_PORT ?? process.env.ROXY_API_PORT ?? "50000";
const ROXYBROWSER_API_TOKEN = process.env.ROXYBROWSER_API_TOKEN ?? process.env.ROXY_API_TOKEN;
const ROXYBROWSER_WORKSPACE_ID = process.env.ROXYBROWSER_WORKSPACE_ID;
const describeWithFirefoxBidi = ROXYBROWSER_API_TOKEN ? describe : describe.skip;

describeWithFirefoxBidi("Firefox BiDi MCP snapshot contract", () => {
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

  it("keeps browser_tabs and browser_snapshot aligned for a real Firefox BiDi session", async () => {
    fixture.server.setContent(
      "/",
      `
        <html>
          <head><title>Firefox MCP Fixture</title></head>
          <body>
            <main>
              <h1>Firefox MCP Fixture</h1>
              <label for="query">Search query</label>
              <input id="query" aria-label="Search query" value="roxy" />
              <button type="button">Run search</button>
            </main>
          </body>
        </html>
      `,
      "text/html"
    );

    const roxyBundle = await createRoxyBrowserMcpInMemory({ snapshotMode: "none" });
    cleanupCallbacks.push(async () => roxyBundle.close());

    const client = createClient("firefox-bidi-mcp-contract-client");
    cleanupCallbacks.push(async () => client.close());
    await client.connect(roxyBundle.clientTransport);

    const session = await openConnectableFirefoxBidiProfile(cleanupCallbacks);
    const connectResult = await callTool(client, "roxy_browser_connect", {
      endpoint: session.endpoint,
      browser: "firefox",
      ...(session.sessionId ? { sessionId: session.sessionId } : {})
    });
    assertToolSucceeded("roxy_browser_connect", connectResult);

    const newTabResult = await callTool(client, "browser_tabs", {
      action: "new",
      url: fixture.server.PREFIX
    });
    assertToolSucceeded("browser_tabs new", newTabResult);

    const tabsResult = await callTool(client, "browser_tabs", {
      action: "list"
    });
    assertToolSucceeded("browser_tabs list", tabsResult);
    const tabsText = textFromResult(tabsResult);
    expect(tabsText).toContain("(current)");
    expect(tabsText).toContain(fixture.server.PREFIX);
    expect(tabsText).toContain("Firefox MCP Fixture");

    const snapshotResult = await callTool(client, "browser_snapshot", {});
    assertToolSucceeded("browser_snapshot", snapshotResult);
    const snapshotText = textFromResult(snapshotResult);
    if (!snapshotText.includes('heading "Firefox MCP Fixture"')) {
      throw new Error(`browser_snapshot missing fixture content:\n${snapshotText}`);
    }
    expect(snapshotText).toContain("### Open tabs");
    expect(snapshotText).toContain(fixture.server.PREFIX);
    expect(snapshotText).toContain("- Page URL: " + fixture.server.PREFIX);
    expect(snapshotText).toContain("- Page Title: Firefox MCP Fixture");
    expect(snapshotText).toContain('heading "Firefox MCP Fixture"');
    expect(snapshotText).toContain('textbox "Search query"');
    expect(snapshotText).not.toContain("- Page URL: about:blank");
    expect(snapshotText).not.toContain("- Page Title: (untitled)");
  });
});

async function openConnectableFirefoxBidiProfile(
  cleanupCallbacks: Array<() => Promise<void>>
): Promise<{ dirId: string; endpoint: string; created?: boolean; sessionId?: string }> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const profileName = attempt === 0
      ? "RoxyBrowser Firefox MCP Snapshot Contract"
      : `RoxyBrowser Firefox MCP Snapshot Contract Retry ${attempt}`;
    const windowRemark = attempt === 0
      ? "firefox mcp snapshot contract"
      : `firefox mcp snapshot contract retry-${attempt}`;

    const session = await openRoxyBrowserFirefoxBidiProfile({
      apiPort: ROXYBROWSER_API_PORT,
      apiToken: ROXYBROWSER_API_TOKEN!,
      workspaceId: ROXYBROWSER_WORKSPACE_ID,
      createNewProfile: true,
      profileName,
      windowRemark,
      coreType: "Firefox",
      coreVersion: process.env.ROXYBROWSER_CORE_VERSION ?? "146",
      debug: true
    });

    const cleanup = async () => {
      await closeRoxyBrowserFirefoxBidiProfile({
        apiPort: ROXYBROWSER_API_PORT,
        apiToken: ROXYBROWSER_API_TOKEN!,
        workspaceId: ROXYBROWSER_WORKSPACE_ID,
        dirId: session.dirId,
        deleteProfile: true
      });
    };
    cleanupCallbacks.push(cleanup);

    const probeServer = createRoxyBrowserMcpInMemory
      ? await createRoxyBrowserMcpServerForProbe()
      : undefined;
    try {
      if (probeServer) {
        const runtime = probeServer.runtimeManager.getRuntime(`probe-${attempt}`);
        await runtime.connect({
          protocol: "bidi",
          endpoint: session.endpoint,
          browser: "firefox",
          ...(session.sessionId ? { sessionId: session.sessionId } : {})
        });
        await runtime.close();
      }
      return session;
    } catch (error) {
      lastError = error;
      await cleanup().catch(() => {});
      cleanupCallbacks.pop();
    } finally {
      await probeServer?.close().catch(() => {});
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function createRoxyBrowserMcpServerForProbe() {
  const { createRoxyBrowserMcpServer } = await import("../../src/mcp/server.js");
  return createRoxyBrowserMcpServer({ snapshotMode: "none" });
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

function assertToolSucceeded(label: string, result: CallToolResult): void {
  if (result.isError) {
    throw new Error(`${label} failed:\n${textFromResult(result)}`);
  }
}
