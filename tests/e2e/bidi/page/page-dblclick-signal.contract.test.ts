import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("page dblclick signal contract e2e (bidi/firefox)", () => {
  it("locator.dblclick should abort via signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<button style="display:none">double click me</button>`);
      const controller = new AbortController();
      const promise = page.locator("button").dblclick({ signal: controller.signal, timeout: 0 }).catch((error) => error);

      await page.waitForTimeout(100);
      const reason = new Error("foo bar");
      controller.abort(reason);

      const error = await promise;
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("page.dblclick should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<button>double click me</button>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.dblclick("button", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("frame.dblclick should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<button>double click me</button>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.mainFrame().dblclick("button", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("elementHandle.dblclick should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<button>double click me</button>`);
      const button = await page.locator("button").elementHandle();
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await button.dblclick({ signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });
});
