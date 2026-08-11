import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page click signal contract e2e", () => {
  it("should abort via signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<button style="display:none">click me</button>`);
      const controller = new AbortController();
      const promise = page.locator("button").click({ signal: controller.signal, timeout: 0 }).catch((error) => error);

      await page.waitForTimeout(100);
      const reason = new Error("foo bar");
      controller.abort(reason);

      const error = await promise;
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<button>click me</button>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.locator("button").click({ signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });
});
