import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("elementHandle selectText e2e (bidi/firefox)", () => {
  it("should select input text", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<input value="some value">');
      const input = await page.$("input");

      await input!.selectText();

      expect(await page.evaluate(() => window.getSelection().toString())).toBe("some value");
    });
  });

  it("should follow label control", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<label>Label text <input value="some value"></label>`);
      const label = await page.$("label");

      await label!.selectText();

      expect(await page.evaluate(() => window.getSelection().toString())).toBe("some value");
    });
  });
});
