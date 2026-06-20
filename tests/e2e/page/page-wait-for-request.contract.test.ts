import vm from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TimeoutError } from "../../../src/errors.js";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page waitForRequest contract e2e", () => {
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
      const [request] = await Promise.all([
        page.waitForRequest(fixture.server.PREFIX + "/digits/2.png"),
        page.evaluate(() => {
          void fetch("/digits/1.png");
          void fetch("/digits/2.png");
          void fetch("/digits/3.png");
        })
      ]);
      expect(request.url()).toBe(fixture.server.PREFIX + "/digits/2.png");
    });
  });

  it("should work with predicate", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const [request] = await Promise.all([
        page.waitForEvent("request", (request) => request.url() === fixture.server.PREFIX + "/digits/2.png"),
        page.evaluate(() => {
          void fetch("/digits/1.png");
          void fetch("/digits/2.png");
          void fetch("/digits/3.png");
        })
      ]);
      expect(request.url()).toBe(fixture.server.PREFIX + "/digits/2.png");
    });
  });

  it("should respect timeout", async () => {
    await withPage(async (page) => {
      const error = await page
        .waitForEvent("request", { predicate: () => false, timeout: 1 })
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(TimeoutError);
      expect(error.message).toContain('Timeout 1ms exceeded while waiting for event "request"');
      const firstFrame = String(error.stack)
        .split("\n")
        .find((line) => line.startsWith("    at "));
      expect(firstFrame).toContain("page-wait-for-request.contract.test.ts");
    });
  });

  it("should respect default timeout", async () => {
    await withPage(async (page) => {
      page.setDefaultTimeout(1);
      const error = await page.waitForRequest(() => false).catch((caught) => caught);
      expect(error).toBeInstanceOf(TimeoutError);
      const firstFrame = String(error.stack)
        .split("\n")
        .find((line) => line.startsWith("    at "));
      expect(firstFrame).toContain("page-wait-for-request.contract.test.ts");
    });
  });

  it("should log the url", async () => {
    await withPage(async (page) => {
      const error = await page
        .waitForRequest("long-long-long-long-long-long-long-long-long-long-long-long-long-long.css", {
          timeout: 1000
        })
        .catch((caught) => caught);
      expect(error.message).toContain(
        'waiting for request "long-long-long-long-long-long-long-long-long-long…"'
      );
    });
  });

  it("should work with no timeout", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const [request] = await Promise.all([
        page.waitForRequest(fixture.server.PREFIX + "/digits/2.png", { timeout: 0 }),
        page.evaluate(() => {
          window.setTimeout(() => {
            void fetch("/digits/1.png");
            void fetch("/digits/2.png");
            void fetch("/digits/3.png");
          }, 50);
        })
      ]);
      expect(request.url()).toBe(fixture.server.PREFIX + "/digits/2.png");
    });
  });

  it("should work with url match", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const [request] = await Promise.all([
        page.waitForRequest(/digits\/\d\.png/),
        page.evaluate(() => {
          void fetch("/digits/1.png");
        })
      ]);
      expect(request.url()).toBe(fixture.server.PREFIX + "/digits/1.png");
    });
  });

  it("should work with url match regular expression from a different context", async () => {
    await withPage(async (page) => {
      const context = vm.createContext();
      const regexp = vm.runInContext("new RegExp(/digits\\/\\d\\.png/)", context);

      await page.goto(fixture.server.EMPTY_PAGE);
      const [request] = await Promise.all([
        page.waitForRequest(regexp),
        page.evaluate(() => {
          void fetch("/digits/1.png");
        })
      ]);
      expect(request.url()).toBe(fixture.server.PREFIX + "/digits/1.png");
    });
  });
});
