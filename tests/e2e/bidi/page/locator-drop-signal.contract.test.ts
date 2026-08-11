import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("locator drop signal contract e2e (bidi/firefox)", () => {
  it("should abort via signal", async () => {
    await withBidiPage(async (page) => {
      const controller = new AbortController();
      const promise = page.locator("#dropzone").drop({ data: { "text/plain": "hello" } }, { signal: controller.signal, timeout: 0 }).catch((error) => error);

      await page.waitForTimeout(100);
      const reason = new Error("foo bar");
      controller.abort(reason);

      const error = await promise;
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<div id="dropzone"></div>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.locator("#dropzone").drop({ data: { "text/plain": "hello" } }, { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });
});
