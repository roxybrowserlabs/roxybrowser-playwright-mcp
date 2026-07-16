import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  scrollCalls: Array<{
    target: ClickTarget | null;
    deltaX: number;
    deltaY: number;
    options?: { stepPx: number; stepDelayMs: number };
  }> = [];
  screenshotCount = 0;
  uploadFileCalls: Array<{ target: ClickTarget; paths: string[] }> = [];
  prepareForFileUploadCalls: ClickTarget[] = [];
  finishFileUploadCalls: ClickTarget[] = [];
  waitForPageTimeoutCalls: number[] = [];
  waitForMainFrameLoadCalls: number[] = [];
  waitForRequestFinishedCalls: Array<{ requestId: string; timeoutMs: number }> = [];
  waitForRequestResponseCalls: Array<{ requestId: string; timeoutMs: number }> = [];
  fillFormCalls: SessionFormField[][] = [];
  formFieldMetadataByTarget = new Map<string, { tagName: string; inputType?: string; isContentEditable?: boolean }>();
  pendingFileChooserTarget: ClickTarget | undefined;
  consumePendingChooserReturnsUndefinedOnce = false;
  networkRequestsList: BrowserNetworkRequest[] = [];
  requestCollectionStates: Array<{ requests: BrowserNetworkRequest[]; requestKeys: string[] }> = [];
  closeCount = 0;
  cursorVisualizationCount = 0;

  protected collectRequest(request: BrowserNetworkRequest): void {
    for (const collector of this.requestCollectionStates) {
      collector.requestKeys.push(request.requestKey ?? request.requestId);
    }
  }

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

  async consumePendingFileChooserTarget(): Promise<ClickTarget | undefined> {
    if (this.consumePendingChooserReturnsUndefinedOnce) {
      this.consumePendingChooserReturnsUndefinedOnce = false;
      return undefined;
    }
    const target = this.pendingFileChooserTarget;
    this.pendingFileChooserTarget = undefined;
    return target;
  }

  async click(target: ClickTarget, options: SessionClickOptions): Promise<void> {
    this.clickCalls.push({ target, options });
    const targetValue = "selector" in target ? target.selector : target.nodeToken;
    if (targetValue.includes("dialog")) {
      this.dialogOpen = true;
    }
    if (targetValue.includes("upload-button")) {
      this.pendingFileChooserTarget = { selector: "input[type=file]" };
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

  async formFieldMetadata(target: ClickTarget) {
    const key = "selector" in target ? target.selector : "nodeToken" in target ? target.nodeToken : String(target.backendNodeId);
    return this.formFieldMetadataByTarget.get(key) ?? { tagName: "input", inputType: "text" };
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

  async scroll(
    target: ClickTarget | null,
    deltaX: number,
    deltaY: number,
    options?: { stepPx: number; stepDelayMs: number }
  ): Promise<void> {
    this.scrollCalls.push({ target, deltaX, deltaY, options });
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
    const request = {
      index: this.networkRequestsList.length + 1,
      requestId: `request-${this.networkRequestsList.length + 1}`,
      method: "GET",
      url: "https://example.test/api",
      resourceType: "fetch",
      requestHeaders: {},
      status: 200,
      statusText: "OK",
      responseHeaders: {},
      responseBody: "{}"
    };
    this.networkRequestsList.push(request);
    this.collectRequest(request);
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
    return this.networkRequestsList.map((request) => ({ ...request }));
  }

  async beginRequestCollection(): Promise<unknown> {
    const state = { requests: [] as BrowserNetworkRequest[], requestKeys: [] as string[] };
    this.requestCollectionStates.push(state);
    return state;
  }

  async endRequestCollection(state?: unknown): Promise<BrowserNetworkRequest[]> {
    const collector = state as { requests: BrowserNetworkRequest[]; requestKeys: string[] } | undefined;
    if (!collector) {
      return [];
    }
    const uniqueKeys = Array.from(new Set(collector.requestKeys));
    const requests = uniqueKeys
      .map((requestKey) => this.networkRequestsList.find((request) => (request.requestKey ?? request.requestId) === requestKey))
      .filter((request): request is BrowserNetworkRequest => !!request)
      .map((request) => ({ ...request }));
    return requests.length ? requests : collector.requests.map((request) => ({ ...request }));
  }

  async networkRequest(index: number): Promise<BrowserNetworkRequest | undefined> {
    return (await this.networkRequests()).find((request) => request.index === index);
  }

  async fetchResponseBody(index: number): Promise<string | undefined> {
    const request = await this.networkRequest(index);
    return request?.responseBody;
  }

  async waitForPageTimeout(timeoutMs: number): Promise<void> {
    this.waitForPageTimeoutCalls.push(timeoutMs);
  }

  async waitForMainFrameLoad(timeoutMs: number): Promise<void> {
    this.waitForMainFrameLoadCalls.push(timeoutMs);
  }

  async waitForRequestFinished(requestId: string, timeoutMs: number): Promise<void> {
    this.waitForRequestFinishedCalls.push({ requestId, timeoutMs });
  }

  async waitForRequestResponse(requestId: string, timeoutMs: number): Promise<void> {
    this.waitForRequestResponseCalls.push({ requestId, timeoutMs });
  }

  async runCodeUnsafe(code: string): Promise<unknown> {
    return `ran:${code}`;
  }

  async ensureActiveCursorVisualization(): Promise<void> {
    this.cursorVisualizationCount++;
  }


  async close(): Promise<void> {
    this.closeCount += 1;
  }
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

class NavigationRequestSession extends FakeConnectedBrowserSession {
  override async click(target: ClickTarget, options: SessionClickOptions): Promise<void> {
    await super.click(target, options);
    const request: BrowserNetworkRequest = {
      index: this.networkRequestsList.length + 1,
      requestId: `request-${this.networkRequestsList.length + 1}`,
      method: "GET",
      url: "https://example.test/next",
      resourceType: "document",
      isNavigationRequest: true,
      requestHeaders: {},
      status: 200,
      statusText: "OK",
      responseHeaders: {}
    };
    this.networkRequestsList.push(request);
    this.collectRequest(request);
  }
}

class ImageRequestSession extends FakeConnectedBrowserSession {
  override async click(target: ClickTarget, options: SessionClickOptions): Promise<void> {
    await super.click(target, options);
    const request: BrowserNetworkRequest = {
      index: this.networkRequestsList.length + 1,
      requestId: `request-${this.networkRequestsList.length + 1}`,
      method: "GET",
      url: "https://example.test/logo.png",
      resourceType: "image",
      requestHeaders: {},
      status: 200,
      statusText: "OK",
      responseHeaders: {}
    };
    this.networkRequestsList.push(request);
    this.collectRequest(request);
  }
}

class DocumentButNotNavigationSession extends FakeConnectedBrowserSession {
  override async click(target: ClickTarget, options: SessionClickOptions): Promise<void> {
    await super.click(target, options);
    const request: BrowserNetworkRequest = {
      index: this.networkRequestsList.length + 1,
      requestId: `request-${this.networkRequestsList.length + 1}`,
      method: "GET",
      url: "https://example.test/frame-document",
      resourceType: "document",
      isNavigationRequest: false,
      requestHeaders: {},
      status: 200,
      statusText: "OK",
      responseHeaders: {}
    };
    this.networkRequestsList.push(request);
    this.collectRequest(request);
  }
}

class PendingRequestUntilCloseSession extends FakeConnectedBrowserSession {
  private pendingResolvers = new Map<string, () => void>();

  override async click(target: ClickTarget, options: SessionClickOptions): Promise<void> {
    await super.click(target, options);
    const request: BrowserNetworkRequest = {
      index: this.networkRequestsList.length + 1,
      requestId: `request-${this.networkRequestsList.length + 1}`,
      method: "GET",
      url: "https://example.test/pending.js",
      resourceType: "script",
      requestHeaders: {}
    };
    this.networkRequestsList.push(request);
    this.collectRequest(request);
  }

  override async waitForRequestFinished(requestId: string, timeoutMs: number): Promise<void> {
    this.waitForRequestFinishedCalls.push({ requestId, timeoutMs });
    await new Promise<void>((resolve) => {
      this.pendingResolvers.set(requestId, resolve);
    });
  }

  override async close(): Promise<void> {
    for (const resolve of this.pendingResolvers.values()) {
      resolve();
    }
    this.pendingResolvers.clear();
  }
}

class RedirectRequestSession extends FakeConnectedBrowserSession {
  override async click(target: ClickTarget, options: SessionClickOptions): Promise<void> {
    await super.click(target, options);
    const first: BrowserNetworkRequest = {
      index: this.networkRequestsList.length + 1,
      requestId: `request-${this.networkRequestsList.length + 1}`,
      requestKey: `request-${this.networkRequestsList.length + 1}#1`,
      method: "GET",
      url: "https://example.test/start",
      resourceType: "document",
      isNavigationRequest: true,
      requestHeaders: {},
      status: 302,
      statusText: "Found",
      responseHeaders: { location: "https://example.test/final" }
    };
    const second: BrowserNetworkRequest = {
      index: this.networkRequestsList.length + 2,
      requestId: first.requestId,
      requestKey: `${first.requestId}#2`,
      redirectedFromRequestKey: first.requestKey,
      finalRequestKey: `${first.requestId}#2`,
      method: "GET",
      url: "https://example.test/final",
      resourceType: "document",
      isNavigationRequest: true,
      requestHeaders: {},
      status: 200,
      statusText: "OK",
      responseHeaders: {}
    };
    first.redirectedToRequestKey = second.requestKey;
    first.finalRequestKey = second.requestKey;
    this.networkRequestsList.push(first, second);
    this.collectRequest(first);
    this.collectRequest(second);
  }
}

class UpdatingRequestSession extends FakeConnectedBrowserSession {
  override async click(target: ClickTarget, options: SessionClickOptions): Promise<void> {
    await super.click(target, options);
    const request: BrowserNetworkRequest = {
      index: this.networkRequestsList.length + 1,
      requestId: `request-${this.networkRequestsList.length + 1}`,
      method: "GET",
      url: "https://example.test/updating",
      resourceType: "fetch",
      requestHeaders: {}
    };
    this.networkRequestsList.push(request);
    this.collectRequest(request);
    request.status = 200;
    request.statusText = "OK";
    request.responseHeaders = { "content-type": "application/json" };
    request.responseBody = '{"ok":true}';
  }
}

class DelayedPostActionRequestSession extends FakeConnectedBrowserSession {
  override async click(target: ClickTarget, options: SessionClickOptions): Promise<void> {
    await super.click(target, options);
  }

  override async waitForPageTimeout(timeoutMs: number): Promise<void> {
    this.waitForPageTimeoutCalls.push(timeoutMs);
    if (timeoutMs === 500 && this.requestCollectionStates.length > 0 && this.networkRequestsList.length === 0) {
      const request: BrowserNetworkRequest = {
        index: 1,
        requestId: "request-1",
        method: "GET",
        url: "https://example.test/deferred.css",
        resourceType: "stylesheet",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: { "content-type": "text/css" }
      };
      this.networkRequestsList.push(request);
      this.collectRequest(request);
    }
  }
}

class BeginRequestCollectionFailureSession extends FakeConnectedBrowserSession {
  override async beginRequestCollection(): Promise<unknown> {
    throw new Error("begin request collection failed");
  }
}

class EndRequestCollectionFailureSession extends FakeConnectedBrowserSession {
  override async endRequestCollection(_state?: unknown): Promise<BrowserNetworkRequest[]> {
    throw new Error("end request collection failed");
  }
}

class PostActionQuietWindowFailureSession extends FakeConnectedBrowserSession {
  override async waitForPageTimeout(timeoutMs: number): Promise<void> {
    if (timeoutMs === 500 && this.requestCollectionStates.length > 0) {
      throw new Error("post-action quiet window failed");
    }
    await super.waitForPageTimeout(timeoutMs);
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
    const runCodeTool = tools.tools.find((tool) => tool.name === "browser_run_code_unsafe");

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

    expect(runCodeTool?.inputSchema.properties).toMatchObject({
      code: {
        type: "string",
        description: expect.stringContaining("JavaScript")
      },
      filename: {
        type: "string",
        description: expect.stringContaining("Load code")
      }
    });
    expect(runCodeTool?.inputSchema.required ?? []).not.toContain("code");
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

    const hovered = await client.callTool({
      name: "browser_hover",
      arguments: {
        target: "e1"
      }
    });
    expect(hovered.isError).toBeUndefined();

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

  it("installs cursor visualization after roxy_browser_connect succeeds", async () => {
    let capturedSession: FakeConnectedBrowserSession | undefined;
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: async (args) => {
        capturedSession = new FakeConnectedBrowserSession(args);
        return capturedSession;
      }
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const connected = await client.callTool({
      name: "roxy_browser_connect",
      arguments: {
        endpoint: "ws://cursor.invalid/devtools/browser/1"
      }
    });

    expect(connected.isError).toBeUndefined();
    expect(capturedSession?.cursorVisualizationCount).toBe(1);
  });

  it("clears previous browser context when roxy_browser_connect reconnects", async () => {
    const sessions: FakeConnectedBrowserSession[] = [];
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: async (args) => {
        const session = new FakeConnectedBrowserSession(args);
        sessions.push(session);
        return session;
      }
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const firstConnect = await client.callTool({
      name: "roxy_browser_connect",
      arguments: {
        endpoint: "ws://first-browser.invalid/devtools/browser/1",
        browser: "chrome"
      }
    });
    expect(firstConnect.isError).toBeUndefined();

    await client.callTool({
      name: "browser_click",
      arguments: { target: "button.upload-button" }
    });

    const blockedBeforeReconnect = await client.callTool({
      name: "browser_hover",
      arguments: { target: "button.other-action" }
    });
    expect(blockedBeforeReconnect.isError).toBe(true);
    expect(textFromResult(blockedBeforeReconnect)).toContain(
      'Tool "browser_hover" does not handle the modal state.'
    );

    const secondConnect = await client.callTool({
      name: "roxy_browser_connect",
      arguments: {
        endpoint: "ws://second-browser.invalid/session",
        browser: "firefox",
        sessionId: "session-2"
      }
    });
    expect(secondConnect.isError).toBeUndefined();
    expect(textFromResult(secondConnect)).toContain("Connected to firefox via bidi.");

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.closeCount).toBe(1);

    const hoverAfterReconnect = await client.callTool({
      name: "browser_hover",
      arguments: { target: "button.other-action" }
    });
    expect(hoverAfterReconnect.isError).toBeUndefined();

    const clickAfterReconnect = await client.callTool({
      name: "browser_click",
      arguments: { target: "e1" }
    });
    expect(clickAfterReconnect.isError).toBeUndefined();
    expect(sessions[0]!.clickCalls).toHaveLength(1);
    expect(sessions[1]!.clickCalls[0]?.target).toEqual({ nodeToken: "tab-1:node-1" });

    const tabsAfterReconnect = await client.callTool({
      name: "browser_tabs",
      arguments: { action: "list" }
    });
    const tabsText = textFromResult(tabsAfterReconnect);
    expect(tabsText).toContain("ws://second-browser.invalid/session/home");
    expect(tabsText).not.toContain("ws://first-browser.invalid/devtools/browser/1/home");
  });

  it("passes Playwright-style snapshot args through the MCP layer and can save to a file", async () => {
    const snapshotsDir = await mkdtemp(join(tmpdir(), "roxybrowser-mcp-snapshots-"));
    cleanupCallbacks.push(async () => {
      await rm(snapshotsDir, { recursive: true, force: true });
    });
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory,
      snapshotsDir
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

    const filename = "snapshot.md";
    const resolvedFilename = join(snapshotsDir, filename);

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
    expect(textFromResult(result)).toContain(`Saved snapshot to "${resolvedFilename}".`);

    const savedSnapshot = await readFile(resolvedFilename, "utf8");
    expect(savedSnapshot).toContain("[target=tab-1:node-1]");
    expect(savedSnapshot).toContain("[depth=2]");
    expect(savedSnapshot).toContain("[box=0,0,120,32]");
    // Playwright writes the raw snapshot text, without the MCP response header.
    expect(savedSnapshot).not.toContain("### Snapshot");
    expect(savedSnapshot.startsWith("- button")).toBe(true);
  });

  it("resolves relative browser_snapshot filenames into the configured snapshots dir", async () => {
    const screenshotsDir = await mkdtemp(join(tmpdir(), "roxybrowser-mcp-screenshots-"));
    const snapshotsDir = await mkdtemp(join(tmpdir(), "roxybrowser-mcp-snapshots-"));
    cleanupCallbacks.push(async () => {
      await rm(screenshotsDir, { recursive: true, force: true });
      await rm(snapshotsDir, { recursive: true, force: true });
    });

    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory,
      screenshotsDir,
      snapshotsDir
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
    const resolvedFilename = join(snapshotsDir, "nested", "snapshot.md");

    const result = await client.callTool({
      name: "browser_snapshot",
      arguments: {
        filename: relativeFilename
      }
    });

    expect(result.isError).toBeUndefined();
    expect(textFromResult(result)).toContain(`Saved snapshot to "${resolvedFilename}".`);
    expect(textFromResult(result)).not.toContain(screenshotsDir);

    const savedSnapshot = await readFile(resolvedFilename, "utf8");
    expect(savedSnapshot).toContain("- button");
  });

  it("passes unified asset roots to connected browser sessions", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "roxybrowser-mcp-artifacts-"));
    const downloadsDir = await mkdtemp(join(tmpdir(), "roxybrowser-mcp-downloads-"));
    const snapshotsDir = await mkdtemp(join(tmpdir(), "roxybrowser-mcp-snapshots-"));
    cleanupCallbacks.push(async () => {
      await rm(artifactsDir, { recursive: true, force: true });
      await rm(downloadsDir, { recursive: true, force: true });
      await rm(snapshotsDir, { recursive: true, force: true });
    });

    let capturedArgs: RoxyBrowserConnectArgs | undefined;
    const trackingFactory: BrowserSessionFactory = async (args) => {
      capturedArgs = args;
      return new FakeConnectedBrowserSession(args);
    };
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: trackingFactory,
      artifactsDir,
      downloadsDir,
      snapshotsDir
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: {
        endpoint: "ws://asset-roots.invalid/devtools/browser/1"
      }
    });

    expect(capturedArgs?.assetRoots).toMatchObject({
      artifactsDir,
      downloadsDir,
      snapshotsDir
    });
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
      const sessionSubscribe = vi.fn(async () => ({}));
      const scriptAddPreloadScript = vi.fn(async () => ({ script: "script-1" }));
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
        sessionSubscribe,
        networkAddDataCollector: vi.fn(async () => ({ collector: "collector-1" })),
        networkRemoveDataCollector: vi.fn(async () => ({})),
        scriptAddPreloadScript,
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
      expect(sessionSubscribe).toHaveBeenCalledWith(expect.objectContaining({
        events: expect.arrayContaining([
          "browsingContext.navigationStarted",
          "browsingContext.load",
          "network.beforeRequestSent",
          "network.responseStarted",
          "network.responseCompleted",
          "network.fetchError"
        ])
      }));
      expect(scriptAddPreloadScript).toHaveBeenCalledWith({
        functionDeclaration: expect.stringContaining("__roxyBubbleCursor")
      });
      expect(result.isError).toBeUndefined();
    });

    it("installs persistent cursor visualization from bare BiDi browser session connect", async () => {
      const module = await import("../../src/mcp/connectedBrowser.js");
      const scriptAddPreloadScript = vi.fn(async () => ({ script: "script-1" }));
      const scriptEvaluate = vi.fn(async (params: { expression: string }) => {
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
            value: true
          }
        };
      });
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
        scriptAddPreloadScript,
        scriptRemovePreloadScript: vi.fn(async () => ({})),
        scriptEvaluate
      }));

      setBidiClientFactoryForTests(createBidiClient);

      await module.BidiConnectedBrowserSession.connect({
        endpoint: "ws://127.0.0.1:63631/session/existing",
        browser: "firefox",
        protocol: "bidi"
      });

      expect(scriptAddPreloadScript).toHaveBeenCalledWith({
        functionDeclaration: expect.stringContaining("__roxyBubbleCursor")
      });
      expect(scriptEvaluate).toHaveBeenCalledWith(expect.objectContaining({
        expression: expect.stringContaining("__roxyBubbleCursor")
      }));
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
      expect(getSession().typeCalls[0]!.options?.strategy).toBe("sequential");
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

    it("passes the selected human profile into sequential typing", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_type",
        arguments: { target: "e1", text: "quick", human: { profile: "fast" } }
      });

      expect(getSession().typeCalls[0]!.options).toMatchObject({
        strategy: "sequential",
        varianceMs: 30
      });
      expect(getSession().typeCalls[0]!.options?.delayMs).toBeLessThanOrEqual(102);
    });

    it("keeps text under the 30 second typing budget on the sequential path", async () => {
      const { client, getSession } = await setupTrackingClient();
      const text = "x".repeat(200);

      await client.callTool({
        name: "browser_type",
        arguments: { target: "e1", text }
      });

      expect(getSession().clearCalls).toHaveLength(1);
      expect(getSession().typeCalls[0]!.options?.strategy).toBe("sequential");
    });

    it("uses fill strategy for large text without clearing character by character", async () => {
      const { client, getSession } = await setupTrackingClient();
      const text = "Large pasted paragraph. ".repeat(20);

      await client.callTool({
        name: "browser_type",
        arguments: { target: "e1", text }
      });

      expect(getSession().clearCalls).toEqual([]);
      expect(getSession().typeCalls).toEqual([{
        target: expect.objectContaining({ nodeToken: expect.any(String) }),
        text,
        options: { strategy: "fill" }
      }]);
    });

    it("submits large filled text with a real Enter key press", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_type",
        arguments: { target: "e1", text: "x".repeat(300), submit: true }
      });

      expect(getSession().typeCalls[0]!.options).toEqual({ strategy: "fill" });
      expect(getSession().pressKeyCalls).toEqual([{ key: "Enter", modifiers: undefined }]);
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

    it("uses Playwright-style direct value setter for native picker inputs while keeping hover/click", async () => {
      const { client, getSession } = await setupTrackingClient();
      getSession().formFieldMetadataByTarget.set("input[type=month]", {
        tagName: "input",
        inputType: "month"
      });

      const result = await client.callTool({
        name: "browser_fill_form",
        arguments: {
          fields: [{ target: "input[type=month]", type: "textbox", value: "2026-07", name: "Month" }]
        }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().hoverCalls).toEqual([{ selector: "input[type=month]" }]);
      expect(getSession().clickCalls).toHaveLength(1);
      expect(getSession().focusCalls).toHaveLength(0);
      expect(getSession().clearCalls).toHaveLength(0);
      expect(getSession().typeCalls).toHaveLength(0);
      expect(getSession().fillFormCalls).toEqual([[
        { target: { selector: "input[type=month]" }, type: "value", value: "2026-07" }
      ]]);
    });

    it("keeps humanized typing for normal text inputs", async () => {
      const { client, getSession } = await setupTrackingClient();
      getSession().formFieldMetadataByTarget.set("#name", {
        tagName: "input",
        inputType: "text"
      });

      await client.callTool({
        name: "browser_fill_form",
        arguments: {
          fields: [{ target: "#name", type: "textbox", value: "Ada", name: "Name" }]
        }
      });

      expect(getSession().fillFormCalls).toEqual([]);
      expect(getSession().clearCalls).toEqual([{ selector: "#name" }]);
      expect(getSession().typeCalls[0]).toMatchObject({
        target: { selector: "#name" },
        text: "Ada",
        options: { slowly: true }
      });
    });

    it("humanizes checkbox, radio, combobox, and slider fields before applying values", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_fill_form",
        arguments: {
          fields: [
            { target: "#opt-in", type: "checkbox", value: "true", name: "Opt in" },
            { target: "#blue", type: "radio", value: "true", name: "Blue" },
            { target: "#country", type: "combobox", value: "CA", name: "Country" },
            { target: "#volume", type: "slider", value: "73", name: "Volume" }
          ]
        }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().hoverCalls).toEqual([
        { selector: "#opt-in" },
        { selector: "#blue" },
        { selector: "#country" },
        { selector: "#volume" }
      ]);
      expect(getSession().clickCalls.map((call) => call.target)).toEqual([
        { selector: "#opt-in" },
        { selector: "#blue" },
        { selector: "#country" },
        { selector: "#volume" }
      ]);
      expect(getSession().checkCalls).toEqual([
        { target: { selector: "#opt-in" }, checked: true },
        { target: { selector: "#blue" }, checked: true }
      ]);
      expect(getSession().selectOptionCalls).toEqual([]);
      expect(getSession().fillFormCalls).toEqual([
        [{ target: { selector: "#country" }, type: "combobox", value: "CA" }],
        [{ target: { selector: "#volume" }, type: "slider", value: "73" }]
      ]);
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

    it("presses a key after an ordinary click without a file chooser modal", async () => {
      const { client, getSession } = await setupTrackingClient();

      const click = await client.callTool({
        name: "browser_click",
        arguments: { target: "e1" }
      });
      expect(click.isError).toBeUndefined();

      const press = await client.callTool({
        name: "browser_press_key",
        arguments: { key: "Enter" }
      });

      expect(press.isError).toBeUndefined();
      expect(textFromResult(press)).not.toContain("does not handle the modal state");
      expect(getSession().pressKeyCalls).toEqual([{ key: "Enter", modifiers: undefined }]);
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
    it("auto-saves screenshot to the screenshots dir and returns an image content item", async () => {
      const screenshotsDir = await mkdtemp(join(tmpdir(), "roxy-screenshot-auto-"));
      cleanupCallbacks.push(async () => rm(screenshotsDir, { recursive: true, force: true }));

      let capturedSession: FakeConnectedBrowserSession | undefined;
      const trackingFactory: BrowserSessionFactory = async (args) => {
        capturedSession = new FakeConnectedBrowserSession(args);
        return capturedSession;
      };

      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: trackingFactory,
        screenshotsDir
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
      expect(text).toMatch(new RegExp(`${screenshotsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.+page-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z\\.png`));
      const imageItems = (result.content as Array<{ type: string; data?: string; mimeType?: string }>)
        .filter((item) => item.type === "image");
      expect(imageItems.length).toBe(1);
      expect(imageItems[0]!.mimeType).toBe("image/png");
      expect(typeof imageItems[0]!.data).toBe("string");
      expect(capturedSession?.screenshotCount).toBe(1);
    });

    it("saves screenshot to file when filename is given", async () => {
      const screenshotsDir = await mkdtemp(join(tmpdir(), "roxy-screenshot-"));
      cleanupCallbacks.push(async () => rm(screenshotsDir, { recursive: true, force: true }));
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: fakeSessionFactory,
        screenshotsDir
      });
      cleanupCallbacks.push(async () => bundle.close());
      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { endpoint: "ws://x.invalid/1" }
      });
      const filename = "screen.png";
      const resolvedFilename = join(screenshotsDir, filename);

      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: { filename }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain(resolvedFilename);
      const saved = await readFile(resolvedFilename);
      expect(saved.length).toBeGreaterThan(0);
    });

    it("resolves relative screenshot filenames into the configured screenshots dir", async () => {
      const screenshotsDir = await mkdtemp(join(tmpdir(), "roxy-screenshot-output-"));
      cleanupCallbacks.push(async () => rm(screenshotsDir, { recursive: true, force: true }));

      let capturedSession: FakeConnectedBrowserSession | undefined;
      const trackingFactory: BrowserSessionFactory = async (args) => {
        capturedSession = new FakeConnectedBrowserSession(args);
        return capturedSession;
      };

      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: trackingFactory,
        screenshotsDir
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
      const resolvedFilename = join(screenshotsDir, "images", "screen.png");

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
      const screenshotsDir = await mkdtemp(join(tmpdir(), "roxy-screenshot-empty-"));
      cleanupCallbacks.push(async () => rm(screenshotsDir, { recursive: true, force: true }));

      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: fakeSessionFactory,
        screenshotsDir
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
      expect(text).toMatch(new RegExp(`${screenshotsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.+page-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z\\.png`));
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
      expect(getSession().waitForPageTimeoutCalls).toEqual([500, 500, 500]);
      expect(getSession().waitForRequestFinishedCalls).toEqual([{ requestId: "request-1", timeoutMs: 5_000 }]);
      expect(getSession().waitForRequestResponseCalls).toEqual([]);
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

    it("consumes a chooser target captured after clicking a non-file upload button", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_click",
        arguments: { target: "button.upload-button" }
      });

      const result = await client.callTool({
        name: "browser_file_upload",
        arguments: { paths: ["/tmp/a.pdf"] }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().uploadFileCalls[0]!.target).toEqual({ selector: "input[type=file]" });
      expect(getSession().prepareForFileUploadCalls).toEqual([{ selector: "button.upload-button" }]);
      expect(getSession().finishFileUploadCalls).toEqual([{ selector: "input[type=file]" }]);
    });

    it("keeps file chooser modal state available after clicking a non-file upload button", async () => {
      const { client } = await setupTrackingClient();

      await client.callTool({
        name: "browser_click",
        arguments: { target: "button.upload-button" }
      });

      const result = await client.callTool({
        name: "browser_hover",
        arguments: { target: "button.other-action" }
      });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain('Tool "browser_hover" does not handle the modal state.');
    });

    it("keeps file chooser modal state pending when chooser target is not captured before click returns", async () => {
      const { client, getSession } = await setupTrackingClient();
      getSession().consumePendingChooserReturnsUndefinedOnce = true;
      getSession().pendingFileChooserTarget = { selector: "input[type=file]" };

      await client.callTool({
        name: "browser_click",
        arguments: { target: "button.upload-button" }
      });

      const blocked = await client.callTool({
        name: "browser_hover",
        arguments: { target: "button.other-action" }
      });

      expect(blocked.isError).toBe(true);
      expect(textFromResult(blocked)).toContain('Tool "browser_hover" does not handle the modal state.');

      const upload = await client.callTool({
        name: "browser_file_upload",
        arguments: { paths: ["/tmp/a.pdf"] }
      });

      expect(upload.isError).toBeUndefined();
      expect(getSession().uploadFileCalls[0]!.target).toEqual({ selector: "input[type=file]" });
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

    it("cancels a pending file chooser when paths are omitted", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_click",
        arguments: { target: "input[type=file]" }
      });

      const result = await client.callTool({
        name: "browser_file_upload",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().uploadFileCalls).toEqual([]);
      expect(getSession().finishFileUploadCalls).toEqual([{ selector: "input[type=file]" }]);
      expect(textFromResult(result)).toContain("### Snapshot");

      const hover = await client.callTool({
        name: "browser_hover",
        arguments: { target: "button.after-cancel" }
      });
      expect(hover.isError).toBeUndefined();
    });

    it("cleans up request collection when upload callback fails", async () => {
      const { client, getSession } = await setupTrackingClient();
      const session = getSession();
      session.uploadFile = vi.fn(async () => {
        throw new Error("upload failed");
      });

      await client.callTool({
        name: "browser_click",
        arguments: { target: "input[type=file]" }
      });

      const result = await client.callTool({
        name: "browser_file_upload",
        arguments: { paths: ["/tmp/file.txt"] }
      });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain("upload failed");
      expect(session.requestCollectionStates.length).toBeGreaterThanOrEqual(1);
      expect(session.requestCollectionStates.at(-1)?.requests).toEqual([]);
      expect(session.finishFileUploadCalls).toEqual([{ selector: "input[type=file]" }]);
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

  describe("browser_network_request tools", () => {
    it("numbers requests by list position and resolves details by the printed number", async () => {
      const { client, getSession } = await setupTrackingClient();
      getSession().networkRequestsList.push(
        {
          index: 42,
          requestId: "request-a",
          method: "GET",
          url: "https://example.test/api/first",
          resourceType: "fetch",
          requestHeaders: { accept: "application/json" },
          status: 200,
          statusText: "OK",
          responseHeaders: { "content-type": "application/json" },
          responseBody: '{"first":true}',
          mimeType: "application/json"
        },
        {
          index: 99,
          requestId: "request-b",
          method: "POST",
          url: "https://example.test/api/second",
          resourceType: "xhr",
          requestHeaders: { "content-type": "application/json" },
          requestBody: '{"second":true}',
          status: 201,
          statusText: "Created",
          responseHeaders: { "content-type": "application/json" },
          responseBody: '{"created":true}',
          mimeType: "application/json"
        }
      );

      const list = await client.callTool({
        name: "browser_network_requests",
        arguments: {}
      });

      expect(list.isError).toBeUndefined();
      expect(textFromResult(list)).toContain("1. [GET] https://example.test/api/first => [200] OK");
      expect(textFromResult(list)).toContain("2. [POST] https://example.test/api/second => [201] Created");
      expect(textFromResult(list)).not.toContain("42. [GET]");
      expect(textFromResult(list)).not.toContain("99. [POST]");

      const details = await client.callTool({
        name: "browser_network_request",
        arguments: { index: 1 }
      });

      expect(details.isError).toBeUndefined();
      expect(textFromResult(details)).toContain("#1 [GET] https://example.test/api/first");
      expect(textFromResult(details)).not.toContain("#42 [GET]");
    });

    it("returns response bodies using the printed request number", async () => {
      const { client, getSession } = await setupTrackingClient();
      getSession().networkRequestsList.push({
        index: 42,
        requestId: "request-a",
        method: "GET",
        url: "https://example.test/api/first",
        resourceType: "fetch",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: { "content-type": "application/json" },
        responseBody: '{"first":true}'
      });

      const result = await client.callTool({
        name: "browser_network_request",
        arguments: { index: 1, part: "response-body" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toBe('{"first":true}');
    });
  });

  describe("browser_run_code_unsafe", () => {
    it("loads code from filename", async () => {
      const { client } = await setupTrackingClient();
      const dir = await mkdtemp(join(tmpdir(), "roxy-run-code-"));
      cleanupCallbacks.push(async () => rm(dir, { recursive: true, force: true }));
      const filename = join(dir, "snippet.js");
      await writeFile(filename, "async page => page.url()", "utf8");

      const result = await client.callTool({
        name: "browser_run_code_unsafe",
        arguments: { filename }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain('"ran:async page => page.url()"');
    });

    it("prefers filename over inline code", async () => {
      const { client } = await setupTrackingClient();
      const dir = await mkdtemp(join(tmpdir(), "roxy-run-code-"));
      cleanupCallbacks.push(async () => rm(dir, { recursive: true, force: true }));
      const filename = join(dir, "snippet.js");
      await writeFile(filename, "async page => 'from-file'", "utf8");

      const result = await client.callTool({
        name: "browser_run_code_unsafe",
        arguments: {
          code: "async page => 'inline'",
          filename
        }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("\"ran:async page => 'from-file'\"");
    });

    it("requires either code or filename", async () => {
      const { client } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_run_code_unsafe",
        arguments: {}
      });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain("Either code or filename is required");
    });
  });

  describe("waitForCompletion parity", () => {
    it("waits for main frame load when a navigation request is collected", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: async (args) => new NavigationRequestSession(args)
      });
      const client = createClient("navigation-wait-client");
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { protocol: "cdp", endpoint: "https://example.test" }
      });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "button.navigate" }
      });

      const session = bundle.runtimeManager.getRuntime(bundle.getLastSessionId?.()).requireConnected() as NavigationRequestSession;
      expect(result.isError).toBeUndefined();
      expect(session.waitForMainFrameLoadCalls).toEqual([10_000]);
      expect(session.waitForRequestFinishedCalls).toEqual([]);
      expect(session.waitForRequestResponseCalls).toEqual([]);

      await client.close();
      await bundle.close();
    });

    it("waits for request response for non fetch-like resources", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: async (args) => new ImageRequestSession(args)
      });
      const client = createClient("image-wait-client");
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { protocol: "cdp", endpoint: "https://example.test" }
      });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "button.image" }
      });

      const session = bundle.runtimeManager.getRuntime(bundle.getLastSessionId?.()).requireConnected() as ImageRequestSession;
      expect(result.isError).toBeUndefined();
      expect(session.waitForPageTimeoutCalls).toEqual([500, 500]);
      expect(session.waitForRequestFinishedCalls).toEqual([]);
      expect(session.waitForRequestResponseCalls).toEqual([{ requestId: "request-1", timeoutMs: 5_000 }]);

      await client.close();
      await bundle.close();
    });

    it("does not treat every document resource as a navigation request", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: async (args) => new DocumentButNotNavigationSession(args)
      });
      const client = createClient("document-non-navigation-wait-client");
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { protocol: "cdp", endpoint: "https://example.test" }
      });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "button.frame-doc" }
      });

      const session = bundle.runtimeManager.getRuntime(bundle.getLastSessionId?.()).requireConnected() as DocumentButNotNavigationSession;
      expect(result.isError).toBeUndefined();
      expect(session.waitForMainFrameLoadCalls).toEqual([]);
      expect(session.waitForRequestFinishedCalls).toEqual([{ requestId: "request-1", timeoutMs: 5_000 }]);

      await client.close();
      await bundle.close();
    });

    it("keeps redirect hops as separate collected requests like Playwright request events", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: async (args) => new RedirectRequestSession(args)
      });
      const client = createClient("redirect-wait-client");
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { protocol: "cdp", endpoint: "https://example.test" }
      });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "button.redirect" }
      });

      const session = bundle.runtimeManager.getRuntime(bundle.getLastSessionId?.()).requireConnected() as RedirectRequestSession;
      expect(result.isError).toBeUndefined();
      expect(session.requestCollectionStates.at(-1)?.requestKeys).toEqual(["request-1#1", "request-1#2"]);
      expect(session.networkRequestsList.map((request) => ({
        requestId: request.requestId,
        requestKey: request.requestKey,
        redirectedFromRequestKey: request.redirectedFromRequestKey,
        redirectedToRequestKey: request.redirectedToRequestKey,
        finalRequestKey: request.finalRequestKey,
        url: request.url,
        status: request.status
      }))).toEqual([
        {
          requestId: "request-1",
          requestKey: "request-1#1",
          redirectedFromRequestKey: undefined,
          redirectedToRequestKey: "request-1#2",
          finalRequestKey: "request-1#2",
          url: "https://example.test/start",
          status: 302
        },
        {
          requestId: "request-1",
          requestKey: "request-1#2",
          redirectedFromRequestKey: "request-1#1",
          redirectedToRequestKey: undefined,
          finalRequestKey: "request-1#2",
          url: "https://example.test/final",
          status: 200
        }
      ]);
      expect(session.waitForMainFrameLoadCalls).toEqual([10_000]);
      expect(session.waitForRequestFinishedCalls).toEqual([]);
      expect(session.waitForRequestResponseCalls).toEqual([]);

      await client.close();
      await bundle.close();
    });

    it("observes the final collected request state like Playwright Request objects", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: async (args) => new UpdatingRequestSession(args)
      });
      const client = createClient("updating-request-wait-client");
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { protocol: "cdp", endpoint: "https://example.test" }
      });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "button.updating" }
      });

      const session = bundle.runtimeManager.getRuntime(bundle.getLastSessionId?.()).requireConnected() as UpdatingRequestSession;
      expect(result.isError).toBeUndefined();
      expect(session.requestCollectionStates.at(-1)?.requestKeys).toEqual(["request-1"]);
      expect(session.requestCollectionStates.at(-1)?.requests).toEqual([]);
      expect(session.waitForRequestFinishedCalls).toEqual([{ requestId: "request-1", timeoutMs: 5_000 }]);
      const collected = session.networkRequestsList[0];
      expect(collected).toMatchObject({
        requestId: "request-1",
        status: 200,
        statusText: "OK",
        responseHeaders: { "content-type": "application/json" },
        responseBody: '{"ok":true}'
      });

      await client.close();
      await bundle.close();
    });

    it("collects requests that begin during the post-action 500ms window like Playwright", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: async (args) => new DelayedPostActionRequestSession(args)
      });
      const client = createClient("delayed-post-action-request-client");
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { protocol: "cdp", endpoint: "https://example.test" }
      });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "button.delayed-request" }
      });

      const session = bundle.runtimeManager.getRuntime(bundle.getLastSessionId?.()).requireConnected() as DelayedPostActionRequestSession;
      expect(result.isError).toBeUndefined();
      expect(session.requestCollectionStates.at(-1)?.requestKeys).toEqual(["request-1"]);
      expect(session.waitForRequestFinishedCalls).toEqual([{ requestId: "request-1", timeoutMs: 5_000 }]);
      expect(session.waitForRequestResponseCalls).toEqual([]);

      await client.close();
      await bundle.close();
    });

    it("propagates beginRequestCollection failures like Playwright listener setup failures", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: async (args) => new BeginRequestCollectionFailureSession(args)
      });
      const client = createClient("begin-request-collection-failure-client");
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { protocol: "cdp", endpoint: "https://example.test" }
      });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "button.begin-failure" }
      });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain("begin request collection failed");

      await client.close();
      await bundle.close();
    });

    it("propagates the post-action 500ms wait failure like Playwright", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: async (args) => new PostActionQuietWindowFailureSession(args)
      });
      const client = createClient("post-action-quiet-window-failure-client");
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { protocol: "cdp", endpoint: "https://example.test" }
      });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "button.quiet-window-failure" }
      });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain("post-action quiet window failed");

      await client.close();
      await bundle.close();
    });

    it("propagates endRequestCollection failures from cleanup like Playwright finally cleanup", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: async (args) => new EndRequestCollectionFailureSession(args)
      });
      const client = createClient("end-request-collection-failure-client");
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { protocol: "cdp", endpoint: "https://example.test" }
      });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "button.end-failure" }
      });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain("end request collection failed");

      await client.close();
      await bundle.close();
    });

    it("keeps raw header patching aligned to redirect hop order", async () => {
      const firstResponseHeaders = { location: "https://example.test/final" };
      const secondResponseHeaders = { contentType: "text/html" };
      const first: BrowserNetworkRequest = {
        index: 1,
        requestId: "request-redirect",
        requestKey: "request-redirect#1",
        method: "GET",
        url: "https://example.test/start",
        resourceType: "document",
        isNavigationRequest: true,
        requestHeaders: { accept: "text/html" },
        responseHeaders: firstResponseHeaders,
        rawResponseHeaders: firstResponseHeaders,
        status: 302,
        statusText: "Found"
      };
      const second: BrowserNetworkRequest = {
        index: 2,
        requestId: "request-redirect",
        requestKey: "request-redirect#2",
        method: "GET",
        url: "https://example.test/final",
        resourceType: "document",
        isNavigationRequest: true,
        requestHeaders: { accept: "text/html" },
        responseHeaders: secondResponseHeaders,
        rawResponseHeaders: secondResponseHeaders,
        status: 200,
        statusText: "OK"
      };

      const requestsByRequestId = new Map<string, BrowserNetworkRequest[]>();
      requestsByRequestId.set("request-redirect", [first, second]);

      const rawRequestTarget = (requestsByRequestId.get("request-redirect") ?? []).find((request) => request.rawRequestHeaders === undefined);
      expect(rawRequestTarget?.requestKey).toBe("request-redirect#1");
      rawRequestTarget!.rawRequestHeaders = { cookie: "a=1" };
      const nextRawRequestTarget = (requestsByRequestId.get("request-redirect") ?? []).find((request) => request.rawRequestHeaders === undefined);
      expect(nextRawRequestTarget?.requestKey).toBe("request-redirect#2");

      const rawResponseTarget = (requestsByRequestId.get("request-redirect") ?? []).find(
        (request) => request.responseHeaders !== undefined && request.rawResponseHeaders === request.responseHeaders
      );
      expect(rawResponseTarget?.requestKey).toBe("request-redirect#1");
      rawResponseTarget!.rawResponseHeaders = { location: "https://example.test/final", server: "edge" };
      const nextRawResponseTarget = (requestsByRequestId.get("request-redirect") ?? []).find(
        (request) => request.responseHeaders !== undefined && request.rawResponseHeaders === request.responseHeaders
      );
      expect(nextRawResponseTarget?.requestKey).toBe("request-redirect#2");
    });

    it("does not wait for the full timeout once the session closes", async () => {
      vi.useFakeTimers();
      try {
        const bundle = await createRoxyBrowserMcpInMemory({
          sessionFactory: async (args) => new PendingRequestUntilCloseSession(args)
        });
        const client = createClient("close-interrupts-wait-client");
        await client.connect(bundle.clientTransport);
        await client.callTool({
          name: "roxy_browser_connect",
          arguments: { protocol: "cdp", endpoint: "https://example.test" }
        });

        const clickPromise = client.callTool({
          name: "browser_click",
          arguments: { target: "button.pending" }
        });

        await Promise.resolve();
        await Promise.resolve();
        const session = bundle.runtimeManager.getRuntime(bundle.getLastSessionId?.()).requireConnected() as PendingRequestUntilCloseSession;
        await session.close();
        await vi.runAllTimersAsync();

        const result = await clickPromise;
        expect(result.isError).toBeUndefined();
        await client.close().catch(() => undefined);
        await bundle.close();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
