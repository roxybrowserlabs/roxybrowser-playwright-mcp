import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withBidiPage } from "../../../helpers/bidi.js";
import { createHistoryPageFixture } from "../../../helpers/server.js";

describe("page keyboard insertText e2e (bidi/firefox)", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("inserts text into a focused cross-origin iframe like Playwright", async () => {
    await withBidiPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/empty.html");
      await page.setContent(`
        <iframe id="target" src="${fixture.server.CROSS_PROCESS_PREFIX}/input/textarea.html"></iframe>
      `);

      const frame = await page.locator("#target").contentFrame();
      await frame!.locator("textarea").focus();
      await page.keyboard.insertText("BiDi");

      expect(await frame!.locator("textarea").inputValue()).toBe("BiDi");
    });
  });
});
