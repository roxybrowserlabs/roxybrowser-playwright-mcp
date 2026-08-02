import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";
import { createHistoryPageFixture } from "../../../helpers/server.js";

describe("page.request cookies e2e (bidi/firefox)", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("shares browser context cookies with API requests in a real Firefox BiDi browser", async () => {
    fixture.server.setRoute("/echo-cookie", (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
    });
    fixture.server.setRoute("/set-cookie-from-api", (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "api_cookie=from-api; Path=/"
      });
      response.end(JSON.stringify({ ok: true }));
    });

    await withBidiPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      await page.evaluate("() => { document.cookie = 'browser_cookie=from-page; Path=/'; }");

      const response = await page.context().request.get(`${fixture.server.PREFIX}/echo-cookie`);
      expect(await response.json()).toEqual({
        cookie: "browser_cookie=from-page"
      });

      await page.context().request.get(`${fixture.server.PREFIX}/set-cookie-from-api`);
      expect(await page.evaluate("() => document.cookie")).toContain("api_cookie=from-api");
    });
  });
});
