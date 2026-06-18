import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page screencast overlay contract e2e", () => {
  it("adds and removes overlays", async () => {
    await withPage(async (page) => {
      await page.goto("data:text/html,<body></body>");

      const overlay = await page.screencast.showOverlay('<div id="my-overlay">Hello Overlay</div>');
      expect(
        await page.evaluate(`() => {
          const container = document.querySelector("x-pw-user-overlays");
          return {
            count: document.querySelectorAll(".x-pw-user-overlay").length,
            hasContainer: !!container,
            text: document.getElementById("my-overlay")?.textContent ?? null
          };
        }`)
      ).toEqual({
        count: 1,
        hasContainer: true,
        text: "Hello Overlay"
      });

      await overlay.dispose();
      expect(
        await page.evaluate(`() => document.querySelectorAll(".x-pw-user-overlay").length`)
      ).toBe(0);
    });
  });

  it("supports multiple overlays and independent disposal", async () => {
    await withPage(async (page) => {
      await page.goto("data:text/html,<body></body>");

      const first = await page.screencast.showOverlay('<div id="overlay-1">First</div>');
      const second = await page.screencast.showOverlay('<div id="overlay-2">Second</div>');

      expect(
        await page.evaluate(`() => ({
          count: document.querySelectorAll(".x-pw-user-overlay").length,
          first: document.getElementById("overlay-1")?.textContent ?? null,
          second: document.getElementById("overlay-2")?.textContent ?? null
        })`)
      ).toEqual({
        count: 2,
        first: "First",
        second: "Second"
      });

      await first.dispose();
      expect(
        await page.evaluate(`() => ({
          count: document.querySelectorAll(".x-pw-user-overlay").length,
          second: document.getElementById("overlay-2")?.textContent ?? null
        })`)
      ).toEqual({
        count: 1,
        second: "Second"
      });

      await second.dispose();
      expect(await page.evaluate(`() => document.querySelectorAll(".x-pw-user-overlay").length`)).toBe(0);
    });
  });

  it("hides and shows overlays without removing them", async () => {
    await withPage(async (page) => {
      await page.goto("data:text/html,<body></body>");

      await page.screencast.showOverlay('<div id="visible-overlay">Visible</div>');
      await page.screencast.hideOverlays();
      expect(
        await page.evaluate(`() => {
          const container = document.querySelector("x-pw-user-overlays");
          return {
            hidden: container instanceof HTMLElement ? container.hidden : null,
            text: document.getElementById("visible-overlay")?.textContent ?? null
          };
        }`)
      ).toEqual({
        hidden: true,
        text: "Visible"
      });

      await page.screencast.showOverlays();
      expect(
        await page.evaluate(`() => {
          const container = document.querySelector("x-pw-user-overlays");
          return container instanceof HTMLElement ? container.hidden : null;
        }`)
      ).toBe(false);
    });
  });

  it("sanitizes scripts and event handlers from overlay html", async () => {
    await withPage(async (page) => {
      await page.goto("data:text/html,<body></body>");

      await page.screencast.showOverlay(
        '<div id="safe" onclick="window.__clicked=true">Safe</div><script>window.__injected = true</script>'
      );
      expect(
        await page.evaluate(`() => ({
          hasOnclick: document.getElementById("safe")?.hasAttribute("onclick") ?? null,
          injected: window.__injected ?? null,
          text: document.getElementById("safe")?.textContent ?? null
        })`)
      ).toEqual({
        hasOnclick: false,
        injected: null,
        text: "Safe"
      });
    });
  });

  it("survives navigation and reload", async () => {
    await withPage(async (page) => {
      await page.goto("data:text/html,<body><div>first</div></body>");
      await page.screencast.showOverlay('<div id="persistent">Persist</div>');

      await page.goto("data:text/html,<body><div>second</div></body>");
      expect(await page.evaluate(`() => document.getElementById("persistent")?.textContent ?? null`)).toBe(
        "Persist"
      );

      await page.reload();
      expect(await page.evaluate(`() => document.getElementById("persistent")?.textContent ?? null`)).toBe(
        "Persist"
      );
    });
  });

  it("does not restore disposed overlays after reload", async () => {
    await withPage(async (page) => {
      await page.goto("data:text/html,<body></body>");

      const overlay = await page.screencast.showOverlay('<div id="temp">Temporary</div>');
      await overlay.dispose();
      await page.reload();

      expect(await page.evaluate(`() => document.querySelectorAll(".x-pw-user-overlay").length`)).toBe(0);
    });
  });

  it("auto-removes overlays after timeout", async () => {
    await withPage(async (page) => {
      await page.goto("data:text/html,<body></body>");

      await page.screencast.showOverlay('<div id="timed">Temporary</div>', { duration: 1 });
      await page.waitForTimeout(25);

      expect(
        await page.evaluate(`() => document.querySelectorAll(".x-pw-user-overlay").length`)
      ).toBe(0);
    });
  });

  it("preserves inline styles inside overlay html", async () => {
    await withPage(async (page) => {
      await page.goto("data:text/html,<body></body>");

      await page.screencast.showOverlay(
        '<div id="styled" style="color: red; font-size: 20px;">Styled</div>'
      );
      expect(
        await page.evaluate(`() => {
          const node = document.getElementById("styled");
          return node instanceof HTMLElement ? getComputedStyle(node).color : null;
        }`)
      ).toBe("rgb(255, 0, 0)");
    });
  });
});
