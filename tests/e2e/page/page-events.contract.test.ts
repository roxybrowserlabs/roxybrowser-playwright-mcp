import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page events contract e2e", () => {
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

  it("emits console events and supports waitForEvent", async () => {
    await withPage(async (page) => {
      const messagePromise = page.waitForEvent("console");

      await page.evaluate(() => {
        console.log("hello from contract test");
      });

      const message = await messagePromise;
      expect(message.text()).toBe("hello from contract test");
      expect(message.type()).toBe("log");
    });
  });

  it("matches Playwright console args jsonValue contract", async () => {
    await withPage(async (page) => {
      let message = null as Awaited<ReturnType<typeof page.waitForEvent<"console">>> | null;
      page.once("console", (consoleMessage) => {
        message = consoleMessage;
      });

      await Promise.all([
        page.evaluate(() => console.log("hello", 5, { foo: "bar" })),
        page.waitForEvent("console")
      ]);

      expect(message).not.toBeNull();
      expect(message!.text()).toBe("hello 5 {foo: bar}");
      expect(message!.type()).toBe("log");
      expect(await message!.args()[0]!.jsonValue()).toEqual("hello");
      expect(await message!.args()[1]!.jsonValue()).toEqual(5);
      expect(await message!.args()[2]!.jsonValue()).toEqual({ foo: "bar" });
    });
  });

  it("removeAllListeners with ignoreErrors does not surface async listener failures", async () => {
    await withPage(async (page) => {
      let release!: () => void;
      const unblock = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached = false;

      page.on("console", async () => {
        reached = true;
        await unblock;
        throw new Error("Error in console handler");
      });

      await page.evaluate(() => {
        console.log("listener ignoreErrors");
      });
      await expect.poll(() => reached).toBe(true);

      await page.removeAllListeners("console", { behavior: "ignoreErrors" });
      release();
      await page.waitForTimeout(50);
    });
  });

  it("removeAllListeners with wait waits for pending async listeners", async () => {
    await withPage(async (page) => {
      let release!: () => void;
      const unblock = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached = false;
      let value = 0;

      page.on("console", async () => {
        reached = true;
        await unblock;
        value = 42;
      });

      await page.evaluate(() => {
        console.log("listener wait");
      });
      await expect.poll(() => reached).toBe(true);

      const removePromise = page.removeAllListeners("console", { behavior: "wait" });
      release();
      await removePromise;

      expect(value).toBe(42);
    });
  });

  it("removeAllListeners with wait rethrows async listener failures", async () => {
    await withPage(async (page) => {
      let release!: () => void;
      const unblock = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached = false;

      page.on("console", async () => {
        reached = true;
        await unblock;
        throw new Error("Error in handler");
      });

      await page.evaluate(() => {
        console.log("listener wait error");
      });
      await expect.poll(() => reached).toBe(true);

      const removePromise = page.removeAllListeners("console", { behavior: "wait" });
      release();
      await expect(removePromise).rejects.toThrow("Error in handler");
    });
  });

  it("supports once() and removeListener() semantics for console events", async () => {
    await withPage(async (page) => {
      let onceCount = 0;
      let removedCount = 0;

      page.once("console", () => {
        onceCount++;
      });

      const removedListener = () => {
        removedCount++;
      };
      page.on("console", removedListener);
      page.removeListener("console", removedListener);

      await page.evaluate(() => {
        console.log("first");
        console.log("second");
      });

      expect(onceCount).toBe(1);
      expect(removedCount).toBe(0);
    });
  });

  it("emits the same console log twice", async () => {
    await withPage(async (page) => {
      const messages: string[] = [];
      page.on("console", (message) => {
        messages.push(message.text());
      });

      await page.evaluate(() => {
        for (let index = 0; index < 2; index += 1) {
          console.log("hello");
        }
      });

      expect(messages).toEqual(["hello", "hello"]);
    });
  });

  it("reports different console API types", async () => {
    await withPage(async (page) => {
      const messages: Array<{ text: string; type: string }> = [];
      page.on("console", (message) => {
        messages.push({
          text: message.text(),
          type: message.type()
        });
      });

      await page.evaluate(() => {
        console.warn("warn message");
        console.error("error message");
        console.info("info message");
        console.debug("debug message");
      });

      expect(messages).toEqual([
        { text: "warn message", type: "warning" },
        { text: "error message", type: "error" },
        { text: "info message", type: "info" },
        { text: "debug message", type: "debug" }
      ]);
    });
  });

  it("formats console.time/timeLog/timeEnd like Playwright on Chromium", async () => {
    await withPage(async (page) => {
      const messages: Array<{ text: string; type: string }> = [];
      page.on("console", (message) => {
        messages.push({
          text: message.text(),
          type: message.type()
        });
      });

      await page.evaluate(async () => {
        console.time("foo time");
        await new Promise((resolve) => setTimeout(resolve, 100));
        console.timeLog("foo time");
        await new Promise((resolve) => setTimeout(resolve, 100));
        console.timeEnd("foo time");
      });

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ type: "log" });
      expect(messages[1]).toMatchObject({ type: "timeEnd" });
      expect(messages[0]!.text).toMatch(/foo time: \d+(?:\.\d+)? ?ms/);
      expect(messages[1]!.text).toMatch(/foo time: \d+(?:\.\d+)? ?ms/);
    });
  });

  it("exposes console message location like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const [message] = await Promise.all([
        page.waitForEvent("console", (entry) => entry.text().startsWith("here:")),
        page.goto(fixture.server.PREFIX + "/consolelog.html")
      ]);

      expect(message.type()).toBe("log");
      expect(message.location()).toEqual({
        url: fixture.server.PREFIX + "/consolelog.html",
        line: 11,
        lineNumber: 11,
        column: 14,
        columnNumber: 14
      });
    });
  });

  it("uses object previews for arrays and objects", async () => {
    await withPage(async (page) => {
      let text = "";
      page.on("console", (message) => {
        text = message.text();
      });

      await page.evaluate(() => console.log([1, 2, 3], { a: 1 }, window));

      expect(text).toBe("[1, 2, 3] {a: 1} Window");
    });
  });

  it("exposes console timestamps like Playwright", async () => {
    await withPage(async (page) => {
      const before = Date.now() - 100;
      const [message] = await Promise.all([
        page.waitForEvent("console"),
        page.evaluate(() => console.log("timestamp test"))
      ]);
      const after = Date.now() + 100;

      expect(message.timestamp()).toBeGreaterThanOrEqual(before);
      expect(message.timestamp()).toBeLessThanOrEqual(after);
    });
  });

  it("keeps console timestamps monotonic", async () => {
    await withPage(async (page) => {
      const messages: Array<Awaited<ReturnType<typeof page.waitForEvent<"console">>>> = [];
      page.on("console", (message) => {
        messages.push(message);
      });

      await page.evaluate(() => {
        console.log("first");
        console.log("second");
        console.log("third");
      });

      expect(messages).toHaveLength(3);
      expect(messages[1]!.timestamp()).toBeGreaterThanOrEqual(messages[0]!.timestamp());
      expect(messages[2]!.timestamp()).toBeGreaterThanOrEqual(messages[1]!.timestamp());
    });
  });

  it("consoleMessages defaults to since-navigation like Playwright", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => console.log("before navigation"));
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.evaluate(() => console.log("after navigation"));

      const all = await page.consoleMessages({ filter: "all" });
      expect(all.map((message) => message.text())).toContain("before navigation");
      expect(all.map((message) => message.text())).toContain("after navigation");

      const defaultMessages = await page.consoleMessages();
      expect(defaultMessages.map((message) => message.text())).not.toContain("before navigation");
      expect(defaultMessages.map((message) => message.text())).toContain("after navigation");
      expect((await page.consoleMessages({ filter: "since-navigation" })).map((message) => message.text())).toEqual(
        defaultMessages.map((message) => message.text())
      );
    });
  });

  it("fires domcontentloaded and load during navigation", async () => {
    await withPage(async (page) => {
      const events: string[] = [];
      const seenPages: Array<"domcontentloaded" | "load"> = [];
      page.on("domcontentloaded", (eventPage) => {
        expect(eventPage).toBe(page);
        events.push("domcontentloaded");
        seenPages.push("domcontentloaded");
      });
      page.on("load", (eventPage) => {
        expect(eventPage).toBe(page);
        events.push("load");
        seenPages.push("load");
      });

      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });

      expect(events).toContain("domcontentloaded");
      expect(events).toContain("load");
      expect(seenPages).toEqual(["domcontentloaded", "load"]);
      expect(events.indexOf("domcontentloaded")).toBeLessThan(events.indexOf("load"));
    });
  });

  it("emits popup events and preserves opener()", async () => {
    await withPage(async (page) => {
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate(() => {
          window.__popup = window.open("about:blank");
        })
      ]);

      expect(await popup.opener()).toBe(page);
      expect(await popup.evaluate(() => !!window.opener)).toBe(true);
    });
  });

  it("fires load once for the main page and not for iframe navigation", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/page-with-iframe.html", (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html>
          <html lang="en">
            <body>
              <iframe id="tracker" src="${fixture.server.PREFIX}/frame-one.html"></iframe>
            </body>
          </html>`);
      });
      fixture.server.setContent("/frame-one.html", "<div>frame one</div>", "text/html");
      fixture.server.setContent("/frame-two.html", "<div>frame two</div>", "text/html");

      let loadCount = 0;
      page.on("load", () => {
        loadCount += 1;
      });

      await page.goto(fixture.server.PREFIX + "/page-with-iframe.html", { waitUntil: "load" });

      await Promise.all([
        fixture.server.waitForRequest("/frame-two.html"),
        page.evaluate((url) => {
          const iframe = document.getElementById("tracker");
          if (!(iframe instanceof HTMLIFrameElement)) {
            throw new Error("Expected tracker iframe.");
          }
          iframe.src = url;
        }, fixture.server.PREFIX + "/frame-two.html")
      ]);

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(loadCount).toBe(1);
    });
  });

  it("does not fire page load for form submissions targeted at an iframe like Playwright", async () => {
    await withPage(async (page) => {
      let requestCount = 0;
      fixture.server.setRoute("/tracker", (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`request count: ${++requestCount}`);
      });
      fixture.server.setRoute("/home", (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`
          <!DOCTYPE html>
          <html>
            <body>
              <script>
                window.eventLog = [];
                window.addEventListener('load', () => window.eventLog.push('load'));
              </script>
              <form id="trackerForm" action="/tracker" method="post" target="tracker">
                <input type="submit">
              </form>
              <iframe name="tracker" src="/tracker"></iframe>
            </body>
          </html>
        `);
      });

      let loadCount = 0;
      page.on("load", () => {
        loadCount += 1;
      });

      await page.goto(fixture.server.PREFIX + "/home", { waitUntil: "load" });
      await expect.poll(async () => page.frame("tracker")?.locator("body").textContent()).toContain("request count: 1");

      const loadFired = Promise.race([
        page.waitForEvent("load").then(() => "loadfired"),
        page.waitForTimeout(1000).then(() => "timeout")
      ]);
      await page.locator('input[type="submit"]').click();

      expect(await loadFired).toBe("timeout");
      expect(loadCount).toBe(1);
      expect(await page.evaluate(() => window["eventLog"])).toEqual(["load"]);
      expect(await page.frame("tracker")!.locator("body").textContent()).toContain("request count: 2");
    });
  });

  it("emits frameattached, framenavigated and framedetached for dynamic iframes", async () => {
    await withPage(async (page) => {
      const attached: string[] = [];
      const navigated: string[] = [];
      const detached: Array<{ url: string; detached: boolean }> = [];

      page.on("frameattached", (frame) => {
        attached.push(frame.url());
      });
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) {
          navigated.push(frame.url());
        }
      });
      page.on("framedetached", (frame) => {
        detached.push({
          url: frame.url(),
          detached: frame.isDetached()
        });
      });

      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });

      await Promise.all([
        page.waitForEvent("frameattached"),
        page.waitForEvent("framenavigated", (frame) => frame !== page.mainFrame()),
        page.evaluate((url) => {
          const iframe = document.createElement("iframe");
          iframe.id = "dynamic-frame";
          iframe.src = url;
          document.body.appendChild(iframe);
          return new Promise((resolve, reject) => {
            iframe.onload = () => resolve(undefined);
            iframe.onerror = () => reject(new Error("iframe failed to load"));
          });
        }, fixture.server.PREFIX + "/frame-one.html")
      ]);

      await Promise.all([
        page.waitForEvent("framenavigated", (frame) => frame.url().endsWith("/frame-two.html")),
        page.evaluate((url) => {
          const iframe = document.getElementById("dynamic-frame");
          if (!(iframe instanceof HTMLIFrameElement)) {
            throw new Error("Expected dynamic iframe.");
          }
          iframe.src = url;
          return new Promise((resolve, reject) => {
            iframe.onload = () => resolve(undefined);
            iframe.onerror = () => reject(new Error("iframe failed to reload"));
          });
        }, fixture.server.PREFIX + "/frame-two.html")
      ]);

      await Promise.all([
        page.waitForEvent("framedetached"),
        page.evaluate(() => {
          document.getElementById("dynamic-frame")?.remove();
        })
      ]);

      expect(attached).toContain(fixture.server.PREFIX + "/frame-one.html");
      expect(navigated).toContain(fixture.server.PREFIX + "/frame-one.html");
      expect(navigated).toContain(fixture.server.PREFIX + "/frame-two.html");
      expect(detached).toEqual([
        {
          url: fixture.server.PREFIX + "/frame-two.html",
          detached: true
        }
      ]);
    });
  });

  it("emits request and response events for the main resource", async () => {
    await withPage(async (page) => {
      const requestPromise = page.waitForEvent("request", (request) => {
        return request.url().endsWith("/simple.json");
      });
      const responsePromise = page.waitForEvent("response", (response) => {
        return response.url().endsWith("/simple.json");
      });

      await page.goto(fixture.server.PREFIX + "/simple.json", { waitUntil: "load" });

      const request = await requestPromise;
      const response = await responsePromise;

      expect(request.method()).toBe("GET");
      expect(request.url()).toBe(fixture.server.PREFIX + "/simple.json");
      expect(response.status()).toBe(200);
      expect(response.statusText()).toBe("OK");
      expect(await response.text()).toBe('{"foo": "bar"}\n');
    });
  });

  it("fires request for navigation requests like Playwright", async () => {
    await withPage(async (page) => {
      const requests: unknown[] = [];
      page.on("request", (request) => requests.push(request));

      await page.goto(fixture.server.EMPTY_PAGE);

      expect(requests.length).toBe(1);
    });
  });

  it("fires request for iframes like Playwright", async () => {
    await withPage(async (page) => {
      const requests: unknown[] = [];
      page.on("request", (request) => requests.push(request));

      await page.goto(fixture.server.EMPTY_PAGE);
      await page.evaluate((url) => {
        const iframe = document.createElement("iframe");
        iframe.src = url;
        document.body.appendChild(iframe);
        return new Promise<void>((resolve) => {
          iframe.onload = () => resolve();
        });
      }, fixture.server.EMPTY_PAGE);

      expect(requests.length).toBe(2);
    });
  });

  it("fires request for fetches like Playwright", async () => {
    await withPage(async (page) => {
      const requests: unknown[] = [];
      page.on("request", (request) => requests.push(request));

      await page.goto(fixture.server.EMPTY_PAGE);
      await page.evaluate(() => fetch("/empty.html"));

      expect(requests.length).toBe(2);
    });
  });

  it("fires request for fetches with keepalive true like Playwright", async () => {
    await withPage(async (page) => {
      const requests: unknown[] = [];
      page.on("request", (request) => requests.push(request));

      await page.goto(fixture.server.EMPTY_PAGE);
      await page.evaluate(() => fetch("/empty.html", { keepalive: true }));

      expect(requests.length).toBe(2);
    });
  });

  it("emits request events for iframe navigations", async () => {
    await withPage(async (page) => {
      const requests: string[] = [];
      page.on("request", (request) => {
        requests.push(request.url());
      });

      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      const requestPromise = page.waitForEvent("request", (request) => {
        return request.url().endsWith("/iframe-request-target.html");
      });

      await Promise.all([
        fixture.server.waitForRequest("/iframe-request-target.html"),
        page.evaluate((url) => {
          const iframe = document.createElement("iframe");
          iframe.src = url;
          document.body.appendChild(iframe);
        }, fixture.server.PREFIX + "/iframe-request-target.html")
      ]);

      await requestPromise;

      expect(requests).toContain(fixture.server.PREFIX + "/iframe-request-target.html");
    });
  });

  it("emits request events for fetches", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });

      const requestPromise = page.waitForEvent("request", (request) => {
        return request.url().endsWith("/fetch-request-target.json");
      });

      await page.evaluate((url) => {
        void fetch(url);
      }, fixture.server.PREFIX + "/fetch-request-target.json");

      const request = await requestPromise;
      expect(request.method()).toBe("GET");
      expect(request.url()).toBe(fixture.server.PREFIX + "/fetch-request-target.json");
    });
  });

  it("returns response body when Cross-Origin-Opener-Policy is set like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/empty.html", (_request, response) => {
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        response.end(`
          <div>Hello there!</div>
          <script>window.onload = () => console.log('onload')</script>
        `);
      });

      const response = await page.goto(fixture.server.EMPTY_PAGE);

      expect(page.url()).toBe(fixture.server.EMPTY_PAGE);
      await response!.finished();
      expect(response!.request().failure()).toBeNull();
      expect(await response!.text()).toContain("Hello there!");
    });
  });

  it("fires request before response for fetches", async () => {
    await withPage(async (page) => {
      const events: string[] = [];
      page.on("request", (request) => {
        if (request.url().endsWith("/ordered-response.json")) {
          events.push("request");
        }
      });
      page.on("response", (response) => {
        if (response.url().endsWith("/ordered-response.json")) {
          events.push("response");
        }
      });

      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      const responsePromise = page.waitForEvent("response", (response) => {
        return response.url().endsWith("/ordered-response.json");
      });
      await page.evaluate((url) => {
        void fetch(url);
      }, fixture.server.PREFIX + "/ordered-response.json");
      await responsePromise;

      expect(events).toEqual(["request", "response"]);
    });
  });

  it("reports requests and responses handled by service worker like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/serviceworkers/fetchdummy/sw.html");
      await page.evaluate(() => (window as typeof window & { activationPromise: Promise<void> }).activationPromise);

      const [request, swResponse] = await Promise.all([
        page.waitForEvent("request"),
        page.evaluate(() =>
          (window as typeof window & { fetchDummy(name: string): Promise<string> }).fetchDummy("foo")
        )
      ]);

      expect(swResponse).toBe("responseFromServiceWorker:foo");
      expect(request.url()).toBe(fixture.server.PREFIX + "/serviceworkers/fetchdummy/foo");
      expect(request.serviceWorker()).toBe(null);
      const response = await request.response();
      expect(response!.url()).toBe(fixture.server.PREFIX + "/serviceworkers/fetchdummy/foo");
      expect(await response!.text()).toBe("responseFromServiceWorker:foo");
      expect(response!.fromServiceWorker()).toBe(true);

      const [failedRequest] = await Promise.all([
        page.waitForEvent("requestfailed"),
        page.evaluate(() =>
          (window as typeof window & { fetchDummy(name: string): Promise<string> }).fetchDummy("error")
        ).catch((error) => error)
      ]);
      expect(failedRequest.url()).toBe(fixture.server.PREFIX + "/serviceworkers/fetchdummy/error");
      expect(failedRequest.failure()).not.toBe(null);
      expect(failedRequest.serviceWorker()).toBe(null);
      expect(await failedRequest.response()).toBe(null);
    });
  });

  it("reports service worker requests with routing like Playwright", async () => {
    await withPage(async (page) => {
      const interceptedUrls: string[] = [];
      await page.route("**/*", (route) => {
        interceptedUrls.push(route.request().url());
        void route.continue();
      });

      await page.goto(fixture.server.PREFIX + "/serviceworkers/fetchdummy/sw.html");
      await page.evaluate(() => (window as typeof window & { activationPromise: Promise<void> }).activationPromise);

      const [swResponse, request] = await Promise.all([
        page.evaluate(() =>
          (window as typeof window & { fetchDummy(name: string): Promise<string> }).fetchDummy("foo")
        ),
        page.waitForEvent("request")
      ]);

      expect(swResponse).toBe("responseFromServiceWorker:foo");
      expect(request.url()).toBe(fixture.server.PREFIX + "/serviceworkers/fetchdummy/foo");
      expect(request.serviceWorker()).toBe(null);
      const response = await request.response();
      expect(response!.url()).toBe(fixture.server.PREFIX + "/serviceworkers/fetchdummy/foo");
      expect(await response!.text()).toBe("responseFromServiceWorker:foo");

      const [failedRequest] = await Promise.all([
        page.waitForEvent("requestfailed"),
        page.evaluate(() =>
          (window as typeof window & { fetchDummy(name: string): Promise<string> }).fetchDummy("error")
        ).catch((error) => error)
      ]);
      expect(failedRequest.url()).toBe(fixture.server.PREFIX + "/serviceworkers/fetchdummy/error");
      expect(failedRequest.failure()).not.toBe(null);
      expect(failedRequest.serviceWorker()).toBe(null);
      expect(await failedRequest.response()).toBe(null);

      expect(interceptedUrls).toEqual([
        fixture.server.PREFIX + "/serviceworkers/fetchdummy/sw.html"
      ]);
    });
  });

  it("reports navigation requests and responses handled by service worker like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/serviceworkers/stub/sw.html");
      await page.evaluate(() => (window as typeof window & { activationPromise: Promise<void> }).activationPromise);

      const reloadResponse = await page.reload();

      expect(await page.evaluate("window.fromSW")).toBe(true);
      expect(reloadResponse!.url()).toBe(fixture.server.PREFIX + "/serviceworkers/stub/sw.html");
      expect(reloadResponse!.fromServiceWorker()).toBe(true);
      expect(reloadResponse!.request().serviceWorker()).toBe(null);
    });
  });

  it("reports navigation requests handled by service worker with routing like Playwright", async () => {
    await withPage(async (page) => {
      await page.route("**/*", (route) => route.continue());
      await page.goto(fixture.server.PREFIX + "/serviceworkers/stub/sw.html");
      await page.evaluate(() => (window as typeof window & { activationPromise: Promise<void> }).activationPromise);

      const reloadResponse = await page.reload();

      expect(await page.evaluate("window.fromSW")).toBe(true);
      expect(reloadResponse!.url()).toBe(fixture.server.PREFIX + "/serviceworkers/stub/sw.html");
      expect(reloadResponse!.fromServiceWorker()).toBe(true);
      expect(reloadResponse!.request().serviceWorker()).toBe(null);
    });
  });

  it("does not expose preflight OPTIONS request like Playwright", async () => {
    await withPage(async (page) => {
      const serverRequests: string[] = [];
      fixture.server.setRoute("/cors", (request, response) => {
        serverRequests.push(`${request.method} ${request.url}`);
        if (request.method === "OPTIONS") {
          response.writeHead(204, {
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
            "Access-Control-Allow-Origin": "*"
          });
          response.end();
          return;
        }
        response.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Content-type": "text/plain"
        });
        response.end("Hello there!");
      });
      const clientRequests: string[] = [];
      page.on("request", (request) => {
        clientRequests.push(`${request.method()} ${request.url()}`);
      });

      const response = await page.evaluate(async (url) => {
        const response = await fetch(url, {
          body: "",
          headers: {
            "Content-Type": "application/json",
            "X-Custom-Header": "test-value"
          },
          method: "POST"
        });
        return response.text();
      }, fixture.server.CROSS_PROCESS_PREFIX + "/cors");

      expect(response).toBe("Hello there!");
      expect(serverRequests).toEqual(["OPTIONS /cors", "POST /cors"]);
      expect(clientRequests).toEqual([
        `POST ${fixture.server.CROSS_PROCESS_PREFIX}/cors`
      ]);
    });
  });

  it("does not expose preflight OPTIONS request with network interception like Playwright", async () => {
    await withPage(async (page) => {
      const serverRequests: string[] = [];
      fixture.server.setRoute("/cors", (request, response) => {
        serverRequests.push(`${request.method} ${request.url}`);
        if (request.method === "OPTIONS") {
          response.writeHead(204, {
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
            "Access-Control-Allow-Origin": "*"
          });
          response.end();
          return;
        }
        response.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Content-type": "text/plain"
        });
        response.end("Hello there!");
      });
      await page.route("**/*", (route) => route.continue());
      const clientRequests: string[] = [];
      page.on("request", (request) => {
        clientRequests.push(`${request.method()} ${request.url()}`);
      });

      const response = await page.evaluate(async (url) => {
        const response = await fetch(url, {
          body: "",
          headers: {
            "Content-Type": "application/json",
            "X-Custom-Header": "test-value"
          },
          method: "POST"
        });
        return response.text();
      }, fixture.server.CROSS_PROCESS_PREFIX + "/cors");

      expect(response).toBe("Hello there!");
      expect(serverRequests).toEqual(["POST /cors"]);
      expect(clientRequests).toEqual([
        `POST ${fixture.server.CROSS_PROCESS_PREFIX}/cors`
      ]);
    });
  });

  it("finishes 204 requests like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/204", (_request, response) => {
        response.writeHead(204, { "Content-type": "text/plain" });
        response.end();
      });
      await page.goto(fixture.server.EMPTY_PAGE);
      const requestPromise = Promise.race([
        page.waitForEvent("requestfailed", (request) => request.url().endsWith("/204")).then(() => "requestfailed"),
        page.waitForEvent("requestfinished", (request) => request.url().endsWith("/204")).then(() => "requestfinished")
      ]);

      await page.evaluate((url) => {
        void fetch(url);
      }, fixture.server.PREFIX + "/204");

      expect(await requestPromise).toBe("requestfinished");
    });
  });

  it("returns last requests as Playwright Request objects", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/title.html");
      for (let index = 0; index < 200; index += 1) {
        fixture.server.setRoute(`/fetch?${index}`, (request, response) => {
          response.end(`url:${fixture.server.PREFIX}${request.url}`);
        });
      }

      for (let index = 0; index < 99; index += 1) {
        await page.evaluate((url) => fetch(url), fixture.server.PREFIX + `/fetch?${index}`);
      }
      const first99Requests = await page.requests();
      first99Requests.shift();

      for (let index = 99; index < 199; index += 1) {
        await page.evaluate((url) => fetch(url), fixture.server.PREFIX + `/fetch?${index}`);
      }
      const last100Requests = await page.requests();
      const allRequests = [...first99Requests, ...last100Requests];

      const received = await Promise.all(allRequests.map(async (request) => {
        const response = await request.response();
        return {
          text: await response!.text(),
          url: request.url()
        };
      }));
      const expected = [];
      for (let index = 0; index < 199; index += 1) {
        const url = fixture.server.PREFIX + `/fetch?${index}`;
        expected.push({ text: `url:${url}`, url });
      }
      expect(received).toEqual(expected);
    });
  });

  it("emits requestfailed for a broken stylesheet request", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/broken-style-page.html", (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html>
          <html lang="en">
            <head>
              <link rel="stylesheet" href="/broken.css" />
            </head>
            <body>broken stylesheet</body>
          </html>`);
      });
      fixture.server.setRoute("/broken.css", (_request, response) => {
        response.destroy();
      });

      const failedPromise = page.waitForEvent("requestfailed", (request) => {
        return request.url().endsWith("/broken.css");
      });

      await page.goto(fixture.server.PREFIX + "/broken-style-page.html", { waitUntil: "load" });

      const failed = await failedPromise;
      expect(failed.method()).toBe("GET");
      expect(failed.url()).toBe(fixture.server.PREFIX + "/broken.css");
      expect(failed.failure()?.errorText.length ?? 0).toBeGreaterThan(0);
    });
  });

  it("fires requestfailed when intercepting race", async () => {
    await withPage(async (page) => {
      const promise = new Promise<void>((resolve) => {
        let counter = 0;
        const failures = new Set();
        const alive = new Set();
        page.on("request", (request) => {
          expect(alive.has(request)).toBe(false);
          expect(failures.has(request)).toBe(false);
          alive.add(request);
        });
        page.on("requestfailed", (request) => {
          expect(failures.has(request)).toBe(false);
          expect(alive.has(request)).toBe(true);
          alive.delete(request);
          failures.add(request);
          if (++counter === 10) {
            resolve();
          }
        });
      });

      await page.route("**", () => {});

      await page.setContent(`
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <iframe src="${fixture.server.EMPTY_PAGE}"></iframe>
        <script>
          function abortAll() {
            const frames = document.querySelectorAll("iframe");
            for (const frame of frames)
              frame.src = "about:blank";
          }
          abortAll();
        </script>
      `);

      await promise;
    });
  });

  it("main resource xhr should have type xhr", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const [request] = await Promise.all([
        page.waitForEvent("request"),
        page.evaluate(() => {
          const x = new XMLHttpRequest();
          x.open("GET", location.href, false);
          x.send();
        })
      ]);
      expect(request.isNavigationRequest()).toBe(false);
      expect(request.resourceType()).toBe("xhr");
    });
  });

  it("<picture> resource should have type image", async () => {
    await withPage(async (page) => {
      const [request] = await Promise.all([
        page.waitForEvent("request"),
        page.setContent(`
          <picture>
            <source>
              <img src="https://www.wikipedia.org/portal/wikipedia.org/assets/img/Wikipedia-logo-v2@2x.png">
            </source>
          </picture>
        `)
      ]);
      expect(request.resourceType()).toBe("image");
    });
  });

  it("supports redirects with Playwright-style request/response chaining", async () => {
    await withPage(async (page) => {
      const fooUrl = fixture.server.PREFIX + "/foo.html";
      const events: Record<string, Array<string | number>> = {
        [fooUrl]: [],
        [fixture.server.EMPTY_PAGE]: []
      };

      page.on("request", (request) => {
        events[request.url()]?.push(request.method());
      });
      page.on("response", (response) => {
        events[response.url()]?.push(response.status());
      });
      page.on("requestfinished", (request) => {
        events[request.url()]?.push("DONE");
      });
      page.on("requestfailed", (request) => {
        events[request.url()]?.push("FAIL");
      });

      fixture.server.setRedirect("/foo.html", "/empty.html");
      const response = await page.goto(fooUrl, { waitUntil: "load" });
      await response!.finished();

      expect(events).toEqual({
        [fooUrl]: ["GET", 302, "DONE"],
        [fixture.server.EMPTY_PAGE]: ["GET", 200, "DONE"]
      });

      const redirectedFrom = response!.request().redirectedFrom();
      expect(redirectedFrom).toBeTruthy();
      expect(redirectedFrom!.url()).toContain("/foo.html");
      expect(redirectedFrom!.redirectedFrom()).toBe(null);
      expect(redirectedFrom!.redirectedTo()).toBe(response!.request());
    });
  });
});
