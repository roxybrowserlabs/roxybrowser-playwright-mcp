import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("locator clear signal contract e2e (bidi/firefox)", () => {
  it("should abort via signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<input value="value" style="display:none">`);
      const controller = new AbortController();
      const promise = page.locator("input").clear({ signal: controller.signal, timeout: 0 }).catch((error) => error);

      await page.waitForTimeout(100);
      const reason = new Error("foo bar");
      controller.abort(reason);

      const error = await promise;
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<input value="value">`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.locator("input").clear({ signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
      expect(await page.locator("input").inputValue()).toBe("value");
    });
  });
});
