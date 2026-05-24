import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  ARIA_REF_SELECTOR_EVALUATE_SOURCE,
  ARIA_SNAPSHOT_EVALUATE_SOURCE,
  type AriaSnapshotResult,
  type ResolvedAriaRefResult
} from "../../src/ariaSnapshot.js";

function createWindow(html: string) {
  const window = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://example.com/"
  }).window;
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

function createSnapshotHelpers(window: Window) {
  return {
    snapshot: window.eval(`(${ARIA_SNAPSHOT_EVALUATE_SOURCE})`) as (payload: {
      options: { mode: "ai" };
    }) => AriaSnapshotResult,
    resolveRef: window.eval(`(${ARIA_REF_SELECTOR_EVALUATE_SOURCE})`) as (payload: {
      ref: string;
    }) => ResolvedAriaRefResult
  };
}

function firstRef(snapshot: AriaSnapshotResult): string {
  const ref = Object.keys(snapshot.refs)[0];
  if (!ref) {
    throw new Error(`Expected snapshot to include at least one ref.\n${snapshot.text}`);
  }
  return ref;
}

function refForLine(snapshot: AriaSnapshotResult, lineFragment: string): string {
  const line = snapshot.text
    .split("\n")
    .find((candidate) => candidate.includes(lineFragment) && candidate.includes("[ref="));
  if (!line) {
    throw new Error(`Unable to find snapshot line containing "${lineFragment}".\n${snapshot.text}`);
  }

  const match = line.match(/\[ref=(r\d+)\]/);
  if (!match) {
    throw new Error(`Unable to extract ref from line: ${line}`);
  }
  return match[1];
}

function resolveTopLevelQuerySelector(window: Window, expression: string | null) {
  if (!expression) {
    return null;
  }
  return window.eval(expression) as Element | null;
}

function resolveXpath(document: Document, xpath: string | null) {
  if (!xpath) {
    return null;
  }
  return document.evaluate(
    xpath,
    document,
    null,
    document.defaultView!.XPathResult.FIRST_ORDERED_NODE_TYPE,
    null
  ).singleNodeValue as Element | null;
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

describe("aria snapshot helpers", () => {
  it("resolves ai snapshot refs into selector and xpath metadata", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <main>
            <button id="buy-now">Buy now</button>
          </main>
        </body>
      </html>
    `);

    const { snapshot, resolveRef } = createSnapshotHelpers(window);

    const result = snapshot({
      options: {
        mode: "ai"
      }
    });
    const ref = firstRef(result);
    const resolved = resolveRef({ ref });
    const target = window.document.getElementById("buy-now");

    expect(result.text).toContain('[ref=');
    expect(resolveTopLevelQuerySelector(window, resolved.querySelector ?? null)).toBe(target);
    expect(resolveTopLevelQuerySelector(window, resolved.querySelectorChain ?? null)).toBe(target);
    expect(resolveXpath(window.document, resolved.xpath ?? null)).toBe(target);
    expect(resolved).toEqual({
      ok: true,
      ref,
      selector: "#buy-now",
      xpath: '//*[@id="buy-now"]',
      querySelector: 'document.querySelector("#buy-now")',
      querySelectorChain: 'document.querySelector("#buy-now")',
      framePath: [],
      inShadowTree: false
    });
  });

  it("returns a stale result when the ref was never snapshotted", () => {
    const window = createWindow("<!doctype html><html><body><button>Click</button></body></html>");
    const { resolveRef } = createSnapshotHelpers(window);

    expect(resolveRef({ ref: "r99" })).toEqual({
      ok: false,
      reason: "stale"
    });
  });

  it("builds stable nth-of-type selector and xpath when the target has no id", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <section id="checkout">
            <button>Cancel</button>
            <button>Pay now</button>
            <a href="/help">Help</a>
          </section>
        </body>
      </html>
    `);
    const { snapshot, resolveRef } = createSnapshotHelpers(window);

    const result = snapshot({
      options: {
        mode: "ai"
      }
    });
    const ref = refForLine(result, 'button "Pay now"');
    const resolved = resolveRef({ ref });
    const target = window.document.querySelector("#checkout > button:nth-of-type(2)");

    expect(resolved.selector).toBe("#checkout > button:nth-of-type(2)");
    expect(resolved.querySelector).toBe(
      'document.querySelector("#checkout > button:nth-of-type(2)")'
    );
    expect(resolved.querySelectorChain).toBe(
      'document.querySelector("#checkout > button:nth-of-type(2)")'
    );
    expect(resolveTopLevelQuerySelector(window, resolved.querySelector ?? null)).toBe(target);
    expect(resolveXpath(window.document, resolved.xpath ?? null)).toBe(target);
  });

  it("escapes special characters in ids for selector and xpath output", () => {
    const window = createWindow("<!doctype html><html><body></body></html>");
    const button = window.document.createElement("button");
    button.id = `cta:hero"slot'primary`;
    button.textContent = "Checkout";
    window.document.body.append(button);

    const { snapshot, resolveRef } = createSnapshotHelpers(window);
    const result = snapshot({
      options: {
        mode: "ai"
      }
    });
    const ref = refForLine(result, 'button "Checkout"');
    const resolved = resolveRef({ ref });

    expect(resolved.selector).toBe(String.raw`#cta\:hero\"slot\'primary`);
    expect(resolved.xpath).toBe(`//*[@id=concat("cta:hero", '"', "slot'primary")]`);
    expect(resolveTopLevelQuerySelector(window, resolved.querySelector ?? null)).toBe(button);
    expect(resolveXpath(window.document, resolved.xpath ?? null)).toBe(button);
  });

  it("returns frame-aware locator metadata for refs inside an iframe", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <iframe id="checkout-frame"></iframe>
        </body>
      </html>
    `);
    const iframe = window.document.getElementById("checkout-frame") as HTMLIFrameElement;
    const frameWindow = attachIframeWindow(
      iframe,
      `
        <!doctype html>
        <html>
          <body>
            <main>
              <button id="inside-frame">Confirm order</button>
            </main>
          </body>
        </html>
      `
    );
    const { snapshot, resolveRef } = createSnapshotHelpers(window);

    const result = snapshot({
      options: {
        mode: "ai"
      }
    });
    const ref = refForLine(result, 'button "Confirm order"');
    const resolved = resolveRef({ ref });
    const target = frameWindow.document.getElementById("inside-frame");

    expect(resolved.querySelector).toBeNull();
    expect(resolved.selector).toBe("#inside-frame");
    expect(resolved.framePath).toEqual([
      {
        selector: "#checkout-frame",
        xpath: '//*[@id="checkout-frame"]'
      }
    ]);
    expect(resolved.querySelectorChain).toBe(
      'document.querySelector("#checkout-frame")?.contentDocument.querySelector("#inside-frame")'
    );
    expect(resolveTopLevelQuerySelector(window, resolved.querySelectorChain ?? null)).toBe(target);
    expect(resolveXpath(frameWindow.document, resolved.xpath ?? null)).toBe(target);
  });

  it("marks shadow DOM refs as non-query-selectable from document scope", () => {
    const window = createWindow("<!doctype html><html><body><div id=\"host\"></div></body></html>");
    const host = window.document.getElementById("host")!;
    const shadowRoot = host.attachShadow({ mode: "open" });
    const button = window.document.createElement("button");
    button.textContent = "Shadow action";
    shadowRoot.append(button);

    const { snapshot, resolveRef } = createSnapshotHelpers(window);
    const result = snapshot({
      options: {
        mode: "ai"
      }
    });
    const ref = refForLine(result, 'button "Shadow action"');
    const resolved = resolveRef({ ref });

    expect(resolved).toEqual({
      ok: true,
      ref,
      selector: null,
      xpath: null,
      querySelector: null,
      querySelectorChain: null,
      framePath: [],
      inShadowTree: true
    });
  });

  it("returns stale when the referenced element has been removed after snapshot", () => {
    const window = createWindow("<!doctype html><html><body><button id=\"remove-me\">Remove me</button></body></html>");
    const { snapshot, resolveRef } = createSnapshotHelpers(window);
    const result = snapshot({
      options: {
        mode: "ai"
      }
    });
    const ref = firstRef(result);
    window.document.getElementById("remove-me")?.remove();

    expect(resolveRef({ ref })).toEqual({
      ok: false,
      reason: "stale"
    });
  });
});
