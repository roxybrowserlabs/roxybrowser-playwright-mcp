import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page keyboard contract e2e", () => {
  it("types into a textarea", async () => {
    await withPage(async (page) => {
      await page.setContent("<textarea></textarea>");
      await page.focus("textarea");

      const text = "Hello world. I am the text that was typed!";
      await page.keyboard.type(text);

      expect(await page.evaluate(() => document.querySelector("textarea")!.value)).toBe(text);
    });
  });

  it("moves with arrow keys and deletes the selected text", async () => {
    await withPage(async (page) => {
      await page.setContent("<textarea></textarea>");
      await page.type("textarea", "Hello World!");

      for (let index = 0; index < "World!".length; index += 1) {
        await page.keyboard.press("ArrowLeft");
      }
      await page.keyboard.type("inserted ");
      expect(await page.evaluate(() => document.querySelector("textarea")!.value)).toBe("Hello inserted World!");

      await page.keyboard.down("Shift");
      for (let index = 0; index < "inserted ".length; index += 1) {
        await page.keyboard.press("ArrowLeft");
      }
      await page.keyboard.up("Shift");
      await page.keyboard.press("Backspace");

      expect(await page.evaluate(() => document.querySelector("textarea")!.value)).toBe("Hello World!");
    });
  });

  it("sends text with insertText even when keydown is canceled", async () => {
    await withPage(async (page) => {
      await page.setContent("<textarea></textarea>");
      await page.focus("textarea");

      await page.keyboard.insertText("嗨");
      expect(await page.evaluate(() => document.querySelector("textarea")!.value)).toBe("嗨");

      await page.evaluate(() => {
        window.addEventListener("keydown", (event) => event.preventDefault(), true);
      });
      await page.keyboard.insertText("a");

      expect(await page.evaluate(() => document.querySelector("textarea")!.value)).toBe("嗨a");
    });
  });

  it("insertText only emits input events", async () => {
    await withPage(async (page) => {
      await page.setContent("<textarea></textarea>");
      await page.focus("textarea");
      await page.evaluate(() => {
        (window as unknown as { events: string[] }).events = [];
        for (const type of ["keydown", "keyup", "keypress", "input"]) {
          document.addEventListener(type, (event) => {
            (window as unknown as { events: string[] }).events.push(event.type);
          });
        }
      });

      await page.keyboard.insertText("hello world");

      expect(await page.evaluate(() => (window as unknown as { events: string[] }).events)).toEqual(["input"]);
    });
  });

  it("emits keydown, keypress, textInput, input and keyup for a character", async () => {
    await withPage(async (page) => {
      await page.setContent("<input>");
      await page.evaluate(() => {
        (window as unknown as { events: string[] }).events = [];
        const input = document.querySelector("input")!;
        for (const type of ["keydown", "keypress", "textInput", "input", "keyup"]) {
          input.addEventListener(type, (event) => {
            (window as unknown as { events: string[] }).events.push(event.type);
          });
        }
      });
      await page.focus("input");

      await page.keyboard.press("f");

      expect(await page.evaluate(() => (window as unknown as { events: string[] }).events)).toEqual([
        "keydown",
        "keypress",
        "textInput",
        "input",
        "keyup"
      ]);
    });
  });
});
