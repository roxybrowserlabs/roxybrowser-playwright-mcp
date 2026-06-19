import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page form action contract e2e", () => {
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

  it("fills textarea and input", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <textarea oninput="window.textareaResult = this.value"></textarea>
        <input oninput="window.inputResult = this.value">
      `);

      await page.fill("textarea", "some value");
      await page.fill("input", "input value");

      expect(await page.evaluate(() => window.textareaResult)).toBe("some value");
      expect(await page.evaluate(() => window.inputResult)).toBe("input value");
    });
  });

  it("fills supported input types", async () => {
    await withPage(async (page) => {
      await page.setContent('<input oninput="window.result = this.value">');

      for (const type of ["password", "search", "tel", "text", "url", "invalid-type"]) {
        await page.$eval("input", (input, nextType) => input.setAttribute("type", nextType), type);
        await page.fill("input", `text ${type}`);
        expect(await page.evaluate(() => window.result)).toBe(`text ${type}`);
      }
    });
  });

  it("throws on unsupported input types", async () => {
    await withPage(async (page) => {
      await page.setContent("<input>");

      for (const type of ["button", "checkbox", "file", "image", "radio", "reset", "submit"]) {
        await page.$eval("input", (input, nextType) => input.setAttribute("type", nextType), type);
        const error = await page.fill("input", "").catch((e) => e);
        expect(error.message).toContain(`Input of type "${type}" cannot be filled`);
      }
    });
  });

  it("fills date, time, month, week, range and color inputs", async () => {
    await withPage(async (page) => {
      for (const [type, value, expected] of [
        ["color", "#aaaaaa", "#aaaaaa"],
        ["date", "2020-03-02", "2020-03-02"],
        ["time", "13:15", "13:15"],
        ["datetime-local", "2020-03-02T13:15", "2020-03-02T13:15"],
        ["month", "2020-07", "2020-07"],
        ["range", "42", "42"],
        ["week", "2020-W50", "2020-W50"]
      ] as const) {
        await page.setContent(`<input type="${type}" min="0" max="100" value="">`);
        await page.fill("input", value);
        expect(await page.$eval("input", (input) => input.value)).toBe(expected);
      }
    });
  });

  it("throws Playwright-like errors for malformed special input values", async () => {
    await withPage(async (page) => {
      await page.setContent('<input type="range" min="0" max="100" value="50">');
      await expect(page.fill("input", "foo")).rejects.toThrow("Malformed value");
      await expect(page.fill("input", "200")).rejects.toThrow("Malformed value");
      await expect(page.fill("input", "15.43")).rejects.toThrow("Malformed value");

      for (const [type, value] of [
        ["color", "badvalue"],
        ["date", "2020-13-05"],
        ["time", "25:05"],
        ["datetime-local", "abc"],
        ["month", "2020-13"],
        ["week", "2020-123"]
      ] as const) {
        await page.setContent(`<input type="${type}">`);
        await expect(page.fill("input", value)).rejects.toThrow("Malformed value");
      }
    });
  });

  it("matches Playwright input[type=number] fill semantics", async () => {
    await withPage(async (page) => {
      await page.setContent('<input id="input" type="number">');

      await page.fill("input", "42");
      expect(await page.$eval("input", (input) => input.value)).toBe("42");

      await page.fill("input", "-10e5");
      expect(await page.$eval("input", (input) => input.value)).toBe("-10e5");

      await page.fill("input", "");
      expect(await page.$eval("input", (input) => input.value)).toBe("");

      await expect(page.fill("input", "abc")).rejects.toThrow("Cannot type text into input[type=number]");
    });
  });

  it("throws Playwright-like errors for non-fillable elements and non-string values", async () => {
    await withPage(async (page) => {
      await page.setContent("<select><option>value1</option></select><div>plain</div><textarea></textarea>");

      await expect(page.fill("select", "")).rejects.toThrow(
        "Element is not an <input>, <textarea> or [contenteditable] element"
      );
      await expect(page.locator("div").fill("text", { timeout: 50 })).rejects.toThrow(
        "Element is not an <input>, <textarea>, <select> or [contenteditable] and does not have a role allowing [aria-readonly]"
      );

      await expect(page.fill("textarea", 123 as unknown as string)).rejects.toThrow(
        "value: expected string, got number"
      );
      await expect(page.locator("textarea").fill(123 as unknown as string)).rejects.toThrow(
        "value: expected string, got number"
      );
    });
  });

  it("waits for fill actionability and honors force like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent('<input id="disabled" disabled oninput="window.disabledResult = this.value">');
      await expect(page.fill("#disabled", "blocked", { timeout: 50 })).rejects.toThrow("Element is not enabled.");
      expect(await page.evaluate(() => window.disabledResult)).toBeUndefined();

      const disabledFill = page.fill("#disabled", "ready", { timeout: 1_000 });
      await page.$eval("#disabled", (input) => setTimeout(() => ((input as HTMLInputElement).disabled = false), 100));
      await disabledFill;
      expect(await page.evaluate(() => window.disabledResult)).toBe("ready");

      await page.setContent('<textarea id="readonly" readonly oninput="window.readonlyResult = this.value"></textarea>');
      await expect(page.fill("#readonly", "blocked", { timeout: 50 })).rejects.toThrow("Element is not editable.");
      expect(await page.evaluate(() => window.readonlyResult)).toBeUndefined();

      await page.fill("#readonly", "forced", { force: true });
      expect(await page.evaluate(() => window.readonlyResult)).toBe("forced");

      await page.setContent('<input id="hidden" style="display:none" oninput="window.hiddenResult = this.value">');
      await expect(page.fill("#hidden", "blocked", { timeout: 50 })).rejects.toThrow("Element is not visible.");
      await page.fill("#hidden", "forced", { force: true });
      expect(await page.evaluate(() => window.hiddenResult)).toBe("forced");
    });
  });

  it("fill input event.composed crosses shadow dom boundary like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <body>
          <script>
            const div = document.createElement('div');
            const shadowRoot = div.attachShadow({ mode: 'open' });
            shadowRoot.innerHTML = '<input type=text></input>';
            document.body.appendChild(div);
          </script>
        </body>
      `);
      await page.locator("body").evaluate((body) => {
        (window as any).firedBodyEvents = [];
        for (const event of ["input", "change"]) {
          body.addEventListener(event, (e) => {
            (window as any).firedBodyEvents.push(e.type + ":" + e.composed);
          });
        }
      });
      await page.locator("input").evaluate((input) => {
        (window as any).firedEvents = [];
        for (const event of ["input", "change"]) {
          input.addEventListener(event, (e) => {
            (window as any).firedEvents.push(e.type + ":" + e.composed);
          });
        }
      });

      await page.locator("input").fill("hello");

      expect(await page.evaluate(() => (window as any).firedEvents)).toEqual(["input:true", "change:false"]);
      expect(await page.evaluate(() => (window as any).firedBodyEvents)).toEqual(["input:true"]);
    });
  });

  it("fills contenteditable with new lines", async () => {
    await withPage(async (page) => {
      await page.setContent('<div contenteditable="true"></div>');

      await page.locator('div[contenteditable]').fill("John\nDoe");

      expect(await page.locator('div[contenteditable]').innerText()).toBe("John\nDoe");
    });
  });

  it("does not double-fill contenteditable with beforeinput handler", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div id="editor" contenteditable="true"></div>
        <script>
          const editor = document.getElementById("editor");
          editor.addEventListener("beforeinput", event => {
            event.preventDefault();
            editor.textContent = event.data;
          });
        </script>
      `);

      await page.locator("#editor").fill("Playwright");

      expect(await page.locator("#editor").textContent()).toBe("Playwright");
    });
  });

  it("fills elements with existing value and selection", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <input oninput="window.result = this.value">
        <div contenteditable>initial</div>
      `);

      await page.$eval("input", (input) => {
        input.value = "value one";
      });
      await page.fill("input", "another value");
      expect(await page.evaluate(() => window.result)).toBe("another value");

      await page.$eval("input", (input) => {
        input.selectionStart = 1;
        input.selectionEnd = 2;
      });
      await page.fill("input", "maybe this one");
      expect(await page.evaluate(() => window.result)).toBe("maybe this one");

      await page.$eval("div[contenteditable]", (div) => {
        div.innerHTML = "some text <span>some more text<span> and even more text";
        const range = document.createRange();
        range.selectNodeContents(div.querySelector("span")!);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await page.fill("div[contenteditable]", "replace with this");
      expect(await page.$eval("div[contenteditable]", (div) => div.textContent)).toBe("replace with this");
    });
  });

  it("fills body, fixed position input, and clears using fill", async () => {
    await withPage(async (page) => {
      await page.setContent('<body contenteditable="true"></body>');
      await page.fill("body", "some value");
      expect(await page.evaluate(() => document.body.textContent)).toBe("some value");

      await page.setContent("<input style='position: fixed;'>");
      await page.fill("input", "some value");
      expect(await page.evaluate(() => document.querySelector("input")!.value)).toBe("some value");

      await page.fill("input", "");
      expect(await page.evaluate(() => document.querySelector("input")!.value)).toBe("");
    });
  });

  it("focuses element and emits blur/focus events", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div id="d1" tabIndex="0">DIV1</div>
        <div id="d2" tabIndex="0">DIV2</div>
        <script>
          window.events = [];
          d1.addEventListener('blur', () => window.events.push('blur'));
          d2.addEventListener('focus', () => window.events.push('focus'));
        </script>
      `);

      expect(await page.evaluate(() => document.activeElement?.nodeName)).toBe("BODY");
      await page.focus("#d1");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("d1");
      await page.focus("#d2");

      expect(await page.evaluate(() => window.events)).toEqual(["blur", "focus"]);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("d2");
    });
  });

  it("checks, unchecks and setChecked checkboxes", async () => {
    await withPage(async (page) => {
      await page.setContent('<input id="checkbox" type="checkbox">');

      await page.check("input");
      expect(await page.evaluate(() => checkbox.checked)).toBe(true);

      await page.uncheck("input");
      expect(await page.evaluate(() => checkbox.checked)).toBe(false);

      await page.setChecked("input", true);
      expect(await page.evaluate(() => checkbox.checked)).toBe(true);

      await page.setChecked("input", false);
      expect(await page.evaluate(() => checkbox.checked)).toBe(false);
    });
  });

  it("checks radio input", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <input type="radio">one
        <input id="two" type="radio">two
        <input type="radio">three
      `);

      await page.check("#two");

      expect(await page.evaluate(() => two.checked)).toBe(true);
    });
  });

  it("checks and unchecks aria checkbox-like roles by clicking", async () => {
    await withPage(async (page) => {
      for (const role of ["checkbox", "menuitemcheckbox", "option", "radio", "switch", "menuitemradio", "treeitem"]) {
        await page.setContent(`
          <div role="${role}" id="checkbox">CHECKBOX</div>
          <script>
            checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'true'));
          </script>
        `);
        await page.check("div");
        expect(await page.evaluate(() => checkbox.getAttribute("aria-checked"))).toBe("true");

        await page.setContent(`
          <div role="${role}" id="checkbox" aria-checked="true">CHECKBOX</div>
          <script>
            checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'false'));
          </script>
        `);
        await page.uncheck("div");
        expect(await page.evaluate(() => checkbox.getAttribute("aria-checked"))).toBe("false");
      }
    });
  });

  it("matches Playwright check error and trial semantics", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>Check me</div>");
      await expect(page.check("div")).rejects.toThrow("Not a checkbox or radio button");

      await page.setContent("<div role=button>Check me</div>");
      await expect(page.check("div")).rejects.toThrow("Not a checkbox or radio button");

      await page.setContent(`<input id="checkbox" type="checkbox">`);
      await page.check("input", { trial: true });
      expect(await page.evaluate(() => checkbox.checked)).toBe(false);

      await page.setContent(`<input id="checkbox" type="checkbox" checked>`);
      await page.uncheck("input", { trial: true });
      expect(await page.evaluate(() => checkbox.checked)).toBe(true);

      await page.setContent(`<input type="radio" name="test" checked id="radio">`);
      await expect(page.uncheck("#radio")).rejects.toThrow("Cannot uncheck radio button");
    });
  });

  it("taps an element through the page shortcut", async () => {
    await withPage(async (page) => {
      await page.setContent('<button ontouchstart="window.touched = true" onclick="window.clicked = true">Tap me</button>');

      await page.tap("button");

      expect(await page.evaluate(() => (window as any).clicked)).toBe(true);
    });
  });

  it("selects options by value, label and index", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <select oninput="window.input = Array.from(this.selectedOptions).map(option => option.value)"
                onchange="window.changed = Array.from(this.selectedOptions).map(option => option.value)">
          <option value="red">Red</option>
          <option value="blue">Blue</option>
          <option value="green">Green</option>
        </select>
      `);

      expect(await page.selectOption("select", "blue")).toEqual(["blue"]);
      expect(await page.evaluate(() => window.input)).toEqual(["blue"]);
      expect(await page.evaluate(() => window.changed)).toEqual(["blue"]);

      expect(await page.selectOption("select", { label: "Green" })).toEqual(["green"]);
      expect(await page.selectOption("select", { index: 0 })).toEqual(["red"]);

      const blueOption = await page.$("option[value=blue]");
      expect(await page.selectOption("select", blueOption!)).toEqual(["blue"]);
    });
  });

  it("selects multiple options", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <select multiple oninput="window.input = Array.from(this.selectedOptions).map(option => option.value)"
                         onchange="window.changed = Array.from(this.selectedOptions).map(option => option.value)">
          <option value="red">Red</option>
          <option value="blue">Blue</option>
          <option value="green">Green</option>
        </select>
      `);

      const values = await page.selectOption("select", ["blue", "green"]);

      expect(values).toEqual(["blue", "green"]);
      expect(await page.evaluate(() => window.input)).toEqual(["blue", "green"]);
      expect(await page.evaluate(() => window.changed)).toEqual(["blue", "green"]);

      expect(await page.selectOption("select", null)).toEqual([]);
      expect(await page.$eval("select", (select) =>
        Array.from((select as HTMLSelectElement).options).every((option) => !option.selected)
      )).toBe(true);
    });
  });
});
