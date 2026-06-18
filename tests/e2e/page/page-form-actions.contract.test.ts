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
    });
  });
});
