import type { ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TimeoutError } from "../../../src/errors.js";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

const expectedOutput = "<html><head></head><body><div>hello</div></body></html>";

describe("page setContent contract e2e", () => {
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
      await page.setContent("<div>hello</div>");
      expect(await page.content()).toBe(expectedOutput);
    });
  });

  it("should work with domcontentloaded", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>hello</div>", { waitUntil: "domcontentloaded" });
      expect(await page.content()).toBe(expectedOutput);
    });
  });

  it("should work with commit", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>hello</div>", { waitUntil: "commit" });
      expect(await page.content()).toBe(expectedOutput);
    });
  });

  it("should work with doctype", async () => {
    await withPage(async (page) => {
      const doctype = "<!DOCTYPE html>";
      await page.setContent(`${doctype}<div>hello</div>`);
      expect(await page.content()).toBe(`${doctype}${expectedOutput}`);
    });
  });

  it("should work with HTML 4 doctype", async () => {
    await withPage(async (page) => {
      const doctype = '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" ' +
        '"http://www.w3.org/TR/html4/strict.dtd">';
      await page.setContent(`${doctype}<div>hello</div>`);
      expect(await page.content()).toBe(`${doctype}${expectedOutput}`);
    });
  });

  it("should respect timeout", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/img.png", () => {});
      const error = await page.setContent(
        `<img src="${fixture.server.PREFIX}/img.png"></img>`,
        { timeout: 1 }
      ).catch((caught) => caught);
      expect(error).toBeInstanceOf(TimeoutError);
      expect(error.message).toContain("Timeout 1ms exceeded");
    });
  });

  it("should respect default navigation timeout", async () => {
    await withPage(async (page) => {
      page.setDefaultNavigationTimeout(1);
      fixture.server.setRoute("/img.png", () => {});
      const error = await page.setContent(`<img src="${fixture.server.PREFIX}/img.png"></img>`)
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(TimeoutError);
      expect(error.message).toContain("Timeout 1ms exceeded");
    });
  });

  it("should await resources to load", async () => {
    await withPage(async (page) => {
      let imgResponse: ServerResponse | null = null;
      fixture.server.setRoute("/img.png", (_request, response) => {
        imgResponse = response;
      });

      let loaded = false;
      const contentPromise = page.setContent(`<img src="${fixture.server.PREFIX}/img.png"></img>`)
        .then(() => {
          loaded = true;
        });

      await fixture.server.waitForRequest("/img.png");
      expect(loaded).toBe(false);
      imgResponse!.end();
      await contentPromise;
      expect(loaded).toBe(true);
    });
  });

  it("should work fast enough", async () => {
    await withPage(async (page) => {
      for (let index = 0; index < 20; index += 1) {
        await page.setContent("<div>yo</div>");
      }
    });
  });

  it("should work with tricky content", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>hello world</div>" + "\x7F");
      expect(await page.$eval("div", (div) => div.textContent)).toBe("hello world");
    });
  });

  it("should work with accents", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>aberración</div>");
      expect(await page.$eval("div", (div) => div.textContent)).toBe("aberración");
    });
  });

  it("should work with emojis", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>🐥</div>");
      expect(await page.$eval("div", (div) => div.textContent)).toBe("🐥");
    });
  });

  it("should work with newline", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>\n</div>");
      expect(await page.$eval("div", (div) => div.textContent)).toBe("\n");
    });
  });
});
