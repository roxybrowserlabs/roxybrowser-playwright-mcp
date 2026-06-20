import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

  it("reports console events on workers without page/context listeners like Playwright", async () => {
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

      const [workerMessage] = await Promise.all([
        worker.waitForEvent("console"),
        worker.evaluate(() => {
          console.log("hello from worker");
        })
      ]);

      expect(workerMessage.text()).toBe("hello from worker");
    });
  });

  it("exposes JSHandles for worker console logs like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const logPromise = page.waitForEvent("console");

      await page.evaluate(() => {
        new Worker(URL.createObjectURL(new Blob([
          "console.log(1, 2, 3, this)"
        ], { type: "application/javascript" })));
      });

      const log = await logPromise;
      expect(log.text()).toMatch(/^1 2 3 /);
      expect(log.args()).toHaveLength(4);
      expect(await (await log.args()[3]!.getProperty("origin")).jsonValue()).toEqual(expect.any(String));
    });
  });

  it("emits created and destroyed worker events like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);

      const workerCreatedPromise = page.waitForEvent("worker");
      const workerHandle = await page.evaluateHandle(() => {
        return new Worker(URL.createObjectURL(new Blob(["1"], { type: "application/javascript" })));
      });
      const worker = await workerCreatedPromise;
      const workerThisHandle = await worker.evaluateHandle("this");
      const workerDestroyedPromise = new Promise((resolve) => worker.once("close", resolve));

      await page.evaluate((handle) => {
        handle.terminate();
      }, workerHandle);

      expect(await workerDestroyedPromise).toBe(worker);
      const error = await workerThisHandle.getProperty("self").catch((caught: Error) => caught);
      expect(error.message).toContain("Target page, context or browser has been closed");
    });
  });

  it("reports worker exceptions through pageerror like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const errorPromise = new Promise<Error>((resolve) => page.on("pageerror", resolve));

      await page.evaluate(() => {
        new Worker(URL.createObjectURL(new Blob([`
          setTimeout(() => {
            console.log("hey");
            throw new Error("this is my error");
          });
        `], { type: "application/javascript" })));
      });

      const error = await errorPromise;
      expect(error.message).toContain("this is my error");
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

  it("clears workers on cross-process navigation like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const workerCreatedPromise = page.waitForEvent("worker");
      await page.evaluate(() => {
        new Worker(URL.createObjectURL(new Blob(["console.log(1)"], { type: "application/javascript" })));
      });
      const worker = await workerCreatedPromise;
      expect(page.workers()).toHaveLength(1);

      let destroyed = false;
      worker.once("close", () => {
        destroyed = true;
      });

      await page.goto(fixture.server.CROSS_PROCESS_PREFIX + "/empty.html");
      expect(destroyed).toBe(true);
      expect(page.workers()).toHaveLength(0);
    });
  });

  it("reports worker network activity like Playwright", async () => {
    await withPage(async (page) => {
      const [worker] = await Promise.all([
        page.waitForEvent("worker"),
        page.goto(fixture.server.PREFIX + "/worker/worker.html")
      ]);
      const url = fixture.server.PREFIX + "/one-style.css";
      const requestPromise = page.waitForRequest(url);
      const responsePromise = page.waitForResponse(url);

      await worker.evaluate((targetUrl) => {
        return fetch(targetUrl).then((response) => response.text()).then(console.log);
      }, url);

      const observedRequests = await page.requests();
      expect(observedRequests.some((request) => request.url() === url)).toBe(true);
      const request = await requestPromise;
      const response = await responsePromise;
      expect(request.url()).toBe(url);
      expect(response.request()).toBe(request);
      expect(response.ok()).toBe(true);
      expect(await response.text()).toBe(readFileSync(fixture.asset("one-style.css"), "utf8"));
    });
  });

  it("reports network activity on worker creation like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const url = fixture.server.PREFIX + "/one-style.css";
      const requestPromise = page.waitForRequest(url);
      const responsePromise = page.waitForResponse(url);

      await page.evaluate((targetUrl) => {
        new Worker(URL.createObjectURL(new Blob([`
          fetch("${targetUrl}").then(response => response.text()).then(console.log);
        `], { type: "application/javascript" })));
      }, url);

      const request = await requestPromise;
      const response = await responsePromise;
      expect(request.url()).toBe(url);
      expect(response.request()).toBe(request);
      expect(response.ok()).toBe(true);
    });
  });

  it("reports worker script as network request like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);

      const [requestStarted, requestFinished] = await Promise.all([
        page.waitForEvent("request", (request) => request.url().includes("/worker/worker.js")),
        page.waitForEvent("requestfinished", (request) => request.url().includes("/worker/worker.js")),
        page.evaluate(() => {
          (window as typeof window & { worker?: Worker }).worker = new Worker("/worker/worker.js");
        })
      ]);

      expect(requestStarted.url()).toBe(fixture.server.PREFIX + "/worker/worker.js");
      expect(requestFinished).toBe(requestStarted);
      const response = await requestStarted.response();
      expect(response).not.toBeNull();
      expect(await response!.text()).toContain("hello from the worker");
    });
  });

  it("dispatches page console messages when page has workers like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);

      await Promise.all([
        page.waitForEvent("worker"),
        page.evaluate(() => {
          new Worker(URL.createObjectURL(new Blob(["const x = 1;"], { type: "application/javascript" })));
        })
      ]);

      const [message] = await Promise.all([
        page.waitForEvent("console"),
        page.evaluate(() => {
          console.log("foo");
        })
      ]);

      expect(message.text()).toBe("foo");
    });
  });

  it("attributes network activity for worker inside iframe to the iframe like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const [worker, frame] = await Promise.all([
        page.waitForEvent("worker"),
        attachFrame(page, "frame1", fixture.server.PREFIX + "/worker/worker.html")
      ]);
      const url = fixture.server.PREFIX + "/one-style.css";

      const [request] = await Promise.all([
        page.waitForRequest(url),
        worker.evaluate((targetUrl) => {
          return fetch(targetUrl).then((response) => response.text()).then(console.log);
        }, url)
      ]);

      expect(request.url()).toBe(url);
      expect(request.frame()).toBe(frame);
    });
  });

  it("reports worker script as network request after redirect like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRedirect("/worker.js", "/worker2.js");
      fixture.server.setRoute("/worker2.js", (_request, response) => {
        response.setHeader("Content-Type", "text/javascript");
        response.end("console.log('hello from the worker');");
      });
      const requestPromise = page.waitForEvent("request", (candidate) => candidate.url().includes("/worker.js"));
      const consolePromise = page.waitForEvent("console", (message) => message.text().includes("hello from the worker"));
      await page.evaluate(() => {
        (window as typeof window & { worker?: Worker }).worker = new Worker("/worker.js");
      });
      const request = await requestPromise;

      expect(request.url()).toBe(fixture.server.PREFIX + "/worker.js");
      await expect.poll(() => request.redirectedTo()?.url() ?? null).toBe(
        fixture.server.PREFIX + "/worker2.js"
      );
      const redirect = request.redirectedTo();
      expect(redirect).toBeTruthy();
      expect(redirect!.url()).toBe(fixture.server.PREFIX + "/worker2.js");
      await consolePromise;
      const response = await redirect!.response();
      expect(response).not.toBeNull();
      expect(await response!.text()).toContain("hello from the worker");
    });
  });
});
