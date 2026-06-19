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

  it("locator getAttribute/inputValue/text convenience methods should work like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(`${fixture.server.PREFIX}/dom.html`);

      const outer = page.locator("#outer");
      expect(await outer.getAttribute("name")).toBe("value");
      expect(await outer.getAttribute("foo")).toBe(null);
      expect(await outer.innerHTML()).toBe('<div id="inner">Text,\nmore text</div>');

      const inner = page.locator("#inner");
      expect(await inner.innerText()).toBe("Text, more text");
      expect(await inner.textContent()).toBe("Text,\nmore text");

      await page.selectOption("#select", "foo");
      expect(await page.locator("#select").inputValue()).toBe("foo");

      await page.fill("#textarea", "text value");
      expect(await page.locator("#textarea").inputValue()).toBe("text value");

      await page.fill("#input", "input value");
      expect(await page.locator("#input").inputValue()).toBe("input value");
      await expect(page.locator("#inner").inputValue()).rejects.toThrow(
        "Node is not an <input>, <textarea> or <select> element"
      );
    });
  });

  it("locator innerText should throw like Playwright for non-HTMLElement nodes", async () => {
    await withPage(async (page) => {
      await page.setContent("<svg>text</svg>");

      await expect(page.locator("svg").innerText()).rejects.toThrow("Node is not an HTMLElement");
    });
  });

  it("locator enabled/disabled/editable/checked state methods should work like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button disabled>button1</button>
        <button>button2</button>
        <div>div</div>
      `);

      const div = page.locator("div");
      expect(await div.isEnabled()).toBe(true);
      expect(await div.isDisabled()).toBe(false);

      const button1 = page.getByText("button1");
      expect(await button1.isEnabled()).toBe(false);
      expect(await button1.isDisabled()).toBe(true);

      const button2 = page.getByText("button2");
      expect(await button2.isEnabled()).toBe(true);
      expect(await button2.isDisabled()).toBe(false);

      await page.setContent(`
        <input id=input1 disabled>
        <textarea></textarea>
        <input id=input2>
        <div contenteditable="true"></div>
        <span id=span1 role=textbox aria-readonly=true></span>
        <span id=span2 role=textbox></span>
        <button>button</button>
      `);
      await page.$eval("textarea", (textarea) => {
        (textarea as HTMLTextAreaElement).readOnly = true;
      });

      expect(await page.locator("#input1").isEditable()).toBe(false);
      expect(await page.locator("#input2").isEditable()).toBe(true);
      expect(await page.locator("textarea").isEditable()).toBe(false);
      expect(await page.locator("div").isEditable()).toBe(true);
      expect(await page.locator("#span1").isEditable()).toBe(false);
      expect(await page.locator("#span2").isEditable()).toBe(true);
      await expect(page.locator("button").isEditable()).rejects.toThrow(
        "Element is not an <input>, <textarea>, <select> or [contenteditable] and does not have a role allowing [aria-readonly]"
      );

      await page.setContent("<input type='checkbox' checked><div>Not a checkbox</div>");
      const checkbox = page.locator("input");
      expect(await checkbox.isChecked()).toBe(true);
      await checkbox.evaluate((input) => {
        (input as HTMLInputElement).checked = false;
      });
      expect(await checkbox.isChecked()).toBe(false);
      await expect(page.locator("div").isChecked()).rejects.toThrow("Not a checkbox or radio button");
    });
  });
});
