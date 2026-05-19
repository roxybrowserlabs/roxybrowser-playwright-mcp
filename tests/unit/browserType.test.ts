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

    const browserType = new RoxyBrowserType({
      cdp: factory,
      bidi: factory,
      webdriver: factory
    });

    const browser = await browserType.launch();

    expect(factory.create).toHaveBeenCalledWith({ protocol: "cdp" });
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
    const browserType = new RoxyBrowserType({
      cdp: cdpFactory,
      bidi: bidiFactory,
      webdriver: webdriverFactory
    });

    await browserType.launch({
      protocol: "bidi",
      headless: false,
      human: {
        profile: "fast"
      }
    });

    expect(bidiFactory.create).toHaveBeenCalledWith({
      protocol: "bidi",
      headless: false,
      human: {
        profile: "fast"
      }
    });
    expect(cdpFactory.create).not.toHaveBeenCalled();
    expect(webdriverFactory.create).not.toHaveBeenCalled();
  });
});

