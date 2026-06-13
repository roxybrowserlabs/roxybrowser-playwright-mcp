import type { ServerResponse } from "node:http";
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

  it("should return text", async () => {
    await withPage(async (page) => {
      const response = await page.goto(fixture.server.PREFIX + "/simple.json", {
        waitUntil: "load"
      });

      expect(response).toBeTruthy();
      expect(await response!.text()).toBe('{"foo": "bar"}\n');
    });
  });

  it("exposes response headers, mime type, cache flag, and status", async () => {
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
      expect(response!.status).toBe(200);
      expect(response!.statusText).toBe("OK");
      expect(response!.mimeType).toBe("application/json");
      expect(response!.fromCache).toBe(false);
      expect(response!.headers).toEqual(
        expect.arrayContaining([
          { name: "Content-Type", value: "application/json; charset=utf-8" },
          { name: "X-Test", value: "contract" }
        ])
      );
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
      expect(response!.status).toBe(200);
      expect(response!.statusText).toBe("cool!");
      expect(await response!.text()).toBe("nice");
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
        return response.url.endsWith("/stream.txt");
      });

      await Promise.all([
        fixture.server.waitForRequest("/stream.txt"),
        page.evaluate(`(url) => {
          void fetch(url);
        }`, fixture.server.PREFIX + "/stream.txt")
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
