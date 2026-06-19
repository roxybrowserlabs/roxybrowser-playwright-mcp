import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("JSHandle contract e2e", () => {
  it("jsonValue should work", async () => {
    await withPage(async (page) => {
      const handle = await page.evaluateHandle(() => ({ foo: "bar" }));
      expect(await handle.jsonValue()).toEqual({ foo: "bar" });
      await handle.dispose();
    });
  });

  it("jsonValue should work with dates", async () => {
    await withPage(async (page) => {
      const handle = await page.evaluateHandle(() => new Date("2017-09-26T00:00:00.000Z"));
      const date = await handle.jsonValue();
      expect(date.toJSON()).toBe("2017-09-26T00:00:00.000Z");
      await handle.dispose();
    });
  });

  it("jsonValue should handle circular objects", async () => {
    await withPage(async (page) => {
      const handle = await page.evaluateHandle("const a = {}; a.b = a; a");
      const a: any = {};
      a.b = a;
      expect(await handle.jsonValue()).toEqual(a);
      await handle.dispose();
    });
  });

  it("evaluate should work with function and expression", async () => {
    await withPage(async (page) => {
      const windowHandle = await page.evaluateHandle(() => {
        window["foo"] = [1, 2];
        return window;
      });
      expect(await windowHandle.evaluate((windowObject) => windowObject["foo"])).toEqual([1, 2]);
      expect(await windowHandle.evaluate("window.foo")).toEqual([1, 2]);
      await windowHandle.dispose();
    });
  });

  it("getProperty should work", async () => {
    await withPage(async (page) => {
      const handle = await page.evaluateHandle(() => ({
        one: 1,
        two: 2,
        three: 3
      }));
      const twoHandle = await handle.getProperty("two");
      expect(await twoHandle.jsonValue()).toBe(2);
      await twoHandle.dispose();
      await handle.dispose();
    });
  });

  it("getProperty should work with undefined, null, empty, and unserializable values", async () => {
    await withPage(async (page) => {
      const handle = await page.evaluateHandle(() => ({
        infinity: Infinity,
        nInfinity: -Infinity,
        nan: NaN,
        null: null,
        nzero: -0,
        undefined: undefined
      }));

      expect(String(await (await handle.getProperty("undefined")).jsonValue())).toBe("undefined");
      expect(await (await handle.getProperty("null")).jsonValue()).toBe(null);
      expect(String(await (await handle.getProperty("empty")).jsonValue())).toBe("undefined");
      expect(await (await handle.getProperty("infinity")).jsonValue()).toBe(Infinity);
      expect(await (await handle.getProperty("nInfinity")).jsonValue()).toBe(-Infinity);
      expect(String(await (await handle.getProperty("nan")).jsonValue())).toBe("NaN");
      expect(await (await handle.getProperty("nzero")).jsonValue()).toBe(-0);
      await handle.dispose();
    });
  });

  it("getProperties should work", async () => {
    await withPage(async (page) => {
      const handle = await page.evaluateHandle(() => ({ foo: "bar" }));
      const properties = await handle.getProperties();
      const foo = properties.get("foo");
      expect(foo).toBeTruthy();
      expect(await foo!.jsonValue()).toBe("bar");
      await handle.dispose();
    });
  });

  it("getProperties should return empty map for non-objects", async () => {
    await withPage(async (page) => {
      const handle = await page.evaluateHandle(() => 123);
      expect((await handle.getProperties()).size).toBe(0);
      await handle.dispose();
    });
  });

  it("getProperties should return even non-own properties", async () => {
    await withPage(async (page) => {
      const handle = await page.evaluateHandle(() => {
        class A {
          a: string;
          constructor() {
            this.a = "1";
          }
        }
        class B extends A {
          b: string;
          constructor() {
            super();
            this.b = "2";
          }
        }
        return new B();
      });
      const properties = await handle.getProperties();

      expect(await properties.get("a")!.jsonValue()).toBe("1");
      expect(await properties.get("b")!.jsonValue()).toBe("2");
      await handle.dispose();
    });
  });

  it("getProperties should work with elements", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>Hello</div>");
      const handle = await page.evaluateHandle(() => ({ body: document.body }));
      const properties = await handle.getProperties();
      const body = properties.get("body")!.asElement();

      expect(body).toBeTruthy();
      expect(await body!.textContent()).toBe("Hello");
      await handle.dispose();
    });
  });

  it("asElement should return ElementHandle for elements", async () => {
    await withPage(async (page) => {
      const handle = await page.evaluateHandle(() => document.body);
      expect(handle.asElement()).toBeTruthy();
      await handle.dispose();
    });
  });

  it("asElement should return null for non-elements", async () => {
    await withPage(async (page) => {
      const handle = await page.evaluateHandle(() => 2);
      expect(handle.asElement()).toBeFalsy();
      await handle.dispose();
    });
  });

  it("asElement should return ElementHandle for TextNodes", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>ee!</div>");
      const handle = await page.evaluateHandle(() => document.querySelector("div")!.firstChild);
      const element = handle.asElement();
      expect(element).toBeTruthy();
      expect(await page.evaluate((node) => node!.nodeType === Node.TEXT_NODE, element)).toBeTruthy();
      await handle.dispose();
    });
  });

  it("asElement should work with nullified Node global", async () => {
    await withPage(async (page) => {
      await page.setContent("<section>test</section>");
      await page.evaluate("delete Node");
      const handle = await page.evaluateHandle(() => document.querySelector("section"));
      expect(handle.asElement()).not.toBe(null);
      await handle.dispose();
    });
  });

  it("toString should match Playwright previews for primitives and common objects", async () => {
    await withPage(async (page) => {
      expect((await page.evaluateHandle(() => 2)).toString()).toBe("2");
      expect((await page.evaluateHandle(() => "a")).toString()).toBe("a");
      expect((await page.evaluateHandle(() => window)).toString()).toBe("Window");
      expect((await page.evaluateHandle("(function(){})")).toString()).toContain("function");
      expect((await page.evaluateHandle("12")).toString()).toBe("12");
      expect((await page.evaluateHandle("true")).toString()).toBe("true");
      expect((await page.evaluateHandle("undefined")).toString()).toBe("undefined");
      expect((await page.evaluateHandle('"foo"')).toString()).toBe("foo");
      expect((await page.evaluateHandle("Symbol()")).toString()).toBe("Symbol()");
      expect((await page.evaluateHandle("null")).toString()).toBe("null");
      expect((await page.evaluateHandle("new Map()")).toString()).toContain("Map");
      expect((await page.evaluateHandle("new Set()")).toString()).toContain("Set");
      expect((await page.evaluateHandle("[]")).toString()).toContain("Array");
      expect((await page.evaluateHandle("document.body")).toString()).toBe("JSHandle@<body></body>");
      expect((await page.evaluateHandle("new WeakMap()")).toString()).toBe("WeakMap");
      expect((await page.evaluateHandle("new WeakSet()")).toString()).toBe("WeakSet");
      expect((await page.evaluateHandle("new Error()")).toString()).toContain("Error");
      expect((await page.evaluateHandle("new Proxy({}, {})")).toString()).toBe("Proxy(Object)");
    });
  });

  it("toString should match Playwright previews for promises and previewable subtypes", async () => {
    await withPage(async (page) => {
      const wrapperHandle = await page.evaluateHandle(() => ({ b: Promise.resolve(123) }));
      const promiseHandle = await wrapperHandle.getProperty("b");

      expect(promiseHandle.toString()).toBe("Promise");
      expect((await page.evaluateHandle("/foo/")).toString()).toBe("/foo/");
      expect((await page.evaluateHandle("new Date(0)")).toString()).toContain("GMT");
      expect((await page.evaluateHandle("new Int32Array()")).toString()).toContain("Int32Array");
      await wrapperHandle.dispose();
    });
  });
});
