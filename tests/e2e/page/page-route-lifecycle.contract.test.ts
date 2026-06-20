import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

describe("page route lifecycle contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  beforeEach(() => {
    fixture.server.reset();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("page.close does not wait for active route handlers like Playwright", async () => {
    await withPage(async (page) => {
      let secondHandlerCalled = false;
      await page.route(/.*/, () => {
        secondHandlerCalled = true;
      });

      let routeCallback!: () => void;
      const routePromise = new Promise<void>((resolve) => {
        routeCallback = resolve;
      });

      await page.route(/.*/, async () => {
        routeCallback();
        await new Promise(() => {});
      });

      void page.goto(fixture.server.EMPTY_PAGE).catch(() => {});
      await routePromise;
      await withTimeout(page.close(), "page.close", 1000);
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(secondHandlerCalled).toBe(false);
    });
  });

  it("route.continue does not throw after page close like Playwright", async () => {
    await withPage(async (page) => {
      let routeCallback!: (route: any) => void;
      const routePromise = new Promise<any>((resolve) => {
        routeCallback = resolve;
      });

      await page.route(/.*/, async (route) => {
        routeCallback(route);
      });

      void page.goto(fixture.server.EMPTY_PAGE).catch(() => {});
      const route = await routePromise;
      await page.close();

      await expect(route.continue()).resolves.toBeUndefined();
    });
  });

  it("route.fallback does not throw after page close like Playwright", async () => {
    await withPage(async (page) => {
      let routeCallback!: (route: any) => void;
      const routePromise = new Promise<any>((resolve) => {
        routeCallback = resolve;
      });

      await page.route(/.*/, async (route) => {
        routeCallback(route);
      });

      void page.goto(fixture.server.EMPTY_PAGE).catch(() => {});
      const route = await routePromise;
      await page.close();

      await expect(route.fallback()).resolves.toBeUndefined();
    });
  });

  it("route.fulfill does not throw after page close like Playwright", async () => {
    await withPage(async (page) => {
      let routeCallback!: (route: any) => void;
      const routePromise = new Promise<any>((resolve) => {
        routeCallback = resolve;
      });

      await page.route(/.*/, async (route) => {
        routeCallback(route);
      });

      void page.goto(fixture.server.EMPTY_PAGE).catch(() => {});
      const route = await routePromise;
      await page.close();

      await expect(route.fulfill()).resolves.toBeUndefined();
    });
  });

  it("does not continue requests in flight during page.unrouteAll wait like Playwright", async () => {
    await withPage(async (page) => {
      let routeCallback!: () => void;
      const routePromise = new Promise<void>((resolve) => {
        routeCallback = resolve;
      });

      await page.goto(fixture.server.EMPTY_PAGE);
      await page.route("**/*", async (route) => {
        routeCallback();
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const response = await route.fetch();
        await route.fulfill({ response });
      });

      void page.evaluate(() => fetch("/")).catch(() => {});
      await routePromise;
      await withTimeout(page.unrouteAll({ behavior: "wait" }), "page.unrouteAll", 6000);
    });
  });
});
