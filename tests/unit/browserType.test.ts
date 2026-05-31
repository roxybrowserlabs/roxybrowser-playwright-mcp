import { describe, expect, it, vi } from "vitest";
import { RoxyBrowser } from "../../src/browser.js";
import { RoxyBrowserType } from "../../src/browserType.js";
import type { ProtocolBrowserAdapterFactory } from "../../src/protocol/adapter.js";
import {
  createBrowserAdapterStub,
  createBrowserSessionStub
} from "../helpers/fakes.js";

describe("RoxyBrowserType", () => {
  it("launches using the default cdp protocol", async () => {
    const adapter = createBrowserAdapterStub();
    adapter.browser = vi.fn(async () => createBrowserSessionStub());
    const factory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => adapter)
    };

    const browserType = new RoxyBrowserType("chromium", {
      cdp: factory,
      bidi: factory,
      webdriver: factory
    });

    const browser = await browserType.launch();

    expect(factory.create).toHaveBeenCalledWith({
      browserName: "chromium",
      protocol: "cdp"
    });
    expect(adapter.connect).toHaveBeenCalledTimes(1);
    expect(browser).toBeInstanceOf(RoxyBrowser);
  });

  it("selects the requested protocol factory and passes launch options through", async () => {
    const cdpFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const bidiAdapter = createBrowserAdapterStub();
    bidiAdapter.browser = vi.fn(async () => createBrowserSessionStub());
    const bidiFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => bidiAdapter)
    };
    const webdriverFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: cdpFactory,
      bidi: bidiFactory,
      webdriver: webdriverFactory
    });

    await browserType.launch({
      protocol: "bidi",
      channel: "chrome",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false,
      human: {
        profile: "fast"
      }
    });

    expect(bidiFactory.create).toHaveBeenCalledWith({
      browserName: "chromium",
      protocol: "bidi",
      channel: "chrome",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false,
      human: {
        profile: "fast"
      }
    });
    expect(cdpFactory.create).not.toHaveBeenCalled();
    expect(webdriverFactory.create).not.toHaveBeenCalled();
  });

  it("connects over a ws CDP endpoint using the cdp factory", async () => {
    const cdpAdapter = createBrowserAdapterStub();
    cdpAdapter.browser = vi.fn(async () => createBrowserSessionStub());
    const cdpFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => cdpAdapter)
    };
    const bidiFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const webdriverFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: cdpFactory,
      bidi: bidiFactory,
      webdriver: webdriverFactory
    });

    const browser = await browserType.connectOverCDP(
      "ws://127.0.0.1:9222/devtools/browser/example",
      {
        isLocal: true,
        noDefaults: true,
        slowMo: 25
      }
    );

    expect(cdpFactory.create).toHaveBeenCalledWith({
      browserName: "chromium",
      protocol: "cdp",
      wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/example",
      isLocal: true,
      noDefaults: true,
      slowMo: 25
    });
    expect(cdpAdapter.connect).toHaveBeenCalledTimes(1);
    expect(browser).toBeInstanceOf(RoxyBrowser);
    expect(bidiFactory.create).not.toHaveBeenCalled();
    expect(webdriverFactory.create).not.toHaveBeenCalled();
  });

  it("connects firefox to an existing BiDi websocket endpoint", async () => {
    const cdpFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const bidiAdapter = createBrowserAdapterStub();
    bidiAdapter.browser = vi.fn(async () => createBrowserSessionStub());
    const bidiFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => bidiAdapter)
    };
    const webdriverFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const browserType = new RoxyBrowserType("firefox", {
      cdp: cdpFactory,
      bidi: bidiFactory,
      webdriver: webdriverFactory
    });

    const browser = await browserType.connect({
      wsEndpoint: "ws://127.0.0.1:9222",
      protocol: "bidi",
      sessionId: "existing-bidi-session"
    });

    expect(bidiFactory.create).toHaveBeenCalledWith({
      browserName: "firefox",
      protocol: "bidi",
      wsEndpoint: "ws://127.0.0.1:9222",
      sessionId: "existing-bidi-session"
    });
    expect(bidiAdapter.connect).toHaveBeenCalledTimes(1);
    expect(browser).toBeInstanceOf(RoxyBrowser);
    expect(cdpFactory.create).not.toHaveBeenCalled();
    expect(webdriverFactory.create).not.toHaveBeenCalled();
  });

  it("rejects non-websocket CDP endpoints", async () => {
    const factory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => createBrowserAdapterStub())
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: factory,
      bidi: factory,
      webdriver: factory
    });

    await expect(
      browserType.connectOverCDP("http://127.0.0.1:9222")
    ).rejects.toThrow(
      'Only ws:// and wss:// CDP endpoints are currently supported. Received "http:".'
    );
  });

  it("rejects custom headers for websocket CDP endpoints", async () => {
    const factory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => createBrowserAdapterStub())
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: factory,
      bidi: factory,
      webdriver: factory
    });

    await expect(
      browserType.connectOverCDP("ws://127.0.0.1:9222/devtools/browser/example", {
        headers: [{ name: "authorization", value: "Bearer token" }]
      })
    ).rejects.toThrow("Custom headers are not supported for WebSocket CDP endpoints yet.");
  });

  it("launches firefox using bidi by default", async () => {
    const cdpFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const bidiAdapter = createBrowserAdapterStub();
    bidiAdapter.browser = vi.fn(async () => createBrowserSessionStub());
    const bidiFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => bidiAdapter)
    };
    const webdriverFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const browserType = new RoxyBrowserType("firefox", {
      cdp: cdpFactory,
      bidi: bidiFactory,
      webdriver: webdriverFactory
    });

    const browser = await browserType.launch();

    expect(bidiFactory.create).toHaveBeenCalledWith({
      browserName: "firefox",
      protocol: "bidi"
    });
    expect(browser).toBeInstanceOf(RoxyBrowser);
    expect(cdpFactory.create).not.toHaveBeenCalled();
    expect(webdriverFactory.create).not.toHaveBeenCalled();
  });
});
