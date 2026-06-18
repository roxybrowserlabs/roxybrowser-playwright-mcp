import { describe, expect, it } from "vitest";
import { TimeoutError } from "../../../src/errors.js";
import { withPage } from "../../helpers/browser.js";

describe("page.waitForFunction contract e2e", () => {
  it("should accept a string expression", async () => {
    await withPage(async (page) => {
      const watchdog = page.waitForFunction("window.__FOO === 1");
      await page.evaluate(() => {
        window["__FOO"] = 1;
      });
      await watchdog;
    });
  });

  it("should evaluate in frame scope", async () => {
    await withPage(async (page) => {
      await page.setContent("<iframe></iframe>");
      const frame = page.frames()[1]!;
      const watchdog = frame.waitForFunction("window.__FRAME_READY === true");
      await frame.evaluate(() => {
        window["__FRAME_READY"] = true;
      });
      await watchdog;
      expect(await page.evaluate(() => window["__FRAME_READY"])).toBeUndefined();
    });
  });

  it("should poll on interval", async () => {
    await withPage(async (page) => {
      const polling = 100;
      const timeDelta = await page.waitForFunction(() => {
        if (!window["__startTime"]) {
          window["__startTime"] = Date.now();
          return false;
        }
        return Date.now() - window["__startTime"];
      }, {}, { polling });
      expect(await timeDelta.jsonValue()).not.toBeLessThan(polling);
    });
  });

  it("should poll on raf", async () => {
    await withPage(async (page) => {
      const watchdog = page.waitForFunction(() => window["__FOO"] === "hit", {}, { polling: "raf" });
      await page.evaluate(() => {
        window["__FOO"] = "hit";
      });
      await watchdog;
    });
  });

  it("should fail with predicate throwing", async () => {
    await withPage(async (page) => {
      const error = await page.waitForFunction(() => {
        throw new Error("oh my");
      }).catch((caught) => caught);
      expect(error.message).toContain("oh my");
    });
  });

  it("should reject bad polling options", async () => {
    await withPage(async (page) => {
      const unknown = await page.waitForFunction(() => true, {}, {
        polling: "mutation" as "raf"
      }).catch((caught) => caught);
      expect(unknown.message).toContain("Unknown polling option: mutation");

      const negative = await page.waitForFunction(() => true, {}, {
        polling: -10
      }).catch((caught) => caught);
      expect(negative.message).toContain("Cannot poll with non-positive interval");
    });
  });

  it("should return success value as a JSHandle", async () => {
    await withPage(async (page) => {
      expect(await (await page.waitForFunction(() => 5)).jsonValue()).toBe(5);
    });
  });

  it("should accept JSHandle arguments", async () => {
    await withPage(async (page) => {
      const state = await page.evaluateHandle(() => ({ done: false }));
      const wait = page.waitForFunction((arg) => arg.done, state);
      await page.evaluate((arg) => {
        arg.done = true;
      }, state);
      await wait;
      await state.dispose();
    });
  });

  it("should respect timeout and default timeout", async () => {
    await withPage(async (page) => {
      const error = await page.waitForFunction("false", {}, { timeout: 10 }).catch((caught) => caught);
      expect(error).toBeInstanceOf(TimeoutError);
      expect(error.message).toContain("page.waitForFunction: Timeout 10ms exceeded");

      page.setDefaultTimeout(1);
      const defaultError = await page.waitForFunction("false").catch((caught) => caught);
      expect(defaultError).toBeInstanceOf(TimeoutError);
      expect(defaultError.message).toContain("page.waitForFunction: Timeout 1ms exceeded");
    });
  });

  it("should disable timeout when set to 0", async () => {
    await withPage(async (page) => {
      const watchdog = page.waitForFunction(() => {
        window["__counter"] = (window["__counter"] || 0) + 1;
        return window["__injected"];
      }, {}, { timeout: 0, polling: 10 });
      await page.waitForFunction(() => window["__counter"] > 10);
      await page.evaluate(() => {
        window["__injected"] = true;
      });
      await watchdog;
    });
  });

  it("should wait for predicate with arguments", async () => {
    await withPage(async (page) => {
      await page.waitForFunction(({ arg1, arg2 }) => arg1 + arg2 === 3, {
        arg1: 1,
        arg2: 2
      });
    });
  });
});
