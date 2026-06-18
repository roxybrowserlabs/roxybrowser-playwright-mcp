import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("elementHandle press contract e2e", () => {
  it("should work", async () => {
    await withPage(async (page) => {
      await page.setContent("<input type='text' />");

      await page.press("input", "h");

      expect(await page.$eval("input", (input) => (input as HTMLInputElement).value)).toBe("h");
    });
  });

  it("should not select existing value", async () => {
    await withPage(async (page) => {
      await page.setContent("<input type='text' value='hello' />");

      await page.press("input", "w");

      expect(await page.$eval("input", (input) => (input as HTMLInputElement).value)).toBe("whello");
    });
  });

  it("should reset selection when not focused", async () => {
    await withPage(async (page) => {
      await page.setContent("<input type='text' value='hello' /><div tabIndex=2>text</div>");
      await page.$eval("input", (input) => {
        input.selectionStart = 2;
        input.selectionEnd = 4;
        document.querySelector("div")!.focus();
      });

      await page.press("input", "w");

      expect(await page.$eval("input", (input) => (input as HTMLInputElement).value)).toBe("whello");
    });
  });

  it("should not modify selection when focused", async () => {
    await withPage(async (page) => {
      await page.setContent("<input type='text' value='hello' />");
      await page.$eval("input", (input) => {
        input.focus();
        input.selectionStart = 2;
        input.selectionEnd = 4;
      });

      await page.press("input", "w");

      expect(await page.$eval("input", (input) => (input as HTMLInputElement).value)).toBe("hewo");
    });
  });

  it("should work with number input", async () => {
    await withPage(async (page) => {
      await page.setContent("<input type='number' value=2 />");

      await page.press("input", "1");

      expect(await page.$eval("input", (input) => (input as HTMLInputElement).value)).toBe("12");
    });
  });
});
