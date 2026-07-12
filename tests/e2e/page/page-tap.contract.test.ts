import { afterAll, describe, expect, it } from "vitest";
import { connectTestBrowser } from "../../helpers/browser.js";
import type { Browser, BrowserContext, Page } from "../../../src/types/api.js";
import { cleanupLocalTestBrowserProcessesWithTimeout } from "../../helpers/browser-process-cleanup.js";

describe("page tap contract e2e", () => {
  afterAll(async () => {
    await cleanupLocalTestBrowserProcessesWithTimeout();
  });

  it("sends the expected tap event sequence", async () => {
    await withTapPage(async (page) => {
      await page.setContent(`
        <div id="a" style="background: lightblue; width: 50px; height: 50px">a</div>
        <div id="b" style="background: pink; width: 50px; height: 50px">b</div>
      `);

      await page.tap("#a");
      await trackEventsOnSelector(page, "#b");
      await page.tap("#b");

      expect(await readTrackedEvents(page)).toEqual([
        "pointerover",
        "pointerenter",
        "pointerdown",
        "touchstart",
        "pointerup",
        "pointerout",
        "pointerleave",
        "touchend",
        "mouseover",
        "mouseenter",
        "mousemove",
        "mousedown",
        "mouseup",
        "click"
      ]);
    });
  });

  it("does not send mouse events when touchstart is canceled", async () => {
    await withTapPage(async (page) => {
      await page.setContent(`<div style="width: 50px; height: 50px; background: red"></div>`);
      await page.evaluate(() => {
        document.addEventListener("touchstart", (event) => event.preventDefault(), { passive: false });
      });

      await trackEventsOnSelector(page, "div");
      await page.tap("div");

      expect(await readTrackedEvents(page)).toEqual([
        "pointerover",
        "pointerenter",
        "pointerdown",
        "touchstart",
        "pointerup",
        "pointerout",
        "pointerleave",
        "touchend"
      ]);
    });
  });

  it("does not send mouse events when touchend is canceled", async () => {
    await withTapPage(async (page) => {
      await page.setContent(`<div style="width: 50px; height: 50px; background: red"></div>`);
      await page.evaluate(() => {
        document.addEventListener("touchend", (event) => event.preventDefault());
      });

      await trackEventsOnSelector(page, "div");
      await page.tap("div");

      expect(await readTrackedEvents(page)).toEqual([
        "pointerover",
        "pointerenter",
        "pointerdown",
        "touchstart",
        "pointerup",
        "pointerout",
        "pointerleave",
        "touchend"
      ]);
    });
  });

  it("supports tap modifiers", async () => {
    await withTapPage(async (page) => {
      await page.setContent("hello world");

      const altKeyPromise = page.evaluate(() => new Promise<boolean>((resolve) => {
        document.addEventListener("touchstart", (event) => {
          resolve(event.altKey);
        }, { passive: false, once: true });
      }));

      await page.evaluate(() => void 0);
      await page.tap("body", { modifiers: ["Alt"] });

      expect(await altKeyPromise).toBe(true);
    });
  });

  it("sends well-formed touchscreen touch points", async () => {
    await withTapPage(async (page) => {
      const touchStartPromise = page.evaluate(() => new Promise((resolve) => {
        document.addEventListener("touchstart", (event) => {
          resolve([...event.touches].map((touch) => ({
            identifier: touch.identifier,
            clientX: touch.clientX,
            clientY: touch.clientY,
            pageX: touch.pageX,
            pageY: touch.pageY,
            radiusX: "radiusX" in touch ? touch.radiusX : (touch as Touch & { webkitRadiusX: number }).webkitRadiusX,
            radiusY: "radiusY" in touch ? touch.radiusY : (touch as Touch & { webkitRadiusY: number }).webkitRadiusY,
            rotationAngle: "rotationAngle" in touch ? touch.rotationAngle : (touch as Touch & { webkitRotationAngle: number }).webkitRotationAngle,
            force: "force" in touch ? touch.force : (touch as Touch & { webkitForce: number }).webkitForce
          })));
        }, false);
      }));
      const touchEndPromise = page.evaluate(() => new Promise((resolve) => {
        document.addEventListener("touchend", (event) => {
          resolve([...event.touches].map((touch) => ({
            identifier: touch.identifier,
            clientX: touch.clientX,
            clientY: touch.clientY,
            pageX: touch.pageX,
            pageY: touch.pageY,
            radiusX: "radiusX" in touch ? touch.radiusX : (touch as Touch & { webkitRadiusX: number }).webkitRadiusX,
            radiusY: "radiusY" in touch ? touch.radiusY : (touch as Touch & { webkitRadiusY: number }).webkitRadiusY,
            rotationAngle: "rotationAngle" in touch ? touch.rotationAngle : (touch as Touch & { webkitRotationAngle: number }).webkitRotationAngle,
            force: "force" in touch ? touch.force : (touch as Touch & { webkitForce: number }).webkitForce
          })));
        }, false);
      }));

      await page.evaluate(() => void 0);
      await page.touchscreen.tap(40, 60);

      expect(await touchStartPromise).toEqual([{
        clientX: 40,
        clientY: 60,
        force: 1,
        identifier: 0,
        pageX: 40,
        pageY: 60,
        radiusX: 1,
        radiusY: 1,
        rotationAngle: 0
      }]);
      expect(await touchEndPromise).toEqual([]);
    });
  });
});

async function withTapPage<T>(
  run: (page: Page, context: BrowserContext, browser: Browser) => Promise<T>
): Promise<T> {
  const browser = await connectTestBrowser();

  try {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      try {
        return await run(page, context, browser);
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
    await cleanupLocalTestBrowserProcessesWithTimeout();
  }
}

async function trackEventsOnSelector(page: Page, selector: string): Promise<void> {
  await page.$eval(selector, (target) => {
    const events: string[] = [];
    for (const event of [
      "mousedown", "mouseenter", "mouseleave", "mousemove", "mouseout", "mouseover", "mouseup", "click",
      "pointercancel", "pointerdown", "pointerenter", "pointerleave", "pointermove", "pointerout", "pointerover", "pointerup",
      "touchstart", "touchend", "touchmove", "touchcancel"
    ]) {
      target.addEventListener(event, () => events.push(event), false);
    }
    (window as Window & { __roxyTapEvents?: string[] }).__roxyTapEvents = events;
  });
}

async function readTrackedEvents(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as Window & { __roxyTapEvents?: string[] }).__roxyTapEvents ?? []);
}
