import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page evaluateHandle contract e2e", () => {
  it("should work", async () => {
    await withPage(async (page) => {
      const windowHandle = await page.evaluateHandle(() => window);
      expect(windowHandle).toBeTruthy();
      await windowHandle.dispose();
    });
  });

  it("should accept object handle as an argument", async () => {
    await withPage(async (page) => {
      const navigatorHandle = await page.evaluateHandle(() => navigator);
      const text = await page.evaluate((e) => e.userAgent, navigatorHandle);
      expect(text).toContain("Mozilla");
      await navigatorHandle.dispose();
    });
  });

  it("should accept object handle to primitive types", async () => {
    await withPage(async (page) => {
      const aHandle = await page.evaluateHandle(() => 5);
      const isFive = await page.evaluate((e) => Object.is(e, 5), aHandle);
      expect(isFive).toBe(true);
      await aHandle.dispose();
    });
  });

  it("should accept nested handle", async () => {
    await withPage(async (page) => {
      const foo = await page.evaluateHandle(() => ({ x: 1, y: "foo" }));
      const result = await page.evaluate(({ foo }) => {
        return foo;
      }, { foo });
      expect(result).toEqual({ x: 1, y: "foo" });
      await foo.dispose();
    });
  });

  it("should accept nested window handle", async () => {
    await withPage(async (page) => {
      const foo = await page.evaluateHandle(() => window);
      const result = await page.evaluate(({ foo }) => {
        return foo === window;
      }, { foo });
      expect(result).toBe(true);
      await foo.dispose();
    });
  });

  it("should accept multiple nested handles", async () => {
    await withPage(async (page) => {
      const foo = await page.evaluateHandle(() => ({ x: 1, y: "foo" }));
      const bar = await page.evaluateHandle(() => 5);
      const baz = await page.evaluateHandle(() => ["baz"]);
      const result = await page.evaluate((x) => {
        return JSON.stringify(x);
      }, { a1: { foo }, a2: { bar, arr: [{ baz }] } });
      expect(JSON.parse(result)).toEqual({
        a1: { foo: { x: 1, y: "foo" } },
        a2: { bar: 5, arr: [{ baz: ["baz"] }] }
      });
      await foo.dispose();
      await bar.dispose();
      await baz.dispose();
    });
  });

  it("should accept same handle multiple times", async () => {
    await withPage(async (page) => {
      const foo = await page.evaluateHandle(() => 1);
      expect(await page.evaluate((x) => x, { foo, bar: [foo], baz: { foo } })).toEqual({
        foo: 1,
        bar: [1],
        baz: { foo: 1 }
      });
      await foo.dispose();
    });
  });

  it("should accept object handle to unserializable value", async () => {
    await withPage(async (page) => {
      const aHandle = await page.evaluateHandle(() => Infinity);
      expect(await page.evaluate((e) => Object.is(e, Infinity), aHandle)).toBe(true);
      await aHandle.dispose();
    });
  });
});
