import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page checkbox signal contract e2e", () => {
  it("locator.check should abort via signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input type="checkbox" style="display:none">`);
      const controller = new AbortController();
      const promise = page.locator("input").check({ signal: controller.signal, timeout: 0 }).catch((error) => error);

      await page.waitForTimeout(100);
      const reason = new Error("foo bar");
      controller.abort(reason);

      const error = await promise;
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("page.check should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input type="checkbox">`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.check("input", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("frame.uncheck should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input type="checkbox" checked>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.mainFrame().uncheck("input", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("elementHandle.setChecked should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input type="checkbox">`);
      const input = await page.locator("input").elementHandle();
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await input.setChecked(true, { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });
});
