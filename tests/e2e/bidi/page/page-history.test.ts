import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { withBidiPage } from "../../../helpers/bidi.js";
import { createHistoryPageFixture } from "../../../helpers/server.js";

describe("page history e2e (bidi/firefox)", () => {
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

  it("page.goBack should work @smoke", async () => {
    await withBidiPage(async (page) => {
      expect(await page.goBack()).toBe(null);

      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      await page.goto(fixture.server.PREFIX + "/grid.html", { waitUntil: "load" });

      let response = await page.goBack();
      expect(response?.ok()).toBe(true);
      expect(response?.url()).toContain(fixture.server.EMPTY_PAGE);

      response = await page.goForward();
      expect(response?.ok()).toBe(true);
      expect(response?.url()).toContain("/grid.html");

      response = await page.goForward();
      expect(response).toBe(null);
    });
  });

  it("page.goBack should work with HistoryAPI", async () => {
    await withBidiPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      await page.evaluate(`() => {
        history.pushState({}, '', '/first.html');
        history.pushState({}, '', '/second.html');
      }`);
      expect(await page.url()).toBe(`${fixture.server.PREFIX}/second.html`);

      await page.goBack();
      expect(await page.url()).toBe(`${fixture.server.PREFIX}/first.html`);
      await page.goBack();
      expect(await page.url()).toBe(fixture.server.EMPTY_PAGE);
      await page.goForward();
      expect(await page.url()).toBe(`${fixture.server.PREFIX}/first.html`);
    });
  });

  it("page.reload should work", async () => {
    await withBidiPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      await page.evaluate(`() => {
        window._foo = 10;
      }`);
      await page.reload();
      expect(await page.evaluate("() => window._foo")).toBe(undefined);
    });
  });

  it("page.reload should work with data url", async () => {
    await withBidiPage(async (page) => {
      await page.goto("data:text/html,hello", { waitUntil: "load" });
      expect(await page.content()).toContain("hello");
      expect(await page.reload()).toBe(null);
      expect(await page.content()).toContain("hello");
    });
  });

  it("page.goBack should work for file urls", async () => {
    if (process.env.CI !== "false") {
      // Firefox BiDi is still flaky here upstream as well:
      // library/playwright/tests/bidi/expectations/moz-firefox-nightly-page.txt
      return;
    }
    await withBidiPage(async (page) => {
      const url1 = pathToFileURL(fixture.asset("consolelog.html")).href;
      const url2 = fixture.server.PREFIX + "/consolelog.html";

      await Promise.all([
        page.waitForEvent("console", (message) => message.text() === `here:${url1}`),
        page.goto(url1, { waitUntil: "load" })
      ]);
      await page.setContent(`<a href='${url2}'>url2</a>`);
      expect((await page.url()).toLowerCase()).toBe(url1.toLowerCase());

      await Promise.all([
        page.waitForEvent("console", (message) => message.text() === `here:${url2}`),
        page.click("a")
      ]);
      expect(await page.url()).toBe(url2);

      await Promise.all([
        page.waitForEvent("console", (message) => message.text() === `here:${url1}`),
        page.goBack()
      ]);
      expect((await page.url()).toLowerCase()).toBe(url1.toLowerCase());
      expect(await page.evaluate<number>("() => window.scrollX")).toBe(0);
      await page.screenshot();

      await Promise.all([
        page.waitForEvent("console", (message) => message.text() === `here:${url2}`),
        page.goForward()
      ]);
      expect(await page.url()).toBe(url2);
      expect(await page.evaluate<number>("() => window.scrollX")).toBe(0);
      await page.screenshot();
    });
  });
});
