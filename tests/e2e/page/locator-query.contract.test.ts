import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("locator query contract e2e", () => {
  it("should respect first() and last() like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <section>
          <div><p>A</p></div>
          <div><p>A</p><p>A</p></div>
          <div><p>A</p><p>A</p><p>A</p></div>
        </section>
      `);

      expect(await page.locator("div >> p").count()).toBe(6);
      expect(await page.locator("div").locator("p").count()).toBe(6);
      expect(await page.locator("div").first().locator("p").count()).toBe(1);
      expect(await page.locator("div").last().locator("p").count()).toBe(3);
    });
  });

  it("should respect nth() like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <section>
          <div><p>A</p></div>
          <div><p>A</p><p>A</p></div>
          <div><p>A</p><p>A</p><p>A</p></div>
        </section>
      `);

      expect(await page.locator("div >> p").nth(0).count()).toBe(1);
      expect(await page.locator("div").nth(1).locator("p").count()).toBe(2);
      expect(await page.locator("div").nth(2).locator("p").count()).toBe(3);
    });
  });

  it("should throw on capture with nth() like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<section><div><p>A</p></div></section>");

      expect(() => page.locator("*css=div >> p").nth(1).click()).toThrow("Can't query n-th element");
    });
  });

  it("should throw due to strictness like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>A</div><div>B</div>");

      await expect(page.locator("div").isVisible()).rejects.toThrow(/strict mode violation/);
    });
  });

  it("should throw due to strictness for evaluate like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<select><option>One</option><option>Two</option></select>");

      await expect(page.locator("option").evaluate(() => undefined)).rejects.toThrow(/strict mode violation/);
    });
  });
});
