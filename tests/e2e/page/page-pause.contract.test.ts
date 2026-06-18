import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page pause contract e2e", () => {
  it("resumes from window.playwright.resume()", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>pause</div>");

      const pausePromise = (page as typeof page & {
        pause(options?: { __testHookKeepTestTimeout?: boolean }): Promise<void>;
      }).pause({ __testHookKeepTestTimeout: true });

      await page.waitForFunction(`() => {
        return Boolean(window.playwright && window.playwright.resume && window.playwright.resume() !== false);
      }`);

      await pausePromise;

      expect(
        await page.evaluate(`() => {
          return Boolean(window.playwright && typeof window.playwright.resume === "function");
        }`)
      ).toBe(false);
    });
  });
});
