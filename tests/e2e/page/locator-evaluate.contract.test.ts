import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("locator evaluate contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  beforeEach(() => {
    fixture.server.reset();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("evaluates matching element", async () => {
    await withPage(async (page) => {
      await page.setContent('<html><body><div class="tweet"><div class="like">100</div><div class="retweets">10</div></div></body></html>');
      const tweet = page.locator(".tweet .like");

      const content = await tweet.evaluate((node) => (node as HTMLElement).innerText);

      expect(content).toBe("100");
    });
  });

  it("evaluates all matching elements", async () => {
    await withPage(async (page) => {
      await page.setContent('<html><body><div class="tweet"><div class="like">100</div><div class="like">10</div></div></body></html>');
      const tweet = page.locator(".tweet .like");

      const content = await tweet.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).innerText));

      expect(content).toEqual(["100", "10"]);
    });
  });

  it("does not throw for evaluateAll with missing selector", async () => {
    await withPage(async (page) => {
      await page.setContent('<div class="a">not-a-child-div</div><div id="myId"></div>');
      const element = page.locator("#myId .a");

      const nodesLength = await element.evaluateAll((nodes) => nodes.length);

      expect(nodesLength).toBe(0);
    });
  });
});
