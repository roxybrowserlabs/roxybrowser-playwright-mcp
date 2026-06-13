import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { ARIA_REF_SELECTOR_EVALUATE_SOURCE, type ResolvedAriaRefResult } from "../../../../src/ariaSnapshot.js";
import { PLAYWRIGHT_ARIA_SNAPSHOT_EVALUATE_SOURCE } from "../../../../src/vendor/playwright/ariaSnapshotEvaluate.js";

interface PlaywrightAriaSnapshotResult {
  refs: Record<string, string>;
  text: string;
  title: string;
  url: string;
  notReady?: boolean;
}

function createWindow(html: string) {
  const window = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://example.com/"
  }).window;
  Object.defineProperty(window.document, "readyState", {
    configurable: true,
    get: () => "complete"
  });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      width: 120,
      height: 32,
      top: 0,
      right: 120,
      bottom: 32,
      left: 0,
      toJSON() {
        return this;
      }
    };
  };
  return window;
}

function attachIframeWindow(iframe: HTMLIFrameElement, frameHtml: string) {
  const frameWindow = createWindow(frameHtml);
  Object.defineProperty(iframe, "contentDocument", {
    configurable: true,
    value: frameWindow.document
  });
  Object.defineProperty(frameWindow, "frameElement", {
    configurable: true,
    value: iframe
  });
  return frameWindow;
}

function createHelpers(window: Window) {
  return {
    snapshot: window.eval(`(${PLAYWRIGHT_ARIA_SNAPSHOT_EVALUATE_SOURCE})`) as (payload: {
      options: { mode: "ai" | "default"; depth?: number; boxes?: boolean; timeout?: number };
      target?: { nodeToken?: string; selector?: string; raw?: string };
    }) => PlaywrightAriaSnapshotResult,
    resolveRef: window.eval(`(${ARIA_REF_SELECTOR_EVALUATE_SOURCE})`) as (payload: {
      ref: string;
    }) => ResolvedAriaRefResult
  };
}

function refForLine(snapshot: PlaywrightAriaSnapshotResult, lineFragment: string): string {
  const line = snapshot.text
    .split("\n")
    .find((candidate) => candidate.includes(lineFragment) && candidate.includes("[ref="));
  if (!line) {
    throw new Error(`Unable to find snapshot line containing "${lineFragment}".\n${snapshot.text}`);
  }

  const match = line.match(/\[ref=((?:f\d+)?e\d+)\]/);
  if (!match) {
    throw new Error(`Unable to extract ref from line: ${line}`);
  }
  return match[1];
}

describe("Playwright aria snapshot evaluate wrapper", () => {
  it("evaluates as valid JavaScript", () => {
    expect(() => new Function(`return (${PLAYWRIGHT_ARIA_SNAPSHOT_EVALUATE_SOURCE});`)).not.toThrow();
  });

  it("assigns frame-prefixed refs to iframe descendants", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <button id="top">Top button</button>
          <iframe id="frame-a"></iframe>
        </body>
      </html>
    `);
    const frame = window.document.getElementById("frame-a") as HTMLIFrameElement;
    attachIframeWindow(
      frame,
      `<!doctype html><html><body><button id="inside-a">Inside frame</button></body></html>`
    );
    const { snapshot } = createHelpers(window);

    const result = snapshot({
      options: {
        mode: "ai"
      }
    });

    expect(refForLine(result, 'button "Top button"')).toMatch(/^e\d+$/);
    expect(refForLine(result, 'button "Inside frame"')).toMatch(/^f1e\d+$/);
  });

  it("keeps iframe refs resolvable through resolveAriaRef", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <iframe id="frame-a"></iframe>
        </body>
      </html>
    `);
    const frame = window.document.getElementById("frame-a") as HTMLIFrameElement;
    attachIframeWindow(
      frame,
      `<!doctype html><html><body><button id="inside-a">Confirm</button></body></html>`
    );
    const { snapshot, resolveRef } = createHelpers(window);

    const result = snapshot({
      options: {
        mode: "ai"
      }
    });
    const ref = refForLine(result, 'button "Confirm"');
    const resolved = resolveRef({ ref });

    expect(ref).toMatch(/^f1e\d+$/);
    expect(resolved.ok).toBe(true);
    expect(resolved.ref).toBe(ref);
    expect(resolved.framePath).toEqual([
      {
        selector: "#frame-a",
        xpath: '//*[@id="frame-a"]'
      }
    ]);
  });
});
