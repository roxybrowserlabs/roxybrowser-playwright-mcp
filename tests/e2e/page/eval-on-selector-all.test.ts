import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page eval on selector all e2e", () => {
  it("should work with css selector", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>hello</div><div>beautiful</div><div>world!</div>");
      const divsCount = await page.$$eval("css=div", (divs) => divs.length);
      expect(divsCount).toBe(3);
    });
  });

  it("should work with text selector", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>hello</div><div>beautiful</div><div>beautiful</div><div>world!</div>");
      const divsCount = await page.$$eval('text="beautiful"', (divs) => divs.length);
      expect(divsCount).toBe(2);
    });
  });

  it("should work with xpath selector", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>hello</div><div>beautiful</div><div>world!</div>");
      const divsCount = await page.$$eval("xpath=/html/body/div", (divs) => divs.length);
      expect(divsCount).toBe(3);
    });
  });

  it("should auto-detect css selector", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>hello</div><div>beautiful</div><div>world!</div>");
      const divsCount = await page.$$eval("div", (divs) => divs.length);
      expect(divsCount).toBe(3);
    });
  });

  it("should support >> syntax", async () => {
    await withPage(async (page) => {
      await page.setContent("<div><span>hello</span></div><div>beautiful</div><div><span>wo</span><span>rld!</span></div><span>Not this one</span>");
      const spansCount = await page.$$eval("css=div >> css=span", (spans) => spans.length);
      expect(spansCount).toBe(3);
    });
  });

  it("should support * capture", async () => {
    await withPage(async (page) => {
      await page.setContent("<section><div><span>a</span></div></section><section><div><span>b</span></div></section>");
      expect(await page.$$eval('*css=div >> "b"', (elements) => elements.length)).toBe(1);
      expect(await page.$$eval('section >> *css=div >> "b"', (elements) => elements.length)).toBe(1);
      expect(await page.$$eval("section >> *", (elements) => elements.length)).toBe(4);

      await page.setContent("<section><div><span>a</span><span>a</span></div></section>");
      expect(await page.$$eval('*css=div >> "a"', (elements) => elements.length)).toBe(1);
      expect(await page.$$eval('section >> *css=div >> "a"', (elements) => elements.length)).toBe(1);

      await page.setContent("<div><span>a</span></div><div><span>a</span></div><section><div><span>a</span></div></section>");
      expect(await page.$$eval('*css=div >> "a"', (elements) => elements.length)).toBe(3);
      expect(await page.$$eval('section >> *css=div >> "a"', (elements) => elements.length)).toBe(1);
    });
  });

  it("should support * capture when multiple paths match", async () => {
    await withPage(async (page) => {
      await page.setContent("<div><div><span></span></div></div><div></div>");
      expect(await page.$$eval("*css=div >> span", (elements) => elements.length)).toBe(2);
      await page.setContent("<div><div><span></span></div><span></span><span></span></div><div></div>");
      expect(await page.$$eval("*css=div >> span", (elements) => elements.length)).toBe(2);
    });
  });

  it("should return complex values", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>hello</div><div>beautiful</div><div>world!</div>");
      const texts = await page.$$eval("css=div", (divs) => {
        return divs.map((div) => (div as HTMLElement).textContent);
      });
      expect(texts).toEqual(["hello", "beautiful", "world!"]);
    });
  });

  it("should work with bogus Array.from", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>hello</div><div>beautiful</div><div>world!</div>");
      await page.evaluate(`() => {
        Array.from = () => [];
      }`);
      const divsCount = await page.$$eval("css=div", (divs) => divs.length);
      expect(divsCount).toBe(3);
    });
  });
});
