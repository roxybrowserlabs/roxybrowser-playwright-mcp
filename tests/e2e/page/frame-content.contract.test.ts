import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("frame content contract e2e", () => {
  it("reads and sets content through the main frame", async () => {
    await withPage(async (page) => {
      const frame = page.mainFrame();

      await frame.setContent("<div>hello</div>");

      expect(await frame.content()).toBe("<html><head></head><body><div>hello</div></body></html>");
      expect(await page.content()).toBe("<html><head></head><body><div>hello</div></body></html>");
    });
  });

  it("reads and sets content through a child frame", async () => {
    await withPage(async (page) => {
      const attached = page.waitForEvent("frameattached");
      await page.setContent("<iframe name=child></iframe>");
      await attached;

      const frame = page.frame("child");
      expect(frame).toBeTruthy();

      await frame!.setContent("<section>child</section>");

      expect(await frame!.content()).toBe("<html><head></head><body><section>child</section></body></html>");
      expect(await frame!.textContent("section")).toBe("child");
    });
  });
});
