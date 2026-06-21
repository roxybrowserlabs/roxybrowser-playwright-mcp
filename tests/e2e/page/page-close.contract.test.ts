import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

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
});
