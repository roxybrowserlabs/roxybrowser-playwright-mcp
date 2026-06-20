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
  });

  it("cleans stale Firefox state before opening a new local browser", async () => {
    const { withBidiPage } = await import("../helpers/bidi.js");

    await withBidiPage(async () => {
      events.push("run");
    });

    expect(events[0]).toBe("close-profile");
    expect(events[1]).toBe("cleanup");
    expect(events[2]).toBe("launch");
    expect(events).toContain("browser.close");
    expect(cleanupLocalTestBrowserProcessesWithTimeout).toHaveBeenCalledTimes(2);
    expect(closeRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledTimes(1);
    expect(resolveRoxyBrowserFirefoxBidiEndpoint).not.toHaveBeenCalled();
  });
});
