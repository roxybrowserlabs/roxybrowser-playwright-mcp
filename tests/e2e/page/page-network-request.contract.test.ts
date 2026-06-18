import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page network request contract e2e", () => {
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

  it("works for main frame navigation request", async () => {
    await withPage(async (page) => {
      const requests = [];
      page.on("request", (request) => requests.push(request));
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.frame()).toBe(page.mainFrame());
    });
  });

  it("works for subframe navigation request", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const requests = [];
      page.on("request", (request) => requests.push(request));
      const frameAttachedPromise = page.waitForEvent("frameattached");
      const frameNavigatedPromise = page.waitForEvent("framenavigated", (frame) => frame !== page.mainFrame());
      await page.evaluate((url) => {
        const frame = document.createElement("iframe");
        frame.src = url;
        document.body.appendChild(frame);
      }, fixture.server.EMPTY_PAGE);
      await frameAttachedPromise;
      await frameNavigatedPromise;
      expect(requests).toHaveLength(1);
      expect(requests[0]!.frame()).toBe(page.frames()[1]);
    });
  });

  it("works for fetch requests", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const requests = [];
      page.on("request", (request) => requests.push(request));
      await page.evaluate(() => fetch("/digits/1.png"));
      expect(requests).toHaveLength(1);
      expect(requests[0]!.frame()).toBe(page.mainFrame());
    });
  });

  it("works for a redirect", async () => {
    await withPage(async (page) => {
      fixture.server.setRedirect("/foo.html", "/empty.html");
      const requests = [];
      page.on("request", (request) => requests.push(request));
      await page.goto(fixture.server.PREFIX + "/foo.html");
      expect(requests).toHaveLength(2);
      expect(requests[0]!.url()).toBe(fixture.server.PREFIX + "/foo.html");
      expect(requests[1]!.url()).toBe(fixture.server.PREFIX + "/empty.html");
      expect(requests[1]!.redirectedFrom()).toBe(requests[0]);
      expect(requests[0]!.redirectedTo()).toBe(requests[1]);
    });
  });

  it("returns postData", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/post", (_request, response) => response.end());
      const requestPromise = page.waitForRequest("**/post");
      await page.evaluate(() => fetch("./post", { method: "POST", body: JSON.stringify({ foo: "bar" }) }));
      const request = await requestPromise;
      expect(request.postData()).toBe('{"foo":"bar"}');
      expect(request.postDataJSON()).toEqual({ foo: "bar" });
    });
  });

  it("works with binary post data", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/post", (_request, response) => response.end());
      const requestPromise = page.waitForRequest("**/post");
      await page.evaluate(async () => {
        await fetch("./post", { method: "POST", body: new Uint8Array(Array.from(Array(256).keys())) });
      });
      const buffer = (await requestPromise).postDataBuffer();
      expect(buffer).not.toBeNull();
      expect(buffer).toHaveLength(256);
      for (let i = 0; i < 256; ++i) {
        expect(buffer![i]).toBe(i);
      }
    });
  });

  it("works with binary post data and interception", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/post", (_request, response) => response.end());
      await page.route("**/post", (route) => route.continue());
      const requestPromise = page.waitForRequest("**/post");
      await page.evaluate(async () => {
        await fetch("./post", { method: "POST", body: new Uint8Array(Array.from(Array(256).keys())) });
      });
      const buffer = (await requestPromise).postDataBuffer();
      expect(buffer).not.toBeNull();
      expect(buffer).toHaveLength(256);
      for (let i = 0; i < 256; ++i) {
        expect(buffer![i]).toBe(i);
      }
    });
  });

  it("overrides post data content type", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      let serverRequestHeaders: Record<string, string | string[] | undefined> | null = null;
      fixture.server.setRoute("/post", (request, response) => {
        serverRequestHeaders = request.headers;
        response.end();
      });
      await page.route("**/post", (route, request) => {
        const headers = request.headers();
        headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
        void route.continue({
          headers,
          postData: request.postData()
        });
      });
      await page.evaluate(async () => {
        await fetch("./post", { method: "POST", body: "foo=bar" });
      });
      expect(serverRequestHeaders).toBeTruthy();
      expect(serverRequestHeaders!["content-type"]).toBe("application/x-www-form-urlencoded; charset=UTF-8");
    });
  });

  it("gets null with postData() and postDataJSON() when there is no post data", async () => {
    await withPage(async (page) => {
      const response = await page.goto(fixture.server.EMPTY_PAGE);
      expect(response!.request().postData()).toBe(null);
      expect(response!.request().postDataJSON()).toBe(null);
    });
  });

  it("parses form urlencoded post data", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/post", (_request, response) => response.end());
      const requestPromise = page.waitForRequest("**/post");
      await page.setContent(
        "<form method='POST' action='/post'><input type='text' name='foo' value='bar'><input type='number' name='baz' value='123'><input type='submit'></form>"
      );
      await page.click("input[type=submit]");
      expect((await requestPromise).postDataJSON()).toEqual({ foo: "bar", baz: "123" });
    });
  });

  it("parses urlencoded post data", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/post", (_request, response) => response.end());
      const requestPromise = page.waitForRequest("**/post");
      await page.evaluate(() => fetch("./post", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8"
        },
        body: "foo=bar&baz=123"
      }));
      expect((await requestPromise).postDataJSON()).toEqual({ foo: "bar", baz: "123" });
    });
  });

  it("returns navigation bit", async () => {
    await withPage(async (page) => {
      const requests = new Map<string, Awaited<ReturnType<typeof page.waitForRequest>>>();
      page.on("request", (request) => requests.set(request.url().split("/").pop()!, request));
      fixture.server.setRedirect("/rrredirect", "/frames/one-frame.html");
      await page.goto(fixture.server.PREFIX + "/rrredirect");
      expect(requests.get("rrredirect")!.isNavigationRequest()).toBe(true);
      expect(requests.get("one-frame.html")!.isNavigationRequest()).toBe(true);
      expect(requests.get("frame.html")!.isNavigationRequest()).toBe(true);
      expect(requests.get("script.js")!.isNavigationRequest()).toBe(false);
      expect(requests.get("style.css")!.isNavigationRequest()).toBe(false);
    });
  });

  it("returns navigation bit when navigating to image", async () => {
    await withPage(async (page) => {
      const requests = [];
      page.on("request", (request) => requests.push(request));
      await page.goto(fixture.server.PREFIX + "/pptr.png").catch(() => null);
      expect(requests[0]!.isNavigationRequest()).toBe(true);
    });
  });

  it("returns eventsource resource type", async () => {
    await withPage(async (page) => {
      const sseMessage = { foo: "bar" };
      fixture.server.setRoute("/sse", (_request, response) => {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
          "Cache-Control": "no-cache"
        });
        response.write(`data: ${JSON.stringify(sseMessage)}\n\n`);
      });

      await page.goto(fixture.server.EMPTY_PAGE);
      const requests = [];
      page.on("request", (request) => requests.push(request));
      expect(await page.evaluate(() => {
        const eventSource = new EventSource("/sse");
        return new Promise((resolve) => {
          eventSource.onmessage = (event) => resolve(JSON.parse(event.data));
        });
      })).toEqual(sseMessage);
      expect(requests[0]!.resourceType()).toBe("eventsource");
    });
  });

  it("reports raw headers", async () => {
    await withPage(async (page) => {
      let expectedHeaders: Array<{ name: string; value: string }> = [];
      fixture.server.setRoute("/headers", (request, response) => {
        expectedHeaders = [];
        for (let i = 0; i < request.rawHeaders.length; i += 2) {
          expectedHeaders.push({
            name: request.rawHeaders[i]!,
            value: request.rawHeaders[i + 1]!
          });
        }
        response.end();
      });

      await page.goto(fixture.server.EMPTY_PAGE);
      const [request] = await Promise.all([
        page.waitForRequest("**/*"),
        page.evaluate(() => fetch("/headers", {
          headers: [
            ["header-a", "value-a"],
            ["header-b", "value-b"],
            ["header-a", "value-a-1"],
            ["header-a", "value-a-2"]
          ]
        }))
      ]);
      const headers = await request.headersArray();
      expect(headers.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
        expectedHeaders.sort((a, b) => a.name.localeCompare(b.name))
      );
      expect(await request.headerValue("header-a")).toEqual("value-a, value-a-1, value-a-2");
      expect(await request.headerValue("not-there")).toEqual(null);
    });
  });

  it("reports raw response headers in redirects", async () => {
    await withPage(async (page) => {
      fixture.server.setExtraHeaders("/redirect/1.html", { "sec-test-header": "1.html" });
      fixture.server.setExtraHeaders("/redirect/2.html", { "sec-test-header": "2.html" });
      fixture.server.setExtraHeaders("/empty.html", { "sec-test-header": "empty.html" });
      fixture.server.setRedirect("/redirect/1.html", "/redirect/2.html");
      fixture.server.setRedirect("/redirect/2.html", "/empty.html");

      const expectedUrls = ["/redirect/1.html", "/redirect/2.html", "/empty.html"].map(
        (path) => fixture.server.PREFIX + path
      );
      const expectedHeaders = ["1.html", "2.html", "empty.html"];

      const response = await page.goto(fixture.server.PREFIX + "/redirect/1.html");
      const redirectChain: string[] = [];
      const headersChain: Array<string | undefined> = [];
      for (let request = response!.request(); request; request = request.redirectedFrom()) {
        redirectChain.unshift(request.url());
        const redirectResponse = await request.response();
        const headers = await redirectResponse!.allHeaders();
        headersChain.unshift(headers["sec-test-header"]);
      }

      expect(redirectChain).toEqual(expectedUrls);
      expect(headersChain).toEqual(expectedHeaders);
    });
  });

  it("reports all cookies in one header", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.evaluate(() => {
        document.cookie = "myCookie=myValue";
        document.cookie = "myOtherCookie=myOtherValue";
      });
      const response = await page.goto(fixture.server.EMPTY_PAGE);
      const cookie = (await response!.request().allHeaders())["cookie"];
      expect(cookie).toBe("myCookie=myValue; myOtherCookie=myOtherValue");
    });
  });

  it("page.reload returns 304 status code using Chromium semantics", async () => {
    await withPage(async (page) => {
      let requestNumber = 0;
      fixture.server.setRoute("/test.html", (_request, response) => {
        ++requestNumber;
        const headers = {
          "cf-cache-status": "DYNAMIC",
          "Content-Type": "text/html;charset=UTF-8",
          "Last-Modified": "Fri, 05 Jan 2024 01:56:20 GMT",
          Vary: "Access-Control-Request-Headers"
        };
        if (requestNumber === 1) {
          response.writeHead(200, headers);
        } else {
          response.writeHead(304, "Not Modified", headers);
        }
        response.write("<div>Test</div>");
        response.end();
      });
      const response1 = await page.goto(fixture.server.PREFIX + "/test.html");
      expect(response1!.status()).toBe(200);
      const response2 = await page.reload();
      expect(requestNumber).toBe(2);
      expect(response2!.status()).toBe(200);
      expect(response2!.statusText()).toBe("OK");
      expect(await response2!.text()).toBe("<div>Test</div>");
    });
  });
});
