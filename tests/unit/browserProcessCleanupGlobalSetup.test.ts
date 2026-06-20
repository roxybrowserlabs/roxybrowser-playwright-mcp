import { afterEach, describe, expect, it, vi } from "vitest";

describe("browser process cleanup global setup", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("installs process cleanup hooks in the vitest main process", async () => {
    const installLocalTestBrowserProcessCleanupHooks = vi.fn();
    const cleanupLocalTestBrowserProcessesWithTimeout = vi.fn(async () => {});

    vi.doMock("../helpers/browser-process-cleanup.js", () => ({
      cleanupLocalTestBrowserProcessesWithTimeout,
      installLocalTestBrowserProcessCleanupHooks
    }));

    const { default: globalSetup } = await import("../helpers/browser-process-cleanup.global-setup.ts");
    const teardown = await globalSetup();

    expect(installLocalTestBrowserProcessCleanupHooks).toHaveBeenCalledTimes(1);
    expect(cleanupLocalTestBrowserProcessesWithTimeout).toHaveBeenCalledTimes(1);

    await teardown();

    expect(cleanupLocalTestBrowserProcessesWithTimeout).toHaveBeenCalledTimes(2);
  });
});
