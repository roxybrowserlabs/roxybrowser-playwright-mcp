import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page.dispatchEvent contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  beforeEach(() => {
    fixture.server.reset();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("dispatches click event", async () => {
    await withPage(async (page) => {
      await page.setContent("<button onclick=\"window.result = 'Clicked'\">Click</button>");

      await page.dispatchEvent("button", "click");

      expect(await page.evaluate(() => window.result)).toBe("Clicked");
    });
  });

  it("dispatches click event properties", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button>Click</button>
        <script>
          document.querySelector('button').addEventListener('click', event => {
            window.bubbles = event.bubbles;
            window.cancelable = event.cancelable;
            window.composed = event.composed;
          });
        </script>
      `);

      await page.dispatchEvent("button", "click");

      expect(await page.evaluate(() => window.bubbles)).toBeTruthy();
      expect(await page.evaluate(() => window.cancelable)).toBeTruthy();
      expect(await page.evaluate(() => window.composed)).toBeTruthy();
    });
  });

  it("dispatches click on svg", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <svg height="100" width="100">
          <circle onclick="window.__CLICKED = 42" cx="50" cy="50" r="40" stroke="black" stroke-width="3" fill="red" />
        </svg>
      `);

      await page.dispatchEvent("circle", "click");

      expect(await page.evaluate(() => window.__CLICKED)).toBe(42);
    });
  });

  it("dispatches click after navigation", async () => {
    await withPage(async (page) => {
      await page.setContent("<button onclick=\"window.result = 'Clicked'\">Click</button>");
      await page.dispatchEvent("button", "click");
      await page.setContent("<button onclick=\"window.result = 'Clicked'\">Click</button>");

      await page.dispatchEvent("button", "click");

      expect(await page.evaluate(() => window.result)).toBe("Clicked");
    });
  });

  it("dispatches click event via ElementHandle", async () => {
    await withPage(async (page) => {
      await page.setContent("<button onclick=\"window.result = 'Clicked'\">Click</button>");
      const button = await page.$("button");

      await button!.dispatchEvent("click");

      expect(await page.evaluate(() => window.result)).toBe("Clicked");
    });
  });

  it("dispatches wheel event via Locator", async () => {
    await withPage(async (page) => {
      await page.setContent("<body style='height: 1000px'></body>");
      const eventsHandle = await page.locator("body").evaluateHandle((body) => {
        const events: WheelEvent[] = [];
        body.addEventListener("wheel", (event) => events.push(event));
        return events;
      });

      await page.locator("body").dispatchEvent("wheel", { deltaX: 100, deltaY: 200 });

      expect(await eventsHandle.evaluate((events) => events.length)).toBe(1);
      expect(await eventsHandle.evaluate((events) => events[0] instanceof WheelEvent)).toBeTruthy();
      expect(await eventsHandle.evaluate((events) => ({ deltaX: events[0].deltaX, deltaY: events[0].deltaY }))).toEqual({
        deltaX: 100,
        deltaY: 200
      });
    });
  });
});
