import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

function refForLine(snapshot: string, fragment: string): string {
  const line = snapshot
    .split("\n")
    .find((candidate) => candidate.includes(fragment) && candidate.includes("[ref="));

  expect(line, `snapshot:\n${snapshot}`).toBeDefined();
  const match = line!.match(/\[ref=((?:f\d+)?e\d+)\]/);
  expect(match, `line:\n${line}`).toBeTruthy();
  return match![1]!;
}

describe("page aria snapshot contract e2e", () => {
  it("generates refs and resolves top-level selector metadata", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <main>
          <button id="buy-now">Buy now</button>
        </main>
      `);

      const snapshot = await page.ariaSnapshot({ mode: "ai" });
      const ref = refForLine(snapshot, 'button "Buy now"');
      const resolved = await page.resolveAriaRef(ref);

      expect(snapshot).toContain("[ref=");
      expect(resolved).toEqual({
        ref,
        selector: "#buy-now",
        xpath: '//*[@id="buy-now"]',
        querySelector: 'document.querySelector("#buy-now")',
        querySelectorChain: 'document.querySelector("#buy-now")',
        framePath: [],
        inShadowTree: false
      });
    });
  });

  it("falls back to structural selectors when duplicate ids are present", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <section id="shell">
          <button id="duplicate">First action</button>
          <div>
            <button id="duplicate">Second action</button>
          </div>
        </section>
      `);

      const snapshot = await page.ariaSnapshot({ mode: "ai" });
      const ref = refForLine(snapshot, 'button "Second action"');
      const resolved = await page.resolveAriaRef(ref);

      expect(resolved.selector).toBe("#shell > div:nth-of-type(1) > button:nth-of-type(1)");
      expect(resolved.querySelector).toBe(
        'document.querySelector("#shell > div:nth-of-type(1) > button:nth-of-type(1)")'
      );
      expect(resolved.inShadowTree).toBe(false);
    });
  });

  it("marks shadow DOM refs as non-query-selectable from document scope", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div id="host"></div>`);
      await page.evaluate(`() => {
        const host = document.getElementById("host");
        const root = host.attachShadow({ mode: "open" });
        const button = document.createElement("button");
        button.textContent = "Shadow action";
        root.appendChild(button);
      }`);

      const snapshot = await page.ariaSnapshot({ mode: "ai" });
      const ref = refForLine(snapshot, 'button "Shadow action"');
      const resolved = await page.resolveAriaRef(ref);

      expect(resolved).toEqual({
        ref,
        selector: null,
        xpath: null,
        querySelector: null,
        querySelectorChain: null,
        framePath: [],
        inShadowTree: true
      });
    });
  });

  it("collapses generic wrapper nodes around interactive content", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div>
          <div>
            <div>
              <button>Button</button>
            </div>
          </div>
        </div>
      `);

      const snapshot = await page.ariaSnapshot({ mode: "ai" });

      expect(snapshot).toContain('button "Button"');
      expect(snapshot).not.toContain("generic");
    });
  });

  it("includes cursor pointer and active element markers", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <a href="about:blank" style="cursor: pointer">Pointer link</a>
        <input id="first-input" placeholder="First input" />
        <input id="second-input" placeholder="Second input" />
      `);
      await page.evaluate(`() => {
        document.getElementById("second-input").focus();
      }`);

      const snapshot = await page.ariaSnapshot({ mode: "ai" });

      expect(snapshot).toContain('link "Pointer link"');
      expect(snapshot).toContain("[cursor=pointer]");
      expect(snapshot).toContain('textbox "Second input" [active]');
    });
  });

  it("does not expose refs in default mode and invalidates prior ai refs", async () => {
    await withPage(async (page) => {
      await page.setContent(`<button>Click me</button>`);

      const aiSnapshot = await page.ariaSnapshot({ mode: "ai" });
      const ref = refForLine(aiSnapshot, 'button "Click me"');

      const defaultSnapshot = await page.ariaSnapshot({ mode: "default" });
      expect(defaultSnapshot).not.toContain("[ref=");

      const error = await page.resolveAriaRef(ref).catch((caughtError: Error) => caughtError);
      expect(error.message).toContain('Call page.ariaSnapshot({ mode: "ai" }) again first.');
    });
  });
});
