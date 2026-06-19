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
});
