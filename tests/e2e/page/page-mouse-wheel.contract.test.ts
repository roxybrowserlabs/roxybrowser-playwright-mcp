import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page mouse and wheel contract e2e", () => {
  it("clicks the document like Playwright", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => {
        (window as unknown as { clickPromise: Promise<unknown> }).clickPromise = new Promise((resolve) => {
          document.addEventListener("click", (event) => {
            resolve({
              button: event.button,
              clientX: event.clientX,
              clientY: event.clientY,
              detail: event.detail,
              isTrusted: event.isTrusted,
              type: event.type
            });
          });
        });
      });

      await page.mouse.click(50, 60);

      expect(await page.evaluate(() => (window as unknown as { clickPromise: Promise<unknown> }).clickPromise)).toEqual({
        button: 0,
        clientX: 50,
        clientY: 60,
        detail: 1,
        isTrusted: true,
        type: "click"
      });
    });
  });

  it("dispatches dblclick with click count two", async () => {
    await withPage(async (page) => {
      await page.setContent("<div style='width: 100px; height: 100px'>Click me</div>");
      await page.evaluate(() => {
        (window as unknown as { dblclickPromise: Promise<unknown> }).dblclickPromise = new Promise((resolve) => {
          document.querySelector("div")!.addEventListener("dblclick", (event) => {
            resolve({
              button: event.button,
              clientX: event.clientX,
              clientY: event.clientY,
              detail: event.detail,
              isTrusted: event.isTrusted,
              type: event.type
            });
          });
        });
      });

      await page.mouse.dblclick(50, 60);

      expect(await page.evaluate(() => (window as unknown as { dblclickPromise: Promise<unknown> }).dblclickPromise)).toEqual({
        button: 0,
        clientX: 50,
        clientY: 60,
        detail: 2,
        isTrusted: true,
        type: "dblclick"
      });
    });
  });

  it("down and up generate a click at the current mouse position", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => {
        (window as unknown as { clickPromise: Promise<unknown> }).clickPromise = new Promise((resolve) => {
          document.addEventListener("click", (event) => {
            resolve({
              button: event.button,
              clientX: event.clientX,
              clientY: event.clientY,
              detail: event.detail,
              isTrusted: event.isTrusted,
              type: event.type
            });
          });
        });
      });

      await page.mouse.move(50, 60);
      await page.mouse.down();
      await page.mouse.up();

      expect(await page.evaluate(() => (window as unknown as { clickPromise: Promise<unknown> }).clickPromise)).toEqual({
        button: 0,
        clientX: 50,
        clientY: 60,
        detail: 1,
        isTrusted: true,
        type: "click"
      });
    });
  });

  it("reports pressed mouse buttons like Playwright", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => {
        (window as unknown as { events: unknown[] }).events = [];
        const handler = (event: MouseEvent) => {
          (window as unknown as { events: unknown[] }).events.push({
            button: event.button,
            buttons: event.buttons,
            type: event.type
          });
        };
        window.addEventListener("mousedown", handler);
        window.addEventListener("mouseup", handler);
      });

      await page.mouse.move(50, 60);
      await page.mouse.down({ button: "middle" });
      await page.mouse.down({ button: "left" });
      await page.mouse.up({ button: "middle" });
      await page.mouse.up({ button: "left" });

      expect(await page.evaluate(() => (window as unknown as { events: unknown[] }).events)).toEqual([
        { button: 1, buttons: 4, type: "mousedown" },
        { button: 0, buttons: 5, type: "mousedown" },
        { button: 1, buttons: 1, type: "mouseup" },
        { button: 0, buttons: 0, type: "mouseup" }
      ]);
    });
  });

  it("moves the mouse in the requested number of steps", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => {
        (window as unknown as { events: Array<{ x: number; y: number }> }).events = [];
        window.addEventListener("mousemove", (event) => {
          (window as unknown as { events: Array<{ x: number; y: number }> }).events.push({
            x: event.clientX,
            y: event.clientY
          });
        });
      });

      await page.mouse.move(100, 100);
      await page.mouse.move(200, 300, { steps: 5 });

      expect(await page.evaluate(() => (window as unknown as { events: Array<{ x: number; y: number }> }).events.slice(-5))).toEqual([
        { x: 120, y: 140 },
        { x: 140, y: 180 },
        { x: 160, y: 220 },
        { x: 180, y: 260 },
        { x: 200, y: 300 }
      ]);
    });
  });

  it("dispatches wheel events and scrolls vertically", async () => {
    await withPage(async (page) => {
      await page.setContent('<div style="width: 5000px; height: 5000px"></div>');
      await page.mouse.move(50, 60);
      await listenForWheelEvents(page);

      await page.mouse.wheel(0, 100);

      await page.waitForFunction("window.scrollY === 100");
      expect(await page.evaluate(() => (window as unknown as { lastWheelEvent: unknown }).lastWheelEvent)).toEqual({
        altKey: false,
        clientX: 50,
        clientY: 60,
        ctrlKey: false,
        deltaMode: 0,
        deltaX: 0,
        deltaY: 100,
        metaKey: false,
        shiftKey: false
      });
    });
  });

  it("sets keyboard modifiers on wheel events", async () => {
    await withPage(async (page) => {
      await page.setContent('<div style="width: 5000px; height: 5000px"></div>');
      await page.mouse.move(50, 60);
      await listenForWheelEvents(page);

      await page.keyboard.down("Shift");
      await page.mouse.wheel(0, 100);
      await page.keyboard.up("Shift");

      await expect.poll(() => page.evaluate(() => (window as unknown as { lastWheelEvent: unknown }).lastWheelEvent)).toMatchObject({
        shiftKey: true,
        deltaY: 100,
        clientX: 50,
        clientY: 60
      });
    });
  });

  it("dispatches wheel events and scrolls horizontally", async () => {
    await withPage(async (page) => {
      await page.setContent('<div style="width: 5000px; height: 5000px"></div>');
      await page.mouse.move(50, 60);
      await listenForWheelEvents(page);

      await page.mouse.wheel(100, 0);

      await page.waitForFunction("window.scrollX === 100");
      await expect.poll(() => page.evaluate(() => (window as unknown as { lastWheelEvent: unknown }).lastWheelEvent)).toMatchObject({
        deltaX: 100,
        deltaY: 0,
        clientX: 50,
        clientY: 60
      });
    });
  });
});

async function listenForWheelEvents(page: {
  evaluate<R, Arg>(pageFunction: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;
}): Promise<void> {
  await page.evaluate(() => {
    document.querySelector("div")!.addEventListener("wheel", (event) => {
      (window as unknown as { lastWheelEvent: unknown }).lastWheelEvent = {
        altKey: event.altKey,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        deltaMode: event.deltaMode,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey
      };
    });
  }, undefined);
}
