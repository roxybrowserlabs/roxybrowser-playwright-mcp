import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page strict selector contract e2e", () => {
  it("should fail page.textContent in strict mode like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<span>span1</span><div><span>target</span></div>`);

      const error = await page.textContent("span", { strict: true }).catch((e) => e);
      expect(error.message).toContain("strict mode violation");
      expect(error.message).toContain("span (span1)");
      expect(error.message).toContain("span (target)");
      expect(error.message).not.toContain('selector "span" resolved');
    });
  });

  it("should fail page.getAttribute and page.$ in strict mode like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<span>span1</span><div><span>target</span></div>`);

      const getAttributeError = await page.getAttribute("span", "id", { strict: true }).catch((e) => e);
      expect(getAttributeError.message).toContain("strict mode violation");
      expect(getAttributeError.message).toContain("span (span1)");
      expect(getAttributeError.message).toContain("span (target)");

      const queryError = await page.$("span", { strict: true }).catch((e) => e);
      expect(queryError.message).toContain("strict mode violation");
      expect(queryError.message).toContain("span (span1)");
      expect(queryError.message).toContain("span (target)");
    });
  });

  it("should fail page.fill in strict mode like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input><div><input></div>`);

      const error = await page.fill("input", "text", { strict: true }).catch((e) => e);
      expect(error.message).toContain("strict mode violation");
      expect(error.message).toContain("locator resolved to 2 elements");
      expect(error.message).toContain("input");
    });
  });

  it("should fail page.waitForSelector and dispatchEvent in strict mode like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<span></span><div><span></span></div>`);

      const waitError = await page.waitForSelector("span", { strict: true, timeout: 1000 }).catch((e) => e);
      expect(waitError.message).toContain("strict mode violation");
      expect(waitError.message).toContain("locator resolved to 2 elements");

      const dispatchError = await page.dispatchEvent("span", "click", {}, { strict: true }).catch((e) => e);
      expect(dispatchError.message).toContain("strict mode violation");
      expect(dispatchError.message).toContain("locator resolved to 2 elements");
    });
  });
});
