import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page fill signal contract e2e", () => {
  it("locator.fill should abort via signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input style="display:none">`);
      const controller = new AbortController();
      const promise = page.locator("input").fill("value", { signal: controller.signal, timeout: 0 }).catch((error) => error);

      await page.waitForTimeout(100);
      const reason = new Error("foo bar");
      controller.abort(reason);

      const error = await promise;
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("page.fill should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.fill("input", "value", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
      expect(await page.locator("input").inputValue()).toBe("");
    });
  });

  it("frame.fill should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.mainFrame().fill("input", "value", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
      expect(await page.locator("input").inputValue()).toBe("");
    });
  });

  it("elementHandle.fill should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input>`);
      const input = await page.locator("input").elementHandle();
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await input.fill("value", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
      expect(await page.locator("input").inputValue()).toBe("");
    });
  });
});
