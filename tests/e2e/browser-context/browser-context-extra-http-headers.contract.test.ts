import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestBrowser } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("browser context extra http headers contract e2e", () => {
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

  it("sends runtime context extra http headers", async () => {
    const browser = await connectTestBrowser();

    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
        await context.setExtraHTTPHeaders({
          "x-custom-header": "custom!"
        });

          const [request] = await Promise.all([
            fixture.server.waitForRequest("/empty.html"),
            page.goto(fixture.server.EMPTY_PAGE)
          ]);

          expect(request.headers["x-custom-header"]).toBe("custom!");
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
});
