import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page and frame click signal contract e2e", () => {
  it("page.click should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<button>click me</button>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.click("button", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("frame.click should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<button>click me</button>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.mainFrame().click("button", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });
});
