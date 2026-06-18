import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page.emulateMedia contract e2e", () => {
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

  it("emulates media type", async () => {
    await withPage(async (page) => {
      expect(await page.evaluate(() => matchMedia("screen").matches)).toBe(true);
      expect(await page.evaluate(() => matchMedia("print").matches)).toBe(false);

      await page.emulateMedia({ media: "print" });
      expect(await page.evaluate(() => matchMedia("screen").matches)).toBe(false);
      expect(await page.evaluate(() => matchMedia("print").matches)).toBe(true);

      await page.emulateMedia({});
      expect(await page.evaluate(() => matchMedia("screen").matches)).toBe(false);
      expect(await page.evaluate(() => matchMedia("print").matches)).toBe(true);

      await page.emulateMedia({ media: null });
      expect(await page.evaluate(() => matchMedia("screen").matches)).toBe(true);
      expect(await page.evaluate(() => matchMedia("print").matches)).toBe(false);
    });
  });

  it("emulates color scheme", async () => {
    await withPage(async (page) => {
      await page.emulateMedia({ colorScheme: "light" });
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches)).toBe(true);
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(false);

      await page.emulateMedia({ colorScheme: "dark" });
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches)).toBe(false);

      await page.emulateMedia({ colorScheme: null });
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(false);
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches)).toBe(true);
    });
  });

  it("emulates reduced motion", async () => {
    await withPage(async (page) => {
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: no-preference)").matches)).toBe(true);

      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: no-preference)").matches)).toBe(false);

      await page.emulateMedia({ reducedMotion: "no-preference" });
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(false);
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: no-preference)").matches)).toBe(true);
    });
  });

  it("emulates forced colors", async () => {
    await withPage(async (page) => {
      expect(await page.evaluate(() => matchMedia("(forced-colors: none)").matches)).toBe(true);

      await page.emulateMedia({ forcedColors: "active" });
      expect(await page.evaluate(() => matchMedia("(forced-colors: none)").matches)).toBe(false);
      expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);

      await page.emulateMedia({ forcedColors: null });
      expect(await page.evaluate(() => matchMedia("(forced-colors: none)").matches)).toBe(true);
    });
  });

  it("emulates contrast", async () => {
    await withPage(async (page) => {
      expect(await page.evaluate(() => matchMedia("(prefers-contrast: no-preference)").matches)).toBe(true);

      await page.emulateMedia({ contrast: "more" });
      expect(await page.evaluate(() => matchMedia("(prefers-contrast: no-preference)").matches)).toBe(false);
      expect(await page.evaluate(() => matchMedia("(prefers-contrast: more)").matches)).toBe(true);

      await page.emulateMedia({ contrast: null });
      expect(await page.evaluate(() => matchMedia("(prefers-contrast: no-preference)").matches)).toBe(true);
    });
  });
});
