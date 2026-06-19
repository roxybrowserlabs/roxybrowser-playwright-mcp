import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import type { Frame } from "../../../src/types/api.js";
import { withPage, type SnapshotPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

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

describe("frame goto contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("should navigate subframes", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/frames/one-frame.html");
      expect(page.frames()[0]!.url()).toContain("/frames/one-frame.html");
      expect(page.frames()[1]!.url()).toContain("/frames/frame.html");

      const frame = page.frames()[1]!;
      const response = await frame.goto(fixture.server.EMPTY_PAGE);
      expect(response?.ok()).toBe(true);
      expect(response?.frame()).toBe(frame);
    });
  });

  it("should reject when frame detaches", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/frames/one-frame.html");

      fixture.server.setRoute("/one-style.css", () => {});
      const navigationPromise = page.frames()[1]!
        .goto(fixture.server.PREFIX + "/one-style.html")
        .catch((error: Error) => error);
      await fixture.server.waitForRequest("/one-style.css");

      await page.$eval("iframe", (frame) => frame.remove());
      const error = await navigationPromise;
      expect(error.message.toLowerCase()).toContain("frame was detached");
    });
  });

  it("should continue after client redirect", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/frames/script.js", () => {});
      const url = fixture.server.PREFIX + "/frames/child-redirect.html";
      const error = await page
        .goto(url, { timeout: 5000, waitUntil: "networkidle" })
        .catch((caught: Error) => caught);

      expect(error.message).toContain("page.goto: Timeout 5000ms exceeded.");
      expect(error.message).toContain(`navigating to "${url}", waiting until "networkidle"`);
    });
  });

  it("should return matching responses", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const frames = [
        await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE),
        await attachFrame(page, "frame2", fixture.server.EMPTY_PAGE),
        await attachFrame(page, "frame3", fixture.server.EMPTY_PAGE)
      ];
      const serverResponses: ServerResponse[] = [];
      fixture.server.setRoute("/0.html", (_request, response) => serverResponses.push(response));
      fixture.server.setRoute("/1.html", (_request, response) => serverResponses.push(response));
      fixture.server.setRoute("/2.html", (_request, response) => serverResponses.push(response));

      const navigations: Array<Promise<Awaited<ReturnType<Frame["goto"]>>>> = [];
      for (let i = 0; i < 3; ++i) {
        navigations.push(frames[i]!.goto(fixture.server.PREFIX + `/${i}.html`));
        await fixture.server.waitForRequest(`/${i}.html`);
      }

      const serverResponseTexts = ["AAA", "BBB", "CCC"];
      for (const i of [1, 2, 0]) {
        serverResponses[i]!.end(serverResponseTexts[i]);
        const response = await navigations[i]!;
        expect(response?.frame()).toBe(frames[i]);
        expect(await response?.text()).toBe(serverResponseTexts[i]);
      }
    });
  });
});
