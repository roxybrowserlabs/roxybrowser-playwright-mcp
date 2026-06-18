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

describe("page screenshot contract e2e", () => {
  it("path option should create subdirectories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-screenshot-"));
    try {
      await withPage(async (page) => {
        await page.setViewportSize({ width: 300, height: 300 });
        await page.setContent("<main style=\"width: 20px; height: 10px; background: green\"></main>");
        const outputPath = join(directory, "these", "are", "directories", "screenshot.png");

        const screenshot = await page.screenshot({ path: outputPath });

        expect(await readFile(outputPath)).toEqual(screenshot);
        expect(pngSize(screenshot)).toEqual({ width: 300, height: 300 });
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("path option should throw for unsupported mime type", async () => {
    await withPage(async (page) => {
      const error = await page.screenshot({ path: "file.txt" }).catch((caught: Error) => caught);

      expect(error.message).toContain('path: unsupported mime type "text/plain"');
    });
  });

  it("quality option should throw for png", async () => {
    await withPage(async (page) => {
      const error = await page.screenshot({ quality: 10 }).catch((caught: Error) => caught);

      expect(error.message).toContain("options.quality is unsupported for the png");
    });
  });

  it("should prefer type over extension", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-screenshot-"));
    try {
      await withPage(async (page) => {
        await page.setViewportSize({ width: 300, height: 300 });
        await page.setContent("<main style=\"width: 20px; height: 10px; background: green\"></main>");

        const screenshot = await page.screenshot({ path: join(directory, "file.png"), type: "jpeg" });

        expect([screenshot[0], screenshot[1], screenshot[2]]).toEqual([0xff, 0xd8, 0xff]);
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
