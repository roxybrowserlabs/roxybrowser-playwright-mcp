import { afterEach, describe, expect, it, vi } from "vitest";

const { chromeRemoteInterfaceMock } = vi.hoisted(() => ({
  chromeRemoteInterfaceMock: Object.assign(vi.fn(), {
    Version: vi.fn()
  })
}));

vi.mock("chrome-remote-interface", () => ({
  default: chromeRemoteInterfaceMock
}));

import { CdpBrowserAdapterFactory } from "../../src/protocol/cdp/backend.js";
import { RoxyPage } from "../../src/page.js";

type Listener = (...args: any[]) => void;

function createCdpClientStub() {
  const listeners = new Map<string, Set<Listener>>();
  let logEntryAddedListener: Listener | undefined;

  const client = {
    on: vi.fn((event: string, listener: Listener) => {
      const eventListeners = listeners.get(event) ?? new Set<Listener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    }),
    removeListener: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    }),
    emit(event: string, payload?: unknown) {
      for (const listener of Array.from(listeners.get(event) ?? [])) {
        listener(payload);
      }
    },
    close: vi.fn(async () => {}),
    send: vi.fn(async (_method: string) => ({})),
    Target: {
      createBrowserContext: vi.fn(async () => ({ browserContextId: "ctx-1" })),
      createTarget: vi.fn(async () => ({ targetId: "target-1" })),
      activateTarget: vi.fn(async () => ({})),
      closeTarget: vi.fn(async () => ({})),
      disposeBrowserContext: vi.fn(async () => ({})),
      getTargets: vi.fn(async () => ({ targetInfos: [] })),
      setDiscoverTargets: vi.fn(async () => ({})),
      targetCreated: vi.fn()
    },
    Page: {
      enable: vi.fn(async () => ({})),
      setLifecycleEventsEnabled: vi.fn(async () => ({})),
      domContentEventFired: vi.fn(),
      javascriptDialogOpening: vi.fn(),
      navigatedWithinDocument: vi.fn(),
      frameNavigated: vi.fn(),
      frameStoppedLoading: vi.fn(),
      loadEventFired: vi.fn(),
      bringToFront: vi.fn(async () => ({})),
      screencastFrame: vi.fn(),
      screencastFrameAck: vi.fn(async () => ({}))
    },
    Runtime: {
      enable: vi.fn(async () => ({})),
      consoleAPICalled: vi.fn(),
      evaluate: vi.fn(async () => ({
        result: {
          type: "string",
          value: "about:blank"
        }
      })),
      exceptionThrown: vi.fn()
    },
    DOM: {
      enable: vi.fn(async () => ({}))
    },
    Log: {
      enable: vi.fn(async () => ({})),
      entryAdded: vi.fn((listener: Listener) => {
        logEntryAddedListener = listener;
      })
    },
    Network: {
      enable: vi.fn(async () => ({})),
      requestWillBeSent: vi.fn(),
      requestWillBeSentExtraInfo: vi.fn(),
      requestServedFromCache: vi.fn(),
      responseReceived: vi.fn(),
      responseReceivedExtraInfo: vi.fn(),
      loadingFinished: vi.fn(),
      loadingFailed: vi.fn()
    },
    Input: {
      dispatchKeyEvent: vi.fn(async () => ({})),
      dispatchMouseEvent: vi.fn(async () => ({})),
      insertText: vi.fn(async () => ({}))
    },
    emitLogEntryAdded(payload: unknown) {
      logEntryAddedListener?.(payload);
    }
  };

  return client;
}

async function createCdpPageClients() {
  const browserClient = createCdpClientStub();
  const pageClient = createCdpClientStub();

  chromeRemoteInterfaceMock.mockImplementation(async (options?: { target?: string }) => {
    if (options?.target === "ws://127.0.0.1:9222/devtools/browser/example") {
      return browserClient;
    }
    return pageClient;
  });
  chromeRemoteInterfaceMock.Version.mockResolvedValue({
    Browser: "Chrome/123.0.0.0",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/example"
  });

  const adapter = new CdpBrowserAdapterFactory().create({
    browserName: "chromium",
    protocol: "cdp",
    wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/example"
  });
  await adapter.connect();
  const browser = await adapter.browser();
  const context = await browser.newContext();
  const page = await context.newPage();

  return {
    browserClient,
    page,
    pageClient
  };
}

describe("CDP coverage", () => {
  afterEach(() => {
    vi.useRealTimers();
    chromeRemoteInterfaceMock.mockReset();
    chromeRemoteInterfaceMock.Version.mockReset();
  });

  it("still cleans up the spawned browser connection when client.close hangs", async () => {
    vi.useFakeTimers();

    const unregisterTestBrowserProcess = vi.fn();
    const adapter = new CdpBrowserAdapterFactory().create({
      browserName: "chromium",
      protocol: "cdp",
      wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/example"
    }) as {
      close(): Promise<void>;
      state?: {
        browserClient: {
          close(): Promise<void>;
        };
        version: {
          Browser: string;
        };
        connection: {
          browserWsEndpoint: string;
          host: string;
          port: number;
          unregisterTestBrowserProcess?: () => void;
        };
      };
    };

    adapter.state = {
      browserClient: {
        close: vi.fn(() => new Promise<void>(() => {}))
      },
      version: {
        Browser: "Chrome/123.0.0.0"
      },
      connection: {
        browserWsEndpoint: "ws://127.0.0.1:9222/devtools/browser/example",
        host: "127.0.0.1",
        port: 9222,
        unregisterTestBrowserProcess
      }
    };

    const closePromise = adapter.close();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(closePromise).resolves.toBeUndefined();
    expect(unregisterTestBrowserProcess).toHaveBeenCalledTimes(1);
    expect(adapter.state).toBeUndefined();
  });

  it("dispatches requestGC through HeapProfiler.collectGarbage", async () => {
    const { page, pageClient } = await createCdpPageClients();

    await page.requestGC();

    expect(pageClient.send).toHaveBeenCalledWith("HeapProfiler.collectGarbage");
  });

  it("uses keyboard events instead of insertText for modified printable keys", async () => {
    const { pageClient } = await createCdpPageClients();
    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.CdpConnectedBrowserSession.prototype) as {
      getActivePageClient(): Promise<typeof pageClient>;
      getActiveTabId(): Promise<string>;
      bringTabToFront(tabId: string): Promise<void>;
      pressedKeyboardModifiers: Set<string>;
      pressedKeyboardCodes: Set<string>;
      pressKey(
        key: string,
        modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">
      ): Promise<void>;
    };
    session.getActivePageClient = async () => pageClient;
    session.getActiveTabId = async () => "tab-1";
    session.bringTabToFront = async () => {};
    session.pressedKeyboardModifiers = new Set();
    session.pressedKeyboardCodes = new Set();

    await session.pressKey("a", ["ControlOrMeta"]);

    expect(pageClient.Input.insertText).not.toHaveBeenCalled();
    expect(pageClient.Input.dispatchKeyEvent).toHaveBeenCalledTimes(4);
    expect(pageClient.Input.dispatchKeyEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: "rawKeyDown"
    }));
    expect(pageClient.Input.dispatchKeyEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      key: "a",
      code: "KeyA"
    }));
  });

  it("navigates MCP CDP sessions back through navigation history like Playwright", async () => {
    const { pageClient } = await createCdpPageClients();
    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.CdpConnectedBrowserSession.prototype) as {
      getActivePageClient(): Promise<typeof pageClient>;
      goBack(): Promise<void>;
    };
    session.getActivePageClient = async () => pageClient;
    pageClient.Page.getNavigationHistory = vi.fn(async () => ({
      currentIndex: 1,
      entries: [
        { id: 10, url: "https://example.test/first" },
        { id: 20, url: "https://example.test/second" }
      ]
    }));
    pageClient.Page.navigateToHistoryEntry = vi.fn(async () => ({}));

    await session.goBack();

    expect(pageClient.Page.getNavigationHistory).toHaveBeenCalledTimes(1);
    expect(pageClient.Page.navigateToHistoryEntry).toHaveBeenCalledWith({ entryId: 10 });
  });

  it("executes humanized typing plans through keyboard events and insertText", async () => {
    const { page, pageClient } = await createCdpPageClients();

    await page.keyboardType("ignored", {
      __roxyTypingPlan: [
        { type: "char", value: "a", delay: 0 },
        { type: "backspace", delay: 0 },
        { type: "char", value: "指", delay: 0 }
      ]
    } as never);

    expect(pageClient.Input.dispatchKeyEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "keyDown",
      key: "a"
    }));
    expect(pageClient.Input.dispatchKeyEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "rawKeyDown",
      key: "Backspace"
    }));
    expect(pageClient.Input.insertText).toHaveBeenCalledWith({ text: "指" });
  });

  it("emits browser log entries as Playwright-style console events", async () => {
    const { page, pageClient } = await createCdpPageClients();
    const roxyPage = new RoxyPage(page, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    const messagePromise = roxyPage.waitForEvent("console");
    pageClient.emitLogEntryAdded({
      entry: {
        level: "error",
        lineNumber: 12,
        source: "network",
        text: "Access to fetch at 'https://example.com' from origin 'null' has been blocked by CORS policy",
        timestamp: 1700000000000,
        url: "https://example.com/"
      }
    });

    const message = await messagePromise;
    expect(message.type()).toBe("error");
    expect(message.text()).toContain("blocked by CORS policy");
    expect(message.location()).toEqual({
      url: "https://example.com/",
      line: 12,
      lineNumber: 12,
      column: 0,
      columnNumber: 0
    });
    expect(message.timestamp()).toBe(1700000000000);
    expect(message.args()).toEqual([]);
    expect(pageClient.Log.enable).toHaveBeenCalledWith();
  });

  it("collects JS coverage with parsed script sources and ignores anonymous scripts by default", async () => {
    const { page, pageClient } = await createCdpPageClients();

    pageClient.send.mockImplementation(async (method: string, params?: any) => {
      if (method === "Debugger.getScriptSource") {
        return {
          scriptSource: params?.scriptId === "script-1" ? "console.log('ok')" : "anonymous()"
        };
      }
      if (method === "Profiler.takePreciseCoverage") {
        return {
          result: [
            {
              url: "https://example.com/app.js",
              scriptId: "script-1",
              functions: [
                {
                  functionName: "run",
                  isBlockCoverage: true,
                  ranges: [{ startOffset: 0, endOffset: 17, count: 1 }]
                }
              ]
            },
            {
              url: "",
              scriptId: "script-2",
              functions: []
            }
          ]
        };
      }
      return {};
    });

    await page.startJSCoverage();
    pageClient.emit("Debugger.scriptParsed", {
      scriptId: "script-1",
      url: "https://example.com/app.js"
    });
    pageClient.emit("Debugger.scriptParsed", {
      scriptId: "script-2",
      url: ""
    });
    await Promise.resolve();
    await Promise.resolve();

    const coverage = await page.stopJSCoverage();

    expect(coverage).toEqual([
      {
        url: "https://example.com/app.js",
        scriptId: "script-1",
        source: "console.log('ok')",
        functions: [
          {
            functionName: "run",
            isBlockCoverage: true,
            ranges: [{ startOffset: 0, endOffset: 17, count: 1 }]
          }
        ]
      }
    ]);
    expect(pageClient.send).toHaveBeenCalledWith("Profiler.startPreciseCoverage", {
      callCount: true,
      detailed: true
    });
    expect(pageClient.send).toHaveBeenCalledWith("Debugger.getScriptSource", {
      scriptId: "script-1"
    });
  });

  it("collects CSS coverage and preserves tracked sheets when resetOnNavigation is false", async () => {
    const { page, pageClient } = await createCdpPageClients();

    pageClient.send.mockImplementation(async (method: string, params?: any) => {
      if (method === "CSS.getStyleSheetText") {
        return {
          text: "body { color: red; }"
        };
      }
      if (method === "CSS.stopRuleUsageTracking") {
        return {
          ruleUsage: [
            {
              styleSheetId: "sheet-1",
              startOffset: 0,
              endOffset: 5,
              used: true
            },
            {
              styleSheetId: "sheet-1",
              startOffset: 5,
              endOffset: 12,
              used: true
            },
            {
              styleSheetId: "sheet-1",
              startOffset: 12,
              endOffset: 18,
              used: false
            }
          ]
        };
      }
      return {};
    });

    await page.startCSSCoverage({ resetOnNavigation: false });
    pageClient.emit("CSS.styleSheetAdded", {
      header: {
        styleSheetId: "sheet-1",
        sourceURL: "https://example.com/app.css"
      }
    });
    pageClient.emit("Runtime.executionContextsCleared");
    await Promise.resolve();
    await Promise.resolve();

    const coverage = await page.stopCSSCoverage();

    expect(coverage).toEqual([
      {
        url: "https://example.com/app.css",
        text: "body { color: red; }",
        ranges: [{ start: 0, end: 12 }]
      }
    ]);
    expect(pageClient.send).toHaveBeenCalledWith("CSS.startRuleUsageTracking");
    expect(pageClient.send).toHaveBeenCalledWith("CSS.getStyleSheetText", {
      styleSheetId: "sheet-1"
    });
  });

  it("treats served-from-cache responses like Playwright extra-info tracking", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.CdpConnectedBrowserSession.prototype) as {
      pageNetworkStates: Map<string, any>;
      completionCollectorsByTabId: Map<string, Set<{ requests: any[] }>>;
      installNetworkCollection(tabId: string, client: ReturnType<typeof createCdpClientStub>): void;
      networkRequests(): Promise<any[]>;
      getActiveTabId(): Promise<string>;
      hydratePerformanceResourceRequests(tabId: string): Promise<void>;
    };

    const pageClient = createCdpClientStub();
    const requestWillBeSentListener = vi.fn();
    const requestWillBeSentExtraInfoListener = vi.fn();
    const requestServedFromCacheListener = vi.fn();
    const responseReceivedListener = vi.fn();
    const responseReceivedExtraInfoListener = vi.fn();
    const loadingFinishedListener = vi.fn();

    pageClient.Network.requestWillBeSent.mockImplementation((listener: Listener) => {
      requestWillBeSentListener.mockImplementation(listener);
    });
    pageClient.Network.requestWillBeSentExtraInfo.mockImplementation((listener: Listener) => {
      requestWillBeSentExtraInfoListener.mockImplementation(listener);
    });
    pageClient.Network.requestServedFromCache = vi.fn((listener: Listener) => {
      requestServedFromCacheListener.mockImplementation(listener);
    });
    pageClient.Network.responseReceived.mockImplementation((listener: Listener) => {
      responseReceivedListener.mockImplementation(listener);
    });
    pageClient.Network.responseReceivedExtraInfo.mockImplementation((listener: Listener) => {
      responseReceivedExtraInfoListener.mockImplementation(listener);
    });
    pageClient.Network.loadingFinished.mockImplementation((listener: Listener) => {
      loadingFinishedListener.mockImplementation(listener);
    });

    session.pageNetworkStates = new Map();
    session.completionCollectorsByTabId = new Map();
    session.getActiveTabId = async () => "tab-1";
    session.hydratePerformanceResourceRequests = async () => {};

    session.installNetworkCollection("tab-1", pageClient);

    requestWillBeSentListener({
      requestId: "cached-request",
      loaderId: "cached-request",
      type: "Document",
      request: {
        url: "https://example.com/cached",
        method: "GET",
        headers: { accept: "text/html" }
      }
    });
    requestServedFromCacheListener({ requestId: "cached-request" });
    requestWillBeSentExtraInfoListener({
      requestId: "cached-request",
      headers: { cookie: "session=1" }
    });
    responseReceivedListener({
      requestId: "cached-request",
      type: "Document",
      response: {
        url: "https://example.com/cached",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        mimeType: "text/html"
      }
    });
    responseReceivedExtraInfoListener({
      requestId: "cached-request",
      headers: { age: "120" },
      headersText: "age: 120\r\n"
    });
    loadingFinishedListener({
      requestId: "cached-request"
    });

    const requests = await session.networkRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestId: "cached-request",
      url: "https://example.com/cached",
      requestHeaders: { accept: "text/html" },
      responseHeaders: { "content-type": "text/html" },
      rawRequestHeaders: undefined,
      rawResponseHeaders: undefined,
      responseHeadersSize: undefined
    });
  });

  it("falls back to provisional headers when response has no extra-info like Playwright", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.CdpConnectedBrowserSession.prototype) as {
      pageNetworkStates: Map<string, any>;
      completionCollectorsByTabId: Map<string, Set<{ requests: any[] }>>;
      installNetworkCollection(tabId: string, client: ReturnType<typeof createCdpClientStub>): void;
      networkRequests(): Promise<any[]>;
      getActiveTabId(): Promise<string>;
      hydratePerformanceResourceRequests(tabId: string): Promise<void>;
    };

    const pageClient = createCdpClientStub();
    const requestWillBeSentListener = vi.fn();
    const responseReceivedListener = vi.fn();
    const loadingFinishedListener = vi.fn();

    pageClient.Network.requestWillBeSent.mockImplementation((listener: Listener) => {
      requestWillBeSentListener.mockImplementation(listener);
    });
    pageClient.Network.responseReceived.mockImplementation((listener: Listener) => {
      responseReceivedListener.mockImplementation(listener);
    });
    pageClient.Network.loadingFinished.mockImplementation((listener: Listener) => {
      loadingFinishedListener.mockImplementation(listener);
    });

    session.pageNetworkStates = new Map();
    session.completionCollectorsByTabId = new Map();
    session.getActiveTabId = async () => "tab-1";
    session.hydratePerformanceResourceRequests = async () => {};

    session.installNetworkCollection("tab-1", pageClient);

    requestWillBeSentListener({
      requestId: "no-extra-info-request",
      loaderId: "no-extra-info-request",
      type: "Document",
      request: {
        url: "https://example.com/no-extra-info",
        method: "GET",
        headers: { accept: "text/html" }
      }
    });
    responseReceivedListener({
      requestId: "no-extra-info-request",
      type: "Document",
      hasExtraInfo: false,
      response: {
        url: "https://example.com/no-extra-info",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        mimeType: "text/html"
      }
    });
    loadingFinishedListener({
      requestId: "no-extra-info-request"
    });

    const requests = await session.networkRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestId: "no-extra-info-request",
      requestHeaders: { accept: "text/html" },
      responseHeaders: { "content-type": "text/html" },
      rawRequestHeaders: { accept: "text/html" },
      rawResponseHeaders: { "content-type": "text/html" },
      responseHeadersSize: undefined
    });
  });

  it("applies redirectResponse metadata to the previous hop like Playwright", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.CdpConnectedBrowserSession.prototype) as {
      pageNetworkStates: Map<string, any>;
      completionCollectorsByTabId: Map<string, Set<{ requests: any[] }>>;
      installNetworkCollection(tabId: string, client: ReturnType<typeof createCdpClientStub>): void;
      networkRequests(): Promise<any[]>;
      getActiveTabId(): Promise<string>;
      hydratePerformanceResourceRequests(tabId: string): Promise<void>;
    };

    const pageClient = createCdpClientStub();
    const requestWillBeSentListener = vi.fn();
    const loadingFinishedListener = vi.fn();

    pageClient.Network.requestWillBeSent.mockImplementation((listener: Listener) => {
      requestWillBeSentListener.mockImplementation(listener);
    });
    pageClient.Network.loadingFinished.mockImplementation((listener: Listener) => {
      loadingFinishedListener.mockImplementation(listener);
    });

    session.pageNetworkStates = new Map();
    session.completionCollectorsByTabId = new Map();
    session.getActiveTabId = async () => "tab-1";
    session.hydratePerformanceResourceRequests = async () => {};

    session.installNetworkCollection("tab-1", pageClient);

    requestWillBeSentListener({
      requestId: "redirect-request",
      loaderId: "redirect-request",
      type: "Document",
      timestamp: 1,
      request: {
        url: "https://example.com/start",
        method: "GET",
        headers: { accept: "text/html" }
      }
    });
    requestWillBeSentListener({
      requestId: "redirect-request",
      loaderId: "redirect-request",
      type: "Document",
      timestamp: 1.25,
      redirectHasExtraInfo: false,
      redirectResponse: {
        url: "https://example.com/start",
        status: 302,
        statusText: "Found",
        headers: { location: "https://example.com/final" },
        mimeType: "text/html"
      },
      request: {
        url: "https://example.com/final",
        method: "GET",
        headers: { accept: "text/html" }
      }
    });
    loadingFinishedListener({
      requestId: "redirect-request"
    });

    const requests = await session.networkRequests();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      requestId: "redirect-request",
      requestKey: "redirect-request#1",
      redirectedToRequestKey: "redirect-request#2",
      finalRequestKey: "redirect-request#2",
      url: "https://example.com/start",
      status: 302,
      statusText: "Found",
      responseHeaders: { location: "https://example.com/final" },
      rawRequestHeaders: { accept: "text/html" },
      rawResponseHeaders: { location: "https://example.com/final" },
      durationMs: 250
    });
    expect(requests[0]?.redirectedFromRequestKey).toBeUndefined();
    expect(requests[1]).toMatchObject({
      requestId: "redirect-request",
      requestKey: "redirect-request#2",
      redirectedFromRequestKey: "redirect-request#1",
      finalRequestKey: "redirect-request#2",
      url: "https://example.com/final"
    });
    expect(requests[1]?.redirectedToRequestKey).toBeUndefined();
  });

  it("falls back to provisional request headers when loading fails before response like Playwright", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.CdpConnectedBrowserSession.prototype) as {
      pageNetworkStates: Map<string, any>;
      completionCollectorsByTabId: Map<string, Set<{ requests: any[] }>>;
      installNetworkCollection(tabId: string, client: ReturnType<typeof createCdpClientStub>): void;
      networkRequests(): Promise<any[]>;
      getActiveTabId(): Promise<string>;
      hydratePerformanceResourceRequests(tabId: string): Promise<void>;
    };

    const pageClient = createCdpClientStub();
    const requestWillBeSentListener = vi.fn();
    const loadingFailedListener = vi.fn();

    pageClient.Network.requestWillBeSent.mockImplementation((listener: Listener) => {
      requestWillBeSentListener.mockImplementation(listener);
    });
    pageClient.Network.loadingFailed.mockImplementation((listener: Listener) => {
      loadingFailedListener.mockImplementation(listener);
    });

    session.pageNetworkStates = new Map();
    session.completionCollectorsByTabId = new Map();
    session.getActiveTabId = async () => "tab-1";
    session.hydratePerformanceResourceRequests = async () => {};

    session.installNetworkCollection("tab-1", pageClient);

    requestWillBeSentListener({
      requestId: "failed-before-response",
      loaderId: "failed-before-response",
      type: "Document",
      request: {
        url: "https://example.com/fail",
        method: "GET",
        headers: { accept: "text/html" }
      }
    });
    loadingFailedListener({
      requestId: "failed-before-response",
      errorText: "net::ERR_ABORTED"
    });

    const requests = await session.networkRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestId: "failed-before-response",
      requestHeaders: { accept: "text/html" },
      rawRequestHeaders: { accept: "text/html" },
      failureText: "net::ERR_ABORTED"
    });
  });

  it("does not treat loadingFinished without a response as a completed response like Playwright", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.CdpConnectedBrowserSession.prototype) as {
      pageNetworkStates: Map<string, any>;
      completionCollectorsByTabId: Map<string, Set<{ requests: any[]; requestKeys: string[] }>>;
      installNetworkCollection(tabId: string, client: ReturnType<typeof createCdpClientStub>): void;
      getActiveTabId(): Promise<string>;
      hydratePerformanceResourceRequests(tabId: string): Promise<void>;
      waitForRequestResponse(requestId: string, timeoutMs: number): Promise<void>;
    };

    const pageClient = createCdpClientStub();
    const requestWillBeSentListener = vi.fn();
    const loadingFinishedListener = vi.fn();

    pageClient.Network.requestWillBeSent.mockImplementation((listener: Listener) => {
      requestWillBeSentListener.mockImplementation(listener);
    });
    pageClient.Network.loadingFinished.mockImplementation((listener: Listener) => {
      loadingFinishedListener.mockImplementation(listener);
    });

    session.pageNetworkStates = new Map();
    session.completionCollectorsByTabId = new Map();
    session.getActiveTabId = async () => "tab-1";
    session.hydratePerformanceResourceRequests = async () => {};

    session.installNetworkCollection("tab-1", pageClient);

    requestWillBeSentListener({
      requestId: "finished-without-response",
      loaderId: "finished-without-response",
      type: "Document",
      request: {
        url: "https://example.com/finished-without-response",
        method: "GET",
        headers: { accept: "text/html" }
      }
    });
    loadingFinishedListener({
      requestId: "finished-without-response",
      timestamp: 1
    });

    vi.useFakeTimers();
    try {
      const waitPromise = session.waitForRequestResponse("finished-without-response#1", 5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(waitPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles request response wait after loadingFailed without requiring a thrown error like Playwright request.response()", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.CdpConnectedBrowserSession.prototype) as {
      pageNetworkStates: Map<string, any>;
      completionCollectorsByTabId: Map<string, Set<{ requests: any[]; requestKeys: string[] }>>;
      installNetworkCollection(tabId: string, client: ReturnType<typeof createCdpClientStub>): void;
      getActiveTabId(): Promise<string>;
      hydratePerformanceResourceRequests(tabId: string): Promise<void>;
      waitForRequestResponse(requestId: string, timeoutMs: number): Promise<void>;
    };

    const pageClient = createCdpClientStub();
    const requestWillBeSentListener = vi.fn();
    const loadingFailedListener = vi.fn();

    pageClient.Network.requestWillBeSent.mockImplementation((listener: Listener) => {
      requestWillBeSentListener.mockImplementation(listener);
    });
    pageClient.Network.loadingFailed.mockImplementation((listener: Listener) => {
      loadingFailedListener.mockImplementation(listener);
    });

    session.pageNetworkStates = new Map();
    session.completionCollectorsByTabId = new Map();
    session.getActiveTabId = async () => "tab-1";
    session.hydratePerformanceResourceRequests = async () => {};

    session.installNetworkCollection("tab-1", pageClient);

    requestWillBeSentListener({
      requestId: "failed-no-response",
      loaderId: "failed-no-response",
      type: "Image",
      request: {
        url: "https://example.com/fail-image",
        method: "GET",
        headers: { accept: "image/png" }
      }
    });

    const waitPromise = session.waitForRequestResponse("failed-no-response#1", 5_000);

    loadingFailedListener({
      requestId: "failed-no-response",
      errorText: "net::ERR_ABORTED"
    });

    await expect(waitPromise).resolves.toBeUndefined();
  });

  it("distinguishes response availability from request finished like Playwright request.response() and response.finished()", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.CdpConnectedBrowserSession.prototype) as {
      pageNetworkStates: Map<string, any>;
      completionCollectorsByTabId: Map<string, Set<{ requests: any[]; requestKeys: string[] }>>;
      installNetworkCollection(tabId: string, client: ReturnType<typeof createCdpClientStub>): void;
      getActiveTabId(): Promise<string>;
      hydratePerformanceResourceRequests(tabId: string): Promise<void>;
      waitForRequestResponse(requestId: string, timeoutMs: number): Promise<void>;
      waitForRequestFinished(requestId: string, timeoutMs: number): Promise<void>;
    };

    const pageClient = createCdpClientStub();
    const requestWillBeSentListener = vi.fn();
    const responseReceivedListener = vi.fn();
    const loadingFinishedListener = vi.fn();

    pageClient.Network.requestWillBeSent.mockImplementation((listener: Listener) => {
      requestWillBeSentListener.mockImplementation(listener);
    });
    pageClient.Network.responseReceived.mockImplementation((listener: Listener) => {
      responseReceivedListener.mockImplementation(listener);
    });
    pageClient.Network.loadingFinished.mockImplementation((listener: Listener) => {
      loadingFinishedListener.mockImplementation(listener);
    });

    session.pageNetworkStates = new Map();
    session.completionCollectorsByTabId = new Map();
    session.getActiveTabId = async () => "tab-1";
    session.hydratePerformanceResourceRequests = async () => {};

    session.installNetworkCollection("tab-1", pageClient);

    requestWillBeSentListener({
      requestId: "response-before-finish",
      loaderId: "response-before-finish",
      type: "Image",
      request: {
        url: "https://example.com/api/data",
        method: "GET",
        headers: { accept: "application/json" }
      }
    });

    const responseWait = session.waitForRequestResponse("response-before-finish#1", 5_000);
    const finishedWait = session.waitForRequestFinished("response-before-finish#1", 5_000);

    responseReceivedListener({
      requestId: "response-before-finish",
      type: "Image",
      response: {
        url: "https://example.com/api/data",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        mimeType: "application/json"
      }
    });

    await expect(responseWait).resolves.toBeUndefined();

    let finishedResolved = false;
    finishedWait.then(() => {
      finishedResolved = true;
    });
    await Promise.resolve();
    expect(finishedResolved).toBe(false);

    loadingFinishedListener({
      requestId: "response-before-finish",
      timestamp: 1
    });

    await expect(finishedWait).resolves.toBeUndefined();
  });

  it("creates a new BiDi request hop for redirects like Playwright", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.BidiConnectedBrowserSession.prototype) as {
      pageNetworkStates: Map<string, any>;
      completionCollectorsByTabId: Map<string, Set<{ requests: any[]; requestKeys: string[] }>>;
      getActiveTabId(): Promise<string>;
      hydratePerformanceResourceRequests(tabId: string): Promise<void>;
      handleBeforeRequestSent(payload: unknown): void;
      networkRequests(): Promise<any[]>;
    };

    session.pageNetworkStates = new Map();
    session.completionCollectorsByTabId = new Map();
    session.getActiveTabId = async () => "tab-1";
    session.hydratePerformanceResourceRequests = async () => {};

    session.handleBeforeRequestSent({
      context: "tab-1",
      request: {
        request: "bidi-redirect",
        method: "GET",
        url: "https://example.com/start",
        destination: "document",
        headers: [{ name: "accept", value: "text/html" }]
      },
      timestamp: 1000
    });
    session.handleBeforeRequestSent({
      context: "tab-1",
      redirectCount: 1,
      request: {
        request: "bidi-redirect",
        method: "GET",
        url: "https://example.com/final",
        destination: "document",
        headers: [{ name: "accept", value: "text/html" }]
      },
      timestamp: 1250
    });

    const requests = await session.networkRequests();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      requestId: "bidi-redirect",
      requestKey: "bidi-redirect#1",
      redirectedToRequestKey: "bidi-redirect#2",
      finalRequestKey: "bidi-redirect#2",
      url: "https://example.com/start"
    });
    expect(requests[0]?.redirectedFromRequestKey).toBeUndefined();
    expect(requests[1]).toMatchObject({
      requestId: "bidi-redirect",
      requestKey: "bidi-redirect#2",
      redirectedFromRequestKey: "bidi-redirect#1",
      finalRequestKey: "bidi-redirect#2",
      url: "https://example.com/final"
    });
    expect(requests[1]?.redirectedToRequestKey).toBeUndefined();
  });

  it("keeps provisional raw request headers on BiDi fetchError like Playwright", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.BidiConnectedBrowserSession.prototype) as {
      pageNetworkStates: Map<string, any>;
      completionCollectorsByTabId: Map<string, Set<{ requests: any[]; requestKeys: string[] }>>;
      getActiveTabId(): Promise<string>;
      hydratePerformanceResourceRequests(tabId: string): Promise<void>;
      handleBeforeRequestSent(payload: unknown): void;
      handleFetchError(payload: unknown): void;
      networkRequests(): Promise<any[]>;
    };

    session.pageNetworkStates = new Map();
    session.completionCollectorsByTabId = new Map();
    session.getActiveTabId = async () => "tab-1";
    session.hydratePerformanceResourceRequests = async () => {};

    session.handleBeforeRequestSent({
      context: "tab-1",
      request: {
        request: "bidi-fail",
        method: "GET",
        url: "https://example.com/fail",
        destination: "document",
        headers: [{ name: "accept", value: "text/html" }]
      },
      timestamp: 1000
    });
    session.handleFetchError({
      context: "tab-1",
      request: {
        request: "bidi-fail",
        method: "GET",
        url: "https://example.com/fail",
        destination: "document",
        headers: [{ name: "accept", value: "text/html" }]
      },
      errorText: "NS_BINDING_ABORTED",
      timestamp: 1100
    });

    const requests = await session.networkRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestId: "bidi-fail",
      requestHeaders: { accept: "text/html" },
      rawRequestHeaders: { accept: "text/html" },
      failureText: "NS_BINDING_ABORTED",
      durationMs: 100
    });
  });

  it("waits for BiDi main-frame load on navigation requests like Playwright", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const listeners = new Map<string, Set<Listener>>();
    const client = {
      on: vi.fn((event: string, listener: Listener) => {
        const eventListeners = listeners.get(event) ?? new Set<Listener>();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
      }),
      removeListener: vi.fn((event: string, listener: Listener) => {
        listeners.get(event)?.delete(listener);
      }),
      scriptEvaluate: vi.fn(async (params?: { expression?: string }) => {
        const expression = String(params?.expression ?? "");
        if (expression.includes("document.title")) {
          return {
            type: "success",
            result: { type: "string", value: "example" }
          };
        }
        throw new Error("not ready");
      }),
      browsingContextGetTree: vi.fn(async () => ({
        contexts: [{ context: "tab-1", url: "https://example.com" }]
      }))
    } as unknown as {
      on(event: string, listener: Listener): void;
      removeListener(event: string, listener: Listener): void;
      scriptEvaluate(...args: any[]): Promise<unknown>;
      browsingContextGetTree(...args: any[]): Promise<unknown>;
    };

    const session = Object.create(module.BidiConnectedBrowserSession.prototype) as {
      client: typeof client;
      activeTabId?: string;
      pageLoadStates: Map<string, { loaded: boolean }>;
      waitForMainFrameLoad(timeoutMs: number): Promise<void>;
      ensurePageLoadState(tabId: string): { loaded: boolean };
    };

    session.client = client;
    session.activeTabId = "tab-1";
    session.pageLoadStates = new Map();

    const waitPromise = session.waitForMainFrameLoad(5_000);
    await vi.waitFor(() => {
      expect(client.on).toHaveBeenCalledWith("browsingContext.load", expect.any(Function));
    });

    const loadListener = Array.from(listeners.get("browsingContext.load") ?? [])[0];
    expect(loadListener).toBeTypeOf("function");

    loadListener?.({ context: "tab-2" });
    await Promise.resolve();
    expect(client.removeListener).not.toHaveBeenCalled();

    loadListener?.({ context: "tab-1" });
    await expect(waitPromise).resolves.toBeUndefined();
    expect(session.ensurePageLoadState("tab-1")).toEqual({ loaded: true });
    expect(client.removeListener).toHaveBeenCalledWith("browsingContext.load", loadListener);
  });
});
