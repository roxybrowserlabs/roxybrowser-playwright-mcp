import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("bidi page selectors contract e2e", () => {
  it("supports Playwright :visible css pseudo-class", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`
        <button style="display: none">What's on your mind</button>
        <button>What's on your mind</button>
      `);

      const locator = page.locator(`button:has-text("What's on your mind"):visible`);
      expect(await locator.count()).toBe(1);
      expect(await locator.isVisible()).toBe(true);
    });
  });

  it("skips hidden elements in getByRole unless includeHidden is true", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`
        <button aria-label="Back to previous page" style="display: none"></button>
        <button>What's on your mind</button>
      `);

      expect(await page.getByRole("button").count()).toBe(1);
      expect(await page.getByRole("button", { includeHidden: true }).count()).toBe(2);
      expect(await page.getByRole("button").first().textContent()).toBe("What's on your mind");
    });
  });
});
