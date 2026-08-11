import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPage, type SnapshotPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";
import type { Frame } from "../../../src/types/api.js";

async function attachFrame(page: SnapshotPage, frameId: string, url: string): Promise<Frame> {
  const handle = await page.evaluateHandle(async ({ frameId, url }) => {
    const frame = document.createElement("iframe");
    frame.src = url;
    frame.id = frameId;
    document.body.appendChild(frame);
    await new Promise((resolve) => {
      frame.onload = resolve;
    });
    return frame;
  }, { frameId, url });
  return (await handle.asElement()!.contentFrame())!;
}

describe("page evaluate callback contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("should throw without the exposeFunctions option", async () => {
    await withPage(async (page) => {
      const error = await page.evaluate(({ cb }) => cb(), { cb: () => {} }).catch((caught) => caught as Error);
      expect(error.message).toContain("Attempting to serialize unexpected value");
    });
  });

  it("should call a function passed as an argument", async () => {
    await withPage(async (page) => {
      const received: number[] = [];
      await page.evaluate(async ({ cb }) => {
        await cb(1);
        await cb(2);
      }, { cb: (n: number) => { received.push(n); } }, { exposeFunctions: true });
      expect(received).toEqual([1, 2]);
    });
  });

  it("should accept a function as the whole argument", async () => {
    await withPage(async (page) => {
      const received: string[] = [];
      await page.evaluate(async (cb) => {
        await cb("a");
        await cb("b");
      }, async (s: string) => { received.push(s); }, { exposeFunctions: true });
      expect(received).toEqual(["a", "b"]);
    });
  });

  it("should return the callback result to the page", async () => {
    await withPage(async (page) => {
      const doubled = await page.evaluate(async ({ cb }) => await cb(21), {
        cb: async (n: number) => n * 2
      }, { exposeFunctions: true });
      expect(doubled).toBe(42);
    });
  });

  it("should propagate callback errors to the page", async () => {
    await withPage(async (page) => {
      const message = await page.evaluate(async ({ cb }) => {
        try {
          await cb();
          return "no error";
        } catch (error) {
          return (error as Error).message;
        }
      }, { cb: async () => { throw new Error("boom"); } }, { exposeFunctions: true });
      expect(message).toBe("boom");
    });
  });

  it("should work with evaluateHandle", async () => {
    await withPage(async (page) => {
      const received: number[] = [];
      const handle = await page.evaluateHandle(async ({ cb }) => {
        await cb(7);
        return { done: true };
      }, { cb: async (n: number) => { received.push(n); } }, { exposeFunctions: true });
      expect(await handle.jsonValue()).toEqual({ done: true });
      expect(received).toEqual([7]);
    });
  });

  it("should work in a child frame", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const frame = await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      const received: number[] = [];
      await frame.evaluate(async ({ cb }) => { await cb(42); }, { cb: async (n: number) => { received.push(n); } }, { exposeFunctions: true });
      expect(received).toEqual([42]);
    });
  });

  it("should work with jsHandle.evaluate", async () => {
    await withPage(async (page) => {
      const handle = await page.evaluateHandle(() => window);
      const received: number[] = [];
      await handle.evaluate(async (win, { cb }) => { await cb(99); }, { cb: async (n: number) => { received.push(n); } }, { exposeFunctions: true });
      expect(received).toEqual([99]);
    });
  });

  it("should work with locator.evaluate", async () => {
    await withPage(async (page) => {
      await page.setContent("<div id=target>hello</div>");
      const received: string[] = [];
      await page.locator("#target").evaluate(async (element, { cb }) => {
        await cb(element.id);
      }, { cb: async (s: string) => { received.push(s); } }, { exposeFunctions: true });
      expect(received).toEqual(["target"]);
    });
  });

  it("should return the callback result with locator.evaluate", async () => {
    await withPage(async (page) => {
      await page.setContent("<div id=target>7</div>");
      const result = await page.locator("#target").evaluate(async (element, { double }) => {
        return await double(+element.textContent!);
      }, { double: async (n: number) => n * 2 }, { exposeFunctions: true });
      expect(result).toBe(14);
    });
  });

  it("should propagate callback errors with locator.evaluate", async () => {
    await withPage(async (page) => {
      await page.setContent("<div id=target></div>");
      const message = await page.locator("#target").evaluate(async (element, { cb }) => {
        try {
          await cb();
          return "no error";
        } catch (error) {
          return (error as Error).message;
        }
      }, { cb: async () => { throw new Error("boom"); } }, { exposeFunctions: true });
      expect(message).toContain("boom");
    });
  });

  it("should work with locator.evaluateHandle", async () => {
    await withPage(async (page) => {
      await page.setContent("<div id=target>hello</div>");
      const received: string[] = [];
      const handle = await page.locator("#target").evaluateHandle(async (element, { cb }) => {
        await cb(element.id);
        return element;
      }, { cb: async (s: string) => { received.push(s); } }, { exposeFunctions: true });
      expect(received).toEqual(["target"]);
      expect(await handle.evaluate((element) => element.id)).toBe("target");
    });
  });

  it("should work with locator.evaluate inside an iframe", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const frame = await attachFrame(page, "frame1", fixture.server.EMPTY_PAGE);
      await frame.evaluate(() => { document.body.innerHTML = "<div id=target>in-frame</div>"; });
      const received: (string | null)[] = [];
      await page.frameLocator("#frame1").locator("#target").evaluate(async (element, { cb }) => {
        await cb(element.textContent);
      }, { cb: async (text: string | null) => { received.push(text); } }, { exposeFunctions: true });
      expect(received).toEqual(["in-frame"]);
    });
  });
});
