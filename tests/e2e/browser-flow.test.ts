import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "../../src/index.js";
import { createTestPageFixture } from "../helpers/server.js";

describe("browser e2e", () => {
  let fixture: Awaited<ReturnType<typeof createTestPageFixture>>;

  beforeAll(async () => {
    fixture = await createTestPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("launches a real browser and drives page interactions through CDP", async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.ROXY_E2E_EXECUTABLE_PATH
        ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
        : {}),
      human: {
        hoverBeforeClickMs: 0,
        clickHoldMs: 0,
        typingDelayMs: 0,
        typingVarianceMs: 0
      }
    });

    try {
      const context = await browser.newContext({
        viewport: {
          width: 1280,
          height: 720
        }
      });

      try {
        const page = await context.newPage();

        try {
          await page.goto(fixture.url, { waitUntil: "load" });

          expect(await browser.version()).toMatch(/Chrome|HeadlessChrome|Edg/);
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
            await page.evaluate<string>(
              "() => window.location.protocol"
            )
          ).toBe("file:");
          expect(
            await page.evaluate<string>(
              "() => document.querySelector('#status')?.textContent ?? ''"
            )
          ).toBe("submitted:Human");
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

  it("applies optional context human defaults without requiring per-call human options", async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.ROXY_E2E_EXECUTABLE_PATH
        ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
        : {})
    });

    try {
      const context = await browser.newContext({
        human: {
          enabled: true,
          hoverBeforeClickMs: 0,
          clickHoldMs: 0,
          typingDelayMs: 0,
          typingVarianceMs: 0
        }
      });

      try {
        const page = await context.newPage();

        try {
          await page.goto(fixture.url, { waitUntil: "load" });
          await page.fill("#name", "");
          await page.type("#name", "ContextHuman");
          await page.press("#name", "Enter");
          await page.getByRole("button", { name: "Send" }).click();

          expect(await page.locator("#status").textContent()).toBe("clicked:ContextHuman");
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
