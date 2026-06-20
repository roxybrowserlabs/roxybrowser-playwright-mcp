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

  it("bubbles request events to browser context like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const requestPromise = page.context().waitForEvent("request", (request) =>
        request.url().endsWith("/digits/1.png")
      );
      await page.evaluate(() => fetch("/digits/1.png"));
      const request = await requestPromise;
      expect(request.frame()).toBe(page.mainFrame());
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

  it("does not expose redirect request to route interception like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRedirect("/foo.html", "/empty.html");
      const requests = [];
      await page.route("**", (route) => {
        requests.push(route.request());
        void route.continue();
      });

      await page.goto(fixture.server.PREFIX + "/foo.html");

      expect(page.url()).toBe(fixture.server.PREFIX + "/empty.html");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url()).toBe(fixture.server.PREFIX + "/foo.html");
    });
  });

  it("returns headers", async () => {
    await withPage(async (page) => {
      const response = await page.goto(fixture.server.EMPTY_PAGE);
      expect(response!.request().headers()["user-agent"]).toContain("Chrome");
    });
  });

  it("gets the same headers as the server", async () => {
    await withPage(async (page) => {
      let serverRequestHeaders: Record<string, string | string[] | undefined> | null = null;
      fixture.server.setRoute("/empty.html", (request, response) => {
        serverRequestHeaders = request.headers;
        response.end("done");
      });

      const response = await page.goto(fixture.server.PREFIX + "/empty.html");
      const headers = await response!.request().allHeaders();
      expect(headers).toEqual(serverRequestHeaders);
    });
  });

  it("gets the same headers as the server for CORS requests like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/empty.html");
      let serverRequestHeaders: Record<string, string | string[] | undefined> | null = null;
      fixture.server.setRoute("/something", (request, response) => {
        serverRequestHeaders = request.headers;
        response.writeHead(200, { "Access-Control-Allow-Origin": "*" });
        response.end("done");
      });

      const responsePromise = page.waitForEvent("response", (response) =>
        response.url() === fixture.server.CROSS_PROCESS_PREFIX + "/something"
      );
      const text = await page.evaluate(async (url) => {
        const response = await fetch(url);
        return response.text();
      }, fixture.server.CROSS_PROCESS_PREFIX + "/something");
      expect(text).toBe("done");

      const response = await responsePromise;
      const headers = await response.request().allHeaders();
      expect(headers).toEqual(serverRequestHeaders);
    });
  });

  it("does not return allHeaders until they are available", async () => {
    await withPage(async (page) => {
      let requestHeadersPromise: Promise<Record<string, string>> | undefined;
      page.on("request", (request) => {
        requestHeadersPromise = request.allHeaders();
      });
      let responseHeadersPromise: Promise<Record<string, string>> | undefined;
      page.on("response", (response) => {
        responseHeadersPromise = response.allHeaders();
      });

      let serverRequestHeaders: Record<string, string | string[] | undefined> | null = null;
      fixture.server.setRoute("/empty.html", async (request, response) => {
        serverRequestHeaders = request.headers;
        response.writeHead(200, { foo: "bar" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        response.end("done");
      });

      await page.goto(fixture.server.PREFIX + "/empty.html");
      expect(await requestHeadersPromise!).toEqual(serverRequestHeaders);
      expect((await responseHeadersPromise!)["foo"]).toBe("bar");
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

  it("returns correct postData buffer for utf-8 body like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/title.html", (_request, response) => response.end());
      const value = "baẞ";
      const [request] = await Promise.all([
        page.waitForRequest("**/title.html"),
        page.evaluate(({ url, value }) => {
          const request = new Request(url, {
            method: "POST",
            body: JSON.stringify(value)
          });
          request.headers.set("content-type", "application/json;charset=UTF-8");
          return fetch(request);
        }, { url: fixture.server.PREFIX + "/title.html", value })
      ]);

      expect(request.postDataBuffer()?.equals(Buffer.from(JSON.stringify(value), "utf-8"))).toBe(true);
      expect(request.postDataJSON()).toBe(value);
    });
  });

  it("returns post data without content-type like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/title.html", (_request, response) => response.end());
      const [request] = await Promise.all([
        page.waitForRequest("**/title.html"),
        page.evaluate((url) => {
          const request = new Request(url, {
            method: "POST",
            body: JSON.stringify({ value: 42 })
          });
          request.headers.set("content-type", "");
          return fetch(request);
        }, fixture.server.PREFIX + "/title.html")
      ]);

      expect(request.postDataJSON()).toEqual({ value: 42 });
    });
  });

  it("throws on invalid JSON in post data like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/title.html", (_request, response) => response.end());
      const [request] = await Promise.all([
        page.waitForRequest("**/title.html"),
        page.evaluate((url) => fetch(url, {
          method: "POST",
          body: "<not a json>"
        }), fixture.server.PREFIX + "/title.html")
      ]);

      expect(() => request.postDataJSON()).toThrow(
        "POST data is not a valid JSON object: <not a json>"
      );
    });
  });

  it("returns post data for PUT requests like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/title.html", (_request, response) => response.end());
      const [request] = await Promise.all([
        page.waitForRequest("**/title.html"),
        page.evaluate((url) => fetch(url, {
          method: "PUT",
          body: JSON.stringify({ value: 42 })
        }), fixture.server.PREFIX + "/title.html")
      ]);

      expect(request.postDataJSON()).toEqual({ value: 42 });
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

  it("reports main resource xhr with resource type xhr like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);

      const [request] = await Promise.all([
        page.waitForEvent("request"),
        page.evaluate(() => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", location.href, false);
          xhr.send();
        })
      ]);

      expect(request.isNavigationRequest()).toBe(false);
      expect(request.resourceType()).toBe("xhr");
    });
  });

  it("reports service worker navigation failures like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/serviceworkers/stub/sw.html");
      await page.evaluate(() => (window as typeof window & { activationPromise: Promise<void> }).activationPromise);

      const reloadResponse = await page.reload();
      expect(await page.evaluate("window.fromSW")).toBe(true);
      expect(reloadResponse!.url()).toBe(fixture.server.PREFIX + "/serviceworkers/stub/sw.html");
      await page.evaluate(() => (window as typeof window & { activationPromise: Promise<void> }).activationPromise);

      const [, failedRequest] = await Promise.all([
        page.evaluate(() => {
          window.location.href = "/serviceworkers/stub/error.html";
        }),
        page.waitForEvent("requestfailed")
      ]);

      expect(failedRequest.url()).toBe(fixture.server.PREFIX + "/serviceworkers/stub/error.html");
      expect(failedRequest.failure()!.errorText).toContain("net::ERR_FAILED");
      expect(failedRequest.serviceWorker()).toBe(null);
      expect(await failedRequest.response()).toBe(null);
    });
  });

  it("reports service worker navigation failures with routing like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/*", (route) => route.continue());
      await page.goto(fixture.server.PREFIX + "/serviceworkers/stub/sw.html");
      await page.evaluate(() => (window as typeof window & { activationPromise: Promise<void> }).activationPromise);

      const reloadResponse = await page.reload();
      expect(await page.evaluate("window.fromSW")).toBe(true);
      expect(reloadResponse!.url()).toBe(fixture.server.PREFIX + "/serviceworkers/stub/sw.html");
      await page.evaluate(() => (window as typeof window & { activationPromise: Promise<void> }).activationPromise);

      const [, failedRequest] = await Promise.all([
        page.evaluate(() => {
          window.location.href = "/serviceworkers/stub/error.html";
          return undefined;
        }),
        page.waitForEvent("requestfailed")
      ]);

      expect(failedRequest.url()).toBe(fixture.server.PREFIX + "/serviceworkers/stub/error.html");
      expect(failedRequest.failure()!.errorText).toContain("net::ERR_FAILED");
      expect(failedRequest.serviceWorker()).toBe(null);
      expect(await failedRequest.response()).toBe(null);
    });
  });

  it("fires requestfailed when intercepting race like Playwright", async () => {
    await withPage(async (page) => {
      const promise = new Promise<void>((resolve) => {
        let counter = 0;
        const failures = new Set();
        const alive = new Set();
        page.on("request", (request) => {
          expect(alive.has(request)).toBe(false);
          expect(failures.has(request)).toBe(false);
          alive.add(request);
        });
        page.on("requestfailed", (request) => {
          expect(failures.has(request)).toBe(false);
          expect(alive.has(request)).toBe(true);
          alive.delete(request);
          failures.add(request);
          if (++counter === 10) {
            resolve();
          }
        });
      });

      // Stall requests to make sure we don't get requestfinished.
      await page.route("**", () => {});

      await page.setContent(`
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <script>
          function abortAll() {
            const frames = document.querySelectorAll("iframe");
            for (const frame of frames) {
              frame.src = "about:blank";
            }
          }
          abortAll();
        </script>
      `);

      await promise;
    });
  });

  it("<picture> resource should have type image like Playwright", async () => {
    await withPage(async (page) => {
      const [request] = await Promise.all([
        page.waitForEvent("request"),
        page.setContent(`
          <picture>
            <source>
              <img src="https://www.wikipedia.org/portal/wikipedia.org/assets/img/Wikipedia-logo-v2@2x.png">
            </source>
          </picture>
        `)
      ]);

      expect(request.resourceType()).toBe("image");
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

  it("does not allow accessing frame on popup main request", async () => {
    await withPage(async (page) => {
      await page.setContent(`<a target=_blank href="${fixture.server.EMPTY_PAGE}">click me</a>`);
      const requestPromise = page.context().waitForEvent("request");
      const popupPromise = page.context().waitForEvent("page");
      const clicked = page.getByText("click me").click();
      const request = await requestPromise;

      expect(request.isNavigationRequest()).toBe(true);
      expect(() => request.frame()).toThrow("Frame for this navigation request is not available");

      const response = await request.response();
      await response!.finished();
      await popupPromise;
      await clicked;
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

  it("returns multipart/form-data", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/post", (_request, response) => response.end());
      await page.route("**/*", (route) => route.continue());
      const requestPromise = page.waitForRequest("**/post");
      await page.evaluate(async () => {
        const body = new FormData();
        body.set("name1", "value1");
        body.set("file", new File(["file-value"], "foo.txt"));
        body.set("name2", "value2");
        body.append("name2", "another-value2");
        await fetch("/post", { method: "POST", body });
      });
      const request = await requestPromise;
      const contentType = await request.headerValue("Content-Type");
      const re = /^multipart\/form-data; boundary=(.*)$/;
      expect(contentType).toMatch(re);
      const boundary = contentType!.match(re)![1]!;
      const expected = `--${boundary}\r\nContent-Disposition: form-data; name=\"name1\"\r\n\r\nvalue1\r\n--${boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"foo.txt\"\r\nContent-Type: application/octet-stream\r\n\r\nfile-value\r\n--${boundary}\r\nContent-Disposition: form-data; name=\"name2\"\r\n\r\nvalue2\r\n--${boundary}\r\nContent-Disposition: form-data; name=\"name2\"\r\n\r\nanother-value2\r\n--${boundary}--\r\n`;
      expect(request.postDataBuffer()!.toString("utf8")).toBe(expected);
    });
  });
});
