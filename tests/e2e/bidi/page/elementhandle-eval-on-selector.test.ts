import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("elementHandle eval on selector e2e (bidi/firefox)", () => {
  it("should work", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<html><body><div class="tweet"><div class="like">100</div><div class="retweets">10</div></div></body></html>');
      const tweet = await page.$(".tweet");
      const content = await tweet!.$eval(".like", (node) => (node as HTMLElement).innerText);
      expect(content).toBe("100");
    });
  });

  it("should retrieve content from subtree", async () => {
    await withBidiPage(async (page) => {
      const htmlContent = '<div class="a">not-a-child-div</div><div id="myId"><div class="a">a-child-div</div></div>';
      await page.setContent(htmlContent);
      const elementHandle = await page.$("#myId");
      const content = await elementHandle!.$eval(".a", (node) => (node as HTMLElement).innerText);
      expect(content).toBe("a-child-div");
    });
  });

  it("should throw in case of missing selector", async () => {
    await withBidiPage(async (page) => {
      const htmlContent = '<div class="a">not-a-child-div</div><div id="myId"></div>';
      await page.setContent(htmlContent);
      const elementHandle = await page.$("#myId");
      const errorMessage = await elementHandle!.$eval(".a", (node) => {
        return (node as HTMLElement).innerText;
      }).catch((error: Error) => error.message);
      expect(errorMessage).toContain('elementHandle.$eval: Failed to find element matching selector ".a"');
    });
  });

  it("should work for all", async () => {
    await withBidiPage(async (page) => {
      await page.setContent('<html><body><div class="tweet"><div class="like">100</div><div class="like">10</div></div></body></html>');
      const tweet = await page.$(".tweet");
      const content = await tweet!.$$eval(".like", (nodes) => {
        return nodes.map((node) => (node as HTMLElement).innerText);
      });
      expect(content).toEqual(["100", "10"]);
    });
  });

  it("should retrieve content from subtree for all", async () => {
    await withBidiPage(async (page) => {
      const htmlContent = '<div class="a">not-a-child-div</div><div id="myId"><div class="a">a1-child-div</div><div class="a">a2-child-div</div></div>';
      await page.setContent(htmlContent);
      const elementHandle = await page.$("#myId");
      const content = await elementHandle!.$$eval(".a", (nodes) => {
        return nodes.map((node) => (node as HTMLElement).innerText);
      });
      expect(content).toEqual(["a1-child-div", "a2-child-div"]);
    });
  });

  it("should not throw in case of missing selector for all", async () => {
    await withBidiPage(async (page) => {
      const htmlContent = '<div class="a">not-a-child-div</div><div id="myId"></div>';
      await page.setContent(htmlContent);
      const elementHandle = await page.$("#myId");
      const nodesLength = await elementHandle!.$$eval(".a", (nodes) => nodes.length);
      expect(nodesLength).toBe(0);
    });
  });
});
