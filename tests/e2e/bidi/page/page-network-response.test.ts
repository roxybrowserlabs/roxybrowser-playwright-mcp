import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withBidiPage } from "../../helpers/bidi.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page network response e2e (bidi/firefox)", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("should return text", async () => {
    await withBidiPage(async (page) => {
      const response = await page.goto(fixture.server.PREFIX + "/simple.json", {
        waitUntil: "load"
      });

      expect(response).toBeTruthy();
      expect(await response!.text()).toBe('{"foo": "bar"}\n');
    });
  });
});
