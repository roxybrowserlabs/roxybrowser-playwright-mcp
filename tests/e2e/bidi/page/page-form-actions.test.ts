import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("page form action e2e (bidi/firefox)", () => {
  it("checks, unchecks, and honors matching state", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`
        <input id="target" type="checkbox" onclick="window.clicks = (window.clicks || 0) + 1">
      `);

      await page.check("#target");
      expect(await page.evaluate(() => target.checked)).toBe(true);
      expect(await page.evaluate(() => window.clicks)).toBe(1);

      await page.check("#target");
      expect(await page.evaluate(() => target.checked)).toBe(true);
      expect(await page.evaluate(() => window.clicks)).toBe(1);

      await page.uncheck("#target");
      expect(await page.evaluate(() => target.checked)).toBe(false);
      expect(await page.evaluate(() => window.clicks)).toBe(2);
    });
  });

  it("honors trial and supports element handle check", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`
        <input id="target" type="checkbox" onclick="window.clicks = (window.clicks || 0) + 1">
      `);

      await page.check("#target", { trial: true });
      expect(await page.evaluate(() => target.checked)).toBe(false);
      expect(await page.evaluate(() => window.clicks || 0)).toBe(0);

      const input = await page.$("#target");
      await input!.check();
      expect(await page.evaluate(() => target.checked)).toBe(true);
      expect(await page.evaluate(() => window.clicks)).toBe(1);

      await input!.uncheck();
      expect(await page.evaluate(() => target.checked)).toBe(false);
      expect(await page.evaluate(() => window.clicks)).toBe(2);
    });
  });
});
