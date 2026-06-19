import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page network sizes contract e2e", () => {
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

  it("sets request bodySize and headersSize like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/get", (_request, response) => {
        response.end("ok");
      });

      const [request] = await Promise.all([
        page.waitForEvent("request", (request) => request.url().endsWith("/get")),
        page.evaluate(() => fetch("./get", { method: "POST", body: "12345" }).then((response) => response.text()))
      ]);

      const sizes = await request.sizes();
      expect(sizes.requestBodySize).toBe(5);
      expect(sizes.requestHeadersSize).toBeGreaterThanOrEqual(250);
    });
  });

  it("sets request bodySize to 0 when there was no body like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/get", (_request, response) => {
        response.end("ok");
      });

      const [request] = await Promise.all([
        page.waitForEvent("request", (request) => request.url().endsWith("/get")),
        page.evaluate(() => fetch("./get").then((response) => response.text()))
      ]);

      const sizes = await request.sizes();
      expect(sizes.requestBodySize).toBe(0);
      expect(sizes.requestHeadersSize).toBeGreaterThanOrEqual(190);
    });
  });

  it("sets response bodySize and headersSize like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/get", (_request, response) => {
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end("abc134");
      });
      await page.goto(fixture.server.EMPTY_PAGE);

      const [response] = await Promise.all([
        page.waitForEvent("response", (response) => response.url().endsWith("/get")),
        page.evaluate(() => fetch("./get").then((response) => response.text())),
        fixture.server.waitForRequest("/get")
      ]);

      const sizes = await response.request().sizes();
      expect(sizes.responseBodySize).toBe(6);
      expect(sizes.responseHeadersSize).toBeGreaterThanOrEqual(100);
    });
  });

  it("sets response bodySize to 0 when there was no response body like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/empty-response", (_request, response) => {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-cache, no-store");
        response.end();
      });

      const response = await page.goto(fixture.server.PREFIX + "/empty-response");
      const sizes = await response!.request().sizes();

      expect(sizes.responseBodySize).toBe(0);
      expect(sizes.responseHeadersSize).toBeGreaterThanOrEqual(150);
    });
  });

  it("handles redirects like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRedirect("/foo", "/bar");
      fixture.server.setRoute("/bar", (_request, response) => response.end("bar"));
      await page.goto(fixture.server.EMPTY_PAGE);

      const [response] = await Promise.all([
        page.waitForEvent("response", (response) => response.url().endsWith("/foo")),
        page.evaluate(() => fetch("/foo", {
          method: "POST",
          body: "12345"
        }).then((response) => response.text()))
      ]);

      expect((await response.request().sizes()).requestBodySize).toBe(5);
      const newRequest = response.request().redirectedTo();
      expect(newRequest).toBeTruthy();
      expect((await newRequest!.sizes()).responseBodySize).toBe(3);
    });
  });

  it("throws for failed requests like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/one-style.css", (_request, response) => {
        response.setHeader("Content-Type", "text/css");
        response.socket?.destroy();
      });
      await page.goto(fixture.server.EMPTY_PAGE);

      const [request] = await Promise.all([
        page.waitForEvent("requestfailed", (request) => request.url().endsWith("/one-style.css")),
        page.goto(fixture.server.PREFIX + "/one-style.html")
      ]);

      await expect(request.sizes()).rejects.toThrow("Unable to fetch sizes for failed request");
    });
  });

  for (const statusCode of [200, 401, 404, 500]) {
    it(`works with ${statusCode} status code like Playwright`, async () => {
      await withPage(async (page) => {
        fixture.server.setRoute("/foo", (_request, response) => {
          response.writeHead(statusCode, {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": "3"
          });
          response.end("bar");
        });
        await page.goto(fixture.server.EMPTY_PAGE);

        const [response] = await Promise.all([
          page.waitForEvent("response", (response) => response.url().endsWith("/foo")),
          page.evaluate(() => fetch("/foo", {
            method: "POST",
            body: "12345"
          }).then((response) => response.text()))
        ]);

        expect(response.status()).toBe(statusCode);
        const sizes = await response.request().sizes();
        expect(sizes.requestBodySize).toBe(5);
        expect(sizes.responseBodySize).toBe(3);
      });
    });
  }
});
