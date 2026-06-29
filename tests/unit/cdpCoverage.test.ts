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
      pressKey(
        key: string,
        modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">
      ): Promise<void>;
    };
    session.getActivePageClient = async () => pageClient;

    await session.pressKey("a", ["ControlOrMeta"]);

    expect(pageClient.Input.insertText).not.toHaveBeenCalled();
    expect(pageClient.Input.dispatchKeyEvent).toHaveBeenCalledTimes(2);
    expect(pageClient.Input.dispatchKeyEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: "keyDown",
      key: "a",
      code: "KeyA"
    }));
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
});
