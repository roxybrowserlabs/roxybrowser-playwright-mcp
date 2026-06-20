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

  it("sends page-level extra http headers with redirects", async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.ROXY_E2E_EXECUTABLE_PATH
        ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
        : {})
    });

    try {
      fixture.server.setRedirect("/foo.html", "/empty.html");

      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          await page.setExtraHTTPHeaders({
            foo: "bar"
          });

          const [request] = await Promise.all([
            fixture.server.waitForRequest("/empty.html"),
            page.goto(`${fixture.server.PREFIX}/foo.html`)
          ]);

          expect(request.headers.foo).toBe("bar");
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

  it("uses extra headers from browser context", async () => {
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
          await page.context().setExtraHTTPHeaders({
            foo: "bar"
          });

          const [request] = await Promise.all([
            fixture.server.waitForRequest("/empty.html"),
            page.goto(fixture.server.EMPTY_PAGE)
          ]);

          expect(request.headers.foo).toBe("bar");
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

  it("throws for non-string header values", async () => {
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
          const pageError = await page
            .setExtraHTTPHeaders({ foo: 1 as never })
            .catch((error: Error) => error);
          expect(pageError.message).toContain(
            'Expected value of header "foo" to be String, but "number" is found.'
          );

          const contextError = await page.context()
            .setExtraHTTPHeaders({ foo: true as never })
            .catch((error: Error) => error);
          expect(contextError.message).toContain(
            'Expected value of header "foo" to be String, but "boolean" is found.'
          );
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

  it("does not duplicate referer header", async () => {
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
            referer: fixture.server.EMPTY_PAGE
          });

          const response = await page.goto(fixture.server.EMPTY_PAGE);

          expect(response?.ok()).toBe(true);
          expect(response?.request().headers().referer).toBe(fixture.server.EMPTY_PAGE);
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
