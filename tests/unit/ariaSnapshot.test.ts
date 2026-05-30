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
      options: { mode: "ai" | "default"; depth?: number; boxes?: boolean; timeout?: number };
      target?: { nodeToken?: string; selector?: string; raw?: string };
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

  const match = line.match(/\[ref=(e\d+)\]/);
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
    const ref = refForLine(result, 'button "Buy now"');
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

    expect(resolveRef({ ref: "e99" })).toEqual({
      ok: false,
      reason: "stale"
    });
  });

  it("does not expose refs for default snapshots", () => {
    const window = createWindow("<!doctype html><html><body><button id=\"plain\">Click</button></body></html>");
    const { snapshot, resolveRef } = createSnapshotHelpers(window);
    const result = snapshot({
      options: {
        mode: "default"
      }
    });

    expect(result.text).not.toContain("[ref=");
    expect(result.refs).toEqual({});
    expect(resolveRef({ ref: "e1" })).toEqual({
      ok: false,
      reason: "stale"
    });
  });

  it("invalidates prior ai refs after a default snapshot clears ref state", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <button id="first">First</button>
        </body>
      </html>
    `);
    const { snapshot, resolveRef } = createSnapshotHelpers(window);

    const aiSnapshot = snapshot({
      options: {
        mode: "ai"
      }
    });
    const ref = refForLine(aiSnapshot, 'button "First"');

    snapshot({
      options: {
        mode: "default"
      }
    });

    expect(resolveRef({ ref })).toEqual({
      ok: false,
      reason: "stale"
    });
  });

  it("supports selector-targeted snapshots from a subtree root", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <section id="marketing">
            <button>Learn more</button>
          </section>
          <section id="checkout">
            <button>Pay now</button>
          </section>
        </body>
      </html>
    `);
    const { snapshot } = createSnapshotHelpers(window);

    const result = snapshot({
      options: {
        mode: "ai"
      },
      target: {
        raw: "#checkout",
        selector: "#checkout"
      }
    });
    const sectionRef = refForLine(result, "- section");
    const buttonRef = refForLine(result, 'button "Pay now"');

    expect(result.text).toBe(`- section [ref=${sectionRef}]:
  - button "Pay now" [ref=${buttonRef}]`);
  });

  it("supports ref-targeted snapshots using the previous snapshot state", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <main>
            <button id="pay-now">Pay now</button>
            <button id="cancel">Cancel</button>
          </main>
        </body>
      </html>
    `);
    const { snapshot } = createSnapshotHelpers(window);

    const firstResult = snapshot({
      options: {
        mode: "ai"
      }
    });
    const ref = refForLine(firstResult, 'button "Pay now"');
    const nodeToken = firstResult.refs[ref];
    if (!nodeToken) {
      throw new Error(`Expected node token for ref "${ref}".`);
    }

    const secondResult = snapshot({
      options: {
        mode: "ai"
      },
      target: {
        raw: ref,
        nodeToken
      }
    });
    expect(secondResult.text).toBe(`- button "Pay now" [ref=${ref}]`);
  });

  it("matches Playwright-style snapshot depth rendering for list trees", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <ul>
            <li>text</li>
            <li>
              <button>Button</button>
            </li>
          </ul>
        </body>
      </html>
    `);
    const { snapshot } = createSnapshotHelpers(window);

    const depthOne = snapshot({
      options: {
        mode: "ai",
        depth: 1
      }
    });
    const listRef = refForLine(depthOne, "- list ");
    const textItemRef = refForLine(depthOne, "- listitem");
    const nestedItemRef = depthOne.text
      .split("\n")
      .filter((line) => line.startsWith("  - listitem"))
      .find((line) => !line.includes(": text"));
    if (!nestedItemRef) {
      throw new Error(`Expected nested list item line.\n${depthOne.text}`);
    }
    const nestedItemMatch = nestedItemRef.match(/\[ref=(e\d+)\]/);
    if (!nestedItemMatch) {
      throw new Error(`Expected ref in line: ${nestedItemRef}`);
    }

    expect(depthOne.text).toBe(`- list [ref=${listRef}]:
  - listitem [ref=${textItemRef}]: text
  - listitem [ref=${nestedItemMatch[1]}]`);

    const depthTwo = snapshot({
      options: {
        mode: "ai",
        depth: 2
      }
    });
    const listRef2 = refForLine(depthTwo, "- list ");
    const textItemRef2 = depthTwo.text
      .split("\n")
      .find((line) => line.startsWith("  - listitem") && line.includes(": text"));
    const nestedItemRef2 = depthTwo.text
      .split("\n")
      .find((line) => line.startsWith("  - listitem") && !line.includes(": text"));
    const buttonRef2 = refForLine(depthTwo, 'button "Button"');
    if (!textItemRef2 || !nestedItemRef2) {
      throw new Error(`Expected both list item lines.\n${depthTwo.text}`);
    }
    const textItemMatch2 = textItemRef2.match(/\[ref=(e\d+)\]/);
    const nestedItemMatch2 = nestedItemRef2.match(/\[ref=(e\d+)\]/);
    if (!textItemMatch2 || !nestedItemMatch2) {
      throw new Error(`Expected refs in list item lines.\n${depthTwo.text}`);
    }

    expect(depthTwo.text).toBe(`- list [ref=${listRef2}]:
  - listitem [ref=${textItemMatch2[1]}]: text
  - listitem [ref=${nestedItemMatch2[1]}]:
    - button "Button" [ref=${buttonRef2}]`);
  });

  it("supports boxes and omits them by default", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <button>click</button>
        </body>
      </html>
    `);
    const button = window.document.querySelector("button")!;
    button.getBoundingClientRect = () => ({
      x: 100,
      y: 50,
      width: 80,
      height: 40,
      top: 50,
      right: 180,
      bottom: 90,
      left: 100,
      toJSON() {
        return this;
      }
    });
    const { snapshot } = createSnapshotHelpers(window);

    const boxed = snapshot({
      options: {
        mode: "ai",
        boxes: true
      }
    });
    expect(boxed.text).toContain('button "click"');
    expect(boxed.text).toContain("[box=100,50,80,40]");

    const plain = snapshot({
      options: {
        mode: "ai"
      }
    });
    expect(plain.text).not.toContain("[box=");
  });

  it("returns strict and no-match errors for selector targets", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <button>Submit</button>
          <button>Cancel</button>
        </body>
      </html>
    `);
    const { snapshot } = createSnapshotHelpers(window);

    const strictResult = snapshot({
      options: {
        mode: "ai"
      },
      target: {
        raw: "button",
        selector: "button"
      }
    });
    expect(strictResult.error).toEqual({
      code: "strict",
      message: 'strict mode violation: "button" matches multiple elements.'
    });

    const notFound = snapshot({
      options: {
        mode: "ai"
      },
      target: {
        raw: "#target",
        selector: "#target"
      }
    });
    expect(notFound.error).toEqual({
      code: "not_found",
      message: '"#target" does not match any element.'
    });
  });

  it("keeps visibility:hidden > visibility:visible descendants in the snapshot", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <div style="visibility: hidden;">
            <div style="visibility: visible;">
              <button>Button</button>
            </div>
          </div>
        </body>
      </html>
    `);
    const { snapshot } = createSnapshotHelpers(window);

    const result = snapshot({
      options: {
        mode: "ai"
      }
    });

    expect(result.text).toContain('- button "Button"');
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

  it("escapes numeric-leading ids so querySelector remains valid", () => {
    const window = createWindow("<!doctype html><html><body></body></html>");
    const button = window.document.createElement("button");
    button.id = "123checkout";
    button.textContent = "Pay";
    window.document.body.append(button);

    const { snapshot, resolveRef } = createSnapshotHelpers(window);
    const result = snapshot({
      options: {
        mode: "ai"
      }
    });
    const ref = refForLine(result, 'button "Pay"');
    const resolved = resolveRef({ ref });

    expect(resolved.selector).toBe(String.raw`#\31 23checkout`);
    expect(resolveTopLevelQuerySelector(window, resolved.querySelector ?? null)).toBe(button);
    expect(resolveXpath(window.document, resolved.xpath ?? null)).toBe(button);
  });

  it("falls back to structural selectors when duplicate ids are present", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <section id="shell">
            <button id="duplicate">First action</button>
            <div>
              <button id="duplicate">Second action</button>
            </div>
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
    const ref = refForLine(result, 'button "Second action"');
    const resolved = resolveRef({ ref });
    const target = window.document.querySelector("#shell > div:nth-of-type(1) > button:nth-of-type(1)");

    expect(resolved.selector).toBe("#shell > div:nth-of-type(1) > button:nth-of-type(1)");
    expect(resolveTopLevelQuerySelector(window, resolved.querySelector ?? null)).toBe(target);
    expect(resolveXpath(window.document, resolved.xpath ?? null)).toBe(target);
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

  it("keeps slotted light DOM nodes query-selectable", () => {
    const window = createWindow("<!doctype html><html><body><div id=\"host\"></div></body></html>");
    const host = window.document.getElementById("host")!;
    const shadowRoot = host.attachShadow({ mode: "open" });
    const slot = window.document.createElement("slot");
    shadowRoot.append(slot);

    const button = window.document.createElement("button");
    button.textContent = "Slotted checkout";
    host.append(button);

    const { snapshot, resolveRef } = createSnapshotHelpers(window);
    const result = snapshot({
      options: {
        mode: "ai"
      }
    });
    const ref = refForLine(result, 'button "Slotted checkout"');
    const resolved = resolveRef({ ref });

    expect(resolved).toEqual({
      ok: true,
      ref,
      selector: "#host > button:nth-of-type(1)",
      xpath: "/html[1]/body[1]/div[1]/button[1]",
      querySelector: 'document.querySelector("#host > button:nth-of-type(1)")',
      querySelectorChain: 'document.querySelector("#host > button:nth-of-type(1)")',
      framePath: [],
      inShadowTree: false
    });
    expect(resolveTopLevelQuerySelector(window, resolved.querySelector ?? null)).toBe(button);
    expect(resolveXpath(window.document, resolved.xpath ?? null)).toBe(button);
  });

  it("reports unresolved frame selectors when an iframe lives inside shadow DOM", () => {
    const window = createWindow("<!doctype html><html><body><div id=\"shadow-host\"></div></body></html>");
    const host = window.document.getElementById("shadow-host")!;
    const shadowRoot = host.attachShadow({ mode: "open" });
    const iframe = window.document.createElement("iframe");
    iframe.id = "payments-frame";
    shadowRoot.append(iframe);

    const frameWindow = attachIframeWindow(
      iframe,
      `
        <!doctype html>
        <html>
          <body>
            <button id="pay-inside-shadow-frame">Pay inside shadow frame</button>
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
    const ref = refForLine(result, 'button "Pay inside shadow frame"');
    const resolved = resolveRef({ ref });

    expect(resolved.selector).toBe("#pay-inside-shadow-frame");
    expect(resolved.xpath).toBe('//*[@id="pay-inside-shadow-frame"]');
    expect(resolved.querySelector).toBeNull();
    expect(resolved.querySelectorChain).toBeNull();
    expect(resolved.framePath).toEqual([
      {
        selector: null,
        xpath: null
      }
    ]);
    expect(resolveXpath(frameWindow.document, resolved.xpath ?? null)).toBe(
      frameWindow.document.getElementById("pay-inside-shadow-frame")
    );
  });

  it("builds nested frame querySelector chains for multi-level iframes", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <main id="app">
            <iframe></iframe>
          </main>
        </body>
      </html>
    `);
    const outerFrame = window.document.querySelector("iframe") as HTMLIFrameElement;
    const outerWindow = attachIframeWindow(
      outerFrame,
      `
        <!doctype html>
        <html>
          <body>
            <section id="outer-shell">
              <iframe></iframe>
            </section>
          </body>
        </html>
      `
    );
    const innerFrame = outerWindow.document.querySelector("iframe") as HTMLIFrameElement;
    const innerWindow = attachIframeWindow(
      innerFrame,
      `
        <!doctype html>
        <html>
          <body>
            <button>Nested checkout</button>
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
    const ref = refForLine(result, 'button "Nested checkout"');
    const resolved = resolveRef({ ref });
    const target = innerWindow.document.querySelector("button");

    expect(resolved.selector).toBe("html > body:nth-of-type(1) > button:nth-of-type(1)");
    expect(resolved.framePath).toEqual([
      {
        selector: "#app > iframe:nth-of-type(1)",
        xpath: "/html[1]/body[1]/main[1]/iframe[1]"
      },
      {
        selector: "#outer-shell > iframe:nth-of-type(1)",
        xpath: "/html[1]/body[1]/section[1]/iframe[1]"
      }
    ]);
    expect(resolved.querySelectorChain).toBe(
      'document.querySelector("#app > iframe:nth-of-type(1)")?.contentDocument.querySelector("#outer-shell > iframe:nth-of-type(1)")?.contentDocument.querySelector("html > body:nth-of-type(1) > button:nth-of-type(1)")'
    );
    expect(resolveTopLevelQuerySelector(window, resolved.querySelectorChain ?? null)).toBe(target);
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
    const ref = refForLine(result, 'button "Remove me"');
    window.document.getElementById("remove-me")?.remove();

    expect(resolveRef({ ref })).toEqual({
      ok: false,
      reason: "stale"
    });
  });

  it("recomputes selector and xpath after the same node is moved in the DOM", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <section id="source">
            <button>Keep</button>
            <button>Move me</button>
          </section>
          <section id="target"></section>
        </body>
      </html>
    `);
    const { snapshot, resolveRef } = createSnapshotHelpers(window);
    const result = snapshot({
      options: {
        mode: "ai"
      }
    });
    const ref = refForLine(result, 'button "Move me"');
    const movedButton = window.document.querySelector("#source > button:nth-of-type(2)")!;
    window.document.getElementById("target")!.append(movedButton);

    const resolved = resolveRef({ ref });

    expect(resolved.selector).toBe("#target > button:nth-of-type(1)");
    expect(resolved.querySelector).toBe('document.querySelector("#target > button:nth-of-type(1)")');
    expect(resolved.querySelectorChain).toBe(
      'document.querySelector("#target > button:nth-of-type(1)")'
    );
    expect(resolveTopLevelQuerySelector(window, resolved.querySelector ?? null)).toBe(movedButton);
    expect(resolveXpath(window.document, resolved.xpath ?? null)).toBe(movedButton);
  });

  it("invalidates old refs after a new ai snapshot is generated", () => {
    const window = createWindow(`
      <!doctype html>
      <html>
        <body>
          <button id="before">Before rerender</button>
        </body>
      </html>
    `);
    const { snapshot, resolveRef } = createSnapshotHelpers(window);

    const firstSnapshot = snapshot({
      options: {
        mode: "ai"
      }
    });
    const firstRef = refForLine(firstSnapshot, 'button "Before rerender"');
    window.document.body.innerHTML = '<button id="after">After rerender</button>';

    const secondSnapshot = snapshot({
      options: {
        mode: "ai"
      }
    });
    const secondRef = refForLine(secondSnapshot, 'button "After rerender"');
    const secondResolved = resolveRef({ ref: secondRef });

    expect(resolveRef({ ref: firstRef })).toEqual({
      ok: false,
      reason: "stale"
    });
    expect(secondRef).not.toBe(firstRef);
    expect(secondResolved.selector).toBe("#after");
    expect(resolveTopLevelQuerySelector(window, secondResolved.querySelector ?? null)).toBe(
      window.document.getElementById("after")
    );
  });
});
