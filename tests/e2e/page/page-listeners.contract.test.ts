import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page listeners contract e2e", () => {
  it("should not throw with ignoreErrors like Playwright", async () => {
    await withPage(async (page) => {
      let release!: () => void;
      const unblock = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reachedHandler = false;

      page.on("console", async () => {
        reachedHandler = true;
        await unblock;
        throw new Error("Error in console handler");
      });

      await page.evaluate("console.log(1)");
      await expect.poll(() => reachedHandler).toBe(true);
      await page.removeAllListeners("console", { behavior: "ignoreErrors" });
      release();
      await page.waitForTimeout(1000);
    });
  });

  it("should wait like Playwright", async () => {
    await withPage(async (page) => {
      let value = 0;
      let reachedHandler = false;

      page.on("console", async () => {
        reachedHandler = true;
        value = 42;
      });

      await page.evaluate("console.log(1)");
      await expect.poll(() => reachedHandler).toBe(true);
      const removePromise = page.removeAllListeners("console", { behavior: "wait" });
      await removePromise;
      expect(value).toBe(42);
    });
  });

  it("wait should throw like Playwright", async () => {
    await withPage(async (page) => {
      let release!: () => void;
      const unblock = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reachedHandler = false;

      page.on("console", async () => {
        reachedHandler = true;
        await unblock;
        throw new Error("Error in handler");
      });

      await page.evaluate("console.log(1)");
      await expect.poll(() => reachedHandler).toBe(true);
      const removePromise = page.removeAllListeners("console", { behavior: "wait" });
      release();
      await expect(removePromise).rejects.toThrow("Error in handler");
    });
  });
});
