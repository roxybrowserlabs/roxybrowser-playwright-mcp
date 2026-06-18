import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("elementHandle scrollIntoViewIfNeeded e2e (bidi/firefox)", () => {
  it("should wait for display:none to become visible", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<div style="display:none">Hello</div>');
      const div = await page.$("div");
      let done = false;

      const promise = div!.scrollIntoViewIfNeeded().then(() => {
        done = true;
      });
      await page.waitForTimeout(1000);
      expect(done).toBe(false);

      await div!.evaluate((node) => {
        node.style.display = "block";
      });
      await promise;
      expect(done).toBe(true);
    });
  });

  it("should throw for detached element", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div>Hello</div>");
      const div = await page.$("div");
      await div!.evaluate((node) => node.remove());

      const error = await div!.scrollIntoViewIfNeeded().catch((caught: Error) => caught);

      expect(error.message).toContain("Element is not attached to the DOM");
    });
  });
});
