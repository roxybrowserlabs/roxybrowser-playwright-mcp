import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("page eval on selector all e2e (bidi/firefox)", () => {
  it("should work with css selector", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div>hello</div><div>beautiful</div><div>world!</div>");
      const divsCount = await page.$$eval("css=div", (divs) => divs.length);
      expect(divsCount).toBe(3);
    });
  });

  it("should work with text selector", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div>hello</div><div>beautiful</div><div>beautiful</div><div>world!</div>");
      const divsCount = await page.$$eval('text="beautiful"', (divs) => divs.length);
      expect(divsCount).toBe(2);
    });
  });

  it("should work with xpath selector", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div>hello</div><div>beautiful</div><div>world!</div>");
      const divsCount = await page.$$eval("xpath=/html/body/div", (divs) => divs.length);
      expect(divsCount).toBe(3);
    });
  });

  it("should auto-detect css selector", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div>hello</div><div>beautiful</div><div>world!</div>");
      const divsCount = await page.$$eval("div", (divs) => divs.length);
      expect(divsCount).toBe(3);
    });
  });

  it("should support >> syntax", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div><span>hello</span></div><div>beautiful</div><div><span>wo</span><span>rld!</span></div><span>Not this one</span>");
      const spansCount = await page.$$eval("css=div >> css=span", (spans) => spans.length);
      expect(spansCount).toBe(3);
    });
  });

  it("should return complex values", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div>hello</div><div>beautiful</div><div>world!</div>");
      const texts = await page.$$eval("css=div", (divs) => {
        return divs.map((div) => (div as HTMLElement).textContent);
      });
      expect(texts).toEqual(["hello", "beautiful", "world!"]);
    });
  });

  it("should work with bogus Array.from", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div>hello</div><div>beautiful</div><div>world!</div>");
      await page.evaluate(`() => {
        Array.from = () => [];
      }`);
      const divsCount = await page.$$eval("css=div", (divs) => divs.length);
      expect(divsCount).toBe(3);
    });
  });
});
