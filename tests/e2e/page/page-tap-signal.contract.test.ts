import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page tap signal contract e2e", () => {
  it("locator.tap should abort via signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<button style="display:none">tap</button>`);
      const controller = new AbortController();
      const promise = page.locator("button").tap({ signal: controller.signal, timeout: 0 }).catch((error) => error);

      await page.waitForTimeout(100);
      const reason = new Error("foo bar");
      controller.abort(reason);

      const error = await promise;
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("page.tap should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<button>tap</button>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.tap("button", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("frame.tap should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<button>tap</button>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.mainFrame().tap("button", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("elementHandle.tap should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent(`<button>tap</button>`);
      const button = await page.locator("button").elementHandle();
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await button.tap({ signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });
});
