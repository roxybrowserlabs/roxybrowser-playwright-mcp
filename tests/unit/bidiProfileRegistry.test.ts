import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const closeRoxyBrowserFirefoxBidiProfile = vi.fn(async () => {});
const openRoxyBrowserFirefoxBidiProfile = vi.fn(async () => ({
  dirId: "created-profile",
  endpoint: "ws://127.0.0.1:9222/session",
  sessionId: "script-session",
  created: true
}));

vi.mock("../../scripts/roxybrowser-firefox-bidi.mjs", () => ({
  closeRoxyBrowserFirefoxBidiProfile,
  openRoxyBrowserFirefoxBidiProfile
}));

const page = { close: vi.fn(async () => {}) };
const context = {
  newPage: vi.fn(async () => page),
  close: vi.fn(async () => {})
};
const browser = {
  contexts: vi.fn(() => [] as typeof context[]),
  newContext: vi.fn(async () => context),
  close: vi.fn(async () => {})
};
const connect = vi.fn(async () => browser);

vi.mock("../../src/index.js", () => ({
  firefox: { connect }
}));

vi.mock("../helpers/browser-process-cleanup.js", () => ({
  cleanupCurrentWorkerTestBrowserProcesses: vi.fn(async () => {}),
  cleanupCurrentWorkerTestBrowserProcessesSync: vi.fn(() => {}),
  configureCurrentWorkerTestBrowserCleanup: vi.fn(() => "/tmp/roxybrowser-worker-registry.jsonl")
}));

function registryPath(): string {
  const worker = process.env.VITEST_POOL_ID ?? "main";
  return join(tmpdir(), `roxybrowser-bidi-profile-registry-${worker}-${process.pid}.jsonl`);
}

describe("bidi RoxyBrowser profile registry", () => {
  beforeEach(() => {
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
    delete process.env.VITEST_POOL_ID;
    rmSync(registryPath(), { force: true });
  });

  afterEach(() => {
    rmSync(registryPath(), { force: true });
  });

  it("records a newly created profile to the on-disk registry when opened", async () => {
    const { openBidiBrowser } = await import("../helpers/bidi.js");

    await openBidiBrowser();

    const text = readFileSync(registryPath(), "utf8");
    expect(JSON.parse(text.trim())).toEqual({ dirId: "created-profile" });
  });

  it("does not record a profile that was reused rather than created", async () => {
    openRoxyBrowserFirefoxBidiProfile.mockResolvedValueOnce({
      dirId: "reused-profile",
      endpoint: "ws://127.0.0.1:9222/session",
      sessionId: "script-session",
      created: false
    });

    const { openBidiBrowser } = await import("../helpers/bidi.js");
    await openBidiBrowser();

    expect(existsSync(registryPath())).toBe(false);
  });

  it("removes the registry entry once the profile is actually deleted", async () => {
    const { openBidiBrowser, cleanupExternalBidiTestState } = await import("../helpers/bidi.js");
    await openBidiBrowser();
    expect(existsSync(registryPath())).toBe(true);

    await cleanupExternalBidiTestState();

    expect(closeRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledWith(
      expect.objectContaining({ dirId: "created-profile", deleteProfile: true })
    );
    expect(existsSync(registryPath())).toBe(false);
  });

  it("sweeps every recorded profile and clears the registry file", async () => {
    writeFileSync(
      registryPath(),
      `${JSON.stringify({ dirId: "orphaned-profile-1" })}\n${JSON.stringify({ dirId: "orphaned-profile-2" })}\n`
    );

    const { cleanupOrphanedRoxyBrowserProfiles } = await import("../helpers/bidi.js");
    await cleanupOrphanedRoxyBrowserProfiles();

    expect(closeRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledWith({
      apiPort: "50000",
      apiToken: "test-token",
      workspaceId: undefined,
      dirId: "orphaned-profile-1",
      deleteProfile: true
    });
    expect(closeRoxyBrowserFirefoxBidiProfile).toHaveBeenCalledWith({
      apiPort: "50000",
      apiToken: "test-token",
      workspaceId: undefined,
      dirId: "orphaned-profile-2",
      deleteProfile: true
    });
    expect(existsSync(registryPath())).toBe(false);
  });

  it("skips the sweep entirely when no RoxyBrowser token is configured", async () => {
    writeFileSync(registryPath(), `${JSON.stringify({ dirId: "orphaned-profile" })}\n`);
    delete process.env.ROXYBROWSER_API_TOKEN;
    delete process.env.ROXY_API_TOKEN;

    const { cleanupOrphanedRoxyBrowserProfiles } = await import("../helpers/bidi.js");
    await cleanupOrphanedRoxyBrowserProfiles();

    expect(closeRoxyBrowserFirefoxBidiProfile).not.toHaveBeenCalled();
    expect(existsSync(registryPath())).toBe(true);
  });
});
