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

  it("allTextContents and allInnerTexts should work like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>A</div><div>B</div><div>C</div>");

      expect(await page.locator("div").allTextContents()).toEqual(["A", "B", "C"]);
      expect(await page.locator("div").allInnerTexts()).toEqual(["A", "B", "C"]);
    });
  });

  it("locator.page should return page like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(`${fixture.server.PREFIX}/frames/two-frames.html`);
      const outer = page.locator("#outer");
      expect(outer.page()).toBe(page);

      const inner = outer.locator("#inner");
      expect(inner.page()).toBe(page);

      const inFrame = page.frames()[1]!.locator("div");
      expect(inFrame.page()).toBe(page);
    });
  });

  it("locator description should work like Playwright", async () => {
    await withPage(async (page) => {
      expect(page.locator("button").description()).toBe(null);
      expect(page.locator("button").describe("Submit button").description()).toBe("Submit button");
      expect(page.locator("div").describe(`Button with "quotes" and 'apostrophes'`).description()).toBe(`Button with "quotes" and 'apostrophes'`);
      expect(page.locator("form").locator("input").describe("Form input field").description()).toBe("Form input field");

      const locator1 = page.locator("foo").describe("First description");
      expect(locator1.description()).toBe("First description");
      const locator2 = locator1.locator("button").describe("Second description");
      expect(locator2.description()).toBe("Second description");
      const locator3 = locator2.locator("button");
      expect(locator3.description()).toBe(null);
    });
  });

  it("locator.toString should work like Playwright", async () => {
    await withPage(async (page) => {
      const locator = page.getByRole("button", { name: "Submit" });
      expect(locator.toString()).toBe("getByRole('button', { name: 'Submit' })");
      expect(locator.description()).toBe(null);

      const described = page.getByRole("button", { name: "Submit" }).describe("Submit button");
      expect(described.toString()).toBe("Submit button");
      expect(described.toString()).toBe(described.description());
    });
  });
});
