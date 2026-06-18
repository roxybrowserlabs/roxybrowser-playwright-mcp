import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page evaluate contract e2e", () => {
  it("should work", async () => {
    await withPage(async (page) => {
      const result = await page.evaluate(() => 7 * 3);
      expect(result).toBe(21);
    });
  });

  it("should evaluate string functions", async () => {
    await withPage(async (page) => {
      expect(await page.evaluate("() => 7 * 3")).toBe(21);
      expect(await page.evaluate("(value) => value * 2", 11)).toBe(22);
    });
  });

  it("should transfer unserializable values", async () => {
    await withPage(async (page) => {
      expect(Object.is(await page.evaluate((a) => a, NaN), NaN)).toBe(true);
      expect(Object.is(await page.evaluate((a) => a, -0), -0)).toBe(true);
      expect(Object.is(await page.evaluate((a) => a, Infinity), Infinity)).toBe(true);
      expect(Object.is(await page.evaluate((a) => a, -Infinity), -Infinity)).toBe(true);
    });
  });

  it("should roundtrip unserializable values", async () => {
    await withPage(async (page) => {
      const value = {
        infinity: Infinity,
        nInfinity: -Infinity,
        nZero: -0,
        nan: NaN
      };
      const result = await page.evaluate((arg) => arg, value);
      expect(result).toEqual(value);
    });
  });

  it("should transfer arrays as arrays", async () => {
    await withPage(async (page) => {
      expect(await page.evaluate((a) => a, [1, 2, 3])).toEqual([1, 2, 3]);
      expect(await page.evaluate((a) => Array.isArray(a), [1, 2, 3])).toBe(true);
    });
  });

  it("should transfer typed arrays", async () => {
    await withPage(async (page) => {
      const testCases = [
        new Int8Array([1, 2, 3]),
        new Uint8Array([1, 2, 3]),
        new Uint8ClampedArray([1, 2, 3]),
        new Int16Array([1, 2, 3]),
        new Uint16Array([1, 2, 3]),
        new Int32Array([1, 2, 3]),
        new Uint32Array([1, 2, 3]),
        new Float32Array([1.1, 2.2, 3.3]),
        new Float64Array([1.1, 2.2, 3.3]),
        new BigInt64Array([1n, 2n, 3n]),
        new BigUint64Array([1n, 2n, 3n])
      ];

      for (const typedArray of testCases) {
        expect(await page.evaluate((a) => a, typedArray)).toEqual(typedArray);
      }
    });
  });

  it("should transfer bigint", async () => {
    await withPage(async (page) => {
      expect(await page.evaluate(() => 42n)).toBe(42n);
      expect(await page.evaluate((a) => a, 17n)).toBe(17n);
    });
  });

  it("should return undefined for objects with symbols", async () => {
    await withPage(async (page) => {
      expect(await page.evaluate(() => [Symbol("foo4")])).toEqual([undefined]);
      expect(await page.evaluate(() => {
        const a = {};
        a[Symbol("foo4")] = 42;
        return a;
      })).toEqual({});
      expect(await page.evaluate(() => {
        return { foo: [{ a: Symbol("foo4") }] };
      })).toEqual({ foo: [{ a: undefined }] });
    });
  });

  it("should support thrown primitives as error messages", async () => {
    await withPage(async (page) => {
      const stringError = await page.evaluate(() => {
        throw "qwerty";
      }).catch((error) => error);
      expect(stringError.message).toContain("qwerty");

      const numberError = await page.evaluate(() => {
        throw 100500;
      }).catch((error) => error);
      expect(numberError.message).toContain("100500");
    });
  });

  it("should return complex objects by value", async () => {
    await withPage(async (page) => {
      const object = { foo: "bar!" };
      const result = await page.evaluate((arg) => arg, object);
      expect(result).not.toBe(object);
      expect(result).toEqual(object);
    });
  });

  it("should return unserializable values", async () => {
    await withPage(async (page) => {
      expect(Object.is(await page.evaluate(() => NaN), NaN)).toBe(true);
      expect(Object.is(await page.evaluate(() => -0), -0)).toBe(true);
      expect(Object.is(await page.evaluate(() => Infinity), Infinity)).toBe(true);
      expect(Object.is(await page.evaluate(() => -Infinity), -Infinity)).toBe(true);
    });
  });

  it("should work with overwritten Promise", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => {
        const originalPromise = window.Promise;
        class Promise2 {
          _promise: Promise<any>;
          static all(arg) {
            return wrap(originalPromise.all(arg));
          }
          static race(arg) {
            return wrap(originalPromise.race(arg));
          }
          static resolve(arg) {
            return wrap(originalPromise.resolve(arg));
          }
          constructor(f) {
            this._promise = new originalPromise(f);
          }
          then(f, r) {
            return wrap(this._promise.then(f, r));
          }
          catch(f) {
            return wrap(this._promise.catch(f));
          }
          finally(f) {
            return wrap(this._promise.finally(f));
          }
        }
        const wrap = (promise) => {
          const result = new Promise2(() => {});
          result._promise = promise;
          return result;
        };
        window.Promise = Promise2 as typeof Promise;
        window["__Promise2"] = Promise2;
      });

      expect(await page.evaluate(() => {
        const p = Promise.all([Promise.race([]), new Promise(() => {}).then(() => {})]);
        return p instanceof window["__Promise2"];
      })).toBe(true);
      expect(await page.evaluate(() => Promise.resolve(42))).toBe(42);
    });
  });

  it("should throw when passed more than one parameter", async () => {
    await withPage(async (page) => {
      const error = await (page.evaluate as any)((a, b) => false, 1, 2).catch((caught) => caught);
      expect(String(error)).toContain("Too many arguments");

      const handleError = await (page.evaluateHandle as any)((a, b) => false, 1, 2).catch((caught) => caught);
      expect(String(handleError)).toContain("Too many arguments");
    });
  });

  it("should serialize undefined and null like Playwright", async () => {
    await withPage(async (page) => {
      expect(await page.evaluate(({ a, b }) => Object.is(a, undefined) && Object.is(b, "foo"), {
        a: undefined,
        b: "foo"
      })).toBe(true);
      expect(await page.evaluate((x) => ({ a: x }), undefined)).toEqual({});
      expect(await page.evaluate(() => ({ a: undefined }))).toEqual({});
      expect("a" in await page.evaluate(() => ({ a: undefined }))).toBe(true);
      expect(await page.evaluate((x) => x, null)).toBe(null);
      expect(await page.evaluate(() => ({ a: null }))).toEqual({ a: null });
    });
  });

  it("should return undefined for non-serializable objects", async () => {
    await withPage(async (page) => {
      expect(await page.evaluate(() => function () {})).toBe(undefined);
    });
  });

  it("should alias Window, Document and Node", async () => {
    await withPage(async (page) => {
      const object = await page.evaluate("[window, document, document.body]");
      expect(object).toEqual(["ref: <Window>", "ref: <Document>", "ref: <Node>"]);
    });
  });

  it("should work for circular object", async () => {
    await withPage(async (page) => {
      const result = await page.evaluate(() => {
        const a = {} as any;
        a.b = a;
        return a;
      });
      const a: any = {};
      a.b = a;
      expect(result).toEqual(a);
    });
  });

  it("should accept string expressions", async () => {
    await withPage(async (page) => {
      expect(await page.evaluate("1 + 2")).toBe(3);
      expect(await page.evaluate("1 + 5;")).toBe(6);
      expect(await page.evaluate("2 + 5;\n// do some math!")).toBe(7);
    });
  });
});
