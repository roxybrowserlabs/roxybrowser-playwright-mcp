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
  it("launches using the default cdp protocol", async () => {
    const adapter = createBrowserAdapterStub();
    adapter.browser = vi.fn(async () => createBrowserSessionStub());
    const factory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => adapter)
    };

    const browserType = new RoxyBrowserType("chromium", {
      cdp: factory,
      bidi: factory
    });

    const browser = await browserType.launch();

    expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({
      browserName: "chromium",
      protocol: "cdp"
    }));
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
    const browserType = new RoxyBrowserType("chromium", {
      cdp: cdpFactory,
      bidi: bidiFactory
    });

    await browserType.launch({
      protocol: "bidi",
      channel: "chrome",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false
    });

    expect(bidiFactory.create).toHaveBeenCalledWith(expect.objectContaining({
      browserName: "chromium",
      protocol: "bidi",
      channel: "chrome",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false
    }));
    expect(bidiFactory.create).toHaveBeenCalledWith(expect.not.objectContaining({
      human: expect.anything()
    }));
    expect(cdpFactory.create).not.toHaveBeenCalled();
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
    const browserType = new RoxyBrowserType("chromium", {
      cdp: cdpFactory,
      bidi: bidiFactory
    });

    const browser = await browserType.connectOverCDP(
      "ws://127.0.0.1:9222/devtools/browser/example",
      {
        isLocal: true,
        noDefaults: true,
        slowMo: 25
      }
    );

    expect(cdpFactory.create).toHaveBeenCalledWith(expect.objectContaining({
      browserName: "chromium",
      protocol: "cdp",
      wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/example",
      isLocal: true,
      noDefaults: true,
      slowMo: 25
    }));
    expect(cdpAdapter.connect).toHaveBeenCalledTimes(1);
    expect(browser).toBeInstanceOf(RoxyBrowser);
    expect(browser.contexts()).toHaveLength(1);
    expect(bidiFactory.create).not.toHaveBeenCalled();
  });

  it("keeps the explicit connectOverCDP endpoint even if options contain wsEndpoint", async () => {
    const cdpAdapter = createBrowserAdapterStub();
    cdpAdapter.browser = vi.fn(async () => createBrowserSessionStub());
    const cdpFactory: ProtocolBrowserAdapterFactory = {
      create: vi.fn(() => cdpAdapter)
    };
    const browserType = new RoxyBrowserType("chromium", {
      cdp: cdpFactory,
      bidi: { create: vi.fn() }
    });

    await browserType.connectOverCDP(
      "ws://127.0.0.1:9222/devtools/browser/example",
      {
        wsEndpoint: undefined
      } as never
    );

    expect(cdpFactory.create).toHaveBeenCalledWith(expect.objectContaining({
      protocol: "cdp",
      wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/example"
    }));
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

  it("rejects non-websocket CDP endpoints", async () => {
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
      'Only ws:// and wss:// CDP endpoints are currently supported. Received "http:".'
    );
  });

  it("rejects custom headers for websocket CDP endpoints", async () => {
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
    const browserType = new RoxyBrowserType("firefox", {
      cdp: cdpFactory,
      bidi: bidiFactory
    });

    const browser = await browserType.launch();

    expect(bidiFactory.create).toHaveBeenCalledWith(expect.objectContaining({
      browserName: "firefox",
      protocol: "bidi"
    }));
    expect(browser).toBeInstanceOf(RoxyBrowser);
    expect(cdpFactory.create).not.toHaveBeenCalled();
  });
});
