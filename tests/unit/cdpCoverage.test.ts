import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { chromium } from "../../src/index.js";

type Listener = (...args: any[]) => void;

function createCdpClientStub() {
  const listeners = new Map<string, Set<Listener>>();
  let logEntryAddedListener: Listener | undefined;
  let downloadWillBeginListener: Listener | undefined;
  let downloadProgressListener: Listener | undefined;

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
      createIsolatedWorld: vi.fn(async () => ({ executionContextId: 7 })),
      captureScreenshot: vi.fn(async () => ({ data: "" })),
      getFrameTree: vi.fn(async () => ({
        frameTree: {
          frame: {
            id: "frame-1",
            url: "about:blank"
          }
        }
      })),
      getLayoutMetrics: vi.fn(async () => ({
        contentSize: { x: 0, y: 0, width: 1280, height: 720 },
        cssContentSize: { x: 0, y: 0, width: 1280, height: 720 },
        cssVisualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 1280,
          clientHeight: 720,
          scale: 1
        }
      })),
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
    Fetch: {
      enable: vi.fn(async () => ({})),
      disable: vi.fn(async () => ({})),
      requestPaused: vi.fn(),
      continueRequest: vi.fn(async () => ({})),
      fulfillRequest: vi.fn(async () => ({})),
      failRequest: vi.fn(async () => ({}))
    },
    Browser: {
      downloadWillBegin: vi.fn((listener: Listener) => {
        downloadWillBeginListener = listener;
      }),
      downloadProgress: vi.fn((listener: Listener) => {
        downloadProgressListener = listener;
      })
    },
    Input: {
      dispatchKeyEvent: vi.fn(async () => ({})),
      dispatchMouseEvent: vi.fn(async () => ({})),
      insertText: vi.fn(async () => ({}))
    },
    emitLogEntryAdded(payload: unknown) {
      logEntryAddedListener?.(payload);
    },
    emitDownloadWillBegin(payload: unknown) {
      downloadWillBeginListener?.(payload);
    },
    emitDownloadProgress(payload: unknown) {
      downloadProgressListener?.(payload);
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

  it("keeps CDP protocol input in the target without activating the browser window", async () => {
    const { browserClient, page, pageClient } = await createCdpPageClients();
    const internalPage = page as typeof page & {
      resolveActionPoint(): Promise<{ x: number; y: number }>;
    };
    internalPage.resolveActionPoint = vi.fn(async () => ({ x: 30, y: 40 }));

    await page.keyboardType("human");
    await page.mouseMove(10, 20, { steps: 2 });
    await page.mouseClick(10, 20, { delay: 1 });
    await page.mouseWheel(0, 100);
    await page.locator({ strategy: "css", value: "#target" }).hover();
    await page.locator({ strategy: "css", value: "#target" }).click();

    expect(pageClient.Input.dispatchKeyEvent).toHaveBeenCalled();
    expect(pageClient.send).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: expect.any(String) })
    );
    expect(browserClient.Target.activateTarget).not.toHaveBeenCalled();

    await page.bringToFront();

    expect(browserClient.Target.activateTarget).toHaveBeenCalledOnce();
  });

  it("emits requestheaders when CDP request extra-info arrives after request fallback", async () => {
    const { page, pageClient } = await createCdpPageClients();
    vi.useFakeTimers();
    const requestListener = vi.fn();
    const requestHeadersListener = vi.fn();
    page.on("request", requestListener);
    page.on("requestheaders", requestHeadersListener);

    pageClient.Network.requestWillBeSent.mock.calls[0]?.[0]({
      requestId: "late-extra-info",
      loaderId: "late-extra-info",
      type: "Document",
      request: {
        method: "GET",
        url: "https://example.com/late-extra-info",
        headers: { accept: "text/html" }
      },
      timestamp: 1
    });
    await vi.advanceTimersByTimeAsync(251);
    pageClient.Network.requestWillBeSentExtraInfo.mock.calls[0]?.[0]({
      requestId: "late-extra-info",
      headers: {
        accept: "text/html",
        cookie: "a=b"
      }
    });

    expect(requestListener).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://example.com/late-extra-info",
      headers: expect.arrayContaining([{ name: "accept", value: "text/html" }])
    }));
    expect(requestHeadersListener).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://example.com/late-extra-info",
      headers: expect.arrayContaining([
        { name: "accept", value: "text/html" },
        { name: "cookie", value: "a=b" }
      ])
    }));
  });

  it("waits long enough for CDP response extra-info to preserve duplicate headers", async () => {
    const { page, pageClient } = await createCdpPageClients();
    vi.useFakeTimers();
    const responseListener = vi.fn();
    page.on("response", responseListener);

    pageClient.Network.requestWillBeSent.mock.calls[0]?.[0]({
      requestId: "duplicate-response-headers",
      loaderId: "duplicate-response-headers",
      type: "Document",
      request: {
        method: "GET",
        url: "https://example.com/duplicate-response-headers",
        headers: { accept: "text/html" }
      },
      timestamp: 1
    });
    pageClient.Network.requestWillBeSentExtraInfo.mock.calls[0]?.[0]({
      requestId: "duplicate-response-headers",
      headers: { accept: "text/html" }
    });
    pageClient.Network.responseReceived.mock.calls[0]?.[0]({
      requestId: "duplicate-response-headers",
      hasExtraInfo: true,
      type: "Document",
      response: {
        url: "https://example.com/duplicate-response-headers",
        status: 200,
        statusText: "OK",
        headers: { "header-a": "value-a, value-a-1" },
        mimeType: "text/html"
      }
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(responseListener).not.toHaveBeenCalled();

    pageClient.Network.responseReceivedExtraInfo.mock.calls[0]?.[0]({
      requestId: "duplicate-response-headers",
      headers: { "header-a": "value-a, value-a-1" },
      headersText: "HTTP/1.1 200 OK\r\nheader-a: value-a\r\nheader-a: value-a-1\r\n\r\n"
    });

    expect(responseListener).toHaveBeenCalledWith(expect.objectContaining({
      headers: [
        { name: "header-a", value: "value-a" },
        { name: "header-a", value: "value-a-1" }
      ]
    }));
  });

  it("installs cursor visualization when a CDP browser session connects to an active page", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const browserClient = createCdpClientStub();
    const pageClient = createCdpClientStub();
    Object.assign(pageClient.Page, {
      addScriptToEvaluateOnNewDocument: vi.fn(async () => ({ identifier: "cursor-script" }))
    });
    browserClient.Target.getTargets.mockResolvedValue({
      targetInfos: [
        {
          targetId: "tab-1",
          type: "page",
          title: "Ready",
          url: "https://example.test/"
        }
      ]
    });
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

    await module.CdpConnectedBrowserSession.connect({
      browser: "chromium",
      protocol: "cdp",
      endpoint: "ws://127.0.0.1:9222/devtools/browser/example"
    });

    expect(pageClient.Page.addScriptToEvaluateOnNewDocument).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.stringContaining("__roxyBubbleCursor")
    }));
    expect(pageClient.Runtime.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      expression: expect.stringContaining("__roxyBubbleCursor")
    }));
  });

  it("surfaces CDP download events in MCP snapshots like Playwright MCP", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const browserClient = createCdpClientStub();
    const pageClient = createCdpClientStub();
    Object.assign(pageClient.Page, {
      addScriptToEvaluateOnNewDocument: vi.fn(async () => ({ identifier: "cursor-script" }))
    });
    browserClient.Target.getTargets.mockResolvedValue({
      targetInfos: [
        {
          targetId: "tab-1",
          type: "page",
          title: "Ready",
          url: "https://example.test/"
        }
      ]
    });
    pageClient.Runtime.evaluate.mockResolvedValue({
      result: {
        value: {
          refs: {},
          text: "- link \"Download\" [ref=e1]",
          title: "Ready",
          url: "https://example.test/"
        }
      }
    });
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

    const session = await module.CdpConnectedBrowserSession.connect({
      browser: "chromium",
      protocol: "cdp",
      endpoint: "ws://127.0.0.1:9222/devtools/browser/example"
    });

    browserClient.emitDownloadWillBegin({
      frameId: "frame-1",
      guid: "download-1",
      suggestedFilename: "test.txt",
      url: "https://example.test/download"
    });
    browserClient.emitDownloadProgress({
      guid: "download-1",
      state: "completed"
    });

    await expect(session.snapshot()).resolves.toMatchObject({
      events: [
        { type: "download-start", filename: "test.txt" },
        { type: "download-finish", filename: "test.txt" }
      ]
    });
  });

  it("redacts secrets in MCP CDP console log artifacts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "roxy-cdp-console-secrets-"));
    try {
      const module = await import("../../src/mcp/connectedBrowser.js");
      const browserClient = createCdpClientStub();
      const pageClient = createCdpClientStub();
      Object.assign(pageClient.Page, {
        addScriptToEvaluateOnNewDocument: vi.fn(async () => ({ identifier: "cursor-script" }))
      });
      browserClient.Target.getTargets.mockResolvedValue({
        targetInfos: [
          {
            targetId: "tab-1",
            type: "page",
            title: "Ready",
            url: "https://example.test/"
          }
        ]
      });
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
      pageClient.Runtime.evaluate.mockImplementation(async (options: { returnByValue?: boolean }) => {
        if (options.returnByValue) {
          return {
            result: {
              value: {
                refs: {},
                text: "- document \"Ready\"",
                title: "Ready",
                url: "https://example.test/"
              }
            }
          };
        }
        return { result: { type: "string", value: "about:blank" } };
      });

      const session = await module.CdpConnectedBrowserSession.connect({
        browser: "chromium",
        protocol: "cdp",
        endpoint: "ws://127.0.0.1:9222/devtools/browser/example",
        assetRoots: {
          tempDir,
          artifactsDir: tempDir,
          downloadsDir: tempDir,
          screenshotsDir: tempDir,
          snapshotsDir: tempDir,
          tracesDir: tempDir,
          videosDir: tempDir,
          networkDir: tempDir,
          consoleDir: tempDir,
          scriptsDir: tempDir
        },
        redactText: (text) => text.replaceAll("password123", "<secret>X-PASSWORD</secret>")
      });
      pageClient.Runtime.consoleAPICalled.mock.calls[0]?.[0]({
        type: "log",
        timestamp: 1700000000000,
        args: [{ type: "string", value: "password123" }],
        stackTrace: {
          callFrames: [{ url: "https://example.test/", lineNumber: 4 }]
        }
      });

      const snapshot = await session.snapshot();
      expect(snapshot.consoleLink).toBeDefined();
      const [filePath] = snapshot.consoleLink!.split("#L");
      const logText = await readFile(filePath!, "utf8");

      expect(logText).not.toContain("password123");
      expect(logText).toContain("<secret>X-PASSWORD</secret>");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("tracks MCP CDP main document response status in snapshots", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const browserClient = createCdpClientStub();
    const pageClient = createCdpClientStub();
    Object.assign(pageClient.Page, {
      addScriptToEvaluateOnNewDocument: vi.fn(async () => ({ identifier: "cursor-script" }))
    });
    browserClient.Target.getTargets.mockResolvedValue({
      targetInfos: [
        {
          targetId: "tab-1",
          type: "page",
          title: "Ready",
          url: "https://example.test/locked"
        }
      ]
    });
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
    pageClient.Runtime.evaluate.mockImplementation(async (options: { returnByValue?: boolean }) => {
      if (options.returnByValue) {
        return {
          result: {
            value: {
              refs: {},
              text: "- document \"Payment Required\"",
              title: "Payment Required",
              url: "https://example.test/locked"
            }
          }
        };
      }
      return { result: { type: "string", value: "about:blank" } };
    });

    const session = await module.CdpConnectedBrowserSession.connect({
      browser: "chromium",
      protocol: "cdp",
      endpoint: "ws://127.0.0.1:9222/devtools/browser/example"
    });
    pageClient.Network.requestWillBeSent.mock.calls[0]?.[0]({
      requestId: "nav-1",
      loaderId: "nav-1",
      type: "Document",
      request: {
        method: "GET",
        url: "https://example.test/locked",
        headers: {}
      },
      timestamp: 1
    });
    pageClient.Network.responseReceived.mock.calls[0]?.[0]({
      requestId: "nav-1",
      type: "Document",
      response: {
        status: 402,
        statusText: "Payment Required",
        headers: {},
        mimeType: "text/html"
      }
    });

    const snapshot = await session.snapshot();

    expect(snapshot.mainDocumentStatus).toEqual({
      status: 402,
      statusText: "Payment Required"
    });
  });

  it("does not activate the browser window for MCP CDP interactions", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const browserClient = createCdpClientStub();
    const pageClient = createCdpClientStub();
    Object.assign(pageClient.Page, {
      addScriptToEvaluateOnNewDocument: vi.fn(async () => ({ identifier: "cursor-script" }))
    });
    browserClient.Target.getTargets.mockResolvedValue({
      targetInfos: [
        {
          targetId: "tab-1",
          type: "page",
          title: "Ready",
          url: "https://example.test/"
        }
      ]
    });
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

    const session = await module.CdpConnectedBrowserSession.connect({
      browser: "chromium",
      protocol: "cdp",
      endpoint: "ws://127.0.0.1:9222/devtools/browser/example"
    });
    pageClient.Runtime.evaluate.mockImplementation(async (options: {
      expression?: string;
      returnByValue?: boolean;
    }) => {
      if (options.returnByValue === false) {
        return { result: { objectId: "focused-element" } };
      }
      if (options.expression?.includes("globalThis.innerWidth")) {
        return { result: { value: { x: 0, y: 0, width: 1280, height: 720 } } };
      }
      return { result: { value: { ok: true, x: 10, y: 20 } } };
    });

    await session.hover({ selector: "#field" }, { moveDelayMs: 0 });
    await session.click({ selector: "#field" }, { clickHoldMs: 0, moveDelayMs: 0 });
    await session.focus({ selector: "#field" });
    await session.clear({ selector: "#field" });
    await session.type({ selector: "#field" }, "hi", { slowly: true, delayMs: 0 });
    await session.pressKey("Enter");

    expect(pageClient.Input.dispatchMouseEvent).toHaveBeenCalled();
    expect(pageClient.Input.insertText).toHaveBeenCalledWith({ text: "h" });
    expect(pageClient.Input.dispatchKeyEvent).toHaveBeenCalled();
    expect(browserClient.Target.activateTarget).not.toHaveBeenCalled();

    await session.close();
  });

  it("rejects background tab creation before Chromium 145 without changing focus", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const browserClient = createCdpClientStub();
    const pageClient = createCdpClientStub();
    browserClient.Target.getTargets.mockResolvedValue({
      targetInfos: [
        {
          targetId: "tab-1",
          type: "page",
          title: "Ready",
          url: "https://example.test/"
        }
      ]
    });
    chromeRemoteInterfaceMock.mockImplementation(async (options?: { target?: string }) => {
      if (options?.target === "ws://127.0.0.1:9222/devtools/browser/example") {
        return browserClient;
      }
      return pageClient;
    });
    chromeRemoteInterfaceMock.Version.mockResolvedValue({
      Browser: "Chrome/144.0.7559.97",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/example"
    });

    const session = await module.CdpConnectedBrowserSession.connect({
      browser: "chromium",
      protocol: "cdp",
      endpoint: "ws://127.0.0.1:9222/devtools/browser/example"
    });

    await expect(
      session.newTab("https://background.test/", { activate: false })
    ).rejects.toMatchObject({ code: "background_tab_unsupported" });
    expect(browserClient.Target.createTarget).not.toHaveBeenCalled();
    expect(browserClient.Target.activateTarget).not.toHaveBeenCalled();

    await session.close();
  });

  it("fills MCP CDP text through selection plus protocol text insertion", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const browserClient = createCdpClientStub();
    const pageClient = createCdpClientStub();
    Object.assign(pageClient.Page, {
      addScriptToEvaluateOnNewDocument: vi.fn(async () => ({ identifier: "cursor-script" }))
    });
    browserClient.Target.getTargets.mockResolvedValue({
      targetInfos: [
        {
          targetId: "tab-1",
          type: "page",
          title: "Ready",
          url: "https://example.test/"
        }
      ]
    });
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

    const session = await module.CdpConnectedBrowserSession.connect({
      browser: "chromium",
      protocol: "cdp",
      endpoint: "ws://127.0.0.1:9222/devtools/browser/example"
    });
    pageClient.Runtime.evaluate.mockImplementation(async (options: {
      expression?: string;
      returnByValue?: boolean;
    }) => {
      if (options.expression?.includes("globalThis.innerWidth")) {
        return { result: { value: { x: 0, y: 0, width: 1280, height: 720 } } };
      }
      if (options.expression?.includes("selectNodeContents")) {
        return { result: { value: { ok: true, action: "insert" } } };
      }
      return { result: { value: { ok: true, x: 10, y: 20 } } };
    });

    await session.type({ selector: "[contenteditable]" }, "long pasted caption", { strategy: "fill" });

    expect(pageClient.Runtime.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      expression: expect.stringContaining("selectNodeContents")
    }));
    expect(pageClient.Input.insertText).toHaveBeenCalledWith({ text: "long pasted caption" });
    expect(browserClient.Target.activateTarget).not.toHaveBeenCalled();

    await session.close();
  });

  it("keeps CDP tab operations in the background when activation is disabled", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const browserClient = createCdpClientStub();
    const pageClient = createCdpClientStub();
    browserClient.Target.getTargets.mockResolvedValue({
      targetInfos: [
        {
          targetId: "tab-1",
          type: "page",
          title: "Ready",
          url: "https://example.test/"
        }
      ]
    });
    chromeRemoteInterfaceMock.mockImplementation(async (options?: { target?: string }) => {
      if (options?.target === "ws://127.0.0.1:9222/devtools/browser/example") {
        return browserClient;
      }
      return pageClient;
    });
    chromeRemoteInterfaceMock.Version.mockResolvedValue({
      Browser: "Chrome/145.0.0.0",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/example"
    });

    const session = await module.CdpConnectedBrowserSession.connect({
      browser: "chromium",
      protocol: "cdp",
      endpoint: "ws://127.0.0.1:9222/devtools/browser/example"
    });

    await session.newTab("https://background.test/", { activate: false });
    await session.selectTab("tab-1", { activate: false });
    await session.closeTab("tab-1", { activate: false });

    expect(browserClient.Target.createTarget).toHaveBeenCalledWith({
      url: "https://background.test/",
      background: true
    });
    expect(browserClient.Target.activateTarget).not.toHaveBeenCalled();

    await session.close();
  });

  it("still activates a CDP tab when activation is explicit", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const browserClient = createCdpClientStub();
    const pageClient = createCdpClientStub();
    browserClient.Target.getTargets.mockResolvedValue({
      targetInfos: [
        {
          targetId: "tab-1",
          type: "page",
          title: "Ready",
          url: "https://example.test/"
        }
      ]
    });
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

    const session = await module.CdpConnectedBrowserSession.connect({
      browser: "chromium",
      protocol: "cdp",
      endpoint: "ws://127.0.0.1:9222/devtools/browser/example"
    });

    await session.selectTab("tab-1", { activate: true });

    expect(browserClient.Target.activateTarget).toHaveBeenCalledOnce();
    expect(browserClient.Target.activateTarget).toHaveBeenCalledWith({ targetId: "tab-1" });

    await session.close();
  });

  it("keeps BiDi tab operations in the background when activation is disabled", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const browsingContextCreate = vi.fn(async () => ({ context: "tab-2" }));
    const browsingContextActivate = vi.fn(async () => ({}));
    const session = Object.create(module.BidiConnectedBrowserSession.prototype) as {
      client: {
        browsingContextCreate: typeof browsingContextCreate;
        browsingContextActivate: typeof browsingContextActivate;
        browsingContextNavigate: ReturnType<typeof vi.fn>;
        browsingContextGetTree: ReturnType<typeof vi.fn>;
        emulationSetNetworkConditions: ReturnType<typeof vi.fn>;
      };
      activeTabId: string | undefined;
      offline: boolean;
      titleForContext(tabId: string): Promise<string>;
      newTab(url?: string, options?: { activate?: boolean }): Promise<unknown>;
      selectTab(tabId: string, options?: { activate?: boolean }): Promise<unknown>;
    };
    session.client = {
      browsingContextCreate,
      browsingContextActivate,
      browsingContextNavigate: vi.fn(async () => ({})),
      browsingContextGetTree: vi.fn(async () => ({
        contexts: [
          { context: "tab-1", url: "https://example.test/", children: [] },
          { context: "tab-2", url: "https://background.test/", children: [] }
        ]
      })),
      emulationSetNetworkConditions: vi.fn(async () => ({}))
    };
    session.activeTabId = "tab-1";
    session.offline = false;
    session.titleForContext = async (tabId) => tabId;

    await session.newTab("https://background.test/", { activate: false });
    await session.selectTab("tab-1", { activate: false });

    expect(browsingContextCreate).toHaveBeenCalledWith({
      type: "tab",
      background: true
    });
    expect(browsingContextActivate).not.toHaveBeenCalled();
  });

  it("orders initially discovered pages by page event order like Playwright", async () => {
    const browserClient = createCdpClientStub();
    browserClient.Target.getTargets.mockResolvedValue({
      targetInfos: [
        {
          targetId: "slow-tab",
          type: "page",
          title: "Slow",
          url: "https://slow.test/"
        },
        {
          targetId: "fast-tab",
          type: "page",
          title: "Fast",
          url: "https://fast.test/"
        }
      ]
    });
    browserClient.Target.attachToTarget = vi.fn(async ({ targetId }: { targetId: string }) => ({
      sessionId: `session-${targetId}`
    }));

    let frameTreeCalls = 0;
    browserClient.Page.getFrameTree = vi.fn(async () => {
      frameTreeCalls += 1;
      const isSlow = frameTreeCalls === 1;
      if (isSlow) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const url = isSlow ? "https://slow.test/" : "https://fast.test/";
      return {
        frameTree: {
          frame: {
            id: isSlow ? "slow-frame" : "fast-frame",
            url
          }
        }
      };
    });
    browserClient.Page.addScriptToEvaluateOnNewDocument = vi.fn(async () => ({
      identifier: "script-1"
    }));
    browserClient.send = vi.fn(async (method: string, _params?: unknown, sessionId?: string) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            objectId: `global-${sessionId ?? "browser"}`,
            type: "object"
          }
        };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            type: "undefined",
            value: { v: "undefined" }
          }
        };
      }
      if (method === "Runtime.releaseObject") {
        return {};
      }
      return {};
    });

    chromeRemoteInterfaceMock.mockImplementation(async () => browserClient);
    chromeRemoteInterfaceMock.Version.mockResolvedValue({
      Browser: "Chrome/123.0.0.0",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/example"
    });

    const browser = await chromium.connect("ws://127.0.0.1:9222/devtools/browser/example");

    try {
      expect(browser.contexts()[0]!.pages().map(page => page.url())).toEqual([
        "https://fast.test/",
        "https://slow.test/"
      ]);
    } finally {
      await browser.close();
    }
  });

  it("handles context init scripts on transient closed popup pages like Playwright", async () => {
    const browserClient = createCdpClientStub();
    browserClient.Target.createBrowserContext.mockResolvedValue({ browserContextId: "ctx-1" });
    browserClient.Target.getTargets.mockResolvedValue({ targetInfos: [] });

    chromeRemoteInterfaceMock.mockImplementation(async () => browserClient);
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
    await context.ready?.();
    await context.addInitScript("window.__contextScript = true;");

    const closingPageClient = createCdpClientStub();
    closingPageClient.Page.enable.mockRejectedValue(new Error("Target closed"));
    closingPageClient.Page.addScriptToEvaluateOnNewDocument = vi.fn(async () => ({
      identifier: "script-closed"
    }));

    await expect((context as any).getOrCreatePage("popup-target", {
      client: closingPageClient,
      emitPage: true,
      fallbackUrl: "https://popup.test/",
      hasWindowOpener: true,
      openerTargetId: "opener-target"
    })).resolves.toEqual(expect.objectContaining({
      url: expect.any(Function)
    }));

    await context.close();
    await adapter.close();
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

  it("scales MCP CDP screenshots like Playwright", async () => {
    const pageClient = createCdpClientStub();
    pageClient.send.mockImplementation(async (method: string) => {
      if (method === "Page.getLayoutMetrics") {
        return {
          contentSize: { x: 0, y: 0, width: 800, height: 600 },
          cssContentSize: { x: 0, y: 0, width: 400, height: 300 },
          cssVisualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: 400,
            clientHeight: 300,
            scale: 1
          }
        };
      }
      return {};
    });

    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.CdpConnectedBrowserSession.prototype) as {
      getActivePageClient(): Promise<typeof pageClient>;
      screenshot(options?: { scale?: "css" | "device" }): Promise<{ data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }>;
    };
    session.getActivePageClient = async () => pageClient;

    await session.screenshot();
    await session.screenshot({ scale: "device" });

    expect(pageClient.Page.captureScreenshot).toHaveBeenNthCalledWith(1, expect.objectContaining({
      clip: expect.objectContaining({ scale: 0.5 })
    }));
    expect(pageClient.Page.captureScreenshot).toHaveBeenNthCalledWith(2, expect.objectContaining({
      clip: expect.objectContaining({ scale: 1 })
    }));
  });

  it("passes webp screenshot quality to CDP", async () => {
    const { page, pageClient } = await createCdpPageClients();

    await page.screenshot({ type: "webp", quality: 80 });

    expect(pageClient.Page.captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({
      format: "webp",
      quality: 80
    }));
  });

  it("passes MCP CDP webp screenshots through to the browser", async () => {
    const pageClient = createCdpClientStub();
    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.CdpConnectedBrowserSession.prototype) as {
      getActivePageClient(): Promise<typeof pageClient>;
      screenshot(options?: { type?: "png" | "jpeg" | "webp" }): Promise<{ data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }>;
    };
    session.getActivePageClient = async () => pageClient;

    const result = await session.screenshot({ type: "webp" });

    expect(pageClient.Page.captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({
      format: "webp"
    }));
    expect(result.mimeType).toBe("image/webp");
  });

  it("does not resolve CDP clicks before the mouse release command finishes", async () => {
    const { pageClient } = await createCdpPageClients();
    vi.useFakeTimers();
    const module = await import("../../src/mcp/connectedBrowser.js");
    let releaseMouse: (() => void) | undefined;
    let clickSettled = false;
    const session = Object.create(module.CdpConnectedBrowserSession.prototype) as {
      getActivePageClient(): Promise<typeof pageClient>;
      getActiveTabId(): Promise<string>;
      bringTabToFront(tabId: string): Promise<void>;
      getActiveUtilityContextId(client: typeof pageClient): Promise<number>;
      moveMouseAlongHumanPath(): Promise<void>;
      pageDialogStates: Map<string, unknown>;
      dialogWaiters: Map<string, Set<unknown>>;
      click(
        target: { selector: string },
        options: { clickHoldMs: number; moveDelayMs: number }
      ): Promise<void>;
    };
    session.getActivePageClient = async () => pageClient;
    session.getActiveTabId = async () => "tab-1";
    session.bringTabToFront = async () => {};
    session.getActiveUtilityContextId = async () => 1;
    session.moveMouseAlongHumanPath = async () => {};
    session.pageDialogStates = new Map();
    session.dialogWaiters = new Map();

    pageClient.Runtime.evaluate
      .mockResolvedValueOnce({ result: { value: { ok: true, x: 10, y: 20 } } });
    pageClient.Input.dispatchMouseEvent.mockImplementation(async (event: { type: string }) => {
      if (event.type === "mouseReleased") {
        return new Promise<void>((resolve) => {
          releaseMouse = resolve;
        });
      }
      return {};
    });

    const clickPromise = session.click(
      { selector: "button" },
      { clickHoldMs: 0, moveDelayMs: 0 }
    ).then(() => {
      clickSettled = true;
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(clickSettled).toBe(false);

    releaseMouse?.();
    await clickPromise;

    expect(clickSettled).toBe(true);
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

  it("ignores internal typing plan hints and follows plain keyboard typing", async () => {
    const { page, pageClient } = await createCdpPageClients();

    await page.keyboardType("abc", {
      __roxyTypingPlan: [
        { type: "backspace", delay: 0 },
        { type: "char", value: "指", delay: 0 }
      ]
    } as never);

    expect(pageClient.Input.dispatchKeyEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "keyDown",
      key: "a"
    }));
    expect(pageClient.Input.dispatchKeyEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "keyDown",
      key: "b"
    }));
    expect(pageClient.Input.dispatchKeyEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "keyDown",
      key: "c"
    }));
    expect(pageClient.Input.dispatchKeyEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      key: "Backspace"
    }));
    expect(pageClient.Input.insertText).not.toHaveBeenCalledWith({ text: "指" });
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

  it("lists a failed request once like Playwright MCP", async () => {
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
      requestId: "failed-image",
      loaderId: "main",
      type: "Image",
      request: {
        url: "http://does-not-exist.invalid/api/x",
        method: "GET",
        headers: {}
      }
    });
    loadingFailedListener({
      requestId: "failed-image",
      errorText: "net::ERR_NAME_NOT_RESOLVED"
    });

    const requests = await session.networkRequests();
    expect(requests.filter((request) => request.url.endsWith("/api/x"))).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestId: "failed-image",
      failureText: "net::ERR_NAME_NOT_RESOLVED"
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

  it("routes CDP requests for Playwright MCP browser_route mocks and header overrides", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.CdpConnectedBrowserSession.prototype) as {
      pageClients: Map<string, any>;
      routesList: any[];
      activeTabId: string;
      refreshRouteInterception(): Promise<void>;
      addRoute(route: any): Promise<void>;
    };

    const pageClient = createCdpClientStub();
    const requestPausedListener = vi.fn();
    pageClient.Fetch.requestPaused.mockImplementation((listener: Listener) => {
      requestPausedListener.mockImplementation(listener);
    });

    session.pageClients = new Map([["tab-1", pageClient]]);
    session.routesList = [];
    session.activeTabId = "tab-1";

    await session.addRoute({
      pattern: "**/api/users",
      status: 201,
      body: "[{\"id\":1}]",
      contentType: "application/json"
    });
    await session.addRoute({
      pattern: "**/api/check",
      addHeaders: { "X-Custom-Header": "test-value" },
      removeHeaders: ["authorization"]
    });

    requestPausedListener({
      requestId: "fetch-users",
      request: {
        url: "https://example.test/api/users",
        method: "GET",
        headers: {}
      },
      resourceType: "Fetch"
    });
    requestPausedListener({
      requestId: "fetch-check",
      request: {
        url: "https://example.test/api/check",
        method: "GET",
        headers: {
          authorization: "secret",
          accept: "application/json"
        }
      },
      resourceType: "Fetch"
    });

    await vi.waitFor(() => {
      expect(pageClient.Fetch.fulfillRequest).toHaveBeenCalledTimes(1);
      expect(pageClient.Fetch.continueRequest).toHaveBeenCalledTimes(1);
    });
    expect(pageClient.Fetch.fulfillRequest).toHaveBeenCalledWith({
      requestId: "fetch-users",
      responseCode: 201,
      responseHeaders: [{ name: "content-type", value: "application/json" }],
      body: Buffer.from("[{\"id\":1}]", "utf8").toString("base64")
    });
    expect(pageClient.Fetch.continueRequest).toHaveBeenCalledWith({
      requestId: "fetch-check",
      headers: [
        { name: "accept", value: "application/json" },
        { name: "X-Custom-Header", value: "test-value" }
      ]
    });
  });

  it("aborts CDP requests for Playwright MCP origin blocking", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.CdpConnectedBrowserSession.prototype) as {
      pageClients: Map<string, any>;
      routesList: any[];
      addRoute(route: any): Promise<void>;
    };

    const pageClient = createCdpClientStub();
    const requestPausedListener = vi.fn();
    pageClient.Fetch.requestPaused.mockImplementation((listener: Listener) => {
      requestPausedListener.mockImplementation(listener);
    });

    session.pageClients = new Map([["tab-1", pageClient]]);
    session.routesList = [];

    await session.addRoute({
      pattern: "https://example.com/**",
      abort: "blockedbyclient"
    });
    requestPausedListener({
      requestId: "fetch-blocked",
      request: {
        url: "https://example.com/",
        method: "GET",
        headers: {}
      },
      resourceType: "Document"
    });

    await vi.waitFor(() => {
      expect(pageClient.Fetch.failRequest).toHaveBeenCalledTimes(1);
    });
    expect(pageClient.Fetch.failRequest).toHaveBeenCalledWith({
      requestId: "fetch-blocked",
      errorReason: "BlockedByClient"
    });
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

  it("passes MCP BiDi webp screenshots through to the browser", async () => {
    const browsingContextCaptureScreenshot = vi.fn(async () => ({ data: "" }));
    const module = await import("../../src/mcp/connectedBrowser.js");
    const session = Object.create(module.BidiConnectedBrowserSession.prototype) as {
      client: { browsingContextCaptureScreenshot: typeof browsingContextCaptureScreenshot };
      getActiveTabId(): Promise<string>;
      screenshot(options?: { type?: "png" | "jpeg" | "webp" }): Promise<{ data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }>;
    };
    session.client = { browsingContextCaptureScreenshot };
    session.getActiveTabId = async () => "tab-1";

    const result = await session.screenshot({ type: "webp" });

    expect(browsingContextCaptureScreenshot).toHaveBeenCalledWith(expect.objectContaining({
      format: { type: "image/webp" }
    }));
    expect(result.mimeType).toBe("image/webp");
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

  it("types BiDi MCP slow text through per-character insertText calls", async () => {
    const module = await import("../../src/mcp/connectedBrowser.js");
    const scriptEvaluate = vi.fn(async (params: {
      awaitPromise?: boolean;
      expression: string;
      target: { context: string };
    }) => {
      expect(params.awaitPromise).toBe(true);
      expect(params.target).toEqual({ context: "tab-1" });
      if ((params as { resultOwnership?: string }).resultOwnership === "root") {
        return { type: "success", result: { sharedId: "field-1", handle: "handle-1" } };
      }
      if (params.expression.includes("__roxyMcpState")) {
        return { result: { type: "object", value: [["ok", { type: "boolean", value: true }]] } };
      }
      return { result: { type: "undefined" } };
    });
    const session = Object.create(module.BidiConnectedBrowserSession.prototype) as {
      client: { scriptEvaluate: typeof scriptEvaluate };
      getActiveTabId(): Promise<string>;
      type(target: { selector: string }, text: string, options?: {
        delayMs?: number;
        slowly?: boolean;
        strategy?: "sequential" | "fill";
      }): Promise<void>;
    };

    session.client = { scriptEvaluate };
    session.getActiveTabId = async () => "tab-1";

    await session.type({ selector: "#field" }, "ab", { slowly: true, delayMs: 0 });

    const serializedArgs = scriptEvaluate.mock.calls.map(([params]) => params.expression);
    const insertTextExpressions = serializedArgs.filter((arg) => arg.includes("bidiInsertText(window"));
    expect(insertTextExpressions).toHaveLength(2);
    expect(insertTextExpressions.some((arg) => arg.includes('\\"text\\":\\"a\\"') || arg.includes('"text":"a"'))).toBe(true);
    expect(insertTextExpressions.some((arg) => arg.includes('\\"text\\":\\"b\\"') || arg.includes('"text":"b"'))).toBe(true);
    expect(serializedArgs.some((arg) => arg.includes('\\"text\\":\\"ab\\"') || arg.includes('"text":"ab"'))).toBe(false);
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
