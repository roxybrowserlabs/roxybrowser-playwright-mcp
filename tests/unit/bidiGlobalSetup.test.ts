import { beforeEach, describe, expect, it, vi } from "vitest";

const cleanupExternalBidiTestState = vi.fn(async () => {});

vi.mock("../helpers/bidi.js", () => ({
  cleanupExternalBidiTestState
}));

describe("bidi global setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("cleans external BiDi browser state before the suite and on teardown", async () => {
    const module = await import("../helpers/bidi.global-setup.js");

    const teardown = await module.default();
    expect(cleanupExternalBidiTestState).toHaveBeenCalledTimes(1);

    await teardown();
    expect(cleanupExternalBidiTestState).toHaveBeenCalledTimes(2);
  });
});
