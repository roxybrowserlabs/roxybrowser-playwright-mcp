import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

async function exposeStub(page: Awaited<Parameters<typeof withPage>[0]> extends (page: infer P, ...args: any[]) => any ? P : never) {
  const calls: Array<{ params: any[] }> = [];
  await page.exposeFunction("stub", async (...params: any[]) => {
    calls.push({ params });
  });
  return calls;
}

describe("page clock contract e2e", () => {
  it("runs timers with Playwright runFor semantics", async () => {
    await withPage(async (page) => {
      const calls = await exposeStub(page);
      await page.clock.install({ time: 0 });
      await page.clock.pauseAt(1000);

      await page.evaluate(async () => {
        setTimeout((window as any).stub, 100);
        setTimeout((window as any).stub, 100);
        setTimeout((window as any).stub, 99);
        setTimeout((window as any).stub, 100);
      });

      await page.clock.runFor(100);

      expect(calls).toHaveLength(4);
      expect(await page.evaluate(() => Date.now())).toBe(1100);
    });
  });

  it("updates Date while ticking like Playwright", async () => {
    await withPage(async (page) => {
      const calls = await exposeStub(page);
      await page.clock.install({ time: 0 });
      await page.clock.pauseAt(1000);
      await page.clock.setSystemTime(0);

      await page.evaluate(async () => {
        setInterval(() => {
          (window as any).stub(new Date().getTime());
        }, 10);
      });

      await page.clock.runFor(100);

      expect(calls).toEqual([
        { params: [10] },
        { params: [20] },
        { params: [30] },
        { params: [40] },
        { params: [50] },
        { params: [60] },
        { params: [70] },
        { params: [80] },
        { params: [90] },
        { params: [100] }
      ]);
    });
  });

  it("supports Playwright string tick arguments and rejects invalid ones", async () => {
    await withPage(async (page) => {
      const calls = await exposeStub(page);
      await page.clock.install({ time: 0 });
      await page.clock.pauseAt(1000);

      await page.evaluate(async () => {
        setInterval((window as any).stub, 6000);
      });

      await page.clock.runFor("01:00");
      expect(calls).toHaveLength(10);

      await expect(page.clock.runFor("12:02:34:10")).rejects.toThrow(
        "Clock only understands numbers, 'mm:ss' and 'hh:mm:ss'"
      );
    });
  });

  it("matches Playwright fastForward semantics for skipped timers", async () => {
    await withPage(async (page) => {
      const calls = await exposeStub(page);
      await page.clock.install({ time: 0 });
      await page.clock.pauseAt(1000);

      await page.evaluate(async () => {
        setTimeout(() => {
          (window as any).stub(Date.now());
        }, 1000);
      });

      await page.clock.fastForward(500);
      expect(calls).toEqual([]);

      await page.clock.fastForward(1500);
      expect(calls).toEqual([{ params: [3000] }]);
    });
  });

  it("replaces global timer and performance primitives like Playwright", async () => {
    await withPage(async (page) => {
      await page.clock.install({ time: 0 });
      await page.clock.pauseAt(1000);

      await page.evaluate(() => {
        (window as any).__clockCalls = [];
        const timeoutId = setTimeout(() => (window as any).__clockCalls.push("timeout"), 1000);
        clearTimeout(timeoutId);
        const intervalId = setInterval(() => (window as any).__clockCalls.push("interval"), 500);
        clearInterval(intervalId);
        (window as any).__timerIdType = typeof setTimeout(() => {}, 1000);
      });

      const performancePromise = page.evaluate<{ prev: number; next: number }>(() => {
        return new Promise((resolve) => {
          const prev = performance.now();
          setTimeout(() => {
            resolve({ prev, next: performance.now() });
          }, 1000);
        });
      });

      await page.clock.runFor(1000);
      const performanceResult = await performancePromise;

      expect(await page.evaluate(() => (window as any).__clockCalls.slice())).toEqual([]);
      expect(await page.evaluate(() => (window as any).__timerIdType)).toBe("number");
      expect(performanceResult.next - performanceResult.prev).toBe(1000);
    });
  });

  it("runs later timers even when an earlier timer throws", async () => {
    await withPage(async (page) => {
      await page.clock.install({ time: 0 });
      await page.clock.pauseAt(1000);

      await page.evaluate(() => {
        (window as any).__clockCalls = [];
        setTimeout(() => {
          throw new Error("boom");
        }, 100);
        setTimeout(() => {
          (window as any).__clockCalls.push("after-error");
        }, 120);
      });

      await expect(page.clock.runFor(120)).rejects.toThrow("boom");
      expect(await page.evaluate(() => (window as any).__clockCalls.slice())).toEqual(["after-error"]);
    });
  });

  it("does not run nested zero-delay timers until the next tick", async () => {
    await withPage(async (page) => {
      await page.clock.install({ time: 0 });
      await page.clock.pauseAt(1000);

      await page.evaluate(() => {
        (window as any).__clockCalls = [];
        setTimeout(() => {
          (window as any).__clockCalls.push("outer");
          setTimeout(() => (window as any).__clockCalls.push("inner"), 0);
        }, 1000);
      });

      await page.clock.runFor(1000);
      expect(await page.evaluate(() => (window as any).__clockCalls.slice())).toEqual(["outer"]);

      await page.clock.runFor(1);
      expect(await page.evaluate(() => (window as any).__clockCalls.slice())).toEqual(["outer", "inner"]);
    });
  });

  it("shares the Playwright-like clock between context and page", async () => {
    await withPage(async (page, context) => {
      expect(page.clock).toBe(context.clock);

      await context.clock.install({ time: 0 });
      await context.clock.pauseAt(1000);
      await page.evaluate(() => {
        (window as any).__clockNow = Date.now();
      });

      expect(await page.evaluate(() => (window as any).__clockNow)).toBe(1000);
    });
  });

  it("replaces global performance.timeOrigin like Playwright", async () => {
    await withPage(async (page) => {
      await page.clock.install({ time: 1000 });
      await page.clock.pauseAt(2000);

      const promise = page.evaluate(async () => {
        const prev = performance.now();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const next = performance.now();
        return { prev, next };
      });

      await page.clock.runFor(1000);

      expect(await page.evaluate(() => performance.timeOrigin)).toBe(1000);
      expect(await promise).toEqual({ prev: 1000, next: 2000 });
    });
  });

  it("propagates paused clock state to popups", async () => {
    await withPage(async (page) => {
      await page.clock.install({ time: 0 });
      const now = new Date("2015-09-25");
      await page.clock.pauseAt(now);

      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate(() => window.open("about:blank"))
      ]);

      expect(await popup.evaluate(() => Date.now())).toBe(now.getTime());

      await page.clock.runFor(1000);
      expect(await popup.evaluate(() => Date.now())).toBe(now.getTime() + 1000);
    });
  });

  it("propagates elapsed clock state to popups opened later", async () => {
    await withPage(async (page) => {
      await page.clock.install({ time: 0 });
      const now = new Date("2015-09-25");
      await page.clock.pauseAt(now);
      await page.clock.runFor(1000);

      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate(() => window.open("about:blank"))
      ]);

      expect(await popup.evaluate(() => Date.now())).toBe(now.getTime() + 1000);
    });
  });

  it("keeps fixed time stable while still allowing native timers", async () => {
    await withPage(async (page) => {
      await page.clock.setFixedTime(100);
      expect(await page.evaluate(() => Date.now())).toBe(100);

      const result = await page.evaluate(() => {
        return new Promise<number>((resolve) => {
          setTimeout(() => resolve(Date.now()), 1);
        });
      });

      expect(result).toBe(100);

      await page.clock.fastForward(20);
      expect(await page.evaluate(() => Date.now())).toBe(100);
    });
  });

  it("allows setting fixed time multiple times and then running fake timers", async () => {
    await withPage(async (page) => {
      const calls = await exposeStub(page);
      await page.clock.setFixedTime(100);
      expect(await page.evaluate(() => Date.now())).toBe(100);

      await page.clock.setFixedTime(200);
      expect(await page.evaluate(() => Date.now())).toBe(200);

      await page.evaluate(() => {
        setTimeout(() => (window as any).stub(Date.now()));
      });

      await page.clock.runFor(0);
      expect(calls).toEqual([{ params: [200] }]);
    });
  });

  it("continues time while running after install", async () => {
    await withPage(async (page) => {
      await page.clock.install({ time: 0 });
      await page.goto("data:text/html,");
      await page.waitForTimeout(1000);

      const now = await page.evaluate(() => Date.now());
      expect(now).toBeGreaterThanOrEqual(1000);
      expect(now).toBeLessThanOrEqual(2000);
    });
  });

  it("can pause and then fastForward like Playwright", async () => {
    await withPage(async (page) => {
      await page.clock.install({ time: 0 });
      await page.goto("data:text/html,");
      await page.clock.pauseAt(1000);
      await page.clock.fastForward(1000);

      expect(await page.evaluate(() => Date.now())).toBe(2000);
    });
  });

  it("AbortSignal.timeout follows fake clock time", async () => {
    await withPage(async (page) => {
      await page.clock.install({ time: 0 });

      const controller = await page.evaluateHandle(() => {
        const signal = AbortSignal.any([AbortSignal.timeout(100)]);
        const handle = {
          signal,
          event: false,
          handler: false
        };
        signal.addEventListener("abort", () => {
          handle.event = true;
        });
        signal.onabort = () => {
          handle.handler = true;
        };
        return handle;
      });

      expect(await controller.evaluate((handle: any) => ({
        signal: handle.signal.aborted,
        event: handle.event,
        handler: handle.handler
      }))).toEqual({
        signal: false,
        event: false,
        handler: false
      });

      await page.clock.runFor(200);

      expect(await controller.evaluate((handle: any) => ({
        signal: handle.signal.aborted,
        event: handle.event,
        handler: handle.handler,
        reason: {
          name: handle.signal.reason.name,
          message: handle.signal.reason.message,
          code: handle.signal.reason.code
        }
      }))).toEqual({
        signal: true,
        event: true,
        handler: true,
        reason: {
          name: "TimeoutError",
          message: "signal timed out",
          code: 23
        }
      });

      expect(await page.evaluate(() => AbortSignal.abort().aborted)).toBe(true);
    });
  });

  it("rounds fractional runFor ticks like Playwright", async () => {
    await withPage(async (page) => {
      await page.clock.install({ time: 0 });
      await page.goto("data:text/html,");
      await page.clock.pauseAt(1000);
      await page.clock.runFor(0.5);

      expect(await page.evaluate(() => Date.now())).toBe(1001);
    });
  });
});
