import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page aria snapshot iframe refs e2e", () => {
  it("assigns flat eN refs at top level and f{n}eN refs inside an iframe", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button id="top">Top button</button>
        <iframe id="frame-a" srcdoc='<button id="inside-a">Inside frame</button>'></iframe>
      `);

      // Wait until the iframe document is loaded and same-origin accessible.
      await page.evaluate(`
        new Promise((resolve, reject) => {
          const start = Date.now();
          const check = () => {
            const frame = document.getElementById("frame-a");
            const doc = frame && frame.contentDocument;
            if (doc && doc.getElementById("inside-a")) {
              resolve(true);
              return;
            }
            if (Date.now() - start > 5000) {
              reject(new Error("iframe content did not load"));
              return;
            }
            setTimeout(check, 25);
          };
          check();
        })
      `);

      const snapshot = await page.ariaSnapshot({ mode: "ai" });

      const topLine = snapshot
        .split("\n")
        .find((line) => line.includes('"Top button"') && line.includes("[ref="));
      const insideLine = snapshot
        .split("\n")
        .find((line) => line.includes('"Inside frame"') && line.includes("[ref="));

      expect(topLine, `snapshot:\n${snapshot}`).toBeDefined();
      expect(insideLine, `snapshot:\n${snapshot}`).toBeDefined();

      const topRef = topLine!.match(/\[ref=((?:f\d+)?e\d+)\]/)![1];
      const insideRef = insideLine!.match(/\[ref=((?:f\d+)?e\d+)\]/)![1];

      expect(topRef).toMatch(/^e\d+$/);
      expect(insideRef).toMatch(/^f1e\d+$/);
    });
  });

  it("resolves a frame-prefixed ref back to the in-frame element", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <iframe id="frame-a" srcdoc='<button id="inside-a">Confirm</button>'></iframe>
      `);

      await page.evaluate(`
        new Promise((resolve, reject) => {
          const start = Date.now();
          const check = () => {
            const frame = document.getElementById("frame-a");
            const doc = frame && frame.contentDocument;
            if (doc && doc.getElementById("inside-a")) {
              resolve(true);
              return;
            }
            if (Date.now() - start > 5000) {
              reject(new Error("iframe content did not load"));
              return;
            }
            setTimeout(check, 25);
          };
          check();
        })
      `);

      const snapshot = await page.ariaSnapshot({ mode: "ai" });
      const insideLine = snapshot
        .split("\n")
        .find((line) => line.includes('"Confirm"') && line.includes("[ref="));
      expect(insideLine, `snapshot:\n${snapshot}`).toBeDefined();

      const ref = insideLine!.match(/\[ref=((?:f\d+)?e\d+)\]/)![1]!;
      expect(ref).toMatch(/^f1e\d+$/);

      const resolved = await page.resolveAriaRef(ref);
      expect(resolved.ref).toBe(ref);
      // The element lives inside the iframe, so a frame path must be present.
      expect(Array.isArray(resolved.framePath)).toBe(true);
      expect(resolved.framePath!.length).toBeGreaterThanOrEqual(1);
    });
  });
});
