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
});
