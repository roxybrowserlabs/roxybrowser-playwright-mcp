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

describe("frame.frameElement contract e2e", () => {
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
      const frame1 = await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      await attachFrame(page, "frame2", fixture.server.EMPTY_PAGE);
      const frame3 = await attachFrame(page, "frame3", fixture.server.EMPTY_PAGE);

      const frame1handle1 = await page.$("#frame1");
      const frame1handle2 = await frame1.frameElement();
      const frame3handle1 = await page.$("#frame3");
      const frame3handle2 = await frame3.frameElement();

      expect(await frame1handle1!.evaluate((a, b) => a === b, frame1handle2)).toBe(true);
      expect(await frame3handle1!.evaluate((a, b) => a === b, frame3handle2)).toBe(true);
      expect(await frame1handle1!.evaluate((a, b) => a === b, frame3handle1)).toBe(false);
    });
  });

  it("should work with contentFrame", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const frame = await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      const handle = await frame.frameElement();
      const contentFrame = await handle.contentFrame();

      expect(contentFrame).toBe(frame);
    });
  });

  it("should throw when detached", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const frame1 = await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      await page.$eval("#frame1", (element) => element.remove());
      const error = await frame1.frameElement().catch((caught) => caught as Error);

      expect(error.message).toContain("Frame has been detached.");
    });
  });

  it("should work inside closed shadow root", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent(`
        <div id="framecontainer"></div>
        <script>
          const iframe = document.createElement('iframe');
          iframe.setAttribute('name', 'myframe');
          iframe.setAttribute('srcdoc', 'find me');
          const div = document.getElementById('framecontainer');
          const host = div.attachShadow({ mode: 'closed' });
          host.appendChild(iframe);
        </script>
      `);

      const frame = page.frames()[1]!;
      const element = await frame.frameElement();
      expect(await element.getAttribute("name")).toBe("myframe");
    });
  });

  it("should work inside declarative shadow root", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent(`
        <div>
          <template shadowrootmode="open">
            <iframe name="myframe" srcdoc="<h1>Hi!</h1>"></iframe>
            <slot></slot>
          </template>
          <span>footer</span>
        </div>
      `);

      const frame = page.frames()[1]!;
      const element = await frame.frameElement();
      expect(await element.getAttribute("name")).toBe("myframe");
    });
  });
});
