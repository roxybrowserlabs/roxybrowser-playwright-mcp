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

describe("elementHandle.contentFrame e2e", () => {
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
      const elementHandle = await page.$("#frame1");
      const frame = await elementHandle!.contentFrame();
      expect(frame).toBe(page.frames()[1]);
    });
  });

  it("should work for cross-process iframes", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await attachFrame(page, "frame1", fixture.server.CROSS_PROCESS_PREFIX + "/empty.html");
      const elementHandle = await page.$("#frame1");
      const frame = await elementHandle!.contentFrame();
      expect(frame).toBe(page.frames()[1]);
    });
  });

  it("should work for cross-frame evaluations", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      const frame = page.frames()[1]!;
      const elementHandle = await frame.evaluateHandle(() => window.top!.document.querySelector("#frame1"));
      expect(await elementHandle.asElement()!.contentFrame()).toBe(frame);
    });
  });

  it("should return null for non-iframes", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      const frame = page.frames()[1]!;
      const elementHandle = await frame.evaluateHandle(() => document.body);
      expect(await elementHandle.asElement()!.contentFrame()).toBe(null);
    });
  });

  it("should return null for document.documentElement", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      const frame = page.frames()[1]!;
      const elementHandle = await frame.evaluateHandle(() => document.documentElement);
      expect(await elementHandle.asElement()!.contentFrame()).toBe(null);
    });
  });
});
