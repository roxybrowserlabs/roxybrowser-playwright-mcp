import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium } from "../../../src/index.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

function launchBrowser() {
  return chromium.launch({
    headless: true,
    ...(process.env.ROXY_E2E_EXECUTABLE_PATH
      ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
      : {})
  });
}

describe("browser context route contract e2e", () => {
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

  it("intercepts through context.route like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        let intercepted = false;
        await context.route("**/empty.html", async (route) => {
          intercepted = true;
          const request = route.request();
          expect(request.url()).toContain("empty.html");
          expect(request.headers()["user-agent"]).toBeTruthy();
          expect(request.method()).toBe("GET");
          expect(request.postData()).toBe(null);
          expect(request.isNavigationRequest()).toBe(true);
          expect(request.resourceType()).toBe("document");
          await route.continue();
        });

        const page = await context.newPage();
        try {
          const response = await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(response?.ok()).toBe(true);
          expect(intercepted).toBe(true);
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("supports context.unroute lifecycle like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          let intercepted: number[] = [];
          await context.route("**/*", async (route) => {
            intercepted.push(1);
            await route.fallback();
          });
          await context.route("**/empty.html", async (route) => {
            intercepted.push(2);
            await route.fallback();
          });
          await context.route("**/empty.html", async (route) => {
            intercepted.push(3);
            await route.fallback();
          });
          const handler4 = async (route: Parameters<typeof context.route>[1] extends infer T ? T extends (...args: any[]) => any ? Parameters<T>[0] : never : never) => {
            intercepted.push(4);
            await route.fallback();
          };

          await context.route(/empty.html/, handler4 as never);
          await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(intercepted).toEqual([4, 3, 2, 1]);

          intercepted = [];
          await context.unroute(/empty.html/, handler4 as never);
          await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(intercepted).toEqual([3, 2, 1]);

          intercepted = [];
          await context.unroute("**/empty.html");
          await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(intercepted).toEqual([1]);
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("yields to page.route before context.route like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        await context.route("**/empty.html", async (route) => {
          await route.fulfill({ status: 200, body: "context" });
        });
        const page = await context.newPage();
        try {
          await page.route("**/empty.html", async (route) => {
            await route.fulfill({ status: 200, body: "page" });
          });
          const response = await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(response?.ok()).toBe(true);
          expect(await response?.text()).toBe("page");
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("falls back from page.route to context.route like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        await context.route("**/empty.html", async (route) => {
          await route.fulfill({ status: 200, body: "context" });
        });
        const page = await context.newPage();
        try {
          await page.route("**/non-empty.html", async (route) => {
            await route.fulfill({ status: 200, body: "page" });
          });
          const response = await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(response?.ok()).toBe(true);
          expect(await response?.text()).toBe("context");
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
});
