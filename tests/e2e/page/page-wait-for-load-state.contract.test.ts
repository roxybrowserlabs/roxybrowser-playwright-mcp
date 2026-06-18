import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page waitForLoadState contract e2e", () => {
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

  it("picks up ongoing navigation", async () => {
    await withPage(async (page) => {
      fixture.server.setContent(
        "/wait-for-load-state.html",
        '<link rel="stylesheet" href="/slow.css"><div>hello</div>',
        "text/html"
      );
      let cssResponse: { statusCode: number; end(body?: string): void } | null = null;

      fixture.server.setRoute("/slow.css", (_request, response) => {
        cssResponse = response;
      });

      await Promise.all([
        fixture.server.waitForRequest("/slow.css"),
        page.goto(fixture.server.PREFIX + "/wait-for-load-state.html", {
          waitUntil: "domcontentloaded"
        })
      ]);

      const waitPromise = page.waitForLoadState();
      cssResponse!.statusCode = 404;
      cssResponse!.end("Not found");
      await waitPromise;
    });
  });

  it("respects timeout", async () => {
    await withPage(async (page) => {
      fixture.server.setContent(
        "/wait-for-load-state.html",
        '<link rel="stylesheet" href="/slow.css"><div>hello</div>',
        "text/html"
      );
      fixture.server.setRoute("/slow.css", () => {});
      await page.goto(fixture.server.PREFIX + "/wait-for-load-state.html", {
        waitUntil: "domcontentloaded"
      });

      const error = await page.waitForLoadState("load", { timeout: 1 }).catch((caught) => caught);
      expect(error.message).toContain("page.waitForLoadState: Timeout 1ms exceeded.");
    });
  });

  it("resolves immediately if loaded", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/one-style.html");
      await expect(page.waitForLoadState()).resolves.toBeUndefined();
    });
  });

  it("throws for bad state", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/one-style.html");
      const error = await page.waitForLoadState("bad" as never).catch((caught) => caught);
      expect(error.message).toContain("state: expected one of (load|domcontentloaded|networkidle|commit)");
    });
  });
});
