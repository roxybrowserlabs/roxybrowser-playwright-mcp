import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("locator elementHandle contract e2e", () => {
  it("should query existing element like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent('<html><body><div class="second"><div class="inner">A</div></div></body></html>');
      const html = page.locator("html");
      const second = html.locator(".second");
      const inner = second.locator(".inner");

      const content = await page.evaluate((element) => element.textContent, await inner.elementHandle());

      expect(content).toBe("A");
    });
  });

  it("should query existing elements like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<html><body><div>A</div><br/><div>B</div></body></html>");
      const html = page.locator("html");
      const elements = await html.locator("div").elementHandles();
      const texts = await Promise.all(
        elements.map((element) => page.evaluate((node) => node.textContent, element))
      );

      expect(elements.length).toBe(2);
      expect(texts).toEqual(["A", "B"]);
    });
  });

  it("should return empty array for non-existing elements like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<html><body><span>A</span><br/><span>B</span></body></html>");
      const html = page.locator("html");

      expect(await html.locator("div").elementHandles()).toEqual([]);
    });
  });

  it("xpath should query existing element like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent('<html><body><div class="second"><div class="inner">A</div></div></body></html>');
      const html = page.locator("html");
      const second = html.locator("xpath=./body/div[contains(@class, 'second')]");
      const inner = second.locator("xpath=./div[contains(@class, 'inner')]");

      const content = await page.evaluate((element) => element.textContent, await inner.elementHandle());

      expect(content).toBe("A");
    });
  });

  it("xpath should return empty array for non-existing elements like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent('<html><body><div class="second"><div class="inner">B</div></div></body></html>');
      const html = page.locator("html");

      expect(await html.locator("xpath=/div[contains(@class, 'third')]").elementHandles()).toEqual([]);
    });
  });
});
