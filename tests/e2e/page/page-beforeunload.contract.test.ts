import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page beforeunload contract e2e", () => {
  it("surfaces beforeunload dialogs and keeps the page alive after dismiss", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <body>ready</body>
        <script>
          window.addEventListener('beforeunload', event => {
            event.preventDefault();
            event.returnValue = '';
          });
        </script>
      `);
      await page.click("body");

      const [dialog] = await Promise.all([
        page.waitForEvent("dialog"),
        page.close({ runBeforeUnload: true })
      ]);

      expect(dialog.type()).toBe("beforeunload");
      await dialog.dismiss();
      expect(page.isClosed()).toBe(false);
      expect(await page.evaluate(() => document.readyState)).toBe("complete");
    });
  });

  it("closes the page after accepting the beforeunload dialog", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <body>ready</body>
        <script>
          window.addEventListener('beforeunload', event => {
            event.preventDefault();
            event.returnValue = '';
          });
        </script>
      `);
      await page.click("body");

      const closePromise = page.waitForEvent("close");
      const [dialog] = await Promise.all([
        page.waitForEvent("dialog"),
        page.close({ runBeforeUnload: true })
      ]);

      await Promise.all([dialog.accept(), closePromise]);
      expect(page.isClosed()).toBe(true);
    });
  });
});
