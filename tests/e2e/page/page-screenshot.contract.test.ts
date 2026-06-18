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

function pngColorType(buffer: Buffer): number {
  expect(buffer.subarray(1, 4).toString("ascii")).toBe("PNG");
  return buffer[25]!;
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

  it("should clip rect to the viewport", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 300, height: 300 });
      await page.setContent("<main style=\"width: 800px; height: 800px; background: green\"></main>");

      const screenshot = await page.screenshot({
        clip: {
          x: 250,
          y: 250,
          width: 100,
          height: 100
        }
      });

      expect(pngSize(screenshot)).toEqual({ width: 50, height: 50 });
    });
  });

  it("should throw on clip outside the viewport", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 300, height: 300 });
      await page.setContent("<main style=\"width: 800px; height: 800px; background: green\"></main>");

      const error = await page.screenshot({
        clip: {
          x: 50,
          y: 350,
          width: 100,
          height: 100
        }
      }).catch((caught: Error) => caught);

      expect(error.message).toContain("Clipped area is either empty or outside the resulting image");
    });
  });

  it("should take fullPage screenshots using the full document size", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 300, height: 300 });
      await page.setContent("<style>body { margin: 0 }</style><main style=\"width: 420px; height: 640px; background: green\"></main>");

      const screenshot = await page.screenshot({ fullPage: true });

      expect(pngSize(screenshot)).toEqual({ width: 420, height: 640 });
    });
  });

  it("should clip rect with fullPage against the full document", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 300, height: 300 });
      await page.setContent("<style>body { margin: 0 }</style><main style=\"width: 420px; height: 640px; background: green\"></main>");
      await page.evaluate(() => window.scrollBy(100, 200));

      const screenshot = await page.screenshot({
        fullPage: true,
        clip: {
          x: 50,
          y: 100,
          width: 150,
          height: 100
        }
      });

      expect(pngSize(screenshot)).toEqual({ width: 150, height: 100 });
    });
  });

  it("should offset viewport clip by current scroll position", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 300, height: 300 });
      await page.setContent("<main style=\"width: 300px; height: 700px; background: green\"></main>");
      await page.evaluate(() => window.scrollBy(0, 200));

      const screenshot = await page.screenshot({
        clip: {
          x: 10,
          y: 20,
          width: 80,
          height: 60
        }
      });

      expect(pngSize(screenshot)).toEqual({ width: 80, height: 60 });
    });
  });

  it("style option should apply during screenshot and restore afterwards", async () => {
    await withPage(async (page) => {
      await page.setContent('<div data-test-screenshot="hide">target</div>');
      let duringScreenshot = "";

      await page.screenshot({
        style: '[data-test-screenshot="hide"] { visibility: hidden; }',
        __testHookBeforeScreenshot: async () => {
          duringScreenshot = await page.locator("div").evaluate((element) =>
            getComputedStyle(element).visibility
          );
        }
      } as never);

      const afterScreenshot = await page.locator("div").evaluate((element) =>
        getComputedStyle(element).visibility
      );
      expect(duringScreenshot).toBe("hidden");
      expect(afterScreenshot).toBe("visible");
    });
  });

  it("should hide caret by default and restore it after screenshot", async () => {
    await withPage(async (page) => {
      await page.setContent('<input style="caret-color: rgb(255, 0, 0)" value="hello">');
      let duringScreenshot = "";

      await page.screenshot({
        __testHookBeforeScreenshot: async () => {
          duringScreenshot = await page.locator("input").evaluate((element) =>
            getComputedStyle(element).caretColor
          );
        }
      } as never);

      const afterScreenshot = await page.locator("input").evaluate((element) =>
        getComputedStyle(element).caretColor
      );
      expect(duringScreenshot).toBe("rgba(0, 0, 0, 0)");
      expect(afterScreenshot).toBe("rgb(255, 0, 0)");
    });
  });

  it("caret initial should leave caret unchanged during screenshot", async () => {
    await withPage(async (page) => {
      await page.setContent('<input style="caret-color: rgb(255, 0, 0)" value="hello">');
      let duringScreenshot = "";

      await page.screenshot({
        caret: "initial",
        __testHookBeforeScreenshot: async () => {
          duringScreenshot = await page.locator("input").evaluate((element) =>
            getComputedStyle(element).caretColor
          );
        }
      } as never);

      expect(duringScreenshot).toBe("rgb(255, 0, 0)");
    });
  });

  it("animations disabled should finish finite animations during screenshot", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <style>
          #target {
            width: 10px;
            height: 10px;
            background: green;
            animation: grow 10s linear forwards;
          }
          @keyframes grow {
            from { transform: translateX(0px); }
            to { transform: translateX(200px); }
          }
        </style>
        <div id="target"></div>
      `);
      let duringScreenshot = "";

      await page.screenshot({
        animations: "disabled",
        __testHookBeforeScreenshot: async () => {
          duringScreenshot = await page.locator("#target").evaluate((element) =>
            getComputedStyle(element).transform
          );
        }
      } as never);

      expect(duringScreenshot).toContain("200");
    });
  });

  it("mask option should add overlay during screenshot and remove it afterwards", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div id="target" style="width: 40px; height: 30px; background: green"></div>
      `);
      let maskDuringScreenshot: { background: string; height: string; width: string } | null = null;

      await page.screenshot({
        mask: [page.locator("#target")],
        maskColor: "#00FF00",
        __testHookBeforeScreenshot: async () => {
          maskDuringScreenshot = await page.evaluate(() => {
            const overlay = document.querySelector("[data-roxy-screenshot-mask]") as HTMLElement | null;
            if (!overlay) {
              return null;
            }
            const style = getComputedStyle(overlay);
            return {
              background: style.backgroundColor,
              height: style.height,
              width: style.width
            };
          });
        }
      } as never);

      const maskCountAfterScreenshot = await page.evaluate(() =>
        document.querySelectorAll("[data-roxy-screenshot-mask]").length
      );
      expect(maskDuringScreenshot).toEqual({
        background: "rgb(0, 255, 0)",
        height: "30px",
        width: "40px"
      });
      expect(maskCountAfterScreenshot).toBe(0);
    });
  });

  it("mask option should ignore locators that do not resolve", async () => {
    await withPage(async (page) => {
      await page.setContent("<main>hello</main>");

      const screenshot = await page.screenshot({
        mask: [page.locator("non-existent")]
      });

      expect(screenshot).toBeInstanceOf(Buffer);
    });
  });

  it("omitBackground should allow transparency for png screenshots", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 200, height: 200 });
      await page.setContent("<style>body { margin: 0; background: transparent; }</style>");

      const screenshot = await page.screenshot({ omitBackground: true });

      expect(pngColorType(screenshot)).toBe(6);
    });
  });

  it("omitBackground should not make jpeg screenshots transparent", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 200, height: 200 });
      await page.setContent("<style>body { margin: 0; background: transparent; }</style>");

      const screenshot = await page.screenshot({ omitBackground: true, type: "jpeg" });

      expect([screenshot[0], screenshot[1], screenshot[2]]).toEqual([0xff, 0xd8, 0xff]);
    });
  });

  it("should run page screenshots sequentially", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 200, height: 200 });
      await page.setContent("<main style=\"width: 20px; height: 20px; background: green\"></main>");
      const events: string[] = [];
      let releaseFirst!: () => void;
      const firstCanFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const first = page.screenshot({
        __testHookBeforeScreenshot: async () => {
          events.push("first-before");
          await firstCanFinish;
        },
        __testHookAfterScreenshot: async () => {
          events.push("first-after");
        }
      } as never);
      await until(() => events.includes("first-before"));

      const second = page.screenshot({
        __testHookBeforeScreenshot: async () => {
          events.push("second-before");
        },
        __testHookAfterScreenshot: async () => {
          events.push("second-after");
        }
      } as never);
      await page.waitForTimeout(100);
      expect(events).toEqual(["first-before"]);

      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual(["first-before", "first-after", "second-before", "second-after"]);
    });
  });

  it("should continue screenshot queue after failure", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 200, height: 200 });
      await page.setContent("<main style=\"width: 20px; height: 20px; background: green\"></main>");
      const events: string[] = [];

      const error = await page.screenshot({
        __testHookBeforeScreenshot: async () => {
          events.push("failing-before");
          throw new Error("boom");
        }
      } as never).catch((caught: Error) => caught);
      const screenshot = await page.screenshot({
        __testHookBeforeScreenshot: async () => {
          events.push("second-before");
        }
      } as never);

      expect(error.message).toContain("boom");
      expect(screenshot).toBeInstanceOf(Buffer);
      expect(events).toEqual(["failing-before", "second-before"]);
    });
  });
});

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition.");
}
