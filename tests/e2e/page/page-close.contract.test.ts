import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

describe("page close contract e2e", () => {
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

  it("passes self to the close event like Playwright", async () => {
    await withPage(async (page) => {
      const [closedPage] = await Promise.all([
        page.waitForEvent("close"),
        page.close()
      ]);

      expect(closedPage).toBe(page);
    });
  });

  it("sets the page close state like Playwright", async () => {
    await withPage(async (page) => {
      expect(page.isClosed()).toBe(false);
      await page.close();
      expect(page.isClosed()).toBe(true);
    });
  });

  it("is callable multiple times like Playwright", async () => {
    await withPage(async (page) => {
      await Promise.all([
        page.close(),
        page.close()
      ]);

      await expect(page.close()).resolves.toBeUndefined();
    });
  });

  it("returns null from popup.opener() after parent page closes", async () => {
    await withPage(async (page) => {
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate(() => {
          window.open("about:blank");
        })
      ]);

      expect(await popup.opener()).toBe(page);

      await page.close();

      expect(await popup.opener()).toBeNull();
    });
  });

  it("rejects waitForEvent promises with a closed error after page.close", async () => {
    await withPage(async (page) => {
      let error: Error | null = null;
      const waitForPromise = page.waitForEvent("download").catch((caught) => {
        error = caught as Error;
      });

      await page.close();
      await waitForPromise;

      expect(error).toBeTruthy();
      expect(error!.message).toContain("Target page, context or browser has been closed");
    });
  });

  it("terminates request and response waiters without timing out", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);

      const [requestError, responseError] = await Promise.all([
        page.waitForRequest(fixture.server.EMPTY_PAGE).catch((error) => error as Error),
        page.waitForResponse(fixture.server.EMPTY_PAGE).catch((error) => error as Error),
        page.close()
      ]);

      expect(requestError.message).toContain("Target page, context or browser has been closed");
      expect(requestError.message).not.toContain("Timeout");
      expect(responseError.message).toContain("Target page, context or browser has been closed");
      expect(responseError.message).not.toContain("Timeout");
    });
  });

  it("rejects pending page promises when the page closes", async () => {
    await withPage(async (page) => {
      let error: Error | null = null;

      await Promise.all([
        page.evaluate(() => new Promise(() => {})).catch((caught) => {
          error = caught as Error;
        }),
        page.close()
      ]);

      expect(error).toBeTruthy();
      expect(error!.message).toContain("Target page, context or browser has been closed");
    });
  });

  it("does not treat popup navigations as new popups", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent('<a target=_blank rel=noopener href="/one-style.html">yo</a>');

      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.click("a")
      ]);

      let badSecondPopup = false;
      page.on("popup", () => {
        badSecondPopup = true;
      });

      await popup.goto(fixture.server.CROSS_PROCESS_PREFIX + "/empty.html");
      await page.close();

      expect(badSecondPopup).toBe(false);
    });
  });

  it("interrupts request.response() when the page closes", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/one-style.css", (_request, response) => {
        response.setHeader("Content-Type", "text/css");
      });

      const requestPromise = page.waitForRequest("**/one-style.css");
      await page.goto(fixture.server.PREFIX + "/one-style.html", {
        waitUntil: "domcontentloaded"
      });
      const request = await requestPromise;

      const responsePromise = request.response().catch((error) => error as Error);
      const headersPromise = request.allHeaders().catch((error) => error as Error);

      await page.close();

      expect((await responsePromise).message).toContain("Target page, context or browser has been closed");
      expect((await headersPromise).message).toContain("Target page, context or browser has been closed");
    });
  });

  it("rejects response.finished() when the page closes", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/get", (_request, response) => {
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.write("hello ");
      });

      const [pageResponse] = await Promise.all([
        page.waitForEvent("response"),
        page.evaluate(() => fetch("./get", { method: "GET" }))
      ]);

      const finishedPromise = pageResponse.finished().catch((error) => error as Error);
      await page.close();

      expect((await finishedPromise).message).toContain("closed");
    });
  });

  it("does not surface unhandled promise rejections when closing during mouse actions", async () => {
    await withPage(async (page) => {
      await Promise.all([
        page.close(),
        page.mouse.click(1, 2)
      ]).catch((error) => error);
    });
  });

  it("closes cleanly with an active dialog like Playwright", async () => {
    await withPage(async (page) => {
      await page.evaluate('"trigger builtins.setTimeout"');
      await page.setContent("<button onclick=\"builtins.setTimeout(() => alert(1))\">alert</button>");
      void page.click("button").catch(() => {});
      await page.waitForEvent("dialog");
      await expect(page.close()).resolves.toBeUndefined();
    });
  });

  it("does not report timeout wording when expect polling is interrupted by page.close", async () => {
    await withPage(async (page) => {
      await page.setContent("<div id=node>Text content</div>");

      const [error] = await Promise.all([
        expect(page.locator("div")).toHaveText("hey", { timeout: 100000 }).catch((caught) => caught as Error),
        page.close()
      ]);

      expect(stripAnsi(error.message)).toContain("expected locator text to be");
      expect(stripAnsi(error.message)).not.toContain("Timed out");
      expect(stripAnsi(error.message)).toContain("Target page, context or browser has been closed");
    });
  });

  it("propagates custom close reasons through locator handlers like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/input/handle-locator.html");

      await page.addLocatorHandler(page.getByText("This interstitial covers the button"), async () => {
        await page.close({ reason: "custom reason" });
      });

      await page.locator("#aside").hover();
      await page.evaluate(() => {
        window.clicked = 0;
        window.setupAnnoyingInterstitial("mouseover", 1);
      });

      const error = await page.locator("#target").click().catch((caught) => caught as Error);
      expect(error.message).toContain("custom reason");
    });
  });

  it("does not result in unhandled rejection when exposeFunction closes the page", async () => {
    await withPage(async (page) => {
      const closedPromise = page.waitForEvent("close");
      await page.exposeFunction("foo", async () => {
        await page.close();
      });
      await page.evaluate(() => {
        window.builtins.setTimeout(() => window["foo"](), 0);
        return undefined;
      });
      await closedPromise;
      expect(await page.evaluate("1 + 1").catch((error) => error)).toBeInstanceOf(Error);
    });
  });

  it("does not throw when continuing while the page is closing", async () => {
    await withPage(async (page) => {
      let done: Promise<unknown> | undefined;
      await page.route("**/*", async (route) => {
        done = Promise.all([
          route.continue(),
          page.close()
        ]);
      });

      await page.goto(fixture.server.EMPTY_PAGE).catch((error) => error);
      await done;
    });
  });

  it("does not throw when continuing after the page is closed", async () => {
    await withPage(async (page) => {
      let done: Promise<unknown> | undefined;
      await page.route("**/*", async (route) => {
        await page.close();
        done = route.continue();
      });

      const error = await page.goto(fixture.server.EMPTY_PAGE).catch((caught) => caught);
      await done;
      expect(error).toBeInstanceOf(Error);
    });
  });
});
