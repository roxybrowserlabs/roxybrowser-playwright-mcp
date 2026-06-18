import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("elementHandle.boundingBox e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("should work", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 500, height: 500 });
      await page.goto(fixture.server.PREFIX + "/grid.html");
      const elementHandle = await page.$(".box:nth-of-type(13)");
      const box = await elementHandle!.boundingBox();
      expect(box).toEqual({ x: 100, y: 50, width: 50, height: 50 });
    });
  });

  it("should handle nested frames", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 616, height: 500 });
      await page.goto(fixture.server.PREFIX + "/frames/nested-frames.html");
      const nestedFrame = page.frameLocator('[name="2frames"]').frameLocator("[name=dos]");
      const elementHandle = await nestedFrame.locator("div").elementHandle();
      const box = await elementHandle.boundingBox();
      expect(box).toEqual({ x: 24, y: 224, width: 268, height: 18 });
    });
  });

  it("should get frame box", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 250, height: 250 });
      await page.setContent(`<style>
  body {
      display: flex;
      height: 500px;
      margin: 0px;
  }
  body iframe {
      flex-shrink: 1;
      border: 0;
      background-color: green;
  }
  </style>
  <iframe></iframe>
  `);
      const elementHandle = await page.$("iframe");
      const box = await elementHandle!.boundingBox();
      expect(box).toEqual({ x: 0, y: 0, width: 300, height: 500 });
    });
  });

  it("should handle scroll offset and click", async () => {
    await withPage(async (page) => {
      await page.setContent(`
    <style>* { margin: 0; padding: 0; }</style>
    <div style="width:8000px; height:8000px;">
      <div id=target style="width:20px; height:20px; margin-left:230px; margin-top:340px;"
        onclick="window.__clicked = true">
      </div>
    </div>
  `);
      const elementHandle = await page.$("#target");
      const box1 = await elementHandle!.boundingBox();
      await page.evaluate(() => window.scrollBy(200, 300));
      const box2 = await elementHandle!.boundingBox();
      expect(box1).toEqual({ x: 230, y: 340, width: 20, height: 20 });
      expect(box2).toEqual({ x: 30, y: 40, width: 20, height: 20 });
      await page.mouse.click(box2!.x + 10, box2!.y + 10);
      expect(await page.evaluate(() => (window as unknown as { __clicked?: boolean }).__clicked)).toBe(true);
    });
  });

  it("should return null for invisible elements", async () => {
    await withPage(async (page) => {
      await page.setContent('<div style="display:none">hi</div>');
      const element = await page.$("div");
      expect(await element!.boundingBox()).toBe(null);
    });
  });

  it("should force a layout", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 500, height: 500 });
      await page.setContent('<div style="width: 100px; height: 100px">hello</div>');
      const elementHandle = await page.$("div");
      await page.evaluate((element) => {
        (element as HTMLElement).style.height = "200px";
      }, elementHandle);
      const box = await elementHandle!.boundingBox();
      expect(box).toEqual({ x: 8, y: 8, width: 100, height: 200 });
    });
  });

  it("should work with SVG nodes", async () => {
    await withPage(async (page) => {
      await page.setContent(`
      <svg xmlns="http://www.w3.org/2000/svg" width="500" height="500">
        <rect id="theRect" x="30" y="50" width="200" height="300"></rect>
      </svg>
    `);
      const element = await page.$("#therect");
      const pwBoundingBox = await element!.boundingBox();
      const webBoundingBox = await page.evaluate((e) => {
        const rect = (e as Element).getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }, element);
      expect(pwBoundingBox).toEqual(webBoundingBox);
    });
  });

  it("should work when inline box child is outside of viewport", async () => {
    await withPage(async (page) => {
      await page.setContent(`
      <style>
      i {
        position: absolute;
        top: -1000px;
      }
      body {
        margin: 0;
        font-size: 12px;
      }
      </style>
      <span><i>woof</i><b>doggo</b></span>
    `);
      const handle = await page.$("span");
      const box = await handle!.boundingBox();
      const webBoundingBox = await handle!.evaluate((e) => {
        const rect = (e as Element).getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      const round = (value: NonNullable<typeof box>) => ({
        x: Math.round(value.x * 100),
        y: Math.round(value.y * 100),
        width: Math.round(value.width * 100),
        height: Math.round(value.height * 100)
      });
      expect(round(box!)).toEqual(round(webBoundingBox));
    });
  });
});
