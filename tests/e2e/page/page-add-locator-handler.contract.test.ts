import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page addLocatorHandler contract e2e", () => {
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

  it("runs the locator handler before an action blocked by an interstitial", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/input/handle-locator.html");

      let beforeCount = 0;
      let afterCount = 0;
      const originalLocator = page.getByText("This interstitial covers the button");
      await page.addLocatorHandler(originalLocator, async (locatorArgument) => {
        expect(locatorArgument).toBe(originalLocator);
        beforeCount++;
        await page.locator("#close").click();
        afterCount++;
      });

      await page.locator("#aside").hover();
      await page.evaluate(() => {
        window.clicked = 0;
        window.setupAnnoyingInterstitial("none", 1);
      });

      await page.locator("#target").click();

      expect(beforeCount).toBe(1);
      expect(afterCount).toBe(1);
      expect(await page.evaluate(() => window.clicked)).toBe(1);
      expect(await page.locator("#interstitial").isVisible()).toBe(false);
    });
  });

  it("supports a custom check with noWaitAfter", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/input/handle-locator.html");

      await page.addLocatorHandler(page.locator("body"), async () => {
        if (await page.getByText("This interstitial covers the button").isVisible()) {
          await page.locator("#close").click();
        }
      }, { noWaitAfter: true });

      await page.locator("#aside").hover();
      await page.evaluate(() => {
        window.clicked = 0;
        window.setupAnnoyingInterstitial("remove", 1);
      });

      await page.locator("#target").click();

      expect(await page.evaluate(() => window.clicked)).toBe(1);
      expect(await page.locator("#interstitial").isVisible()).toBe(false);
    });
  });

  it("does not run locator handlers for force actions", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/input/handle-locator.html");

      let called = 0;
      await page.addLocatorHandler(page.getByText("This interstitial covers the button"), async () => {
        called++;
        await page.locator("#close").click();
      });

      await page.locator("#aside").hover();
      await page.evaluate(() => {
        window.setupAnnoyingInterstitial("none", 1);
      });

      await page.locator("#target").click({ force: true, timeout: 2000 });

      expect(called).toBe(0);
      expect(await page.locator("#interstitial").isVisible()).toBe(true);
      expect(await page.evaluate(() => window.clicked)).toBe(undefined);
    });
  });

  it("supports the times option", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/input/handle-locator.html");

      let called = 0;
      await page.addLocatorHandler(page.locator("body"), async () => {
        called++;
      }, { noWaitAfter: true, times: 2 });

      await page.locator("#aside").hover();
      await page.evaluate(() => {
        window.clicked = 0;
        window.setupAnnoyingInterstitial("mouseover", 4);
      });

      const error = await page.locator("#target").click({ timeout: 3000 }).catch((caught) => caught);

      expect(called).toBe(2);
      expect(await page.evaluate(() => window.clicked)).toBe(0);
      expect(await page.locator("#interstitial").isVisible()).toBe(true);
      expect(error.message).toContain("Timeout 3000ms exceeded");
    });
  });

  it("removes locator handlers", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/input/handle-locator.html");

      let called = 0;
      const closeButton = page.getByRole("button", { name: "Close the interstitial" });
      await page.addLocatorHandler(closeButton, async (locator) => {
        called++;
        await locator.click();
      });

      await page.evaluate(() => {
        window.clicked = 0;
        window.setupAnnoyingInterstitial("hide", 1);
      });
      await page.locator("#target").click();
      expect(called).toBe(1);
      expect(await page.evaluate(() => window.clicked)).toBe(1);
      expect(await page.locator("#interstitial").isVisible()).toBe(false);

      await page.evaluate(() => {
        window.clicked = 0;
        window.setupAnnoyingInterstitial("hide", 1);
      });
      await page.removeLocatorHandler(closeButton);

      const error = await page.locator("#target").click({ timeout: 3000 }).catch((caught) => caught);

      expect(called).toBe(1);
      expect(await page.evaluate(() => window.clicked)).toBe(0);
      expect(await page.locator("#interstitial").isVisible()).toBe(true);
      expect(error.message).toContain("Timeout 3000ms exceeded");
    });
  });
});
