import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("locator list and misc contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  beforeEach(() => {
    fixture.server.reset();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("locator.all should work", async () => {
    await withPage(async (page) => {
      await page.setContent("<div><p>A</p><p>B</p><p>C</p></div>");
      const texts = [];

      for (const p of await page.locator("div >> p").all()) {
        texts.push(await p.textContent());
      }

      expect(texts).toEqual(["A", "B", "C"]);
    });
  });

  it("locator.count should work when Map is deleted", async () => {
    await withPage(async (page) => {
      await page.evaluate("Map = 1");

      const count = await page.locator("#searchResultTableDiv .x-grid3-row").count();

      expect(count).toBe(0);
    });
  });

  it("waitFor should wait for visible element", async () => {
    await withPage(async (page) => {
      await page.setContent("<div></div>");
      const locator = page.locator("span");
      const promise = locator.waitFor();

      await page.$eval("div", (div) => {
        div.innerHTML = "<span>target</span>";
      });

      await promise;
      expect(await locator.textContent()).toBe("target");
    });
  });

  it("waitFor should wait for hidden element", async () => {
    await withPage(async (page) => {
      await page.setContent("<div><span>target</span></div>");
      const locator = page.locator("span");
      const promise = locator.waitFor({ state: "hidden" });

      await page.$eval("div", (div) => {
        div.innerHTML = "";
      });

      await promise;
    });
  });

  it("scrollIntoViewIfNeeded should scroll element into view", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div style="height: 2000px"></div>
        <button id="target">target</button>
      `);

      await page.locator("#target").scrollIntoViewIfNeeded();

      const bottom = await page.locator("#target").evaluate((button) => button.getBoundingClientRect().bottom);
      expect(bottom <= 720).toBe(true);
    });
  });

  it("selectText should select textarea contents", async () => {
    await withPage(async (page) => {
      await page.setContent('<textarea>some value</textarea>');
      const textarea = page.locator("textarea");

      await textarea.selectText();

      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("some value");
    });
  });
});
