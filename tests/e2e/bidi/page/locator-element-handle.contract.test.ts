import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("locator elementHandle contract bidi e2e", () => {
  it("elementHandle timeout 0 waits indefinitely like Playwright", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<main></main>");
      const promise = page.locator("#late").elementHandle({ timeout: 0 });

      await page.evaluate(() => {
        setTimeout(() => {
          const div = document.createElement("div");
          div.id = "late";
          div.textContent = "ready";
          document.querySelector("main")?.appendChild(div);
        }, 100);
      });

      const handle = await promise;
      await expect(handle.evaluate((element) => element.textContent)).resolves.toBe("ready");
    });
  });
});
