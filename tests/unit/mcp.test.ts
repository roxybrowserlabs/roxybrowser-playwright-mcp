import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRoxyBrowserMcpInMemory, createRoxyBrowserMcpServer, startRoxyBrowserMcpHttp, startRoxyBrowserMcpStdio } from "../../src/mcp/index.js";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BrowserSessionFactory,
  BrowserSnapshot,
  BrowserSnapshotRequest,
  BrowserTab,
  ClickTarget,
  ConnectedBrowserSession,
  RoxyBrowserConnectArgs,
  SessionClickOptions,
  SessionTypeOptions
} from "../../src/mcp/index.js";


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

  async snapshot(request: BrowserSnapshotRequest = {}): Promise<BrowserSnapshot> {
    const activeTab = this.tabs.find((tab) => tab.active) ?? this.tabs[0];
    const targetSuffix = request.target?.nodeToken
      ? ` [target=${request.target.nodeToken}]`
      : request.target?.selector
        ? ` [target=${request.target.selector}]`
        : "";
    const depthSuffix = request.depth !== undefined ? ` [depth=${request.depth}]` : "";
    const boxSuffix = request.boxes ? " [box=0,0,120,32]" : "";
    return {
      title: activeTab?.title ?? "",
      url: activeTab?.url ?? "",
      text: `- button "${activeTab?.title ?? "Action"}" [ref=e1]${targetSuffix}${depthSuffix}${boxSuffix}`,
      refs: {
        e1: `${activeTab?.id ?? "tab"}:node-1`
      }
    };
  }

  clickCalls: Array<{ target: ClickTarget; options: SessionClickOptions }> = [];
  hoverCalls: Array<ClickTarget> = [];
  navigateCalls: string[] = [];
  typeCalls: Array<{ target: ClickTarget; text: string; options?: SessionTypeOptions }> = [];
  pressKeyCalls: Array<{ key: string; modifiers?: string[] }> = [];
  selectOptionCalls: Array<{ target: ClickTarget; values: string[] }> = [];
  checkCalls: Array<{ target: ClickTarget; checked: boolean }> = [];
  goBackCount = 0;
  goForwardCount = 0;
  scrollCalls: Array<{ target: ClickTarget | null; deltaX: number; deltaY: number }> = [];
  screenshotCount = 0;
  uploadFileCalls: Array<{ target: ClickTarget; paths: string[] }> = [];

  async click(target: ClickTarget, options: SessionClickOptions): Promise<void> {
    this.clickCalls.push({ target, options });
  }

  async hover(target: ClickTarget): Promise<void> {
    this.hoverCalls.push(target);
  }

  async navigate(url: string): Promise<void> {
    this.navigateCalls.push(url);
    const activeTab = this.tabs.find((tab) => tab.active);
    if (activeTab) {
      activeTab.url = url;
      activeTab.title = url;
    }
  }

  async type(target: ClickTarget, text: string, options?: SessionTypeOptions): Promise<void> {
    this.typeCalls.push({ target, text, options });
  }

  async pressKey(key: string, modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">): Promise<void> {
    this.pressKeyCalls.push({ key, modifiers });
  }

  async selectOption(target: ClickTarget, values: string[]): Promise<string[]> {
    this.selectOptionCalls.push({ target, values });
    return values;
  }

  async check(target: ClickTarget, checked: boolean): Promise<void> {
    this.checkCalls.push({ target, checked });
  }

  async goBack(): Promise<void> {
    this.goBackCount++;
  }

  async goForward(): Promise<void> {
    this.goForwardCount++;
  }

  async scroll(target: ClickTarget | null, deltaX: number, deltaY: number): Promise<void> {
    this.scrollCalls.push({ target, deltaX, deltaY });
  }

  async screenshot(): Promise<string> {
    this.screenshotCount++;
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  }

  async uploadFile(target: ClickTarget, paths: string[]): Promise<void> {
    this.uploadFileCalls.push({ target, paths });
  }


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
      "browser_check",
      "browser_click",
      "browser_file_upload",
      "browser_go_back",
      "browser_go_forward",
      "browser_hover",
      "browser_navigate",
      "browser_press_key",
      "browser_scroll",
      "browser_select_option",
      "browser_snapshot",
      "browser_tabs",
      "browser_take_screenshot",
      "browser_type",
      "browser_wait_for",
      "roxy_browser_connect"
    ]);
  });

  it("returns structured errors before connect and invalidates snapshot cache after click", async () => {
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

    // Click with a valid aria-ref — should succeed and return a new snapshot
    const clicked = await client.callTool({
      name: "browser_click",
      arguments: {
        target: "e1"
      }
    });
    expect(clicked.isError).toBeUndefined();
    expect(textFromResult(clicked)).toContain("button");

    // Hover with an invalid ref (no snapshot cache after a hover-invalidation)
    const hoverResult = await client.callTool({
      name: "browser_hover",
      arguments: {
        ref: "e999"
      }
    });
    expect(hoverResult.isError).toBe(true);
    expect(textFromResult(hoverResult)).toContain("[stale_ref]");
  });

  it("passes Playwright-style snapshot args through the MCP layer and can save to a file", async () => {
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
        protocol: "cdp",
        endpoint: "ws://snapshot-args.invalid/devtools/browser/1"
      }
    });

    const tempDir = await mkdtemp(join(tmpdir(), "roxybrowser-mcp-"));
    cleanupCallbacks.push(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });
    const filename = join(tempDir, "snapshot.md");

    const result = await client.callTool({
      name: "browser_snapshot",
      arguments: {
        target: "e1",
        depth: 2,
        boxes: true,
        filename
      }
    });

    expect(result.isError).toBeUndefined();
    expect(textFromResult(result)).toContain(`Saved snapshot to "${filename}".`);

    const savedSnapshot = await readFile(filename, "utf8");
    expect(savedSnapshot).toContain("[target=tab-1:node-1]");
    expect(savedSnapshot).toContain("[depth=2]");
    expect(savedSnapshot).toContain("[box=0,0,120,32]");
    // Playwright writes the raw snapshot text — no "Snapshot (title - url):" header.
    expect(savedSnapshot).not.toContain("Snapshot (");
    expect(savedSnapshot.startsWith("- button")).toBe(true);
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

  describe("browser_click", () => {
    async function setupConnectedClient() {
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
          protocol: "cdp",
          endpoint: "ws://click-test.invalid/devtools/browser/1"
        }
      });
      return client;
    }

    it("resolves aria-ref target and returns updated snapshot", async () => {
      const client = await setupConnectedClient();

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "e1" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("button");
    });

    it("accepts CSS selector as target", async () => {
      const client = await setupConnectedClient();

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "button.submit" }
      });

      expect(result.isError).toBeUndefined();
    });

    it("returns stale_ref error for unknown aria-ref", async () => {
      const client = await setupConnectedClient();

      // Take a snapshot to warm the cache, then try a ref that doesn't exist
      await client.callTool({ name: "browser_snapshot", arguments: {} });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "e999" }
      });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain("[stale_ref]");
      // Message text aligns with Playwright's wording.
      expect(textFromResult(result)).toContain(
        "Ref e999 not found in the current page snapshot. Try capturing new snapshot."
      );
    });

    it("accepts doubleClick option", async () => {
      const client = await setupConnectedClient();

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "e1", doubleClick: true }
      });

      expect(result.isError).toBeUndefined();
    });

    it("accepts button option", async () => {
      const client = await setupConnectedClient();

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "e1", button: "right" }
      });

      expect(result.isError).toBeUndefined();
    });

    it("accepts modifiers option", async () => {
      const client = await setupConnectedClient();

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "e1", modifiers: ["Shift"] }
      });

      expect(result.isError).toBeUndefined();
    });

    it("accepts human profile option", async () => {
      const client = await setupConnectedClient();

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "e1", human: { profile: "cautious" } }
      });

      expect(result.isError).toBeUndefined();
    });

    it("records hover call before click in fake session", async () => {
      let capturedSession: FakeConnectedBrowserSession | undefined;
      const trackingFactory: BrowserSessionFactory = async (args) => {
        capturedSession = new FakeConnectedBrowserSession(args);
        return capturedSession;
      };

      const bundle = await createRoxyBrowserMcpInMemory({ sessionFactory: trackingFactory });
      cleanupCallbacks.push(async () => bundle.close());
      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { protocol: "cdp", endpoint: "ws://hover-test.invalid/devtools/browser/1" }
      });

      await client.callTool({
        name: "browser_click",
        arguments: { target: "e1" }
      });

      expect(capturedSession).toBeDefined();
      // hover is called before click (humanization)
      expect(capturedSession!.hoverCalls.length).toBeGreaterThanOrEqual(1);
      expect(capturedSession!.clickCalls.length).toBe(1);
      // aria-ref was resolved to a nodeToken
      expect(capturedSession!.clickCalls[0]!.target).toHaveProperty("nodeToken");
    });

    it("passes selector directly for non-ref targets", async () => {
      let capturedSession: FakeConnectedBrowserSession | undefined;
      const trackingFactory: BrowserSessionFactory = async (args) => {
        capturedSession = new FakeConnectedBrowserSession(args);
        return capturedSession;
      };

      const bundle = await createRoxyBrowserMcpInMemory({ sessionFactory: trackingFactory });
      cleanupCallbacks.push(async () => bundle.close());
      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { protocol: "cdp", endpoint: "ws://selector-test.invalid/devtools/browser/1" }
      });

      await client.callTool({
        name: "browser_click",
        arguments: { target: "button.primary" }
      });

      expect(capturedSession).toBeDefined();
      expect(capturedSession!.clickCalls[0]!.target).toEqual({ selector: "button.primary" });
    });
  });

  describe("snapshotMode", () => {
    async function setupClient(options: { snapshotMode?: "full" | "none" } = {}) {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: fakeSessionFactory,
        ...(options.snapshotMode !== undefined ? { snapshotMode: options.snapshotMode } : {})
      });
      cleanupCallbacks.push(async () => bundle.close());

      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { protocol: "cdp", endpoint: "ws://snapshot-mode.invalid/devtools/browser/1" }
      });
      return client;
    }

    it("appends the updated snapshot to click results by default (full mode)", async () => {
      const client = await setupClient();

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "e1" }
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain("Snapshot (");
      expect(text).toContain('button');
    });

    it("appends the updated snapshot to click results when snapshotMode is full", async () => {
      const client = await setupClient({ snapshotMode: "full" });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "e1" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("Snapshot (");
    });

    it("omits the snapshot from click results when snapshotMode is none", async () => {
      const client = await setupClient({ snapshotMode: "none" });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "e1" }
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).not.toContain("Snapshot (");
      expect(text).toContain("Clicked");
    });

    it("still serves explicit browser_snapshot calls when snapshotMode is none", async () => {
      const client = await setupClient({ snapshotMode: "none" });

      const result = await client.callTool({
        name: "browser_snapshot",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("Snapshot (");
    });
  });

  async function setupTrackingClient() {
    let capturedSession: FakeConnectedBrowserSession | undefined;
    const trackingFactory: BrowserSessionFactory = async (args) => {
      capturedSession = new FakeConnectedBrowserSession(args);
      return capturedSession;
    };
    const bundle = await createRoxyBrowserMcpInMemory({ sessionFactory: trackingFactory });
    cleanupCallbacks.push(async () => bundle.close());
    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: { protocol: "cdp", endpoint: "ws://tools-test.invalid/devtools/browser/1" }
    });
    return { client, getSession: () => capturedSession! };
  }

  describe("browser_navigate", () => {
    it("calls session.navigate and returns a snapshot", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_navigate",
        arguments: { url: "https://example.com" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().navigateCalls).toEqual(["https://example.com"]);
      expect(textFromResult(result)).toContain("Snapshot (");
    });

    it("omits snapshot in snapshotMode none", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: fakeSessionFactory,
        snapshotMode: "none"
      });
      cleanupCallbacks.push(async () => bundle.close());
      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);
      await client.callTool({ name: "roxy_browser_connect", arguments: { protocol: "cdp", endpoint: "ws://x.invalid/1" } });

      const result = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com" } });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain("Navigated to");
      expect(text).not.toContain("Snapshot (");
    });

    it("rejects non-URL input", async () => {
      const { client } = await setupTrackingClient();
      const result = await client.callTool({ name: "browser_navigate", arguments: { url: "not-a-url" } });
      expect(result.isError).toBe(true);
    });
  });

  describe("browser_type", () => {
    it("calls session.type with ref and text, returns snapshot", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_type",
        arguments: { ref: "e1", text: "hello" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().typeCalls.length).toBe(1);
      expect(getSession().typeCalls[0]!.text).toBe("hello");
      expect(getSession().typeCalls[0]!.target).toHaveProperty("nodeToken");
      expect(textFromResult(result)).toContain("Snapshot (");
    });

    it("passes submit option through", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_type",
        arguments: { ref: "e1", text: "query", submit: true }
      });

      expect(getSession().typeCalls[0]!.options?.submit).toBe(true);
    });

    it("uses CSS selector when ref is not a snapshot ref", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_type",
        arguments: { ref: "input#search", text: "test" }
      });

      expect(getSession().typeCalls[0]!.target).toEqual({ selector: "input#search" });
    });

    it("returns stale_ref for unknown aria-ref", async () => {
      const { client } = await setupTrackingClient();
      await client.callTool({ name: "browser_snapshot", arguments: {} });

      const result = await client.callTool({ name: "browser_type", arguments: { ref: "e999", text: "hi" } });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain("[stale_ref]");
    });
  });

  describe("browser_press_key", () => {
    it("calls session.pressKey and returns snapshot", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_press_key",
        arguments: { key: "Enter" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().pressKeyCalls).toEqual([{ key: "Enter", modifiers: undefined }]);
      expect(textFromResult(result)).toContain("Snapshot (");
    });

    it("passes modifier keys", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_press_key",
        arguments: { key: "a", modifiers: ["Control"] }
      });

      expect(getSession().pressKeyCalls[0]!.modifiers).toEqual(["Control"]);
    });
  });

  describe("browser_select_option", () => {
    it("calls session.selectOption and returns selected values with snapshot", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_select_option",
        arguments: { ref: "e1", values: ["opt1", "opt2"] }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().selectOptionCalls[0]!.values).toEqual(["opt1", "opt2"]);
      const text = textFromResult(result);
      expect(text).toContain("opt1");
      expect(text).toContain("Snapshot (");
    });

    it("resolves selector as-is", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_select_option",
        arguments: { ref: "select#lang", values: ["en"] }
      });

      expect(getSession().selectOptionCalls[0]!.target).toEqual({ selector: "select#lang" });
    });
  });

  describe("browser_check", () => {
    it("checks element by default", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_check",
        arguments: { ref: "e1" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().checkCalls[0]!.checked).toBe(true);
      expect(textFromResult(result)).toContain("Snapshot (");
    });

    it("unchecks element when checked is false", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_check",
        arguments: { ref: "e1", checked: false }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().checkCalls[0]!.checked).toBe(false);
      expect(textFromResult(result)).toContain("Snapshot (");
    });
  });

  describe("browser_go_back", () => {
    it("calls session.goBack and returns snapshot", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_go_back",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().goBackCount).toBe(1);
      expect(textFromResult(result)).toContain("Snapshot (");
    });
  });

  describe("browser_go_forward", () => {
    it("calls session.goForward and returns snapshot", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_go_forward",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().goForwardCount).toBe(1);
      expect(textFromResult(result)).toContain("Snapshot (");
    });
  });

  describe("browser_scroll", () => {
    it("scrolls whole page when no ref given", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_scroll",
        arguments: { deltaY: 500 }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().scrollCalls[0]).toEqual({ target: null, deltaX: 0, deltaY: 500 });
      expect(textFromResult(result)).toContain("Snapshot (");
    });

    it("resolves ref to element scroll", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_scroll",
        arguments: { ref: "e1", deltaX: 100, deltaY: 200 }
      });

      expect(getSession().scrollCalls[0]!.target).toHaveProperty("nodeToken");
      expect(getSession().scrollCalls[0]!.deltaX).toBe(100);
      expect(getSession().scrollCalls[0]!.deltaY).toBe(200);
    });
  });

  describe("browser_wait_for", () => {
    it("returns snapshot immediately when text condition already met", async () => {
      const { client } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_wait_for",
        arguments: { text: "button" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("Snapshot (");
    });

    it("returns snapshot immediately when url condition already met", async () => {
      const { client } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_wait_for",
        arguments: { url: "tools-test.invalid" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("Snapshot (");
    });

    it("times out when condition is never met", async () => {
      const { client } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_wait_for",
        arguments: { text: "this-text-never-appears-xyz", timeout: 300 }
      });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain("[timeout]");
    });
  });

  describe("browser_take_screenshot", () => {
    it("returns an image content item", async () => {
      const { client } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      const imageItems = (result.content as Array<{ type: string; data?: string; mimeType?: string }>)
        .filter((item) => item.type === "image");
      expect(imageItems.length).toBe(1);
      expect(imageItems[0]!.mimeType).toBe("image/png");
      expect(typeof imageItems[0]!.data).toBe("string");
    });

    it("saves screenshot to file when filename is given", async () => {
      const { client } = await setupTrackingClient();
      const tempDir = await mkdtemp(join(tmpdir(), "roxy-screenshot-"));
      cleanupCallbacks.push(async () => rm(tempDir, { recursive: true, force: true }));
      const filename = join(tempDir, "screen.png");

      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: { filename }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain(filename);
      const saved = await readFile(filename);
      expect(saved.length).toBeGreaterThan(0);
    });

    it("calls session.screenshot", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({ name: "browser_take_screenshot", arguments: {} });

      expect(getSession().screenshotCount).toBe(1);
    });
  });

  describe("browser_file_upload", () => {
    it("calls session.uploadFile and returns snapshot", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_file_upload",
        arguments: { ref: "e1", paths: ["/tmp/file.txt"] }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().uploadFileCalls[0]!.paths).toEqual(["/tmp/file.txt"]);
      expect(getSession().uploadFileCalls[0]!.target).toHaveProperty("nodeToken");
      expect(textFromResult(result)).toContain("Snapshot (");
    });

    it("passes selector target for non-ref inputs", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_file_upload",
        arguments: { ref: "input[type=file]", paths: ["/tmp/a.pdf"] }
      });

      expect(getSession().uploadFileCalls[0]!.target).toEqual({ selector: "input[type=file]" });
    });
  });
});
