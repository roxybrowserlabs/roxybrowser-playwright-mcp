import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("page type signal contract e2e (bidi/firefox)", () => {
  it("locator.type should abort via signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<input>`);
      const controller = new AbortController();
      const promise = page.locator("input").type("ab", { delay: 1_000, signal: controller.signal }).catch((error) => error);

      await page.waitForTimeout(100);
      const reason = new Error("foo bar");
      controller.abort(reason);

      const error = await promise;
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("page.type should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<input>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.type("input", "value", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
      expect(await page.locator("input").inputValue()).toBe("");
    });
  });

  it("frame.type should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<input>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.mainFrame().type("input", "value", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
      expect(await page.locator("input").inputValue()).toBe("");
    });
  });

  it("elementHandle.type should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<input>`);
      const input = await page.locator("input").elementHandle();
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await input.type("value", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
      expect(await page.locator("input").inputValue()).toBe("");
    });
  });
});
