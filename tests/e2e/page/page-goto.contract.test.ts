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

  it("should work when page calls history API in beforeunload", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.evaluate(() => {
        window.addEventListener(
          "beforeunload",
          () => history.replaceState(null, "initial", window.location.href),
          false
        );
      });
      const response = await page.goto(fixture.server.PREFIX + "/grid.html");
      expect(response!.status()).toBe(200);
    });
  });

  it("should fail when server returns 204", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/empty.html", (_request, response) => {
        response.statusCode = 204;
        response.end();
      });
      const error = await page.goto(fixture.server.EMPTY_PAGE).catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("net::ERR_ABORTED");
    });
  });

  it("should fail when navigating to bad url", async () => {
    await withPage(async (page) => {
      const error = await page.goto("asdfasdf").catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("Cannot navigate to invalid URL");
    });
  });

  it("should not throw if networkidle0 is passed as an option", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE, {
        waitUntil: "networkidle0" as never
      });
    });
  });

  it("should throw if networkidle2 is passed as an option", async () => {
    await withPage(async (page) => {
      const error = await page
        .goto(fixture.server.EMPTY_PAGE, {
          waitUntil: "networkidle2" as never
        })
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("waitUntil: expected one of (load|domcontentloaded|networkidle|commit)");
    });
  });

  it("should fail when main resources failed to load", async () => {
    await withPage(async (page) => {
      const error = await page
        .goto("http://localhost:44123/non-existing-url")
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("net::ERR_CONNECTION_REFUSED");
    });
  });

  it("should fail when exceeding maximum navigation timeout", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/empty.html", () => {});
      const error = await page
        .goto(fixture.server.PREFIX + "/empty.html", {
          timeout: 1
        })
        .catch((caught) => caught);
      expect(error.message).toContain("Timeout 1ms exceeded.");
      expect(error.message).toContain(fixture.server.PREFIX + "/empty.html");
    });
  });

  it("should prioritize default navigation timeout over default timeout", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/empty.html", () => {});
      page.setDefaultTimeout(0);
      page.setDefaultNavigationTimeout(1);
      const error = await page.goto(fixture.server.PREFIX + "/empty.html").catch((caught) => caught);
      expect(error.message).toContain("page.goto: Timeout 1ms exceeded.");
      expect(error.message).toContain(fixture.server.PREFIX + "/empty.html");
    });
  });

  it("should disable timeout when its set to 0", async () => {
    await withPage(async (page) => {
      let error: Error | null = null;
      let loaded = false;
      page.once("load", () => {
        loaded = true;
      });
      await page
        .goto(fixture.server.PREFIX + "/grid.html", {
          timeout: 0,
          waitUntil: "load"
        })
        .catch((caught) => {
          error = caught;
        });
      expect(error).toBe(null);
      expect(loaded).toBe(true);
    });
  });

  it("should work when navigating to data url", async () => {
    await withPage(async (page) => {
      const response = await page.goto("data:text/html,hello");
      expect(response).toBe(null);
    });
  });

  it("should navigate to dataURL and not fire dataURL requests", async () => {
    await withPage(async (page) => {
      const requests: Array<{ url(): string }> = [];
      page.on("request", (request) => requests.push(request));
      const dataURL = "data:text/html,<div>yo</div>";
      const response = await page.goto(dataURL);
      expect(response).toBe(null);
      expect(requests.length).toBe(0);
    });
  });

  it("should navigate to URL with hash and fire requests without hash", async () => {
    await withPage(async (page) => {
      const requests: Array<{ url(): string }> = [];
      page.on("request", (request) => requests.push(request));
      const response = await page.goto(fixture.server.EMPTY_PAGE + "#hash");
      expect(response!.status()).toBe(200);
      expect(response!.url()).toBe(fixture.server.EMPTY_PAGE);
      expect(requests.length).toBe(1);
      expect(requests[0]!.url()).toBe(fixture.server.EMPTY_PAGE);
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
