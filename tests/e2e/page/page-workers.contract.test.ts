import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page workers contract e2e", () => {
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

  it("emits worker events and evaluates in worker like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const workerPromise = page.waitForEvent("worker");
      await page.evaluate(() => {
        (window as typeof window & { worker?: Worker }).worker = new Worker(
          URL.createObjectURL(new Blob([
            "self.workerFunction = () => 'worker function result'; setInterval(() => {}, 1000);"
          ], { type: "application/javascript" }))
        );
      });

      const worker = await workerPromise;
      expect(worker.url()).toContain("blob:");
      expect(page.workers()).toHaveLength(1);
      expect(page.workers()[0]).toBe(worker);
      expect(await worker.evaluate(() => self["workerFunction"]())).toBe("worker function result");
      expect(await worker.evaluate((value) => value + 1, 41)).toBe(42);
      expect(await (await worker.evaluateHandle(() => ({ answer: 42 }))).jsonValue()).toEqual({ answer: 42 });
    });
  });

  it("reports console logs from workers once like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const messages: string[] = [];
      page.on("console", (message) => messages.push(message.text()));

      await Promise.all([
        page.waitForEvent("console", (message) => message.text() === "1"),
        page.waitForEvent("console", (message) => message.text() === "2"),
        page.evaluate(() => {
          new Worker(URL.createObjectURL(new Blob([
            "setTimeout(() => { console.log(1); console.log(2); }, 0); setInterval(() => {}, 1000);"
          ], { type: "application/javascript" })));
        })
      ]);

      expect(messages).toEqual(["1", "2"]);
      expect(page.url()).not.toContain("blob");
    });
  });

  it("reports console events on workers like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const [worker] = await Promise.all([
        page.waitForEvent("worker"),
        page.evaluate(() => {
          (window as typeof window & { worker?: Worker }).worker = new Worker(
            URL.createObjectURL(new Blob(["42"], { type: "application/javascript" }))
          );
        })
      ]);

      const [workerMessage, pageMessage, contextMessage] = await Promise.all([
        worker.waitForEvent("console"),
        page.waitForEvent("console"),
        page.context().waitForEvent("console"),
        worker.evaluate(() => {
          console.log("hello from worker");
        })
      ]);

      expect(workerMessage.text()).toBe("hello from worker");
      expect(workerMessage).toBe(pageMessage);
      expect(workerMessage).toBe(contextMessage);
    });
  });

  it("emits worker close and clears workers on navigation like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const workerPromise = page.waitForEvent("worker");
      await page.evaluate(() => {
        (window as typeof window & { worker?: Worker }).worker = new Worker(
          URL.createObjectURL(new Blob(["setInterval(() => {}, 1000);"], { type: "application/javascript" }))
        );
      });
      const worker = await workerPromise;
      const closePromise = worker.waitForEvent("close");
      await page.evaluate(() => {
        (window as typeof window & { worker?: Worker }).worker?.terminate();
      });

      expect(await closePromise).toBe(worker);
      expect(page.workers()).toHaveLength(0);

      const nextWorkerPromise = page.waitForEvent("worker");
      await page.evaluate(() => {
        new Worker(URL.createObjectURL(new Blob(["setInterval(() => {}, 1000);"], { type: "application/javascript" })));
      });
      const nextWorker = await nextWorkerPromise;
      let closed = false;
      nextWorker.once("close", () => {
        closed = true;
      });
      await page.goto(fixture.server.PREFIX + "/one-style.html");
      expect(closed).toBe(true);
      expect(page.workers()).toHaveLength(0);
    });
  });
});
