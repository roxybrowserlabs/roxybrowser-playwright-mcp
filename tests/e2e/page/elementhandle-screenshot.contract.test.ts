import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

function pngSize(buffer: Buffer): { height: number; width: number } {
  expect(buffer.subarray(1, 4).toString("ascii")).toBe("PNG");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

describe("elementHandle screenshot contract e2e", () => {
  it("should capture only the element bounding box", async () => {
    await withPage(async (page) => {
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

  it("should fail to screenshot a detached element", async () => {
    await withPage(async (page) => {
      await page.setContent("<h1>remove this</h1>");
      const elementHandle = await page.$("h1");
      await page.evaluate((element) => element!.remove(), elementHandle);

      const error = await elementHandle!.screenshot().catch((caught: Error) => caught);

      expect(error.message).toContain("Element is not attached to the DOM");
    });
  });

  it("path option should create subdirectories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roxy-element-screenshot-"));
    try {
      await withPage(async (page) => {
        await page.setContent('<div style="width: 20px; height: 10px; background: green"></div>');
        const elementHandle = await page.$("div");
        const outputPath = join(directory, "these", "are", "directories", "screenshot.png");

        const screenshot = await elementHandle!.screenshot({ path: outputPath });

        expect(await readFile(outputPath)).toEqual(screenshot);
        expect(pngSize(screenshot)).toEqual({ width: 20, height: 10 });
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("should prefer type over extension", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roxy-element-screenshot-"));
    try {
      await withPage(async (page) => {
        await page.setContent('<div style="width: 20px; height: 10px; background: green"></div>');
        const elementHandle = await page.$("div");

        const screenshot = await elementHandle!.screenshot({ path: join(directory, "file.png"), type: "jpeg" });

        expect([screenshot[0], screenshot[1], screenshot[2]]).toEqual([0xff, 0xd8, 0xff]);
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("should timeout waiting for visible", async () => {
    await withPage(async (page) => {
      await page.setContent('<div style="width: 50px; height: 0"></div>');
      const div = await page.$("div");

      const error = await div!.screenshot({ timeout: 300 }).catch((caught: Error) => caught);

      expect(error.message).toContain("elementHandle.screenshot: Timeout 300ms exceeded");
      expect(error.message).toContain("element is not visible");
    });
  });

  it("should take screenshot of disabled button", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 500, height: 500 });
      await page.setContent("<button disabled>Click me</button>");
      const button = await page.$("button");

      const screenshot = await button!.screenshot();

      expect(screenshot).toBeInstanceOf(Buffer);
    });
  });
});
