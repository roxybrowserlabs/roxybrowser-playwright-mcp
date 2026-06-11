import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("page eval on selector e2e (bidi/firefox)", () => {
  it("should work with css selector", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<section id="testAttribute">43543</section>');
      const idAttribute = await page.$eval("css=section", (e) => (e as HTMLElement).id);
      expect(idAttribute).toBe("testAttribute");
    });
  });

  it("should work with id selector", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<section id="testAttribute">43543</section>');
      const idAttribute = await page.$eval("id=testAttribute", (e) => (e as HTMLElement).id);
      expect(idAttribute).toBe("testAttribute");
    });
  });

  it("should work with data-test selector", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<section data-test=foo id="testAttribute">43543</section>');
      const idAttribute = await page.$eval("data-test=foo", (e) => (e as HTMLElement).id);
      expect(idAttribute).toBe("testAttribute");
    });
  });

  it("should work with data-testid selector", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<section data-testid=foo id="testAttribute">43543</section>');
      const idAttribute = await page.$eval("data-testid=foo", (e) => (e as HTMLElement).id);
      expect(idAttribute).toBe("testAttribute");
    });
  });

  it("should work with data-test-id selector", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<section data-test-id=foo id="testAttribute">43543</section>');
      const idAttribute = await page.$eval("data-test-id=foo", (e) => (e as HTMLElement).id);
      expect(idAttribute).toBe("testAttribute");
    });
  });

  it("should work with text selector in quotes", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<section id="testAttribute">43543</section>');
      const idAttribute = await page.$eval('text="43543"', (e) => (e as HTMLElement).id);
      expect(idAttribute).toBe("testAttribute");
    });
  });

  it("should work with xpath selector", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<section id="testAttribute">43543</section>');
      const idAttribute = await page.$eval("xpath=/html/body/section", (e) => (e as HTMLElement).id);
      expect(idAttribute).toBe("testAttribute");
    });
  });

  it("should work with text selector", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<section id="testAttribute">43543</section>');
      const idAttribute = await page.$eval("text=43543", (e) => (e as HTMLElement).id);
      expect(idAttribute).toBe("testAttribute");
    });
  });

  it("should auto-detect css selector", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<section id="testAttribute">43543</section>');
      const idAttribute = await page.$eval("section", (e) => (e as HTMLElement).id);
      expect(idAttribute).toBe("testAttribute");
    });
  });

  it("should auto-detect css selector with attributes", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<section id="testAttribute">43543</section>');
      const idAttribute = await page.$eval('section[id="testAttribute"]', (e) => (e as HTMLElement).id);
      expect(idAttribute).toBe("testAttribute");
    });
  });

  it("should auto-detect nested selectors", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div foo=bar><section>43543<span>Hello<div id=target></div></span></section></div>");
      const idAttribute = await page.$eval('div[foo=bar] > section >> "Hello" >> div', (e) => {
        return (e as HTMLElement).id;
      });
      expect(idAttribute).toBe("target");
    });
  });

  it("should accept arguments", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<section>hello</section>");
      const text = await page.$eval("section", (e, suffix: string) => {
        return (e as HTMLElement).textContent + suffix;
      }, " world!");
      expect(text).toBe("hello world!");
    });
  });

  it("should accept ElementHandles as arguments", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<section>hello</section><div> world</div>");
      const divHandle = await page.$("div");
      const text = await page.$eval("section", (e, div) => {
        return (e as HTMLElement).textContent + (div as HTMLElement).textContent;
      }, divHandle);
      expect(text).toBe("hello world");
    });
  });

  it("should throw error if no element is found", async () => {
    await withBidiPage(async (page) => {
      let error: Error | null = null;
      await page.$eval("section", (e) => (e as HTMLElement).id).catch((caughtError: Error) => {
        error = caughtError;
        return "";
      });
      expect(error?.message).toContain('Failed to find element matching selector "section"');
    });
  });

  it("should support >> syntax", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<section><div>hello</div></section>");
      const text = await page.$eval("css=section >> css=div", (e, suffix: string) => {
        return (e as HTMLElement).textContent + suffix;
      }, " world!");
      expect(text).toBe("hello world!");
    });
  });

  it("should support >> syntax with different engines", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<section><div><span>hello</span></div></section>");
      const text = await page.$eval('xpath=/html/body/section >> css=div >> text="hello"', (e, suffix: string) => {
        return (e as HTMLElement).textContent + suffix;
      }, " world!");
      expect(text).toBe("hello world!");
    });
  });

  it("should return complex values", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<section id="testAttribute">43543</section>');
      const idAttribute = await page.$eval("css=section", (e) => [{ id: (e as HTMLElement).id }]);
      expect(idAttribute).toEqual([{ id: "testAttribute" }]);
    });
  });
});
