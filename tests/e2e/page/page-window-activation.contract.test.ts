import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page window activation contract e2e", () => {
  it("interacts with an initially background page without explicit activation", async () => {
    await withPage(async (foregroundPage, context) => {
      await foregroundPage.setContent("<main>Foreground work</main>");
      const backgroundPage = await context.newPage();
      await backgroundPage.setContent(`
        <button onclick="globalThis.clickCount = (globalThis.clickCount ?? 0) + 1">Click</button>
        <input aria-label="Message">
      `);

      await foregroundPage.bringToFront();
      expect(await foregroundPage.evaluate(() => document.hasFocus())).toBe(true);
      expect(await backgroundPage.evaluate(() => document.hasFocus())).toBe(false);

      await backgroundPage.getByRole("button", { name: "Click" }).click();
      await backgroundPage.getByLabel("Message").type("human");

      expect(await backgroundPage.evaluate(() => globalThis.clickCount)).toBe(1);
      expect(
        await backgroundPage.getByLabel("Message").evaluate((element) => (element as HTMLInputElement).value)
      ).toBe("human");
    });
  });
});
