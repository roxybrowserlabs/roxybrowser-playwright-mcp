import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPage, type SnapshotPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";
import type { Frame } from "../../../src/types/api.js";

async function attachFrame(page: SnapshotPage, frameId: string, url: string): Promise<Frame> {
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
  return (await handle.asElement()!.contentFrame())!;
}

async function detachFrame(page: SnapshotPage, frameId: string): Promise<void> {
  await page.$eval(`#${frameId}`, (frame) => frame.remove());
}

describe("frame evaluate contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("should have different execution contexts", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);

      expect(page.frames()).toHaveLength(2);
      await page.frames()[0]!.evaluate(() => window["FOO"] = "foo");
      await page.frames()[1]!.evaluate(() => window["FOO"] = "bar");

      expect(await page.frames()[0]!.evaluate(() => window["FOO"])).toBe("foo");
      expect(await page.frames()[1]!.evaluate(() => window["FOO"])).toBe("bar");
    });
  });

  it("should have correct execution contexts", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/frames/one-frame.html");

      expect(page.frames()).toHaveLength(2);
      expect(await page.frames()[0]!.evaluate(() => document.body.textContent!.trim())).toBe("");
      expect(await page.frames()[1]!.evaluate(() => document.body.textContent!.trim())).toBe("Hi, I'm frame");
    });
  });

  it("should execute after cross-site navigation", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const mainFrame = page.mainFrame();

      expect(await mainFrame.evaluate(() => window.location.href)).toContain(fixture.server.EMPTY_PAGE);
      await page.goto(fixture.server.CROSS_PROCESS_PREFIX + "/empty.html");
      expect(await mainFrame.evaluate(() => window.location.href)).toContain(fixture.server.CROSS_PROCESS_PREFIX);
    });
  });

  it("should not allow cross-frame js handles", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/frames/one-frame.html");
      const handle = await page.evaluateHandle(() => {
        const iframe = document.querySelector("iframe")!;
        const foo = { bar: "baz" };
        iframe.contentWindow!["__foo"] = foo;
        return foo;
      });
      const childFrame = page.mainFrame().childFrames()[0]!;

      expect(await childFrame.evaluate(() => window["__foo"])).toEqual({ bar: "baz" });
      const error = await childFrame.evaluate((foo) => foo.bar, handle).catch((caught) => caught as Error);
      expect(error.message).toContain("JSHandles can be evaluated only in the context they were created!");
    });
  });

  it("should allow cross-frame element handles", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/frames/one-frame.html");
      const bodyHandle = await page.mainFrame().childFrames()[0]!.$("body");
      const result = await page.evaluate((body) => body.innerHTML, bodyHandle);

      expect(result.trim()).toBe("<div>Hi, I'm frame</div>");
    });
  });

  it("should not allow cross-frame element handles when frames do not script each other", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const frame = await attachFrame(page, "frame1", fixture.server.CROSS_PROCESS_PREFIX + "/empty.html");
      const bodyHandle = await frame.$("body");
      const error = await page.evaluate((body) => body.innerHTML, bodyHandle).catch((caught) => caught as Error);

      expect(error.message).toContain("Unable to adopt element handle from a different document");
    });
  });

  it("should throw for detached frames", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const frame1 = await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      await detachFrame(page, "frame1");

      const error = await frame1.evaluate(() => 7 * 8).catch((caught) => caught as Error);
      expect(error.message).toContain("frame.evaluate: Frame was detached");
    });
  });

  it("should be isolated between frames", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      const [frame1, frame2] = page.frames();

      expect(frame1).not.toBe(frame2);
      await Promise.all([
        frame1!.evaluate(() => window["a"] = 1),
        frame2!.evaluate(() => window["a"] = 2)
      ]);

      expect(await frame1!.evaluate(() => window["a"])).toBe(1);
      expect(await frame2!.evaluate(() => window["a"])).toBe(2);
    });
  });

  it("evaluateHandle should work", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const windowHandle = await page.mainFrame().evaluateHandle(() => window);

      expect(windowHandle).toBeTruthy();
      await windowHandle.dispose();
    });
  });
});
