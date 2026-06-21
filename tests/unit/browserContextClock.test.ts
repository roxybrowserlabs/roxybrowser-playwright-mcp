import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { RoxyBrowserContextClockDelegate } from "../../src/browserContextClock.js";
import { RoxyClock } from "../../src/clock.js";

class ClockHost {
  readonly initScripts: Array<{
    arg?: unknown;
    source: string;
  }> = [];
  readonly window = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "https://example.com"
  }).window;

  constructor() {
    let performance = this.window.performance;
    Object.defineProperty(this.window, "performance", {
      get() {
        return performance;
      },
      set(value) {
        performance = value;
      },
      configurable: true
    });
  }
  async addInitScript(source: string | ((arg?: unknown) => unknown), arg?: unknown) {
    this.initScripts.push({ source: typeof source === "string" ? source : source.toString(), arg });
    return { dispose() {} };
  }

  async evaluate<TResult>(pageFunction: string | ((arg?: unknown) => TResult), arg?: unknown): Promise<TResult> {
    if (typeof pageFunction === "function") {
      return await pageFunction.call(this.window, arg);
    }
    const runner = this.window.Function(
      "arg",
      `return (${pageFunction})(arg);`
    ) as (value?: unknown) => TResult | Promise<TResult>;
    return await runner.call(this.window, arg);
  }
}

async function createClockHarness() {
  const delegate = new RoxyBrowserContextClockDelegate();
  const clock = new RoxyClock(delegate);
  const host = new ClockHost();
  await delegate.attachPage(host);
  return {
    delegate,
    clock,
    host
  };
}

describe("RoxyBrowserContextClockDelegate", () => {
  it("runs Playwright-style timers on attached pages", async () => {
    const { clock, host } = await createClockHarness();
    await clock.install({ time: 0 });
    await clock.pauseAt(1000);
    await host.evaluate(`() => {
      globalThis.__clockCalls = [];
      globalThis.setTimeout(() => {
        globalThis.__clockCalls.push(globalThis.Date.now());
      }, 100);
    }`);

    await clock.runFor(100);

    expect(await host.evaluate<number[]>(`() => globalThis.__clockCalls.slice()`)).toEqual([1100]);
    expect(await host.evaluate<number>(`() => globalThis.Date.now()`)).toBe(1100);
  });

  it("replays prior clock history when a later page attaches", async () => {
    const { delegate, clock, host: firstHost } = await createClockHarness();
    await clock.install({ time: 0 });
    await clock.pauseAt(2000);
    await clock.setSystemTime(2500);

    const secondHost = new ClockHost();
    await delegate.attachPage(secondHost);

    expect(await secondHost.evaluate<number>(`() => globalThis.Date.now()`)).toBe(2500);
    await secondHost.evaluate(`() => {
      globalThis.__clockCalls = [];
      globalThis.setTimeout(() => {
        globalThis.__clockCalls.push(globalThis.Date.now());
      }, 50);
    }`);

    await clock.runFor(50);

    expect(
      await secondHost.evaluate<number[]>(`() => globalThis.__clockCalls.slice()`)
    ).toEqual([2550]);
  });

  it("understands Playwright tick strings and validates invalid ones", async () => {
    const { clock, host } = await createClockHarness();
    let fired = 0;

    await clock.install({ time: 0 });
    await clock.pauseAt(0);
    await host.evaluate(`() => {
      globalThis.setInterval(() => {
        globalThis.__fired += 1;
      }, 10000);
    }`);
    await host.evaluate(`() => {
      globalThis.__fired = 0;
    }`);

    await clock.runFor("01:00");
    await expect(clock.runFor("12:02:34:10")).rejects.toThrow(
      "Clock only understands numbers, 'mm:ss' and 'hh:mm:ss'"
    );

    fired = await host.evaluate<number>(`() => globalThis.__fired`);
    expect(fired).toBe(6);
  });

  it("matches Playwright runFor timer scheduling semantics", async () => {
    const { clock, host } = await createClockHarness();

    await clock.install({ time: 0 });
    await clock.pauseAt(1000);
    await host.evaluate(`() => {
      globalThis.__clockCalls = [];
      globalThis.setTimeout(() => globalThis.__clockCalls.push("immediate"), 0);
      globalThis.setTimeout(() => globalThis.__clockCalls.push("late"), 100);
    }`);

    await clock.runFor(0);
    expect(await host.evaluate<string[]>(`() => globalThis.__clockCalls.slice()`)).toEqual(["immediate"]);

    await clock.runFor(10);
    expect(await host.evaluate<string[]>(`() => globalThis.__clockCalls.slice()`)).toEqual(["immediate"]);

    await clock.runFor(90);
    expect(await host.evaluate<string[]>(`() => globalThis.__clockCalls.slice()`)).toEqual([
      "immediate",
      "late"
    ]);
  });

  it("matches Playwright fastForward semantics for skipped timers", async () => {
    const { clock, host } = await createClockHarness();

    await clock.install({ time: 0 });
    await clock.pauseAt(1000);
    await host.evaluate(`() => {
      globalThis.__clockCalls = [];
      globalThis.setTimeout(() => {
        globalThis.__clockCalls.push(globalThis.Date.now());
      }, 1000);
    }`);

    await clock.fastForward(500);
    expect(await host.evaluate<number[]>(`() => globalThis.__clockCalls.slice()`)).toEqual([]);

    await clock.fastForward(1500);
    expect(await host.evaluate<number[]>(`() => globalThis.__clockCalls.slice()`)).toEqual([3000]);
  });

  it("keeps fixed time stable while allowing fake timers to run", async () => {
    const { clock, host } = await createClockHarness();

    await clock.setFixedTime(100);
    expect(await host.evaluate<number>(`() => globalThis.Date.now()`)).toBe(100);

    await host.evaluate(`() => {
      globalThis.__clockCalls = [];
      globalThis.setTimeout(() => {
        globalThis.__clockCalls.push(globalThis.Date.now());
      }, 0);
    }`);

    await clock.runFor(0);
    expect(await host.evaluate<number[]>(`() => globalThis.__clockCalls.slice()`)).toEqual([100]);

    await clock.fastForward(20);
    expect(await host.evaluate<number>(`() => globalThis.Date.now()`)).toBe(100);
  });

  it("replaces global timer and performance primitives like Playwright clock", async () => {
    const { clock, host } = await createClockHarness();

    await clock.install({ time: 0 });
    await clock.pauseAt(1000);

    await host.evaluate(`() => {
      globalThis.__clockCalls = [];
      const timeoutId = globalThis.setTimeout(() => globalThis.__clockCalls.push("timeout"), 1000);
      globalThis.clearTimeout(timeoutId);
      const intervalId = globalThis.setInterval(() => globalThis.__clockCalls.push("interval"), 500);
      globalThis.clearInterval(intervalId);
      globalThis.__timerIdType = typeof globalThis.setTimeout(() => {}, 1000);
    }`);

    const performancePromise = host.evaluate<{ prev: number; next: number }>(`() => {
      return new Promise(resolve => {
        const prev = globalThis.performance.now();
        globalThis.setTimeout(() => {
          resolve({ prev, next: globalThis.performance.now() });
        }, 1000);
      });
    }`);

    await clock.runFor(1000);

    const performanceResult = await performancePromise;

    expect(await host.evaluate<string[]>(`() => globalThis.__clockCalls.slice()`)).toEqual([]);
    expect(await host.evaluate<string>(`() => globalThis.__timerIdType`)).toBe("number");
    expect(performanceResult).toEqual(
      expect.objectContaining({
        next: expect.any(Number),
        prev: expect.any(Number)
      })
    );
    expect(performanceResult.next - performanceResult.prev).toBe(1000);
  });

  it("runs later timers even when an earlier timer throws", async () => {
    const { clock, host } = await createClockHarness();

    await clock.install({ time: 0 });
    await clock.pauseAt(1000);
    await host.evaluate(`() => {
      globalThis.__clockCalls = [];
      globalThis.setTimeout(() => {
        throw new Error("boom");
      }, 100);
      globalThis.setTimeout(() => {
        globalThis.__clockCalls.push("after-error");
      }, 120);
    }`);

    await expect(clock.runFor(120)).rejects.toThrow("boom");
    expect(await host.evaluate<string[]>(`() => globalThis.__clockCalls.slice()`)).toEqual([
      "after-error"
    ]);
  });

  it("does not run nested zero-delay timers until the next tick", async () => {
    const { clock, host } = await createClockHarness();

    await clock.install({ time: 0 });
    await clock.pauseAt(1000);
    await host.evaluate(`() => {
      globalThis.__clockCalls = [];
      globalThis.setTimeout(() => {
        globalThis.__clockCalls.push("outer");
        globalThis.setTimeout(() => globalThis.__clockCalls.push("inner"), 0);
      }, 1000);
    }`);

    await clock.runFor(1000);
    expect(await host.evaluate<string[]>(`() => globalThis.__clockCalls.slice()`)).toEqual(["outer"]);

    await clock.runFor(1);
    expect(await host.evaluate<string[]>(`() => globalThis.__clockCalls.slice()`)).toEqual([
      "outer",
      "inner"
    ]);
  });

});
