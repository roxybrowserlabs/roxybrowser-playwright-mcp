import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page addScriptTag contract e2e", () => {
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
      const error = await (page.addScriptTag as unknown as (options?: unknown) => Promise<unknown>)(
        "/injectedfile.js"
      ).catch((caught) => caught);
      expect(error.message).toContain("Provide an object with a `url`, `path` or `content` property");
    });
  });

  it("works with a url like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const scriptHandle = await page.addScriptTag({ url: "/injectedfile.js" });
      expect(scriptHandle.asElement()).not.toBeNull();
      expect(await page.evaluate(() => window["__injected"])).toBe(42);
    });
  });

  it("works with a path like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const scriptHandle = await page.addScriptTag({ path: fixture.asset("injectedfile.js") });
      expect(scriptHandle.asElement()).not.toBeNull();
      expect(await page.evaluate(() => window["__injected"])).toBe(42);
    });
  });

  it("works with content like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const scriptHandle = await page.addScriptTag({ content: 'window["__injected"] = 35;' });
      expect(scriptHandle.asElement()).not.toBeNull();
      expect(await page.evaluate(() => window["__injected"])).toBe(35);
    });
  });

  it("throws when loading a script url fails like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const error = await page.addScriptTag({ url: "/nonexistfile.js" }).catch((caught) => caught);
      expect(error).toBeTruthy();
    });
  });

  it("throws a nice error when the request fails like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const url = fixture.server.PREFIX + "/this_does_not_exist.js";
      const error = await page.addScriptTag({ url }).catch((caught) => caught);
      expect(error.message).toContain(url);
    });
  });
});
