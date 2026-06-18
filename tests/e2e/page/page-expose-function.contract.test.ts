import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page exposeFunction/exposeBinding contract e2e", () => {
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

  it("exposeBinding should work", async () => {
    await withPage(async (page) => {
      let bindingSource: unknown;
      await page.exposeBinding("add", (source, a, b) => {
        bindingSource = source;
        return a + b;
      });
      const result = await page.evaluate(async () => window["add"](5, 6));
      expect((bindingSource as { context: unknown }).context).toBe(page.context());
      expect((bindingSource as { page: unknown }).page).toBe(page);
      expect((bindingSource as { frame: unknown }).frame).toBe(page.mainFrame());
      expect(result).toBe(11);
    });
  });

  it("exposeFunction should work", async () => {
    await withPage(async (page) => {
      await page.exposeFunction("compute", (a: number, b: number) => a * b);
      const result = await page.evaluate(async () => window["compute"](9, 4));
      expect(result).toBe(36);
    });
  });

  it("exposeFunction should dispose", async () => {
    await withPage(async (page) => {
      const binding = await page.exposeFunction("compute", (a: number, b: number) => a * b);
      const result = await page.evaluate(async () => window["compute"](9, 4));
      expect(result).toBe(36);
      await binding.dispose();
      const error = await page.evaluate(async () => window["compute"](9, 4)).catch((caught) => caught);
      expect(error.message).toContain("is not a function");
    });
  });

  it("exposeFunction should throw exception in page context", async () => {
    await withPage(async (page) => {
      await page.exposeFunction("woof", () => {
        throw new Error("WOOF WOOF");
      });
      const result = await page.evaluate(async () => {
        try {
          await window["woof"]();
        } catch (error) {
          return { message: (error as Error).message, stack: (error as Error).stack };
        }
      });
      expect(result.message).toBe("WOOF WOOF");
      expect(result.stack).toContain("page-expose-function.contract.test.ts");
    });
  });

  it("exposeFunction should support throwing null", async () => {
    await withPage(async (page) => {
      await page.exposeFunction("woof", () => {
        throw null;
      });
      const thrown = await page.evaluate(async () => {
        try {
          await window["woof"]();
        } catch (error) {
          return error;
        }
      });
      expect(thrown).toBe(null);
    });
  });

  it("exposeFunction should be callable from addInitScript", async () => {
    await withPage(async (page) => {
      let called = false;
      await page.exposeFunction("woof", () => {
        called = true;
      });
      await page.addInitScript(() => window["woof"]());
      await page.reload();
      await expect.poll(() => called).toBe(true);
    });
  });

  it("exposeFunction should survive navigation", async () => {
    await withPage(async (page) => {
      await page.exposeFunction("compute", (a: number, b: number) => a * b);
      await page.goto(fixture.server.EMPTY_PAGE);
      const result = await page.evaluate(async () => window["compute"](9, 4));
      expect(result).toBe(36);
    });
  });

  it("exposeFunction should await returned promise", async () => {
    await withPage(async (page) => {
      await page.exposeFunction("compute", (a: number, b: number) => Promise.resolve(a * b));
      const result = await page.evaluate(async () => window["compute"](3, 5));
      expect(result).toBe(15);
    });
  });

  it("exposeFunction should work on frames", async () => {
    await withPage(async (page) => {
      await page.exposeFunction("compute", (a: number, b: number) => Promise.resolve(a * b));
      await page.goto(fixture.server.PREFIX + "/frames/two-frames.html");
      const frame = page.frames()[1];
      const result = await frame.evaluate(async () => window["compute"](3, 5));
      expect(result).toBe(15);
    });
  });

  it("exposeFunction should work on frames before navigation", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/frames/two-frames.html");
      await page.exposeFunction("compute", (a: number, b: number) => Promise.resolve(a * b));
      const frame = page.frames()[1];
      const result = await frame.evaluate(async () => window["compute"](3, 5));
      expect(result).toBe(15);
    });
  });

  it("exposeFunction should work after cross origin navigation", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.exposeFunction("compute", (a: number, b: number) => a * b);
      await page.goto(fixture.server.CROSS_PROCESS_PREFIX + "/empty.html");
      const result = await page.evaluate(async () => window["compute"](9, 4));
      expect(result).toBe(36);
    });
  });

  it("exposeBinding should serialize cycles", async () => {
    await withPage(async (page) => {
      let object: unknown;
      await page.exposeBinding("log", (_source, obj) => object = obj);
      await page.evaluate("const a = {}; a.b = a; window.log(a)");
      const a: any = {};
      a.b = a;
      expect(object).toEqual(a);
    });
  });

  it("exposeFunction should reject duplicates", async () => {
    await withPage(async (page) => {
      await page.exposeFunction("foo", () => {});
      const error = await page.exposeFunction("foo", () => {}).catch((caught) => caught);
      expect(error.message).toContain('page.exposeFunction: Function "foo" has been already registered');
    });
  });
});
