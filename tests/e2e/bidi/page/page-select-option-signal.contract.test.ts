import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("page selectOption signal contract e2e (bidi/firefox)", () => {
  it("locator.selectOption should abort via signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<select><option value="one">one</option></select>`);
      const controller = new AbortController();
      const promise = page.locator("select").selectOption("two", { signal: controller.signal, timeout: 0 }).catch((error) => error);

      await page.waitForTimeout(100);
      const reason = new Error("foo bar");
      controller.abort(reason);

      const error = await promise;
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("page.selectOption should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<select><option value="one">one</option></select>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.selectOption("select", "one", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("frame.selectOption should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<select><option value="one">one</option></select>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.mainFrame().selectOption("select", "one", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("elementHandle.selectOption should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<select><option value="one">one</option></select>`);
      const select = await page.locator("select").elementHandle();
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await select.selectOption("one", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });
});
