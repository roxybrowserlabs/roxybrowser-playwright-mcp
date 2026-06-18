import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPage, type SnapshotPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";
import type { Frame } from "../../../src/types/api.js";

async function attachFrame(page: SnapshotPage, frameId: string, url: string): Promise<Frame | null> {
  const handle = await page.evaluateHandle(async ({ frameId, url }) => {
    const frame = document.createElement("iframe");
    frame.src = url;
    frame.id = frameId;
    document.body.appendChild(frame);
    await new Promise((resolve) => {
      frame.onload = resolve;
    });
    return frame;
  }, { frameId, url });
  return handle.asElement()!.contentFrame();
}

describe("elementHandle.ownerFrame e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("should work", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      const frame = page.frames()[1]!;
      const elementHandle = await frame.evaluateHandle(() => document.body);
      expect(await elementHandle.asElement()!.ownerFrame()).toBe(frame);
    });
  });

  it("should work for cross-process iframes", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await attachFrame(page, "frame1", fixture.server.CROSS_PROCESS_PREFIX + "/empty.html");
      const frame = page.frames()[1]!;
      const elementHandle = await frame.evaluateHandle(() => document.body);
      expect(await elementHandle.asElement()!.ownerFrame()).toBe(frame);
    });
  });

  it("should work for document", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      const frame = page.frames()[1]!;
      const elementHandle = await frame.evaluateHandle(() => document);
      expect(await elementHandle.asElement()!.ownerFrame()).toBe(frame);
    });
  });

  it("should work for iframe elements", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      const frame = page.mainFrame();
      const elementHandle = await frame.evaluateHandle(() => document.querySelector("#frame1"));
      expect(await elementHandle.asElement()!.ownerFrame()).toBe(frame);
    });
  });

  it("should work for cross-frame evaluations", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      const frame = page.mainFrame();
      const elementHandle = await frame.evaluateHandle(() => {
        return document.querySelector("iframe")!.contentWindow!.document.body;
      });
      expect(await elementHandle.asElement()!.ownerFrame()).toBe(frame.childFrames()[0]);
    });
  });

  it("should work for detached elements", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const divHandle = await page.evaluateHandle(() => {
        const div = document.createElement("div");
        document.body.appendChild(div);
        return div;
      });
      expect(await divHandle.asElement()!.ownerFrame()).toBe(page.mainFrame());
      await page.evaluate(() => {
        const div = document.querySelector("div")!;
        document.body.removeChild(div);
      });
      expect(await divHandle.asElement()!.ownerFrame()).toBe(page.mainFrame());
    });
  });

  it("should work for adopted elements", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate((url) => {
          (window as Window & { __popup?: Window | null }).__popup = window.open(url);
        }, fixture.server.EMPTY_PAGE)
      ]);
      const divHandle = await page.evaluateHandle(() => {
        const div = document.createElement("div");
        document.body.appendChild(div);
        return div;
      });
      expect(await divHandle.asElement()!.ownerFrame()).toBe(page.mainFrame());
      await popup.waitForLoadState("domcontentloaded");
      await page.evaluate(() => {
        const div = document.querySelector("div")!;
        (window as Window & { __popup?: Window | null }).__popup!.document.body.appendChild(div);
      });
      expect(await divHandle.asElement()!.ownerFrame()).toBe(popup.mainFrame());
    });
  });
});
