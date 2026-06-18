import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page goto contract e2e", () => {
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

  it("should work", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(page.url()).toBe(fixture.server.EMPTY_PAGE);
    });
  });

  it("should work with file URL", async () => {
    await withPage(async (page) => {
      const fileUrl = pathToFileURL(fixture.asset("empty.html")).href;
      await page.goto(fileUrl);
      expect(page.url().toLowerCase()).toBe(fileUrl.toLowerCase());
      expect(page.frames().length).toBe(1);
    });
  });

  it("should work with file URL with subframes", async () => {
    await withPage(async (page) => {
      const fileUrl = pathToFileURL(fixture.asset("frames/two-frames.html")).href;
      await page.goto(fileUrl);
      expect(page.url().toLowerCase()).toBe(fileUrl.toLowerCase());
      expect(page.frames().length).toBe(3);
    });
  });

  it("should use http for no protocol", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE.substring("http://".length));
      expect(page.url()).toBe(fixture.server.EMPTY_PAGE);
    });
  });

  it("should work with anchor navigation", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(page.url()).toBe(fixture.server.EMPTY_PAGE);
      await page.goto(fixture.server.EMPTY_PAGE + "#foo");
      expect(page.url()).toBe(fixture.server.EMPTY_PAGE + "#foo");
      await page.goto(fixture.server.EMPTY_PAGE + "#bar");
      expect(page.url()).toBe(fixture.server.EMPTY_PAGE + "#bar");
    });
  });

  it("should work with redirects", async () => {
    await withPage(async (page) => {
      fixture.server.setRedirect("/redirect/1.html", "/redirect/2.html");
      fixture.server.setRedirect("/redirect/2.html", "/empty.html");
      const response = await page.goto(fixture.server.PREFIX + "/redirect/1.html");
      expect(response!.status()).toBe(200);
      expect(page.url()).toBe(fixture.server.EMPTY_PAGE);
    });
  });

  it("should navigate to about:blank", async () => {
    await withPage(async (page) => {
      const response = await page.goto("about:blank");
      expect(response).toBe(null);
    });
  });

  it("should return response when page changes its URL after load", async () => {
    await withPage(async (page) => {
      const response = await page.goto(fixture.server.PREFIX + "/historyapi.html");
      expect(response!.status()).toBe(200);
    });
  });

  it("should work with subframes return 204", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/frames/frame.html", (_request, response) => {
        response.statusCode = 204;
        response.end();
      });
      await page.goto(fixture.server.PREFIX + "/frames/one-frame.html");
    });
  });

  it("should work with subframes return 204 with domcontentloaded", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/frames/frame.html", (_request, response) => {
        response.statusCode = 204;
        response.end();
      });
      await page.goto(fixture.server.PREFIX + "/frames/one-frame.html", {
        waitUntil: "domcontentloaded"
      });
    });
  });

  it("should navigate to empty page with domcontentloaded", async () => {
    await withPage(async (page) => {
      const response = await page.goto(fixture.server.EMPTY_PAGE, {
        waitUntil: "domcontentloaded"
      });
      expect(response!.status()).toBe(200);
    });
  });

  it("should work when navigating to data url", async () => {
    await withPage(async (page) => {
      const response = await page.goto("data:text/html,hello");
      expect(response).toBe(null);
    });
  });

  it("should work when navigating to 404", async () => {
    await withPage(async (page) => {
      const response = await page.goto(fixture.server.PREFIX + "/not-found");
      expect(response!.ok()).toBe(false);
      expect(response!.status()).toBe(404);
    });
  });

  it("should return last response in redirect chain", async () => {
    await withPage(async (page) => {
      fixture.server.setRedirect("/redirect/1.html", "/redirect/2.html");
      fixture.server.setRedirect("/redirect/2.html", "/redirect/3.html");
      fixture.server.setRedirect("/redirect/3.html", fixture.server.EMPTY_PAGE);
      const response = await page.goto(fixture.server.PREFIX + "/redirect/1.html");
      expect(response!.ok()).toBe(true);
      expect(response!.url()).toBe(fixture.server.EMPTY_PAGE);
    });
  });
});
