import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page close contract e2e", () => {
  it("passes self to the close event like Playwright", async () => {
    await withPage(async (page) => {
      const [closedPage] = await Promise.all([
        page.waitForEvent("close"),
        page.close()
      ]);

      expect(closedPage).toBe(page);
    });
  });

  it("is callable multiple times like Playwright", async () => {
    await withPage(async (page) => {
      await Promise.all([
        page.close(),
        page.close()
      ]);

      await expect(page.close()).resolves.toBeUndefined();
    });
  });

  it("returns null from popup.opener() after parent page closes", async () => {
    await withPage(async (page) => {
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate(() => {
          window.open("about:blank");
        })
      ]);

      expect(await popup.opener()).toBe(page);

      await page.close();

      expect(await popup.opener()).toBeNull();
    });
  });
});
