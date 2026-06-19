import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPage, type SnapshotPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";
import type { Frame } from "../../../src/types/api.js";

function dumpFrames(frame: Frame, indentation = ""): string[] {
  let description = frame.url();
  if (frame.name()) {
    description += ` (${frame.name()})`;
  }
  const result = [indentation + description];
  const childFrames = frame.childFrames();
  childFrames.sort((a, b) => {
    if (a.url() !== b.url()) {
      return a.url() < b.url() ? -1 : 1;
    }
    return a.name() < b.name() ? -1 : 1;
  });
  for (const child of childFrames) {
    result.push(...dumpFrames(child, `    ${indentation}`));
  }
  return result;
}

async function attachFrame(page: SnapshotPage, frameId: string, url: string): Promise<Frame> {
  await page.evaluate(async ({ frameId, url }) => {
    const frame = document.createElement("iframe");
    frame.src = url;
    frame.id = frameId;
    document.body.appendChild(frame);
    await new Promise((resolve) => {
      frame.onload = resolve;
    });
  }, { frameId, url });
  await expect.poll(() => page.frames().find((frame) => frame.name() === frameId)?.url()).toBe(url);
  return page.frames().find((frame) => frame.name() === frameId)!;
}

async function detachFrame(page: SnapshotPage, frameId: string): Promise<void> {
  const frame = page.frames().find((candidate) => candidate.name() === frameId);
  await page.$eval(`#${frameId}`, (frame) => frame.remove());
  if (frame) {
    await expect.poll(() => frame.isDetached()).toBe(true);
  }
}

describe("frame hierarchy contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("should handle nested frames", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/frames/nested-frames.html");

      expect(dumpFrames(page.mainFrame())).toEqual([
        `${fixture.server.PREFIX}/frames/nested-frames.html`,
        `    ${fixture.server.PREFIX}/frames/frame.html (aframe)`,
        `    ${fixture.server.PREFIX}/frames/two-frames.html (2frames)`,
        `        ${fixture.server.PREFIX}/frames/frame.html (dos)`,
        `        ${fixture.server.PREFIX}/frames/frame.html (uno)`
      ]);
    });
  });

  it("should send events when frames are manipulated dynamically", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const attachedFrames: Frame[] = [];
      page.on("frameattached", (frame) => attachedFrames.push(frame));
      await attachFrame(page, "frame1", fixture.server.PREFIX + "/frames/frame.html");
      await expect.poll(() => attachedFrames.length).toBe(1);
      expect(attachedFrames[0]!.url()).toContain("/frames/frame.html");

      const navigatedFrames: Frame[] = [];
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) {
          navigatedFrames.push(frame);
        }
      });
      await page.evaluate((url) => {
        const frame = document.getElementById("frame1") as HTMLIFrameElement;
        frame.src = url;
        return new Promise((resolve) => {
          frame.onload = resolve;
        });
      }, fixture.server.EMPTY_PAGE);
      await expect.poll(() => navigatedFrames.some((frame) => frame.url() === fixture.server.EMPTY_PAGE)).toBe(true);

      const detachedFrames: Frame[] = [];
      page.on("framedetached", (frame) => detachedFrames.push(frame));
      await detachFrame(page, "frame1");
      await expect.poll(() => detachedFrames.length).toBe(1);
      expect(detachedFrames[0]!.isDetached()).toBe(true);
    });
  });

  it("should send framenavigated when navigating on anchor URLs", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const navigatedFrames: Frame[] = [];
      page.on("framenavigated", (frame) => navigatedFrames.push(frame));
      await page.goto(fixture.server.EMPTY_PAGE + "#foo");
      await expect.poll(() => navigatedFrames.some((frame) => frame.url() === fixture.server.EMPTY_PAGE + "#foo")).toBe(true);
      expect(page.url()).toBe(fixture.server.EMPTY_PAGE + "#foo");
    });
  });

  it("should persist mainFrame on cross-process navigation", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const mainFrame = page.mainFrame();
      await page.goto(fixture.server.CROSS_PROCESS_PREFIX + "/empty.html");
      expect(page.mainFrame()).toBe(mainFrame);
    });
  });

  it("should not send attach/detach events for main frame", async () => {
    await withPage(async (page) => {
      let hasEvents = false;
      page.on("frameattached", () => hasEvents = true);
      page.on("framedetached", () => hasEvents = true);
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(hasEvents).toBe(false);
    });
  });

  it("should report frame.name()", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await attachFrame(page, "theFrameId", fixture.server.EMPTY_PAGE);
      await page.evaluate((url) => {
        const frame = document.createElement("iframe");
        frame.name = "theFrameName";
        frame.src = url;
        document.body.appendChild(frame);
        return new Promise((resolve) => {
          frame.onload = resolve;
        });
      }, fixture.server.EMPTY_PAGE);
      await expect.poll(() => page.frames().length).toBe(3);

      expect(page.frames()[0]!.name()).toBe("");
      expect(page.frames()[1]!.name()).toBe("theFrameId");
      expect(page.frames()[2]!.name()).toBe("theFrameName");
    });
  });

  it("should report frame.parentFrame()", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      await attachFrame(page, "frame2", fixture.server.EMPTY_PAGE);

      expect(page.frames()[0]!.parentFrame()).toBe(null);
      expect(page.frames()[1]!.parentFrame()).toBe(page.mainFrame());
      expect(page.frames()[2]!.parentFrame()).toBe(page.mainFrame());
    });
  });

  it("should report different frame instance when frame re-attaches", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const frame1 = await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      await page.evaluate(() => {
        window["frame"] = document.querySelector("#frame1");
        window["frame"].remove();
      });
      await expect.poll(() => frame1.isDetached()).toBe(true);
      expect(frame1.isDetached()).toBe(true);

      await page.evaluate(() => document.body.appendChild(window["frame"]));
      await expect.poll(() => page.frames().find((frame) => frame.name() === "frame1" && frame !== frame1)?.isDetached()).toBe(false);
      const frame2 = page.frames().find((frame) => frame.name() === "frame1" && frame !== frame1)!;
      expect(frame2.isDetached()).toBe(false);
      expect(frame1).not.toBe(frame2);
    });
  });

  it("should return frame.page()", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/frames/one-frame.html");
      expect(page.mainFrame().page()).toBe(page);
      expect(page.mainFrame().childFrames()[0]!.page()).toBe(page);
    });
  });
});
