import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PingRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createRoxyBrowserMcpInMemory, createRoxyBrowserMcpServer, startRoxyBrowserMcpHttp, startRoxyBrowserMcpStdio } from "../../src/mcp/index.js";
import { defineTool as defineBackendTool } from "../../src/mcp/backend/tool.js";
import { resetBidiClientFactoryForTests, setBidiClientFactoryForTests } from "../../src/protocol/bidi/client.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserSessionFactory,
  BrowserConsoleEntry,
  BrowserCookie,
  BrowserNetworkRequest,
  BrowserNetworkResponseBody,
  BrowserSnapshot,
  BrowserSnapshotRequest,
  BrowserTab,
  ClickTarget,
  ConnectedBrowserSession,
  RoxyBrowserConnectArgs,
  RoxyBrowserLaunchClient,
  SessionClickOptions,
  SessionDragOptions,
  SessionDropOptions,
  SessionFormField,
  SessionScreenshotOptions,
  BrowserNetworkRoute,
  SessionTypeOptions
} from "../../src/mcp/index.js";
import type { CreateRoxyBrowserMcpServerOptions } from "../../src/mcp/types.js";
import type { BrowserContextOptions } from "../../src/types/options.js";


class FakeConnectedBrowserSession implements ConnectedBrowserSession {
  readonly browserName: "chromium" | "firefox";
  readonly protocol: "cdp" | "bidi";
  private tabs: BrowserTab[];
  private nextTabId = 2;
  private dialogOpen = false;
  private contentHtml = "";
  private globals = new Map<string, unknown>();

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
    this.applyConsoleLevel(args.consoleLevel);
  }

  private applyConsoleLevel(level: "error" | "warning" | "info" | "debug" | undefined): void {
    this.consoleLevel = level ?? "info";
    this.consoleMessagesList = this.consoleMessagesList.filter(
      (message) => consoleLevelForTest(message.type) <= consoleLevelForTest(this.consoleLevel)
    );
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
    const text = this.contentHtml
      ? `- text "${this.contentHtml.replace(/<[^>]*>/g, "")}" [ref=e1]${targetSuffix}${depthSuffix}${boxSuffix}`
      : `- button "${activeTab?.title ?? "Action"}" [ref=e1]${targetSuffix}${depthSuffix}${boxSuffix}`;
    return {
      title: activeTab?.title ?? "",
      url: activeTab?.url ?? "",
      text,
      refs: {
        e1: `${activeTab?.id ?? "tab"}:node-1`
      }
    };
  }

  async ariaSnapshot(request: BrowserSnapshotRequest = {}): Promise<string> {
    return (await this.snapshot(request)).text;
  }

  clickCalls: Array<{ target: ClickTarget; options: SessionClickOptions }> = [];
  hoverCalls: Array<ClickTarget> = [];
  focusCalls: Array<ClickTarget> = [];
  clearCalls: Array<ClickTarget> = [];
  navigateCalls: string[] = [];
  typeCalls: Array<{ target: ClickTarget; text: string; options?: SessionTypeOptions }> = [];
  keyboardTypeCalls: string[] = [];
  keyDownCalls: string[] = [];
  keyUpCalls: string[] = [];
  pressKeyCalls: Array<{ key: string; modifiers?: string[] }> = [];
  pressCalls: Array<{ target: ClickTarget; key: string; options?: SessionTypeOptions }> = [];
  dragCalls: Array<{ start: ClickTarget; end: ClickTarget; options: SessionDragOptions }> = [];
  mouseMoveCalls: Array<{ x: number; y: number; options?: { moveDelayMs?: number } }> = [];
  mouseClickCalls: Array<{
    x: number;
    y: number;
    options: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
      delay?: number;
      moveDelayMs?: number;
    };
  }> = [];
  mouseDragCalls: Array<{ startX: number; startY: number; endX: number; endY: number; options: SessionDragOptions }> = [];
  dropCalls: Array<{ target: ClickTarget; payload: SessionDropOptions }> = [];
  selectOptionCalls: Array<{ target: ClickTarget; values: string[] }> = [];
  checkCalls: Array<{ target: ClickTarget; checked: boolean }> = [];
  goBackCount = 0;
  goForwardCount = 0;
  reloadCount = 0;
  resizeCalls: Array<{ width: number; height: number }> = [];
  emulateContextCalls: BrowserContextOptions[] = [];
  scrollCalls: Array<{
    target: ClickTarget | null;
    deltaX: number;
    deltaY: number;
    options?: { stepPx: number; stepDelayMs: number };
  }> = [];
  screenshotCount = 0;
  screenshotCalls: SessionScreenshotOptions[] = [];
  pdfCalls = 0;
  uploadFileCalls: Array<{ target: ClickTarget; paths: string[] }> = [];
  prepareForFileUploadCalls: ClickTarget[] = [];
  finishFileUploadCalls: ClickTarget[] = [];
  waitForPageTimeoutCalls: number[] = [];
  waitForMainFrameLoadCalls: number[] = [];
  waitForRequestFinishedCalls: Array<{ requestId: string; timeoutMs: number }> = [];
  waitForRequestResponseCalls: Array<{ requestId: string; timeoutMs: number }> = [];
  offlineCalls: boolean[] = [];
  routeList: BrowserNetworkRoute[] = [];
  fillFormCalls: SessionFormField[][] = [];
  formFieldMetadataByTarget = new Map<string, { tagName: string; inputType?: string; isContentEditable?: boolean }>();
  pendingFileChooserTarget: ClickTarget | undefined;
  consumePendingChooserReturnsUndefinedOnce = false;
  networkRequestsList: BrowserNetworkRequest[] = [];
  cookiesList: BrowserCookie[] = [];
  addCookiesCalls: Array<Partial<BrowserCookie> & { name: string; value: string }> = [];
  clearCookiesCalls: Array<{ domain?: string | RegExp; name?: string | RegExp; path?: string | RegExp } | undefined> = [];
  localStorageItemsList: Array<{ name: string; value: string }> = [];
  sessionStorageItemsList: Array<{ name: string; value: string }> = [];
  setWebStorageItemCalls: Array<{ storageName: "localStorage" | "sessionStorage"; key: string; value: string }> = [];
  removeWebStorageItemCalls: Array<{ storageName: "localStorage" | "sessionStorage"; key: string }> = [];
  clearWebStorageCalls: Array<{ storageName: "localStorage" | "sessionStorage" }> = [];
  requestCollectionStates: Array<{ requests: BrowserNetworkRequest[]; requestKeys: string[] }> = [];
  consoleMessagesList: BrowserConsoleEntry[] = [{
    type: "log",
    text: "hello",
    timestamp: Date.now(),
    formattedText: "[LOG] hello @ :0"
  }];
  consoleLevel: "error" | "warning" | "info" | "debug" = "info";
  closeCount = 0;
  cursorVisualizationCount = 0;

  protected collectRequest(request: BrowserNetworkRequest): void {
    for (const collector of this.requestCollectionStates) {
      collector.requestKeys.push(request.requestKey ?? request.requestId);
    }
  }

  async consoleMessages(level: "error" | "warning" | "info" | "debug" = "info") {
    return this.consoleMessagesList
      .filter((message) => consoleLevelForTest(message.type) <= consoleLevelForTest(level))
      .map((message) => ({ ...message }));
  }

  async consoleMessageSummary() {
    return {
      total: this.consoleMessagesList.length,
      errors: this.consoleMessagesList.filter((message) => message.type === "error" || message.type === "assert").length,
      warnings: this.consoleMessagesList.filter((message) => message.type === "warning").length
    };
  }

  async clearConsoleMessages(): Promise<void> {
    this.consoleMessagesList = [];
  }

  async evaluate(expression: string): Promise<unknown> {
    const isFunction = !expression.startsWith("(") || expression.includes("=>");
    const globalRead = expression.match(/window\.(\w+)/);
    const consoleLog = expression.match(/console\.log\((['"])(.*?)\1\)/);
    if (consoleLog) {
      this.consoleMessagesList.push({
        type: "log",
        text: consoleLog[2]!,
        timestamp: Date.now(),
        formattedText: `[LOG] ${consoleLog[2]!} @ :0`
      });
    }
    return {
      result: globalRead && this.globals.has(globalRead[1]!)
        ? this.globals.get(globalRead[1]!)
        : isFunction ? `evaluated:${expression}` : 2,
      isFunction
    };
  }

  async setContent(html: string): Promise<void> {
    this.contentHtml = html;
  }

  async countByRole(role: string, accessibleName: string): Promise<number> {
    return role === "button" && accessibleName === `${this.args.endpoint} home` ? 1 : 0;
  }

  async textContentsByText(text: string, options: { target?: ClickTarget; visible?: boolean } = {}): Promise<string[]> {
    const root = options.target
      ? ("selector" in options.target ? options.target.selector : options.target.nodeToken)
      : `${this.args.endpoint} home`;
    if (text === "") {
      return [root];
    }
    if (`${root} home Apples Bananas Cherries`.toLowerCase().includes(text.toLowerCase())) {
      return [text];
    }
    return [];
  }

  async textContent(target: ClickTarget): Promise<string | null> {
    return "selector" in target ? target.selector : target.nodeToken;
  }

  async inputValue(target: ClickTarget): Promise<string> {
    const targetValue = "selector" in target ? target.selector : target.nodeToken;
    return targetValue.includes("email") ? "user@example.test" : targetValue;
  }

  async isChecked(target: ClickTarget): Promise<boolean> {
    const targetValue = "selector" in target ? target.selector : target.nodeToken;
    return targetValue.includes("checked");
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

  initScriptCalls: string[] = [];

  async addInitScript(source: string): Promise<void> {
    this.initScriptCalls.push(source);
    const assignment = source.match(/window\.(\w+)\s*=\s*(true|false);?/);
    if (assignment) {
      this.globals.set(assignment[1]!, assignment[2] === "true");
    }
    const consoleLog = source.match(/console\.log\((['"])(.*?)\1\);?/);
    if (consoleLog) {
      this.consoleMessagesList.push({
        type: "log",
        text: consoleLog[2]!,
        timestamp: Date.now(),
        formattedText: `[LOG] ${consoleLog[2]!} @ :0`
      });
    }
  }

  async type(target: ClickTarget, text: string, options?: SessionTypeOptions): Promise<void> {
    this.typeCalls.push({ target, text, options });
  }

  async typeKeyboard(text: string): Promise<void> {
    this.keyboardTypeCalls.push(text);
  }

  async keyDown(key: string): Promise<void> {
    this.keyDownCalls.push(key);
  }

  async keyUp(key: string): Promise<void> {
    this.keyUpCalls.push(key);
  }

  async pressKey(key: string, modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">): Promise<void> {
    this.pressKeyCalls.push({ key, modifiers });
  }

  async press(target: ClickTarget, key: string, options?: SessionTypeOptions): Promise<void> {
    this.pressCalls.push({ target, key, options });
  }

  async drag(start: ClickTarget, end: ClickTarget, options: SessionDragOptions): Promise<void> {
    this.dragCalls.push({ start, end, options });
  }

  async mouseMove(x: number, y: number, options?: { moveDelayMs?: number }): Promise<void> {
    this.mouseMoveCalls.push({ x, y, options });
  }

  async mouseClick(
    x: number,
    y: number,
    options: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
      delay?: number;
      moveDelayMs?: number;
    }
  ): Promise<void> {
    this.mouseClickCalls.push({ x, y, options });
  }

  async mouseDrag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    options: SessionDragOptions
  ): Promise<void> {
    this.mouseDragCalls.push({ startX, startY, endX, endY, options });
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

  async reload(): Promise<void> {
    this.reloadCount++;
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
    this.resizeCalls.push({ width, height });
    const activeTab = this.tabs.find((tab) => tab.active);
    if (activeTab) {
      activeTab.title = `${width}x${height}`;
    }
  }

  async emulateContext(options: BrowserContextOptions): Promise<void> {
    this.emulateContextCalls.push(options);
    if (options.viewport) {
      const activeTab = this.tabs.find((tab) => tab.active);
      if (activeTab) {
        activeTab.title = `${options.viewport.width}x${options.viewport.height}`;
      }
    }
  }

  async screenshot(options: SessionScreenshotOptions = {}): Promise<{ data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }> {
    this.screenshotCount++;
    this.screenshotCalls.push(options);
    const type = options.type ?? "png";
    return {
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      mimeType: type === "jpeg" ? "image/jpeg" : type === "webp" ? "image/webp" : "image/png"
    };
  }

  async pdf(): Promise<Buffer> {
    this.pdfCalls++;
    return Buffer.from("%PDF-fake");
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

  async clearRequests(): Promise<void> {
    this.networkRequestsList = [];
  }

  async setOffline(offline: boolean): Promise<void> {
    this.offlineCalls.push(offline);
  }

  async addRoute(route: BrowserNetworkRoute): Promise<void> {
    this.routeList.push({ ...route });
  }

  async routes(): Promise<BrowserNetworkRoute[]> {
    return this.routeList.map((route) => ({ ...route }));
  }

  async removeRoute(pattern?: string): Promise<number> {
    const previousLength = this.routeList.length;
    this.routeList = pattern === undefined
      ? []
      : this.routeList.filter((route) => route.pattern !== pattern);
    return previousLength - this.routeList.length;
  }

  async cookies(): Promise<BrowserCookie[]> {
    return this.cookiesList.map((cookie) => ({ ...cookie }));
  }

  async addCookies(cookies: Array<Partial<BrowserCookie> & { name: string; value: string }>): Promise<void> {
    this.addCookiesCalls.push(...cookies.map((cookie) => ({ ...cookie })));
    for (const cookie of cookies) {
      const stored: BrowserCookie = {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain ?? "tools-test.invalid",
        path: cookie.path ?? "/",
        expires: cookie.expires ?? -1,
        httpOnly: cookie.httpOnly ?? false,
        secure: cookie.secure ?? false,
        sameSite: cookie.sameSite ?? "Lax",
        ...(cookie.partitionKey !== undefined ? { partitionKey: cookie.partitionKey } : {})
      };
      const existingIndex = this.cookiesList.findIndex((candidate) =>
        candidate.name === stored.name &&
        candidate.domain === stored.domain &&
        candidate.path === stored.path
      );
      if (existingIndex >= 0) {
        this.cookiesList[existingIndex] = stored;
      } else {
        this.cookiesList.push(stored);
      }
    }
  }

  async clearCookies(options?: { domain?: string | RegExp; name?: string | RegExp; path?: string | RegExp }): Promise<void> {
    this.clearCookiesCalls.push(options);
    if (!options?.domain && !options?.name && !options?.path) {
      this.cookiesList = [];
      return;
    }
    this.cookiesList = this.cookiesList.filter((cookie) => !cookieMatchesFilter(cookie, options));
  }

  async webStorageItems(storageName: "localStorage" | "sessionStorage"): Promise<Array<{ name: string; value: string }>> {
    return storageName === "localStorage"
      ? this.localStorageItemsList.map((item) => ({ ...item }))
      : this.sessionStorageItemsList.map((item) => ({ ...item }));
  }

  async setWebStorageItem(storageName: "localStorage" | "sessionStorage", key: string, value: string): Promise<void> {
    this.setWebStorageItemCalls.push({ storageName, key, value });
    const items = storageName === "localStorage" ? this.localStorageItemsList : this.sessionStorageItemsList;
    const existingIndex = items.findIndex((item) => item.name === key);
    const item = { name: key, value };
    if (existingIndex >= 0) {
      items[existingIndex] = item;
    } else {
      items.push(item);
    }
  }

  async removeWebStorageItem(storageName: "localStorage" | "sessionStorage", key: string): Promise<void> {
    this.removeWebStorageItemCalls.push({ storageName, key });
    if (storageName === "localStorage") {
      this.localStorageItemsList = this.localStorageItemsList.filter((item) => item.name !== key);
    } else {
      this.sessionStorageItemsList = this.sessionStorageItemsList.filter((item) => item.name !== key);
    }
  }

  async clearWebStorage(storageName: "localStorage" | "sessionStorage"): Promise<void> {
    this.clearWebStorageCalls.push({ storageName });
    if (storageName === "localStorage") {
      this.localStorageItemsList = [];
    } else {
      this.sessionStorageItemsList = [];
    }
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

  async fetchResponseBody(index: number): Promise<BrowserNetworkResponseBody | undefined> {
    const request = await this.networkRequest(index);
    if (!request) {
      return undefined;
    }
    return {
      ...(request.responseBody !== undefined ? { text: request.responseBody } : {}),
      ...(request.responseBodyBase64 !== undefined ? { base64: request.responseBodyBase64 } : {})
    };
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

function cookieMatchesFilter(
  cookie: BrowserCookie,
  filter: { domain?: string | RegExp; name?: string | RegExp; path?: string | RegExp }
): boolean {
  return (
    (filter.domain === undefined || stringOrRegexMatches(cookie.domain, filter.domain)) &&
    (filter.name === undefined || stringOrRegexMatches(cookie.name, filter.name)) &&
    (filter.path === undefined || stringOrRegexMatches(cookie.path, filter.path))
  );
}

function stringOrRegexMatches(value: string, matcher: string | RegExp): boolean {
  return typeof matcher === "string" ? value === matcher : matcher.test(value);
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

class SecretConsoleSession extends FakeConnectedBrowserSession {
  override async consoleMessages() {
    return [{
      type: "log",
      text: "hello password123",
      timestamp: Date.now(),
      formattedText: "[LOG] hello password123 @ :0"
    }];
  }
}

class Non2xxNavigationStatusSession extends FakeConnectedBrowserSession {
  override async snapshot(request: BrowserSnapshotRequest = {}): Promise<BrowserSnapshot> {
    return {
      ...await super.snapshot(request),
      mainDocumentStatus: {
        status: 402,
        statusText: "Payment Required"
      }
    };
  }
}

class TestIdLocatorSnapshotSession extends FakeConnectedBrowserSession {
  override async snapshot(_request: BrowserSnapshotRequest = {}): Promise<BrowserSnapshot> {
    const snapshot = await super.snapshot(_request);
    return {
      ...snapshot,
      text: '- button "Submit" [ref=e1]',
      locators: {
        e1: "getByTestId('submit')"
      }
    };
  }
}

class Final2xxNavigationStatusSession extends FakeConnectedBrowserSession {
  override async snapshot(request: BrowserSnapshotRequest = {}): Promise<BrowserSnapshot> {
    return {
      ...await super.snapshot(request),
      mainDocumentStatus: {
        status: 200,
        statusText: "OK"
      }
    };
  }
}

class DownloadEventsSnapshotSession extends FakeConnectedBrowserSession {
  override async snapshot(request: BrowserSnapshotRequest = {}): Promise<BrowserSnapshot> {
    return {
      ...await super.snapshot(request),
      events: [
        { type: "download-start", filename: "test.txt" },
        { type: "download-finish", filename: "test.txt", path: "output/test.txt" }
      ]
    };
  }
}

class ConsoleAndDownloadEventsSnapshotSession extends FakeConnectedBrowserSession {
  override async snapshot(request: BrowserSnapshotRequest = {}): Promise<BrowserSnapshot> {
    return {
      ...await super.snapshot(request),
      consoleLink: "/tmp/console.log",
      events: [
        { type: "download-start", filename: "test.txt" }
      ]
    };
  }
}

class FindAriaSnapshotSession extends FakeConnectedBrowserSession {
  snapshotCount = 0;
  ariaSnapshotCount = 0;

  override async snapshot(request: BrowserSnapshotRequest = {}): Promise<BrowserSnapshot> {
    this.snapshotCount += 1;
    return {
      ...await super.snapshot(request),
      text: '- button "Runtime Snapshot" [ref=e1]'
    };
  }

  override async ariaSnapshot(_request: BrowserSnapshotRequest = {}): Promise<string> {
    this.ariaSnapshotCount += 1;
    return '- button "Aria Snapshot" [ref=e1]';
  }
}

const playwrightMcpFindListSnapshot = [
  '- heading "Groceries" [ref=e1]',
  "- list [ref=e2]:",
  '  - listitem [ref=e3]: Apples',
  '  - listitem [ref=e4]: Bananas',
  '  - listitem [ref=e5]: Cherries',
  '- button "Add to cart" [ref=e6]'
].join("\n");

class PlaywrightMcpFindListSession extends FakeConnectedBrowserSession {
  override async snapshot(): Promise<BrowserSnapshot> {
    return {
      title: "Groceries",
      url: "https://example.test/groceries",
      text: playwrightMcpFindListSnapshot,
      refs: {
        e1: "node-heading",
        e2: "node-list",
        e3: "node-apples",
        e4: "node-bananas",
        e5: "node-cherries",
        e6: "node-add"
      }
    };
  }
}

const playwrightMcpFindNestedSnapshot = [
  "  - main [ref=e2]:",
  '    - region "Sidebar" [ref=e3]:',
  '      - navigation "Primary" [ref=e4]:',
  "        - list [ref=e5]:",
  "          - listitem [ref=e6]:",
  '            - link "Home" [ref=e7]',
  "          - listitem [ref=e8]:",
  '            - link "Products" [ref=e9]',
  "          - listitem [ref=e10]:",
  '            - link "About" [ref=e11]',
  "          - listitem [ref=e12]:",
  '            - link "Contact" [ref=e13]',
  "          - listitem [ref=e14]:",
  '            - link "Careers" [ref=e15]',
  "          - listitem [ref=e16]:",
  '            - link "Deep Target Link" [ref=e17]'
].join("\n");

class PlaywrightMcpFindNestedSession extends FakeConnectedBrowserSession {
  override async snapshot(): Promise<BrowserSnapshot> {
    return {
      title: "Nested",
      url: "https://example.test/nested",
      text: playwrightMcpFindNestedSnapshot,
      refs: {
        e2: "node-main",
        e3: "node-sidebar",
        e4: "node-primary",
        e5: "node-list",
        e6: "node-li-home",
        e7: "node-home",
        e8: "node-li-products",
        e9: "node-products",
        e10: "node-li-about",
        e11: "node-about",
        e12: "node-li-contact",
        e13: "node-contact",
        e14: "node-li-careers",
        e15: "node-careers",
        e16: "node-li-target",
        e17: "node-target"
      }
    };
  }
}

const playwrightMcpFindToolbarSnapshot = [
  "  - main [ref=e2]:",
  '    - group "Toolbar" [ref=e3]:',
  '      - button "One" [ref=e4]',
  '      - button "Two" [ref=e5]',
  '      - button "Three" [ref=e6]',
  '      - button "Four" [ref=e7]',
  '    - group "Content" [ref=e8]:',
  '      - button "Target Button" [ref=e9]'
].join("\n");

class PlaywrightMcpFindToolbarSession extends FakeConnectedBrowserSession {
  override async snapshot(): Promise<BrowserSnapshot> {
    return {
      title: "Toolbar",
      url: "https://example.test/toolbar",
      text: playwrightMcpFindToolbarSnapshot,
      refs: {
        e2: "node-main",
        e3: "node-toolbar",
        e4: "node-one",
        e5: "node-two",
        e6: "node-three",
        e7: "node-four",
        e8: "node-content",
        e9: "node-target"
      }
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

function consoleLevelForTest(type: string): number {
  if (type === "error" || type === "assert") return 0;
  if (type === "warning") return 1;
  if (type === "debug") return 3;
  return 2;
}

async function httpGetWithHost(
  port: number,
  pathname: string,
  hostHeader: string
): Promise<{ statusCode: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: "GET",
      headers: {
        Host: hostHeader
      }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

const cleanupCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  delete process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS;
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
      "browser_find",
      "browser_get_config",
      "browser_handle_dialog",
      "browser_hover",
      "browser_navigate",
      "browser_navigate_back",
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
    expect(names).not.toContain("browser_console_clear");
    expect(names).not.toContain("browser_cookie_list");
    expect(names).not.toContain("browser_generate_locator");
    expect(names).not.toContain("browser_network_clear");
    expect(names).not.toContain("browser_network_state_set");
    expect(names).not.toContain("browser_route");
    expect(names).not.toContain("browser_route_list");
    expect(names).not.toContain("browser_unroute");
    expect(names).not.toContain("browser_navigate_forward");
    expect(names).not.toContain("browser_reload");
    expect(names).not.toContain("browser_start_tracing");
    expect(names).not.toContain("browser_stop_tracing");
    expect(names).not.toContain("browser_set_storage_state");
    expect(names).not.toContain("browser_storage_state");
  });

  it("forwards the MCP request AbortSignal to backend tool handlers", async () => {
    let receivedSignal: AbortSignal | undefined;
    const signalTool = defineBackendTool({
      capability: "core",
      schema: {
        name: "test_signal_forwarding",
        title: "Test signal forwarding",
        description: "Test signal forwarding",
        inputSchema: z.object({}),
        type: "readOnly"
      },
      handle: async (_context, _params, response, signal) => {
        receivedSignal = signal;
        response.addTextResult(signal ? "signal-received" : "signal-missing");
      }
    });
    const bundle = createRoxyBrowserMcpServer(
      { sessionFactory: fakeSessionFactory },
      { extraBackendTools: [signalTool] }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await bundle.server.connect(serverTransport);
    const client = createClient();
    await client.connect(clientTransport);

    const controller = new AbortController();
    const result = await client.callTool(
      { name: "test_signal_forwarding", arguments: {} },
      undefined,
      { signal: controller.signal }
    );

    expect(result.isError).toBeUndefined();
    expect(textFromResult(result)).toContain("signal-received");
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);

    await client.close();
    await bundle.close();
    await serverTransport.close();
    await clientTransport.close();
  });

  it("registers storage tools only when storage capability is enabled", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory,
      capabilities: ["storage"]
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    expect(names).toContain("browser_cookie_clear");
    expect(names).toContain("browser_cookie_delete");
    expect(names).toContain("browser_cookie_get");
    expect(names).toContain("browser_cookie_list");
    expect(names).toContain("browser_cookie_set");
    expect(names).toContain("browser_localstorage_clear");
    expect(names).toContain("browser_localstorage_delete");
    expect(names).toContain("browser_localstorage_get");
    expect(names).toContain("browser_localstorage_list");
    expect(names).toContain("browser_localstorage_set");
    expect(names).toContain("browser_sessionstorage_clear");
    expect(names).toContain("browser_sessionstorage_delete");
    expect(names).toContain("browser_sessionstorage_get");
    expect(names).toContain("browser_sessionstorage_list");
    expect(names).toContain("browser_sessionstorage_set");
    expect(names).toContain("browser_set_storage_state");
    expect(names).toContain("browser_storage_state");
  });

  it("registers Playwright testing verify tools when testing capability is enabled", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory,
      capabilities: ["testing"]
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    expect(names).toContain("browser_generate_locator");
    expect(names).toContain("browser_verify_element_visible");
    expect(names).toContain("browser_verify_text_visible");
    expect(names).toContain("browser_verify_list_visible");
    expect(names).toContain("browser_verify_value");
  });

  it("registers Playwright vision mouse tools when vision capability is enabled", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory,
      capabilities: ["vision"]
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    expect(names).toContain("browser_mouse_move_xy");
    expect(names).toContain("browser_mouse_click_xy");
    expect(names).toContain("browser_mouse_drag_xy");
  });

  it("registers Playwright PDF tool when pdf capability is enabled", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory,
      capabilities: ["pdf"]
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    expect(names).toContain("browser_pdf_save");
  });

  it("registers Playwright network state tool only when network capability is enabled", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory,
      capabilities: ["network"]
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    expect(names).toContain("browser_network_state_set");
    expect(names).toContain("browser_route");
    expect(names).toContain("browser_route_list");
    expect(names).toContain("browser_unroute");
  });

  it("registers Playwright devtools tools only when devtools capability is enabled", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory,
      capabilities: ["devtools"]
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    expect(names).toContain("browser_run_code_unsafe");
    expect(names).toContain("browser_start_tracing");
    expect(names).toContain("browser_stop_tracing");
  });

  it("exposes the Playwright config tool", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory,
      skillMode: true,
      snapshotMode: "none",
      timeouts: {
        action: 123,
        navigation: 456,
        expect: 789,
        settle: 321
      },
      contextOptions: {
        viewport: { width: 360, height: 732 },
        isMobile: true,
        hasTouch: true,
        userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Mobile Safari/537.36"
      },
      initPage: ["hooks/page.ts"],
      initScript: ["hooks/script.js"],
      secrets: {
        TOKEN: "abc123"
      },
      serverInfo: {
        name: "roxy-test",
        version: "9.9.9"
      }
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const result = await client.callTool({
      name: "browser_get_config",
      arguments: {}
    });

    expect(result.isError).toBeUndefined();
    const text = textFromResult(result);
    expect(text).toContain('"skillMode": true');
    expect(text).toContain('"snapshot": {\n    "mode": "none"\n  }');
    expect(text).toContain('"action": 123');
    expect(text).toContain('"navigation": 456');
    expect(text).toContain('"expect": 789');
    expect(text).toContain('"settle": 321');
    expect(text).toContain('"contextOptions": {');
    expect(text).toContain('"width": 360');
    expect(text).toContain('"isMobile": true');
    expect(text).toContain("Pixel 10");
    expect(text).toContain('"initPage": [');
    expect(text).toContain('"hooks/page.ts"');
    expect(text).toContain('"initScript": [');
    expect(text).toContain('"hooks/script.js"');
    expect(text).toContain('<secret>TOKEN</secret>');
  });

  it("registers roxy_browser_launch only when in-memory launch integration is configured", async () => {
    const launchClient: RoxyBrowserLaunchClient = {
      getConnectionInfo: vi.fn(),
      openBrowser: vi.fn()
    };
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory,
      roxyBrowserLaunch: {
        workspaceId: 12,
        client: launchClient
      }
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names).toContain("roxy_browser_connect");
    expect(names).toContain("roxy_browser_launch");
    expect(tools.tools.find((tool) => tool.name === "roxy_browser_launch")?.inputSchema).toMatchObject({
      properties: {
        dirId: { type: "string" },
        browser: { default: "chrome" },
        forceOpen: { default: true },
        args: { type: "array" }
      }
    });
    expect(tools.tools.find((tool) => tool.name === "roxy_browser_launch")?.inputSchema.properties)
      .not.toHaveProperty("workspaceId");
    expect(tools.tools.find((tool) => tool.name === "roxy_browser_launch")?.inputSchema.properties)
      .not.toHaveProperty("sessionId");
  });

  it("roxy_browser_launch reuses existing RoxyBrowser connection info before opening", async () => {
    const launchClient: RoxyBrowserLaunchClient = {
      getConnectionInfo: vi.fn(async () => ({
        code: 0,
        data: [
          {
            dirId: "profile-1",
            ws: "ws://existing.invalid/devtools/browser/abc",
            http: "127.0.0.1:41000",
            coreType: "Chrome"
          }
        ]
      })),
      openBrowser: vi.fn()
    };
    let connectArgs: RoxyBrowserConnectArgs | undefined;
    const bundle = await createRoxyBrowserMcpInMemory({
      roxyBrowserLaunch: {
        workspaceId: 12,
        client: launchClient
      },
      sessionFactory: async (args) => {
        connectArgs = args;
        return new FakeConnectedBrowserSession(args);
      }
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const result = await client.callTool({
      name: "roxy_browser_launch",
      arguments: {
        dirId: "profile-1"
      }
    });

    expect(result.isError).toBeUndefined();
    expect(launchClient.getConnectionInfo).toHaveBeenCalledWith(["profile-1"]);
    expect(launchClient.openBrowser).not.toHaveBeenCalled();
    expect(connectArgs).toMatchObject({
      protocol: "cdp",
      endpoint: "ws://existing.invalid/devtools/browser/abc",
      browser: "chromium"
    });
    expect(result.structuredContent).toEqual({
      browsers: [
        {
          dirId: "profile-1",
          endpoint: "ws://existing.invalid/devtools/browser/abc",
          connected: true,
          pageUrl: "ws://existing.invalid/devtools/browser/abc/home",
          browserType: "chrome"
        }
      ]
    });
    expect(JSON.parse(textFromResult(result))).toEqual(result.structuredContent);
  });

  it("installs Playwright MCP request origin filters on connect", async () => {
    let capturedSession: FakeConnectedBrowserSession | undefined;
    const bundle = await createRoxyBrowserMcpInMemory({
      network: {
        allowedOrigins: ["microsoft.com", "https://example.com", "http://localhost:*"],
        blockedOrigins: ["https://example.com", "playwright.dev"]
      },
      sessionFactory: async (args) => {
        capturedSession = new FakeConnectedBrowserSession(args);
        return capturedSession;
      }
    });
    cleanupCallbacks.push(async () => bundle.close());
    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const result = await client.callTool({
      name: "roxy_browser_connect",
      arguments: { endpoint: "ws://origin-filter.invalid/devtools/browser/1" }
    });

    expect(result.isError).toBeUndefined();
    expect(capturedSession?.routeList).toEqual([
      {
        pattern: "**",
        abort: "blockedbyclient"
      },
      {
        pattern: "*://microsoft.com/**"
      },
      {
        pattern: "https://example.com/**"
      },
      {
        pattern: "http://localhost:*/**"
      },
      {
        pattern: "https://example.com/**",
        abort: "blockedbyclient"
      },
      {
        pattern: "*://playwright.dev/**",
        abort: "blockedbyclient"
      }
    ]);
  });

  it("roxy_browser_launch opens the RoxyBrowser profile when no connection is available", async () => {
    const launchClient: RoxyBrowserLaunchClient = {
      getConnectionInfo: vi.fn(async () => ({ code: 0, data: [] })),
      openBrowser: vi.fn(async () => ({
        code: 0,
        data: {
          dirId: "profile-2",
          ws: "ws://opened.invalid/devtools/browser/def",
          pid: 1234,
          coreType: "Chrome"
        }
      }))
    };
    let connectArgs: RoxyBrowserConnectArgs | undefined;
    const bundle = await createRoxyBrowserMcpInMemory({
      roxyBrowserLaunch: {
        workspaceId: 12,
        client: launchClient
      },
      sessionFactory: async (args) => {
        connectArgs = args;
        return new FakeConnectedBrowserSession(args);
      }
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const result = await client.callTool({
      name: "roxy_browser_launch",
      arguments: {
        dirId: "profile-2",
        forceOpen: false,
        args: ["--headless=new"]
      }
    });

    expect(result.isError).toBeUndefined();
    expect(launchClient.openBrowser).toHaveBeenCalledWith({
      workspaceId: 12,
      dirId: "profile-2",
      forceOpen: false,
      args: ["--headless=new"]
    });
    expect(connectArgs?.endpoint).toBe("ws://opened.invalid/devtools/browser/def");
    expect(result.structuredContent).toEqual({
      browsers: [
        {
          dirId: "profile-2",
          endpoint: "ws://opened.invalid/devtools/browser/def",
          connected: true,
          pageUrl: "ws://opened.invalid/devtools/browser/def/home",
          browserType: "chrome"
        }
      ]
    });
  });

  it("roxy_browser_launch can use RoxyBrowser API options passed to in-memory creation", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, data: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            dirId: "profile-3",
            ws: "ws://api-opened.invalid/devtools/browser/ghi"
          }
        })
      } as Response);
    let connectArgs: RoxyBrowserConnectArgs | undefined;
    const bundle = await createRoxyBrowserMcpInMemory({
      roxyBrowserLaunch: {
        workspaceId: 88,
        apiToken: "api-token",
        apiPort: 59999,
        host: "127.0.0.2"
      },
      sessionFactory: async (args) => {
        connectArgs = args;
        return new FakeConnectedBrowserSession(args);
      }
    });
    cleanupCallbacks.push(async () => {
      fetchSpy.mockRestore();
      await bundle.close();
    });

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const result = await client.callTool({
      name: "roxy_browser_launch",
      arguments: {
        dirId: "profile-3"
      }
    });

    expect(result.isError).toBeUndefined();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.2:59999/browser/connection_info?dirIds=profile-3"
    );
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        token: "api-token"
      }
    });
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      "http://127.0.0.2:59999/browser/open"
    );
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        workspaceId: 88,
        dirId: "profile-3",
        forceOpen: true
      })
    });
    expect((fetchSpy.mock.calls[1]?.[1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    expect(connectArgs?.endpoint).toBe("ws://api-opened.invalid/devtools/browser/ghi");
    expect(result.structuredContent).toEqual({
      browsers: [
        {
          dirId: "profile-3",
          endpoint: "ws://api-opened.invalid/devtools/browser/ghi",
          connected: true,
          pageUrl: "ws://api-opened.invalid/devtools/browser/ghi/home",
          browserType: "chrome"
        }
      ]
    });
  });

  it("roxy_browser_launch attaches to Firefox over BiDi with the resolved session id", async () => {
    const launchClient: RoxyBrowserLaunchClient = {
      getConnectionInfo: vi.fn(async () => ({
        code: 0,
        data: [
          {
            dirId: "firefox-profile",
            ws: "ws://firefox.invalid/session/bidi-session",
            coreType: "Firefox"
          }
        ]
      })),
      openBrowser: vi.fn()
    };
    let connectArgs: RoxyBrowserConnectArgs | undefined;
    const bundle = await createRoxyBrowserMcpInMemory({
      roxyBrowserLaunch: {
        workspaceId: 12,
        client: launchClient
      },
      sessionFactory: async (args) => {
        connectArgs = args;
        return new FakeConnectedBrowserSession(args);
      }
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const result = await client.callTool({
      name: "roxy_browser_launch",
      arguments: {
        dirId: "firefox-profile",
        browser: "firefox"
      }
    });

    expect(result.isError).toBeUndefined();
    expect(connectArgs).toMatchObject({
      protocol: "bidi",
      endpoint: "ws://firefox.invalid/session/bidi-session",
      browser: "firefox",
      sessionId: "bidi-session"
    });
    expect(result.structuredContent).toEqual({
      browsers: [
        {
          dirId: "firefox-profile",
          endpoint: "ws://firefox.invalid/session/bidi-session",
          connected: true,
          pageUrl: "ws://firefox.invalid/session/bidi-session/home",
          browserType: "firefox"
        }
      ]
    });
  });

  it("exposes Playwright-like schemas for evaluate, hover, and file upload", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const tools = await client.listTools();
    const evaluateTool = tools.tools.find((tool) => tool.name === "browser_evaluate");
    const hoverTool = tools.tools.find((tool) => tool.name === "browser_hover");
    const uploadTool = tools.tools.find((tool) => tool.name === "browser_file_upload");
    const runCodeTool = tools.tools.find((tool) => tool.name === "browser_run_code_unsafe");

    expect(evaluateTool).toMatchObject({
      description: "Evaluate JavaScript expression on page or element",
      inputSchema: {
        properties: {
          element: {
            description: "Human-readable element description used to obtain permission to interact with the element"
          },
          target: {
            description: "Exact target element reference from the page snapshot, or a unique element selector"
          },
          function: {
            description: "() => { /* code */ } or (element) => { /* code */ } when element is provided"
          },
          filename: {
            description: "Filename to save the result to. If not provided, result is returned as text."
          }
        }
      }
    });

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

  it("exposes the Playwright 1.62 screenshot tool metadata", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const tools = await client.listTools();
    const screenshotTool = tools.tools.find((tool) => tool.name === "browser_take_screenshot");

    expect(screenshotTool).toMatchObject({
      title: "Take a screenshot",
      description: "Take a screenshot of the current page. You can't perform actions based on the screenshot, use browser_snapshot for actions.",
      inputSchema: {
        properties: {
          type: {
            description: "Image format for the screenshot. If unset, inferred from the filename extension, otherwise png."
          },
          filename: {
            description: "File name to save the screenshot to. Defaults to `page-{timestamp}.{png|jpeg|webp}` if not specified. Prefer relative file names to stay within the output directory."
          },
          scale: {
            default: "css"
          }
        }
      }
    });
  });

  it("exposes the Playwright network request part description", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const tools = await client.listTools();
    const networkRequestTool = tools.tools.find((tool) => tool.name === "browser_network_request");

    expect(networkRequestTool).toMatchObject({
      description: "Returns full details (headers and body) of a single network request, or a single part if `part` is set. Use the number from browser_network_requests.",
      inputSchema: {
        properties: {
          part: {
            description: "Return only this part of the request. Omit to return full details."
          }
        }
      }
    });
  });

  it("formats browser_evaluate failures through the Playwright-style response body", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: async (args) => {
        const session = new FakeConnectedBrowserSession(args);
        session.evaluate = async () => {
          throw new Error("Failed to execute 'querySelector' on 'Document': '\"consumechris\"' is not a valid selector.");
        };
        return session;
      }
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: {
        endpoint: "ws://evaluate-error.invalid/devtools/browser/1"
      }
    });

    const result = await client.callTool({
      name: "browser_evaluate",
      arguments: {
        function: "(currentUser) => currentUser",
        target: "\"consumechris\""
      }
    });

    expect(result.isError).toBe(true);
    expect(textFromResult(result)).toContain("### Error");
    expect(textFromResult(result)).toContain("\"consumechris\"");
  });

  it("formats browser_evaluate function results and generated code like Playwright", async () => {
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
        endpoint: "ws://evaluate-code.invalid/devtools/browser/1"
      }
    });

    const result = await client.callTool({
      name: "browser_evaluate",
      arguments: {
        function: "() => document.title"
      }
    });

    expect(result.isError).toBeUndefined();
    expect(textFromResult(result)).toContain("### Result\n\"evaluated:() => document.title\"");
    expect(textFromResult(result)).toContain("### Code\n```js\nawait page.evaluate('() => document.title');\n```");
  });

  it("formats browser_evaluate expressions and target code like Playwright", async () => {
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
        endpoint: "ws://evaluate-target.invalid/devtools/browser/1"
      }
    });

    const expressionResult = await client.callTool({
      name: "browser_evaluate",
      arguments: {
        function: "(1+1)"
      }
    });
    expect(expressionResult.isError).toBeUndefined();
    expect(textFromResult(expressionResult)).toContain("### Result\n2");
    expect(textFromResult(expressionResult)).toContain("await page.evaluate('() => ((1+1))');");

    const targetResult = await client.callTool({
      name: "browser_evaluate",
      arguments: {
        function: "element => element.textContent",
        element: "button",
        target: "button"
      }
    });
    expect(targetResult.isError).toBeUndefined();
    expect(textFromResult(targetResult)).toContain("await page.locator('button').evaluate('element => element.textContent');");
  });

  it("formats browser_evaluate filename results like Playwright", async () => {
    const scriptsDir = await mkdtemp(join(tmpdir(), "roxy-evaluate-results-"));
    cleanupCallbacks.push(async () => rm(scriptsDir, { recursive: true, force: true }));
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: fakeSessionFactory,
      scriptsDir
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: {
        endpoint: "ws://evaluate-file.invalid/devtools/browser/1"
      }
    });

    const result = await client.callTool({
      name: "browser_evaluate",
      arguments: {
        function: "() => document.title",
        filename: "result.json"
      }
    });

    const text = textFromResult(result);
    expect(result.isError).toBeUndefined();
    expect(text).toContain("### Result");
    expect(text).toContain("- [Evaluation result](");
    const match = text.match(/\- \[Evaluation result\]\(([^)]+)\)/);
    expect(match?.[1]).toBeTruthy();
    expect(await readFile(match![1]!, "utf8")).toBe("\"evaluated:() => document.title\"");
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
    const beforeConnectText = textFromResult(beforeConnect);
    expect(beforeConnectText).toContain("### Error");
    expect(beforeConnectText).toContain("Code: `not_connected`");
    expect(beforeConnectText).toContain("No RoxyBrowser browser is connected.");
    expect(beforeConnectText).toContain(
      "Connect to an existing RoxyBrowser browser or launch one from RoxyBrowser first."
    );
    expect(beforeConnectText).not.toContain("roxy_browser_connect");
    expect(beforeConnectText).not.toContain("roxy_browser_launch");

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
    expect(textFromResult(hoverResult)).toContain("Code: `stale_ref`");
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

  it("applies configured viewport after roxy_browser_connect like Playwright MCP", async () => {
    let capturedSession: FakeConnectedBrowserSession | undefined;
    const bundle = await createRoxyBrowserMcpInMemory({
      viewport: { width: 800, height: 600 },
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
        endpoint: "ws://viewport.invalid/devtools/browser/1"
      }
    });

    expect(connected.isError).toBeUndefined();
    expect(capturedSession?.resizeCalls).toEqual([{ width: 800, height: 600 }]);
  });

  it("applies configured device context after roxy_browser_connect like Playwright MCP", async () => {
    let capturedSession: FakeConnectedBrowserSession | undefined;
    const bundle = await createRoxyBrowserMcpInMemory({
      contextOptions: {
        viewport: { width: 360, height: 732 },
        screen: { width: 360, height: 808 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Mobile Safari/537.36"
      },
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
        endpoint: "ws://mobile.invalid/devtools/browser/1"
      }
    });

    expect(connected.isError).toBeUndefined();
    expect(capturedSession?.emulateContextCalls).toEqual([
      {
        viewport: { width: 360, height: 732 },
        screen: { width: 360, height: 808 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Mobile Safari/537.36"
      }
    ]);
  });

  it("blocks service worker registration after roxy_browser_connect like Playwright MCP", async () => {
    let capturedSession: FakeConnectedBrowserSession | undefined;
    const bundle = await createRoxyBrowserMcpInMemory({
      contextOptions: {
        serviceWorkers: "block"
      },
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
        endpoint: "ws://service-workers.invalid/devtools/browser/1"
      }
    });

    expect(connected.isError).toBeUndefined();
    expect(capturedSession?.emulateContextCalls).toEqual([
      {
        serviceWorkers: "block"
      }
    ]);
    expect(capturedSession?.initScriptCalls).toContain(
      "\nif (navigator.serviceWorker) navigator.serviceWorker.register = async () => { console.warn('Service Worker registration blocked by Playwright'); };\n"
    );
  });

  it("restores configured storage state after roxy_browser_connect like Playwright MCP", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roxy-mcp-storage-state-option-"));
    cleanupCallbacks.push(async () => rm(dir, { recursive: true, force: true }));
    const storageStatePath = join(dir, "state.json");
    await writeFile(storageStatePath, JSON.stringify({
      cookies: [{
        name: "session",
        value: "from-file",
        domain: "example.test",
        path: "/"
      }],
      origins: [{
        origin: "https://example.test",
        localStorage: [{ name: "token", value: "abc123" }]
      }]
    }));
    let capturedSession: FakeConnectedBrowserSession | undefined;
    const bundle = await createRoxyBrowserMcpInMemory({
      contextOptions: {
        storageState: storageStatePath
      },
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
        endpoint: "ws://storage-state.invalid/devtools/browser/1"
      }
    });

    expect(connected.isError).toBeUndefined();
    expect(capturedSession?.cookiesList).toEqual([{
      name: "session",
      value: "from-file",
      domain: "example.test",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: "Lax"
    }]);
    expect(capturedSession?.localStorageItemsList).toEqual([{ name: "token", value: "abc123" }]);
  });

  it("includes the configured mobile viewport in the initial snapshot like Playwright MCP device tests", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      contextOptions: {
        viewport: { width: 360, height: 732 },
        screen: { width: 360, height: 808 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Mobile Safari/537.36"
      },
      sessionFactory: async (args) => new FakeConnectedBrowserSession(args)
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const connected = await client.callTool({
      name: "roxy_browser_connect",
      arguments: {
        endpoint: "ws://mobile-snapshot.invalid/devtools/browser/1"
      }
    });

    expect(connected.isError).toBeUndefined();
    expect(textFromResult(connected)).toContain('button "360x732"');
  });

  it("surfaces init-page load errors like Playwright MCP", async () => {
    const hooksDir = await mkdtemp(join(tmpdir(), "roxy-mcp-init-page-"));
    cleanupCallbacks.push(async () => rm(hooksDir, { recursive: true, force: true }));
    const initPagePath = join(hooksDir, "broken-init-page.mjs");
    await writeFile(initPagePath, `
      export default async () => {
        throw new Error('boom from initPage');
      };
    `);

    const bundle = await createRoxyBrowserMcpInMemory({
      initPage: [initPagePath],
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: { endpoint: "ws://init-page.invalid/devtools/browser/1" }
    });

    const response = await client.callTool({
      name: "browser_snapshot",
      arguments: {}
    });

    expect(response.isError).toBe(true);
    expect(textFromResult(response)).toContain(`Failed to load init page "${initPagePath}": boom from initPage`);
  });

  it("runs init-page before browser_snapshot like Playwright MCP", async () => {
    const hooksDir = await mkdtemp(join(tmpdir(), "roxy-mcp-init-page-"));
    cleanupCallbacks.push(async () => rm(hooksDir, { recursive: true, force: true }));
    const initPagePath = join(hooksDir, "init-page.mjs");
    await writeFile(initPagePath, `
      export default async ({ page }) => {
        await page.setContent('<div>Hello world</div>');
      };
    `);

    const bundle = await createRoxyBrowserMcpInMemory({
      initPage: [initPagePath],
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: { endpoint: "ws://init-page-success.invalid/devtools/browser/1" }
    });

    const response = await client.callTool({
      name: "browser_snapshot",
      arguments: {}
    });

    expect(response.isError).toBeUndefined();
    expect(textFromResult(response)).toContain("Hello world");
  });

  it("applies init-page before the first page screenshot like Playwright MCP", async () => {
    const hooksDir = await mkdtemp(join(tmpdir(), "roxy-mcp-init-page-"));
    cleanupCallbacks.push(async () => rm(hooksDir, { recursive: true, force: true }));
    const initPagePath = join(hooksDir, "screenshot-init-page.mjs");
    await writeFile(initPagePath, `
      export default async ({ page }) => {
        page.screenshot = async () => {
          throw new Error('initPage screenshot hook applied');
        };
      };
    `);

    const bundle = await createRoxyBrowserMcpInMemory({
      initPage: [initPagePath],
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: { endpoint: "ws://init-page-screenshot.invalid/devtools/browser/1" }
    });

    const response = await client.callTool({
      name: "browser_take_screenshot",
      arguments: {}
    });

    expect(response.isError).toBe(true);
    expect(textFromResult(response)).toContain("initPage screenshot hook applied");
  });

  it("loads and executes init-script files like Playwright MCP", async () => {
    const hooksDir = await mkdtemp(join(tmpdir(), "roxy-mcp-init-script-"));
    cleanupCallbacks.push(async () => rm(hooksDir, { recursive: true, force: true }));
    const initScriptPath = join(hooksDir, "init-script1.js");
    const initScriptPath2 = join(hooksDir, "init-script2.js");
    await writeFile(initScriptPath, "window.testInitScriptExecuted = true;");
    await writeFile(initScriptPath2, "console.log('Init script executed successfully');");

    let capturedSession: FakeConnectedBrowserSession | undefined;
    const bundle = await createRoxyBrowserMcpInMemory({
      initScript: [initScriptPath, initScriptPath2],
      sessionFactory: async (args) => {
        capturedSession = new FakeConnectedBrowserSession(args);
        return capturedSession;
      }
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: { endpoint: "ws://init-script.invalid/devtools/browser/1" }
    });

    await client.callTool({
      name: "browser_navigate",
      arguments: { url: "https://example.test/hello" }
    });
    await client.callTool({
      name: "browser_evaluate",
      arguments: { function: "() => console.log(\"Custom log\")" }
    });

    const evaluated = await client.callTool({
      name: "browser_evaluate",
      arguments: { function: "() => window.testInitScriptExecuted" }
    });
    const consoleResult = await client.callTool({
      name: "browser_console_messages",
      arguments: { all: true }
    });

    expect(evaluated.isError).toBeUndefined();
    expect(textFromResult(evaluated)).toContain("true");
    expect(capturedSession?.initScriptCalls).toEqual([
      "window.testInitScriptExecuted = true;",
      "console.log('Init script executed successfully');"
    ]);
    expect(textFromResult(consoleResult)).toMatch(/Init script executed successfully.*Custom log/ms);
  });

  it("surfaces init-script load errors like Playwright MCP", async () => {
    const hooksDir = await mkdtemp(join(tmpdir(), "roxy-mcp-init-script-missing-"));
    cleanupCallbacks.push(async () => rm(hooksDir, { recursive: true, force: true }));
    const initScriptPath = join(hooksDir, "missing-init-script.js");

    const bundle = await createRoxyBrowserMcpInMemory({
      initScript: [initScriptPath],
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);

    const response = await client.callTool({
      name: "roxy_browser_connect",
      arguments: { endpoint: "ws://init-script-missing.invalid/devtools/browser/1" }
    });

    expect(response.isError).toBe(true);
    expect(textFromResult(response)).toContain(initScriptPath);
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
    expect(textFromResult(invalidSelect)).toContain("Code: `invalid_tab_index`");
  });

  it("omits generated code when Playwright MCP codegen is disabled", async () => {
    const bundle = await createRoxyBrowserMcpInMemory({
      codegen: "none",
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => bundle.close());

    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: { endpoint: "ws://codegen-none.invalid/devtools/browser/1" }
    });

    const result = await client.callTool({
      name: "browser_navigate",
      arguments: { url: "https://example.test" }
    });

    expect(result.isError).toBeUndefined();
    const text = textFromResult(result);
    expect(text).not.toContain("### Code");
    expect(text).not.toContain("page.goto");
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

  it("rejects HTTP requests from disallowed Host headers like Playwright MCP", async () => {
    const httpBundle = await startRoxyBrowserMcpHttp({
      port: 0,
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => httpBundle.close());

    const address = httpBundle.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral HTTP address.");
    }

    const response = await httpGetWithHost(address.port, "/health", "evil.example");

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("Access is only allowed at");
  });

  it("allows any HTTP Host header when allowedHosts contains wildcard like Playwright MCP", async () => {
    const httpBundle = await startRoxyBrowserMcpHttp({
      port: 0,
      allowedHosts: ["*"],
      sessionFactory: fakeSessionFactory
    });
    cleanupCallbacks.push(async () => httpBundle.close());

    const address = httpBundle.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral HTTP address.");
    }

    const response = await httpGetWithHost(address.port, "/health", "evil.example");

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
  });

  it("closes an HTTP MCP session when heartbeat ping is not answered like Playwright MCP", async () => {
    process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS = "50";
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

    const client = createClient();
    const transport = new StreamableHTTPClientTransport(baseUrl);
    cleanupCallbacks.push(async () => transport.close());
    cleanupCallbacks.push(async () => client.close());
    client.setRequestHandler(PingRequestSchema, () => new Promise(() => {}));
    await client.connect(transport);
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: { endpoint: "ws://heartbeat-timeout.invalid/devtools/browser/1" }
    }).catch(() => {});

    await expect.poll(async () => {
      const result = await client.callTool({
        name: "browser_tabs",
        arguments: { action: "list" }
      }).then(() => "open", () => "closed");
      return result;
    }, { timeout: 2000 }).toBe("closed");
  });

  it("does not run HTTP MCP heartbeat when ping timeout is non-positive like Playwright MCP", async () => {
    process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS = "0";
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

    const client = createClient();
    const transport = new StreamableHTTPClientTransport(baseUrl);
    cleanupCallbacks.push(async () => transport.close());
    cleanupCallbacks.push(async () => client.close());
    client.setRequestHandler(PingRequestSchema, () => new Promise(() => {}));
    await client.connect(transport);
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: { endpoint: "ws://heartbeat-disabled.invalid/devtools/browser/1" }
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const result = await client.callTool({
      name: "browser_tabs",
      arguments: { action: "list" }
    });
    expect(result.isError).toBeUndefined();
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
      expect(textFromResult(handled)).not.toContain("Accepted dialog.");
      expect(textFromResult(handled)).not.toContain("Dismissed dialog.");
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
      expect(textFromResult(result)).toContain("Code: `stale_ref`");
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

    it("generates getByTestId code for snapshot refs with the configured Playwright MCP test id attribute", async () => {
      let capturedSession: TestIdLocatorSnapshotSession | undefined;
      const trackingFactory: BrowserSessionFactory = async (args) => {
        capturedSession = new TestIdLocatorSnapshotSession(args);
        return capturedSession;
      };

      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: trackingFactory,
        testIdAttribute: "data-tid"
      });
      cleanupCallbacks.push(async () => bundle.close());
      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { endpoint: "ws://test-id-ref.invalid/devtools/browser/1" }
      });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { element: "Submit button", target: "e1" }
      });

      expect(result.isError).toBeUndefined();
      expect(capturedSession!.clickCalls[0]!.target).toHaveProperty("nodeToken");
      expect(textFromResult(result)).toContain("await page.getByTestId('submit').click();");
    });

    it("resolves getByTestId targets with the configured Playwright MCP test id attribute", async () => {
      let capturedSession: FakeConnectedBrowserSession | undefined;
      const trackingFactory: BrowserSessionFactory = async (args) => {
        capturedSession = new FakeConnectedBrowserSession(args);
        return capturedSession;
      };

      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: trackingFactory,
        testIdAttribute: "data-pw"
      });
      cleanupCallbacks.push(async () => bundle.close());
      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { endpoint: "ws://test-id-attribute.invalid/devtools/browser/1" }
      });

      const result = await client.callTool({
        name: "browser_click",
        arguments: { target: "getByTestId('save')" }
      });

      expect(result.isError).toBeUndefined();
      expect(capturedSession!.clickCalls[0]!.target).toEqual({ selector: "[data-pw=\"save\"]" });
      expect(textFromResult(result)).toContain("await page.getByTestId('save').click");
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

  async function setupTrackingClient(options: Omit<CreateRoxyBrowserMcpServerOptions, "sessionFactory"> = {}) {
    let capturedSession: FakeConnectedBrowserSession | undefined;
    const trackingFactory: BrowserSessionFactory = async (args) => {
      capturedSession = new FakeConnectedBrowserSession(args);
      return capturedSession;
    };
    const bundle = await createRoxyBrowserMcpInMemory({ ...options, sessionFactory: trackingFactory });
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

  async function setupClientWithSession(session: ConnectedBrowserSession) {
    const bundle = await createRoxyBrowserMcpInMemory({
      sessionFactory: async () => session
    });
    cleanupCallbacks.push(async () => bundle.close());
    const client = createClient();
    cleanupCallbacks.push(async () => client.close());
    await client.connect(bundle.clientTransport);
    await client.callTool({
      name: "roxy_browser_connect",
      arguments: { endpoint: "ws://tools-test.invalid/devtools/browser/1" }
    });
    return client;
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

    it("surfaces non-2xx main document status like Playwright MCP", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: async (args) => new Non2xxNavigationStatusSession(args)
      });
      cleanupCallbacks.push(async () => bundle.close());
      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { endpoint: "ws://status.invalid/devtools/browser/1" }
      });

      const result = await client.callTool({
        name: "browser_navigate",
        arguments: { url: "https://example.test/locked" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("- HTTP status: 402 Payment Required");
    });

    it("does not surface final 2xx main document status like Playwright MCP", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: async (args) => new Final2xxNavigationStatusSession(args)
      });
      cleanupCallbacks.push(async () => bundle.close());
      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { endpoint: "ws://status.invalid/devtools/browser/1" }
      });

      const result = await client.callTool({
        name: "browser_navigate",
        arguments: { url: "https://example.test/redirect" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).not.toContain("HTTP status");
    });
  });

  describe("download events", () => {
    it("formats download events like Playwright MCP", async () => {
      const client = await setupClientWithSession(
        new DownloadEventsSnapshotSession({
          protocol: "cdp",
          endpoint: "ws://download.invalid/devtools/browser/1"
        })
      );

      const result = await client.callTool({
        name: "browser_snapshot",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain(`### Events
- Downloading file test.txt ...
- Downloaded file test.txt to "output/test.txt"`);
    });

    it("keeps console and download events in the same Events section", async () => {
      const client = await setupClientWithSession(
        new ConsoleAndDownloadEventsSnapshotSession({
          protocol: "cdp",
          endpoint: "ws://download.invalid/devtools/browser/1"
        })
      );

      const result = await client.callTool({
        name: "browser_snapshot",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain(`### Events
- New console entries: /tmp/console.log
- Downloading file test.txt ...`);
    });
  });

  describe("browser_close", () => {
    it("returns Playwright-style close output", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_close",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().closeCount).toBe(1);
      const text = textFromResult(result);
      expect(text).toContain("await page.close()");
      expect(text).not.toContain("Browser session closed.");
    });
  });

  describe("browser_find", () => {
    it("searches snapshot text and returns surrounding context", async () => {
      const { client } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_find",
        arguments: { text: "home" }
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain("Found 1 match for \"home\"");
      expect(text).toContain('- button "ws://tools-test.invalid/devtools/browser/1 home" [ref=e1]');
    });

    it("supports Playwright MCP regex literal input", async () => {
      const { client } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_find",
        arguments: { regex: "/HOME/i" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("Found 1 match for /HOME/i");
    });

    it("searches the page aria snapshot directly like Playwright MCP", async () => {
      const session = new FindAriaSnapshotSession({
        protocol: "cdp",
        endpoint: "ws://find.invalid/devtools/browser/1"
      });
      const client = await setupClientWithSession(session);
      const snapshotCountBeforeFind = session.snapshotCount;

      const result = await client.callTool({
        name: "browser_find",
        arguments: { text: "Aria Snapshot" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain('Found 1 match for "Aria Snapshot"');
      expect(session.ariaSnapshotCount).toBe(1);
      expect(session.snapshotCount).toBe(snapshotCountBeforeFind);
    });

    it("shows the ancestor path from the root to the match like Playwright MCP", async () => {
      const client = await setupClientWithSession(
        new PlaywrightMcpFindNestedSession({
          protocol: "cdp",
          endpoint: "ws://find.invalid/devtools/browser/1"
        })
      );

      const result = await client.callTool({
        name: "browser_find",
        arguments: { text: "Deep Target Link" }
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain(`Found 1 match for "Deep Target Link":

  - main [ref=e2]:
    - region "Sidebar" [ref=e3]:
      - navigation "Primary" [ref=e4]:
        - list [ref=e5]:
          - listitem [ref=e14]:`);
      expect(text).toContain(`          - listitem [ref=e16]:
            - link "Deep Target Link" [ref=e17]`);
      expect(text).toContain("Careers");
    });

    it("marks gaps within off-path context with an ellipsis like Playwright MCP", async () => {
      const client = await setupClientWithSession(
        new PlaywrightMcpFindToolbarSession({
          protocol: "cdp",
          endpoint: "ws://find.invalid/devtools/browser/1"
        })
      );

      const result = await client.callTool({
        name: "browser_find",
        arguments: { text: "Target Button" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain(`Found 1 match for "Target Button":

  - main [ref=e2]:
    - group "Toolbar" [ref=e3]:
      ...
      - button "Three" [ref=e6]
      - button "Four" [ref=e7]
    - group "Content" [ref=e8]:
      - button "Target Button" [ref=e9]`);
    });

    it("is case-insensitive for text like Playwright MCP", async () => {
      const client = await setupClientWithSession(
        new PlaywrightMcpFindListSession({
          protocol: "cdp",
          endpoint: "ws://find.invalid/devtools/browser/1"
        })
      );

      const result = await client.callTool({
        name: "browser_find",
        arguments: { text: "apples" }
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain('Found 1 match for "apples"');
      expect(text).toContain("Apples");
    });

    it("formats text queries with Playwright MCP quoting", async () => {
      const client = await setupClientWithSession(
        new PlaywrightMcpFindListSession({
          protocol: "cdp",
          endpoint: "ws://find.invalid/devtools/browser/1"
        })
      );

      const result = await client.callTool({
        name: "browser_find",
        arguments: { text: 'button "Add' }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain('Found 1 match for "button "Add"');
      expect(textFromResult(result)).not.toContain('\\"Add');
    });

    it("keeps regex case-sensitive by default like Playwright MCP", async () => {
      const client = await setupClientWithSession(
        new PlaywrightMcpFindListSession({
          protocol: "cdp",
          endpoint: "ws://find.invalid/devtools/browser/1"
        })
      );

      const result = await client.callTool({
        name: "browser_find",
        arguments: { regex: "apples" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("No matches found for /apples/.");
    });

    it("reports invalid regex input like Playwright MCP", async () => {
      const client = await setupClientWithSession(
        new PlaywrightMcpFindListSession({
          protocol: "cdp",
          endpoint: "ws://find.invalid/devtools/browser/1"
        })
      );

      const result = await client.callTool({
        name: "browser_find",
        arguments: { regex: "(" }
      });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain("Invalid regular expression");
    });

    it("requires exactly one search query like Playwright MCP", async () => {
      const { client } = await setupTrackingClient();

      const missing = await client.callTool({
        name: "browser_find",
        arguments: {}
      });
      const both = await client.callTool({
        name: "browser_find",
        arguments: { text: "Action", regex: "Action" }
      });

      expect(missing.isError).toBe(true);
      expect(textFromResult(missing)).toContain('Provide either "text" or "regex" to search for.');
      expect(both.isError).toBe(true);
      expect(textFromResult(both)).toContain('Provide only one of "text" or "regex", not both.');
    });
  });

  describe("browser_console_messages tools", () => {
    it("reports total console counts before level filtering like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient();
      getSession().consoleMessagesList = [
        {
          type: "log",
          text: "hello",
          timestamp: Date.now(),
          formattedText: "[LOG] hello @ :0"
        },
        {
          type: "warning",
          text: "careful",
          timestamp: Date.now(),
          formattedText: "[WARNING] careful @ :0"
        },
        {
          type: "error",
          text: "boom",
          timestamp: Date.now(),
          formattedText: "[ERROR] boom @ :0"
        }
      ];

      const result = await client.callTool({
        name: "browser_console_messages",
        arguments: { level: "error" }
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain("Total messages: 3 (Errors: 1, Warnings: 1)");
      expect(text).toContain('Returning 1 messages for level "error"');
      expect(text).toContain("[ERROR] boom");
      expect(text).not.toContain("[WARNING] careful");
      expect(text).not.toContain("[LOG] hello");
    });

    it("applies the configured default console collection level like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        consoleLevel: "error"
      });
      getSession().consoleMessagesList = [
        {
          type: "log",
          text: "console.log",
          timestamp: Date.now(),
          formattedText: "[LOG] console.log @ :0"
        },
        {
          type: "error",
          text: "console.error",
          timestamp: Date.now(),
          formattedText: "[ERROR] console.error @ :0"
        }
      ].filter((message) => consoleLevelForTest(message.type) <= consoleLevelForTest(getSession().consoleLevel));

      const result = await client.callTool({
        name: "browser_console_messages",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain("Total messages: 1 (Errors: 1, Warnings: 0)");
      expect(text).toContain("[ERROR] console.error");
      expect(text).not.toContain("console.log");
    });

    it("clears console messages like Playwright MCP", async () => {
      const { client } = await setupTrackingClient();

      const before = await client.callTool({
        name: "browser_console_messages",
        arguments: {}
      });
      const clear = await client.callTool({
        name: "browser_console_clear",
        arguments: {}
      });
      const after = await client.callTool({
        name: "browser_console_messages",
        arguments: {}
      });

      expect(before.isError).toBeUndefined();
      expect(textFromResult(before)).toContain("[LOG] hello");
      expect(clear.isError).toBeUndefined();
      expect(textFromResult(after)).not.toContain("[LOG] hello");
      expect(textFromResult(after)).toContain("Total messages: 0 (Errors: 0, Warnings: 0)");
    });

    it("evicts old output files after saving text artifacts when outputMaxSize is exceeded like Playwright MCP", async () => {
      const artifactsDir = await mkdtemp(join(tmpdir(), "roxy-output-budget-"));
      cleanupCallbacks.push(async () => rm(artifactsDir, { recursive: true, force: true }));
      const consoleDir = join(artifactsDir, "console");
      await mkdir(consoleDir, { recursive: true });
      const oldFile = join(consoleDir, "old.log");
      await writeFile(oldFile, "x".repeat(200), "utf8");
      const oldDate = new Date(Date.now() - 60_000);
      await utimes(oldFile, oldDate, oldDate);
      const { client } = await setupTrackingClient({
        artifactsDir,
        outputMaxSize: 200
      });

      const result = await client.callTool({
        name: "browser_console_messages",
        arguments: { filename: "new.log" }
      });

      expect(result.isError).toBeUndefined();
      await expect(readFile(oldFile, "utf8")).rejects.toThrow();
      await expect(readFile(join(consoleDir, "new.log"), "utf8")).resolves.toContain("[LOG] hello");
    });
  });

  describe("secrets", () => {
    it("redacts configured secrets from MCP text responses and saved text artifacts", async () => {
      const consoleDir = await mkdtemp(join(tmpdir(), "roxybrowser-mcp-console-secrets-"));
      cleanupCallbacks.push(async () => rm(consoleDir, { recursive: true, force: true }));
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: async (args) => new SecretConsoleSession(args),
        consoleDir,
        secrets: {
          "X-PASSWORD": "password123",
          EMPTY_SECRET: ""
        }
      });
      cleanupCallbacks.push(async () => bundle.close());

      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { endpoint: "ws://secrets.invalid/devtools/browser/1" }
      });

      const response = await client.callTool({
        name: "browser_console_messages",
        arguments: {}
      });
      expect(response.isError).toBeUndefined();
      expect(textFromResult(response)).not.toContain("password123");
      expect(textFromResult(response)).toContain("<secret>X-PASSWORD</secret>");

      const filename = "console.log";
      const resolvedFilename = join(consoleDir, filename);
      const saved = await client.callTool({
        name: "browser_console_messages",
        arguments: { filename }
      });
      expect(saved.isError).toBeUndefined();
      expect(textFromResult(saved)).toContain(`Saved console messages to "${resolvedFilename}".`);

      const savedText = await readFile(resolvedFilename, "utf8");
      expect(savedText).not.toContain("password123");
      expect(savedText).toContain("<secret>X-PASSWORD</secret>");
    });
  });

  describe("browser_type", () => {
    it("calls session.type with ref and text without snapshot when not submitting", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_type",
        arguments: { target: "e1", text: "hello" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().typeCalls.length).toBe(1);
      expect(getSession().typeCalls[0]!.text).toBe("hello");
      expect(getSession().typeCalls[0]!.target).toHaveProperty("nodeToken");
      expect(getSession().typeCalls[0]!.options?.strategy).toBe("fill");
      expect(getSession().focusCalls).toHaveLength(1);
      expect(getSession().clearCalls).toHaveLength(0);
      expect(getSession().pressKeyCalls).toEqual([]);
      expect(textFromResult(result)).not.toContain("### Snapshot");
    });

    it("passes submit option through", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_type",
        arguments: { target: "e1", text: "query", submit: true }
      });

      expect(getSession().typeCalls[0]!.options?.strategy).toBe("fill");
      expect(getSession().pressCalls).toEqual([{
        target: expect.objectContaining({ nodeToken: expect.any(String) }),
        key: "Enter",
        options: undefined
      }]);
      expect(getSession().pressKeyCalls).toEqual([]);
    });

    it("resolves configured secret names like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        secrets: {
          "TEST_PASSWORD": "password123"
        }
      });

      const result = await client.callTool({
        name: "browser_type",
        arguments: { target: "e1", text: "TEST_PASSWORD" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().typeCalls[0]!.text).toBe("password123");
      const text = textFromResult(result);
      expect(text).toContain("await page.locator('aria-ref=e1').fill(process.env['TEST_PASSWORD']);");
      expect(text).not.toContain("password123");
    });

    it("types slowly with Playwright-style pressSequentially code", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_type",
        arguments: { target: "e1", text: "Hi!", slowly: true }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().typeCalls[0]!.options?.strategy).toBe("sequential");
      const text = textFromResult(result);
      expect(text).toContain("await page.locator('aria-ref=e1').pressSequentially('Hi!');");
      expect(text).not.toContain(".fill(\"Hi!\")");
    });

    it("uses Playwright-style fill code for default typing", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_type",
        arguments: { target: "e1", text: "Hello" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().typeCalls).toHaveLength(1);
      expect(getSession().typeCalls[0]!.options?.strategy).toBe("fill");
      expect(textFromResult(result)).toContain("await page.locator('aria-ref=e1').fill('Hello');");
      expect(textFromResult(result)).not.toContain("pressSequentially('Hello')");
    });

    it("passes the selected human profile into sequential typing", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({
        name: "browser_type",
        arguments: { target: "e1", text: "quick", slowly: true, human: { profile: "fast" } }
      });

      expect(getSession().typeCalls[0]!.options).toMatchObject({
        strategy: "sequential",
        varianceMs: 30
      });
      expect(getSession().typeCalls[0]!.options?.delayMs).toBeLessThanOrEqual(102);
    });

    it("honors explicit slow typing on the sequential path", async () => {
      const { client, getSession } = await setupTrackingClient();
      const text = "x".repeat(200);

      await client.callTool({
        name: "browser_type",
        arguments: { target: "e1", text, slowly: true }
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
      expect(getSession().pressCalls).toEqual([{
        target: expect.objectContaining({ nodeToken: expect.any(String) }),
        key: "Enter",
        options: undefined
      }]);
      expect(getSession().pressKeyCalls).toEqual([]);
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
      expect(textFromResult(result)).toContain("Code: `stale_ref`");
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

    it("resolves configured textbox secrets like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        secrets: {
          "TEST_PASSWORD": "password123"
        }
      });

      const result = await client.callTool({
        name: "browser_fill_form",
        arguments: {
          fields: [{ target: "e1", type: "textbox", value: "TEST_PASSWORD", name: "Password" }]
        }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().typeCalls[0]!.text).toBe("password123");
      const text = textFromResult(result);
      expect(text).toContain("await page.locator('aria-ref=e1').fill(process.env['TEST_PASSWORD']);");
      expect(text).not.toContain("password123");
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
    it("calls session.pressKey and returns snapshot for Enter", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_press_key",
        arguments: { key: "Enter" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().pressKeyCalls).toEqual([{ key: "Enter", modifiers: undefined }]);
      expect(textFromResult(result)).toContain("// Press Enter");
      expect(textFromResult(result)).toContain("### Snapshot");
    });

    it("presses ordinary keys without returning a snapshot", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_press_key",
        arguments: { key: "h" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().pressKeyCalls).toEqual([{ key: "h", modifiers: undefined }]);
      expect(textFromResult(result)).not.toContain("### Snapshot");
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

  describe("browser_press_sequentially", () => {
    it("types text key by key without waiting for completion when submit is not requested", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_press_sequentially",
        arguments: { text: "Hi!" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().keyboardTypeCalls).toEqual(["Hi!"]);
      expect(getSession().pressKeyCalls).toEqual([]);
      expect(getSession().waitForPageTimeoutCalls).toEqual([]);
      const text = textFromResult(result);
      expect(text).toContain("await page.keyboard.type(\"Hi!\");");
      expect(text).not.toContain("### Snapshot");
    });

    it("types text key by key and optionally submits like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_press_sequentially",
        arguments: { text: "Hi!", submit: true }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().keyboardTypeCalls).toEqual(["Hi!"]);
      expect(getSession().pressKeyCalls).toEqual([{ key: "Enter", modifiers: undefined }]);
      const text = textFromResult(result);
      expect(text).toContain("await page.keyboard.type(\"Hi!\");");
      expect(text).toContain("await page.keyboard.press('Enter');");
      expect(text).toContain("### Snapshot");
    });
  });

  describe("browser_keydown and browser_keyup", () => {
    it("presses a key down and up like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient();

      const down = await client.callTool({
        name: "browser_keydown",
        arguments: { key: "h" }
      });
      const up = await client.callTool({
        name: "browser_keyup",
        arguments: { key: "h" }
      });

      expect(down.isError).toBeUndefined();
      expect(up.isError).toBeUndefined();
      expect(getSession().keyDownCalls).toEqual(["h"]);
      expect(getSession().keyUpCalls).toEqual(["h"]);
      expect(textFromResult(down)).toContain("await page.keyboard.down(\"h\");");
      expect(textFromResult(up)).toContain("await page.keyboard.up(\"h\");");
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

  describe("browser_mouse_click_xy", () => {
    it("clicks coordinates like Playwright MCP while using the humanized runtime path", async () => {
      const { client, getSession } = await setupTrackingClient({ capabilities: ["vision"] });

      const result = await client.callTool({
        name: "browser_mouse_click_xy",
        arguments: { x: 100, y: 120, button: "right", clickCount: 2, delay: 20 }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().mouseClickCalls).toHaveLength(1);
      expect(getSession().mouseClickCalls[0]).toMatchObject({
        x: 100,
        y: 120,
        options: {
          button: "right",
          clickCount: 2,
          delay: 20
        }
      });
      expect(textFromResult(result)).toContain(`await page.mouse.click(100, 120, { button: "right", clickCount: 2, delay: 20 });`);
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
      expect(text).toContain("await page.locator('aria-ref=e1').selectOption([\"opt1\", \"opt2\"]);");
      expect(text).not.toContain("Selected options:");
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

  describe("browser_generate_locator", () => {
    it("returns the Playwright locator for a snapshot ref", async () => {
      const { client } = await setupTrackingClient({ capabilities: ["testing"] });
      await client.callTool({ name: "browser_snapshot", arguments: {} });

      const result = await client.callTool({
        name: "browser_generate_locator",
        arguments: { target: "e1", element: "home button" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("locator('aria-ref=e1')");
      expect(textFromResult(result)).not.toContain("### Snapshot");
    });

    it("returns the Playwright locator for a CSS selector", async () => {
      const { client } = await setupTrackingClient({ capabilities: ["testing"] });

      const result = await client.callTool({
        name: "browser_generate_locator",
        arguments: { target: "button.primary", element: "primary button" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("locator('button.primary')");
    });
  });

  describe("browser_storage_state", () => {
    it("saves storage state to a generated file like Playwright MCP", async () => {
      const artifactsDir = await mkdtemp(join(tmpdir(), "roxy-storage-state-"));
      cleanupCallbacks.push(async () => rm(artifactsDir, { recursive: true, force: true }));
      const { client, getSession } = await setupTrackingClient({
        artifactsDir,
        capabilities: ["storage"]
      });
      await client.callTool({
        name: "browser_navigate",
        arguments: { url: "https://example.test/page" }
      });
      getSession().cookiesList = [{
        name: "testCookie",
        value: "testValue",
        domain: "example.test",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Lax"
      }];
      getSession().localStorageItemsList = [{ name: "testKey", value: "testValue" }];

      const result = await client.callTool({
        name: "browser_storage_state",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain("- [Storage state](");
      expect(text).toContain("await page.context().storageState");

      const match = text.match(/- \[Storage state\]\(([^)]+storage-state-[^)]+\.json)\)/);
      expect(match?.[1]).toBeDefined();
      const content = JSON.parse(await readFile(match![1]!, "utf8"));
      expect(content.cookies).toContainEqual(expect.objectContaining({
        name: "testCookie",
        value: "testValue"
      }));
      expect(content.origins).toEqual([{
        origin: "https://example.test",
        localStorage: [{ name: "testKey", value: "testValue" }]
      }]);
    });

    it("saves storage state to a custom filename like Playwright MCP", async () => {
      const artifactsDir = await mkdtemp(join(tmpdir(), "roxy-storage-state-custom-"));
      cleanupCallbacks.push(async () => rm(artifactsDir, { recursive: true, force: true }));
      const { client } = await setupTrackingClient({
        artifactsDir,
        capabilities: ["storage"]
      });

      const result = await client.callTool({
        name: "browser_storage_state",
        arguments: { filename: "my-state.json" }
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain("my-state.json");
      expect(JSON.parse(await readFile(join(artifactsDir, "storage", "my-state.json"), "utf8"))).toEqual({
        cookies: [],
        origins: []
      });
    });
  });

  describe("browser_set_storage_state", () => {
    it("restores storage state from a file like Playwright MCP", async () => {
      const artifactsDir = await mkdtemp(join(tmpdir(), "roxy-set-storage-state-"));
      cleanupCallbacks.push(async () => rm(artifactsDir, { recursive: true, force: true }));
      await mkdir(join(artifactsDir, "storage"), { recursive: true });
      await writeFile(join(artifactsDir, "storage", "state.json"), JSON.stringify({
        cookies: [{
          name: "restoredCookie",
          value: "restoredValue",
          domain: "example.test",
          path: "/"
        }],
        origins: [{
          origin: "https://example.test",
          localStorage: [{ name: "restoredKey", value: "restoredValue" }]
        }]
      }));
      const { client, getSession } = await setupTrackingClient({
        artifactsDir,
        capabilities: ["storage"]
      });
      await client.callTool({
        name: "browser_navigate",
        arguments: { url: "https://example.test/page" }
      });
      getSession().cookiesList = [{
        name: "oldCookie",
        value: "oldValue",
        domain: "example.test",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Lax"
      }];
      getSession().localStorageItemsList = [{ name: "oldKey", value: "oldValue" }];

      const result = await client.callTool({
        name: "browser_set_storage_state",
        arguments: { filename: "state.json" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("Storage state restored from state.json");
      expect(textFromResult(result)).toContain("await page.context().setStorageState('state.json');");
      expect(getSession().cookiesList).toEqual([{
        name: "restoredCookie",
        value: "restoredValue",
        domain: "example.test",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Lax"
      }]);
      expect(getSession().localStorageItemsList).toEqual([{ name: "restoredKey", value: "restoredValue" }]);
    });
  });

  describe("browser_cookie_list", () => {
    it("shows no cookies when empty like Playwright MCP", async () => {
      const { client } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      const result = await client.callTool({
        name: "browser_cookie_list",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("No cookies found");
      expect(textFromResult(result)).toContain("await page.context().cookies();");
    });

    it("shows cookies like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });
      getSession().cookiesList = [
        {
          name: "cookie1",
          value: "value1",
          domain: "example.test",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax"
        },
        {
          name: "cookie2",
          value: "value2",
          domain: "example.test",
          path: "/admin",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Strict"
        }
      ];

      const result = await client.callTool({
        name: "browser_cookie_list",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("cookie1=value1 (domain: example.test, path: /)");
      expect(textFromResult(result)).toContain("cookie2=value2 (domain: example.test, path: /admin)");
    });

    it("filters by domain and path like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });
      getSession().cookiesList = [
        {
          name: "root",
          value: "one",
          domain: "example.test",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax"
        },
        {
          name: "admin",
          value: "two",
          domain: "admin.example.test",
          path: "/admin",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax"
        }
      ];

      const domainResult = await client.callTool({
        name: "browser_cookie_list",
        arguments: { domain: "admin.example" }
      });
      expect(textFromResult(domainResult)).toContain("admin=two");
      expect(textFromResult(domainResult)).not.toContain("root=one");

      const pathResult = await client.callTool({
        name: "browser_cookie_list",
        arguments: { path: "/admin" }
      });
      expect(textFromResult(pathResult)).toContain("admin=two");
      expect(textFromResult(pathResult)).not.toContain("root=one");

      const emptyResult = await client.callTool({
        name: "browser_cookie_list",
        arguments: { domain: "missing.test" }
      });
      expect(textFromResult(emptyResult)).toContain("No cookies found");
    });
  });

  describe("browser_cookie_get", () => {
    it("gets a cookie by name like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });
      getSession().cookiesList = [
        {
          name: "testCookie",
          value: "testValue",
          domain: "example.test",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Strict"
        }
      ];

      const result = await client.callTool({
        name: "browser_cookie_get",
        arguments: { name: "testCookie" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain(
        "testCookie=testValue (domain: example.test, path: /, httpOnly: true, secure: true, sameSite: Strict)"
      );
      expect(textFromResult(result)).toContain("await page.context().cookies();");
    });

    it("returns not found for a missing cookie like Playwright MCP", async () => {
      const { client } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      const result = await client.callTool({
        name: "browser_cookie_get",
        arguments: { name: "nonexistent" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("Cookie 'nonexistent' not found");
      expect(textFromResult(result)).toContain("await page.context().cookies();");
    });
  });

  describe("browser_cookie_set", () => {
    it("sets a cookie using the active page hostname like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      const result = await client.callTool({
        name: "browser_cookie_set",
        arguments: { name: "testCookie", value: "testValue" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().addCookiesCalls).toEqual([
        {
          name: "testCookie",
          value: "testValue",
          domain: "tools-test.invalid",
          path: "/"
        }
      ]);
      expect(textFromResult(result)).toContain(
        'await page.context().addCookies([{"name":"testCookie","value":"testValue","domain":"tools-test.invalid","path":"/"}]);'
      );

      const getResult = await client.callTool({
        name: "browser_cookie_get",
        arguments: { name: "testCookie" }
      });
      expect(textFromResult(getResult)).toContain("testCookie=testValue");
    });

    it("sets a cookie with all options like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });
      const futureTime = Math.floor(Date.now() / 1000) + 3600;

      const result = await client.callTool({
        name: "browser_cookie_set",
        arguments: {
          name: "fullCookie",
          value: "fullValue",
          path: "/test",
          expires: futureTime,
          httpOnly: true,
          secure: false,
          sameSite: "Lax"
        }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().addCookiesCalls).toEqual([
        {
          name: "fullCookie",
          value: "fullValue",
          domain: "tools-test.invalid",
          path: "/test",
          expires: futureTime,
          httpOnly: true,
          secure: false,
          sameSite: "Lax"
        }
      ]);
      expect(textFromResult(result)).toContain(
        `await page.context().addCookies([{"name":"fullCookie","value":"fullValue","domain":"tools-test.invalid","path":"/test","expires":${futureTime},"httpOnly":true,"secure":false,"sameSite":"Lax"}]);`
      );

      const getResult = await client.callTool({
        name: "browser_cookie_get",
        arguments: { name: "fullCookie" }
      });
      expect(textFromResult(getResult)).toContain("fullCookie=fullValue");
      expect(textFromResult(getResult)).toContain("httpOnly: true");
      expect(textFromResult(getResult)).toContain("sameSite: Lax");
    });
  });

  describe("browser_cookie_delete", () => {
    it("removes a cookie by name like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      await client.callTool({
        name: "browser_cookie_set",
        arguments: { name: "toDelete", value: "deleteMe" }
      });
      expect(textFromResult(await client.callTool({
        name: "browser_cookie_get",
        arguments: { name: "toDelete" }
      }))).toContain("toDelete=deleteMe");

      const result = await client.callTool({
        name: "browser_cookie_delete",
        arguments: { name: "toDelete" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().clearCookiesCalls).toEqual([{ name: "toDelete" }]);
      expect(textFromResult(result)).toContain("await page.context().clearCookies({ name: 'toDelete' });");
      expect(textFromResult(await client.callTool({
        name: "browser_cookie_get",
        arguments: { name: "toDelete" }
      }))).toContain("not found");
    });

    it("does not error for a nonexistent cookie like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      await client.callTool({
        name: "browser_cookie_set",
        arguments: { name: "existing", value: "value" }
      });

      const result = await client.callTool({
        name: "browser_cookie_delete",
        arguments: { name: "nonexistent" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().clearCookiesCalls).toEqual([{ name: "nonexistent" }]);
      expect(textFromResult(await client.callTool({
        name: "browser_cookie_get",
        arguments: { name: "existing" }
      }))).toContain("existing=value");
    });
  });

  describe("browser_cookie_clear", () => {
    it("removes all cookies like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      await client.callTool({
        name: "browser_cookie_set",
        arguments: { name: "cookie1", value: "value1" }
      });
      await client.callTool({
        name: "browser_cookie_set",
        arguments: { name: "cookie2", value: "value2" }
      });

      const beforeClear = await client.callTool({
        name: "browser_cookie_list",
        arguments: {}
      });
      expect(textFromResult(beforeClear)).toContain("cookie1");
      expect(textFromResult(beforeClear)).toContain("cookie2");

      const result = await client.callTool({
        name: "browser_cookie_clear",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().clearCookiesCalls).toEqual([undefined]);
      expect(textFromResult(result)).toContain("await page.context().clearCookies();");

      const afterClear = await client.callTool({
        name: "browser_cookie_list",
        arguments: {}
      });
      expect(textFromResult(afterClear)).toContain("No cookies found");
    });
  });

  describe("browser_localstorage_list", () => {
    it("shows no items when empty like Playwright MCP", async () => {
      const { client } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      const result = await client.callTool({
        name: "browser_localstorage_list",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("No localStorage items found");
      expect(textFromResult(result)).toContain("await page.localStorage.items();");
    });

    it("shows localStorage items like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });
      getSession().localStorageItemsList = [
        { name: "key1", value: "value1" },
        { name: "key2", value: "value2" }
      ];

      const result = await client.callTool({
        name: "browser_localstorage_list",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("key1=value1");
      expect(textFromResult(result)).toContain("key2=value2");
      expect(textFromResult(result)).toContain("await page.localStorage.items();");
    });
  });

  describe("browser_localstorage_get", () => {
    it("gets a localStorage item by key like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });
      getSession().localStorageItemsList = [
        { name: "testKey", value: "testValue" }
      ];

      const result = await client.callTool({
        name: "browser_localstorage_get",
        arguments: { key: "testKey" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("testKey=testValue");
      expect(textFromResult(result)).toContain("await page.localStorage.getItem('testKey');");
    });

    it("returns not found for a missing key like Playwright MCP", async () => {
      const { client } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      const result = await client.callTool({
        name: "browser_localstorage_get",
        arguments: { key: "nonexistent" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("localStorage key 'nonexistent' not found");
      expect(textFromResult(result)).toContain("await page.localStorage.getItem('nonexistent');");
    });
  });

  describe("browser_localstorage_set", () => {
    it("sets a localStorage item like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      const result = await client.callTool({
        name: "browser_localstorage_set",
        arguments: { key: "testKey", value: "testValue" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().setWebStorageItemCalls).toEqual([
        { storageName: "localStorage", key: "testKey", value: "testValue" }
      ]);
      expect(textFromResult(result)).toContain("await page.localStorage.setItem('testKey', 'testValue');");

      const getResult = await client.callTool({
        name: "browser_localstorage_get",
        arguments: { key: "testKey" }
      });
      expect(textFromResult(getResult)).toContain("testKey=testValue");
    });
  });

  describe("browser_localstorage_delete", () => {
    it("removes a localStorage item like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      await client.callTool({
        name: "browser_localstorage_set",
        arguments: { key: "toDelete", value: "deleteMe" }
      });

      const beforeDelete = await client.callTool({
        name: "browser_localstorage_get",
        arguments: { key: "toDelete" }
      });
      expect(textFromResult(beforeDelete)).toContain("toDelete=deleteMe");

      const result = await client.callTool({
        name: "browser_localstorage_delete",
        arguments: { key: "toDelete" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().removeWebStorageItemCalls).toEqual([
        { storageName: "localStorage", key: "toDelete" }
      ]);
      expect(textFromResult(result)).toContain("await page.localStorage.removeItem('toDelete');");

      const afterDelete = await client.callTool({
        name: "browser_localstorage_get",
        arguments: { key: "toDelete" }
      });
      expect(textFromResult(afterDelete)).toContain("localStorage key 'toDelete' not found");
    });
  });

  describe("browser_localstorage_clear", () => {
    it("clears all localStorage items like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      await client.callTool({
        name: "browser_localstorage_set",
        arguments: { key: "key1", value: "value1" }
      });
      await client.callTool({
        name: "browser_localstorage_set",
        arguments: { key: "key2", value: "value2" }
      });

      const result = await client.callTool({
        name: "browser_localstorage_clear",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().clearWebStorageCalls).toEqual([
        { storageName: "localStorage" }
      ]);
      expect(textFromResult(result)).toContain("await page.localStorage.clear();");

      const afterClear = await client.callTool({
        name: "browser_localstorage_list",
        arguments: {}
      });
      expect(textFromResult(afterClear)).toContain("No localStorage items found");
    });
  });

  describe("browser_sessionstorage_list", () => {
    it("is unavailable without storage capability like Playwright MCP", async () => {
      const { client } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_sessionstorage_list",
        arguments: {}
      });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain("Tool browser_sessionstorage_list not found");
    });

    it("shows no items when sessionStorage is empty like Playwright MCP", async () => {
      const { client } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      const result = await client.callTool({
        name: "browser_sessionstorage_list",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("No sessionStorage items found");
      expect(textFromResult(result)).toContain("await page.sessionStorage.items();");
    });

    it("lists sessionStorage items like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });
      getSession().sessionStorageItemsList = [
        { name: "key1", value: "value1" },
        { name: "key2", value: "value2" }
      ];

      const result = await client.callTool({
        name: "browser_sessionstorage_list",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("key1=value1");
      expect(textFromResult(result)).toContain("key2=value2");
      expect(textFromResult(result)).toContain("await page.sessionStorage.items();");
    });
  });

  describe("browser_sessionstorage_get", () => {
    it("gets a sessionStorage item by key like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });
      getSession().sessionStorageItemsList = [
        { name: "testKey", value: "testValue" }
      ];

      const result = await client.callTool({
        name: "browser_sessionstorage_get",
        arguments: { key: "testKey" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("testKey=testValue");
      expect(textFromResult(result)).toContain("await page.sessionStorage.getItem('testKey');");
    });

    it("returns not found for a missing key like Playwright MCP", async () => {
      const { client } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      const result = await client.callTool({
        name: "browser_sessionstorage_get",
        arguments: { key: "nonexistent" }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("sessionStorage key 'nonexistent' not found");
      expect(textFromResult(result)).toContain("await page.sessionStorage.getItem('nonexistent');");
    });
  });

  describe("browser_sessionstorage_set", () => {
    it("sets a sessionStorage item like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      const result = await client.callTool({
        name: "browser_sessionstorage_set",
        arguments: { key: "testKey", value: "testValue" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().setWebStorageItemCalls).toEqual([
        { storageName: "sessionStorage", key: "testKey", value: "testValue" }
      ]);
      expect(textFromResult(result)).toContain("await page.sessionStorage.setItem('testKey', 'testValue');");

      const getResult = await client.callTool({
        name: "browser_sessionstorage_get",
        arguments: { key: "testKey" }
      });
      expect(textFromResult(getResult)).toContain("testKey=testValue");
    });
  });

  describe("browser_sessionstorage_delete", () => {
    it("removes a sessionStorage item like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      await client.callTool({
        name: "browser_sessionstorage_set",
        arguments: { key: "toDelete", value: "deleteMe" }
      });

      const beforeDelete = await client.callTool({
        name: "browser_sessionstorage_get",
        arguments: { key: "toDelete" }
      });
      expect(textFromResult(beforeDelete)).toContain("toDelete=deleteMe");

      const result = await client.callTool({
        name: "browser_sessionstorage_delete",
        arguments: { key: "toDelete" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().removeWebStorageItemCalls).toEqual([
        { storageName: "sessionStorage", key: "toDelete" }
      ]);
      expect(textFromResult(result)).toContain("await page.sessionStorage.removeItem('toDelete');");

      const afterDelete = await client.callTool({
        name: "browser_sessionstorage_get",
        arguments: { key: "toDelete" }
      });
      expect(textFromResult(afterDelete)).toContain("sessionStorage key 'toDelete' not found");
    });
  });

  describe("browser_sessionstorage_clear", () => {
    it("clears all sessionStorage items like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({
        capabilities: ["storage"]
      });

      await client.callTool({
        name: "browser_sessionstorage_set",
        arguments: { key: "key1", value: "value1" }
      });
      await client.callTool({
        name: "browser_sessionstorage_set",
        arguments: { key: "key2", value: "value2" }
      });

      const result = await client.callTool({
        name: "browser_sessionstorage_clear",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().clearWebStorageCalls).toEqual([
        { storageName: "sessionStorage" }
      ]);
      expect(textFromResult(result)).toContain("await page.sessionStorage.clear();");

      const afterClear = await client.callTool({
        name: "browser_sessionstorage_list",
        arguments: {}
      });
      expect(textFromResult(afterClear)).toContain("No sessionStorage items found");
    });
  });

  describe("browser_reload", () => {
    it("calls session.reload and returns Playwright-style output", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_reload",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().reloadCount).toBe(1);
      expect(textFromResult(result)).toContain("await page.reload();");
      expect(textFromResult(result)).toContain("### Snapshot");
    });
  });

  describe("browser_resize", () => {
    it("returns Playwright-style resize output", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: fakeSessionFactory,
        snapshotMode: "none"
      });
      cleanupCallbacks.push(async () => bundle.close());
      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);
      await client.callTool({
        name: "roxy_browser_connect",
        arguments: { endpoint: "ws://resize.invalid/devtools/browser/1" }
      });

      const result = await client.callTool({
        name: "browser_resize",
        arguments: { width: 1280, height: 720 }
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain("await page.setViewportSize({ width: 1280, height: 720 });");
      expect(text).not.toContain("Resized viewport to 1280x720.");
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
      const text = textFromResult(result);
      expect(text).toContain("Waited for button");
      expect(text).toContain("await page.getByText(\"button\").first().waitFor({ state: 'visible' });");
      expect(text).toContain("### Snapshot");
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

    it("shows Playwright-style wait code for a time delay", async () => {
      const { client } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_wait_for",
        arguments: { time: 2 }
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain("Waited for 2");
      expect(text).toContain("await new Promise(f => setTimeout(f, 2 * 1000));");
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
      expect(text).toMatch(new RegExp(`${screenshotsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.+page-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.png`));
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

    it("infers jpeg screenshot type from the filename extension", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: { filename: "screen.jpeg" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().screenshotCalls[0]!.type).toBe("jpeg");
    });

    it("passes Playwright default jpeg quality to screenshot calls and code", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: { type: "jpeg" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().screenshotCalls[0]).toMatchObject({
        type: "jpeg",
        quality: 90
      });
      expect(textFromResult(result)).toContain("quality: 90");
    });

    it("returns webp screenshots when type is requested", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: { type: "webp" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().screenshotCalls[0]!.type).toBe("webp");
      const imageItems = (result.content as Array<{ type: string; data?: string; mimeType?: string }>)
        .filter((item) => item.type === "image");
      expect(imageItems[0]!.mimeType).toBe("image/webp");
      expect(textFromResult(result)).toContain(".webp");
    });

    it("omits screenshot image attachments when imageResponses is omit like Playwright MCP", async () => {
      const { client } = await setupTrackingClient({ imageResponses: "omit" });

      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toContain("await page.screenshot");
      const imageItems = (result.content as Array<{ type: string }>)
        .filter((item) => item.type === "image");
      expect(imageItems).toEqual([]);
    });

    it("infers webp screenshot type from the filename extension", async () => {
      const { client, getSession } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: { filename: "screen.webp" }
      });

      expect(result.isError).toBeUndefined();
      expect(getSession().screenshotCalls[0]!.type).toBe("webp");
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
      expect(text).toMatch(new RegExp(`${screenshotsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.+page-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.png`));
      const imageItems = (result.content as Array<{ type: string; data?: string; mimeType?: string }>)
        .filter((item) => item.type === "image");
      expect(imageItems.length).toBe(1);
    });

    it("auto-generates element screenshot filenames with the Playwright prefix", async () => {
      const screenshotsDir = await mkdtemp(join(tmpdir(), "roxy-screenshot-element-"));
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
      await client.callTool({ name: "browser_snapshot", arguments: {} });

      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: {
          element: "hello button",
          target: "e1"
        }
      });

      expect(result.isError).toBeUndefined();
      expect(textFromResult(result)).toMatch(new RegExp(`${screenshotsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.+element-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.png`));
    });

    it("calls session.screenshot", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({ name: "browser_take_screenshot", arguments: {} });

      expect(getSession().screenshotCount).toBe(1);
    });

    it("passes the Playwright MCP screenshot scale option to the session", async () => {
      const { client, getSession } = await setupTrackingClient();

      await client.callTool({ name: "browser_take_screenshot", arguments: {} });
      await client.callTool({
        name: "browser_take_screenshot",
        arguments: { scale: "device" }
      });

      expect(getSession().screenshotCalls.map((call) => call.scale)).toEqual(["css", "device"]);
    });

    it("includes Playwright-style screenshot code with options", async () => {
      const { client } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: { fullPage: true, scale: "device" }
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain("// Screenshot full page and save it as");
      expect(text).toContain("await page.screenshot");
      expect(text).toContain("fullPage: true");
      expect(text).toContain("scale: 'device'");
    });

    it("includes Playwright-style element screenshot code", async () => {
      const { client } = await setupTrackingClient();
      await client.callTool({ name: "browser_snapshot", arguments: {} });

      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: {
          element: "hello button",
          target: "e1"
        }
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain("// Screenshot hello button and save it as");
      expect(text).toContain("await page.locator('aria-ref=e1').screenshot");
      expect(text).toContain("type: 'png'");
      expect(text).toContain("scale: 'css'");
      expect(text).toContain("path:");
    });

    it("errors when fullPage is used with an element screenshot", async () => {
      const { client, getSession } = await setupTrackingClient();
      await client.callTool({ name: "browser_snapshot", arguments: {} });

      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: {
          fullPage: true,
          element: "hello button",
          target: "e1"
        }
      });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain("fullPage cannot be used with element screenshots");
      expect(getSession().screenshotCalls).toEqual([]);
    });
  });

  describe("browser_pdf_save", () => {
    it("is unavailable without the pdf capability like Playwright MCP", async () => {
      const { client } = await setupTrackingClient();

      const result = await client.callTool({
        name: "browser_pdf_save",
        arguments: {}
      });

      expect(result.isError).toBe(true);
      expect(textFromResult(result)).toContain("Tool browser_pdf_save not found");
    });

    it("saves page PDF with a requested filename like Playwright MCP", async () => {
      const artifactsDir = await mkdtemp(join(tmpdir(), "roxy-pdf-"));
      cleanupCallbacks.push(async () => rm(artifactsDir, { recursive: true, force: true }));
      const { client, getSession } = await setupTrackingClient({
        artifactsDir,
        capabilities: ["pdf"]
      });

      const result = await client.callTool({
        name: "browser_pdf_save",
        arguments: { filename: "output.pdf" }
      });

      const resolvedFilename = join(artifactsDir, "output.pdf");
      expect(result.isError).toBeUndefined();
      expect(getSession().pdfCalls).toBe(1);
      await expect(readFile(resolvedFilename, "utf8")).resolves.toBe("%PDF-fake");
      expect(textFromResult(result)).toContain(`[Page as pdf](${resolvedFilename})`);
      expect(textFromResult(result)).toContain(`await page.pdf({ path: '${resolvedFilename}' });`);
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

    it("shows Playwright-style code for uploading files", async () => {
      const { client } = await setupTrackingClient();

      await client.callTool({
        name: "browser_click",
        arguments: { target: "input[type=file]" }
      });

      const result = await client.callTool({
        name: "browser_file_upload",
        arguments: { paths: ["/tmp/file.txt"] }
      });

      expect(result.isError).toBeUndefined();
      const text = textFromResult(result);
      expect(text).toContain("await fileChooser.setFiles([\"/tmp/file.txt\"])");
      expect(text).not.toContain("Uploaded 1 file(s).");
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
      expect(textFromResult(result)).not.toContain("await fileChooser.setFiles(undefined)");
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

    it("saves binary response-body parts to a file like Playwright MCP", async () => {
      const networkDir = await mkdtemp(join(tmpdir(), "roxy-network-binary-"));
      cleanupCallbacks.push(async () => rm(networkDir, { recursive: true, force: true }));
      const { client, getSession } = await setupTrackingClient({ networkDir });
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      getSession().networkRequestsList.push({
        index: 1,
        requestId: "request-image",
        method: "GET",
        url: "https://example.test/image.png",
        resourceType: "image",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: { "content-type": "image/png" },
        responseBodyBase64: pngBytes.toString("base64"),
        mimeType: "image/png"
      });

      const result = await client.callTool({
        name: "browser_network_request",
        arguments: { index: 1, part: "response-body" }
      });

      expect(result.isError).toBeUndefined();
      const bodyPath = textFromResult(result).trim();
      expect(bodyPath).toMatch(/response-body-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.png$/);
      expect(await readFile(bodyPath)).toEqual(pngBytes);
    });

    it("saves lazily fetched binary response-body parts to a file like Playwright MCP", async () => {
      const networkDir = await mkdtemp(join(tmpdir(), "roxy-network-lazy-binary-"));
      cleanupCallbacks.push(async () => rm(networkDir, { recursive: true, force: true }));
      const { client, getSession } = await setupTrackingClient({ networkDir });
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      getSession().networkRequestsList.push({
        index: 1,
        requestId: "request-lazy-image",
        method: "GET",
        url: "https://example.test/lazy-image.png",
        resourceType: "image",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: { "content-type": "image/png" },
        mimeType: "image/png"
      });
      const originalNetworkRequest = getSession().networkRequest.bind(getSession());
      getSession().networkRequest = async (index: number) => {
        const request = await originalNetworkRequest(index);
        if (!request) {
          return undefined;
        }
        const { responseBodyBase64: _responseBodyBase64, ...withoutBody } = request;
        return withoutBody;
      };
      getSession().fetchResponseBody = async () => ({
        base64: pngBytes.toString("base64")
      });

      const result = await client.callTool({
        name: "browser_network_request",
        arguments: { index: 1, part: "response-body" }
      });

      expect(result.isError).toBeUndefined();
      const bodyPath = textFromResult(result).trim();
      expect(bodyPath).toMatch(/response-body-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.png$/);
      expect(await readFile(bodyPath)).toEqual(pngBytes);
    });

    it("uses the Playwright-style static hint when skill mode is enabled", async () => {
      const { client, getSession } = await setupTrackingClient({ skillMode: true });
      getSession().networkRequestsList.push({
        index: 1,
        requestId: "request-static",
        method: "GET",
        url: "https://example.test/image.png",
        resourceType: "image",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: { "content-type": "image/png" }
      });

      const list = await client.callTool({
        name: "browser_network_requests",
        arguments: {}
      });

      expect(list.isError).toBeUndefined();
      expect(textFromResult(list)).toContain('run with --static option to see it');
      expect(textFromResult(list)).not.toContain('"static"');
    });

    it("uses Playwright skill-mode part hints in request details", async () => {
      const { client, getSession } = await setupTrackingClient({ skillMode: true });
      getSession().networkRequestsList.push({
        index: 1,
        requestId: "request-a",
        method: "POST",
        url: "https://example.test/api",
        resourceType: "fetch",
        requestHeaders: { "content-type": "application/json" },
        requestBody: '{"hello":true}',
        status: 200,
        statusText: "OK",
        responseHeaders: { "content-type": "application/json" },
        responseBody: '{"ok":true}',
        mimeType: "application/json"
      });

      const details = await client.callTool({
        name: "browser_network_request",
        arguments: { index: 1 }
      });

      expect(details.isError).toBeUndefined();
      const text = textFromResult(details);
      expect(text).toContain("Run `request-body 1` to read the request body.");
      expect(text).toContain("Run `response-body 1` to read the response body.");
      expect(text).not.toContain('part="request-body"');
    });

    it("clears network requests like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient();
      getSession().networkRequestsList.push({
        index: 1,
        requestId: "request-a",
        method: "GET",
        url: "https://example.test/api",
        resourceType: "fetch",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: {}
      });

      const clear = await client.callTool({
        name: "browser_network_clear",
        arguments: {}
      });
      const list = await client.callTool({
        name: "browser_network_requests",
        arguments: {}
      });

      expect(clear.isError).toBeUndefined();
      expect(textFromResult(list)).not.toContain("https://example.test/api");
    });

    it("sets network offline and online like Playwright MCP", async () => {
      const { client, getSession } = await setupTrackingClient({ capabilities: ["network"] });

      const offline = await client.callTool({
        name: "browser_network_state_set",
        arguments: { state: "offline" }
      });
      const online = await client.callTool({
        name: "browser_network_state_set",
        arguments: { state: "online" }
      });

      expect(offline.isError).toBeUndefined();
      expect(online.isError).toBeUndefined();
      expect(textFromResult(offline)).toContain("Network is now offline");
      expect(textFromResult(offline)).toContain("await page.context().setOffline(true);");
      expect(textFromResult(online)).toContain("Network is now online");
      expect(textFromResult(online)).toContain("await page.context().setOffline(false);");
      expect(getSession().offlineCalls).toEqual([true, false]);
    });

    it("lists and removes Playwright MCP network routes", async () => {
      const { client } = await setupTrackingClient({ capabilities: ["network"] });

      const emptyList = await client.callTool({
        name: "browser_route_list",
        arguments: {}
      });

      expect(emptyList.isError).toBeUndefined();
      expect(textFromResult(emptyList)).toContain("No active routes");

      const usersRoute = await client.callTool({
        name: "browser_route",
        arguments: {
          pattern: "**/api/users",
          status: 200,
          body: "[]"
        }
      });
      const postsRoute = await client.callTool({
        name: "browser_route",
        arguments: {
          pattern: "**/api/posts",
          status: 201,
          contentType: "application/json"
        }
      });

      expect(usersRoute.isError).toBeUndefined();
      expect(postsRoute.isError).toBeUndefined();
      expect(textFromResult(usersRoute)).toContain("Route added for pattern: **/api/users");
      expect(textFromResult(usersRoute)).toContain("await page.context().route('**/api/users', async route => { /* route handler */ });");

      const list = await client.callTool({
        name: "browser_route_list",
        arguments: {}
      });

      expect(list.isError).toBeUndefined();
      expect(textFromResult(list)).toContain("1. **/api/users (status=200, body=[])");
      expect(textFromResult(list)).toContain("2. **/api/posts (status=201, contentType=application/json)");

      const removeUsers = await client.callTool({
        name: "browser_unroute",
        arguments: { pattern: "**/api/users" }
      });
      const afterSpecificRemove = await client.callTool({
        name: "browser_route_list",
        arguments: {}
      });

      expect(removeUsers.isError).toBeUndefined();
      expect(textFromResult(removeUsers)).toContain("Removed 1 route(s) for pattern: **/api/users");
      expect(textFromResult(afterSpecificRemove)).not.toContain("**/api/users");
      expect(textFromResult(afterSpecificRemove)).toContain("**/api/posts");

      const removeAll = await client.callTool({
        name: "browser_unroute",
        arguments: {}
      });

      expect(removeAll.isError).toBeUndefined();
      expect(textFromResult(removeAll)).toContain("Removed all 1 route(s)");
    });

    it("truncates data URL payloads in list and detail output", async () => {
      const { client, getSession } = await setupTrackingClient();
      const payload = "x".repeat(200);
      getSession().networkRequestsList.push({
        index: 1,
        requestId: "request-data",
        method: "GET",
        url: `data:text/html,${payload}`,
        resourceType: "document",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        responseHeaders: { "content-type": "text/html" },
        responseBody: "<html></html>",
        mimeType: "text/html"
      });

      const list = await client.callTool({
        name: "browser_network_requests",
        arguments: { static: true }
      });
      const details = await client.callTool({
        name: "browser_network_request",
        arguments: { index: 1 }
      });

      expect(list.isError).toBeUndefined();
      expect(details.isError).toBeUndefined();
      expect(textFromResult(list)).toContain("1. [GET] data:text/html,\u2026 => [200] OK");
      expect(textFromResult(details)).toContain("#1 [GET] data:text/html,\u2026");
      expect(textFromResult(list)).not.toContain(payload);
      expect(textFromResult(details)).not.toContain(payload);
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

  describe("browser tracing tools", () => {
    it("matches Playwright MCP tracing start and stop state", async () => {
      const tracesDir = await mkdtemp(join(tmpdir(), "roxy-mcp-traces-"));
      cleanupCallbacks.push(async () => rm(tracesDir, { recursive: true, force: true }));
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: fakeSessionFactory,
        capabilities: ["devtools"],
        tracesDir
      });
      cleanupCallbacks.push(async () => bundle.close());
      const client = createClient();
      cleanupCallbacks.push(async () => client.close());
      await client.connect(bundle.clientTransport);

      const stopBeforeStart = await client.callTool({
        name: "browser_stop_tracing",
        arguments: {}
      });
      expect(stopBeforeStart.isError).toBe(true);
      expect(textFromResult(stopBeforeStart)).toContain("Tracing is not started");

      const start = await client.callTool({
        name: "browser_start_tracing",
        arguments: {}
      });
      expect(start.isError).toBeUndefined();
      const startText = textFromResult(start);
      expect(startText).toContain("Trace recording started");
      expect(startText).toContain("- [Action log](");
      expect(startText).toContain("- [Network log](");
      expect(startText).toContain("- [Resources](");

      const stop = await client.callTool({
        name: "browser_stop_tracing",
        arguments: {}
      });
      expect(stop.isError).toBeUndefined();
      const stopText = textFromResult(stop);
      expect(stopText).toContain("Trace recording stopped.");
      expect(stopText).toContain("- [Trace](");
      expect(stopText).toContain("- [Network log](");
      expect(stopText).toContain("- [Resources](");

      const files = await readdir(tracesDir, { recursive: true });
      expect(files.some((file) => String(file).endsWith(".trace"))).toBe(true);
      expect(files.some((file) => String(file).endsWith(".network"))).toBe(true);
      expect(files.some((file) => String(file).endsWith(".stacks"))).toBe(true);
    });
  });

  describe("browser verify tools", () => {
    it("verifies visible elements by role and accessible name like Playwright MCP", async () => {
      const { client } = await setupTrackingClient({ capabilities: ["testing"] });

      const visible = await client.callTool({
        name: "browser_verify_element_visible",
        arguments: { role: "button", accessibleName: "ws://tools-test.invalid/devtools/browser/1 home" }
      });
      const missing = await client.callTool({
        name: "browser_verify_element_visible",
        arguments: { role: "button", accessibleName: "not on page" }
      });

      expect(visible.isError).toBeUndefined();
      expect(textFromResult(visible)).toContain("Done");
      expect(textFromResult(visible)).toContain("await expect(page.getByRole('button', { name: 'ws://tools-test.invalid/devtools/browser/1 home' })).toBeVisible();");
      expect(missing.isError).toBe(true);
      expect(textFromResult(missing)).toContain('Element with role "button" and accessible name "not on page" not found');
    });

    it("verifies visible text using text locator semantics like Playwright MCP", async () => {
      const { client } = await setupTrackingClient({ capabilities: ["testing"] });

      const visible = await client.callTool({
        name: "browser_verify_text_visible",
        arguments: { text: "home" }
      });
      const missing = await client.callTool({
        name: "browser_verify_text_visible",
        arguments: { text: "not on page" }
      });

      expect(visible.isError).toBeUndefined();
      expect(textFromResult(visible)).toContain("Done");
      expect(textFromResult(visible)).toContain("await expect(page.getByText('home').filter({ visible: true })).toBeVisible();");
      expect(missing.isError).toBe(true);
      expect(textFromResult(missing)).toContain("Text not found");
    });

    it("verifies list items using the target locator like Playwright MCP", async () => {
      const { client } = await setupTrackingClient({ capabilities: ["testing"] });

      const visible = await client.callTool({
        name: "browser_verify_list_visible",
        arguments: {
          element: "shopping list",
          target: "#groceries",
          items: ["Apples", "Bananas"]
        }
      });
      const missing = await client.callTool({
        name: "browser_verify_list_visible",
        arguments: {
          element: "shopping list",
          target: "#groceries",
          items: ["Dragonfruit"]
        }
      });

      expect(visible.isError).toBeUndefined();
      expect(textFromResult(visible)).toContain("await expect(page.locator('body')).toMatchAriaSnapshot(`");
      expect(textFromResult(visible)).toContain("- listitem: \"Apples\"");
      expect(missing.isError).toBe(true);
      expect(textFromResult(missing)).toContain('Item "Dragonfruit" not found');
    });

    it("verifies values using the target locator like Playwright MCP", async () => {
      const { client } = await setupTrackingClient({ capabilities: ["testing"] });

      const textbox = await client.callTool({
        name: "browser_verify_value",
        arguments: {
          type: "textbox",
          element: "Email",
          target: "#email",
          value: "user@example.test"
        }
      });
      const checkbox = await client.callTool({
        name: "browser_verify_value",
        arguments: {
          type: "checkbox",
          element: "Subscribed",
          target: "#checked",
          value: "true"
        }
      });
      const missing = await client.callTool({
        name: "browser_verify_value",
        arguments: {
          type: "textbox",
          element: "Email",
          target: "#email",
          value: "wrong"
        }
      });

      expect(textbox.isError).toBeUndefined();
      expect(textFromResult(textbox)).toContain("await expect(page.locator('#email')).toHaveValue('user@example.test');");
      expect(checkbox.isError).toBeUndefined();
      expect(textFromResult(checkbox)).toContain("await expect(page.locator('#checked')).toBeChecked();");
      expect(missing.isError).toBe(true);
      expect(textFromResult(missing)).toContain('Expected value "wrong", but got "user@example.test"');
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

    it("uses the configured Playwright MCP settle timeout around action completion", async () => {
      const bundle = await createRoxyBrowserMcpInMemory({
        sessionFactory: async (args) => new ImageRequestSession(args),
        timeouts: { settle: 125 }
      });
      const client = createClient("configured-settle-timeout-client");
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
      expect(session.waitForPageTimeoutCalls).toEqual([125, 125]);
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
