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

  it("resolves immediately if load state matches", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/one-style.css", () => {});
      await page.goto(fixture.server.PREFIX + "/one-style.html", {
        waitUntil: "domcontentloaded"
      });
      await page.waitForLoadState("domcontentloaded");
    });
  });

  it("waits for load state of about:blank popup", async () => {
    await withPage(async (page) => {
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate(() => window.open("about:blank") && 1)
      ]);
      await popup.waitForLoadState();
      expect(await popup.evaluate(() => document.readyState)).toBe("complete");
    });
  });

  it("waits for load state of about:blank popup with noopener", async () => {
    await withPage(async (page) => {
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate(() => window.open("about:blank", "_blank", "noopener") && 1)
      ]);
      await popup.waitForLoadState();
      expect(await popup.evaluate(() => document.readyState)).toBe("complete");
    });
  });

  it("waits for load state of popup with network url", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate((url) => window.open(url) && 1, fixture.server.EMPTY_PAGE)
      ]);
      await popup.waitForLoadState();
      expect(await popup.evaluate(() => document.readyState)).toBe("complete");
    });
  });

  it("waits for load state of popup with network url and noopener", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate((url) => window.open(url, "_blank", "noopener") && 1, fixture.server.EMPTY_PAGE)
      ]);
      await popup.waitForLoadState();
      expect(await popup.evaluate(() => document.readyState)).toBe("complete");
    });
  });

  it("works with clicking target=_blank", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent('<a target=_blank rel="opener" href="/one-style.html">yo</a>');
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.click("a")
      ]);
      await popup.waitForLoadState();
      expect(await popup.evaluate(() => document.readyState)).toBe("complete");
    });
  });

  it("works for frame", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/frames/one-frame.html");
      const frame = page.frames()[1]!;

      fixture.server.setRoute("/one-style.css", () => {});
      await frame.goto(fixture.server.PREFIX + "/one-style.html", {
        waitUntil: "domcontentloaded"
      });
      let resolved = false;
      const loadPromise = frame.waitForLoadState().then(() => {
        resolved = true;
      });
      await page.evaluate("1");
      expect(resolved).toBe(false);
      fixture.server.reset();
      await loadPromise;
    });
  });
});
