import type { ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page network response e2e", () => {
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

  it("reports allHeaders() with lower-cased lookup semantics like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/empty.html", (_request, response) => {
        response.setHeader("foo", "bar");
        response.setHeader("BaZ", "bAz");
        response.end();
      });

      const response = await page.goto(fixture.server.EMPTY_PAGE, {
        waitUntil: "load"
      });

      const headers = await response!.allHeaders();
      expect(headers.foo).toBe("bar");
      expect(headers.baz).toBe("bAz");
      expect((headers as Record<string, string | undefined>).BaZ).toBe(undefined);
    });
  });

  it("should return text", async () => {
    await withPage(async (page) => {
      const response = await page.goto(fixture.server.PREFIX + "/simple.json", {
        waitUntil: "load"
      });

      expect(response).toBeTruthy();
      expect(await response!.text()).toBe('{"foo": "bar"}\n');
    });
  });

  it("returns json()", async () => {
    await withPage(async (page) => {
      const response = await page.goto(fixture.server.PREFIX + "/simple.json", {
        waitUntil: "load"
      });

      expect(await response!.json()).toEqual({ foo: "bar" });
    });
  });

  it("returns body()", async () => {
    await withPage(async (page) => {
      const expected = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==",
        "base64"
      );
      fixture.server.setRoute("/image.png", (_request, response) => {
        response.writeHead(200, {
          "Content-Type": "image/png"
        });
        response.end(expected);
      });

      const response = await page.goto(fixture.server.PREFIX + "/image.png", {
        waitUntil: "load"
      });

      expect(await response!.body()).toEqual(expected);
    });
  });

  it("returns body() with compression", async () => {
    await withPage(async (page) => {
      const expected = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==",
        "base64"
      );
      const compressed = gzipSync(expected);
      fixture.server.setRoute("/image-compressed.png", (_request, response) => {
        response.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Encoding": "gzip"
        });
        response.end(compressed);
      });

      const response = await page.goto(fixture.server.PREFIX + "/image-compressed.png", {
        waitUntil: "load"
      });

      expect(await response!.body()).toEqual(expected);
    });
  });

  it("returns uncompressed text for gzip responses", async () => {
    await withPage(async (page) => {
      const text = '{"foo": "bar"}\n';
      const compressed = gzipSync(Buffer.from(text, "utf8"));
      fixture.server.setRoute("/gzip.json", (_request, response) => {
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Encoding": "gzip"
        });
        response.end(compressed);
      });

      const response = await page.goto(fixture.server.PREFIX + "/gzip.json", {
        waitUntil: "load"
      });

      expect(response!.headers()["content-encoding"]).toBe("gzip");
      expect(await response!.text()).toBe(text);
    });
  });

  it("returns multiple header values merged like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/headers", (_request, response) => {
        const conn = response.connection;
        conn.write("HTTP/1.1 200 OK\r\n");
        conn.write("Name-A: v1\r\n");
        conn.write("Name-a: v2\r\n");
        conn.write("name-A: v3\r\n");
        conn.write("\r\n");
        conn.uncork();
        conn.end();
      });

      const response = await page.goto(fixture.server.PREFIX + "/headers", {
        waitUntil: "load"
      });
      expect(response!.status()).toBe(200);
      expect(response!.headers()["name-a"]).toBe("v1, v2, v3");
    });
  });

  it("exposes response headers and status with Playwright-style response methods", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/headers.json", (_request, response) => {
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "X-Test": "contract"
        });
        response.end('{"ok": true}\n');
      });

      const response = await page.goto(fixture.server.PREFIX + "/headers.json", {
        waitUntil: "load"
      });

      expect(response).toBeTruthy();
      expect(response!.status()).toBe(200);
      expect(response!.statusText()).toBe("OK");
      expect(response!.ok()).toBe(true);
      expect(response!.url()).toBe(fixture.server.PREFIX + "/headers.json");
      expect(response!.headers()["content-type"]).toBe("application/json; charset=utf-8");
      expect(await response!.allHeaders()).toMatchObject({
        "content-type": "application/json; charset=utf-8",
        "x-test": "contract"
      });
      expect(await response!.text()).toBe('{"ok": true}\n');
    });
  });

  it("returns custom status text", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/custom-status-text", (_request, response) => {
        response.writeHead(200, "cool!");
        response.end("nice");
      });

      const response = await page.goto(fixture.server.PREFIX + "/custom-status-text", {
        waitUntil: "load"
      });

      expect(response).toBeTruthy();
      expect(response!.status()).toBe(200);
      expect(response!.statusText()).toBe("cool!");
      expect(await response!.text()).toBe("nice");
    });
  });

  it("throws when requesting the body of a redirected response", async () => {
    await withPage(async (page) => {
      fixture.server.setRedirect("/foo.html", "/empty.html");
      const response = await page.goto(fixture.server.PREFIX + "/foo.html", {
        waitUntil: "load"
      });

      const redirectedFrom = response!.request().redirectedFrom();
      expect(redirectedFrom).toBeTruthy();
      const redirectedResponse = await redirectedFrom!.response();
      expect(redirectedResponse!.status()).toBe(302);
      await expect(redirectedResponse!.text()).rejects.toThrow(
        "Response body is unavailable for redirect responses"
      );
      await expect(redirectedResponse!.finished()).resolves.toBeNull();
    });
  });

  it("preserves duplicate response headers and set-cookie separators", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/cookies", (_request, response) => {
        response.writeHead(200, {
          "Set-Cookie": ["a=b", "c=d"],
          "X-Test": "ok"
        });
        response.end("ok");
      });

      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      const [response] = await Promise.all([
        page.waitForResponse(/cookies$/),
        page.evaluate(() => fetch("/cookies"))
      ]);

      const cookies = (await response.headersArray())
        .filter(({ name }) => name.toLowerCase() === "set-cookie")
        .map(({ value }) => value);
      expect(cookies).toEqual(["a=b", "c=d"]);
      expect(await response.headerValue("not-there")).toBeNull();
      expect(await response.headerValue("set-cookie")).toBe("a=b\nc=d");
      expect(await response.headerValues("set-cookie")).toEqual(["a=b", "c=d"]);
      expect((await response.allHeaders())["x-test"]).toBe("ok");
    });
  });

  it("behaves the same way for headers() and allHeaders()", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/all-headers", (_request, response) => {
        response.writeHead(200, {
          "Set-Cookie": ["a=b", "c=d"],
          "Header-A": ["a=b", "c=d"],
          "Name-A": ["v1", "v2", "v3"],
          "Name-B": "v4"
        });
        response.end("ok");
      });

      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      const [response] = await Promise.all([
        page.waitForResponse(/all-headers$/),
        page.evaluate(() => fetch("/all-headers"))
      ]);

      const allHeaders = await response.allHeaders();
      expect(response.headers()).toEqual(allHeaders);
      expect(allHeaders["header-a"]).toBe("a=b, c=d");
      expect(allHeaders["name-a"]).toBe("v1, v2, v3");
      expect(allHeaders["name-b"]).toBe("v4");
      expect(allHeaders["set-cookie"]).toBe("a=b\nc=d");
    });
  });

  it("reports all headers arrays including duplicate non-cookie headers", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/headers-array", (_request, response) => {
        response.writeHead(200, {
          "header-a": ["value-a", "value-a-1", "value-a-2"],
          "header-b": ["value-b"]
        });
        response.end();
      });

      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      const [response] = await Promise.all([
        page.waitForResponse(/headers-array$/),
        page.evaluate(() => fetch("/headers-array"))
      ]);
      const headers = await response.headersArray();
      const actualHeaders: Record<string, string[]> = {};
      for (const { name, value } of headers) {
        actualHeaders[name] ??= [];
        actualHeaders[name].push(value);
      }
      delete actualHeaders["Keep-Alive"];
      delete actualHeaders["keep-alive"];
      delete actualHeaders.Connection;
      delete actualHeaders.connection;
      delete actualHeaders.Date;
      delete actualHeaders.date;
      delete actualHeaders["Transfer-Encoding"];
      delete actualHeaders["transfer-encoding"];

      expect(actualHeaders).toEqual({
        "header-a": ["value-a", "value-a-1", "value-a-2"],
        "header-b": ["value-b"]
      });
    });
  });

  it("request.existingResponse is null before response and set after response arrives", async () => {
    await withPage(async (page) => {
      let serverResponse: ServerResponse | null = null;
      fixture.server.setRoute("/existing-response.json", (_request, response) => {
        serverResponse = response;
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8"
        });
      });

      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });

      const requestPromise = page.waitForRequest(/existing-response\.json$/);
      const responsePromise = page.waitForResponse(/existing-response\.json$/);

      await Promise.all([
        fixture.server.waitForRequest("/existing-response.json"),
        page.evaluate((url) => {
          void fetch(url);
        }, fixture.server.PREFIX + "/existing-response.json")
      ]);

      const request = await requestPromise;
      expect(request.existingResponse()).toBeNull();

      serverResponse!.end('{"ok": true}');
      const response = await responsePromise;
      expect(request.existingResponse()).toBe(response);
      expect(await request.response()).toBe(response);
      expect(response.request()).toBe(request);
    });
  });

  it("request.existingResponse returns the response after it is received", async () => {
    await withPage(async (page) => {
      const response = await page.goto(fixture.server.EMPTY_PAGE, {
        waitUntil: "load"
      });
      const request = response!.request();
      expect(request.existingResponse()).toBe(response);
    });
  });

  it("returns httpVersion()", async () => {
    await withPage(async (page) => {
      const response = await page.goto(fixture.server.PREFIX + "/simple.json", {
        waitUntil: "load"
      });

      expect(await response!.httpVersion()).toBe("HTTP/1.1");
    });
  });

  it("returns headers after route.fulfill()", async () => {
    await withPage(async (page) => {
      await page.route("**/*", async (route) => {
        await route.fulfill({
          status: 200,
          headers: {
            foo: "bar",
            "content-language": "en"
          },
          contentType: "text/plain",
          body: "done"
        });
      });

      const response = await page.goto(fixture.server.EMPTY_PAGE, {
        waitUntil: "load"
      });

      expect(await response!.allHeaders()).toEqual({
        foo: "bar",
        "content-type": "text/plain",
        "content-length": "4",
        "content-language": "en"
      });
    });
  });

  it("provides a Response with a file URL", async () => {
    await withPage(async (page) => {
      const fileUrl = pathToFileURL(fixture.asset("frames/two-frames.html")).href;
      const response = await page.goto(fileUrl, {
        waitUntil: "load"
      });

      expect(response).toBeTruthy();
      expect(response!.status()).toBe(200);
      expect(response!.ok()).toBe(true);
    });
  });

  it("returns set-cookie header after route.fulfill()", async () => {
    await withPage(async (page) => {
      await page.route("**/*", async (route) => {
        await route.fulfill({
          status: 200,
          headers: {
            "set-cookie": "a=b"
          },
          contentType: "text/plain",
          body: ""
        });
      });

      const response = await page.goto(fixture.server.EMPTY_PAGE, {
        waitUntil: "load"
      });

      const headers = await response!.allHeaders();
      expect(headers["set-cookie"]).toBe("a=b");
    });
  });

  it("returns multiple set-cookie headers after route.fulfill()", async () => {
    await withPage(async (page) => {
      await page.route("**/multiple-set-cookie.html", async (route) => {
        await route.fulfill({
          status: 200,
          headers: {
            "X-Header-1": "v1",
            "Set-Cookie": "a=b\nc=d",
            "X-Header-2": "v2"
          },
          body: ""
        });
      });

      const response = await page.goto(fixture.server.PREFIX + "/multiple-set-cookie.html", {
        waitUntil: "load"
      });

      expect((await page.evaluate(() => document.cookie)).split(";").map((value) => value.trim()).sort()).toEqual([
        "a=b",
        "c=d"
      ]);
      expect(await response!.headerValue("X-Header-1")).toBe("v1");
      expect(await response!.headerValue("X-Header-2")).toBe("v2");
      expect(await response!.headerValue("Set-Cookie")).toBe("a=b\nc=d");
    });
  });

  it("reports if request was fromServiceWorker", async () => {
    await withPage(async (page) => {
      {
        const response = await page.goto(fixture.server.PREFIX + "/serviceworkers/fetch/sw.html", {
          waitUntil: "load"
        });
        expect(response!.fromServiceWorker()).toBe(false);
      }

      await page.evaluate(() => (window as typeof window & { activationPromise: Promise<void> }).activationPromise);

      const [response] = await Promise.all([
        page.waitForResponse(/example\.txt$/),
        page.evaluate(() => fetch("/example.txt"))
      ]);
      expect(response.fromServiceWorker()).toBe(true);
    });
  });

  it("returns body for prefetch script", async () => {
    await withPage(async (page) => {
      const [response] = await Promise.all([
        page.waitForResponse(/prefetch\.js$/),
        page.goto(fixture.server.PREFIX + "/prefetch.html", {
          waitUntil: "load"
        })
      ]);

      const body = await response.body();
      expect(body.toString()).toBe("// Scripts will be pre-fetched");
    });
  });

  it("does not go to the network for fulfilled requests body", async () => {
    await withPage(async (page) => {
      await page.route("**/one-style.css", async (route) => {
        await route.fulfill({
          status: 404,
          contentType: "text/plain",
          body: "Not Found! (mocked)"
        });
      });

      let serverHit = false;
      fixture.server.setRoute("/one-style.css", (_request, response) => {
        serverHit = true;
        response.setHeader("Content-Type", "text/css");
        response.end("body { background-color: green; }");
      });
      fixture.server.setRoute("/one-style-linked.html", (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(`<!doctype html><link rel="stylesheet" href="/one-style.css"><body>hello</body>`);
      });

      const responsePromise = page.waitForResponse("**/one-style.css");
      await page.goto(fixture.server.PREFIX + "/one-style-linked.html");
      const response = await responsePromise;
      const body = await response.body();
      expect(body.toString()).toBe("Not Found! (mocked)");
      expect(serverHit).toBe(false);
    });
  });

  it("returns body for fulfilled responses", async () => {
    await withPage(async (page) => {
      for (const status of [100, 200, 404, 500]) {
        await page.route("**/one-style.css", async (route) => {
          await route.fulfill({
            status,
            contentType: "text/plain",
            body: `Custom body ${status}`
          });
        });

        fixture.server.setRoute("/one-style-linked.html", (_request, response) => {
          response.setHeader("Content-Type", "text/html");
          response.end(`<!doctype html><link rel="stylesheet" href="/one-style.css"><body>hello</body>`);
        });
        const responsePromise = page.waitForResponse("**/one-style.css");
        await page.goto(fixture.server.PREFIX + "/one-style-linked.html");
        const response = await responsePromise;
        const body = await response.body();
        expect(body.toString()).toBe(`Custom body ${status}`);
        await page.unrouteAll();
      }
    });
  });

  it("bypasses disk cache when page interception is enabled", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/frames/one-frame.html", {
        waitUntil: "load"
      });
      await page.route("**/api*", (route) => route.continue());

      {
        const requests: unknown[] = [];
        fixture.server.setRoute("/api", (request, response) => {
          requests.push(request);
          response.statusCode = 200;
          response.setHeader("content-type", "text/plain");
          response.setHeader("cache-control", "public, max-age=31536000");
          response.end("Hello");
        });

        for (let index = 0; index < 3; index += 1) {
          const responsePromise = page.waitForResponse(/\/api$/);
          await page.evaluate(async () => {
            const response = await fetch("/api");
            return response.status;
          });
          const response = await responsePromise;
          expect(response.status()).toBe(200);
          expect(requests).toHaveLength(index + 1);
        }
      }

      {
        const requests: unknown[] = [];
        fixture.server.setRoute("/frame/api", (request, response) => {
          requests.push(request);
          response.statusCode = 200;
          response.setHeader("content-type", "text/plain");
          response.setHeader("cache-control", "public, max-age=31536000");
          response.end("Hello");
        });

        const frame = page.frame({ url: /\/frames\/frame\.html$/ });
        expect(frame).toBeTruthy();

        for (let index = 0; index < 3; index += 1) {
          const responsePromise = page.waitForResponse(/\/frame\/api$/);
          await frame!.evaluate(async () => {
            const response = await fetch("/frame/api");
            return response.status;
          });
          const response = await responsePromise;
          expect(response.status()).toBe(200);
          expect(requests).toHaveLength(index + 1);
        }
      }
    });
  });

  it("Response.formData() parses multipart/form-data in page context", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      const result = await page.evaluate(async () => {
        const boundary = "----WebKitFormBoundary1234";
        const body = [
          `--${boundary}`,
          'Content-Disposition: form-data; name="field1"',
          "",
          "value1",
          `--${boundary}`,
          'Content-Disposition: form-data; name="file1"; filename="test.txt"',
          "Content-Type: text/plain",
          "",
          "hello",
          `--${boundary}--`
        ].join("\r\n");
        const response = new Response(body, {
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`
          }
        });
        const formData = await response.formData();
        const file = formData.get("file1");
        return {
          field1: formData.get("field1"),
          fileContent: file instanceof File ? await file.text() : null,
          filename: file instanceof File ? file.name : null
        };
      });

      expect(result.field1).toBe("value1");
      expect(result.filename).toBe("test.txt");
      expect(result.fileContent).toBe("hello");
    });
  });

  it("waits for the response body to complete before resolving text()", async () => {
    await withPage(async (page) => {
      let serverResponse: ServerResponse | null = null;
      fixture.server.setRoute("/stream.txt", (_request, response) => {
        serverResponse = response;
        response.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8"
        });
        response.write("hello ");
      });

      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });

      const responsePromise = page.waitForEvent("response", (response) => {
        return response.url().endsWith("/stream.txt");
      });

      await Promise.all([
        fixture.server.waitForRequest("/stream.txt"),
        page.evaluate((url) => {
          void fetch(url);
        }, fixture.server.PREFIX + "/stream.txt")
      ]);

      const response = await responsePromise;
      const responseTextPromise = response.text();

      expect(serverResponse).toBeTruthy();

      await new Promise<void>((resolve, reject) => {
        serverResponse!.write("wor", (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      await new Promise<void>((resolve, reject) => {
        serverResponse!.end("ld!", (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      expect(await responseTextPromise).toBe("hello world!");
    });
  });
});
