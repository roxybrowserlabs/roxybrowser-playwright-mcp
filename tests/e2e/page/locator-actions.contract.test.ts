import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("locator action contract e2e", () => {
  it("locator.clear should work like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent('<input oninput="window.result = this.value">');
      const input = page.locator("input");

      await input.fill("some value");
      expect(await page.evaluate(() => window.result)).toBe("some value");

      await input.clear();
      expect(await page.evaluate(() => window.result)).toBe("");
    });
  });

  it("locator check, uncheck and setChecked should work like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent('<input id="checkbox" type="checkbox">');
      const input = page.locator("input");

      await input.check();
      expect(await page.evaluate(() => checkbox.checked)).toBe(true);

      await input.setChecked(false);
      expect(await page.evaluate(() => checkbox.checked)).toBe(false);

      await input.setChecked(true);
      expect(await page.evaluate(() => checkbox.checked)).toBe(true);

      await input.uncheck();
      expect(await page.evaluate(() => checkbox.checked)).toBe(false);
    });
  });

  it("locator.selectOption should dispatch input and change like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <select oninput="window.input = Array.from(this.selectedOptions).map(option => option.value)"
                onchange="window.changed = Array.from(this.selectedOptions).map(option => option.value)">
          <option value="red">Red</option>
          <option value="blue">Blue</option>
          <option value="green">Green</option>
        </select>
      `);
      const select = page.locator("select");

      expect(await select.selectOption("blue")).toEqual(["blue"]);
      expect(await page.evaluate(() => window.input)).toEqual(["blue"]);
      expect(await page.evaluate(() => window.changed)).toEqual(["blue"]);

      expect(await select.selectOption({ label: "Green" })).toEqual(["green"]);
      expect(await select.selectOption({ index: 0 })).toEqual(["red"]);
    });
  });

  it("locator.focus and locator.blur should emit events like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button>button</button>
        <script>
          window.focused = false;
          window.blurred = false;
          const button = document.querySelector("button");
          button.addEventListener("focus", () => window.focused = true);
          button.addEventListener("blur", () => window.blurred = true);
        </script>
      `);
      const button = page.locator("button");

      expect(await button.evaluate((element) => document.activeElement === element)).toBe(false);

      await button.focus();
      expect(await page.evaluate(() => window.focused)).toBe(true);
      expect(await page.evaluate(() => window.blurred)).toBe(false);
      expect(await button.evaluate((element) => document.activeElement === element)).toBe(true);

      await button.blur();
      expect(await page.evaluate(() => window.focused)).toBe(true);
      expect(await page.evaluate(() => window.blurred)).toBe(true);
      expect(await button.evaluate((element) => document.activeElement === element)).toBe(false);
    });
  });

  it("locator.focus should respect strictness like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>A</div><div>B</div>");

      await expect(page.locator("div").focus()).rejects.toThrow(/strict mode violation/);
    });
  });

  it("locator.dispatchEvent should work like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button>Click target</button>
        <script>
          window.result = "idle";
          document.querySelector("button").addEventListener("click", () => window.result = "Clicked");
        </script>
      `);

      await page.locator("button").dispatchEvent("click");

      expect(await page.evaluate(() => window.result)).toBe("Clicked");
    });
  });

  it("locator press, type and pressSequentially should work like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<input type='text'>");

      await page.locator("input").press("h");
      expect(await page.$eval("input", (input) => input.value)).toBe("h");

      await page.locator("input").type("ello");
      expect(await page.$eval("input", (input) => input.value)).toBe("hello");

      await page.locator("input").fill("");
      await page.locator("input").pressSequentially("hello");
      expect(await page.$eval("input", (input) => input.value)).toBe("hello");
    });
  });

  it("locator.press should throw on unknown keys like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<input type='text' value='hello'>");
      const locator = page.getByRole("textbox");

      await expect(locator.press("NotARealKey")).rejects.toThrow('Unknown key: "NotARealKey"');
      await expect(locator.press("ё")).rejects.toThrow('Unknown key: "ё"');
      await expect(locator.press("😊")).rejects.toThrow('Unknown key: "😊"');
    });
  });

  it("locator.boundingBox should work like Playwright", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 500, height: 500 });
      await page.setContent(`
        <style>
          body { margin: 0; }
          .box {
            position: absolute;
            left: 100px;
            top: 50px;
            width: 50px;
            height: 50px;
          }
        </style>
        <div class="box"></div>
      `);

      expect(await page.locator(".box").boundingBox()).toEqual({
        x: 100,
        y: 50,
        width: 50,
        height: 50
      });
    });
  });

  it("locator visible selectors and filter({ visible }) should work like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div>
          <div class="item" style="display: none">Hidden data0</div>
          <div class="item">visible data1</div>
          <div class="item" style="display: none">Hidden data1</div>
          <div class="item">visible data2</div>
          <div class="item" style="display: none">Hidden data2</div>
          <div class="item">visible data3</div>
        </div>
      `);

      expect(await page.locator(".item >> visible=true").nth(1).textContent()).toBe("visible data2");
      expect(await page.locator(".item >> visible=true >> text=data3").textContent()).toBe("visible data3");
      expect(await page.locator(".item").filter({ visible: true }).nth(1).textContent()).toBe("visible data2");
      expect(await page.locator(".item").filter({ visible: true }).getByText("data3").textContent()).toBe("visible data3");
      expect(await page.locator(".item").filter({ visible: false }).getByText("data1").textContent()).toBe("Hidden data1");
    });
  });

  it("Locator.locator() and FrameLocator.locator() should accept locator like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div><input value=outer></div>
        <iframe srcdoc="<div><input value=inner></div>"></iframe>
      `);

      const inputLocator = page.locator("input");
      expect(await inputLocator.inputValue()).toBe("outer");
      expect(await page.locator("div").locator(inputLocator).inputValue()).toBe("outer");
      expect(await page.frameLocator("iframe").locator(inputLocator).inputValue()).toBe("inner");
      expect(await page.frameLocator("iframe").locator("div").locator(inputLocator).inputValue()).toBe("inner");

      const divLocator = page.locator("div");
      expect(await divLocator.locator("input").inputValue()).toBe("outer");
      expect(await page.frameLocator("iframe").locator(divLocator).locator("input").inputValue()).toBe("inner");
    });
  });
});
