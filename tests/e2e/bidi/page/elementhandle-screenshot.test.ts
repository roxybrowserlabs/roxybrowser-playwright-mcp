import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

function pngSize(buffer: Buffer): { height: number; width: number } {
  expect(buffer.subarray(1, 4).toString("ascii")).toBe("PNG");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

describe("elementHandle screenshot e2e (bidi/firefox)", () => {
  it("should capture only the element bounding box", async () => {
    await withBidiPage(async (page) => {
      await page.setViewportSize({ width: 300, height: 300 });
      await page.setContent(`
        <style>
          body { margin: 0; }
          #target {
            position: absolute;
            left: 40px;
            top: 30px;
            width: 50px;
            height: 60px;
            background: green;
          }
        </style>
        <div id="target"></div>
      `);
      const elementHandle = await page.$("#target");

      const screenshot = await elementHandle!.screenshot();

      expect(pngSize(screenshot)).toEqual({ width: 50, height: 60 });
    });
  });

  it("should use enclosing integer rect for fractional dimensions", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<div style="width:48.51px;height:19.8px;border:1px solid black;"></div>');
      const elementHandle = await page.$("div");

      const screenshot = await elementHandle!.screenshot();

      expect(pngSize(screenshot)).toEqual({ width: 51, height: 22 });
    });
  });
});
