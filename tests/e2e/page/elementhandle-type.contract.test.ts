import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("elementHandle type contract e2e", () => {
  it("should work", async () => {
    await withPage(async (page) => {
      await page.setContent("<input type='text' />");

      await page.type("input", "hello");

      expect(await page.$eval("input", (input) => (input as HTMLInputElement).value)).toBe("hello");
    });
  });

  it("should not select existing value", async () => {
    await withPage(async (page) => {
      await page.setContent("<input type='text' value='hello' />");

      await page.type("input", "world");

      expect(await page.$eval("input", (input) => (input as HTMLInputElement).value)).toBe("worldhello");
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

      await page.type("input", "world");

      expect(await page.$eval("input", (input) => (input as HTMLInputElement).value)).toBe("worldhello");
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

      await page.type("input", "world");

      expect(await page.$eval("input", (input) => (input as HTMLInputElement).value)).toBe("heworldo");
    });
  });

  it("should work with number input", async () => {
    await withPage(async (page) => {
      await page.setContent("<input type='number' value=2 />");

      await page.type("input", "13");

      expect(await page.$eval("input", (input) => (input as HTMLInputElement).value)).toBe("132");
    });
  });
});
