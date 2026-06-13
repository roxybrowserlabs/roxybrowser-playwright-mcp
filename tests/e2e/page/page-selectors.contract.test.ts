import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page selectors contract e2e", () => {
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
});
