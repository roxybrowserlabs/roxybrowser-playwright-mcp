import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { CURSOR_VISUALIZATION_INSTALL_SOURCE, getBubbleCursorInstallSource } from "../../../src/human/bubbleCursor.js";

describe("cursor visualization install source", () => {
  it("uses the configured body and outline colors", () => {
    expect(getBubbleCursorInstallSource("arrow")).toContain('fill=\\"#EE46BC\\"');
    expect(getBubbleCursorInstallSource("arrow")).toContain('fill=\\"#FFFFFF\\"');
    expect(getBubbleCursorInstallSource("bubble")).toContain("context.fillStyle = '#EE46BC';");
    expect(getBubbleCursorInstallSource("bubble")).toContain("context.strokeStyle = '#FFFFFF';");
  });

  it("waits for DOM readiness when it runs as a document preload script", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      pretendToBeVisual: true,
      runScripts: "outside-only",
      url: "https://example.test/"
    });
    let readyState: DocumentReadyState = "loading";
    Object.defineProperty(dom.window.document, "readyState", {
      configurable: true,
      get: () => readyState
    });
    Object.defineProperty(dom.window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false })
    });

    dom.window.eval(CURSOR_VISUALIZATION_INSTALL_SOURCE);

    expect(dom.window.document.querySelector(".curzr")).toBeNull();
    expect((dom.window as unknown as { __roxyBubbleCursor?: { pending?: boolean } }).__roxyBubbleCursor?.pending)
      .toBe(true);

    readyState = "interactive";
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));

    expect(dom.window.document.querySelectorAll(".curzr")).toHaveLength(1);
    expect((dom.window as unknown as { __roxyBubbleCursor?: { installed?: boolean } }).__roxyBubbleCursor?.installed)
      .toBe(true);

    dom.window.eval(CURSOR_VISUALIZATION_INSTALL_SOURCE);
    expect(dom.window.document.querySelectorAll(".curzr")).toHaveLength(1);
    dom.window.close();
  });
});
