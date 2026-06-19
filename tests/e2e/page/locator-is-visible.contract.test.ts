import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("locator isVisible/isHidden contract e2e", () => {
  it("isVisible and isHidden should work like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>Hi</div><span></span>");

      const div = page.locator("div");
      expect(await div.isVisible()).toBe(true);
      expect(await div.isHidden()).toBe(false);
      expect(await page.isVisible("div")).toBe(true);
      expect(await page.isHidden("div")).toBe(false);

      const span = page.locator("span");
      expect(await span.isVisible()).toBe(false);
      expect(await span.isHidden()).toBe(true);
      expect(await page.isVisible("span")).toBe(false);
      expect(await page.isHidden("span")).toBe(true);

      expect(await page.isVisible("no-such-element")).toBe(false);
      expect(await page.isHidden("no-such-element")).toBe(true);
    });
  });

  it("isVisible should be true for opacity:0 like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent('<div style="opacity:0">Hi</div>');

      expect(await page.locator("div").isVisible()).toBe(true);
    });
  });

  it("isVisible should be true for element outside viewport like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent('<div style="position: absolute; left: -1000px">Hi</div>');

      expect(await page.locator("div").isVisible()).toBe(true);
    });
  });

  it("isVisible and isHidden should work with details like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <details>
          <summary>click to open</summary>
          <ul>
            <li>hidden item 1</li>
            <li>hidden item 2</li>
            <li>hidden item 3</li>
          </ul>
        </details>
      `);

      expect(await page.locator("ul").isHidden()).toBe(true);
    });
  });

  it("isVisible inside a button should work like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<button><span></span>a button</button>");
      const span = page.locator("span");

      expect(await span.isVisible()).toBe(false);
      expect(await span.isHidden()).toBe(true);
      expect(await page.isVisible("span")).toBe(false);
      expect(await page.isHidden("span")).toBe(true);
      await span.waitFor({ state: "hidden" });
      await page.locator("button").waitFor({ state: "visible" });
    });
  });

  it("isVisible inside a role=button should work like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<div role=button><span></span>a button</div>");
      const span = page.locator("span");

      expect(await span.isVisible()).toBe(false);
      expect(await span.isHidden()).toBe(true);
      expect(await page.isVisible("span")).toBe(false);
      expect(await page.isHidden("span")).toBe(true);
      await span.waitFor({ state: "hidden" });
      await page.locator("[role=button]").waitFor({ state: "visible" });
    });
  });

  it("isVisible with invalid selector should throw like Playwright", async () => {
    await withPage(async (page) => {
      const error = await Promise.resolve()
        .then(() => page.locator("hey=what").isVisible())
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Unknown engine "hey" while parsing selector hey=what');
    });
  });
});
