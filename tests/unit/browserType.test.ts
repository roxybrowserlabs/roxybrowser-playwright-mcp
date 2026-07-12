import { describe, expect, it, vi } from "vitest";
import { RoxyBrowser } from "../../src/browser.js";
import { RoxyBrowserType } from "../../src/browserType.js";
import type { ProtocolBrowserAdapterFactory } from "../../src/protocol/adapter.js";
import {
  createBrowserAdapterStub,
  createBrowserContextAdapterStub,
  createBrowserSessionStub
} from "../helpers/fakes.js";

describe("RoxyBrowserType", () => {
  it("returns the browser type name", () => {
    const factory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => createBrowserAdapterStub())
    };

    expect(new RoxyBrowserType("chromium", {
      cdp: factory,
      bidi: factory
    }).name()).toBe("chromium");
    expect(new RoxyBrowserType("firefox", {
      cdp: factory,
      bidi: factory
    }).name()).toBe("firefox");
  });

  it("rejects executablePath() because RoxyBrowser only connects to existing browsers", () => {
    const factory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => createBrowserAdapterStub())
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: factory,
      bidi: factory
    });

    expect(() => browserType.executablePath()).toThrow(
      "BrowserType.executablePath() is not supported in RoxyBrowser because RoxyBrowser does not manage bundled browser executables. Use BrowserType.connect(endpointURL) with an endpoint opened by RoxyBrowser or another browser process."
    );
    expect(factory.create).not.toHaveBeenCalled();
  });

  it("rejects launchPersistentContext() because RoxyBrowser does not launch persistent profiles", async () => {
    const factory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => createBrowserAdapterStub())
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: factory,
      bidi: factory
    });

    await expect(browserType.launchPersistentContext("/tmp/roxy-profile", {
      viewport: {
        width: 1280,
        height: 720
      }
    })).rejects.toThrow(
      "BrowserType.launchPersistentContext() is not supported in RoxyBrowser because RoxyBrowser does not launch persistent profiles. Open the profile in RoxyBrowser or another browser process and use BrowserType.connect(endpointURL) instead."
    );
    expect(factory.create).not.toHaveBeenCalled();
  });

  it("rejects launchServer() because RoxyBrowser does not launch Playwright protocol servers", async () => {
    const factory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => createBrowserAdapterStub())
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: factory,
      bidi: factory
    });

    await expect(browserType.launchServer({
      host: "127.0.0.1",
      port: 0
    })).rejects.toThrow(
      "BrowserType.launchServer() is not supported in RoxyBrowser because RoxyBrowser does not launch Playwright protocol servers. Use BrowserType.connect(endpointURL) with a CDP or BiDi endpoint instead."
    );
    expect(factory.create).not.toHaveBeenCalled();
  });

  it("rejects launch() before creating an adapter", async () => {
    const adapter = createBrowserAdapterStub();
    adapter.browser = vi.fn(async () => createBrowserSessionStub());
    const factory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => adapter)
    };

    const browserType = new RoxyBrowserType("chromium", {
      cdp: factory,
      bidi: factory
    });

    await expect(browserType.launch()).rejects.toThrow(
      "BrowserType.launch() is not supported in RoxyBrowser. Use BrowserType.connect(endpointURL) instead."
    );
    expect(factory.create).not.toHaveBeenCalled();
  });

  it("rejects launch() even when launch options are passed", async () => {
    const cdpFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const bidiAdapter = createBrowserAdapterStub();
    bidiAdapter.browser = vi.fn(async () => createBrowserSessionStub());
    const bidiFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => bidiAdapter)
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: cdpFactory,
      bidi: bidiFactory
    });

    await expect(browserType.launch({
      protocol: "bidi",
      channel: "chrome",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false
    })).rejects.toThrow(
      "BrowserType.launch() is not supported in RoxyBrowser. Use BrowserType.connect(endpointURL) instead."
    );

    expect(bidiFactory.create).not.toHaveBeenCalled();
    expect(cdpFactory.create).not.toHaveBeenCalled();
  });

  it("rejects connectOverCDP() before creating an adapter", async () => {
    const cdpAdapter = createBrowserAdapterStub();
    cdpAdapter.browser = vi.fn(async () => createBrowserSessionStub());
    const cdpFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => cdpAdapter)
    };
    const bidiFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: cdpFactory,
      bidi: bidiFactory
    });

    await expect(browserType.connectOverCDP(
      "ws://127.0.0.1:9222/devtools/browser/example",
      {
        isLocal: true,
        noDefaults: true,
        slowMo: 25
      }
    )).rejects.toThrow(
      "BrowserType.connectOverCDP() is not supported in RoxyBrowser. Use BrowserType.connect(endpointURL) instead."
    );
    expect(cdpFactory.create).not.toHaveBeenCalled();
    expect(cdpAdapter.connect).not.toHaveBeenCalled();
    expect(bidiFactory.create).not.toHaveBeenCalled();
  });

  it("rejects connectOverCDP() even if options contain wsEndpoint", async () => {
    const cdpAdapter = createBrowserAdapterStub();
    cdpAdapter.browser = vi.fn(async () => createBrowserSessionStub());
    const cdpFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => cdpAdapter)
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: cdpFactory,
      bidi: { create: vi.fn() }
    });

    await expect(browserType.connectOverCDP(
      "ws://127.0.0.1:9222/devtools/browser/example",
      {
        wsEndpoint: undefined
      } as never
    )).rejects.toThrow(
      "BrowserType.connectOverCDP() is not supported in RoxyBrowser. Use BrowserType.connect(endpointURL) instead."
    );

    expect(cdpFactory.create).not.toHaveBeenCalled();
  });

  it("connects firefox over connect() using the bidi factory", async () => {
    const cdpFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const bidiAdapter = createBrowserAdapterStub();
    bidiAdapter.browser = vi.fn(async () => createBrowserSessionStub());
    const bidiFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => bidiAdapter)
    };
    const browserType = new RoxyBrowserType("firefox", {
      cdp: cdpFactory,
      bidi: bidiFactory
    });

    // Roxy intentionally diverges from Playwright: connect() dispatches on
    // browserName so it serves both families via one entry point (chromium→cdp,
    // firefox→bidi). See the divergence comment on RoxyBrowserType.connect().
    const browser = await browserType.connect("ws://127.0.0.1:9222");

    expect(bidiFactory.create).toHaveBeenCalledWith(expect.objectContaining({
      browserName: "firefox",
      protocol: "bidi",
      wsEndpoint: "ws://127.0.0.1:9222"
    }));
    expect(bidiAdapter.connect).toHaveBeenCalledTimes(1);
    expect(browser).toBeInstanceOf(RoxyBrowser);
    expect(browser.contexts()).toHaveLength(1);
    expect(cdpFactory.create).not.toHaveBeenCalled();
  });

  it("keeps the explicit firefox connect endpoint even if options contain wsEndpoint", async () => {
    const cdpFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const bidiAdapter = createBrowserAdapterStub();
    bidiAdapter.browser = vi.fn(async () => createBrowserSessionStub());
    const bidiFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => bidiAdapter)
    };
    const browserType = new RoxyBrowserType("firefox", {
      cdp: cdpFactory,
      bidi: bidiFactory
    });

    await browserType.connect("ws://127.0.0.1:9222", {
      wsEndpoint: undefined
    } as never);

    expect(bidiFactory.create).toHaveBeenCalledWith(expect.objectContaining({
      browserName: "firefox",
      protocol: "bidi",
      wsEndpoint: "ws://127.0.0.1:9222"
    }));
    expect(cdpFactory.create).not.toHaveBeenCalled();
  });

  it("rejects firefox connect without an endpoint before creating an adapter", async () => {
    const cdpFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const bidiFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const browserType = new RoxyBrowserType("firefox", {
      cdp: cdpFactory,
      bidi: bidiFactory
    });

    await expect(browserType.connect(undefined as never)).rejects.toThrow(
      "BrowserType.connect(endpointURL) requires a browser WebSocket endpoint."
    );
    expect(cdpFactory.create).not.toHaveBeenCalled();
    expect(bidiFactory.create).not.toHaveBeenCalled();
  });

  it("connects chromium over connect() using the cdp factory", async () => {
    const cdpAdapter = createBrowserAdapterStub();
    const contextAdapter = createBrowserContextAdapterStub();
    const session = createBrowserSessionStub();
    session.newContext = vi.fn(async () => contextAdapter);
    cdpAdapter.browser = vi.fn(async () => session);
    const cdpFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => cdpAdapter)
    };
    const bidiFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: cdpFactory,
      bidi: bidiFactory
    });

    const browser = await browserType.connect("ws://127.0.0.1:9222/devtools/browser/example");

    expect(cdpFactory.create).toHaveBeenCalledWith(expect.objectContaining({
      browserName: "chromium",
      protocol: "cdp",
      wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/example"
    }));
    expect(cdpAdapter.connect).toHaveBeenCalledTimes(1);
    expect(browser).toBeInstanceOf(RoxyBrowser);
    expect(browser.contexts()).toHaveLength(1);
    expect(contextAdapter.addInitScript).toHaveBeenCalledWith(
      expect.stringContaining("__roxyBubbleCursor")
    );
    expect(bidiFactory.create).not.toHaveBeenCalled();
  });

  it("rejects chromium connect without an endpoint before creating an adapter", async () => {
    const cdpFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const bidiFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: cdpFactory,
      bidi: bidiFactory
    });

    await expect(browserType.connect(undefined as never)).rejects.toThrow(
      "BrowserType.connect(endpointURL) requires a browser WebSocket endpoint."
    );
    expect(cdpFactory.create).not.toHaveBeenCalled();
    expect(bidiFactory.create).not.toHaveBeenCalled();
  });

  it("keeps the explicit chromium connect endpoint even if options contain wsEndpoint", async () => {
    const cdpAdapter = createBrowserAdapterStub();
    cdpAdapter.browser = vi.fn(async () => createBrowserSessionStub());
    const cdpFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => cdpAdapter)
    };
    const bidiFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: cdpFactory,
      bidi: bidiFactory
    });

    await browserType.connect("ws://127.0.0.1:9222/devtools/browser/example", {
      wsEndpoint: undefined
    } as never);

    expect(cdpFactory.create).toHaveBeenCalledWith(expect.objectContaining({
      browserName: "chromium",
      protocol: "cdp",
      wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/example"
    }));
    expect(bidiFactory.create).not.toHaveBeenCalled();
  });

  it("rejects non-websocket connectOverCDP() endpoints with the migration error", async () => {
    const factory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => createBrowserAdapterStub())
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: factory,
      bidi: factory
    });

    await expect(
      browserType.connectOverCDP("http://127.0.0.1:9222")
    ).rejects.toThrow(
      "BrowserType.connectOverCDP() is not supported in RoxyBrowser. Use BrowserType.connect(endpointURL) instead."
    );
    expect(factory.create).not.toHaveBeenCalled();
  });

  it("rejects connectOverCDP() custom headers with the migration error", async () => {
    const factory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => createBrowserAdapterStub())
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: factory,
      bidi: factory
    });

    await expect(
      browserType.connectOverCDP("ws://127.0.0.1:9222/devtools/browser/example", {
        headers: [{ name: "authorization", value: "Bearer token" }]
      })
    ).rejects.toThrow(
      "BrowserType.connectOverCDP() is not supported in RoxyBrowser. Use BrowserType.connect(endpointURL) instead."
    );
    expect(factory.create).not.toHaveBeenCalled();
  });

  it("rejects firefox launch() before creating an adapter", async () => {
    const cdpFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn()
    };
    const bidiAdapter = createBrowserAdapterStub();
    bidiAdapter.browser = vi.fn(async () => createBrowserSessionStub());
    const bidiFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => bidiAdapter)
    };
    const browserType = new RoxyBrowserType("firefox", {
      cdp: cdpFactory,
      bidi: bidiFactory
    });

    await expect(browserType.launch()).rejects.toThrow(
      "BrowserType.launch() is not supported in RoxyBrowser. Use BrowserType.connect(endpointURL) instead."
    );

    expect(bidiFactory.create).not.toHaveBeenCalled();
    expect(cdpFactory.create).not.toHaveBeenCalled();
  });
});
