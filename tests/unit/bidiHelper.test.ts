import { beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];
const cleanupCurrentWorkerTestBrowserProcesses = vi.fn(async () => {
  events.push("cleanup");
});
const cleanupCurrentWorkerTestBrowserProcessesSync = vi.fn(() => {
  events.push("cleanup-sync");
});
const configureCurrentWorkerTestBrowserCleanup = vi.fn(() => {
  events.push("configure-cleanup");
  return "/tmp/roxybrowser-worker-registry.jsonl";
});
const closeRoxyBrowserFirefoxBidiProfile = vi.fn(async () => {
  events.push("close-profile");
});
const openRoxyBrowserFirefoxBidiProfile = vi.fn(async () => ({
  dirId: "worker-profile",
  endpoint: "ws://127.0.0.1:9222/session",
  created: true
}));

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
  contexts: vi.fn(() => [] as typeof context[]),
  newContext: vi.fn(async () => context),
  close: vi.fn(async () => {
    events.push("browser.close");
  })
};
const connect = vi.fn(async () => {
  events.push("connect");
  return browser;
});

vi.mock("../../src/index.js", () => ({
  firefox: {
    connect
  }
}));

vi.mock("../../scripts/roxybrowser-firefox-bidi.mjs", () => ({
  closeRoxyBrowserFirefoxBidiProfile,
  openRoxyBrowserFirefoxBidiProfile
}));

vi.mock("../helpers/browser-process-cleanup.js", () => ({
  cleanupCurrentWorkerTestBrowserProcesses,
  cleanupCurrentWorkerTestBrowserProcessesSync,
  configureCurrentWorkerTestBrowserCleanup
}));

describe("bidi helper cleanup", () => {
  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
    vi.resetModules();
    delete (globalThis as typeof globalThis & {
      __roxyBidiTestState?: unknown;
      __roxyBidiTestCleanupHooksInstalled?: boolean;
    }).__roxyBidiTestState;
    delete (globalThis as typeof globalThis & {
      __roxyBidiTestState?: unknown;
      __roxyBidiTestCleanupHooksInstalled?: boolean;
    }).__roxyBidiTestCleanupHooksInstalled;
    process.env.ROXYBROWSER_API_TOKEN = "test-token";
    delete process.env.ROXY_BIDI_REUSE_BROWSER;
    delete process.env.ROXY_BIDI_WS_ENDPOINT;
    delete process.env.VITEST_POOL_ID;
  });

  it("reuses a worker-scoped RoxyBrowser profile by default and cleans it up after worker teardown", async () => {
    const { cleanupExternalBidiTestState, withBidiPage } = await import("../helpers/bidi.js");

    await withBidiPage(async () => {
      events.push("run:first");
    });
    await withBidiPage(async () => {
      events.push("run:second");
    });

    expect(configureCurrentWorkerTestBrowserCleanup).toHaveBeenCalledTimes(2);
    expect(openRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event === "browser.close")).toHaveLength(0);
    expect(closeRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledTimes(0);
    expect(cleanupCurrentWorkerTestBrowserProcesses).toHaveBeenCalledTimes(0);

    await cleanupExternalBidiTestState();

    expect(events.filter((event) => event === "browser.close")).toHaveLength(1);
    expect(closeRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledTimes(1);
    expect(closeRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledWith({
      apiPort: "50000",
      apiToken: "test-token",
      workspaceId: undefined,
      dirId: "worker-profile",
      deleteProfile: true
    });
    expect(cleanupCurrentWorkerTestBrowserProcesses).toHaveBeenCalledTimes(1);
  });

  it("can opt out of worker-scoped reuse when explicitly configured", async () => {
    process.env.ROXY_BIDI_REUSE_BROWSER = "0";

    const { cleanupExternalBidiTestState, withBidiPage } = await import("../helpers/bidi.js");

    await withBidiPage(async () => {
      events.push("run:first");
    });
    await withBidiPage(async () => {
      events.push("run:second");
    });

    expect(openRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event === "browser.close")).toHaveLength(2);
    expect(closeRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledTimes(2);
    expect(cleanupCurrentWorkerTestBrowserProcesses).toHaveBeenCalledTimes(4);

    await cleanupExternalBidiTestState();

    expect(closeRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledTimes(2);
    expect(cleanupCurrentWorkerTestBrowserProcesses).toHaveBeenCalledTimes(5);
  });

  it("uses a worker-specific remark/name when opening a managed RoxyBrowser profile", async () => {
    process.env.VITEST_POOL_ID = "2";
    vi.resetModules();

    const { cleanupExternalBidiTestState, withBidiPage } = await import("../helpers/bidi.js");

    await withBidiPage(async () => {
      events.push("run");
    });

    expect(openRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "RoxyBrowser Firefox BiDi E2E [worker 2]",
        windowRemark: "firefox bidi e2e worker-2"
      })
    );

    await cleanupExternalBidiTestState();
    delete process.env.VITEST_POOL_ID;
  });
});
