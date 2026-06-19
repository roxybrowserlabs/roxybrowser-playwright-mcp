import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";
import type { Page } from "../../../src/types/api.js";

describe("locator frame contract e2e", () => {
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

  async function routeIframe(page: Page) {
    await page.route("**/empty.html", (route) => {
      void route.fulfill({
        body: '<iframe src="iframe.html" name="frame1"></iframe>',
        contentType: "text/html"
      });
    });
    await page.route("**/iframe.html", (route) => {
      void route.fulfill({
        body: `
          <html>
            <div>
              <button data-testid="buttonId">Hello iframe</button>
              <iframe src="iframe-2.html"></iframe>
            </div>
            <span>1</span>
            <span>2</span>
            <label for=target>Name</label><input id=target type=text placeholder=Placeholder title=Title alt=Alternative>
          </html>`,
        contentType: "text/html"
      });
    });
    await page.route("**/iframe-2.html", (route) => {
      void route.fulfill({
        body: "<html><button>Hello nested iframe</button></html>",
        contentType: "text/html"
      });
    });
  }

  async function routeAmbiguous(page: Page) {
    await page.route("**/empty.html", (route) => {
      void route.fulfill({
        body: `<iframe src="iframe-1.html"></iframe>
               <iframe src="iframe-2.html"></iframe>
               <iframe src="iframe-3.html"></iframe>`,
        contentType: "text/html"
      });
    });
    await page.route("**/iframe-*", (route) => {
      const path = new URL(route.request().url()).pathname.slice(1);
      void route.fulfill({
        body: `<html><button>Hello from ${path}</button></html>`,
        contentType: "text/html"
      });
    });
  }

  it("should work for iframe like Playwright", async () => {
    await withPage(async (page) => {
      await routeIframe(page);
      await page.goto(fixture.server.EMPTY_PAGE);
      const button = page.frameLocator("iframe").locator("button");
      await button.waitFor();
      expect(await button.innerText()).toBe("Hello iframe");
      await button.click();
    });
  });

  it("should work for nested iframe like Playwright", async () => {
    await withPage(async (page) => {
      await routeIframe(page);
      await page.goto(fixture.server.EMPTY_PAGE);
      const button = page.frameLocator("iframe").frameLocator("iframe").locator("button");
      await button.waitFor();
      expect(await button.innerText()).toBe("Hello nested iframe");
      await button.click();
    });
  });

  it("should work for $ and $$ like Playwright", async () => {
    await withPage(async (page) => {
      await routeIframe(page);
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(await page.frameLocator("iframe").locator("button").innerText()).toBe("Hello iframe");
      expect(await page.frameLocator("iframe").locator("span").count()).toBe(2);
    });
  });

  it("locator.frameLocator should work for iframe like Playwright", async () => {
    await withPage(async (page) => {
      await routeIframe(page);
      await page.goto(fixture.server.EMPTY_PAGE);
      const button = page.locator("body").frameLocator("iframe").locator("button");
      await button.waitFor();
      expect(await button.innerText()).toBe("Hello iframe");
      await button.click();
    });
  });

  it("locator.frameLocator should throw on ambiguity like Playwright", async () => {
    await withPage(async (page) => {
      await routeAmbiguous(page);
      await page.goto(fixture.server.EMPTY_PAGE);
      const button = page.locator("body").frameLocator("iframe").locator("button");
      const error = await button.waitFor({ timeout: 1000 }).catch((e) => e);
      expect(error.message).toContain("strict mode violation");
      expect(error.message).toContain("resolved to 3 elements");
    });
  });

  it("locator.frameLocator should not throw on first/last/nth like Playwright", async () => {
    await withPage(async (page) => {
      await routeAmbiguous(page);
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(await page.locator("body").frameLocator("iframe").first().locator("button").innerText()).toBe("Hello from iframe-1.html");
      expect(await page.locator("body").frameLocator("iframe").nth(1).locator("button").innerText()).toBe("Hello from iframe-2.html");
      expect(await page.locator("body").frameLocator("iframe").last().locator("button").innerText()).toBe("Hello from iframe-3.html");
    });
  });

  it("getBy coverage should work inside frame locator like Playwright", async () => {
    await withPage(async (page) => {
      await routeIframe(page);
      await page.goto(fixture.server.EMPTY_PAGE);

      expect(await page.frameLocator("iframe").getByRole("button").innerText()).toBe("Hello iframe");
      expect(await page.frameLocator("iframe").getByText("Hello").innerText()).toBe("Hello iframe");
      expect(await page.frameLocator("iframe").getByTestId("buttonId").innerText()).toBe("Hello iframe");
      expect(await page.frameLocator("iframe").getByLabel("Name").inputValue()).toBe("");
      expect(await page.frameLocator("iframe").getByPlaceholder("Placeholder").inputValue()).toBe("");
      expect(await page.frameLocator("iframe").getByAltText("Alternative").inputValue()).toBe("");
      expect(await page.frameLocator("iframe").getByTitle("Title").inputValue()).toBe("");
    });
  });

  it("locator.contentFrame should work like Playwright", async () => {
    await withPage(async (page) => {
      await routeIframe(page);
      await page.goto(fixture.server.EMPTY_PAGE);
      const frameLocator = page.locator("iframe").contentFrame();
      const button = frameLocator.locator("button");
      expect(await button.innerText()).toBe("Hello iframe");
      await button.click();
    });
  });

  it("frameLocator.owner should work like Playwright", async () => {
    await withPage(async (page) => {
      await routeIframe(page);
      await page.goto(fixture.server.EMPTY_PAGE);
      const locator = page.frameLocator("iframe").owner();
      expect(await locator.isVisible()).toBe(true);
      expect(await locator.getAttribute("name")).toBe("frame1");
    });
  });

  it("FrameLocator.locator options should include has filters like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <iframe srcdoc="
          <section>
            <article><button>Hidden</button></article>
            <article><button>Shown</button><span>target</span></article>
          </section>
        "></iframe>
      `);

      const hasTarget = page.locator("span");
      expect(await page.frameLocator("iframe").locator("article", { has: hasTarget }).innerText()).toBe("Showntarget");
      expect(await page.frameLocator("iframe").locator("article", { hasText: "Shown" }).innerText()).toBe("Showntarget");
      expect(await page.frameLocator("iframe").locator("article", { hasNotText: "Shown" }).innerText()).toBe("Hidden");
    });
  });
});
