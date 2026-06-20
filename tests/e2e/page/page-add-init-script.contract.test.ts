import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page addInitScript contract e2e", () => {
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

  it("should evaluate before anything else on the page", async () => {
    await withPage(async (page) => {
      await page.addInitScript(function () {
        (window as typeof window & { injected?: number }).injected = 123;
      });
      await page.goto(fixture.server.PREFIX + "/tamperable.html");
      expect(await page.evaluate(() => (window as typeof window & { result?: number }).result)).toBe(123);
    });
  });

  it("should work with a path", async () => {
    await withPage(async (page) => {
      await page.addInitScript({ path: fixture.asset("injectedfile.js") });
      await page.goto(fixture.server.PREFIX + "/tamperable.html");
      expect(await page.evaluate(() => (window as typeof window & { result?: number }).result)).toBe(123);
    });
  });

  it("should work with content", async () => {
    await withPage(async (page) => {
      await page.addInitScript({ content: 'window["injected"] = 123' });
      await page.goto(fixture.server.PREFIX + "/tamperable.html");
      expect(await page.evaluate(() => (window as typeof window & { result?: number }).result)).toBe(123);
    });
  });

  it("should work with a raw string script", async () => {
    await withPage(async (page) => {
      await page.addInitScript('window["injected"] = 123');
      await page.goto(fixture.server.PREFIX + "/tamperable.html");
      expect(await page.evaluate(() => (window as typeof window & { result?: number }).result)).toBe(123);
    });
  });

  it("should throw without path and content", async () => {
    await withPage(async (page) => {
      const error = await page.addInitScript({ foo: "bar" } as never).catch((caught) => caught);
      expect(error.message).toContain("Either path or content property must be present");
    });
  });

  it("should work with trailing comments", async () => {
    await withPage(async (page) => {
      await page.addInitScript({ content: "// comment" });
      await page.addInitScript({ content: "window.secret = 42;" });
      await page.goto("data:text/html,<html></html>");
      expect(await page.evaluate("secret")).toBe(42);
    });
  });

  it("should support multiple scripts", async () => {
    await withPage(async (page) => {
      await page.addInitScript(function () {
        (window as typeof window & { script1?: number }).script1 = 1;
      });
      await page.addInitScript(function () {
        (window as typeof window & { script2?: number }).script2 = 2;
      });
      await page.goto(fixture.server.PREFIX + "/tamperable.html");
      expect(await page.evaluate(() => (window as typeof window & { script1?: number }).script1)).toBe(1);
      expect(await page.evaluate(() => (window as typeof window & { script2?: number }).script2)).toBe(2);
    });
  });

  it("should work with CSP", async () => {
    await withPage(async (page) => {
      fixture.server.setCSP("/empty.html", "script-src " + fixture.server.PREFIX);
      await page.addInitScript(function () {
        (window as typeof window & { injected?: number }).injected = 123;
      });
      await page.goto(fixture.server.PREFIX + "/empty.html");
      expect(await page.evaluate(() => (window as typeof window & { injected?: number }).injected)).toBe(123);

      await page.addScriptTag({ content: "window.e = 10;" }).catch(() => undefined);
      expect(await page.evaluate(() => (window as typeof window & { e?: number }).e)).toBe(undefined);
    });
  });

  it("should work after a cross origin navigation", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.CROSS_PROCESS_PREFIX);
      await page.addInitScript(function () {
        (window as typeof window & { injected?: number }).injected = 123;
      });
      await page.goto(fixture.server.PREFIX + "/tamperable.html");
      expect(await page.evaluate(() => (window as typeof window & { result?: number }).result)).toBe(123);
    });
  });

  it("should remove init script after dispose", async () => {
    await withPage(async (page) => {
      const disposable = await page.addInitScript(function () {
        (window as typeof window & { injected?: number }).injected = 123;
      });
      await page.goto(fixture.server.PREFIX + "/tamperable.html");
      expect(await page.evaluate(() => (window as typeof window & { result?: number }).result)).toBe(123);

      await disposable.dispose();
      await page.goto(fixture.server.PREFIX + "/tamperable.html");
      expect(await page.evaluate(() => (window as typeof window & { result?: number }).result)).toBe(undefined);
    });
  });

  it("should remove one of multiple init scripts after dispose", async () => {
    await withPage(async (page) => {
      const disposable1 = await page.addInitScript(function () {
        (window as typeof window & { script1?: number }).script1 = 1;
      });
      await page.addInitScript(function () {
        (window as typeof window & { script2?: number }).script2 = 2;
      });
      await page.goto(fixture.server.PREFIX + "/tamperable.html");
      expect(await page.evaluate(() => (window as typeof window & { script1?: number }).script1)).toBe(1);
      expect(await page.evaluate(() => (window as typeof window & { script2?: number }).script2)).toBe(2);

      await disposable1.dispose();
      await page.goto(fixture.server.PREFIX + "/tamperable.html");
      expect(await page.evaluate(() => (window as typeof window & { script1?: number }).script1)).toBe(undefined);
      expect(await page.evaluate(() => (window as typeof window & { script2?: number }).script2)).toBe(2);
    });
  });

  it("init script should run only once in iframe", async () => {
    await withPage(async (page) => {
      const messages: string[] = [];
      page.on("console", (event) => {
        if (event.text().startsWith("init script:")) {
          messages.push(event.text());
        }
      });
      await page.addInitScript(() => console.log("init script:", location.pathname || "no url yet"));
      await page.goto(fixture.server.PREFIX + "/frames/one-frame.html");
      expect(messages).toEqual([
        "init script: /frames/one-frame.html",
        "init script: /frames/frame.html"
      ]);
    });
  });
});
