import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { SELECTOR_RUNTIME_SOURCE } from "../../src/protocol/selectorRuntime.js";
import type { SelectorRuntimePayload } from "../../src/protocol/selectorRuntime.js";

function createRuntime(html: string): {
  document: Document;
  run: (payload: SelectorRuntimePayload) => Promise<unknown>;
} {
  const dom = new JSDOM(html, {
    url: "https://example.test",
    runScripts: "outside-only"
  });
  return {
    document: dom.window.document,
    run: dom.window.eval(`(${SELECTOR_RUNTIME_SOURCE})`) as (payload: SelectorRuntimePayload) => Promise<unknown>
  };
}

describe("selector runtime", () => {
  it("does not match internal overlay shadow DOM nodes with CSS selectors", async () => {
    const { document, run } = createRuntime(`<!doctype html><html><body>
      <div>hello</div>
      <x-pw-user-overlays></x-pw-user-overlays>
    </body></html>`);
    const overlay = document.querySelector("x-pw-user-overlays")!;
    const shadowRoot = overlay.attachShadow({ mode: "open" });
    const internalDiv = document.createElement("div");
    shadowRoot.append(internalDiv);

    const count = await run({
      operation: "count",
      reference: {
        chain: [{ strategy: "css", value: "div" }]
      }
    });

    expect(count).toBe(1);
  });

  it("does not match cursor visualization nodes with CSS selectors", async () => {
    const { run } = createRuntime(`<!doctype html><html><body>
      <div>hello</div>
      <div class="curzr"></div>
    </body></html>`);

    const count = await run({
      operation: "count",
      reference: {
        chain: [{ strategy: "css", value: "div" }]
      }
    });

    expect(count).toBe(1);
  });
});
