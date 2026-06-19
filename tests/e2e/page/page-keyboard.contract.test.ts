import { describe, expect, it } from "vitest";
import { withPage, type SnapshotPage } from "../../helpers/browser.js";

describe("page keyboard contract e2e", () => {
  async function setKeyboardLogger(page: SnapshotPage) {
    await page.setContent(`
      <textarea></textarea>
      <script>
        window.result = "";
        const textarea = document.querySelector("textarea");
        textarea.focus();
        textarea.addEventListener("keydown", event => {
          log("Keydown:", event.key, event.code, getLocation(event), modifiers(event));
        });
        textarea.addEventListener("keypress", event => {
          log("Keypress:", event.key, event.code, getLocation(event), event.charCode, modifiers(event));
        });
        textarea.addEventListener("keyup", event => {
          log("Keyup:", event.key, event.code, getLocation(event), modifiers(event));
        });
        function modifiers(event) {
          const m = [];
          if (event.altKey)
            m.push("Alt");
          if (event.ctrlKey)
            m.push("Control");
          if (event.shiftKey)
            m.push("Shift");
          return "[" + m.join(" ") + "]";
        }
        function getLocation(event) {
          switch (event.location) {
            case KeyboardEvent.DOM_KEY_LOCATION_STANDARD: return "STANDARD";
            case KeyboardEvent.DOM_KEY_LOCATION_LEFT: return "LEFT";
            case KeyboardEvent.DOM_KEY_LOCATION_RIGHT: return "RIGHT";
            case KeyboardEvent.DOM_KEY_LOCATION_NUMPAD: return "NUMPAD";
            default: return "Unknown: " + event.location;
          }
        }
        function log(...args) {
          window.result += args.join(" ") + "\\n";
        }
        window.getResult = () => {
          const temp = window.result.trim();
          window.result = "";
          return temp;
        };
      </script>
    `);
  }

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

  it("specifies repeat property", async () => {
    await withPage(async (page) => {
      await page.setContent("<textarea></textarea>");
      await page.focus("textarea");
      await page.evaluate(() => {
        (window as unknown as { lastEvent: KeyboardEvent | null }).lastEvent = null;
        document.querySelector("textarea")!.addEventListener("keydown", (event) => {
          (window as unknown as { lastEvent: KeyboardEvent }).lastEvent = event;
        });
      });

      await page.keyboard.down("a");
      expect(await page.evaluate(() => (window as unknown as { lastEvent: KeyboardEvent }).lastEvent.repeat)).toBe(false);
      await page.keyboard.press("a");
      expect(await page.evaluate(() => (window as unknown as { lastEvent: KeyboardEvent }).lastEvent.repeat)).toBe(true);

      await page.keyboard.down("b");
      expect(await page.evaluate(() => (window as unknown as { lastEvent: KeyboardEvent }).lastEvent.repeat)).toBe(false);
      await page.keyboard.down("b");
      expect(await page.evaluate(() => (window as unknown as { lastEvent: KeyboardEvent }).lastEvent.repeat)).toBe(true);

      await page.keyboard.up("a");
      await page.keyboard.down("a");
      expect(await page.evaluate(() => (window as unknown as { lastEvent: KeyboardEvent }).lastEvent.repeat)).toBe(false);
    });
  });

  it("throws on unknown keys", async () => {
    await withPage(async (page) => {
      let error = await page.keyboard.press("NotARealKey").catch((caught) => caught);
      expect(error.message).toContain('Unknown key: "NotARealKey"');

      error = await page.keyboard.press("ё").catch((caught) => caught);
      expect(error.message).toContain('Unknown key: "ё"');

      error = await page.keyboard.press("😊").catch((caught) => caught);
      expect(error.message).toContain('Unknown key: "😊"');
    });
  });

  it("reports shiftKey like Playwright", async () => {
    await withPage(async (page) => {
      await setKeyboardLogger(page);
      const keyboard = page.keyboard;

      for (const modifierKey of ["Shift", "Alt", "Control"]) {
        await keyboard.down(modifierKey);
        expect(await page.evaluate("window.getResult()")).toBe(
          `Keydown: ${modifierKey} ${modifierKey}Left LEFT [${modifierKey}]`
        );

        await keyboard.down("!");
        if (modifierKey === "Shift") {
          expect(await page.evaluate("window.getResult()")).toBe(
            [`Keydown: ! Digit1 STANDARD [${modifierKey}]`, `Keypress: ! Digit1 STANDARD 33 [${modifierKey}]`].join("\n")
          );
        } else {
          expect(await page.evaluate("window.getResult()")).toBe(`Keydown: ! Digit1 STANDARD [${modifierKey}]`);
        }

        await keyboard.up("!");
        expect(await page.evaluate("window.getResult()")).toBe(`Keyup: ! Digit1 STANDARD [${modifierKey}]`);
        await keyboard.up(modifierKey);
        expect(await page.evaluate("window.getResult()")).toBe(`Keyup: ${modifierKey} ${modifierKey}Left LEFT []`);
      }
    });
  });

  it("reports multiple modifiers like Playwright", async () => {
    await withPage(async (page) => {
      await setKeyboardLogger(page);
      const keyboard = page.keyboard;

      await keyboard.down("Control");
      expect(await page.evaluate("window.getResult()")).toBe("Keydown: Control ControlLeft LEFT [Control]");
      await keyboard.down("Alt");
      expect(await page.evaluate("window.getResult()")).toBe("Keydown: Alt AltLeft LEFT [Alt Control]");
      await keyboard.down(";");
      expect(await page.evaluate("window.getResult()")).toBe("Keydown: ; Semicolon STANDARD [Alt Control]");
      await keyboard.up(";");
      expect(await page.evaluate("window.getResult()")).toBe("Keyup: ; Semicolon STANDARD [Alt Control]");
      await keyboard.up("Control");
      expect(await page.evaluate("window.getResult()")).toBe("Keyup: Control ControlLeft LEFT [Alt]");
      await keyboard.up("Alt");
      expect(await page.evaluate("window.getResult()")).toBe("Keyup: Alt AltLeft LEFT []");
    });
  });

  it("sends proper codes while typing symbols", async () => {
    await withPage(async (page) => {
      await setKeyboardLogger(page);

      await page.keyboard.type("!");
      expect(await page.evaluate("window.getResult()")).toBe(
        ["Keydown: ! Digit1 STANDARD []", "Keypress: ! Digit1 STANDARD 33 []", "Keyup: ! Digit1 STANDARD []"].join("\n")
      );

      await page.keyboard.type("^");
      expect(await page.evaluate("window.getResult()")).toBe(
        ["Keydown: ^ Digit6 STANDARD []", "Keypress: ^ Digit6 STANDARD 94 []", "Keyup: ^ Digit6 STANDARD []"].join("\n")
      );
    });
  });

  it("supports plus-separated modifiers and shifted raw codes", async () => {
    await withPage(async (page) => {
      await setKeyboardLogger(page);

      await page.keyboard.press("+");
      expect(await page.evaluate("window.getResult()")).toBe(
        ["Keydown: + Equal STANDARD []", "Keypress: + Equal STANDARD 43 []", "Keyup: + Equal STANDARD []"].join("\n")
      );

      await page.keyboard.press("Shift++");
      expect(await page.evaluate("window.getResult()")).toBe(
        [
          "Keydown: Shift ShiftLeft LEFT [Shift]",
          "Keydown: + Equal STANDARD [Shift]",
          "Keypress: + Equal STANDARD 43 [Shift]",
          "Keyup: + Equal STANDARD [Shift]",
          "Keyup: Shift ShiftLeft LEFT []"
        ].join("\n")
      );

      await page.keyboard.press("Control+Shift+~");
      expect(await page.evaluate("window.getResult()")).toBe(
        [
          "Keydown: Control ControlLeft LEFT [Control]",
          "Keydown: Shift ShiftLeft LEFT [Control Shift]",
          "Keydown: ~ Backquote STANDARD [Control Shift]",
          "Keyup: ~ Backquote STANDARD [Control Shift]",
          "Keyup: Shift ShiftLeft LEFT [Control]",
          "Keyup: Control ControlLeft LEFT []"
        ].join("\n")
      );

      await page.keyboard.press("Shift+Digit3");
      expect(await page.evaluate("window.getResult()")).toBe(
        [
          "Keydown: Shift ShiftLeft LEFT [Shift]",
          "Keydown: # Digit3 STANDARD [Shift]",
          "Keypress: # Digit3 STANDARD 35 [Shift]",
          "Keyup: # Digit3 STANDARD [Shift]",
          "Keyup: Shift ShiftLeft LEFT []"
        ].join("\n")
      );
    });
  });
});
