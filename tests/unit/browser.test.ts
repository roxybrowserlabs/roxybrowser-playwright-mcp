import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoxyBrowser } from "../../src/browser.js";
import { RoxyBrowserContext } from "../../src/browserContext.js";
import {
  createBrowser,
  createBrowserAdapterStub,
  createBrowserContextAdapterStub,
  createBrowserSessionStub,
  createPageAdapterStub
} from "../helpers/fakes.js";

describe("RoxyBrowser", () => {
  it("creates a browser context with Playwright-style options", async () => {
    const session = createBrowserSessionStub();
    const contextAdapter = createBrowserContextAdapterStub();
    session.newContext = async (options) => {
      expect(options).toMatchObject({
        acceptDownloads: true,
        locale: "zh-CN"
      });
      expect(options).not.toHaveProperty("human");
      return contextAdapter;
    };

    const browser = createBrowser({ session });
    const context = await browser.newContext({
      locale: "zh-CN"
    });

    expect(context).toBeInstanceOf(RoxyBrowserContext);
  });

  it("proxies version and close lifecycle", async () => {
    const session = createBrowserSessionStub();
    const adapter = createBrowserAdapterStub();
    const browser = createBrowser({ session, adapter });

    expect(browser.version()).toBe("Chrome/123.0.0.0");

    await browser.close();
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it("normalizes context extra http headers before passing options to the session", async () => {
    const session = createBrowserSessionStub();
    const contextAdapter = createBrowserContextAdapterStub();
    session.newContext = async (options) => {
      expect(options).toMatchObject({
        acceptDownloads: true,
        extraHTTPHeaders: {
          Foo: "Bar"
        }
      });
      return contextAdapter;
    };

    const browser = createBrowser({ session });

    await browser.newContext({
      extraHTTPHeaders: {
        Foo: "Bar"
      }
    });
  });

  it("resolves recordVideo.dir before passing options to the session", async () => {
    const session = createBrowserSessionStub();
    const contextAdapter = createBrowserContextAdapterStub();
    session.newContext = async (options) => {
      expect(options).toMatchObject({
        acceptDownloads: true,
        recordVideo: {
          dir: resolve("videos"),
          size: {
            width: 320,
            height: 240
          }
        }
      });
      return contextAdapter;
    };

    const browser = createBrowser({ session });

    await browser.newContext({
      recordVideo: {
        dir: "videos",
        size: {
          width: 320,
          height: 240
        }
      }
    });
  });

  it("rejects invalid context extra http headers", async () => {
    const browser = createBrowser();

    await expect(
      browser.newContext({
        extraHTTPHeaders: {
          foo: null as never
        }
      })
    ).rejects.toThrow('Expected value of header "foo" to be String, but "object" is found.');
  });

  it("still closes the adapter if session shutdown fails", async () => {
    const session = createBrowserSessionStub();
    const adapter = createBrowserAdapterStub();
    session.close = async () => {
      throw new Error("session end failed");
    };
    const browser = createBrowser({ session, adapter });

    await expect(browser.close()).rejects.toThrow("session end failed");
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  describe("static accessors", () => {
    it("returns the browser type passed to the constructor", () => {
      const browserType = { name: "sentinel" } as unknown as ReturnType<typeof Object>;
      const browser = createBrowser({ browserType: browserType as never });
      expect(browser.browserType()).toBe(browserType);
    });

    it("reports connected state and flips to false on close", async () => {
      const browser = createBrowser();
      expect(browser.isConnected()).toBe(true);
      await browser.close();
      expect(browser.isConnected()).toBe(false);
    });

    it("defaults to the chromium version sentinel", () => {
      const browser = createBrowser({ version: "Chrome/999.0.0.0" });
      expect(browser.version()).toBe("Chrome/999.0.0.0");
    });
  });

  describe("context tracking", () => {
    it("tracks opened contexts and removes them once they close", async () => {
      const session = createBrowserSessionStub();
      const contextAdapter = createBrowserContextAdapterStub();
      session.newContext = async () => contextAdapter;
      const browser = createBrowser({ session });

      expect(browser.contexts()).toEqual([]);

      const context = await browser.newContext();
      expect(browser.contexts()).toEqual([context]);

      await context.close();
      expect(browser.contexts()).toEqual([]);
    });

    it("returns a defensive copy of the contexts list", async () => {
      const session = createBrowserSessionStub();
      const contextAdapter = createBrowserContextAdapterStub();
      session.newContext = async () => contextAdapter;
      const browser = createBrowser({ session });

      await browser.newContext();
      const first = browser.contexts();
      const second = browser.contexts();
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
    });

    it("emits the context event when a new context is created", async () => {
      const session = createBrowserSessionStub();
      const contextAdapter = createBrowserContextAdapterStub();
      session.newContext = async () => contextAdapter;
      const browser = createBrowser({ session });

      const listener = vi.fn();
      browser.on("context", listener);

      const context = await browser.newContext();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(context);
    });

    // Bug fix: context.pages() should be populated before newContext() returns.
    // When connecting to an existing browser (reuseDefaultUserContext: true), the
    // CDP adapter discovers pre-existing tabs asynchronously. Without awaiting
    // ready(), callers would see an empty pages() list immediately after connect.
    it("awaits adapter.ready() before returning so context.pages() is populated", async () => {
      const session = createBrowserSessionStub();
      const contextAdapter = createBrowserContextAdapterStub();
      const pageAdapter = createPageAdapterStub();
      let readyResolved = false;

      // Simulate what CdpBrowserContextAdapter does: emit an existing page
      // during the ready() phase (after initial target discovery completes).
      contextAdapter.ready = vi.fn(async () => {
        await contextAdapter.emitPage(pageAdapter);
        readyResolved = true;
      });
      session.newContext = async () => contextAdapter;
      const browser = createBrowser({ session });

      const context = await browser.newContext({ reuseDefaultUserContext: true });

      // ready() must have been called and completed before newContext() returned
      expect(readyResolved).toBe(true);
      expect(contextAdapter.ready).toHaveBeenCalledTimes(1);
      // Pre-existing pages emitted during ready() must be visible immediately
      expect(context.pages()).toHaveLength(1);
    });

    it("installs cursor visualization for context preload and already-discovered pages", async () => {
      const session = createBrowserSessionStub();
      const contextAdapter = createBrowserContextAdapterStub();
      const pageAdapter = createPageAdapterStub();
      const order: string[] = [];
      contextAdapter.addInitScript = vi.fn(async () => {
        order.push("preload");
        return {
          dispose: vi.fn(async () => {})
        };
      });
      contextAdapter.ready = vi.fn(async () => {
        order.push("ready");
        await contextAdapter.emitPage(pageAdapter);
      });
      session.newContext = async () => contextAdapter;
      const browser = createBrowser({ session });

      await browser.newContext({ reuseDefaultUserContext: true });

      expect(order).toEqual(["preload", "ready"]);
      expect(contextAdapter.addInitScript).toHaveBeenCalledWith(
        expect.stringContaining("__roxyBubbleCursor")
      );
      const cursorEvaluations = vi.mocked(pageAdapter.evaluate).mock.calls.filter(([source]) =>
        String(source).includes("__roxyBubbleCursor")
      );
      expect(cursorEvaluations).toHaveLength(1);
    });

    it("returns the context even when the adapter does not implement ready()", async () => {
      // Backward-compatibility: adapters that don't implement ready() (e.g. BiDi)
      // should still work — the optional call silently no-ops.
      const session = createBrowserSessionStub();
      const contextAdapter = createBrowserContextAdapterStub();
      // ready is intentionally absent — the stub does not define it
      expect((contextAdapter as { ready?: unknown }).ready).toBeUndefined();
      session.newContext = async () => contextAdapter;
      const browser = createBrowser({ session });

      const context = await browser.newContext();
      expect(context).toBeDefined();
    });

    it("newPage creates a context, a page within it, and closes the context when the page closes", async () => {
      const session = createBrowserSessionStub();
      const contextAdapter = createBrowserContextAdapterStub();
      const pageAdapter = createPageAdapterStub();
      contextAdapter.newPage = async () => pageAdapter;
      session.newContext = async () => contextAdapter;
      const browser = createBrowser({ session });

      const page = await browser.newPage();
      expect(page).toBeDefined();
      expect(browser.contexts()).toHaveLength(1);

      await page.close();
      expect(browser.contexts()).toEqual([]);
    });
  });

  describe("event listeners", () => {
    it("invokes on listeners and supports removal via off", async () => {
      const session = createBrowserSessionStub();
      session.newContext = async () => createBrowserContextAdapterStub();
      const browser = createBrowser({ session });

      const listener = vi.fn();
      browser.on("context", listener);
      await browser.newContext();
      expect(listener).toHaveBeenCalledTimes(1);

      browser.off("context", listener);
      await browser.newContext();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("addListener is an alias for on", async () => {
      const session = createBrowserSessionStub();
      session.newContext = async () => createBrowserContextAdapterStub();
      const browser = createBrowser({ session });

      const listener = vi.fn();
      const returned = browser.addListener("context", listener);
      expect(returned).toBe(browser);
      await browser.newContext();
      expect(listener).toHaveBeenCalledTimes(1);

      browser.removeListener("context", listener);
      await browser.newContext();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("once listeners are invoked a single time", async () => {
      const session = createBrowserSessionStub();
      session.newContext = async () => createBrowserContextAdapterStub();
      const browser = createBrowser({ session });

      const listener = vi.fn();
      browser.once("context", listener);
      await browser.newContext();
      await browser.newContext();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("prependListener fires the prepended listener before existing ones", async () => {
      const session = createBrowserSessionStub();
      session.newContext = async () => createBrowserContextAdapterStub();
      const browser = createBrowser({ session });

      const order: string[] = [];
      browser.on("context", () => order.push("first"));
      browser.prependListener("context", () => order.push("prepended"));

      await browser.newContext();
      expect(order).toEqual(["prepended", "first"]);
    });

    it("removeAllListeners clears a single event type when given one", async () => {
      const session = createBrowserSessionStub();
      session.newContext = async () => createBrowserContextAdapterStub();
      const browser = createBrowser({ session });

      const contextListener = vi.fn();
      const disconnectListener = vi.fn();
      browser.on("context", contextListener);
      browser.on("disconnected", disconnectListener);

      browser.removeAllListeners("context");
      await browser.newContext();
      expect(contextListener).not.toHaveBeenCalled();
      expect(disconnectListener).not.toHaveBeenCalled();
    });

    it("removeAllListeners clears every event type when called without arguments", async () => {
      const session = createBrowserSessionStub();
      session.newContext = async () => createBrowserContextAdapterStub();
      const browser = createBrowser({ session });

      const contextListener = vi.fn();
      const disconnectListener = vi.fn();
      browser.on("context", contextListener);
      browser.on("disconnected", disconnectListener);

      browser.removeAllListeners();
      await browser.newContext();
      await browser.close();
      expect(contextListener).not.toHaveBeenCalled();
      expect(disconnectListener).not.toHaveBeenCalled();
    });

    it("emits disconnected with the browser instance on close", async () => {
      const browser = createBrowser();
      const listener = vi.fn();
      browser.on("disconnected", listener);

      await browser.close();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(browser);
    });

    it("supports multiple listeners for the same event", async () => {
      const session = createBrowserSessionStub();
      session.newContext = async () => createBrowserContextAdapterStub();
      const browser = createBrowser({ session });

      const first = vi.fn();
      const second = vi.fn();
      browser.on("context", first);
      browser.on("context", second);

      await browser.newContext();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });

    it("returns the browser and is chainable from every listener registration method", () => {
      const browser = createBrowser();
      const listener = () => undefined;

      expect(browser.on("context", listener)).toBe(browser);
      expect(browser.once("context", listener)).toBe(browser);
      expect(browser.addListener("context", listener)).toBe(browser);
      expect(browser.prependListener("context", listener)).toBe(browser);
      expect(browser.off("context", listener)).toBe(browser);
      expect(browser.removeListener("context", listener)).toBe(browser);
      expect(browser.removeAllListeners()).toBe(browser);
      expect(browser.removeAllListeners("context")).toBe(browser);
    });
  });

  describe("close behaviour", () => {
    it("is a no-op when already disconnected", async () => {
      const session = createBrowserSessionStub();
      const adapter = createBrowserAdapterStub();
      const browser = createBrowser({ session, adapter });

      await browser.close();
      await browser.close();

      expect(session.close).toHaveBeenCalledTimes(1);
      expect(adapter.close).toHaveBeenCalledTimes(1);
    });

    it("does not emit disconnected twice when closed repeatedly", async () => {
      const browser = createBrowser();
      const listener = vi.fn();
      browser.on("disconnected", listener);

      await browser.close();
      await browser.close();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("forces the adapter to close when the session close times out", async () => {
      const session = createBrowserSessionStub();
      const adapter = createBrowserAdapterStub();
      // Never resolves -> triggers the close timeout.
      session.close = () => new Promise<void>(() => {});
      const browser = createBrowser({ session, adapter });

      await expect(browser.close()).rejects.toThrow(
        /Timed out closing browser session after \d+ms\./
      );
      expect(adapter.close).toHaveBeenCalledTimes(1);
      expect(browser.isConnected()).toBe(false);
    }, 15_000);

    it("still emits disconnected after a session close timeout", async () => {
      const session = createBrowserSessionStub();
      session.close = () => new Promise<void>(() => {});
      const browser = createBrowser({ session });

      const listener = vi.fn();
      browser.on("disconnected", listener);

      await expect(browser.close()).rejects.toThrow(/Timed out/);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(browser);
    }, 15_000);

    it("forwards close options to the session", async () => {
      const session = createBrowserSessionStub();
      session.close = vi.fn(async () => {});
      const browser = createBrowser({ session });

      await browser.close({ reason: "user-requested" });
      expect(session.close).toHaveBeenCalledTimes(1);
    });
  });

  it("constructs with all core constructor parameters", () => {
    const session = createBrowserSessionStub();
    const adapter = createBrowserAdapterStub();
    const browserType = {} as never;
    const browser = new RoxyBrowser(
      session,
      adapter,
      "chromium",
      browserType,
      "Chrome/123.0.0.0"
    );

    expect(browser.browserType()).toBe(browserType);
    expect(browser.version()).toBe("Chrome/123.0.0.0");
    expect(browser.isConnected()).toBe(true);
  });
});
