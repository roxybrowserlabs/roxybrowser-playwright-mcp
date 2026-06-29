import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRoxyBrowserMcpInMemory, createRoxyBrowserMcpServer, startRoxyBrowserMcpHttp, startRoxyBrowserMcpStdio } from "../../src/mcp/index.js";
import { resetBidiClientFactoryForTests, setBidiClientFactoryForTests } from "../../src/protocol/bidi/client.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserSessionFactory,
  BrowserNetworkRequest,
  BrowserSnapshot,
  BrowserSnapshotRequest,
  BrowserTab,
  ClickTarget,
  ConnectedBrowserSession,
  RoxyBrowserConnectArgs,
  SessionClickOptions,
  SessionDragOptions,
  SessionDropOptions,
  SessionFormField,
  SessionScreenshotOptions,
  SessionTypeOptions
} from "../../src/mcp/index.js";


class FakeConnectedBrowserSession implements ConnectedBrowserSession {
  readonly browserName: "chromium" | "firefox";
  readonly protocol: "cdp" | "bidi";
  private tabs: BrowserTab[];
  private nextTabId = 2;
  private dialogOpen = false;

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
  focusCalls: Array<ClickTarget> = [];
  clearCalls: Array<ClickTarget> = [];
  navigateCalls: string[] = [];
  typeCalls: Array<{ target: ClickTarget; text: string; options?: SessionTypeOptions }> = [];
  pressKeyCalls: Array<{ key: string; modifiers?: string[] }> = [];
  dragCalls: Array<{ start: ClickTarget; end: ClickTarget; options: SessionDragOptions }> = [];
  dropCalls: Array<{ target: ClickTarget; payload: SessionDropOptions }> = [];
  selectOptionCalls: Array<{ target: ClickTarget; values: string[] }> = [];
  checkCalls: Array<{ target: ClickTarget; checked: boolean }> = [];
  goBackCount = 0;
  goForwardCount = 0;
  scrollCalls: Array<{ target: ClickTarget | null; deltaX: number; deltaY: number }> = [];
  screenshotCount = 0;
  uploadFileCalls: Array<{ target: ClickTarget; paths: string[] }> = [];
  prepareForFileUploadCalls: ClickTarget[] = [];
  finishFileUploadCalls: ClickTarget[] = [];
  fillFormCalls: SessionFormField[][] = [];

  async consoleMessages() {
    return [{
      type: "log",
      text: "hello",
      timestamp: Date.now(),
      formattedText: "[LOG] hello @ :0"
    }];
  }

  async evaluate(expression: string): Promise<unknown> {
    return `evaluated:${expression}`;
  }

  async isFileInput(target: ClickTarget): Promise<boolean> {
    return "selector" in target && target.selector.includes("file");
  }

  async prepareForFileUpload(target: ClickTarget): Promise<void> {
    this.prepareForFileUploadCalls.push(target);
  }

  async click(target: ClickTarget, options: SessionClickOptions): Promise<void> {
    this.clickCalls.push({ target, options });
    const targetValue = "selector" in target ? target.selector : target.nodeToken;
    if (targetValue.includes("dialog")) {
      this.dialogOpen = true;
    }
  }

  async hover(target: ClickTarget): Promise<void> {
    this.hoverCalls.push(target);
  }

  async focus(target: ClickTarget): Promise<void> {
    this.focusCalls.push(target);
  }

  async clear(target: ClickTarget): Promise<void> {
    this.clearCalls.push(target);
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

  async drag(start: ClickTarget, end: ClickTarget, options: SessionDragOptions): Promise<void> {
    this.dragCalls.push({ start, end, options });
  }

  async drop(target: ClickTarget, payload: SessionDropOptions): Promise<void> {
    this.dropCalls.push({ target, payload });
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

  async resize(width: number, height: number): Promise<void> {
    const activeTab = this.tabs.find((tab) => tab.active);
    if (activeTab) {
      activeTab.title = `${width}x${height}`;
    }
  }

  async screenshot(_options?: SessionScreenshotOptions): Promise<{ data: string; mimeType: "image/png" | "image/jpeg" }> {
    this.screenshotCount++;
    return {
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      mimeType: "image/png"
    };
  }

  async uploadFile(target: ClickTarget, paths: string[]): Promise<void> {
    this.uploadFileCalls.push({ target, paths });
  }

  async finishFileUpload(target: ClickTarget): Promise<void> {
    this.finishFileUploadCalls.push(target);
  }

  async fillForm(fields: SessionFormField[]): Promise<void> {
    this.fillFormCalls.push(fields);
  }

  async hasDialog(): Promise<boolean> {
    return this.dialogOpen;
  }

  async handleDialog(_accept: boolean, _promptText?: string): Promise<void> {
    if (!this.dialogOpen) {
      throw new Error("No dialog visible.");
    }
    this.dialogOpen = false;
  }

  async networkRequests(): Promise<BrowserNetworkRequest[]> {
    return [{
      index: 1,
      requestId: "request-1",
      method: "GET",
      url: "https://example.test/api",
      resourceType: "fetch",
      requestHeaders: {},
      status: 200,
      statusText: "OK",
      responseHeaders: {},
      responseBody: "{}"
    }];
  }

  async networkRequest(index: number): Promise<BrowserNetworkRequest | undefined> {
    return (await this.networkRequests()).find((request) => request.index === index);
  }

  async fetchResponseBody(index: number): Promise<string | undefined> {
    const request = await this.networkRequest(index);
    return request?.responseBody;
  }

  async runCodeUnsafe(code: string): Promise<unknown> {
    return `ran:${code}`;
  }


  async close(): Promise<void> {}
}

class SwitchingActiveTabSession extends FakeConnectedBrowserSession {
  private snapshotCount = 0;

  override async listTabs(): Promise<BrowserTab[]> {
    const tabs = await super.listTabs();
    return tabs.map((tab, index) => ({
      ...tab,
      active: index === 1
    }));
  }

  override async snapshot(_request: BrowserSnapshotRequest = {}): Promise<BrowserSnapshot> {
    this.snapshotCount += 1;
    const activeTab = (await this.listTabs()).find((tab) => tab.active);
    return {
      title: activeTab?.title ?? "",
      url: activeTab?.url ?? "",
      text: `- document "snapshot-${this.snapshotCount}" [ref=e1]`,
      refs: {
        e1: `${activeTab?.id ?? "tab"}:node-1`
      }
    };
  }
}

class MismatchedSnapshotMetadataSession extends FakeConnectedBrowserSession {
  override async listTabs(): Promise<BrowserTab[]> {
    const tabs = await super.listTabs();
    return tabs.map((tab, index) => ({
      ...tab,
      active: index === 1
    }));
  }

  override async snapshot(_request: BrowserSnapshotRequest = {}): Promise<BrowserSnapshot> {
    return {
      title: "",
      url: "about:blank",
      text: "",
      refs: {}
    };
  }
}

class NotReadyThenReadySnapshotSession extends FakeConnectedBrowserSession {
  private attempts = 0;

  override async snapshot(_request: BrowserSnapshotRequest = {}): Promise<BrowserSnapshot> {
    this.attempts += 1;
    if (this.attempts === 1) {
      return {
        title: "",
        url: "about:blank",
        text: "",
        refs: {}
      };
    }

    const activeTab = (await this.listTabs()).find((tab) => tab.active) ?? (await this.listTabs())[0];
    return {
      title: activeTab?.title ?? "",
      url: activeTab?.url ?? "",
      text: `- button "Ready" [ref=e1]`,
      refs: {
        e1: `${activeTab?.id ?? "tab"}:node-1`
      }
    };
  }
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
  resetBidiClientFactoryForTests();
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
      "browser_close",
      "browser_console_messages",
      "browser_drag",
      "browser_drop",
      "browser_evaluate",
      "browser_file_upload",
      "browser_fill_form",
      "browser_handle_dialog",
      "browser_hover",
      "browser_navigate",
      "browser_navigate_back",
      "browser_navigate_forward",
      "browser_network_request",
      "browser_network_requests",
      "browser_press_key",
      "browser_resize",
      "browser_run_code_unsafe",
      "browser_select_option",
      "browser_snapshot",
      "browser_tabs",
      "browser_take_screenshot",
      "browser_type",
      "browser_wait_for",
      "roxy_browser_connect"
    ]);
  });

  it("exposes Playwright-like schemas for hover and file upload", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const tools = await client.listTools();
    const hoverTool = tools.tools.find((tool) => tool.name === "browser_hover");
    const uploadTool = tools.tools.find((tool) => tool.name === "browser_file_upload");

    expect(hoverTool?.inputSchema).toEqual({
      type: "object",
      properties: {
        element: {
          description: "Human-readable element description used to obtain permission to interact with the element",
          type: "string"
        },
        target: {
          description: "Exact target element reference from the page snapshot, or a unique element selector",
          type: "string"
        }
      },
      required: ["target"],
      $schema: "http://json-schema.org/draft-07/schema#"
    });

    expect(uploadTool?.inputSchema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "The absolute paths to the files to upload. Can be single file or multiple files. If omitted, file chooser is cancelled."
        }
      },
      additionalProperties: false
    });
  });

  it("passes drop file paths through to the session", async () => {
    let capturedSession: FakeConnectedBrowserSession | undefined;
    const trackingFactory: BrowserSessionFactory = async (args) => {
      capturedSession = new FakeConnectedBrowserSession(args);
      return capturedSession;
    };
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: trackingFactory
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: {
        endpoint: "ws://drop-paths.invalid/devtools/browser/1"
      }
    });

    await client.callTool({
      name: "browser_drop",
      arguments: {
        target: "dropzone",
        paths: ["/tmp/sample.txt"]
      }
    });

    expect(capturedSession?.dropCalls[0]?.payload.paths).toEqual(["/tmp/sample.txt"]);
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
        endpoint: "ws://session-one.invalid/devtools/browser/1"
      }
    });
    expect(connected.isError).toBeUndefined();
    expect(textFromResult(connected)).toContain("Connected to chrome via cdp.");

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
        target: "e999"
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
    // Playwright writes the raw snapshot text, without the MCP response header.
    expect(savedSnapshot).not.toContain("### Snapshot");
    expect(savedSnapshot.startsWith("- button")).toBe(true);
  });

  it("resolves relative browser_snapshot filenames into the configured temp dir", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "roxybrowser-mcp-output-"));
    const tempDir = await mkdtemp(join(tmpdir(), "roxybrowser-mcp-temp-"));
    cleanupCallbacks.push(async () => {
      await rm(outputDir, { recursive: true, force: true });
      await rm(tempDir, { recursive: true, force: true });
    });

    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory,
      outputDir,
      tempDir
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: {
        endpoint: "ws://snapshot-output.invalid/devtools/browser/1"
      }
    });

    const relativeFilename = "nested/snapshot.md";
    const resolvedFilename = join(tempDir, "nested", "snapshot.md");

    const result = await client.callTool({
      name: "browser_snapshot",
      arguments: {
        filename: relativeFilename
      }
    });

    expect(result.isError).toBeUndefined();
    expect(textFromResult(result)).toContain(`Saved snapshot to "${resolvedFilename}".`);
    expect(textFromResult(result)).not.toContain(outputDir);

    const savedSnapshot = await readFile(resolvedFilename, "utf8");
    expect(savedSnapshot).toContain("- button");
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
      arguments: { browser: "firefox", endpoint: "ws://session-two.invalid" }
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
        endpoint: "ws://client-one.invalid/devtools/browser/1"
      }
    });
    await clientTwo.callTool({
      name: "roxy_browser_connect",
      arguments: {
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

    it("does not auto-capture snapshot while a dialog is open", async () => {
      const client = await setupConnectedClient();

      const click = await client.callTool({
        name: "browser_click",
        arguments: { target: "button#dialog", element: "Dialog button" }
      });

      expect(click.isError).toBeUndefined();
      expect(textFromResult(click)).toContain('Clicked "Dialog button".');
      expect(textFromResult(click)).not.toContain("### Snapshot");

      const handled = await client.callTool({
        name: "browser_handle_dialog",
        arguments: { accept: true }
      });

      expect(handled.isError).toBeUndefined();
      expect(textFromResult(handled)).toContain("### Snapshot");
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
        arguments: { endpoint: "ws://hover-test.invalid/devtools/browser/1" }
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
        arguments: { endpoint: "ws://selector-test.invalid/devtools/browser/1" }
      });

      await client.callTool({
        name: "browser_click",
        arguments: { target: "button.primary" }
      });

      expect(capturedSession).toBeDefined();
      expect(capturedSession!.clickCalls[0]!.target).toEqual({ selector: "button.primary" });
    });

    it("creates a Firefox BiDi session when a root websocket endpoint has no active session", async () => {
      const sessionNew = vi.fn(async () => ({
        sessionId: "created-session",
        capabilities: { browserName: "firefox" }
      }));
      const createBidiClient = vi.fn(async () => ({
        capabilities: { browserName: "firefox" },
        close: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
        sessionStatus: vi.fn(async () => ({})),
        sessionEnd: vi.fn(async () => ({})),
        browsingContextGetTree: vi
          .fn()
          .mockRejectedValueOnce(new Error("invalid session id: session does not exist"))
          .mockResolvedValue({
            contexts: [
              {
                context: "tab-1",
                url: "about:blank",
                children: []
              }
            ]
          }),
        sessionNew,
        browsingContextActivate: vi.fn(async () => ({})),
        browsingContextCreate: vi.fn(async () => ({ context: "tab-1" })),
        browsingContextNavigate: vi.fn(async () => ({})),
        sessionSubscribe: vi.fn(async () => ({})),
        networkAddDataCollector: vi.fn(async () => ({ collector: "collector-1" })),
        networkRemoveDataCollector: vi.fn(async () => ({})),
        scriptAddPreloadScript: vi.fn(async () => ({ script: "script-1" })),
        scriptRemovePreloadScript: vi.fn(async () => ({})),
        scriptEvaluate: vi.fn(async (params: { expression: string }) => {
          if (params.expression.includes("document.title")) {
            return {
              type: "success",
              result: {
                value: "tab title"
              }
            };
          }
          return {
            type: "success",
            result: {
              value: {
                refs: {},
                text: "- heading \"Ready\" [ref=e1]",
                title: "tab title",
                url: "https://example.test/"
              }
            }
          };
        })
      }));

      setBidiClientFactoryForTests(createBidiClient);

      const bundle = await createRoxyBrowserMcpInMemory();
      cleanupCallbacks.push(async () => bundle.close());
      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);

      const result = await client.callTool({
        name: "roxy_browser_connect",
        arguments: {
          endpoint: "ws://127.0.0.1:63631",
          browser: "firefox"
        }
      });

      expect(createBidiClient).toHaveBeenCalledWith({
        browserName: "firefox",
        webSocketUrl: "ws://127.0.0.1:63631/session"
      });
      expect(sessionNew).toHaveBeenCalledWith({
        capabilities: {
          alwaysMatch: {
            acceptInsecureCerts: true
          }
        }
      });
      expect(result.isError).toBeUndefined();
    });

    it("passes a provided Firefox BiDi session id through the MCP connect tool", async () => {
      const createBidiClient = vi.fn(async () => ({
        capabilities: { browserName: "firefox" },
        close: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
        sessionStatus: vi.fn(async () => ({})),
        sessionEnd: vi.fn(async () => ({})),
        browsingContextGetTree: vi.fn(async () => ({
          contexts: [
            {
              context: "tab-1",
              url: "https://example.test/",
              children: []
            }
          ]
        })),
        browsingContextActivate: vi.fn(async () => ({})),
        browsingContextCreate: vi.fn(async () => ({ context: "tab-1" })),
        browsingContextNavigate: vi.fn(async () => ({})),
        sessionSubscribe: vi.fn(async () => ({})),
        networkAddDataCollector: vi.fn(async () => ({ collector: "collector-1" })),
        networkRemoveDataCollector: vi.fn(async () => ({})),
        scriptAddPreloadScript: vi.fn(async () => ({ script: "script-1" })),
        scriptRemovePreloadScript: vi.fn(async () => ({})),
        scriptEvaluate: vi.fn(async (params: { expression: string }) => {
          if (params.expression.includes("document.title")) {
            return {
              type: "success",
              result: {
                value: "tab title"
              }
            };
          }
          return {
            type: "success",
            result: {
              value: {
                refs: {},
                text: "- heading \"Ready\" [ref=e1]",
                title: "tab title",
                url: "https://example.test/"
              }
            }
          };
        })
      }));

      setBidiClientFactoryForTests(createBidiClient);

      const bundle = await createRoxyBrowserMcpInMemory();
      cleanupCallbacks.push(async () => bundle.close());
      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);

      const result = await client.callTool({
        name: "roxy_browser_connect",
        arguments: {
          endpoint: "ws://127.0.0.1:63631",
          browser: "firefox",
          sessionId: "existing-bidi-session"
        }
      });

      expect(createBidiClient).toHaveBeenCalledWith({
        browserName: "firefox",
        webSocketUrl: "ws://127.0.0.1:63631/session/existing-bidi-session"
      });
      expect(result.isError).toBeUndefined();
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
        arguments: { endpoint: "ws://snapshot-mode.invalid/devtools/browser/1" }
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
      expect(text).toContain("### Snapshot");
      expect(text).toContain('button');
    });

    it("appends the updated snapshot to click results when snapshotMode is full", async () => {
      const client = await setupClient({ snapshotMode: "full" });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "e1" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("### Snapshot");
    });

    it("omits the snapshot from click results when snapshotMode is none", async () => {
      const client = await setupClient({ snapshotMode: "none" });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "button" }
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).not.toContain("### Snapshot");
      expect(text).toContain("Clicked");
    });

    it("still serves explicit browser_snapshot calls when snapshotMode is none", async () => {
      const client = await setupClient({ snapshotMode: "none" });

      const result = await client.callTool({
        name: "browser_snapshot",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("### Snapshot");
    });

    it("keeps snapshot content after browser_tabs new followed by browser_snapshot", async () => {
      const client = await setupClient({ snapshotMode: "none" });

      const newTabResult = await client.callTool({
        name: "browser_tabs",
        arguments: {
          action: "new",
          url: "http://localhost:3000/"
        }
      });
      expect(newTabResult.isError).toBeUndefined();

      const snapshotResult = await client.callTool({
        name: "browser_snapshot",
        arguments: {}
      });

      expect(snapshotResult.isError).toBeUndefined();
      const text = textFromResult(snapshotResult);
      expect(text).toContain("### Snapshot");
      expect(text).toContain("button");
      expect(text).not.toContain("```yaml\n\n```");
    });

    it("uses the latest active tab metadata when rendering browser_snapshot", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: async (args) => {
          const session = new SwitchingActiveTabSession(args);
          await session.newTab("https://www.baidu.com/");
          return session;
        }
      });
      cleanupCallbacks.push(async () => bundle.close());
      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);

      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { endpoint: "ws://snapshot-active.invalid/devtools/browser/1" }
      });

      const result = await client.callTool({
        name: "browser_snapshot",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain("(current)");
      expect(text).toContain("(https://www.baidu.com/)");
      expect(text).toContain("- Page URL: https://www.baidu.com/");
      expect(text).not.toContain("- Page URL: about:blank");
    });

    it("prefers active tab header metadata over stale snapshot url/title", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: async (args) => {
          const session = new MismatchedSnapshotMetadataSession(args);
          await session.newTab("https://www.baidu.com/");
          return session;
        }
      });
      cleanupCallbacks.push(async () => bundle.close());
      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);

      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { endpoint: "ws://snapshot-mismatch.invalid/devtools/browser/1" }
      });

      const result = await client.callTool({
        name: "browser_snapshot",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain("- Page URL: https://www.baidu.com/");
      expect(text).toContain("- Page Title: ws://snapshot-mismatch.invalid/devtools/browser/1 tab-2");
      expect(text).not.toContain("- Page URL: about:blank");
      expect(text).not.toContain("- Page Title: (untitled)");
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
      arguments: { endpoint: "ws://tools-test.invalid/devtools/browser/1" }
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
      expect(textFromResult(result)).toContain("### Snapshot");
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
      await client.callTool({ name: "roxy_browser_connect", arguments: { endpoint: "ws://x.invalid/1" } });

      const result = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com" } });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain("await page.goto('https://example.com');");
      expect(text).not.toContain("### Snapshot");
    });

    it("accepts non-URL input like Playwright MCP", async () => {
      const { client } = await setupTrackingClient();
      const result = await client.callTool({ name: "browser_navigate", arguments: { url: "not-a-url" } });
      expect(result.isError).toBeUndefined();
    });
  });

  describe("browser_type", () => {
    it("calls session.type with ref and text, returns snapshot", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_type",
        arguments: { target: "e1", text: "hello" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().typeCalls.length).toBe(1);
      expect(getSession().typeCalls[0]!.text).toBe("hello");
      expect(getSession().typeCalls[0]!.target).toHaveProperty("nodeToken");
      expect(getSession().focusCalls).toHaveLength(1);
      expect(getSession().clearCalls).toHaveLength(1);
      expect(getSession().pressKeyCalls).toEqual([]);
      expect(textFromResult(result)).toContain("### Snapshot");
    });

    it("passes submit option through", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_type",
        arguments: { target: "e1", text: "query", submit: true }
      });

      expect(getSession().typeCalls[0]!.options?.submit).toBe(true);
    });

    it("uses CSS selector when ref is not a snapshot ref", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_type",
        arguments: { target: "input#search", text: "test" }
      });

      expect(getSession().typeCalls[0]!.target).toEqual({ selector: "input#search" });
    });

    it("returns stale_ref for unknown aria-ref", async () => {
      const { client } = await setupTrackingClient();
      await client.callTool({ name: "browser_snapshot", arguments: {} });

      const result = await client.callTool({ name: "browser_type", arguments: { target: "e999", text: "hi" } });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain("[stale_ref]");
    });
  });

  describe("browser_fill_form", () => {
    it("clears textbox content before typing", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_fill_form",
        arguments: {
          fields: [{ target: "e1", type: "textbox", value: "world", name: "Search" }]
        }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().focusCalls).toHaveLength(1);
      expect(getSession().clearCalls).toHaveLength(1);
      expect(getSession().pressKeyCalls).toEqual([]);
      expect(getSession().typeCalls[0]!.text).toBe("world");
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
      expect(textFromResult(result)).toContain("### Snapshot");
    });

  });

  describe("browser_drag", () => {
    it("calls session.drag and returns snapshot", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_drag",
        arguments: { startTarget: "e1", endTarget: "button.dropzone" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().dragCalls.length).toBe(1);
      expect(getSession().dragCalls[0]!.start).toHaveProperty("nodeToken");
      expect(getSession().dragCalls[0]!.end).toEqual({ selector: "button.dropzone" });
      expect(textFromResult(result)).toContain("### Snapshot");
    });
  });

  describe("browser_select_option", () => {
    it("calls session.selectOption and returns selected values with snapshot", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_select_option",
        arguments: { target: "e1", values: ["opt1", "opt2"] }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().selectOptionCalls[0]!.values).toEqual(["opt1", "opt2"]);
      const text = textFromResult(result);
      expect(text).toContain("opt1");
      expect(text).toContain("### Snapshot");
    });

    it("resolves selector as-is", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_select_option",
        arguments: { target: "select#lang", values: ["en"] }
      });

      expect(getSession().selectOptionCalls[0]!.target).toEqual({ selector: "select#lang" });
    });
  });

  describe("browser_navigate_back", () => {
    it("calls session.goBack and returns snapshot", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_navigate_back",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().goBackCount).toBe(1);
      expect(textFromResult(result)).toContain("### Snapshot");
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
      expect(textFromResult(result)).toContain("### Snapshot");
    });

    it("returns snapshot immediately when textGone condition is already met", async () => {
      const { client } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_wait_for",
        arguments: { textGone: "not present" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("### Snapshot");
    });

    it("rejects missing wait condition", async () => {
      const { client } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_wait_for",
        arguments: {}
      });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain("Either time, text or textGone must be provided");
    });
  });

  describe("browser_take_screenshot", () => {
    it("auto-saves screenshot to the output dir and returns an image content item", async () => {
      const outputDir = await mkdtemp(join(tmpdir(), "roxy-screenshot-auto-"));
      cleanupCallbacks.push(async () => rm(outputDir, { recursive: true, force: true }));

      let capturedSession: FakeConnectedBrowserSession | undefined;
      const trackingFactory: BrowserSessionFactory = async (args) => {
        capturedSession = new FakeConnectedBrowserSession(args);
        return capturedSession;
      };

      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: trackingFactory,
        outputDir
      });
      cleanupCallbacks.push(async () => bundle.close());

      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { endpoint: "ws://x.invalid/1" }
      });

      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toMatch(new RegExp(`${outputDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.+page-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z\\.png`));
      const imageItems = (result.content as Array<{ type: string; data?: string; mimeType?: string }>)
        .filter((item) => item.type === "image");
      expect(imageItems.length).toBe(1);
      expect(imageItems[0]!.mimeType).toBe("image/png");
      expect(typeof imageItems[0]!.data).toBe("string");
      expect(capturedSession?.screenshotCount).toBe(1);
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

    it("resolves relative screenshot filenames into the configured output dir", async () => {
      const outputDir = await mkdtemp(join(tmpdir(), "roxy-screenshot-output-"));
      cleanupCallbacks.push(async () => rm(outputDir, { recursive: true, force: true }));

      let capturedSession: FakeConnectedBrowserSession | undefined;
      const trackingFactory: BrowserSessionFactory = async (args) => {
        capturedSession = new FakeConnectedBrowserSession(args);
        return capturedSession;
      };

      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: trackingFactory,
        outputDir
      });
      cleanupCallbacks.push(async () => bundle.close());

      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { endpoint: "ws://x.invalid/1" }
      });

      const relativeFilename = "images/screen.png";
      const resolvedFilename = join(outputDir, "images", "screen.png");

      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: { filename: relativeFilename }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain(resolvedFilename);

      const saved = await readFile(resolvedFilename);
      expect(saved.length).toBeGreaterThan(0);
      expect(capturedSession?.screenshotCount).toBe(1);
    });

    it("treats an empty filename as auto-generated output", async () => {
      const outputDir = await mkdtemp(join(tmpdir(), "roxy-screenshot-empty-"));
      cleanupCallbacks.push(async () => rm(outputDir, { recursive: true, force: true }));

      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: fakeSessionFactory,
        outputDir
      });
      cleanupCallbacks.push(async () => bundle.close());

      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { endpoint: "ws://x.invalid/1" }
      });

      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: { filename: "" }
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toMatch(new RegExp(`${outputDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.+page-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z\\.png`));
      const imageItems = (result.content as Array<{ type: string; data?: string; mimeType?: string }>)
        .filter((item) => item.type === "image");
      expect(imageItems.length).toBe(1);
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

      await client.callTool({
        name: "browser_click",
        arguments: { target: "input[type=file]" }
      });

      const result = await client.callTool({
        name: "browser_file_upload",
        arguments: { paths: ["/tmp/file.txt"] }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().uploadFileCalls[0]!.paths).toEqual(["/tmp/file.txt"]);
      expect(getSession().uploadFileCalls[0]!.target).toEqual({ selector: "input[type=file]" });
      expect(getSession().prepareForFileUploadCalls).toEqual([{ selector: "input[type=file]" }]);
      expect(getSession().finishFileUploadCalls).toEqual([{ selector: "input[type=file]" }]);
      expect(textFromResult(result)).toContain("### Snapshot");
    });

    it("consumes the most recent file-input click as the chooser target", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_click",
        arguments: { target: "input[type=file]" }
      });

      await client.callTool({
        name: "browser_file_upload",
        arguments: { paths: ["/tmp/a.pdf"] }
      });

      expect(getSession().uploadFileCalls[0]!.target).toEqual({ selector: "input[type=file]" });
      expect(getSession().prepareForFileUploadCalls).toEqual([{ selector: "input[type=file]" }]);
      expect(getSession().finishFileUploadCalls).toEqual([{ selector: "input[type=file]" }]);
    });

    it("returns no_file_chooser when no file chooser is pending", async () => {
      const { client } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_file_upload",
        arguments: { paths: ["/tmp/a.pdf"] }
      });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain("[no_file_chooser]");
    });

    it("blocks hover while file chooser modal state is pending", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_click",
        arguments: { target: "input[type=file]" }
      });

      const result = await client.callTool({
        name: "browser_hover",
        arguments: { target: "button.upload" }
      });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain('Tool "browser_hover" does not handle the modal state.');
      expect(getSession().hoverCalls).toEqual([{ selector: "input[type=file]" }]);
    });
  });
});
