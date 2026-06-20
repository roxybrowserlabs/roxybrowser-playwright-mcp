import { beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];
const cleanupLocalTestBrowserProcessesWithTimeout = vi.fn(async () => {
  events.push("cleanup");
});
const closeRoxyBrowserFirefoxBidiProfile = vi.fn(async () => {
  events.push("close-profile");
});
const resolveRoxyBrowserFirefoxBidiEndpoint = vi.fn(async () => undefined);

const page = {
  close: vi.fn(async () => {
    events.push("page.close");
  })
};
const context = {
  newPage: vi.fn(async () => page),
  close: vi.fn(async () => {
    events.push("context.close");
  })
};
const browser = {
  newContext: vi.fn(async () => context),
  close: vi.fn(async () => {
    events.push("browser.close");
  })
};
const launch = vi.fn(async () => {
  events.push("launch");
  return browser;
});

vi.mock("../../src/index.js", () => ({
  firefox: {
    connect: vi.fn(),
    launch
  }
}));

vi.mock("../../scripts/roxybrowser-firefox-bidi.mjs", () => ({
  closeRoxyBrowserFirefoxBidiProfile,
  resolveRoxyBrowserFirefoxBidiEndpoint
}));

vi.mock("../helpers/browser-process-cleanup.js", () => ({
  cleanupLocalTestBrowserProcessesWithTimeout
}));

describe("bidi helper cleanup", () => {
  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.ROXY_BIDI_WS_ENDPOINT;
    delete process.env.ROXY_BIDI_KEEP_BROWSER_OPEN;
    delete process.env.ROXY_BIDI_REUSE_BROWSER;
    delete process.env.ROXY_BIDI_USE_ROXYBROWSER_API;
    delete process.env.ROXYBROWSER_API_TOKEN;
  });

  it("cleans stale Firefox state before opening a shared local browser", async () => {
    const { cleanupExternalBidiTestState, withBidiPage } = await import("../helpers/bidi.js");

    await withBidiPage(async () => {
      events.push("run");
    });

    expect(events[0]).toBe("close-profile");
    expect(events[1]).toBe("cleanup");
    expect(events[2]).toBe("launch");
    expect(events).not.toContain("browser.close");
    expect(cleanupLocalTestBrowserProcessesWithTimeout).toHaveBeenCalledTimes(1);
    expect(closeRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledTimes(1);
    expect(resolveRoxyBrowserFirefoxBidiEndpoint).not.toHaveBeenCalled();

    await cleanupExternalBidiTestState();

    expect(events).toContain("browser.close");
    expect(cleanupLocalTestBrowserProcessesWithTimeout).toHaveBeenCalledTimes(2);
    expect(closeRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledTimes(2);
  });

  it("closes the local Firefox browser after each bidi test", async () => {
    const {
      cleanupBidiTestStateAfterTest,
      cleanupExternalBidiTestState,
      withBidiPage
    } = await import("../helpers/bidi.js");

    await withBidiPage(async () => {
      events.push("run:first");
    });
    await cleanupBidiTestStateAfterTest();
    await withBidiPage(async () => {
      events.push("run:second");
    });

    expect(launch).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event === "browser.close")).toHaveLength(0);
    expect(cleanupLocalTestBrowserProcessesWithTimeout).toHaveBeenCalledTimes(1);

    await cleanupExternalBidiTestState();

    expect(events.filter((event) => event === "browser.close")).toHaveLength(1);
    expect(cleanupLocalTestBrowserProcessesWithTimeout).toHaveBeenCalledTimes(2);
  });

  it("keeps an explicitly reused external Firefox browser open across bidi tests", async () => {
    process.env.ROXY_BIDI_WS_ENDPOINT = "ws://127.0.0.1:9222";
    process.env.ROXY_BIDI_REUSE_BROWSER = "1";

    const connect = vi.fn(async () => {
      events.push("connect");
      return browser;
    });

    vi.doMock("../../src/index.js", () => ({
      firefox: {
        connect,
        launch
      }
    }));

    const {
      cleanupBidiTestStateAfterTest,
      cleanupExternalBidiTestState,
      withBidiPage
    } = await import("../helpers/bidi.js");

    await withBidiPage(async () => {
      events.push("run:first");
    });
    await cleanupBidiTestStateAfterTest();
    await withBidiPage(async () => {
      events.push("run:second");
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event === "browser.close")).toHaveLength(0);

    await cleanupExternalBidiTestState();

    expect(events.filter((event) => event === "browser.close")).toHaveLength(1);
  });

  it("closes a non-reused external Firefox browser after each bidi test", async () => {
    process.env.ROXY_BIDI_WS_ENDPOINT = "ws://127.0.0.1:9222";

    const connect = vi.fn(async () => {
      events.push("connect");
      return browser;
    });

    vi.doMock("../../src/index.js", () => ({
      firefox: {
        connect,
        launch
      }
    }));

    const {
      cleanupBidiTestStateAfterTest,
      cleanupExternalBidiTestState,
      withBidiPage
    } = await import("../helpers/bidi.js");

    await withBidiPage(async () => {
      events.push("run:first");
    });
    await cleanupBidiTestStateAfterTest();
    await withBidiPage(async () => {
      events.push("run:second");
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event === "browser.close")).toHaveLength(0);

    await cleanupExternalBidiTestState();

    expect(events.filter((event) => event === "browser.close")).toHaveLength(1);
  });

  it("closes a managed RoxyBrowser Firefox profile after each bidi test", async () => {
    process.env.ROXY_BIDI_USE_ROXYBROWSER_API = "1";
    process.env.ROXYBROWSER_API_TOKEN = "test-token";
    resolveRoxyBrowserFirefoxBidiEndpoint.mockResolvedValue("ws://127.0.0.1:9222");

    const connect = vi.fn(async () => {
      events.push("connect");
      return browser;
    });

    vi.doMock("../../src/index.js", () => ({
      firefox: {
        connect,
        launch
      }
    }));

    const {
      cleanupBidiTestStateAfterTest,
      cleanupExternalBidiTestState,
      withBidiPage
    } = await import("../helpers/bidi.js");

    await withBidiPage(async () => {
      events.push("run:first");
    });
    await cleanupBidiTestStateAfterTest();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event === "browser.close")).toHaveLength(0);
    expect(closeRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledTimes(1);
    expect(cleanupLocalTestBrowserProcessesWithTimeout).toHaveBeenCalledTimes(1);

    await cleanupExternalBidiTestState();

    expect(events.filter((event) => event === "browser.close")).toHaveLength(1);
    expect(closeRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledTimes(2);
    delete process.env.ROXY_BIDI_USE_ROXYBROWSER_API;
    delete process.env.ROXYBROWSER_API_TOKEN;
  });
});
