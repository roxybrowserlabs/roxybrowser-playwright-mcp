import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page localStorage/sessionStorage contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  beforeEach(() => {
    fixture.server.reset();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("localStorage.items returns empty array on fresh origin", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);

      expect(await page.localStorage.items()).toEqual([]);
    });
  });

  it("localStorage.getItem returns null for missing key", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);

      expect(await page.localStorage.getItem("absent")).toBeNull();
    });
  });

  it("localStorage.setItem persists and surfaces in items/getItem", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.localStorage.setItem("alpha", "1");
      await page.localStorage.setItem("beta", "2");

      expect(new Set(await page.localStorage.items())).toEqual(new Set([
        { name: "alpha", value: "1" },
        { name: "beta", value: "2" }
      ]));
      expect(await page.localStorage.getItem("alpha")).toBe("1");
      expect(await page.evaluate(() => localStorage.getItem("alpha"))).toBe("1");
    });
  });

  it("localStorage.setItem overwrites existing value", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.localStorage.setItem("k", "first");
      await page.localStorage.setItem("k", "second");

      expect(await page.localStorage.getItem("k")).toBe("second");
    });
  });

  it("localStorage.removeItem removes a single item", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.localStorage.setItem("a", "1");
      await page.localStorage.setItem("b", "2");

      await page.localStorage.removeItem("a");

      expect(await page.localStorage.items()).toEqual([{ name: "b", value: "2" }]);
    });
  });

  it("localStorage.clear empties storage", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.localStorage.setItem("a", "1");
      await page.localStorage.setItem("b", "2");

      await page.localStorage.clear();

      expect(await page.localStorage.items()).toEqual([]);
    });
  });

  it("sessionStorage round-trips independently", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(await page.sessionStorage.items()).toEqual([]);

      await page.sessionStorage.setItem("s1", "v1");
      await page.sessionStorage.setItem("s2", "v2");
      expect(new Set(await page.sessionStorage.items())).toEqual(new Set([
        { name: "s1", value: "v1" },
        { name: "s2", value: "v2" }
      ]));
      expect(await page.sessionStorage.getItem("s1")).toBe("v1");

      await page.sessionStorage.removeItem("s1");
      expect(await page.sessionStorage.items()).toEqual([{ name: "s2", value: "v2" }]);

      await page.sessionStorage.clear();
      expect(await page.sessionStorage.items()).toEqual([]);
    });
  });

  it("localStorage and sessionStorage are independent", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.localStorage.setItem("shared", "local");
      await page.sessionStorage.setItem("shared", "session");

      expect(await page.localStorage.getItem("shared")).toBe("local");
      expect(await page.sessionStorage.getItem("shared")).toBe("session");

      await page.localStorage.clear();
      expect(await page.localStorage.items()).toEqual([]);
      expect(await page.sessionStorage.getItem("shared")).toBe("session");
    });
  });

  it("storage methods are scoped to the current origin", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/empty.html");
      await page.localStorage.setItem("k", "origin-1");

      await page.goto(fixture.server.CROSS_PROCESS_PREFIX + "/empty.html");
      expect(await page.localStorage.items()).toEqual([]);
      await page.localStorage.setItem("k", "origin-2");

      await page.goto(fixture.server.PREFIX + "/empty.html");
      expect(await page.localStorage.getItem("k")).toBe("origin-1");
    });
  });
});
