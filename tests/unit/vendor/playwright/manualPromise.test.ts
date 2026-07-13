import { describe, expect, it } from "vitest";
import {
  LongStandingScope,
  ManualPromise,
  signalToPromise
} from "../../../../src/vendor/playwright/manualPromise.js";

describe("Playwright manual promise primitives", () => {
  it("tracks manual resolution and rejection", async () => {
    const resolved = new ManualPromise<string>();
    expect(resolved.isDone()).toBe(false);
    resolved.resolve("done");
    expect(resolved.isDone()).toBe(true);
    await expect(resolved).resolves.toBe("done");

    const rejected = new ManualPromise<void>();
    rejected.reject(new Error("failed"));
    expect(rejected.isDone()).toBe(true);
    await expect(rejected).rejects.toThrow("failed");
  });

  it("races operations against close and reject lifecycles", async () => {
    const closeScope = new LongStandingScope();
    const pending = new ManualPromise<string>();
    const closed = closeScope.race(pending);
    closeScope.close(new Error("closed"));
    expect(closeScope.isClosed()).toBe(true);
    await expect(closed).rejects.toThrow("closed");

    const rejectScope = new LongStandingScope();
    const rejected = rejectScope.race(new ManualPromise<string>());
    rejectScope.reject(new Error("terminated"));
    await expect(rejected).rejects.toThrow("terminated");
  });

  it("supports safe races and multiple scopes", async () => {
    const safeScope = new LongStandingScope();
    const safeResult = safeScope.safeRace(new ManualPromise<string>(), "fallback");
    safeScope.close(new Error("closed"));
    await expect(safeResult).resolves.toBe("fallback");

    const first = new LongStandingScope();
    const second = new LongStandingScope();
    const result = LongStandingScope.raceMultiple(
      [first, second],
      Promise.resolve("value")
    );
    await expect(result).resolves.toBe("value");
  });

  it("turns abort signals into disposable promises", async () => {
    const controller = new AbortController();
    const abort = signalToPromise(controller.signal);
    controller.abort();
    await expect(abort.promise).resolves.toBeUndefined();

    const detachedController = new AbortController();
    const detached = signalToPromise(detachedController.signal);
    detached.dispose();
    detachedController.abort();
    let settled = false;
    void detached.promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(signalToPromise(alreadyAborted.signal).promise).resolves.toBeUndefined();
  });
});
