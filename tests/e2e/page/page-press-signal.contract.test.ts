import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page press signal contract e2e", () => {
  it("locator.press should abort via signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input>`);
      await page.locator("input").focus();
      const controller = new AbortController();
      const promise = page.locator("input").press("A", { delay: 1_000, signal: controller.signal }).catch((error) => error);

      await page.waitForTimeout(100);
      const reason = new Error("foo bar");
      controller.abort(reason);

      const error = await promise;
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("page.press should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.press("input", "A", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
      expect(await page.locator("input").inputValue()).toBe("");
    });
  });

  it("frame.press should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.mainFrame().press("input", "A", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
      expect(await page.locator("input").inputValue()).toBe("");
    });
  });

  it("elementHandle.press should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input>`);
      const input = await page.locator("input").elementHandle();
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await input.press("A", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
      expect(await page.locator("input").inputValue()).toBe("");
    });
  });
});
