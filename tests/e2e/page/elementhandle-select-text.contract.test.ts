import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("elementHandle selectText contract e2e", () => {
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

  it("should select textarea", async () => {
    await withPage(async (page) => {
      await page.goto(`${fixture.server.PREFIX}/input/textarea.html`);
      const textarea = await page.$("textarea");

      await textarea!.evaluate((node) => {
        (node as HTMLTextAreaElement).value = "some value";
      });
      await textarea!.selectText();

      expect(await page.evaluate(() => window.getSelection().toString())).toBe("some value");
    });
  });

  it("should select input", async () => {
    await withPage(async (page) => {
      await page.goto(`${fixture.server.PREFIX}/input/textarea.html`);
      const input = await page.$("input");

      await input!.evaluate((node) => {
        (node as HTMLInputElement).value = "some value";
      });
      await input!.selectText();

      expect(await page.evaluate(() => window.getSelection().toString())).toBe("some value");
    });
  });

  it("should select plain div", async () => {
    await withPage(async (page) => {
      await page.goto(`${fixture.server.PREFIX}/input/textarea.html`);
      const div = await page.$("div.plain");

      await div!.selectText();

      expect(await page.evaluate(() => window.getSelection().toString())).toBe("Plain div");
    });
  });

  it("should follow label control", async () => {
    await withPage(async (page) => {
      await page.setContent(`<label>Label text <input value="some value"></label>`);
      const labelText = await page.$("label");

      await labelText!.selectText();

      expect(await page.evaluate(() => window.getSelection().toString())).toBe("some value");
    });
  });

  it("should timeout waiting for invisible element", async () => {
    await withPage(async (page) => {
      await page.goto(`${fixture.server.PREFIX}/input/textarea.html`);
      const textarea = await page.$("textarea");
      await textarea!.evaluate((node) => {
        (node as HTMLTextAreaElement).style.display = "none";
      });

      const error = await textarea!.selectText({ timeout: 3000 }).catch((caught: Error) => caught);

      expect(error.message).toContain("element is not visible");
    });
  });

  it("should wait for visible", async () => {
    await withPage(async (page) => {
      await page.goto(`${fixture.server.PREFIX}/input/textarea.html`);
      const textarea = await page.$("textarea");
      await textarea!.evaluate((node) => {
        (node as HTMLTextAreaElement).value = "some value";
        node.style.display = "none";
      });
      let done = false;

      const promise = textarea!.selectText({ timeout: 3000 }).then(() => {
        done = true;
      });
      await page.waitForTimeout(1000);
      expect(done).toBe(false);

      await textarea!.evaluate((node) => {
        node.style.display = "block";
      });
      await promise;
    });
  });
});
