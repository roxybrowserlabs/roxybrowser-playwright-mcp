import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page basic contract e2e", () => {
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

  it("keeps page.url in sync with hash navigations", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE + "#hash");
      expect(await page.url()).toBe(fixture.server.EMPTY_PAGE + "#hash");

      await page.evaluate(() => {
        window.location.hash = "dynamic";
      });

      expect(await page.url()).toBe(fixture.server.EMPTY_PAGE + "#dynamic");
    });
  });

  it("returns the page title", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/title.html");
      expect(await page.title()).toBe("Woof-Woof");
    });
  });

  it("emits close on popups closed via window.close()", async () => {
    await withPage(async (page) => {
      const popupPromise = page.waitForEvent("popup");
      await page.evaluate(() => {
        window.__newPage = window.open("about:blank");
      });
      const popup = await popupPromise;

      const closePromise = popup.waitForEvent("close");
      await page.evaluate(() => {
        window.__newPage.close();
      });

      await expect(closePromise).resolves.toBe(popup);
    });
  });

  it("has navigator.webdriver set to true", async () => {
    await withPage(async (page) => {
      expect(await page.evaluate(() => navigator.webdriver)).toBe(true);
    });
  });
});
