import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRoxyBrowserMcpInMemory, createRoxyBrowserMcpServer, startRoxyBrowserMcpHttp, startRoxyBrowserMcpStdio } from "../../src/mcp/index.js";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserSessionFactory, BrowserSnapshot, BrowserTab, ConnectedBrowserSession, RoxyBrowserConnectArgs } from "../../src/mcp/index.js";

class FakeConnectedBrowserSession implements ConnectedBrowserSession {
  readonly browserName: "chromium" | "firefox";
  readonly protocol: "cdp" | "bidi";
  private tabs: BrowserTab[];
  private nextTabId = 2;

  constructor(private readonly args: RoxyBrowserConnectArgs) {
    this.protocol = args.protocol;
    this.browserName = args.browser ?? (args.protocol === "cdp" ? "chromium" : "firefox");
    this.tabs = [
      {
        id: "tab-1",
        title: `${args.endpoint} home`,
        url: `${args.endpoint}/home`,
        active: true
      }
    ];
  }

  async version(): Promise<string> {
    return `${this.browserName}/1.0`;
  }

  async listTabs(): Promise<BrowserTab[]> {
    return this.tabs.map((tab) => ({ ...tab }));
  }

  async newTab(url = "about:blank"): Promise<BrowserTab[]> {
    const id = `tab-${this.nextTabId++}`;
    this.tabs = this.tabs.map((tab) => ({ ...tab, active: false }));
    this.tabs.push({
      id,
      title: `${this.args.endpoint} ${id}`,
      url,
      active: true
    });
    return this.listTabs();
  }

  async selectTab(tabId: string): Promise<BrowserTab[]> {
    this.tabs = this.tabs.map((tab) => ({
      ...tab,
      active: tab.id === tabId
    }));
    return this.listTabs();
  }

  async closeTab(tabId: string): Promise<BrowserTab[]> {
    const index = this.tabs.findIndex((tab) => tab.id === tabId);
    this.tabs = this.tabs.filter((tab) => tab.id !== tabId);
    if (this.tabs.length > 0) {
      const nextIndex = Math.min(Math.max(index, 0), this.tabs.length - 1);
      this.tabs = this.tabs.map((tab, tabIndex) => ({
        ...tab,
        active: tabIndex === nextIndex
      }));
    }
    return this.listTabs();
  }

  async snapshot(): Promise<BrowserSnapshot> {
    const activeTab = this.tabs.find((tab) => tab.active) ?? this.tabs[0];
    return {
      title: activeTab?.title ?? "",
      url: activeTab?.url ?? "",
      text: `- document\n  - button "${activeTab?.title ?? "Action"}" [ref=r1]`,
      refs: {
        r1: `${activeTab?.id ?? "tab"}:node-1`
      }
    };
  }

  async click(_refToken: string): Promise<void> {}

  async hover(_refToken: string): Promise<void> {}

  async close(): Promise<void> {}
}

const fakeSessionFactory: BrowserSessionFactory = async (
  args: RoxyBrowserConnectArgs
) => new FakeConnectedBrowserSession(args);

function createClient() {
  return new Client({
    name: "mcp-test-client",
    version: "1.0.0"
  });
}

function textFromResult(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

const cleanupCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupCallbacks.length > 0) {
    const callback = cleanupCallbacks.pop();
    if (callback) {
      await callback();
    }
  }
});

describe("MCP server", () => {
  it("registers all MCP tools over in-memory transport", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "browser_click",
      "browser_hover",
      "browser_snapshot",
      "browser_tabs",
      "roxy_browser_connect"
    ]);
  });

  it("returns structured errors before connect and invalidates refs after actions", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const beforeConnect = await client.callTool({
      name: "browser_snapshot",
      arguments: {}
    });
    expect(beforeConnect.isError).toBe(true);
    expect(textFromResult(beforeConnect)).toContain("[not_connected]");

    const connected = await client.callTool({
      name: "roxy_browser_connect",
      arguments: {
        protocol: "cdp",
        endpoint: "ws://session-one.invalid/devtools/browser/1"
      }
    });
    expect(connected.isError).toBeUndefined();
    expect(textFromResult(connected)).toContain("Connected to chromium via cdp.");

    const clicked = await client.callTool({
      name: "browser_click",
      arguments: {
        ref: "r1"
      }
    });
    expect(clicked.isError).toBeUndefined();

    const stale = await client.callTool({
      name: "browser_click",
      arguments: {
        ref: "r1"
      }
    });
    expect(stale.isError).toBe(true);
    expect(textFromResult(stale)).toContain("[stale_ref]");
  });

  it("validates tab index operations through the tool layer", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: {
        protocol: "bidi",
        endpoint: "ws://session-two.invalid"
      }
    });

    const invalidSelect = await client.callTool({
      name: "browser_tabs",
      arguments: {
        action: "select",
        index: 99
      }
    });

    expect(invalidSelect.isError).toBe(true);
    expect(textFromResult(invalidSelect)).toContain("[invalid_tab_index]");
  });

  it("starts and closes stdio transport with custom streams", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const bundle = await startRoxyBrowserMcpStdio({
      sessionFactory: fakeSessionFactory,
      stdin,
      stdout
    });
    cleanupCallbacks.push(async () => bundle.close());

    expect(bundle.transport).toBeDefined();
  });

  it("isolates HTTP runtime state by MCP session", async () => {
    const httpBundle = await startRoxyBrowserMcpHttp({
      port: 0,
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => httpBundle.close());

    const address = httpBundle.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral HTTP address.");
    }
    const baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);

    const clientOne = createClient();
    const transportOne = new StreamableHTTPClientTransport(baseUrl);
    cleanupCallbacks.push(async () => transportOne.close());
    cleanupCallbacks.push(async () => clientOne.close());
    await clientOne.connect(transportOne);

    const clientTwo = createClient();
    const transportTwo = new StreamableHTTPClientTransport(baseUrl);
    cleanupCallbacks.push(async () => transportTwo.close());
    cleanupCallbacks.push(async () => clientTwo.close());
    await clientTwo.connect(transportTwo);

    await clientOne.callTool({
      name: "roxy_browser_connect",
      arguments: {
        protocol: "cdp",
        endpoint: "ws://client-one.invalid/devtools/browser/1"
      }
    });
    await clientTwo.callTool({
      name: "roxy_browser_connect",
      arguments: {
        protocol: "cdp",
        endpoint: "ws://client-two.invalid/devtools/browser/1"
      }
    });

    await clientOne.callTool({
      name: "browser_tabs",
      arguments: {
        action: "new",
        url: "https://one.example"
      }
    });

    const clientOneTabs = await clientOne.callTool({
      name: "browser_tabs",
      arguments: {
        action: "list"
      }
    });
    const clientTwoTabs = await clientTwo.callTool({
      name: "browser_tabs",
      arguments: {
        action: "list"
      }
    });

    expect(textFromResult(clientOneTabs)).toContain("client-one.invalid");
    expect(textFromResult(clientOneTabs)).toContain("https://one.example");
    expect(textFromResult(clientTwoTabs)).toContain("client-two.invalid");
    expect(textFromResult(clientTwoTabs)).not.toContain("https://one.example");
  });

  it("creates a standalone server bundle", async () => {
    const bundle = createRoxyBrowserMcpServer({
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => bundle.close());

    expect(bundle.server).toBeDefined();
    expect(bundle.runtimeManager).toBeDefined();
  });
});
