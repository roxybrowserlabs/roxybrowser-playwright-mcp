import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("page drag signal contract e2e (bidi/firefox)", () => {
  it("locator.dragTo should abort via signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<div id="source" style="display:none"></div><div id="target"></div>`);
      const controller = new AbortController();
      const promise = page.locator("#source").dragTo(page.locator("#target"), { signal: controller.signal, timeout: 0 }).catch((error) => error);

      await page.waitForTimeout(100);
      const reason = new Error("foo bar");
      controller.abort(reason);

      const error = await promise;
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("page.dragAndDrop should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<div id="source" style="width:10px;height:10px"></div><div id="target" style="width:10px;height:10px"></div>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.dragAndDrop("#source", "#target", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("frame.dragAndDrop should abort via already-aborted signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent(`<div id="source" style="width:10px;height:10px"></div><div id="target" style="width:10px;height:10px"></div>`);
      const controller = new AbortController();
      const reason = new Error("Already aborted");
      controller.abort(reason);

      const error = await page.mainFrame().dragAndDrop("#source", "#target", { signal: controller.signal }).catch((caught) => caught);

      expect(error.message).toContain("The operation was aborted");
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });
});
