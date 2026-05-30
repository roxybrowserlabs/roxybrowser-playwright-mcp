import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPage } from "../helpers/browser.js";
import { createHistoryPageFixture } from "../helpers/server.js";

describe("page network response e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("should return text", async () => {
    await withPage(async (page) => {
      const response = await page.goto(fixture.server.PREFIX + "/simple.json", {
        waitUntil: "load"
      });

      expect(response).toBeTruthy();
      expect(await response!.text()).toBe('{"foo": "bar"}\n');
    });
  });
});
