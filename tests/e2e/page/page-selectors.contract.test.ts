import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page selectors contract e2e", () => {
  it("throws for non-string selector like Playwright", async () => {
    await withPage(async (page) => {
      const error = await (page.$ as any)(null).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("selector: expected string, got object");
    });
  });

  it("queries existing elements with css, text, xpath, and inferred selectors", async () => {
    await withPage(async (page) => {
      await page.setContent("<section>test</section>");

      await expect(page.$("css=section")).resolves.toBeTruthy();
      await expect(page.$('text="test"')).resolves.toBeTruthy();
      await expect(page.$("xpath=/html/body/section")).resolves.toBeTruthy();
      await expect(page.$("section")).resolves.toBeTruthy();
      await expect(page.$('"test"')).resolves.toBeTruthy();
      await expect(page.$("//html/body/section")).resolves.toBeTruthy();
      await expect(page.$("(//section)[1]")).resolves.toBeTruthy();
    });
  });

  it("returns null for non-existing element", async () => {
    await withPage(async (page) => {
      expect(await page.$("non-existing-element")).toBe(null);
    });
  });

  it("auto-detects xpath selector starting with parent axis", async () => {
    await withPage(async (page) => {
      await page.setContent("<div><section>test</section><span></span></div>");

      const span = await page.$('"test" >> ../span');
      expect(await span!.evaluate((element) => element.nodeName)).toBe("SPAN");

      const div = await page.$('"test" >> ..');
      expect(await div!.evaluate((element) => element.nodeName)).toBe("DIV");
    });
  });

  it("supports Playwright >> selector syntax", async () => {
    await withPage(async (page) => {
      await page.setContent("<section><div>test</div></section>");

      expect(await page.$("css=section >> css=div")).toBeTruthy();
    });
  });

  it("queries existing elements and preserves order", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>A</div><br/><div>B</div>");

      const elements = await page.$$("div");
      const text = await Promise.all(elements.map((element) => page.evaluate((node) => node.textContent, element)));

      expect(elements).toHaveLength(2);
      expect(text).toEqual(["A", "B"]);
    });
  });

  it("returns empty array if no elements are found", async () => {
    await withPage(async (page) => {
      expect(await page.$$("div")).toEqual([]);
    });
  });

  it("queries multiple elements with xpath selectors", async () => {
    await withPage(async (page) => {
      await page.setContent("<section>test</section>");
      const section = await page.$$("xpath=/html/body/section");
      expect(section).toHaveLength(1);
      expect(section[0]).toBeTruthy();

      expect(await page.$$("xpath=//html/body/non-existing-element")).toEqual([]);

      await page.setContent("<div></div><div></div>");
      expect(await page.$$("xpath=/html/body/div")).toHaveLength(2);
    });
  });

  it("finds content with getByText using string and regex queries", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <main>
          <button>Save draft</button>
          <button>Send message</button>
        </main>
      `);

      expect(await page.getByText("Save draft").isVisible()).toBe(true);
      expect(await page.getByText(/send message/i).isVisible()).toBe(true);
    });
  });

  it("normalizes whitespace and respects exact text matching", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div> ye </div>
        <div>ye</div>
        <div>Hello world</div>
        <div>Hello</div>
      `);

      expect(await page.getByText("ye", { exact: true }).first().textContent()).toBe(" ye ");
      expect(await page.getByText("Hello", { exact: true }).textContent()).toBe("Hello");
      expect(await page.getByText(/hello/i).first().textContent()).toBe("Hello world");
    });
  });

  it("finds buttons with getByRole and accessible names", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button type="button">Submit order</button>
      `);

      expect(await page.getByRole("button", { name: /submit/i }).isVisible()).toBe(true);
    });
  });

  it("matches aria-label names with getByRole and exact name filters", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <input aria-label="Search docs" />
        <button type="button">Save draft</button>
      `);

      expect(await page.getByRole("textbox", { name: "Search docs" }).isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: "Save", exact: true }).isVisible()).toBe(false);
      expect(await page.getByRole("button", { name: "Save draft", exact: true }).isVisible()).toBe(true);
    });
  });

  it("finds label-associated form controls with getByRole", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <label for="name">Name</label>
        <input id="name" />
      `);

      expect(await page.getByRole("textbox", { name: "Name" }).isVisible()).toBe(true);
    });
  });

  it("supports nested locator chaining", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <section class="card">
          <header><h1>Settings</h1></header>
          <div class="content">
            <button type="button">Save</button>
          </div>
        </section>
      `);

      const button = page.locator(".card").locator(".content").getByRole("button", { name: "Save" });
      expect(await button.isVisible()).toBe(true);

      await button.click();
    });
  });

  it("supports locator first(), last(), and nth()", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <section>
          <div><p>First</p></div>
          <div><p>Second</p></div>
          <div><p>Third</p></div>
        </section>
      `);

      const paragraphs = page.locator("div").locator("p");
      expect(await paragraphs.first().textContent()).toBe("First");
      expect(await paragraphs.nth(1).textContent()).toBe("Second");
      expect(await paragraphs.last().textContent()).toBe("Third");
    });
  });

  it("enforces Playwright strictness for ambiguous locators", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div>A</div><div>B</div>`);

      const result = await page.locator("div").isVisible().then(
        () => null,
        (error) => error
      );

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("strict");
    });
  });

  it("enforces Playwright strictness for page selector APIs", async () => {
    await withPage(async (page) => {
      await page.setContent(`<span>span1</span><div><span>target</span></div>`);

      await expect(page.textContent("span")).resolves.toBe("span1");
      await expect(page.textContent("span", { strict: true })).rejects.toThrow(/strict mode violation/);
      await expect(page.getAttribute("span", "id", { strict: true })).rejects.toThrow(/strict mode violation/);
      await expect(page.$("span")).resolves.toBeTruthy();
      await expect(page.$("span", { strict: true })).rejects.toThrow(/strict mode violation/);
      await expect(page.waitForSelector("span", { strict: true, timeout: 500 })).rejects.toThrow(/strict mode violation/);
    });
  });

  it("enforces Playwright strictness for page actions", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input></input><div><input></input></div>`);
      await expect(page.fill("input", "text", { strict: true })).rejects.toThrow(/strict mode violation/);

      await page.setContent(`<span></span><div><span></span></div>`);
      await expect(page.dispatchEvent("span", "click", {}, { strict: true })).rejects.toThrow(/strict mode violation/);
    });
  });

  it("supports xpath selectors through page APIs", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div>
          <span class="target">Hello XPath</span>
        </div>
      `);

      const handle = await page.$("xpath=//span[contains(., 'Hello XPath')]");
      expect(handle).toBeTruthy();
      expect(await handle!.textContent()).toBe("Hello XPath");
    });
  });

  it("supports text selectors through page APIs", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div>yo</div>
        <div>ya</div>
        <div>
          ye
        </div>
      `);

      expect(
        await page.$eval("text=ya", "(element) => element.textContent")
      ).toBe("ya");
      expect(
        await page.$eval("text=/ye/", "(element) => element.textContent")
      ).toContain("ye");
    });
  });

  it("page.$$ works with bogus Array.from like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>hello</div><div></div>");
      const divHandle = await page.evaluateHandle(() => {
        Array.from = () => [];
        return document.querySelector("div");
      });

      const elements = await page.$$("div");

      expect(elements).toHaveLength(2);
      expect(await elements[0]!.evaluate((div, firstDiv) => div === firstDiv, divHandle)).toBe(true);
    });
  });
});
