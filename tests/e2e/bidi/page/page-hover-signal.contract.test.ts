import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("page hover signal contract e2e (bidi/firefox)", () => {
  it("locator.hover should abort via signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<button style="display:none">hover me</button>`);
      const controller = new AbortController();
      const promise = page.locator("button").hover({ signal: controller.signal, timeout: 0 }).catch((error) => error);

      await page.waitForTimeout(100);
      const reason = new Error("foo bar");
      controller.abort(reason);

      const error = await promise;
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("page.hover should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<button>hover me</button>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.hover("button", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("frame.hover should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<button>hover me</button>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.mainFrame().hover("button", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("elementHandle.hover should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<button>hover me</button>`);
      const button = await page.locator("button").elementHandle();
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await button.hover({ signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });
});
