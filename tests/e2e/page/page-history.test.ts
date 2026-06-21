import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page history e2e", () => {
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
    await withPage(async (page) => {
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
    await withPage(async (page) => {
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
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      await page.evaluate(`() => {
        window._foo = 10;
      }`);
      await page.reload();
      expect(await page.evaluate("() => window._foo")).toBe(undefined);
    });
  });

  it("page.reload should work with data url", async () => {
    await withPage(async (page) => {
      await page.goto("data:text/html,hello", { waitUntil: "load" });
      expect(await page.content()).toContain("hello");
      expect(await page.reload()).toBe(null);
      expect(await page.content()).toContain("hello");
    });
  });

  it("page.reload should not resolve with same-document navigation", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      await page.evaluate("1");

      let responseEnded = false;
      fixture.server.setRoute("/empty.html", (_request, response) => {
        setTimeout(() => {
          responseEnded = true;
          response.end("hello");
        }, 200);
      });

      const reloadPromise = page.reload();
      void page.evaluate(`() => {
        window.history.pushState({}, "");
      }`).catch(() => {});

      expect(responseEnded).toBe(false);

      const response = await reloadPromise;
      expect(response).toBeTruthy();
      expect(await response!.text()).toBe("hello");
    });
  });

  it("page.reload during renderer-initiated navigation like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/one-style.html", { waitUntil: "load" });
      await page.setContent("<form method='POST' action='/post'>Form is here<input type='submit'></form>");
      fixture.server.setRoute("/post", () => {});

      let resolveReloadFailed: (() => void) | undefined;
      const reloadFailedPromise = new Promise<void>((resolve) => {
        resolveReloadFailed = resolve;
      });
      page.once("request", async () => {
        await page.reload().catch(() => {});
        resolveReloadFailed?.();
      });
      const clickPromise = page.click("input[type=submit]").catch(() => {});
      await reloadFailedPromise;
      await clickPromise;
      await page.waitForSelector("text=hello");
    });
  });

  it("page.reload should work with same origin redirect like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      fixture.server.setRedirect("/empty.html", fixture.server.PREFIX + "/title.html");
      await page.reload();
      expect(await page.url()).toBe(fixture.server.PREFIX + "/title.html");
    });
  });

  it("page.reload should work with cross-origin redirect like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      fixture.server.setRedirect("/empty.html", fixture.server.CROSS_PROCESS_PREFIX + "/title.html");
      await page.reload();
      expect(await page.url()).toBe(fixture.server.CROSS_PROCESS_PREFIX + "/title.html");
    });
  });

  it("page.reload should work on a page with a hash like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE + "#hash", { waitUntil: "load" });
      await page.reload();
      expect(await page.url()).toBe(fixture.server.EMPTY_PAGE + "#hash");
    });
  });

  it("page.reload should work on a page with a trailing hash like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE + "#", { waitUntil: "load" });
      await page.reload();
      expect(await page.url()).toBe(fixture.server.EMPTY_PAGE + "#");
    });
  });

  it("page.goBack during renderer-initiated navigation like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/one-style.html", { waitUntil: "load" });
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      await page.setContent("<form method='POST' action='/post'>Form is here<input type='submit'></form>");
      fixture.server.setRoute("/post", () => {});

      let resolveGoBackFailed: (() => void) | undefined;
      const goBackFailedPromise = new Promise<void>((resolve) => {
        resolveGoBackFailed = resolve;
      });
      page.once("request", async () => {
        await page.goBack().catch(() => {});
        resolveGoBackFailed?.();
      });
      const clickPromise = page.click("input[type=submit]").catch(() => {});
      await goBackFailedPromise;
      await clickPromise;
      await page.waitForSelector("text=hello");
    });
  });

  it("page.goForward during renderer-initiated navigation like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      await page.goto(fixture.server.PREFIX + "/one-style.html", { waitUntil: "load" });
      await page.goBack();
      await page.setContent("<form method='POST' action='/post'>Form is here<input type='submit'></form>");
      fixture.server.setRoute("/post", () => {});

      let resolveGoForwardFailed: (() => void) | undefined;
      const goForwardFailedPromise = new Promise<void>((resolve) => {
        resolveGoForwardFailed = resolve;
      });
      page.once("request", async () => {
        await page.goForward().catch(() => {});
        resolveGoForwardFailed?.();
      });
      const clickPromise = page.click("input[type=submit]").catch(() => {});
      await goForwardFailedPromise;
      await clickPromise;
      await page.waitForSelector("text=hello");
    });
  });

  it("page.goBack should work for file urls", async () => {
    await withPage(async (page) => {
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

  it("goBack/goForward should work with bfcache-able pages like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/cached/bfcached.html", { waitUntil: "load" });
      await page.setContent(
        `<a href=${JSON.stringify(fixture.server.PREFIX + "/cached/bfcached.html?foo")}>click me</a>`
      );
      await page.click("a");

      let response = await page.goBack({ waitUntil: "commit" });
      expect(response?.url()).toBe(fixture.server.PREFIX + "/cached/bfcached.html");
      expect(await page.evaluate("window.didShow")).toEqual({ persisted: false });

      response = await page.goForward({ waitUntil: "commit" });
      expect(response?.url()).toBe(fixture.server.PREFIX + "/cached/bfcached.html?foo");
    });
  });

  it("regression test for issue 20791 like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/iframe.html", (_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`
          <!doctype html>
          <script type="text/javascript">
            console.log(window.parent.foo);
          </script>
        `);
      });
      fixture.server.setRoute("/main.html", (_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`
          <!doctype html>
          <iframe id="myframe" src="about:blank"></iframe>
          <script type="text/javascript">
            setTimeout(() => window.foo = "foo", 0);
            setTimeout(() => myframe.contentDocument.location.href = "${fixture.server.PREFIX}/iframe.html", 0);
          </script>
        `);
      });

      const messages: string[] = [];
      page.on("console", (message) => {
        messages.push(message.text());
      });

      await page.goto(fixture.server.PREFIX + "/main.html", { waitUntil: "load" });
      await expect.poll(() => [...messages]).toEqual(["foo"]);
      await page.reload();
      await expect.poll(() => [...messages]).toEqual(["foo", "foo"]);
    });
  });

  it("should reload proper page like Playwright", async () => {
    await withPage(async (page) => {
      let mainRequest = 0;
      let popupRequest = 0;

      fixture.server.setRoute("/main.html", (_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><h1>main: ${++mainRequest}</h1>`);
      });
      fixture.server.setRoute("/popup.html", (_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><h1>popup: ${++popupRequest}</h1>`);
      });

      await page.goto(fixture.server.PREFIX + "/main.html", { waitUntil: "load" });
      const popupPromise = page.waitForEvent("popup");
      await page.evaluate(() => {
        window.open("/popup.html");
      });
      const popup = await popupPromise;

      await expect(page.locator("h1")).toHaveText("main: 1");
      await expect(popup.locator("h1")).toHaveText("popup: 1");

      await page.reload();
      await expect(page.locator("h1")).toHaveText("main: 2");
      await expect(popup.locator("h1")).toHaveText("popup: 1");

      await popup.reload();
      await expect(page.locator("h1")).toHaveText("main: 2");
      await expect(popup.locator("h1")).toHaveText("popup: 2");
    });
  });
});
