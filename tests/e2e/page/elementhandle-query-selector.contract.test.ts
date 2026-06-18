import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("elementHandle query selector contract e2e", () => {
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

  it("queries existing element within the element subtree", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/playground.html");
      await page.setContent('<html><body><div class="second"><div class="inner">A</div></div></body></html>');

      const html = await page.$("html");
      const second = await html!.$(".second");
      const inner = await second!.$(".inner");
      const content = await page.evaluate((element) => element!.textContent, inner);

      expect(content).toBe("A");
    });
  });

  it("returns null for non-existing element", async () => {
    await withPage(async (page) => {
      await page.setContent('<html><body><div class="second"><div class="inner">B</div></div></body></html>');

      const html = await page.$("html");
      const second = await html!.$(".third");

      expect(second).toBe(null);
    });
  });

  it("works for adopted elements", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const popupPromise = page.waitForEvent("popup");
      await page.evaluate((url) => {
        window.__popup = window.open(url);
      }, fixture.server.EMPTY_PAGE);
      const popup = await popupPromise;

      const divHandle = await page.evaluateHandle(() => {
        const div = document.createElement("div");
        document.body.appendChild(div);
        const span = document.createElement("span");
        span.textContent = "hello";
        div.appendChild(span);
        return div;
      });

      expect(await divHandle.asElement()!.$("span")).toBeTruthy();
      expect(await divHandle.asElement()!.$eval("span", (element) => element.textContent)).toBe("hello");

      await popup.waitForLoadState("domcontentloaded");
      await page.evaluate(() => {
        const div = document.querySelector("div");
        window.__popup!.document.body.appendChild(div!);
      });

      expect(await divHandle.asElement()!.$("span")).toBeTruthy();
      expect(await divHandle.asElement()!.$eval("span", (element) => element.textContent)).toBe("hello");
    });
  });

  it("queries existing elements within the element subtree", async () => {
    await withPage(async (page) => {
      await page.setContent("<html><body><div>A</div><br/><div>B</div></body></html>");

      const html = await page.$("html");
      const elements = await html!.$$("div");
      const content = await Promise.all(elements.map((element) => page.evaluate((node) => node.textContent, element)));

      expect(elements).toHaveLength(2);
      expect(content).toEqual(["A", "B"]);
    });
  });

  it("returns empty array for non-existing elements", async () => {
    await withPage(async (page) => {
      await page.setContent("<html><body><span>A</span><br/><span>B</span></body></html>");

      const html = await page.$("html");
      const elements = await html!.$$("div");

      expect(elements).toHaveLength(0);
    });
  });

  it("xpath queries existing element within the element subtree", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/playground.html");
      await page.setContent('<html><body><div class="second"><div class="inner">A</div></div></body></html>');

      const html = await page.$("html");
      const second = await html!.$$("xpath=./body/div[contains(@class, 'second')]");
      const inner = await second[0]!.$$("xpath=./div[contains(@class, 'inner')]");
      const content = await page.evaluate((element) => element.textContent, inner[0]);

      expect(content).toBe("A");
    });
  });

  it("xpath returns empty array for non-existing element", async () => {
    await withPage(async (page) => {
      await page.setContent('<html><body><div class="second"><div class="inner">B</div></div></body></html>');

      const html = await page.$("html");
      const second = await html!.$$("xpath=/div[contains(@class, 'third')]");

      expect(second).toEqual([]);
    });
  });
});
