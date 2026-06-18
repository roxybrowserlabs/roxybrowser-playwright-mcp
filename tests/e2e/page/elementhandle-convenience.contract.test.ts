import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("elementHandle convenience contract e2e", () => {
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

  it("getAttribute works like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(`${fixture.server.PREFIX}/dom.html`);
      const handle = await page.$("#outer");

      expect(await handle!.getAttribute("name")).toBe("value");
      expect(await handle!.getAttribute("foo")).toBe(null);
      expect(await page.getAttribute("#outer", "name")).toBe("value");
      expect(await page.getAttribute("#outer", "foo")).toBe(null);
    });
  });

  it("inputValue works and throws for non-input nodes", async () => {
    await withPage(async (page) => {
      await page.goto(`${fixture.server.PREFIX}/dom.html`);

      await page.selectOption("#select", "foo");
      expect(await page.inputValue("#select")).toBe("foo");

      await page.fill("#textarea", "text value");
      expect(await page.inputValue("#textarea")).toBe("text value");

      await page.fill("#input", "input value");
      expect(await page.inputValue("#input")).toBe("input value");
      const handle = await page.$("#input");
      expect(await handle!.inputValue()).toBe("input value");

      await expect(page.inputValue("#inner")).rejects.toThrow("Node is not an <input>, <textarea> or <select> element");
      const inner = await page.$("#inner");
      await expect(inner!.inputValue()).rejects.toThrow("Node is not an <input>, <textarea> or <select> element");
    });
  });

  it("innerHTML, innerText, and textContent work like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(`${fixture.server.PREFIX}/dom.html`);

      const outer = await page.$("#outer");
      expect(await outer!.innerHTML()).toBe('<div id="inner">Text,\nmore text</div>');
      expect(await page.innerHTML("#outer")).toBe('<div id="inner">Text,\nmore text</div>');

      const inner = await page.$("#inner");
      expect(await inner!.innerText()).toBe("Text, more text");
      expect(await page.innerText("#inner")).toBe("Text, more text");
      expect(await inner!.textContent()).toBe("Text,\nmore text");
      expect(await page.textContent("#inner")).toBe("Text,\nmore text");
    });
  });

  it("innerText throws on non-HTMLElement nodes", async () => {
    await withPage(async (page) => {
      await page.setContent("<svg>text</svg>");

      await expect(page.innerText("svg")).rejects.toThrow("Node is not an HTMLElement");
      const handle = await page.$("svg");
      await expect(handle!.innerText()).rejects.toThrow("Node is not an HTMLElement");
    });
  });

  it("textContent works on ShadowRoot and does not match ShadowRoot as scope", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div></div>
        <script>
          document.querySelector('div').attachShadow({ mode: 'open' }).innerHTML = '<div>hello</div>';
        </script>
      `);

      const div = await page.$("div");
      const root = await div!.evaluateHandle((element) => element.shadowRoot);

      expect(await root.asElement()!.textContent()).toBe("hello");
      expect(await root.asElement()!.$$("css=:scope div")).toEqual([]);
    });
  });

  it("isVisible and isHidden work like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>Hi</div><span></span>");

      const div = await page.$("div");
      expect(await div!.isVisible()).toBe(true);
      expect(await div!.isHidden()).toBe(false);
      expect(await page.isVisible("div")).toBe(true);
      expect(await page.isHidden("div")).toBe(false);

      const span = await page.$("span");
      expect(await span!.isVisible()).toBe(false);
      expect(await span!.isHidden()).toBe(true);
      expect(await page.isVisible("span")).toBe(false);
      expect(await page.isHidden("span")).toBe(true);

      expect(await page.isVisible("no-such-element")).toBe(false);
      expect(await page.isHidden("no-such-element")).toBe(true);
    });
  });

  it("isEnabled and isDisabled work with option and optgroup inheritance", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <select name="select">
          <option id="enabled1" value="1">Enabled</option>
          <option id="disabled1" value="2" disabled>Disabled</option>
          <optgroup label="Foo1">
            <option id="enabled2" value="mercedes">Mercedes</option>
          </optgroup>
          <optgroup label="Foo2" disabled>
            <option id="disabled2" value="mercedes">Mercedes</option>
          </optgroup>
        </select>
      `);

      expect(await (await page.$("#enabled1"))!.isEnabled()).toBe(true);
      expect(await (await page.$("#enabled1"))!.isDisabled()).toBe(false);
      expect(await (await page.$("#disabled1"))!.isEnabled()).toBe(false);
      expect(await (await page.$("#disabled1"))!.isDisabled()).toBe(true);
      expect(await (await page.$("#enabled2"))!.isEnabled()).toBe(true);
      expect(await (await page.$("#enabled2"))!.isDisabled()).toBe(false);
      expect(await (await page.$("#disabled2"))!.isEnabled()).toBe(false);
      expect(await (await page.$("#disabled2"))!.isDisabled()).toBe(true);
    });
  });

  it("isEditable and isChecked work like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<input id=input1 disabled><textarea></textarea><input id=input2>");
      await page.$eval("textarea", (textarea) => {
        (textarea as HTMLTextAreaElement).readOnly = true;
      });

      const input1 = await page.$("#input1");
      expect(await input1!.isEditable()).toBe(false);
      expect(await page.isEditable("#input1")).toBe(false);

      const input2 = await page.$("#input2");
      expect(await input2!.isEditable()).toBe(true);
      expect(await page.isEditable("#input2")).toBe(true);

      const textarea = await page.$("textarea");
      expect(await textarea!.isEditable()).toBe(false);
      expect(await page.isEditable("textarea")).toBe(false);

      await page.setContent("<input type='checkbox' checked><div>Not a checkbox</div>");
      const checkbox = await page.$("input");
      expect(await checkbox!.isChecked()).toBe(true);
      expect(await page.isChecked("input")).toBe(true);
      await checkbox!.evaluate((input) => {
        (input as HTMLInputElement).checked = false;
      });
      expect(await checkbox!.isChecked()).toBe(false);
      expect(await page.isChecked("input")).toBe(false);
      await expect(page.isChecked("div")).rejects.toThrow("Not a checkbox or radio button");
    });
  });
});
