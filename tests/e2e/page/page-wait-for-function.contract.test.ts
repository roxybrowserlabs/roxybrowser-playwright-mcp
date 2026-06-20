import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TimeoutError } from "../../../src/errors.js";
import { withPage, type SnapshotPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";
import type { Frame } from "../../../src/types/api.js";

async function attachFrame(page: SnapshotPage, frameId: string, url: string): Promise<Frame> {
  await page.evaluate(async ({ frameId, url }) => {
    const frame = document.createElement("iframe");
    frame.src = url;
    frame.id = frameId;
    document.body.appendChild(frame);
    await new Promise((resolve) => {
      frame.onload = resolve;
    });
  }, { frameId, url });
  await expect.poll(() => page.frames().find((frame) => frame.name() === frameId)?.url()).toBe(url);
  return page.frames().find((frame) => frame.name() === frameId)!;
}

async function detachFrame(page: SnapshotPage, frameId: string): Promise<void> {
  await page.evaluate((id) => document.getElementById(id)?.remove(), frameId);
}

describe("page.waitForFunction contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

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

  it("should avoid side effects after timeout like Playwright", async () => {
    await withPage(async (page) => {
      let counter = 0;
      page.on("console", () => {
        counter += 1;
      });

      const error = await page.waitForFunction(() => {
        window["counter"] = (window["counter"] || 0) + 1;
        console.log(window["counter"]);
        return false;
      }, {}, { polling: 10, timeout: 100 }).catch((caught) => caught);

      const savedCounter = counter;
      await page.waitForTimeout(300);

      expect(error).toBeInstanceOf(TimeoutError);
      expect(error.message).toContain("page.waitForFunction: Timeout 100ms exceeded");
      expect(counter).toBe(savedCounter);
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

  it("should not be called after finishing successfully like Playwright", async () => {
    await withPage(async (page) => {
      const messages: string[] = [];
      page.on("console", (message) => {
        if (message.text().startsWith("waitForFunction")) {
          messages.push(message.text());
        }
      });

      await page.waitForFunction(() => {
        console.log("waitForFunction1");
        return true;
      });
      await page.reload();
      await page.waitForFunction(() => {
        console.log("waitForFunction2");
        return true;
      });
      await page.reload();
      await page.waitForFunction(() => {
        console.log("waitForFunction3");
        return true;
      });

      expect(messages.join("|")).toBe("waitForFunction1|waitForFunction2|waitForFunction3");
    });
  });

  it("should not be called after finishing unsuccessfully like Playwright", async () => {
    await withPage(async (page) => {
      const messages: string[] = [];
      page.on("console", (message) => {
        if (message.text().startsWith("waitForFunction")) {
          messages.push(message.text());
        }
      });

      await page.waitForFunction(() => {
        console.log("waitForFunction1");
        throw new Error("waitForFunction1");
      }).catch(() => null);
      await page.reload();
      await page.waitForFunction(() => {
        console.log("waitForFunction2");
        throw new Error("waitForFunction2");
      }).catch(() => null);
      await page.reload();
      await page.waitForFunction(() => {
        console.log("waitForFunction3");
        throw new Error("waitForFunction3");
      }).catch(() => null);

      expect(messages.join("|")).toBe("waitForFunction1|waitForFunction2|waitForFunction3");
    });
  });

  it("should throw when frame is detached like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const frame = await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      const promise = frame.waitForFunction(() => false, undefined, { polling: 10 }).catch((error) => error);
      await detachFrame(page, "frame1");

      const error = await promise;
      expect(error).toBeTruthy();
      expect(error.message).toMatch(/frame.waitForFunction: (Frame was detached|Execution context was destroyed)/);
    });
  });
});
