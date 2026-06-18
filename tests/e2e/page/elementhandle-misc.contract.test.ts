import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("elementHandle misc contract e2e", () => {
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

  it("hovers elements", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button id="button-1" style="margin-top: 200px">one</button>
        <button id="button-6" style="margin-top: 200px">six</button>
      `);
      const button = await page.$("#button-6");

      await button!.hover();

      expect(await page.evaluate(() => document.querySelector("button:hover")?.id)).toBe("button-6");
    });
  });

  it("hovers when Node is removed", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button id="button-1" style="margin-top: 200px">one</button>
        <button id="button-6" style="margin-top: 200px">six</button>
      `);
      await page.evaluate(() => {
        delete (window as Window & { Node?: typeof Node }).Node;
      });
      const button = await page.$("#button-6");

      await button!.hover();

      expect(await page.evaluate(() => document.querySelector("button:hover")?.id)).toBe("button-6");
    });
  });

  it("fills input", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <input oninput="window.result = this.value">
      `);
      const handle = await page.$("input");

      await handle!.fill("some value");

      expect(await page.evaluate(() => window.result)).toBe("some value");
    });
  });

  it("fills input when Node is removed", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <input oninput="window.result = this.value">
      `);
      await page.evaluate(() => {
        delete (window as Window & { Node?: typeof Node }).Node;
      });
      const handle = await page.$("input");

      await handle!.fill("some value");

      expect(await page.evaluate(() => window.result)).toBe("some value");
    });
  });

  it("checks and unchecks boxes", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input id="checkbox" type="checkbox">`);
      const input = await page.$("input");

      await input!.check();
      expect(await page.evaluate(() => (document.querySelector("#checkbox") as HTMLInputElement).checked)).toBe(true);

      await input!.uncheck();
      expect(await page.evaluate(() => (document.querySelector("#checkbox") as HTMLInputElement).checked)).toBe(false);
    });
  });

  it("sets checked state", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input id="checkbox" type="checkbox">`);
      const input = await page.$("input");

      await input!.setChecked(true);
      expect(await page.evaluate(() => (document.querySelector("#checkbox") as HTMLInputElement).checked)).toBe(true);

      await input!.setChecked(false);
      expect(await page.evaluate(() => (document.querySelector("#checkbox") as HTMLInputElement).checked)).toBe(false);
    });
  });

  it("checks aria roles by clicking and honors trial", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div role="checkbox" id="checkbox">CHECKBOX</div>
        <script>
          checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'true'));
        </script>
      `);
      const checkbox = await page.$("div");

      await checkbox!.check();
      expect(await page.evaluate(() => checkbox.getAttribute("aria-checked"))).toBe("true");

      await page.setContent(`<input id="input" type="checkbox">`);
      const input = await page.$("input");
      await input!.check({ trial: true });
      expect(await page.evaluate(() => input.checked)).toBe(false);
    });
  });

  it("selects a single option", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <select onchange="window.changed = Array.from(this.selectedOptions).map(option => option.value)"
                oninput="window.input = Array.from(this.selectedOptions).map(option => option.value)">
          <option value="red">Red</option>
          <option value="blue">Blue</option>
        </select>
      `);
      const select = await page.$("select");

      const values = await select!.selectOption("blue");

      expect(values).toEqual(["blue"]);
      expect(await page.evaluate(() => window.input)).toEqual(["blue"]);
      expect(await page.evaluate(() => window.changed)).toEqual(["blue"]);
    });
  });
});
