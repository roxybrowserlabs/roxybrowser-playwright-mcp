import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("elementHandle type e2e (bidi/firefox)", () => {
  it("should reset selection when not focused", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<input type='text' value='hello' /><div tabIndex=2>text</div>");
      await page.$eval("input", (input) => {
        input.selectionStart = 2;
        input.selectionEnd = 4;
        document.querySelector("div")!.focus();
      });

      await page.type("input", "world");

      expect(await page.$eval("input", (input) => (input as HTMLInputElement).value)).toBe("worldhello");
    });
  });
});
