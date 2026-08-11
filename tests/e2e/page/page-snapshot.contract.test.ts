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

  it("resolves refs for generic nodes distilled away in ai mode like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <a style="cursor: pointer" href="/issues/15860">
          <div>[Feature] a dedicated clipboard API</div>
        </a>
      `);

      const snapshot = await page.ariaSnapshot({ mode: "ai" });

      expect(snapshot).toContain('link "[Feature] a dedicated clipboard API"');
      expect(snapshot).not.toContain("[ref=e3]");
      const resolved = await page.resolveAriaRef("e3");
      expect(resolved.ref).toBe("e3");
      expect(resolved.selector).toContain("a:nth-of-type(1) > div:nth-of-type(1)");
      expect(resolved.querySelector).toContain("document.querySelector");
    });
  });

  it("omits name-repeating generics behind wrappers like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <a style="cursor: pointer" href="/labels">
          <span style="display: inline-block">
            <span style="display: inline-block">
              <span>P3-collecting-feedback</span>
            </span>
          </span>
        </a>
      `);

      const snapshot = await page.ariaSnapshot({ mode: "ai" });

      expect(snapshot).toContain('link "P3-collecting-feedback"');
      expect(snapshot).toContain("- /url: /labels");
      expect(snapshot.split("P3-collecting-feedback")).toHaveLength(2);
    });
  });

  it("inlines deeply nested generic text and removes nameless images like Playwright", async () => {
    await withPage(async (page) => {
      const img = `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=">`;
      await page.setContent(`
        <div>${img}<div>${img}<div>${img}<div>${img}<div>Deeply nested.</div></div></div></div></div>
      `);

      const snapshot = await page.ariaSnapshot({ mode: "ai" });

      expect(snapshot).toContain("- generic [active] [ref=e1]: Deeply nested.");
      expect(snapshot).not.toContain("img");
    });
  });

  it("keeps generic nodes with title like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div title="Element title">Element content</div>`);

      const snapshot = await page.ariaSnapshot({ mode: "ai" });

      expect(snapshot).toContain('generic "Element title"');
      expect(snapshot).toContain("[ref=");
    });
  });

  it("omits names that just repeat printed descendant nodes like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <h3><a style="cursor: pointer" href="/issues/1">Clipboard API</a></h3>
      `);

      const snapshot = await page.ariaSnapshot({ mode: "ai" });

      expect(snapshot).toContain("- heading [level=3]");
      expect(snapshot).toContain('link "Clipboard API"');
      expect(snapshot).toContain("[cursor=pointer]");
      expect(snapshot).not.toContain('heading "Clipboard API"');
    });
  });

  it("omits redundant name when a contributing wrapper is collapsed like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <h3><span style="display: flex"><a style="cursor: pointer" href="/issues/1">Clipboard API</a></span></h3>
      `);

      const snapshot = await page.ariaSnapshot({ mode: "ai" });

      expect(snapshot).toContain("- heading [level=3]");
      expect(snapshot).toContain('link "Clipboard API"');
      expect(snapshot).toContain("[cursor=pointer]");
      expect(snapshot).not.toContain('heading "Clipboard API"');
    });
  });

  it("omits redundant name when a contributor is a skipped leaf generic like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <h3><a style="cursor: pointer" href="/issues/1"><span><span>Clipboard API</span></span></a></h3>
      `);

      const snapshot = await page.ariaSnapshot({ mode: "ai" });

      expect(snapshot).toContain("- heading [level=3]");
      expect(snapshot).toContain('link "Clipboard API"');
      expect(snapshot).toContain("[cursor=pointer]");
      expect(snapshot).not.toContain('heading "Clipboard API"');
      expect(snapshot).not.toContain("generic");
    });
  });

  it("keeps names when contributing wrappers collapse into repeating text like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button>
          <span>
            <span>
              <svg focusable="false" tabindex="-1" aria-hidden="true" viewBox="0 0 448 512">
                <path d="M416 208H272V64c0-17.67-14.33-32-32-32h-32c-17.67 0-32 14.33-32 32v144H32c-17.67 0-32c0 17.67 14.33 32 32 32h144v144c0 17.67 14.33 32 32 32h32c17.67 0 32-14.33 32-32V304h144c17.67 0 32-14.33 32-32v-32c0-17.67-14.33-32-32-32z"/>
              </svg>
            </span>
            <span>Add New Item</span>
          </span>
        </button>
      `);

      const snapshot = await page.ariaSnapshot({ mode: "ai" });

      expect(snapshot).toContain('button "Add New Item"');
      expect(snapshot).not.toContain("- button [ref=");
    });
  });

  it("limits depth like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <ul>
          <li>item1</li>
          <a href="about:blank" style="cursor:pointer">link</a>
          <li>
            <ul id="target">
              <li>item2</li>
              <li>
                <ul>
                  <li>item3</li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      `);

      const snapshot = await page.locator("#target").ariaSnapshot({ mode: "ai", depth: 1 });

      expect(snapshot).toContain("- list ");
      expect(snapshot).toContain("- listitem ");
      expect(snapshot).toContain(": item2");
      expect(snapshot).not.toContain("item3");
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
