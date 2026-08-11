import { describe, expect, it } from "vitest";
import { abortableDelay, throwIfAborted } from "../../src/abortSignal.js";

describe("abort signal helpers", () => {
  it("throws AbortError with the signal reason as cause", () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    controller.abort(reason);

    expect(() => throwIfAborted({ signal: controller.signal })).toThrow("The operation was aborted");
    try {
      throwIfAborted({ signal: controller.signal });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("AbortError");
      expect((error as Error).cause).toBe(reason);
    }
  });

  it("aborts pending delays", async () => {
    const controller = new AbortController();
    const delay = abortableDelay(10_000, { signal: controller.signal }).catch((error) => error);
    const reason = new Error("cancelled");
    controller.abort(reason);

    const error = await delay;
    expect(error.name).toBe("AbortError");
    expect(error.cause).toBe(reason);
  });
});
