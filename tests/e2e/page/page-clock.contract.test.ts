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
});
