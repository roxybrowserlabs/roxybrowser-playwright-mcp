import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TimeoutError } from "../../../src/errors.js";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page waitForResponse contract e2e", () => {
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
      const [response] = await Promise.all([
        page.waitForResponse(fixture.server.PREFIX + "/digits/2.png"),
        page.evaluate(() => {
          void fetch("/digits/1.png");
          void fetch("/digits/2.png");
          void fetch("/digits/3.png");
        })
      ]);
      expect(response.url()).toBe(fixture.server.PREFIX + "/digits/2.png");
    });
  });

  it("should respect timeout", async () => {
    await withPage(async (page) => {
      const error = await page
        .waitForEvent("response", { predicate: () => false, timeout: 1 })
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(TimeoutError);
    });
  });

  it("should respect default timeout", async () => {
    await withPage(async (page) => {
      page.setDefaultTimeout(1);
      const error = await page.waitForResponse(() => false).catch((caught) => caught);
      expect(error).toBeInstanceOf(TimeoutError);
      const firstFrame = String(error.stack)
        .split("\n")
        .find((line) => line.startsWith("    at "));
      expect(firstFrame).toContain("page-wait-for-response.contract.test.ts");
    });
  });

  it("should log the url", async () => {
    await withPage(async (page) => {
      const error1 = await page.waitForResponse("foo.css", { timeout: 1000 }).catch((caught) => caught);
      expect(error1.message).toContain('waiting for response "foo.css"');
      const error2 = await page.waitForResponse(/foo.css/i, { timeout: 1000 }).catch((caught) => caught);
      expect(error2.message).toContain("waiting for response /foo.css/i");
    });
  });

  it("should work with predicate", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const [response] = await Promise.all([
        page.waitForEvent("response", (response) => response.url() === fixture.server.PREFIX + "/digits/2.png"),
        page.evaluate(() => {
          void fetch("/digits/1.png");
          void fetch("/digits/2.png");
          void fetch("/digits/3.png");
        })
      ]);
      expect(response.url()).toBe(fixture.server.PREFIX + "/digits/2.png");
    });
  });

  it("should work with async predicate", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const [response1, response2] = await Promise.all([
        page.waitForEvent("response", async (response) => {
          const text = await response.text();
          return text.includes("contents of the file");
        }),
        page.waitForResponse(async (response) => {
          const text = await response.text();
          return text.includes("bar");
        }),
        page.evaluate(() => {
          void fetch("/simple.json").then((response) => response.json());
          void fetch("/file-to-upload.txt").then((response) => response.text());
        })
      ]);
      expect(response1.url()).toBe(fixture.server.PREFIX + "/file-to-upload.txt");
      expect(response2.url()).toBe(fixture.server.PREFIX + "/simple.json");
    });
  });

  it("sync predicate should be only called once", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      let counter = 0;
      const [response] = await Promise.all([
        page.waitForEvent("response", (response) => {
          ++counter;
          return response.url() === fixture.server.PREFIX + "/digits/1.png";
        }),
        page.evaluate(async () => {
          await fetch("/digits/1.png");
          await fetch("/digits/2.png");
          await fetch("/digits/3.png");
        })
      ]);
      expect(response.url()).toBe(fixture.server.PREFIX + "/digits/1.png");
      expect(counter).toBe(1);
    });
  });

  it("should work with no timeout", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const [response] = await Promise.all([
        page.waitForResponse(fixture.server.PREFIX + "/digits/2.png", { timeout: 0 }),
        page.evaluate(() => {
          window.setTimeout(() => {
            void fetch("/digits/1.png");
            void fetch("/digits/2.png");
            void fetch("/digits/3.png");
          }, 50);
        })
      ]);
      expect(response.url()).toBe(fixture.server.PREFIX + "/digits/2.png");
    });
  });
});
