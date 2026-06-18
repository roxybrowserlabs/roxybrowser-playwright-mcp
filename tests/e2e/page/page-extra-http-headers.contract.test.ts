import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium } from "../../../src/index.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page extra http headers contract e2e", () => {
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

  it("sends page-level extra http headers", async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.ROXY_E2E_EXECUTABLE_PATH
        ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
        : {})
    });

    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          await page.setExtraHTTPHeaders({
            "x-page-header": "page-value"
          });

          const [request] = await Promise.all([
            fixture.server.waitForRequest("/empty.html"),
            page.goto(fixture.server.EMPTY_PAGE)
          ]);

          expect(request.headers["x-page-header"]).toBe("page-value");
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

  it("overrides context extra http headers with page headers", async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.ROXY_E2E_EXECUTABLE_PATH
        ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
        : {})
    });

    try {
      const context = await browser.newContext({
        extraHTTPHeaders: {
          fOo: "bAr",
          baR: "foO"
        }
      });
      try {
        const page = await context.newPage();
        try {
          await page.setExtraHTTPHeaders({
            Foo: "Bar"
          });

          const [request] = await Promise.all([
            fixture.server.waitForRequest("/empty.html"),
            page.goto(fixture.server.EMPTY_PAGE)
          ]);

          expect(request.headers.foo).toBe("Bar");
          expect(request.headers.bar).toBe("foO");
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
