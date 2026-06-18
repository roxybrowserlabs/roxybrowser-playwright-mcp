import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page dialog contract e2e", () => {
  it("should fire", async () => {
    await withPage(async (page) => {
      page.on("dialog", (dialog) => {
        expect(dialog.type()).toBe("alert");
        expect(dialog.defaultValue()).toBe("");
        expect(dialog.message()).toBe("yo");
        void dialog.accept();
      });
      await page.evaluate(() => alert("yo"));
    });
  });

  it("should allow accepting prompts", async () => {
    await withPage(async (page) => {
      page.on("dialog", (dialog) => {
        expect(dialog.type()).toBe("prompt");
        expect(dialog.defaultValue()).toBe("yes.");
        expect(dialog.message()).toBe("question?");
        void dialog.accept("answer!");
      });
      const result = await page.evaluate(() => prompt("question?", "yes."));
      expect(result).toBe("answer!");
    });
  });

  it("should dismiss prompts", async () => {
    await withPage(async (page) => {
      page.on("dialog", (dialog) => void dialog.dismiss());
      const result = await page.evaluate(() => prompt("question?"));
      expect(result).toBe(null);
    });
  });

  it("should accept confirms", async () => {
    await withPage(async (page) => {
      page.on("dialog", (dialog) => void dialog.accept());
      const result = await page.evaluate(() => confirm("boolean?"));
      expect(result).toBe(true);
    });
  });

  it("should dismiss confirms", async () => {
    await withPage(async (page) => {
      page.on("dialog", (dialog) => void dialog.dismiss());
      const result = await page.evaluate(() => confirm("boolean?"));
      expect(result).toBe(false);
    });
  });

  it("should auto-dismiss alerts without listeners", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div onclick="window.alert(123); window._clicked=true">Click me</div>`);
      await page.click("div");
      expect(await page.evaluate("window._clicked")).toBe(true);
    });
  });
});
