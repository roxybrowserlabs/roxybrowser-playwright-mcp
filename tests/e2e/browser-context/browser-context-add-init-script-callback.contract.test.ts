import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestBrowser } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

async function waitForCondition(condition: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start <= timeout) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

describe("browser context addInitScript callback contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("should expose functions passed as arguments", async () => {
    const browser = await connectTestBrowser();
    try {
      const context = await browser.newContext();
      const received: string[] = [];
      await context.addInitScript(async ({ cb }) => {
        await cb(location.href);
      }, { cb: async (href: string) => { received.push(href); } }, { exposeFunctions: true });
      const page = await context.newPage();
      await page.goto(fixture.server.EMPTY_PAGE);
      await waitForCondition(() => received.includes(fixture.server.EMPTY_PAGE));
      await context.close();
    } finally {
      await browser.close().catch(() => {});
    }
  });

  it("should remove exposed functions after dispose", async () => {
    const browser = await connectTestBrowser();
    try {
      const context = await browser.newContext();
      const disposable = await context.addInitScript(({ cb }) => {
        (window as typeof window & { cb?: (n: number) => number }).cb = cb;
      }, { cb: (n: number) => n * 2 }, { exposeFunctions: true });
      const page = await context.newPage();
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(await page.evaluate(() => (window as typeof window & { cb: (n: number) => number }).cb(21))).toBe(42);
      await disposable.dispose();
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(await page.evaluate(() => typeof (window as typeof window & { cb?: unknown }).cb)).toBe("undefined");
      await context.close();
    } finally {
      await browser.close().catch(() => {});
    }
  });
});
