import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("locator waitForFunction contract e2e (bidi/firefox)", () => {
  it("should return immediately when already truthy", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div id=target>yes</div>");
      expect(await page.locator("#target").waitForFunction((element) => element.textContent === "yes")).toBe(undefined);
    });
  });

  it("should accept string expression", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div id=target>yes</div>");
      await page.locator("#target").waitForFunction(`element => element.textContent === 'yes'`);
    });
  });

  it("should abort via signal", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div id=target>no</div>");
      const controller = new AbortController();
      const promise = page.locator("#target").waitForFunction((element) => element.textContent === "yes", undefined, { timeout: 0, signal: controller.signal }).catch((caught) => caught);

      await page.waitForTimeout(100);
      const reason = new Error("Aborted by user");
      controller.abort(reason);

      const error = await promise;
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });
});
