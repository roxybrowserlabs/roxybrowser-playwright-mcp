import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BidiBrowserAdapterFactory,
  buildFirefoxLaunchArgs,
  resetWebDriverModuleForTests,
  setWebDriverModuleForTests
} from "../../src/bundle.js";

const attachToSession = vi.fn();

describe("buildFirefoxLaunchArgs", () => {
  it("launches Firefox with a temporary profile and BiDi debugging port", () => {
    expect(buildFirefoxLaunchArgs({ headless: true }, "/tmp/roxy-firefox", 9222)).toEqual([
      "-profile",
      "/tmp/roxy-firefox",
      "-no-remote",
      "--remote-debugging-port=9222",
      "-headless"
    ]);
  });

  it("appends custom args after the default Firefox launch args", () => {
    expect(
      buildFirefoxLaunchArgs(
        {
          headless: false,
          args: ["-new-instance", "--private-window"]
        },
        "/tmp/roxy-firefox",
        9333
      )
    ).toEqual([
      "-profile",
      "/tmp/roxy-firefox",
      "-no-remote",
      "--remote-debugging-port=9333",
      "-new-instance",
      "--private-window"
    ]);
  });
});

describe("BidiBrowserAdapterFactory", () => {
  afterEach(() => {
    attachToSession.mockReset();
    resetWebDriverModuleForTests();
    vi.unstubAllGlobals();
  });

  it("reuses an already active Firefox BiDi session at a direct websocket endpoint", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    attachToSession.mockReturnValue({
      capabilities: {
        browserName: "firefox"
      },
      sessionStatus: vi.fn(async () => ({})),
      browsingContextGetTree: vi.fn(async () => ({ contexts: [] })),
      _bidiHandler: {
        close: vi.fn()
      }
    });

    const adapter = new BidiBrowserAdapterFactory().create({
      browserName: "firefox",
      protocol: "bidi",
      wsEndpoint: "ws://127.0.0.1:53453"
    });
    setWebDriverModuleForTests({
      attachToSession
    });

    await adapter.connect();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(attachToSession).toHaveBeenCalledWith({
      sessionId: "bidi-direct",
      capabilities: {
        webSocketUrl: "ws://127.0.0.1:53453/session",
        browserName: "firefox"
      }
    });

    const browser = await adapter.browser();
    await expect(browser.version()).resolves.toBe("firefox");
  });

  it("uses a provided session id and keeps the external session alive on close", async () => {
    const sessionEnd = vi.fn(async () => {});
    const close = vi.fn();

    attachToSession.mockReturnValue({
      capabilities: {
        browserName: "firefox"
      },
      sessionStatus: vi.fn(async () => ({})),
      browsingContextGetTree: vi.fn(async () => ({ contexts: [] })),
      sessionEnd,
      _bidiHandler: {
        waitForConnected: vi.fn(async () => true),
        close
      }
    });

    const adapter = new BidiBrowserAdapterFactory().create({
      browserName: "firefox",
      protocol: "bidi",
      wsEndpoint: "ws://127.0.0.1:53453",
      sessionId: "abc123"
    });
    setWebDriverModuleForTests({
      attachToSession
    });

    await adapter.connect();

    expect(attachToSession).toHaveBeenCalledWith({
      sessionId: "abc123",
      capabilities: {
        webSocketUrl: "ws://127.0.0.1:53453/session/abc123",
        browserName: "firefox"
      }
    });

    const browser = await adapter.browser();
    await browser.close();
    expect(sessionEnd).not.toHaveBeenCalled();

    await adapter.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("creates and ends a BiDi session when none exists yet", async () => {
    const sessionEnd = vi.fn(async () => {});
    const sessionNew = vi.fn(async () => ({
      sessionId: "created-session",
      capabilities: {
        browserName: "firefox"
      }
    }));
    const close = vi.fn();

    attachToSession.mockReturnValue({
      capabilities: {
        browserName: "firefox"
      },
      sessionStatus: vi.fn(async () => ({})),
      browsingContextGetTree: vi.fn(async () => {
        throw new Error("session does not exist");
      }),
      sessionNew,
      sessionEnd,
      _bidiHandler: {
        waitForConnected: vi.fn(async () => true),
        close
      }
    });

    const adapter = new BidiBrowserAdapterFactory().create({
      browserName: "firefox",
      protocol: "bidi",
      wsEndpoint: "ws://127.0.0.1:53453"
    });
    setWebDriverModuleForTests({
      attachToSession
    });

    await adapter.connect();
    const browser = await adapter.browser();
    await browser.close();

    expect(sessionNew).toHaveBeenCalledWith({
      capabilities: {
        alwaysMatch: {
          acceptInsecureCerts: true
        }
      }
    });
    expect(sessionEnd).toHaveBeenCalledWith({});
    await adapter.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
