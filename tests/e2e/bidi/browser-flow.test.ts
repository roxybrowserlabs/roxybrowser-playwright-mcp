import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withBidiPage } from "../../helpers/bidi.js";
import { createTestPageFixture } from "../../helpers/server.js";

describe("browser e2e (bidi/firefox)", () => {
  let fixture: Awaited<ReturnType<typeof createTestPageFixture>>;

  beforeAll(async () => {
    fixture = await createTestPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("launches firefox over bidi and drives page interactions", async () => {
    await withBidiPage(async (page, _context, browser) => {
      await page.goto(fixture.url, { waitUntil: "load" });

      expect(await browser.version()).toMatch(/firefox/i);
      expect(await page.title()).toBe("Roxy E2E");
      expect(await page.getByRole("textbox", { name: "Name" }).isVisible()).toBe(true);

      await page.fill("#name", "Roxy");
      expect(await page.locator("#status").textContent()).toBe("typing:Roxy");

      await page.getByRole("button", { name: "Send" }).click();
      expect(await page.locator("#status").textContent()).toBe("clicked:Roxy");

      await page.fill("#name", "");
      await page.type("#name", "Human", { delay: 0 });
      await page.press("#name", "Enter", { delay: 0 });

      expect(await page.locator("#status").textContent()).toBe("submitted:Human");
      expect(await page.getByText("Second item").isVisible()).toBe(true);
      expect(
        await page.evaluate<string>("() => window.location.protocol")
      ).toBe("file:");
      expect(
        await page.evaluate<string>(
          "() => document.querySelector('#status')?.textContent ?? ''"
        )
      ).toBe("submitted:Human");
    });
  });

  it("applies optional context human defaults without requiring per-call human options", async () => {
    await withBidiPage(async (_page, _context, browser) => {
      const humanContext = await browser.newContext({
        human: {
          enabled: true,
          hoverBeforeClickMs: 0,
          clickHoldMs: 0,
          typingDelayMs: 0,
          typingVarianceMs: 0
        }
      });

      try {
        const humanPage = await humanContext.newPage();
        await humanPage.goto(fixture.url, { waitUntil: "load" });
        await humanPage.fill("#name", "");
        await humanPage.type("#name", "ContextHuman");
        await humanPage.press("#name", "Enter");
        await humanPage.getByRole("button", { name: "Send" }).click();

        expect(await humanPage.locator("#status").textContent()).toBe("clicked:ContextHuman");
      } finally {
        await humanContext.close();
      }
    });
  });
});
