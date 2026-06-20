import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page addStyleTag contract e2e", () => {
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

  it("throws when no options are provided like Playwright", async () => {
    await withPage(async (page) => {
      const error = await (page.addStyleTag as unknown as (options?: unknown) => Promise<unknown>)(
        "/injectedstyle.css"
      ).catch((caught) => caught);
      expect(error.message).toContain("Provide an object with a `url`, `path` or `content` property");
    });
  });

  it("works with a url like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const styleHandle = await page.addStyleTag({ url: "/injectedstyle.css" });
      expect(styleHandle.asElement()).not.toBeNull();
      expect(await page.evaluate(() =>
        window.getComputedStyle(document.querySelector("body")!).getPropertyValue("background-color")
      )).toBe("rgb(255, 0, 0)");
    });
  });

  it("works with a path like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const styleHandle = await page.addStyleTag({ path: fixture.asset("injectedstyle.css") });
      expect(styleHandle.asElement()).not.toBeNull();
      expect(await page.evaluate(() =>
        window.getComputedStyle(document.querySelector("body")!).getPropertyValue("background-color")
      )).toBe("rgb(255, 0, 0)");
    });
  });

  it("works with content like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const styleHandle = await page.addStyleTag({ content: "body { background-color: green; }" });
      expect(styleHandle.asElement()).not.toBeNull();
      expect(await page.evaluate(() =>
        window.getComputedStyle(document.querySelector("body")!).getPropertyValue("background-color")
      )).toBe("rgb(0, 128, 0)");
    });
  });

  it("throws when loading a style url fails like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const error = await page.addStyleTag({ url: "/nonexistfile.js" }).catch((caught) => caught);
      expect(error).toBeTruthy();
    });
  });
});
