import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page waitForURL contract e2e", () => {
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

  it("works for cross-document navigation", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.evaluate((url) => {
        window.location.href = url;
      }, fixture.server.PREFIX + "/grid.html");
      await page.waitForURL("**/grid.html");
    });
  });

  it("respects timeout", async () => {
    await withPage(async (page) => {
      const error = await page.waitForURL("**/frame.html", { timeout: 2500 }).catch((caught) => caught);
      expect(error.message).toContain("page.waitForURL: Timeout 2500ms exceeded.");
    });
  });

  it("supports domcontentloaded and load", async () => {
    await withPage(async (page) => {
      fixture.server.setContent(
        "/wait-for-url.html",
        '<link rel="stylesheet" href="/slow.css"><div>hello</div>',
        "text/html"
      );
      let cssResponse: { end(body?: string): void } | null = null;
      fixture.server.setRoute("/slow.css", (_request, response) => {
        cssResponse = response;
      });

      const navigationPromise = page.goto(fixture.server.PREFIX + "/wait-for-url.html");
      const domContentLoadedPromise = page.waitForURL("**/wait-for-url.html", {
        waitUntil: "domcontentloaded"
      });
      let bothResolved = false;
      const bothPromise = Promise.all([
        page.waitForURL("**/wait-for-url.html", { waitUntil: "load" }),
        domContentLoadedPromise
      ]).then(() => {
        bothResolved = true;
      });

      await fixture.server.waitForRequest("/slow.css");
      await domContentLoadedPromise;
      expect(bothResolved).toBe(false);
      cssResponse!.end("");
      await bothPromise;
      await navigationPromise;
    });
  });

  it("supports commit", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/script.js", () => {});
      fixture.server.setRoute("/empty.html", (_request, response) => {
        response.setHeader("content-type", "text/html");
        response.end('<title>Hello</title><script src="/script.js"></script>');
      });

      void page.goto(fixture.server.EMPTY_PAGE).catch(() => {});
      await page.waitForURL("**/empty.html", { waitUntil: "commit" });
      expect(await page.title()).toBe("Hello");
    });
  });

  it("supports commit and about:blank", async () => {
    await withPage(async (page) => {
      await page.waitForURL("about:blank", { waitUntil: "commit" });
    });
  });

  it("supports anchor navigations", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent("<a href='#foobar'>foobar</a>");
      await page.click("a");
      await page.waitForURL("**/*#foobar");
    });
  });

  it("supports same-document navigations and URLPattern", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent(`
        <a onclick='javascript:pushState()'>SPA</a>
        <script>
          function pushState() { history.pushState({}, '', 'wow.html') }
        </script>
      `);
      await page.click("a");
      await page.waitForURL(new URLPattern({ pathname: "/wow.html" }));
      expect(page.url()).toBe(fixture.server.PREFIX + "/wow.html");
    });
  });

  it("supports history.replaceState()", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent(`
        <a onclick='javascript:replaceState()'>SPA</a>
        <script>
          function replaceState() { history.replaceState({}, '', '/replaced.html') }
        </script>
      `);
      await page.click("a");
      await page.waitForURL("**/replaced.html");
      expect(page.url()).toBe(fixture.server.PREFIX + "/replaced.html");
    });
  });

  it("supports DOM history.back()/history.forward()", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent(`
        <a id=back onclick='javascript:goBack()'>back</a>
        <a id=forward onclick='javascript:goForward()'>forward</a>
        <script>
          function goBack() { history.back(); }
          function goForward() { history.forward(); }
          history.pushState({}, '', '/first.html');
          history.pushState({}, '', '/second.html');
        </script>
      `);
      expect(page.url()).toBe(fixture.server.PREFIX + "/second.html");

      await page.click("a#back");
      await page.waitForURL("**/first.html");
      expect(page.url()).toBe(fixture.server.PREFIX + "/first.html");

      await page.click("a#forward");
      await page.waitForURL("**/second.html");
      expect(page.url()).toBe(fixture.server.PREFIX + "/second.html");
    });
  });

  it("matches same-document navigations by URL", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      let resolved = false;
      const waitPromise = page.waitForURL(/third\.html/).then(() => {
        resolved = true;
      });
      expect(resolved).toBe(false);
      await page.evaluate(() => {
        history.pushState({}, "", "/first.html");
      });
      expect(resolved).toBe(false);
      await page.evaluate(() => {
        history.pushState({}, "", "/second.html");
      });
      expect(resolved).toBe(false);
      await page.evaluate(() => {
        history.pushState({}, "", "/third.html");
      });
      await waitPromise;
      expect(resolved).toBe(true);
    });
  });

  it("works on frame", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/frames/one-frame.html");
      const frame = page.frames()[1]!;
      await frame.evaluate((url) => {
        window.location.href = url;
      }, fixture.server.PREFIX + "/grid.html");
      await frame.waitForURL("**/grid.html");
    });
  });
});
