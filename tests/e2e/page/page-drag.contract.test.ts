import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page drag contract e2e", () => {
  it("dragAndDrop uses tweened mouse movement like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <body style="margin: 0; padding: 0;">
          <div style="width:100px;height:100px;background:red;" id="red"></div>
          <div style="width:300px;height:100px;background:blue;" id="blue"></div>
        </body>
      `);
      await page.evaluate(() => {
        (window as unknown as { events: Array<{ type: string; x: number; y: number }> }).events = [];
        document.addEventListener("mousedown", (event) => {
          (window as unknown as { events: Array<{ type: string; x: number; y: number }> }).events.push({
            type: "mousedown",
            x: event.pageX,
            y: event.pageY
          });
        });
        document.addEventListener("mouseup", (event) => {
          (window as unknown as { events: Array<{ type: string; x: number; y: number }> }).events.push({
            type: "mouseup",
            x: event.pageX,
            y: event.pageY
          });
        });
        document.addEventListener("mousemove", (event) => {
          (window as unknown as { events: Array<{ type: string; x: number; y: number }> }).events.push({
            type: "mousemove",
            x: event.pageX,
            y: event.pageY
          });
        });
      });

      await page.dragAndDrop("#red", "#blue", { steps: 4 });

      expect(await page.evaluate(() => (window as unknown as { events: Array<{ type: string; x: number; y: number }> }).events)).toEqual([
        { type: "mousemove", x: 50, y: 50 },
        { type: "mousedown", x: 50, y: 50 },
        { type: "mousemove", x: 75, y: 75 },
        { type: "mousemove", x: 100, y: 100 },
        { type: "mousemove", x: 125, y: 125 },
        { type: "mousemove", x: 150, y: 150 },
        { type: "mouseup", x: 150, y: 150 }
      ]);
    });
  });

  it("dragAndDrop allows specifying source and target positions", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div style="width:100px;height:100px;background:red;" id="red"></div>
        <div style="width:100px;height:100px;background:blue;" id="blue"></div>
      `);
      await page.evaluate(() => {
        (window as unknown as { events: Array<{ type: string; x: number; y: number }> }).events = [];
        document.getElementById("red")!.addEventListener("mousedown", (event) => {
          (window as unknown as { events: Array<{ type: string; x: number; y: number }> }).events.push({
            type: "mousedown",
            x: event.offsetX,
            y: event.offsetY
          });
        });
        document.getElementById("blue")!.addEventListener("mouseup", (event) => {
          (window as unknown as { events: Array<{ type: string; x: number; y: number }> }).events.push({
            type: "mouseup",
            x: event.offsetX,
            y: event.offsetY
          });
        });
      });

      await page.dragAndDrop("#red", "#blue", {
        sourcePosition: { x: 34, y: 7 },
        targetPosition: { x: 10, y: 20 }
      });

      expect(await page.evaluate(() => (window as unknown as { events: Array<{ type: string; x: number; y: number }> }).events)).toEqual([
        { type: "mousedown", x: 34, y: 7 },
        { type: "mouseup", x: 10, y: 20 }
      ]);
    });
  });
});
