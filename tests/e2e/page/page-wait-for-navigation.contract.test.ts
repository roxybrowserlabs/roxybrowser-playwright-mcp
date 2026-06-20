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

  it("supports both domcontentloaded and load", async () => {
    await withPage(async (page) => {
      let cssResponse: { end(body?: string): void } | null = null;
      fixture.server.setRoute("/one-style.css", (_request, response) => {
        cssResponse = response;
      });

      const navigationPromise = page.goto(fixture.server.PREFIX + "/one-style.html");
      const domContentLoadedPromise = page.waitForNavigation({
        waitUntil: "domcontentloaded"
      });

      let bothResolved = false;
      const bothPromise = Promise.all([
        page.waitForNavigation({ waitUntil: "load" }),
        domContentLoadedPromise
      ]).then(() => {
        bothResolved = true;
      });

      await fixture.server.waitForRequest("/one-style.css");
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
      await page.waitForNavigation({ waitUntil: "commit" });
      expect(await page.title()).toBe("Hello");
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

  it("returns null for history.replaceState navigations", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent(`
        <a onclick='javascript:replaceState()'>SPA</a>
        <script>
          function replaceState() { history.replaceState({}, '', '/replaced.html') }
        </script>
      `);
      const [response] = await Promise.all([
        page.waitForNavigation(),
        page.click("a")
      ]);
      expect(response).toBe(null);
      expect(page.url()).toBe(fixture.server.PREFIX + "/replaced.html");
    });
  });

  it("returns null for DOM history.back()/history.forward() navigations", async () => {
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

      const [backResponse] = await Promise.all([
        page.waitForNavigation(),
        page.click("a#back")
      ]);
      expect(backResponse).toBe(null);
      expect(page.url()).toBe(fixture.server.PREFIX + "/first.html");

      const [forwardResponse] = await Promise.all([
        page.waitForNavigation(),
        page.click("a#forward")
      ]);
      expect(forwardResponse).toBe(null);
      expect(page.url()).toBe(fixture.server.PREFIX + "/second.html");
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

  it("matches the requested URL before resolving", async () => {
    await withPage(async (page) => {
      let response1 = null;
      const response1Promise = page
        .waitForNavigation({ url: /one-style\.html/ })
        .then((response) => {
          response1 = response;
        });
      let response2 = null;
      const response2Promise = page
        .waitForNavigation({ url: /\/frame.html/ })
        .then((response) => {
          response2 = response;
        });
      let response3 = null;
      const response3Promise = page
        .waitForNavigation({ url: (url) => url.searchParams.get("foo") === "bar" })
        .then((response) => {
          response3 = response;
        });

      expect(response1).toBe(null);
      expect(response2).toBe(null);
      expect(response3).toBe(null);
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(response1).toBe(null);
      expect(response2).toBe(null);
      expect(response3).toBe(null);
      await page.goto(fixture.server.PREFIX + "/frame.html");
      expect(response1).toBe(null);
      await response2Promise;
      expect(response2).not.toBe(null);
      expect(response3).toBe(null);
      await page.goto(fixture.server.PREFIX + "/one-style.html");
      await response1Promise;
      expect(response1).not.toBe(null);
      expect(response2).not.toBe(null);
      expect(response3).toBe(null);
      await page.goto(fixture.server.PREFIX + "/frame.html?foo=bar");
      await response3Promise;
      expect(response1).not.toBe(null);
      expect(response2).not.toBe(null);
      expect(response3).not.toBe(null);
      await page.goto(fixture.server.PREFIX + "/empty.html");
      expect(response1!.url()).toBe(fixture.server.PREFIX + "/one-style.html");
      expect(response2!.url()).toBe(fixture.server.PREFIX + "/frame.html");
      expect(response3!.url()).toBe(fixture.server.PREFIX + "/frame.html?foo=bar");
    });
  });

  it("matches same-document navigations by URL", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      let resolved = false;
      const waitPromise = page.waitForNavigation({ url: /third\.html/ }).then(() => {
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

  it("supports cross-process navigations", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const waitPromise = page.waitForNavigation({ waitUntil: "domcontentloaded" });
      const url = fixture.server.CROSS_PROCESS_PREFIX + "/empty.html";
      const gotoPromise = page.goto(url);
      const response = await waitPromise;
      expect(response?.url()).toBe(url);
      expect(page.url()).toBe(url);
      expect(await page.evaluate("document.location.href")).toBe(url);
      await gotoPromise;
    });
  });

  it("should not leak listeners during 20 waitForNavigation calls like Playwright", async () => {
    await withPage(async (page) => {
      let warning: unknown = null;
      const warningHandler = (value: unknown) => {
        warning = value;
      };

      process.on("warning", warningHandler);
      try {
        const promises = Array.from({ length: 20 }, () => page.waitForNavigation());
        await page.goto(fixture.server.EMPTY_PAGE);
        await Promise.all(promises);
      } finally {
        process.off("warning", warningHandler);
      }

      expect(warning).toBe(null);
    });
  });

  it("works on frame", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/frames/one-frame.html");
      const frame = page.frames()[1]!;
      const [response] = await Promise.all([
        frame.waitForNavigation(),
        frame.evaluate((url) => {
          window.location.href = url;
        }, fixture.server.PREFIX + "/grid.html")
      ]);
      expect(response?.ok()).toBe(true);
      expect(response?.url()).toContain("grid.html");
      expect(response?.frame()).toBe(frame);
      expect(page.url()).toContain("/frames/one-frame.html");
    });
  });
});
