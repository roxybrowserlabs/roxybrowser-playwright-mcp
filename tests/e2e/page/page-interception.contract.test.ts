import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";
import { globToRegexPattern, urlMatches } from "../../../src/urlMatch.js";

describe("page interception contract e2e", () => {
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

  it("matches Playwright glob semantics", () => {
    const globToRegex = (glob: string): RegExp => new RegExp(globToRegexPattern(glob));

    expect(globToRegex("**/*.js").test("https://localhost:8080/foo.js")).toBe(true);
    expect(globToRegex("**/*.css").test("https://localhost:8080/foo.js")).toBe(false);
    expect(globToRegex("*.js").test("https://localhost:8080/foo.js")).toBe(false);
    expect(globToRegex("https://**/*.js").test("https://localhost:8080/foo.js")).toBe(true);
    expect(globToRegex("**/{a,b}.js").test("https://localhost:8080/a.js")).toBe(true);
    expect(globToRegex("**/{a,b}.js").test("https://localhost:8080/b.js")).toBe(true);
    expect(globToRegex("**/{a,b}.js").test("https://localhost:8080/c.js")).toBe(false);
    expect(globToRegex("**/*.{png,jpg,jpeg}").test("https://localhost:8080/c.jpg")).toBe(true);
    expect(globToRegex("foo*").test("foo.js")).toBe(true);
    expect(globToRegex("foo*").test("foo/bar.js")).toBe(false);
    expect(globToRegex("**/api\\?param").test("http://example.com/api?param")).toBe(true);
    expect(globToRegex("**/api\\?param").test("http://example.com/api-param")).toBe(false);

    expect(urlMatches(undefined, "http://playwright.dev/", "http://playwright.dev")).toBe(true);
    expect(urlMatches(undefined, "http://playwright.dev/?a=b", "http://playwright.dev?a=b")).toBe(true);
    expect(urlMatches(undefined, "http://playwright.dev/", "h*://playwright.dev")).toBe(true);
    expect(urlMatches(undefined, "http://api.playwright.dev/?x=y", "http://*.playwright.dev?x=y")).toBe(true);
    expect(urlMatches(undefined, "http://playwright.dev/foo/bar", "**/foo/**")).toBe(true);
    expect(urlMatches("http://playwright.dev", "http://playwright.dev/?x=y", "?x=y")).toBe(true);
    expect(urlMatches("http://playwright.dev/foo/", "http://playwright.dev/foo/bar?x=y", "./bar?x=y")).toBe(true);
    expect(urlMatches(undefined, "https://playwright.dev/foobar", "https://playwright.dev/fooBAR")).toBe(false);
    expect(urlMatches(undefined, "https://localhost:3000/?a=b", "**/?a=b")).toBe(true);
    expect(urlMatches(undefined, "https://localhost:3000/?a=b", "**?a=b")).toBe(true);
    expect(urlMatches(undefined, "my.custom.protocol://foo", "my.custom.protocol://**")).toBe(true);
    expect(urlMatches(undefined, "file:///foo/", "f*e://**")).toBe(true);
  });

  it("throws on unbalanced glob braces", () => {
    expect(() => globToRegexPattern("{foo")).toThrow(`Invalid glob pattern "{foo": unmatched '{'`);
    expect(() => globToRegexPattern("}foo")).toThrow(`Invalid glob pattern "}foo": unmatched '}'`);
    expect(() => globToRegexPattern("http://*/foo{")).toThrow("unmatched '{'");
    expect(() => globToRegexPattern("**/*.png?{")).toThrow("unmatched '{'");
    expect(() => globToRegexPattern("https://example.com/{a")).toThrow("unmatched '{'");
    expect(() => globToRegexPattern("{{foo}")).toThrow("nested '{' is not supported");
    expect(() => globToRegexPattern("\\{foo")).not.toThrow();
    expect(() => globToRegexPattern("foo\\}")).not.toThrow();
  });

  it("throws on page.route with invalid glob", async () => {
    await withPage(async (page) => {
      await expect(page.route("http://*/foo{", (route) => route.continue())).rejects.toThrow(
        "unmatched '{'"
      );
    });
  });

  it("marks navigation requests like Playwright", async () => {
    await withPage(async (page) => {
      const requests = new Map<string, any>();
      await page.route("**/*", (route) => {
        requests.set(route.request().url().split("/").pop() ?? "", route.request());
        void route.continue();
      });

      fixture.server.setRedirect("/rrredirect", "/frames/one-frame.html");
      await page.goto(fixture.server.PREFIX + "/rrredirect", { waitUntil: "load" });

      expect(requests.get("rrredirect").isNavigationRequest()).toBe(true);
      expect(requests.get("frame.html").isNavigationRequest()).toBe(true);
      expect(requests.get("script.js").isNavigationRequest()).toBe(false);
      expect(requests.get("style.css").isNavigationRequest()).toBe(false);
    });
  });

  it("intercepts by glob", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      await page.route("http://localhos**?*oo", async (route) => {
        await route.fulfill({
          status: 200,
          body: "intercepted"
        });
      });

      const result = await page.evaluate(
        (url) => fetch(url).then((response) => response.text()),
        fixture.server.PREFIX + "/?foo"
      );
      expect(result).toBe("intercepted");
    });
  });

  it("intercepts route requests like Playwright smoke", async () => {
    await withPage(async (page) => {
      let intercepted = false;
      await page.route("**/empty.html", (route, request) => {
        expect(route.request()).toBe(request);
        expect(request.url()).toContain("empty.html");
        expect(request.headers()["user-agent"]).toBeTruthy();
        expect(request.method()).toBe("GET");
        expect(request.postData()).toBe(null);
        expect(request.isNavigationRequest()).toBe(true);
        expect(request.resourceType()).toBe("document");
        expect(request.frame() === page.mainFrame()).toBe(true);
        expect(request.frame().url()).toBe("about:blank");
        void route.continue();
        intercepted = true;
      });

      const response = await page.goto(fixture.server.EMPTY_PAGE);

      expect(response!.ok()).toBe(true);
      expect(intercepted).toBe(true);
    });
  });

  it("unroutes handlers like Playwright", async () => {
    await withPage(async (page) => {
      let intercepted: number[] = [];
      await page.route("**/*", (route) => {
        intercepted.push(1);
        void route.fallback();
      });
      await page.route("**/empty.html", (route) => {
        intercepted.push(2);
        void route.fallback();
      });
      await page.route("**/empty.html", (route) => {
        intercepted.push(3);
        void route.fallback();
      });
      const handler4 = (route: any) => {
        intercepted.push(4);
        void route.fallback();
      };
      await page.route(/empty.html/, handler4);

      await page.goto(fixture.server.EMPTY_PAGE);
      expect(intercepted).toEqual([4, 3, 2, 1]);

      intercepted = [];
      await page.unroute(/empty.html/, handler4);
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(intercepted).toEqual([3, 2, 1]);

      intercepted = [];
      await page.unroute("**/empty.html");
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(intercepted).toEqual([1]);
    });
  });

  it("does not support question mark as any character in glob like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/index", (_request, response) => response.end("index-no-hello"));
      fixture.server.setRoute("/index123hello", (_request, response) => response.end("index123hello"));
      fixture.server.setRoute("/index?hello", (_request, response) => response.end("index?hello"));
      fixture.server.setRoute("/index1hello", (_request, response) => response.end("index1hello"));

      await page.route("**/index?hello", async (route) => {
        await route.fulfill({ body: "intercepted any character" });
      });
      await page.route("**/index\\?hello", async (route) => {
        await route.fulfill({ body: "intercepted question mark" });
      });

      await page.goto(fixture.server.PREFIX + "/index?hello");
      expect(await page.content()).toContain("intercepted question mark");

      await page.goto(fixture.server.PREFIX + "/index");
      expect(await page.content()).toContain("index-no-hello");

      await page.goto(fixture.server.PREFIX + "/index1hello");
      expect(await page.content()).toContain("index1hello");

      await page.goto(fixture.server.PREFIX + "/index123hello");
      expect(await page.content()).toContain("index123hello");
    });
  });

  it("works when POST is redirected with 302 like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRedirect("/rredirect", "/empty.html");
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.route("**/*", (route) => route.continue());
      await page.setContent(`
        <form action='/rredirect' method='post'>
          <input type="hidden" id="foo" name="foo" value="FOOBAR">
        </form>
      `);

      await Promise.all([
        page.$eval("form", (form) => (form as HTMLFormElement).submit()),
        page.waitForNavigation()
      ]);
    });
  });

  it("works with header manipulation and redirect like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRedirect("/rrredirect", "/empty.html");
      await page.route("**/*", (route) => {
        const headers = {
          ...route.request().headers(),
          foo: "bar"
        };
        void route.continue({ headers });
      });

      await page.goto(fixture.server.PREFIX + "/rrredirect");
    });
  });

  it("removes headers like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.route("**/*", async (route) => {
        const headers = { ...route.request().headers() };
        delete headers.foo;
        void route.continue({ headers });
      });

      const [serverRequest] = await Promise.all([
        fixture.server.waitForRequest("/title.html"),
        page.evaluate((url) => fetch(url, { headers: { foo: "bar" } }), fixture.server.PREFIX + "/title.html")
      ]);

      expect(serverRequest.headers.foo).toBe(undefined);
    });
  });

  it("contains referer header like Playwright", async () => {
    await withPage(async (page) => {
      const requests: any[] = [];
      await page.route("**/*", (route) => {
        requests.push(route.request());
        void route.continue();
      });

      await page.goto(fixture.server.PREFIX + "/one-style.html");

      expect(requests[1].url()).toContain("/one-style.css");
      expect(requests[1].headers().referer).toContain("/one-style.html");
    });
  });

  it("shows custom HTTP headers like Playwright", async () => {
    await withPage(async (page) => {
      await page.setExtraHTTPHeaders({
        foo: "bar"
      });
      await page.route("**/*", (route) => {
        expect(route.request().headers().foo).toBe("bar");
        void route.continue();
      });

      const response = await page.goto(fixture.server.EMPTY_PAGE);

      expect(response!.ok()).toBe(true);
    });
  });

  it("works with redirect inside sync XHR like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRedirect("/logo.png", "/pptr.png");
      let continuePromise: Promise<void> | undefined;
      await page.route("**/*", (route) => {
        continuePromise = route.continue();
      });

      const status = await page.evaluate(() => {
        const request = new XMLHttpRequest();
        request.open("GET", "/logo.png", false);
        request.send(null);
        return request.status;
      });

      expect(status).toBe(200);
      expect(continuePromise).toBeTruthy();
      await continuePromise;
    });
  });

  it("pauses intercepted XHR until continue like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      let resolveRoute!: (route: any) => void;
      const routePromise = new Promise<any>((resolve) => {
        resolveRoute = resolve;
      });
      await page.route("**/global-var.html", async (route) => resolveRoute(route));
      let xhrFinished = false;
      const statusPromise = page
        .evaluate(() => {
          const request = new XMLHttpRequest();
          request.open("GET", "/global-var.html", false);
          request.send(null);
          return request.status;
        })
        .then((status) => {
          xhrFinished = true;
          return status;
        });

      const route = await routePromise;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(xhrFinished).toBe(false);

      const [status] = await Promise.all([
        statusPromise,
        route.continue()
      ]);
      expect(status).toBe(200);
    });
  });

  it("pauses intercepted fetch request until continue like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      let resolveRoute!: (route: any) => void;
      const routePromise = new Promise<any>((resolve) => {
        resolveRoute = resolve;
      });
      await page.route("**/global-var.html", async (route) => resolveRoute(route));
      let fetchFinished = false;
      const statusPromise = page
        .evaluate(async () => {
          const response = await fetch("/global-var.html");
          return response.status;
        })
        .then((status) => {
          fetchFinished = true;
          return status;
        });

      const route = await routePromise;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fetchFinished).toBe(false);

      const [status] = await Promise.all([
        statusPromise,
        route.continue()
      ]);
      expect(status).toBe(200);
    });
  });

  it("sends referer like Playwright", async () => {
    await withPage(async (page) => {
      await page.setExtraHTTPHeaders({
        referer: "http://google.com/"
      });
      await page.route("**/*", (route) => route.continue());

      const [request] = await Promise.all([
        fixture.server.waitForRequest("/grid.html"),
        page.goto(fixture.server.PREFIX + "/grid.html")
      ]);

      expect(request.headers.referer).toBe("http://google.com/");
    });
  });

  it("is abortable like Playwright", async () => {
    await withPage(async (page) => {
      await page.route(/\.css$/, (route) => route.abort());
      let failed = false;
      page.on("requestfailed", (request) => {
        if (request.url().includes(".css")) {
          failed = true;
        }
      });

      const response = await page.goto(fixture.server.PREFIX + "/one-style.html");

      expect(response!.ok()).toBe(true);
      expect(response!.request().failure()).toBe(null);
      expect(failed).toBe(true);
    });
  });

  it("is abortable with custom error codes like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/*", (route) => route.abort("internetdisconnected"));
      let failedRequest: any = null;
      page.on("requestfailed", (request) => {
        failedRequest = request;
      });

      await page.goto(fixture.server.EMPTY_PAGE).catch(() => {});

      expect(failedRequest).toBeTruthy();
      expect(failedRequest.failure().errorText).toBe("net::ERR_INTERNET_DISCONNECTED");
    });
  });

  it("fails navigation when aborting main resource like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/*", (route) => route.abort());

      const error = await page.goto(fixture.server.EMPTY_PAGE).catch((error) => error);

      expect(error).toBeTruthy();
      expect(error.message).toContain("net::ERR_FAILED");
    });
  });

  it("does not intercept redirect hops for navigation like Playwright", async () => {
    await withPage(async (page) => {
      const intercepted: any[] = [];
      await page.route("**/*", (route) => {
        void route.continue();
        intercepted.push(route.request());
      });
      fixture.server.setRedirect("/non-existing-page.html", "/non-existing-page-2.html");
      fixture.server.setRedirect("/non-existing-page-2.html", "/non-existing-page-3.html");
      fixture.server.setRedirect("/non-existing-page-3.html", "/non-existing-page-4.html");
      fixture.server.setRedirect("/non-existing-page-4.html", "/empty.html");

      const response = await page.goto(fixture.server.PREFIX + "/non-existing-page.html");

      expect(response!.status()).toBe(200);
      expect(response!.url()).toContain("empty.html");
      expect(intercepted.length).toBe(1);
      expect(intercepted[0].resourceType()).toBe("document");
      expect(intercepted[0].isNavigationRequest()).toBe(true);
      expect(intercepted[0].url()).toContain("/non-existing-page.html");

      const chain: any[] = [];
      for (let request: any = response!.request(); request; request = request.redirectedFrom()) {
        chain.push(request);
        expect(request.isNavigationRequest()).toBe(true);
      }
      expect(chain.length).toBe(5);
      expect(chain[0].url()).toContain("/empty.html");
      expect(chain[1].url()).toContain("/non-existing-page-4.html");
      expect(chain[2].url()).toContain("/non-existing-page-3.html");
      expect(chain[3].url()).toContain("/non-existing-page-2.html");
      expect(chain[4].url()).toContain("/non-existing-page.html");
      for (let index = 0; index < chain.length; index += 1) {
        expect(chain[index].redirectedTo()).toBe(index ? chain[index - 1] : null);
      }
    });
  });

  it("chains fallback with dynamic URL like Playwright", async () => {
    await withPage(async (page) => {
      const intercepted: number[] = [];
      await page.route("**/bar", (route) => {
        intercepted.push(1);
        void route.fallback({ url: fixture.server.EMPTY_PAGE });
      });
      await page.route("**/foo", (route) => {
        intercepted.push(2);
        void route.fallback({ url: "http://localhost/bar" });
      });
      await page.route("**/empty.html", (route) => {
        intercepted.push(3);
        void route.fallback({ url: "http://localhost/foo" });
      });

      await page.goto(fixture.server.EMPTY_PAGE);

      expect(intercepted).toEqual([3, 2, 1]);
    });
  });

  it("works with redirects for subresources like Playwright", async () => {
    await withPage(async (page) => {
      const intercepted: any[] = [];
      await page.route("**/*", (route) => {
        void route.continue();
        intercepted.push(route.request());
      });
      fixture.server.setRedirect("/one-style.css", "/two-style.css");
      fixture.server.setRedirect("/two-style.css", "/three-style.css");
      fixture.server.setRedirect("/three-style.css", "/four-style.css");
      fixture.server.setRoute("/four-style.css", (_request, response) => {
        response.end("body {box-sizing: border-box; }");
      });

      const response = await page.goto(fixture.server.PREFIX + "/one-style.html");

      expect(response!.status()).toBe(200);
      expect(response!.url()).toContain("one-style.html");
      expect(intercepted.length).toBe(2);
      expect(intercepted[0].resourceType()).toBe("document");
      expect(intercepted[0].url()).toContain("one-style.html");

      let request = intercepted[1];
      for (const url of ["/one-style.css", "/two-style.css", "/three-style.css", "/four-style.css"]) {
        expect(request.resourceType()).toBe("stylesheet");
        expect(request.url()).toContain(url);
        request = request.redirectedTo();
      }
      expect(request).toBe(null);
    });
  });

  it("works with equal requests like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      let responseCount = 1;
      fixture.server.setRoute("/zzz", (_request, response) => {
        response.end(String(responseCount++ * 11));
      });

      let spinner = false;
      await page.route("**/*", (route) => {
        void (spinner ? route.abort() : route.continue());
        spinner = !spinner;
      });

      const results = [];
      for (let index = 0; index < 3; index += 1) {
        results.push(await page.evaluate(() => fetch("/zzz").then((response) => response.text()).catch(() => "FAILED")));
      }

      expect(results).toEqual(["11", "FAILED", "22"]);
    });
  });

  it("navigates to dataURL and does not fire dataURL requests like Playwright", async () => {
    await withPage(async (page) => {
      const requests: any[] = [];
      await page.route("**/*", (route) => {
        requests.push(route.request());
        void route.continue();
      });

      const response = await page.goto("data:text/html,<div>yo</div>");

      expect(response).toBe(null);
      expect(requests.length).toBe(0);
    });
  });

  it("fetches dataURL and does not fire dataURL requests like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const requests: any[] = [];
      await page.route("**/*", (route) => {
        requests.push(route.request());
        void route.continue();
      });

      const text = await page.evaluate((url) => fetch(url).then((response) => response.text()), "data:text/html,<div>yo</div>");

      expect(text).toBe("<div>yo</div>");
      expect(requests.length).toBe(0);
    });
  });

  it("navigates to URL with hash and fires requests without hash like Playwright", async () => {
    await withPage(async (page) => {
      const requests: any[] = [];
      await page.route("**/*", (route) => {
        requests.push(route.request());
        void route.continue();
      });

      const response = await page.goto(fixture.server.EMPTY_PAGE + "#hash");

      expect(response!.status()).toBe(200);
      expect(response!.url()).toBe(fixture.server.EMPTY_PAGE);
      expect(requests.length).toBe(1);
      expect(requests[0].url()).toBe(fixture.server.EMPTY_PAGE);
    });
  });

  it("works with encoded server like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/*", (route) => route.continue());

      const response = await page.goto(fixture.server.PREFIX + "/some nonexisting page");

      expect(response!.status()).toBe(404);
    });
  });

  it("works with badly encoded server like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/malformed?rnd=%911", (_request, response) => response.end());
      await page.route("**/*", (route) => route.continue());

      const response = await page.goto(fixture.server.PREFIX + "/malformed?rnd=%911");

      expect(response!.status()).toBe(200);
    });
  });

  it("works with encoded server for stylesheet like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const requests: any[] = [];
      await page.route("**/*", (route) => {
        void route.continue();
        requests.push(route.request());
      });

      await page.setContent(`<link rel="stylesheet" href="${fixture.server.PREFIX}/fonts?helvetica|arial"/>`);

      expect(requests.length).toBe(1);
      expect((await requests[0].response()).status()).toBe(404);
    });
  });

  it("does not throw Invalid Interception Id if request was cancelled like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent("<iframe></iframe>");
      let route: any = null;
      await page.route("**/*", async (r) => {
        route = r;
      });
      void page.$eval("iframe", (frame, url) => {
        (frame as HTMLIFrameElement).src = url as string;
      }, fixture.server.EMPTY_PAGE);
      await page.waitForEvent("request");
      await page.$eval("iframe", (frame) => frame.remove());

      const error = await route.continue().catch((error: Error) => error);

      expect(error).toBe(undefined);
    });
  });

  it("intercepts main resource during cross-process navigation like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      let intercepted = false;
      await page.route(fixture.server.CROSS_PROCESS_PREFIX + "/empty.html", (route) => {
        intercepted = true;
        void route.continue();
      });

      const response = await page.goto(fixture.server.CROSS_PROCESS_PREFIX + "/empty.html");

      expect(response!.ok()).toBe(true);
      expect(intercepted).toBe(true);
    });
  });

  it("fulfills with redirect status like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/title.html");
      fixture.server.setRoute("/final", (_request, response) => response.end("foo"));
      await page.route("**/*", async (route, request) => {
        if (request.url() !== fixture.server.PREFIX + "/redirect_this") {
          return route.continue();
        }
        await route.fulfill({
          headers: {
            location: "/final"
          },
          status: 301
        });
      });

      const text = await page.evaluate(async (url) => {
        const data = await fetch(url);
        return data.text();
      }, fixture.server.PREFIX + "/redirect_this");

      expect(text).toBe("foo");
    });
  });

  it("supports CORS with GET like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.route("**/cars*", async (route, request) => {
        await route.fulfill({
          body: JSON.stringify(["electric", "gas"]),
          contentType: "application/json",
          headers: {
            "access-control-allow-origin": request.url().endsWith("allow") ? "*" : "none"
          },
          status: 200
        });
      });

      const response = await page.evaluate(async () => {
        const response = await fetch("https://example.com/cars?allow", { mode: "cors" });
        return response.json();
      });
      expect(response).toEqual(["electric", "gas"]);

      const error = await page
        .evaluate(async () => {
          const response = await fetch("https://example.com/cars?reject", { mode: "cors" });
          return response.json();
        })
        .catch((error) => error);
      expect(error.message).toContain("Failed");
    });
  });

  it("adds Access-Control-Allow-Origin by default when fulfilling like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.route("**/cars", async (route) => {
        await route.fulfill({
          body: JSON.stringify(["electric", "gas"]),
          contentType: "application/json",
          status: 200
        });
      });

      const [result, response] = await Promise.all([
        page.evaluate(async () => {
          const response = await fetch("https://example.com/cars", {
            body: JSON.stringify({ number: 1 }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
            mode: "cors"
          });
          return response.json();
        }),
        page.waitForResponse("https://example.com/cars")
      ]);

      expect(result).toEqual(["electric", "gas"]);
      expect(await response.headerValue("Access-Control-Allow-Origin")).toBe(fixture.server.PREFIX);
    });
  });

  it("allows null origin for about:blank like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/something", async (route) => {
        await route.fulfill({
          body: "done",
          contentType: "text/plain",
          status: 200
        });
      });

      const [response, text] = await Promise.all([
        page.waitForResponse(fixture.server.CROSS_PROCESS_PREFIX + "/something"),
        page.evaluate(async (url) => {
          const data = await fetch(url, {
            headers: { "X-PINGOTHER": "pingpong" },
            method: "GET"
          });
          return data.text();
        }, fixture.server.CROSS_PROCESS_PREFIX + "/something")
      ]);

      expect(text).toBe("done");
      expect(await response.headerValue("Access-Control-Allow-Origin")).toBe("null");
    });
  });

  it("respects CORS overrides like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/something", (request, response) => {
        if (request.method === "OPTIONS") {
          response.writeHead(204, {
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache"
          });
          response.end();
          return;
        }
        response.writeHead(404, { "Access-Control-Allow-Origin": "*" });
        response.end("NOT FOUND");
      });
      await page.route("**/something", async (route) => {
        await route.fulfill({
          body: "done",
          contentType: "text/plain",
          headers: { "Access-Control-Allow-Origin": "http://non-existent" },
          status: 200
        });
      });

      const error = await page
        .evaluate(async (url) => {
          const data = await fetch(url, {
            headers: { "X-PINGOTHER": "pingpong" },
            method: "GET"
          });
          return data.text();
        }, fixture.server.CROSS_PROCESS_PREFIX + "/something")
        .catch((error) => error);

      expect(error.message).toContain("Failed");
    });
  });

  it("does not auto-intercept non-preflight OPTIONS without network interception like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      let requests: string[] = [];
      fixture.server.setRoute("/something", (request, response) => {
        requests.push(`${request.method}:${request.url}`);
        if (request.method === "OPTIONS") {
          response.writeHead(200, {
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache"
          });
          response.end("Hello");
          return;
        }
        response.writeHead(200, { "Access-Control-Allow-Origin": "*" });
        response.end("World");
      });

      requests = [];
      const [text1, text2] = await page.evaluate(async (url) => {
        const response1 = await fetch(url, { method: "OPTIONS" });
        const text1 = await response1.text();
        const response2 = await fetch(url, { method: "GET" });
        const text2 = await response2.text();
        return [text1, text2];
      }, fixture.server.CROSS_PROCESS_PREFIX + "/something");

      expect(text1).toBe("Hello");
      expect(text2).toBe("World");
      expect(requests).toEqual(["OPTIONS:/something", "OPTIONS:/something", "GET:/something"]);
    });
  });

  it("does not auto-intercept non-preflight OPTIONS with network interception like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      let requests: string[] = [];
      fixture.server.setRoute("/something", (request, response) => {
        requests.push(`${request.method}:${request.url}`);
        if (request.method === "OPTIONS") {
          response.writeHead(200, {
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache"
          });
          response.end("Hello");
          return;
        }
        response.writeHead(200, { "Access-Control-Allow-Origin": "*" });
        response.end("World");
      });
      await page.route("**/something", (route) => route.continue());

      requests = [];
      const [text1, text2] = await page.evaluate(async (url) => {
        const response1 = await fetch(url, { method: "OPTIONS" });
        const text1 = await response1.text();
        const response2 = await fetch(url, { method: "GET" });
        const text2 = await response2.text();
        return [text1, text2];
      }, fixture.server.CROSS_PROCESS_PREFIX + "/something");

      expect(text1).toBe("Hello");
      expect(text2).toBe("World");
      expect(requests).toEqual(["OPTIONS:/something", "GET:/something"]);
    });
  });

  it("supports CORS with POST like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.route("**/cars", async (route) => {
        await route.fulfill({
          body: JSON.stringify(["electric", "gas"]),
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          status: 200
        });
      });

      const response = await page.evaluate(async () => {
        const response = await fetch("https://example.com/cars", {
          body: JSON.stringify({ number: 1 }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          mode: "cors"
        });
        return response.json();
      });

      expect(response).toEqual(["electric", "gas"]);
    });
  });

  it("supports CORS with credentials like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.route("**/cars", async (route) => {
        await route.fulfill({
          body: JSON.stringify(["electric", "gas"]),
          contentType: "application/json",
          headers: {
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Origin": fixture.server.PREFIX
          },
          status: 200
        });
      });

      const response = await page.evaluate(async () => {
        const response = await fetch("https://example.com/cars", {
          body: JSON.stringify({ number: 1 }),
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          method: "POST",
          mode: "cors"
        });
        return response.json();
      });

      expect(response).toEqual(["electric", "gas"]);
    });
  });

  it("rejects CORS with disallowed credentials like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.route("**/cars", async (route) => {
        await route.fulfill({
          body: JSON.stringify(["electric", "gas"]),
          contentType: "application/json",
          headers: {
            "Access-Control-Allow-Origin": fixture.server.PREFIX
          },
          status: 200
        });
      });

      const error = await page
        .evaluate(async () => {
          const response = await fetch("https://example.com/cars", {
            body: JSON.stringify({ number: 1 }),
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            method: "POST",
            mode: "cors"
          });
          return response.json();
        })
        .catch((error) => error);

      expect(error).toBeTruthy();
    });
  });

  it("supports CORS for different methods like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.route("**/cars", async (route, request) => {
        await route.fulfill({
          body: JSON.stringify([request.method(), "electric", "gas"]),
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          status: 200
        });
      });

      const postResponse = await page.evaluate(async () => {
        const response = await fetch("https://example.com/cars", {
          body: JSON.stringify({ number: 1 }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          mode: "cors"
        });
        return response.json();
      });
      expect(postResponse).toEqual(["POST", "electric", "gas"]);

      const deleteResponse = await page.evaluate(async () => {
        const response = await fetch("https://example.com/cars", {
          body: "",
          headers: {},
          method: "DELETE",
          mode: "cors"
        });
        return response.json();
      });
      expect(deleteResponse).toEqual(["DELETE", "electric", "gas"]);
    });
  });

  it("supports the times parameter with route matching like Playwright", async () => {
    await withPage(async (page) => {
      const intercepted: number[] = [];
      await page.route(
        "**/empty.html",
        (route) => {
          intercepted.push(1);
          void route.continue();
        },
        { times: 1 }
      );

      await page.goto(fixture.server.EMPTY_PAGE);
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.goto(fixture.server.EMPTY_PAGE);

      expect(intercepted).toHaveLength(1);
    });
  });

  it("works if handler with times parameter was removed from another handler like Playwright", async () => {
    await withPage(async (page) => {
      const intercepted: string[] = [];
      const handler = async (route: any) => {
        intercepted.push("first");
        void route.continue();
      };
      await page.route("**/*", handler, { times: 1 });
      await page.route("**/*", async (route) => {
        intercepted.push("second");
        await page.unroute("**/*", handler);
        await route.fallback();
      });

      await page.goto(fixture.server.EMPTY_PAGE);
      expect(intercepted).toEqual(["second"]);

      intercepted.length = 0;
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(intercepted).toEqual(["second"]);
    });
  });

  it("supports async handler with times like Playwright", async () => {
    await withPage(async (page) => {
      await page.route(
        "**/empty.html",
        async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          await route.fulfill({
            body: "<html>intercepted</html>",
            contentType: "text/html"
          });
        },
        { times: 1 }
      );

      await page.goto(fixture.server.EMPTY_PAGE);
      expect(await page.locator("body").textContent()).toBe("intercepted");

      await page.goto(fixture.server.EMPTY_PAGE);
      expect(await page.locator("body").textContent()).not.toBe("intercepted");
    });
  });

  it("contains raw request header like Playwright", async () => {
    await withPage(async (page) => {
      let headers: Record<string, string> | undefined;
      await page.route("**/*", async (route) => {
        headers = await route.request().allHeaders();
        void route.continue();
      });

      await page.goto(fixture.server.PREFIX + "/empty.html");

      expect(headers!.accept).toBeTruthy();
    });
  });

  it("contains raw response header like Playwright", async () => {
    await withPage(async (page) => {
      let request: any;
      await page.route("**/*", async (route) => {
        request = route.request();
        void route.continue();
      });

      await page.goto(fixture.server.PREFIX + "/empty.html");
      const response = await request.response();
      const headers = await response.allHeaders();

      expect(headers["content-type"]).toBeTruthy();
    });
  });

  it("contains raw response header after fulfill like Playwright", async () => {
    await withPage(async (page) => {
      let request: any;
      await page.route("**/*", async (route) => {
        request = route.request();
        await route.fulfill({
          body: "Hello",
          contentType: "text/html",
          status: 200
        });
      });

      await page.goto(fixture.server.PREFIX + "/empty.html");
      const response = await request.response();
      const headers = await response.allHeaders();

      expect(headers["content-type"]).toBeTruthy();
    });
  });

  for (const method of ["fulfill", "continue", "fallback", "abort"] as const) {
    it(`route.${method} throws if called twice like Playwright`, async () => {
      await withPage(async (page) => {
        let resolveRoute!: (route: any) => void;
        const routePromise = new Promise<any>((resolve) => {
          resolveRoute = resolve;
        });
        await page.route("**/*", resolveRoute);
        void page.goto(fixture.server.PREFIX + "/empty.html").catch(() => {});

        const route = await routePromise;
        await route[method]();
        const error = await route[method]().catch((error: Error) => error);

        expect(error.message).toContain("Route is already handled!");
      });
    });
  }

  it("intercepts when postData is more than 1MB like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      let resolvePostData!: (postData: string | null) => void;
      const postDataPromise = new Promise<string | null>((resolve) => {
        resolvePostData = resolve;
      });
      const POST_BODY = "0".repeat(2 * 1024 * 1024);
      await page.route("**/404.html", async (route) => {
        await route.abort();
        resolvePostData(route.request().postData());
      });

      await page.evaluate((postBody) => fetch("/404.html", {
        body: postBody,
        method: "POST"
      }).catch(() => {}), POST_BODY);

      expect(await postDataPromise).toBe(POST_BODY);
    });
  });

  it("continues and amends HTTP headers like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/*", (route) => {
        void route.continue({
          headers: {
            ...route.request().headers(),
            foo: "bar"
          }
        });
      });

      await page.goto(fixture.server.EMPTY_PAGE);
      const [request] = await Promise.all([
        fixture.server.waitForRequest("/simple.json"),
        page.evaluate(() => fetch("/simple.json"))
      ]);

      expect(request.headers.foo).toBe("bar");
    });
  });

  it("does not allow overriding unsafe HTTP headers like Playwright", async () => {
    await withPage(async (page) => {
      let resolveRoute!: (route: any) => void;
      const routePromise = new Promise<any>((resolve) => {
        resolveRoute = resolve;
      });
      await page.route("**/*", (route) => resolveRoute(route));
      const serverRequestPromise = fixture.server.waitForRequest("/empty.html");
      void page.goto(fixture.server.EMPTY_PAGE).catch(() => {});

      const route = await routePromise;
      await route.continue({
        headers: {
          ...route.request().headers(),
          host: "bar",
          trailer: "baz"
        }
      });

      const serverRequest = await serverRequestPromise;
      expect(serverRequest.headers.trailer).toBe(undefined);
      expect(serverRequest.headers.host).toBe(new URL(fixture.server.EMPTY_PAGE).host);
    });
  });

  it("continues and deletes headers with undefined value like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/something", (_request, response) => {
        response.writeHead(200, { "Access-Control-Allow-Origin": "*" });
        response.end("done");
      });
      let interceptedRequest: any;
      await page.route(fixture.server.PREFIX + "/something", async (route, request) => {
        interceptedRequest = request;
        const headers = await request.allHeaders();
        void route.continue({
          headers: {
            ...headers,
            foo: undefined
          }
        });
      });

      const [text, serverRequest] = await Promise.all([
        page.evaluate(async (url) => {
          const data = await fetch(url, {
            headers: {
              bar: "b",
              foo: "a"
            }
          });
          return data.text();
        }, fixture.server.PREFIX + "/something"),
        fixture.server.waitForRequest("/something")
      ]);

      expect(text).toBe("done");
      expect(interceptedRequest.headers().foo).toEqual(undefined);
      expect(serverRequest.headers.foo).toBeFalsy();
      expect(serverRequest.headers.bar).toBe("b");
    });
  });

  it("continues and overrides request url like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/foo", (route) => {
        void route.continue({
          url: fixture.server.PREFIX + "/simple.json"
        });
      });

      const [request, response] = await Promise.all([
        fixture.server.waitForRequest("/simple.json"),
        page.goto(fixture.server.PREFIX + "/foo")
      ]);

      expect(request.method).toBe("GET");
      expect(response!.request().url()).toBe(fixture.server.PREFIX + "/simple.json");
      expect(response!.url()).toBe(fixture.server.PREFIX + "/simple.json");
      expect(await response!.text()).toBe('{"foo": "bar"}\n');
    });
  });

  it("continues and overrides method along with url like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/foo", (route) => {
        void route.continue({
          method: "POST",
          url: fixture.server.PREFIX + "/empty.html"
        });
      });

      const [request] = await Promise.all([
        fixture.server.waitForRequest("/empty.html"),
        page.goto(fixture.server.PREFIX + "/foo")
      ]);

      expect(request.method).toBe("POST");
    });
  });

  it("continues and amends post data like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.route("**/*", (route) => {
        void route.continue({ postData: "doggo" });
      });

      const [request] = await Promise.all([
        fixture.server.waitForRequest("/simple.json"),
        page.evaluate(() => fetch("/simple.json", { body: "birdy", method: "POST" }))
      ]);

      expect(request.method).toBe("POST");
      expect((await request.postBody).toString("utf8")).toBe("doggo");
    });
  });

  it("continues and computes content-length from overridden post data", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const data = "a".repeat(7500);
      await page.route("**/title.html", (route) => {
        const headers = route.request().headers();
        headers["content-type"] = "application/json";
        void route.continue({ headers, postData: data });
      });

      const [request] = await Promise.all([
        fixture.server.waitForRequest("/title.html"),
        page.evaluate(async (url) => {
          await fetch(url, { body: "birdy", method: "PATCH" });
        }, fixture.server.PREFIX + "/title.html")
      ]);

      expect((await request.postBody).toString("utf8")).toBe(data);
      expect(request.headers["content-length"]).toBe(String(data.length));
      expect(request.headers["content-type"]).toBe("application/json");
    });
  });

  it("continues and preserves original content-type when overriding post data", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.route("**/title.html", (route) => {
        void route.continue({ postData: '{"b":2}' });
      });

      const [request] = await Promise.all([
        fixture.server.waitForRequest("/title.html"),
        page.evaluate(async (url) => {
          await fetch(url, {
            body: '{"a":1}',
            headers: { "content-type": "application/json" },
            method: "POST"
          });
        }, fixture.server.PREFIX + "/title.html")
      ]);

      expect(request.headers["content-type"]).toBe("application/json");
      expect((await request.postBody).toString("utf8")).toBe('{"b":2}');
    });
  });

  it("does not delete the origin header like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/empty.html");
      fixture.server.setRoute("/something", (_request, response) => {
        response.writeHead(200, { "Access-Control-Allow-Origin": "*" });
        response.end("done");
      });
      let interceptedOrigin: string | undefined;
      await page.route(fixture.server.CROSS_PROCESS_PREFIX + "/something", async (route, request) => {
        const headers = await request.allHeaders();
        interceptedOrigin = headers.origin;
        delete headers.origin;
        void route.continue({ headers });
      });

      const [text, serverRequest] = await Promise.all([
        page.evaluate(async (url) => {
          const data = await fetch(url);
          return data.text();
        }, fixture.server.CROSS_PROCESS_PREFIX + "/something"),
        fixture.server.waitForRequest("/something")
      ]);

      expect(text).toBe("done");
      expect(interceptedOrigin).toEqual(fixture.server.PREFIX);
      expect(serverRequest.headers.origin).toBe(fixture.server.PREFIX);
    });
  });

  it("respects set-cookie in redirect response like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/set-cookie-redirect", (_request, response) => {
        response.writeHead(302, {
          location: "/empty.html",
          "set-cookie": "foo=bar; max-age=36000"
        });
        response.end();
      });
      await page.route("**/set-cookie-redirect", (route) => {
        void route.continue({
          headers: {
            ...route.request().headers()
          }
        });
      });

      const [serverRequest] = await Promise.all([
        fixture.server.waitForRequest("/empty.html"),
        page.goto(fixture.server.PREFIX + "/set-cookie-redirect")
      ]);

      expect(serverRequest.headers.cookie).toBe("foo=bar");
      expect(await page.evaluate(() => document.cookie)).toBe("foo=bar");
    });
  });

  it("continue does not propagate cookie override to redirects like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/set-cookie", (_request, response) => {
        response.writeHead(200, { "Set-Cookie": "foo=bar;" });
        response.end();
      });
      await page.goto(fixture.server.PREFIX + "/set-cookie");
      expect(await page.evaluate(() => document.cookie)).toBe("foo=bar");

      fixture.server.setRedirect("/redirect", fixture.server.PREFIX + "/empty.html");
      await page.route("**/redirect", (route) => {
        void route.continue({
          headers: {
            ...route.request().headers(),
            cookie: "override"
          }
        });
      });

      const [serverRequest] = await Promise.all([
        fixture.server.waitForRequest("/empty.html"),
        page.goto(fixture.server.PREFIX + "/redirect")
      ]);

      expect(serverRequest.headers.cookie).toBe("foo=bar");
    });
  });

  it("continue does not override cookie like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/set-cookie", (_request, response) => {
        response.writeHead(200, { "Set-Cookie": "foo=bar;" });
        response.end();
      });
      await page.goto(fixture.server.PREFIX + "/set-cookie");
      expect(await page.evaluate(() => document.cookie)).toBe("foo=bar");

      await page.route("**", (route) => {
        void route.continue({
          headers: {
            ...route.request().headers(),
            cookie: "override",
            custom: "value"
          }
        });
      });

      const [serverRequest] = await Promise.all([
        fixture.server.waitForRequest("/empty.html"),
        page.goto(fixture.server.EMPTY_PAGE)
      ]);

      expect(serverRequest.headers.cookie).toBe("foo=bar");
      expect(serverRequest.headers.custom).toBe("value");
    });
  });

  it("redirect after continue can delete cookie like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/set-cookie", (_request, response) => {
        response.writeHead(200, { "Set-Cookie": "foo=bar;" });
        response.end();
      });
      await page.goto(fixture.server.PREFIX + "/set-cookie");
      expect(await page.evaluate(() => document.cookie)).toBe("foo=bar");

      fixture.server.setRoute("/delete-cookie", (_request, response) => {
        response.writeHead(200, {
          "Set-Cookie": "foo=bar; expires=Thu, 01 Jan 1970 00:00:00 GMT"
        });
        response.end();
      });
      fixture.server.setRedirect("/redirect", "/delete-cookie");
      await page.route("**/redirect", (route) => {
        void route.continue({
          headers: {
            ...route.request().headers()
          }
        });
      });

      await page.goto(fixture.server.PREFIX + "/redirect");
      const [serverRequest] = await Promise.all([
        fixture.server.waitForRequest("/empty.html"),
        page.goto(fixture.server.EMPTY_PAGE)
      ]);

      expect(serverRequest.headers.cookie).toBeFalsy();
    });
  });

  it("continue propagates headers to redirects like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRedirect("/redirect", "/empty.html");
      await page.route("**/redirect", (route) => {
        void route.continue({
          headers: {
            ...route.request().headers(),
            custom: "value"
          }
        });
      });

      const [serverRequest] = await Promise.all([
        fixture.server.waitForRequest("/empty.html"),
        page.goto(fixture.server.PREFIX + "/redirect")
      ]);

      expect(serverRequest.headers.custom).toBe("value");
    });
  });

  it("continue drops content-length on redirects like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRedirect("/redirect", "/empty.html");
      await page.route("**/redirect", (route) => {
        void route.continue({
          headers: {
            ...route.request().headers(),
            custom: "value"
          }
        });
      });

      const [serverRequest] = await Promise.all([
        fixture.server.waitForRequest("/empty.html"),
        page.evaluate((url) => fetch(url, { body: "foo", method: "POST" }), fixture.server.PREFIX + "/redirect")
      ]);

      expect(serverRequest.method).toBe("GET");
      expect(serverRequest.headers["content-length"]).toBeUndefined();
      expect(serverRequest.headers["content-type"]).toBeUndefined();
      expect(serverRequest.headers.custom).toBe("value");
    });
  });

  it("redirected requests report overridden headers like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRedirect("/redirect", "/empty.html");
      await page.route("**/redirect", (route) => {
        const headers = route.request().headers();
        headers.custom = "value";
        void route.fallback({ headers });
      });

      const [serverRequest, response] = await Promise.all([
        fixture.server.waitForRequest("/empty.html"),
        page.goto(fixture.server.PREFIX + "/redirect")
      ]);

      expect(serverRequest.headers.custom).toBe("value");
      expect(response!.request().url()).toBe(fixture.server.EMPTY_PAGE);
      expect(response!.request().headers().custom).toBe("value");
      expect((await response!.request().allHeaders()).custom).toBe("value");
    });
  });

  it("continue deletes headers on redirects like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/empty.html");
      fixture.server.setRoute("/something", (_request, response) => {
        response.writeHead(200, { "Access-Control-Allow-Origin": "*" });
        response.end("done");
      });
      fixture.server.setRedirect("/redirect", "/something");
      await page.route("**/redirect", (route) => {
        void route.continue({
          headers: {
            ...route.request().headers(),
            foo: undefined
          }
        });
      });

      const [text, serverRequest] = await Promise.all([
        page.evaluate(async (url) => {
          const data = await fetch(url, {
            headers: {
              foo: "a"
            }
          });
          return data.text();
        }, fixture.server.PREFIX + "/redirect"),
        fixture.server.waitForRequest("/something")
      ]);

      expect(text).toBe("done");
      expect(serverRequest.headers.foo).toBeFalsy();
    });
  });

  it("propagates headers on same-origin redirect like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/empty.html");
      let resolveServerRequest!: (request: any) => void;
      const serverRequestPromise = new Promise<any>((resolve) => {
        resolveServerRequest = resolve;
      });
      fixture.server.setRoute("/something", (request, response) => {
        if (request.method === "OPTIONS") {
          response.writeHead(204, {
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Headers": "authorization,cookie,custom",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
            "Access-Control-Allow-Origin": fixture.server.PREFIX
          });
          response.end();
          return;
        }
        resolveServerRequest(request);
        response.writeHead(200, {});
        response.end("done");
      });
      fixture.server.setRedirect("/redirect", "/something");
      await page.evaluate(() => {
        document.cookie = "a=b";
      });

      const text = await page.evaluate(async (url) => {
        const data = await fetch(url, {
          credentials: "include",
          headers: {
            authorization: "credentials",
            custom: "foo"
          }
        });
        return data.text();
      }, fixture.server.PREFIX + "/redirect");

      const serverRequest = await serverRequestPromise;
      expect(text).toBe("done");
      expect(serverRequest.headers.authorization).toBe("credentials");
      expect(serverRequest.headers.cookie).toBe("a=b");
      expect(serverRequest.headers.custom).toBe("foo");
    });
  });

  it("propagates headers on cross-origin requests like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/empty.html");
      let resolveServerRequest!: (request: any) => void;
      const serverRequestPromise = new Promise<any>((resolve) => {
        resolveServerRequest = resolve;
      });
      fixture.server.setRoute("/something", (request, response) => {
        if (request.method === "OPTIONS") {
          response.writeHead(204, {
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Headers": "authorization,custom",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
            "Access-Control-Allow-Origin": fixture.server.PREFIX
          });
          response.end();
          return;
        }
        resolveServerRequest(request);
        response.writeHead(200, {
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Origin": fixture.server.PREFIX
        });
        response.end("done");
      });

      const text = await page.evaluate(async (url) => {
        const data = await fetch(url, {
          credentials: "include",
          headers: {
            authorization: "credentials",
            custom: "foo"
          }
        });
        return data.text();
      }, fixture.server.CROSS_PROCESS_PREFIX + "/something");

      const serverRequest = await serverRequestPromise;
      expect(text).toBe("done");
      expect(serverRequest.headers.authorization).toBe("credentials");
      expect(serverRequest.headers.custom).toBe("foo");
    });
  });

  it("does not propagate credential headers on cross-origin redirect like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/empty.html");
      let resolveServerRequest!: (request: any) => void;
      const serverRequestPromise = new Promise<any>((resolve) => {
        resolveServerRequest = resolve;
      });
      fixture.server.setRoute("/something", (request, response) => {
        if (request.method === "OPTIONS") {
          response.writeHead(204, {
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Headers": "authorization,cookie,custom",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
            "Access-Control-Allow-Origin": fixture.server.PREFIX
          });
          response.end();
          return;
        }
        resolveServerRequest(request);
        response.writeHead(200, {
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Origin": fixture.server.PREFIX
        });
        response.end("done");
      });
      fixture.server.setRoute("/redirect", (_request, response) => {
        response.writeHead(301, { location: `${fixture.server.CROSS_PROCESS_PREFIX}/something` });
        response.end();
      });
      await page.evaluate(() => {
        document.cookie = "a=b";
      });

      const text = await page.evaluate(async (url) => {
        const data = await fetch(url, {
          credentials: "include",
          headers: {
            authorization: "credentials",
            custom: "foo"
          }
        });
        return data.text();
      }, fixture.server.PREFIX + "/redirect");

      const serverRequest = await serverRequestPromise;
      expect(text).toBe("done");
      expect(serverRequest.headers.authorization).toBeFalsy();
      expect(serverRequest.headers.cookie).toBeFalsy();
      expect(serverRequest.headers.custom).toBe("foo");
    });
  });

  it("continue does not change multipart/form-data body like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/upload", (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("done");
      });

      async function sendFormData() {
        const requestPromise = fixture.server.waitForRequest("/upload");
        const status = await page.evaluate(async () => {
          const file = new File(["file content"], "file.txt");
          const formData = new FormData();
          formData.append("file", file);
          const response = await fetch("/upload", {
            body: formData,
            credentials: "include",
            method: "POST"
          });
          return response.status;
        });
        const request = await requestPromise;
        expect(status).toBe(200);
        return request;
      }

      const requestBefore = await sendFormData();
      await page.route("**/*", async (route) => {
        await route.continue();
      });
      const requestAfter = await sendFormData();
      const fileContent = [
        'Content-Disposition: form-data; name="file"; filename="file.txt"',
        "Content-Type: application/octet-stream",
        "",
        "file content",
        "------"
      ].join("\r\n");

      expect((await requestBefore.postBody).toString("utf8")).toContain(fileContent);
      expect((await requestAfter.postBody).toString("utf8")).toContain(fileContent);
    });
  });

  it("does not forward Host header on cross-origin redirect like Playwright", async () => {
    await withPage(async (page) => {
      const redirectTargetPath = "/final";
      const redirectSourcePath = "/redirect";
      let redirectedHost: string | undefined;
      let firstHost: string | undefined;

      fixture.server.setRoute(redirectTargetPath, (request, response) => {
        redirectedHost = request.headers.host;
        response.end("OK");
      });
      fixture.server.setRoute(redirectSourcePath, (request, response) => {
        firstHost = request.headers.host;
        response.writeHead(302, {
          location: `${fixture.server.CROSS_PROCESS_PREFIX}${redirectTargetPath}`
        });
        response.end();
      });

      await page.route("**/*", async (route) => {
        const headers = route.request().headers();
        expect(headers).not.toHaveProperty("host");
        await route.continue({ headers });
      });

      const response = await page.goto(fixture.server.PREFIX + redirectSourcePath);

      expect(response!.status()).toBe(200);
      expect(firstHost).toBe(new URL(fixture.server.PREFIX).host);
      expect(redirectedHost).toBe(new URL(fixture.server.CROSS_PROCESS_PREFIX).host);
    });
  });

  it("intercepts every navigation to a page controlled by service worker like Playwright", async () => {
    await withPage(async (page) => {
      let interceptions = 0;
      const url = fixture.server.PREFIX + "/serviceworkers/bug-33561/index.html";
      await page.route(url, async (route) => {
        interceptions += 1;
        await route.continue();
      });

      await page.goto(url);
      await page.evaluate(() => (window as typeof window & { activationPromise: Promise<void> }).activationPromise);
      await page.goto(url);

      expect(interceptions).toBe(2);
    });
  });

  it("fulfills document requests like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/*", (route) => {
        void route.fulfill({
          body: "Yo, page!",
          contentType: "text/html",
          headers: {
            foo: "bar"
          },
          status: 201
        });
      });

      const response = await page.goto(fixture.server.EMPTY_PAGE);

      expect(response!.status()).toBe(201);
      expect(response!.headers().foo).toBe("bar");
      expect(await page.evaluate(() => document.body.textContent)).toBe("Yo, page!");
    });
  });

  it("fulfills with buffer body like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/*", (route) => {
        void route.fulfill({
          body: Buffer.from("Yo, page!"),
          contentType: "text/plain",
          status: 200
        });
      });

      const response = await page.goto(fixture.server.EMPTY_PAGE);

      expect(response!.status()).toBe(200);
      expect(await page.evaluate(() => document.body.textContent)).toBe("Yo, page!");
      expect(await response!.body()).toEqual(Buffer.from("Yo, page!"));
    });
  });

  it("fulfills with standard and unknown status text like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/status-422", (route) => {
        void route.fulfill({
          body: "Yo, page!",
          status: 422
        });
      });
      await page.route("**/status-430", (route) => {
        void route.fulfill({
          body: "Yo, page!",
          status: 430
        });
      });

      const response422 = await page.goto(fixture.server.PREFIX + "/status-422");
      expect(response422!.status()).toBe(422);
      expect(response422!.statusText()).toBe("Unprocessable Entity");
      expect(await page.evaluate(() => document.body.textContent)).toBe("Yo, page!");

      const response430 = await page.goto(fixture.server.PREFIX + "/status-430");
      expect(response430!.status()).toBe(430);
      expect(response430!.statusText()).toBe("Unknown");
    });
  });

  it("does not throw when fulfilling a request cancelled by the page like Playwright", async () => {
    await withPage(async (page) => {
      let resolveRoute!: (route: any) => void;
      const routePromise = new Promise<any>((resolve) => {
        resolveRoute = resolve;
      });
      await page.route("**/data.json", (route) => resolveRoute(route));
      await page.goto(fixture.server.EMPTY_PAGE);
      void page.evaluate((url) => {
        const globalWithController = globalThis as typeof globalThis & { controller: AbortController };
        globalWithController.controller = new AbortController();
        return fetch(url, { signal: globalWithController.controller.signal });
      }, fixture.server.PREFIX + "/data.json").catch(() => {});

      const route = await routePromise;
      const failurePromise = page.waitForEvent("requestfailed");
      await page.evaluate(() => {
        (globalThis as typeof globalThis & { controller: AbortController }).controller.abort();
      });
      const cancelledRequest = await failurePromise;

      expect(cancelledRequest.failure()).toBeTruthy();
      expect(cancelledRequest.failure()!.errorText).toMatch(/cancelled|aborted/i);
      await route.fulfill({ status: 200 });
    });
  });

  it("fulfills SVG with charset like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.route("**/*", (route) => {
        void route.fulfill({
          body: '<svg width="50" height="50" version="1.1" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="30" height="30" stroke="black" fill="transparent" stroke-width="5"/></svg>',
          contentType: "image/svg+xml ; charset=utf-8"
        });
      });

      const loaded = await page.evaluate((prefix) => {
        const img = document.createElement("img");
        img.src = prefix + "/does-not-exist.svg";
        document.body.appendChild(img);
        return new Promise<{ height: number; width: number }>((resolve, reject) => {
          img.onload = () => resolve({ height: img.naturalHeight, width: img.naturalWidth });
          img.onerror = () => reject(new Error("image failed"));
        });
      }, fixture.server.PREFIX);

      expect(loaded).toEqual({ height: 50, width: 50 });
    });
  });

  it("fulfills with file path like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.route("**/*", (route) => {
        void route.fulfill({
          contentType: "shouldBeIgnored",
          path: fixture.asset("pptr.png")
        });
      });

      const result = await page.evaluate((prefix) => {
        const img = document.createElement("img");
        img.src = prefix + "/does-not-exist.png";
        document.body.appendChild(img);
        return new Promise<{ complete: boolean; height: number; width: number }>((resolve, reject) => {
          img.onload = () => resolve({
            complete: img.complete,
            height: img.naturalHeight,
            width: img.naturalWidth
          });
          img.onerror = () => reject(new Error("image failed"));
        });
      }, fixture.server.PREFIX);

      expect(result.complete).toBe(true);
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
    });
  });

  it("fulfills json like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.route("**/data.json", (route) => {
        void route.fulfill({
          headers: {
            foo: "bar"
          },
          json: { bar: "baz" },
          status: 201
        });
      });

      const [response, body] = await Promise.all([
        page.waitForResponse("**/data.json"),
        page.evaluate(() => fetch("./data.json").then((response) => response.text()))
      ]);

      expect(response.status()).toBe(201);
      expect(response.headers()["content-type"]).toBe("application/json");
      expect(response.headers().foo).toBe("bar");
      expect(body).toBe(JSON.stringify({ bar: "baz" }));
    });
  });

  it("fulfills with multiple set-cookie like Playwright", async () => {
    await withPage(async (page) => {
      const cookies = ["a=b", "c=d"];
      await page.route("**/multiple-set-cookie.html", async (route) => {
        await route.fulfill({
          body: "",
          headers: {
            "Set-Cookie": cookies.join("\n"),
            "X-Header-1": "v1",
            "X-Header-2": "v2"
          },
          status: 200
        });
      });

      const response = await page.goto(fixture.server.PREFIX + "/multiple-set-cookie.html");

      expect((await page.evaluate(() => document.cookie)).split(";").map((value) => value.trim()).sort()).toEqual(cookies);
      expect(await response!.headerValue("X-Header-1")).toBe("v1");
      expect(await response!.headerValue("X-Header-2")).toBe("v2");
      expect(await response!.headerValue("Set-Cookie")).toBe("a=b\nc=d");
    });
  });

  it("fulfills with fetch response that has multiple set-cookie like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/multiple-cookie-source.html", (_request, response) => {
        response.setHeader("Set-Cookie", ["a=b", "c=d"]);
        response.setHeader("Content-Type", "text/html");
        response.end("");
      });
      await page.route("**/empty.html", async (route) => {
        const response = await page.request.fetch(fixture.server.PREFIX + "/multiple-cookie-source.html");
        await route.fulfill({ response });
      });

      await page.goto(fixture.server.EMPTY_PAGE);

      expect((await page.evaluate(() => document.cookie)).split(";").map((value) => value.trim()).sort()).toEqual([
        "a=b",
        "c=d"
      ]);
    });
  });

  it("fulfills with HAR response like Playwright", async () => {
    await withPage(async (page) => {
      const har = JSON.parse(
        await readFile("library/playwright/tests/assets/har-fulfill.har", "utf8")
      ) as {
        log: {
          entries: Array<{
            request: { url: string };
            response: {
              content: { encoding?: BufferEncoding; text?: string };
              headers: Array<{ name: string; value: string }>;
              redirectURL?: string;
              status: number;
            };
          }>;
        };
      };
      const findResponse = (url: string) => {
        const originalUrl = url;
        let entry: (typeof har.log.entries)[number] | undefined;
        while (url.trim()) {
          entry = har.log.entries.find((entry) => entry.request.url === url);
          url = entry?.response.redirectURL ?? "";
        }
        expect(entry, originalUrl).toBeTruthy();
        return entry!.response;
      };

      await page.route("**/*", async (route) => {
        const response = findResponse(route.request().url());
        await route.fulfill({
          body: Buffer.from(response.content.text || "", response.content.encoding || "utf8"),
          headers: Object.fromEntries(response.headers.map(({ name, value }) => [name, value])),
          status: response.status
        });
      });

      await page.goto("http://no.playwright/");

      expect(await page.evaluate("window.value")).toBe("foo");
      expect(await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor)).toBe("rgb(0, 255, 255)");
    });
  });

  it("routes from HAR matching method and following redirects like Playwright", async () => {
    await withPage(async (page) => {
      await page.routeFromHAR("library/playwright/tests/assets/har-fulfill.har");

      await page.goto("http://no.playwright/");

      expect(await page.evaluate("window.value")).toBe("foo");
      expect(await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor)).toBe("rgb(255, 0, 0)");
    });
  });

  it("routeFromHAR fallback continues requests not found in HAR like Playwright", async () => {
    await withPage(async (page) => {
      await page.routeFromHAR("library/playwright/tests/assets/har-fulfill.har", {
        notFound: "fallback"
      });

      await page.goto(fixture.server.PREFIX + "/one-style.html");

      expect(await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor)).toBe("rgb(255, 192, 203)");
    });
  });

  it("routeFromHAR only handles requests matching url filter like Playwright", async () => {
    await withPage(async (page) => {
      await page.routeFromHAR("library/playwright/tests/assets/har-fulfill.har", {
        notFound: "fallback",
        url: "**/*.js"
      });
      await page.route("http://no.playwright/", async (route) => {
        await route.fulfill({
          body: '<script src="./script.js"></script><div>hello</div>',
          contentType: "text/html",
          status: 200
        });
      });

      await page.goto("http://no.playwright/");

      expect(await page.evaluate("window.value")).toBe("foo");
      expect(await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    });
  });

  it("applies route fallback overrides before routing from HAR like Playwright", async () => {
    await withPage(async (page) => {
      await page.routeFromHAR("library/playwright/tests/assets/har-fulfill.har", {
        url: "**/*.js"
      });
      await page.route("http://no.playwright/my-script.js", async (route) => {
        await route.fallback({
          url: "http://no.playwright/script2.js"
        });
      });
      await page.route("http://test.example/", async (route) => {
        await route.fulfill({
          body: '<script src="http://no.playwright/my-script.js"></script><div>hello</div>',
          contentType: "text/html",
          status: 200
        });
      });

      await page.goto("http://test.example/");

      expect(await page.evaluate("window.value")).toBe("foo");
    });
  });

  it("fulfills preload link requests like Playwright", async () => {
    await withPage(async (page) => {
      let intercepted = false;
      await page.route("**/one-style.css", async (route) => {
        intercepted = true;
        await route.fulfill({
          body: "body { background-color: green; }",
          headers: {
            "cache-control": "no-cache, no-store",
            "content-type": "text/css; charset=utf-8",
            custom: "value"
          },
          status: 200
        });
      });

      const [response] = await Promise.all([
        page.waitForResponse("**/one-style.css"),
        page.goto(fixture.server.PREFIX + "/preload.html")
      ]);

      expect(await response.headerValue("custom")).toBe("value");
      await page.waitForFunction(() => (window as typeof window & { preloadedStyles: boolean }).preloadedStyles);
      expect(intercepted).toBe(true);
      expect(await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor)).toBe("rgb(0, 128, 0)");
    });
  });

  it("fulfills with gzip and readback like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.enableGzip("/one-style.html");
      await page.route("**/one-style.html", async (route) => {
        const response = await route.fetch();
        expect(response.headers()["content-encoding"]).toBe("gzip");
        await route.fulfill({ response });
      });

      const response = await page.goto(fixture.server.PREFIX + "/one-style.html");

      expect(await page.locator("div").textContent()).toBe("hello, world!");
      expect(await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor)).toBe("rgb(255, 192, 203)");
      expect(await response!.text()).toContain("<div>hello, world!</div>");
    });
  });

  it("falls back through matching routes in newest-first order like Playwright", async () => {
    await withPage(async (page) => {
      const intercepted: number[] = [];
      await page.route("**/empty.html", (route) => {
        intercepted.push(1);
        void route.fallback();
      });
      await page.route("**/empty.html", (route) => {
        intercepted.push(2);
        void route.fallback();
      });
      await page.route("**/empty.html", (route) => {
        intercepted.push(3);
        void route.fallback();
      });

      await page.goto(fixture.server.EMPTY_PAGE);

      expect(intercepted).toEqual([3, 2, 1]);
    });
  });

  it("falls back asynchronously like Playwright", async () => {
    await withPage(async (page) => {
      const intercepted: number[] = [];
      await page.route("**/empty.html", async (route) => {
        intercepted.push(1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        void route.fallback();
      });
      await page.route("**/empty.html", async (route) => {
        intercepted.push(2);
        await new Promise((resolve) => setTimeout(resolve, 100));
        void route.fallback();
      });
      await page.route("**/empty.html", async (route) => {
        intercepted.push(3);
        await new Promise((resolve) => setTimeout(resolve, 100));
        void route.fallback();
      });

      await page.goto(fixture.server.EMPTY_PAGE);

      expect(intercepted).toEqual([3, 2, 1]);
    });
  });

  it("does not chain fulfill after fallback like Playwright", async () => {
    await withPage(async (page) => {
      let failed = false;
      await page.route("**/empty.html", () => {
        failed = true;
      });
      await page.route("**/empty.html", (route) => {
        void route.fulfill({ body: "fulfilled", status: 200 });
      });
      await page.route("**/empty.html", (route) => {
        void route.fallback();
      });

      const response = await page.goto(fixture.server.EMPTY_PAGE);

      expect(await response!.text()).toBe("fulfilled");
      expect(failed).toBe(false);
    });
  });

  it("does not chain abort after fallback like Playwright", async () => {
    await withPage(async (page) => {
      let failed = false;
      await page.route("**/empty.html", () => {
        failed = true;
      });
      await page.route("**/empty.html", (route) => {
        void route.abort();
      });
      await page.route("**/empty.html", (route) => {
        void route.fallback();
      });

      const error = await page.goto(fixture.server.EMPTY_PAGE).catch((error) => error);

      expect(error).toBeTruthy();
      expect(failed).toBe(false);
    });
  });

  it("falls back after handler exception like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/empty.html", (route) => {
        void route.continue();
      });
      await page.route("**/empty.html", async (route) => {
        try {
          await route.fulfill({ response: {} as any });
        } catch {
          void route.fallback();
        }
      });

      const response = await page.goto(fixture.server.EMPTY_PAGE);

      expect(response!.ok()).toBe(true);
    });
  });

  it("falls back once with route times like Playwright", async () => {
    await withPage(async (page) => {
      await page.route(
        "**/empty.html",
        (route) => {
          void route.fulfill({ body: "fulfilled one", status: 200 });
        },
        { times: 1 }
      );
      await page.route(
        "**/empty.html",
        (route) => {
          void route.fallback();
        },
        { times: 1 }
      );

      const response = await page.goto(fixture.server.EMPTY_PAGE);

      expect(await response!.text()).toBe("fulfilled one");
    });
  });

  it("fallback amends headers visible to later handlers like Playwright", async () => {
    await withPage(async (page) => {
      const values: Array<string | null | undefined> = [];
      await page.route("**/simple.json", async (route) => {
        values.push(route.request().headers().foo);
        values.push(await route.request().headerValue("FOO"));
        void route.continue();
      });
      await page.route("**/*", (route) => {
        void route.fallback({
          headers: {
            ...route.request().headers(),
            FOO: "bar"
          }
        });
      });

      await page.goto(fixture.server.EMPTY_PAGE);
      const [request] = await Promise.all([
        fixture.server.waitForRequest("/simple.json"),
        page.evaluate(() => fetch("/simple.json"))
      ]);
      values.push(request.headers.foo);

      expect(values).toEqual(["bar", "bar", "bar"]);
    });
  });

  it("fallback amends method visible to later handlers like Playwright", async () => {
    await withPage(async (page) => {
      const serverRequestPromise = fixture.server.waitForRequest("/simple.json");
      await page.goto(fixture.server.EMPTY_PAGE);

      let method: string | undefined;
      await page.route("**/*", (route) => {
        method = route.request().method();
        void route.continue();
      });
      await page.route("**/*", (route) => {
        void route.fallback({ method: "POST" });
      });

      const [request, serverRequest] = await Promise.all([
        page.waitForRequest("**/simple.json"),
        serverRequestPromise,
        page.evaluate(() => fetch("/simple.json"))
      ]);

      expect(method).toBe("POST");
      expect(request.method()).toBe("POST");
      expect(serverRequest.method).toBe("POST");
    });
  });

  it("fallback overrides request url visible to later handlers like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/global-var.html", (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<script>window.globalVar = 123;</script>");
      });
      const serverRequest = fixture.server.waitForRequest("/global-var.html");

      let url: string | undefined;
      await page.route("**/global-var.html", (route) => {
        url = route.request().url();
        void route.continue();
      });
      await page.route("**/foo", (route) => {
        void route.fallback({ url: fixture.server.PREFIX + "/global-var.html" });
      });

      const response = await page.goto(fixture.server.PREFIX + "/foo");

      expect(url).toBe(fixture.server.PREFIX + "/global-var.html");
      expect(response!.request().url()).toBe(fixture.server.PREFIX + "/global-var.html");
      expect(response!.url()).toBe(fixture.server.PREFIX + "/global-var.html");
      expect(await page.evaluate(() => (window as any).globalVar)).toBe(123);
      expect((await serverRequest).method).toBe("GET");
    });
  });

  it("fallback amends post data visible to later handlers like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      let postData: string | null | undefined;
      await page.route("**/*", (route) => {
        postData = route.request().postData();
        void route.continue();
      });
      await page.route("**/*", (route) => {
        void route.fallback({ postData: "doggo" });
      });

      const [serverRequest] = await Promise.all([
        fixture.server.waitForRequest("/simple.json"),
        page.evaluate(() => fetch("/simple.json", { body: "birdy", method: "POST" }))
      ]);

      expect(postData).toBe("doggo");
      expect((await serverRequest.postBody).toString("utf8")).toBe("doggo");
    });
  });

  it("fallback amends binary post data like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const arr = Array.from(Array(256).keys());
      let postDataBuffer: Buffer | null | undefined;
      await page.route("**/*", (route) => {
        postDataBuffer = route.request().postDataBuffer();
        void route.continue();
      });
      await page.route("**/*", (route) => {
        void route.fallback({ postData: Buffer.from(arr) });
      });

      const [serverRequest] = await Promise.all([
        fixture.server.waitForRequest("/simple.json"),
        page.evaluate(() => fetch("/simple.json", { body: "birdy", method: "POST" }))
      ]);

      const buffer = await serverRequest.postBody;
      expect(postDataBuffer!.length).toBe(arr.length);
      expect(buffer.length).toBe(arr.length);
      for (let index = 0; index < arr.length; index += 1) {
        expect(buffer[index]).toBe(arr[index]);
        expect(postDataBuffer![index]).toBe(arr[index]);
      }
    });
  });

  it("fallback amends json post data like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      let postData: unknown;
      await page.route("**/*", (route) => {
        postData = route.request().postDataJSON();
        void route.continue();
      });
      await page.route("**/*", (route) => {
        void route.fallback({ postData: { foo: "bar" } });
      });

      const [serverRequest] = await Promise.all([
        fixture.server.waitForRequest("/simple.json"),
        page.evaluate(() => fetch("/simple.json", { body: "birdy", method: "POST" }))
      ]);

      expect(postData).toEqual({ foo: "bar" });
      expect((await serverRequest.postBody).toString("utf8")).toBe('{"foo":"bar"}');
    });
  });

  it("fulfills intercepted response with route.fetch overrides like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/*", async (route) => {
        const response = await page.request.fetch(route.request());
        await route.fulfill({
          body: "Yo, page!",
          contentType: "text/plain",
          headers: {
            foo: "bar"
          },
          response,
          status: 201
        });
      });

      const response = await page.goto(fixture.server.EMPTY_PAGE);

      expect(response!.status()).toBe(201);
      expect(response!.headers().foo).toBe("bar");
      expect(response!.headers()["content-type"]).toBe("text/plain");
      expect(await page.evaluate(() => document.body.textContent)).toBe("Yo, page!");
    });
  });

  it("fulfills fetched response with empty body like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/*", async (route) => {
        const response = await page.request.fetch(route.request());
        await route.fulfill({
          body: "",
          headers: {
            "content-length": "0"
          },
          response,
          status: 201
        });
      });

      const response = await page.goto(fixture.server.PREFIX + "/title.html");

      expect(response!.status()).toBe(201);
      expect(await response!.text()).toBe("");
    });
  });

  it("overrides with defaults when intercepted response is not provided like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/default-fulfill-empty.html", (_request, response) => {
        response.setHeader("foo", "bar");
        response.end("my content");
      });
      await page.route("**/*", async (route) => {
        await page.request.fetch(route.request());
        await route.fulfill({
          status: 201
        });
      });

      const response = await page.goto(fixture.server.PREFIX + "/default-fulfill-empty.html");

      expect(response!.status()).toBe(201);
      expect(await response!.text()).toBe("");
      expect(response!.headers()).toEqual({});
    });
  });

  it("fulfills with any API response like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/sample", (_request, response) => {
        response.setHeader("foo", "bar");
        response.end("Woo-hoo");
      });
      const sampleResponse = await page.request.get(fixture.server.PREFIX + "/sample");

      await page.route("**/*", async (route) => {
        await route.fulfill({
          contentType: "text/plain",
          response: sampleResponse,
          status: 201
        });
      });

      const response = await page.goto(fixture.server.EMPTY_PAGE);

      expect(response!.status()).toBe(201);
      expect(await response!.text()).toBe("Woo-hoo");
      expect(response!.headers().foo).toBe("bar");
    });
  });

  it("supports fulfill after intercept like Playwright", async () => {
    await withPage(async (page) => {
      const requestPromise = fixture.server.waitForRequest("/title.html");
      await page.route("**", async (route) => {
        const response = await page.request.fetch(route.request());
        await route.fulfill({ response });
      });

      const response = await page.goto(fixture.server.PREFIX + "/title.html");
      const request = await requestPromise;

      expect(request.url).toBe("/title.html");
      expect(await response!.text()).toContain("<title>Woof-Woof</title>");
    });
  });

  it("gives access to intercepted response metadata like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);

      let routeCallback!: (route: any) => void;
      const routePromise = new Promise<any>((resolve) => {
        routeCallback = resolve;
      });
      await page.route("**/title.html", routeCallback);

      const evalPromise = page.evaluate(
        (url) => fetch(url),
        fixture.server.PREFIX + "/title.html"
      );

      const route = await routePromise;
      const response = await page.request.fetch(route.request());

      expect(response.status()).toBe(200);
      expect(response.statusText()).toBe("OK");
      expect(response.ok()).toBe(true);
      expect(response.url().endsWith("/title.html")).toBe(true);
      expect(response.headers()["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headersArray().filter(({ name }) => name.toLowerCase() === "content-type")).toEqual([
        { name: "content-type", value: "text/html; charset=utf-8" }
      ]);

      await Promise.all([route.fulfill({ response }), evalPromise]);
    });
  });

  it("gives access to intercepted response body like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);

      let routeCallback!: (route: any) => void;
      const routePromise = new Promise<any>((resolve) => {
        routeCallback = resolve;
      });
      await page.route("**/simple.json", routeCallback);

      const evalPromise = page
        .evaluate((url) => fetch(url), fixture.server.PREFIX + "/simple.json")
        .catch(() => {});

      const route = await routePromise;
      const response = await page.request.fetch(route.request());

      expect(await response.text()).toBe('{"foo": "bar"}\n');

      await Promise.all([route.fulfill({ response }), evalPromise]);
    });
  });

  it("fulfills intercepted response using route.fetch alias like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/*", async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response });
      });

      const response = await page.goto(fixture.server.EMPTY_PAGE);

      expect(response!.status()).toBe(200);
      expect(response!.headers()["content-type"]).toContain("text/html");
    });
  });

  it("supports timeout option in route.fetch like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/route-fetch-slow", (_request, response) => {
        response.writeHead(200, {
          "content-length": 4096,
          "content-type": "text/html"
        });
      });
      await page.route("**/*", async (route) => {
        const error = await route.fetch({ timeout: 1000 }).catch((error) => error);
        expect(error.message).toContain("route.fetch: Timeout 1000ms exceeded");
      });

      const error = await page
        .goto(fixture.server.PREFIX + "/route-fetch-slow", { timeout: 2000 })
        .catch((error) => error);

      expect(error.message).toContain("Timeout 2000ms exceeded");
    });
  });

  it("does not follow redirects when maxRedirects is 0 in route.fetch like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRedirect("/route-fetch-max-redirects-source", "/empty.html");
      let fetchedStatus: number | undefined;
      let fetchedLocation: string | undefined;
      await page.route("**/*", async (route) => {
        const response = await route.fetch({ maxRedirects: 0 });
        fetchedLocation = response.headers().location;
        fetchedStatus = response.status();
        await route.fulfill({ body: "hello" });
      });

      await page.goto(fixture.server.PREFIX + "/route-fetch-max-redirects-source");

      expect(fetchedStatus).toBe(302);
      expect(fetchedLocation).toBe("/empty.html");
      expect(await page.content()).toContain("hello");
    });
  });

  it("supports url override in route.fetch like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/one-style-upstream.html", (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end("<!DOCTYPE html>\n<link rel='stylesheet' href='./one-style.css'>\n<div>hello, world!</div>");
      });
      await page.route("**/*.html", async (route) => {
        const response = await route.fetch({ url: fixture.server.PREFIX + "/one-style-upstream.html" });
        await route.fulfill({ response });
      });

      const response = await page.goto(fixture.server.PREFIX + "/empty.html");

      expect(response!.status()).toBe(200);
      expect((await response!.body()).toString()).toContain("one-style.css");
    });
  });

  it("supports post data override in route.fetch like Playwright", async () => {
    await withPage(async (page) => {
      const requestPromise = fixture.server.waitForRequest("/empty.html");
      await page.route("**/*.html", async (route) => {
        const response = await route.fetch({
          postData: { foo: "bar" }
        });
        await route.fulfill({ response });
      });

      await page.goto(fixture.server.PREFIX + "/empty.html");

      const request = await requestPromise;
      expect((await request.postBody).toString()).toBe(JSON.stringify({ foo: "bar" }));
    });
  });

  it("intercepts multipart/form-data request body like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/input/fileupload.html");
      await page.setInputFiles("input[type=file]", fixture.asset("file-to-upload.txt"));
      const requestPromise = new Promise<any>(async (resolve) => {
        await page.route("**/upload", (route) => {
          resolve(route.request());
        });
      });

      const [request] = await Promise.all([
        requestPromise,
        page.click("input[type=submit]", { noWaitAfter: true })
      ]);

      expect(request.method()).toBe("POST");
      expect(request.postData()).toContain("contents of the file");
    });
  });

  it("request.postData is not null when fetching FormData with a Blob like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent(`
<script>
  function doStuff() {
    const formData = new FormData();
    formData.append('file', new Blob(["hello"], { type: "text/plain" }));
    fetch('/upload', {
      method: 'POST',
      body: formData
    });
  }
</script>
<body>
<button onclick="doStuff()" data-testid="click-me">Click me!</button>
</body>`);
      let resolvePostData!: (value: string | null) => void;
      const postDataPromise = new Promise<string | null>((resolve) => {
        resolvePostData = resolve;
      });
      await page.route(fixture.server.PREFIX + "/upload", async (route, request) => {
        expect(request.method()).toBe("POST");
        resolvePostData(request.postData());
        await route.fulfill({
          body: "ok",
          status: 200
        });
      });

      await page.getByTestId("click-me").click();
      const postData = await postDataPromise;

      expect(postData).toContain('Content-Disposition: form-data; name="file"; filename="blob"');
      expect(postData).toContain("\r\nhello\r\n");
    });
  });

  it("aborts favicon requests if interception is enabled like Playwright", async () => {
    await withPage(async (page) => {
      let requestCount = 0;
      fixture.server.setRoute("/favicon.ico", (_request, response) => {
        requestCount += 1;
        response.setHeader("content-type", "text/plain");
        response.end("my content");
      });
      await page.route("**/*", async (route) => {
        await route.fulfill({
          body: "Hello, world!",
          status: 200
        });
      });

      await page.goto(fixture.server.EMPTY_PAGE);
      const response = await page.evaluate(() =>
        fetch("/favicon.ico")
          .then((response) => response.text())
          .catch(() => "load failed")
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));

      expect(response).toBe("load failed");
      expect(requestCount).toBe(0);
    });
  });
});
