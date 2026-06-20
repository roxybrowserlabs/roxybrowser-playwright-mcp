import { afterEach, describe, expect, it, vi } from "vitest";

describe("bidi global setup", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("installs BiDi cleanup hooks in the vitest main process", async () => {
    const installBidiTestCleanupHooks = vi.fn();
    const cleanupExternalBidiTestState = vi.fn(async () => {});

    vi.doMock("../helpers/bidi.js", () => ({
      cleanupExternalBidiTestState,
      installBidiTestCleanupHooks
    }));

    const { default: globalSetup } = await import("../helpers/bidi.global-setup.ts");
    const teardown = await globalSetup();

    expect(installBidiTestCleanupHooks).toHaveBeenCalledTimes(1);
    expect(cleanupExternalBidiTestState).toHaveBeenCalledTimes(1);

    await teardown();

    expect(cleanupExternalBidiTestState).toHaveBeenCalledTimes(2);
  });
});
