import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RoxyBrowser } from "../../src/browser.js";
import { RoxyBrowserContext } from "../../src/browserContext.js";
import {
  createBrowserAdapterStub,
  createBrowserContextAdapterStub,
  createBrowserSessionStub
} from "../helpers/fakes.js";

describe("RoxyBrowser", () => {
  it("creates a browser context with inherited human defaults", async () => {
    const session = createBrowserSessionStub();
    const contextAdapter = createBrowserContextAdapterStub();
    session.newContext = async (options) => {
      expect(options).toEqual({
        locale: "zh-CN",
        human: {
          profile: "fast",
          typingDelayMs: 10
        }
      });
      return contextAdapter;
    };

    const browser = new RoxyBrowser(session, createBrowserAdapterStub(), {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const context = await browser.newContext({
      locale: "zh-CN",
      human: {
        profile: "fast",
        typingDelayMs: 10
      }
    });

    expect(context).toBeInstanceOf(RoxyBrowserContext);
  });

  it("proxies version and close lifecycle", async () => {
    const session = createBrowserSessionStub();
    const adapter = createBrowserAdapterStub();
    const browser = new RoxyBrowser(session, adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    expect(await browser.version()).toBe("Chrome/123.0.0.0");

    await browser.close();
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it("normalizes context extra http headers before passing options to the session", async () => {
    const session = createBrowserSessionStub();
    const contextAdapter = createBrowserContextAdapterStub();
    session.newContext = async (options) => {
      expect(options).toEqual({
        extraHTTPHeaders: {
          Foo: "Bar"
        }
      });
      return contextAdapter;
    };

    const browser = new RoxyBrowser(session, createBrowserAdapterStub(), {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

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
      expect(options).toEqual({
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

    const browser = new RoxyBrowser(session, createBrowserAdapterStub(), {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

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
    const browser = new RoxyBrowser(createBrowserSessionStub(), createBrowserAdapterStub(), {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

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
    const browser = new RoxyBrowser(session, adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    await expect(browser.close()).rejects.toThrow("session end failed");
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });
});
