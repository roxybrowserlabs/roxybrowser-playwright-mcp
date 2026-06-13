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

      await page.evaluate(`() => {
        console.log("hello from contract test");
      }`);

      const message = await messagePromise;
      expect(message.text()).toBe("hello from contract test");
      expect(message.type()).toBe("log");
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

      await page.evaluate(`() => {
        console.log("first");
        console.log("second");
      }`);

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

      await page.evaluate(`() => {
        for (let index = 0; index < 2; index += 1) {
          console.log("hello");
        }
      }`);

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

      await page.evaluate(`() => {
        console.warn("warn message");
        console.error("error message");
        console.info("info message");
        console.debug("debug message");
      }`);

      expect(messages).toEqual([
        { text: "warn message", type: "warning" },
        { text: "error message", type: "error" },
        { text: "info message", type: "info" },
        { text: "debug message", type: "debug" }
      ]);
    });
  });

  it("fires domcontentloaded and load during navigation", async () => {
    await withPage(async (page) => {
      const events: string[] = [];
      page.on("domcontentloaded", () => {
        events.push("domcontentloaded");
      });
      page.on("load", () => {
        events.push("load");
      });

      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });

      expect(events).toContain("domcontentloaded");
      expect(events).toContain("load");
      expect(events.indexOf("domcontentloaded")).toBeLessThan(events.indexOf("load"));
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
        page.evaluate(`(url) => {
          const iframe = document.getElementById("tracker");
          if (!(iframe instanceof HTMLIFrameElement)) {
            throw new Error("Expected tracker iframe.");
          }
          iframe.src = url;
        }`, fixture.server.PREFIX + "/frame-two.html")
      ]);

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(loadCount).toBe(1);
    });
  });

  it("emits request and response events for the main resource", async () => {
    await withPage(async (page) => {
      const requestPromise = page.waitForEvent("request", (request) => {
        return request.url.endsWith("/simple.json");
      });
      const responsePromise = page.waitForEvent("response", (response) => {
        return response.url.endsWith("/simple.json");
      });

      await page.goto(fixture.server.PREFIX + "/simple.json", { waitUntil: "load" });

      const request = await requestPromise;
      const response = await responsePromise;

      expect(request.method).toBe("GET");
      expect(request.url).toBe(fixture.server.PREFIX + "/simple.json");
      expect(response.status).toBe(200);
      expect(response.statusText).toBe("OK");
      expect(await response.text()).toBe('{"foo": "bar"}\n');
    });
  });

  it("emits request events for iframe navigations", async () => {
    await withPage(async (page) => {
      const requests: string[] = [];
      page.on("request", (request) => {
        requests.push(request.url);
      });

      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      const requestPromise = page.waitForEvent("request", (request) => {
        return request.url.endsWith("/iframe-request-target.html");
      });

      await Promise.all([
        fixture.server.waitForRequest("/iframe-request-target.html"),
        page.evaluate(`(url) => {
          const iframe = document.createElement("iframe");
          iframe.src = url;
          document.body.appendChild(iframe);
        }`, fixture.server.PREFIX + "/iframe-request-target.html")
      ]);

      await requestPromise;

      expect(requests).toContain(fixture.server.PREFIX + "/iframe-request-target.html");
    });
  });

  it("emits request events for fetches", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });

      const requestPromise = page.waitForEvent("request", (request) => {
        return request.url.endsWith("/fetch-request-target.json");
      });

      await page.evaluate(`(url) => {
        void fetch(url);
      }`, fixture.server.PREFIX + "/fetch-request-target.json");

      const request = await requestPromise;
      expect(request.method).toBe("GET");
      expect(request.url).toBe(fixture.server.PREFIX + "/fetch-request-target.json");
    });
  });

  it("fires request before response for fetches", async () => {
    await withPage(async (page) => {
      const events: string[] = [];
      page.on("request", (request) => {
        if (request.url.endsWith("/ordered-response.json")) {
          events.push("request");
        }
      });
      page.on("response", (response) => {
        if (response.url.endsWith("/ordered-response.json")) {
          events.push("response");
        }
      });

      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      await page.evaluate(`(url) => {
        void fetch(url);
      }`, fixture.server.PREFIX + "/ordered-response.json");
      await page.waitForEvent("response", (response) => {
        return response.url.endsWith("/ordered-response.json");
      });

      expect(events).toEqual(["request", "response"]);
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
        return request.url.endsWith("/broken.css");
      });

      await page.goto(fixture.server.PREFIX + "/broken-style-page.html", { waitUntil: "load" });

      const failed = await failedPromise;
      expect(failed.method).toBe("GET");
      expect(failed.url).toBe(fixture.server.PREFIX + "/broken.css");
      expect(failed.errorText.length).toBeGreaterThan(0);
    });
  });
});
