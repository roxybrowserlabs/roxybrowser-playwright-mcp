import { describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";

describe("elementHandle click e2e (bidi/firefox)", () => {
  it("should throw for <br> elements with force", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("hello<br>goodbye");
      const br = await page.$("br");

      const error = await br!.click({ force: true }).catch((caught: Error) => caught);

      expect(error.message).toContain("Element is outside of the viewport");
    });
  });
});
