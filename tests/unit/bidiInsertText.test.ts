import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import { BIDI_INSERT_TEXT_SOURCE } from "../../src/protocol/bidi/insertText.js";

function installInsertText(window: Window) {
  return window.eval(`(${BIDI_INSERT_TEXT_SOURCE})`) as (payload: { text: string }) => Element | undefined;
}

describe("BIDI_INSERT_TEXT_SOURCE", () => {
  it("inserts text into a textarea selection and emits only input", () => {
    const dom = new JSDOM("<textarea>Hello World!</textarea>", {
      runScripts: "outside-only"
    });
    const insertText = installInsertText(dom.window);
    const textarea = dom.window.document.querySelector("textarea")!;
    const events: string[] = [];

    textarea.addEventListener("keydown", (event) => events.push(event.type));
    textarea.addEventListener("keypress", (event) => events.push(event.type));
    textarea.addEventListener("input", (event) => {
      events.push(`${event.type}:${(event as InputEvent).data}`);
    });
    textarea.focus();
    textarea.setSelectionRange(6, 11);

    insertText({ text: "BiDi" });

    expect(textarea.value).toBe("Hello BiDi!");
    expect(textarea.selectionStart).toBe(10);
    expect(textarea.selectionEnd).toBe(10);
    expect(events).toEqual(["input:BiDi"]);
  });

  it("follows Playwright's active shadow root lookup before inserting text", () => {
    const dom = new JSDOM("<div id=host></div>", {
      runScripts: "outside-only"
    });
    const insertText = installInsertText(dom.window);
    const host = dom.window.document.querySelector("#host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<input value='ab'>";
    const input = shadow.querySelector("input")!;
    input.focus();
    input.setSelectionRange(1, 1);

    insertText({ text: "X" });

    expect(dom.window.document.activeElement).toBe(host);
    expect(shadow.activeElement).toBe(input);
    expect(input.value).toBe("aXb");
  });

  it("inserts contenteditable newlines as text nodes separated by br elements", () => {
    const dom = new JSDOM("<div contenteditable>old</div>", {
      runScripts: "outside-only"
    });
    const insertText = installInsertText(dom.window);
    const editor = dom.window.document.querySelector("div")!;
    const selection = dom.window.getSelection()!;
    const range = dom.window.document.createRange();
    const events: string[] = [];

    Object.defineProperty(editor, "isContentEditable", {
      configurable: true,
      value: true
    });
    editor.addEventListener("input", (event) => {
      events.push(`${event.type}:${(event as InputEvent).data}`);
    });
    editor.focus();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    insertText({ text: "one\ntwo" });

    expect(editor.innerHTML).toBe("one<br>two");
    expect(events).toEqual(["input:one\ntwo"]);
  });

  it("returns the focused frame without reading its cross-origin contentWindow", () => {
    const dom = new JSDOM("<iframe></iframe>", {
      runScripts: "outside-only"
    });
    const insertText = installInsertText(dom.window);
    const frame = dom.window.document.querySelector("iframe")!;

    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      get() {
        throw new dom.window.DOMException("Permission denied", "SecurityError");
      }
    });
    frame.focus();

    expect(insertText({ text: "ignored" })).toBe(frame);
  });
});
