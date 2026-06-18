import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

const SELECT_HTML = `
  <select>
    <option value="">Choose one</option>
    <option value="blue">Blue</option>
    <option value="brown">Brown</option>
    <option value="green">Green</option>
    <option value="gray">Gray</option>
    <option value="black">Black</option>
    <option value="magenta">Magenta</option>
    <option value="indigo">Indigo</option>
    <option value="html">  H T M L  </option>
    <option id="whiteOption" value="white">White</option>
  </select>
  <script>
    window.result = {
      onInput: [],
      onChange: [],
      onBubblingInput: [],
      onBubblingChange: []
    };
    const select = document.querySelector('select');
    window.makeMultiple = () => select.multiple = true;
    select.addEventListener('input', () => window.result.onInput = Array.from(select.selectedOptions).map(option => option.value));
    select.addEventListener('change', () => window.result.onChange = Array.from(select.selectedOptions).map(option => option.value));
    document.body.addEventListener('input', () => window.result.onBubblingInput = Array.from(select.selectedOptions).map(option => option.value));
    document.body.addEventListener('change', () => window.result.onBubblingChange = Array.from(select.selectedOptions).map(option => option.value));
  </script>
`;

describe("page selectOption contract e2e", () => {
  it("selects by value, label fallback, explicit label, index and handle", async () => {
    await withPage(async (page) => {
      await page.setContent(SELECT_HTML);

      await page.selectOption("select", "blue");
      expect(await page.evaluate(() => (window as any).result.onInput)).toEqual(["blue"]);
      expect(await page.evaluate(() => (window as any).result.onChange)).toEqual(["blue"]);

      await page.selectOption("select", "Blue");
      expect(await page.evaluate(() => (window as any).result.onInput)).toEqual(["blue"]);

      await page.selectOption("select", { label: "Indigo" });
      expect(await page.evaluate(() => (window as any).result.onInput)).toEqual(["indigo"]);

      await page.selectOption("select", { index: 2 });
      expect(await page.evaluate(() => (window as any).result.onInput)).toEqual(["brown"]);

      const white = await page.$("#whiteOption");
      await page.selectOption("select", white!);
      expect(await page.evaluate(() => (window as any).result.onInput)).toEqual(["white"]);
    });
  });

  it("selects multiple options and returns matched values", async () => {
    await withPage(async (page) => {
      await page.setContent(SELECT_HTML);
      await page.evaluate(() => (window as any).makeMultiple());

      const values = await page.selectOption("select", ["blue", { label: "Green" }, { index: 4 }]);

      expect(values).toEqual(["blue", "green", "gray"]);
      expect(await page.evaluate(() => (window as any).result.onInput)).toEqual(["blue", "green", "gray"]);
      expect(await page.evaluate(() => (window as any).result.onChange)).toEqual(["blue", "green", "gray"]);
      expect(await page.evaluate(() => (window as any).result.onBubblingInput)).toEqual(["blue", "green", "gray"]);
      expect(await page.evaluate(() => (window as any).result.onBubblingChange)).toEqual(["blue", "green", "gray"]);
    });
  });

  it("deselects all options with null or empty values", async () => {
    await withPage(async (page) => {
      await page.setContent(SELECT_HTML);
      await page.evaluate(() => (window as any).makeMultiple());

      expect(await page.selectOption("select", ["blue", "black", "magenta"])).toEqual(["blue", "black", "magenta"]);
      expect(await page.selectOption("select", null)).toEqual([]);
      expect(await page.$eval("select", (select) =>
        Array.from((select as HTMLSelectElement).options).every((option) => !option.selected)
      )).toBe(true);

      await page.selectOption("select", ["blue", "black"]);
      expect(await page.selectOption("select", [])).toEqual([]);
      expect(await page.$eval("select", (select) =>
        Array.from((select as HTMLSelectElement).options).every((option) => !option.selected)
      )).toBe(true);
    });
  });

  it("validates option value types like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<select><option value=\"12\"></option></select>");

      await expect(page.selectOption("select", 12 as never)).rejects.toThrow("options[0]: expected object, got number");
      await expect(page.selectOption("select", { value: 12 } as never)).rejects.toThrow("options[0].value: expected string, got number");
      await expect(page.selectOption("select", { label: 12 } as never)).rejects.toThrow("options[0].label: expected string, got number");
      await expect(page.selectOption("select", { index: "12" } as never)).rejects.toThrow("options[0].index: expected integer, got string");
      await expect(page.selectOption("select", ["blue", null] as never)).rejects.toThrow("options[1]: expected object, got null");
    });
  });

  it("waits for option value, index and multiple values to become present", async () => {
    await withPage(async (page) => {
      await page.setContent(SELECT_HTML);
      const pendingValue = page.selectOption("select", "scarlet", { timeout: 2_000 });
      await page.waitForTimeout(100);
      await page.$eval("select", (select) => {
        const option = document.createElement("option");
        option.value = "scarlet";
        option.textContent = "Scarlet";
        select.appendChild(option);
      });
      expect(await pendingValue).toEqual(["scarlet"]);

      const length = await page.$eval("select", (select) => select.options.length);
      const pendingIndex = page.selectOption("select", { index: length }, { timeout: 2_000 });
      await page.waitForTimeout(100);
      await page.$eval("select", (select) => {
        const option = document.createElement("option");
        option.value = "violet";
        option.textContent = "Violet";
        select.appendChild(option);
      });
      expect(await pendingIndex).toEqual(["violet"]);

      await page.evaluate(() => (window as any).makeMultiple());
      const pendingMultiple = page.selectOption("select", ["green", "crimson"], { timeout: 2_000 });
      await page.waitForTimeout(100);
      await page.$eval("select", (select) => {
        const option = document.createElement("option");
        option.value = "crimson";
        option.textContent = "Crimson";
        select.appendChild(option);
      });
      expect(await pendingMultiple).toEqual(["green", "crimson"]);
    });
  });

  it("throws for non-select and disabled options like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<body><select><option>one</option><option disabled>two</option><optgroup disabled><option>three</option></optgroup></select></body>");

      await expect(page.selectOption("body", "")).rejects.toThrow("Element is not a <select> element");
      await expect(page.selectOption("select", "two", { timeout: 100 })).rejects.toThrow("option being selected is not enabled");
      await expect(page.selectOption("select", "three", { timeout: 100 })).rejects.toThrow("option being selected is not enabled");
    });
  });

  it("input event.composed crosses shadow dom boundary like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <body>
          <script>
            const div = document.createElement('div');
            const shadowRoot = div.attachShadow({ mode: 'open' });
            shadowRoot.innerHTML = '<select><option value="black">Black</option><option value="blue">Blue</option></select>';
            document.body.appendChild(div);
          </script>
        </body>
      `);
      await page.locator("body").evaluate((body) => {
        (window as any).firedBodyEvents = [];
        for (const event of ["input", "change"]) {
          body.addEventListener(event, (e) => (window as any).firedBodyEvents.push(e.type + ":" + e.composed));
        }
      });
      await page.locator("select").evaluate((select) => {
        (window as any).firedEvents = [];
        for (const event of ["input", "change"]) {
          select.addEventListener(event, (e) => (window as any).firedEvents.push(e.type + ":" + e.composed));
        }
      });

      await page.selectOption("select", "blue");

      expect(await page.evaluate(() => (window as any).firedEvents)).toEqual(["input:true", "change:false"]);
      expect(await page.evaluate(() => (window as any).firedBodyEvents)).toEqual(["input:true"]);
    });
  });
});
