import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page waitForNavigation contract e2e", () => {
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

  it("returns the navigation response for cross-document navigation", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const [response] = await Promise.all([
        page.waitForNavigation(),
        page.evaluate((url) => {
          window.location.href = url;
        }, fixture.server.PREFIX + "/grid.html")
      ]);
      expect(response?.ok()).toBe(true);
      expect(response?.url()).toContain("grid.html");
    });
  });

  it("includes playwright-style timeout context", async () => {
    await withPage(async (page) => {
      const waitPromise = page
        .waitForNavigation({ url: "**/frame.html", timeout: 5000 })
        .catch((caught) => caught);
      await page.goto(fixture.server.EMPTY_PAGE);
      const error = await waitPromise;
      expect(error.message).toContain("page.waitForNavigation: Timeout 5000ms exceeded.");
      expect(error.message).toContain('waiting for navigation to "**/frame.html" until "load"');
      expect(error.message).toContain(`navigated to "${fixture.server.EMPTY_PAGE}"`);
    });
  });

  it("returns null for anchor navigations", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent("<a href='#foobar'>foobar</a>");
      const [response] = await Promise.all([
        page.waitForNavigation(),
        page.click("a")
      ]);
      expect(response).toBe(null);
      expect(page.url()).toBe(fixture.server.EMPTY_PAGE + "#foobar");
    });
  });

  it("returns null for history.pushState navigations", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent(`
        <a onclick='javascript:pushState()'>SPA</a>
        <script>
          function pushState() { history.pushState({}, '', 'wow.html') }
        </script>
      `);
      const [response] = await Promise.all([
        page.waitForNavigation(),
        page.click("a")
      ]);
      expect(response).toBe(null);
      expect(page.url()).toBe(fixture.server.PREFIX + "/wow.html");
    });
  });

  it("supports URLPattern matching", async () => {
    await withPage(async (page) => {
      const responsePromise = page.waitForNavigation({
        url: new URLPattern({ pathname: "/frame.html" })
      });
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.goto(fixture.server.PREFIX + "/frame.html");
      const response = await responsePromise;
      expect(response?.url()).toBe(fixture.server.PREFIX + "/frame.html");
    });
  });
});
