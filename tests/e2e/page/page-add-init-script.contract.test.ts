import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

async function waitForCondition(condition: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start <= timeout) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

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

  it("should drop functions without the exposeFunctions option", async () => {
    await withPage(async (page) => {
      await page.addInitScript(({ cb }) => {
        (window as typeof window & { cbType?: string }).cbType = typeof cb;
      }, { cb: () => {} });
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(await page.evaluate(() => (window as typeof window & { cbType?: string }).cbType)).toBe("undefined");
    });
  });

  it("should throw when exposeFunctions is used with a non-function init script", async () => {
    await withPage(async (page) => {
      const error = await page.addInitScript(
        { content: "window.foo = 1;" },
        undefined,
        { exposeFunctions: true }
      ).catch((caught) => caught as Error);
      expect(error.message).toContain("Passing functions requires the init script to be a function");
    });
  });

  it("should call a function passed as an argument", async () => {
    await withPage(async (page) => {
      const received: number[] = [];
      await page.addInitScript(async ({ cb }) => {
        await cb(1);
        await cb(2);
      }, { cb: async (n: number) => { received.push(n); } }, { exposeFunctions: true });
      await page.goto(fixture.server.EMPTY_PAGE);
      await waitForCondition(() => received.length === 2);
      expect(received).toEqual([1, 2]);
    });
  });

  it("should return the callback result to the page", async () => {
    await withPage(async (page) => {
      await page.addInitScript(async ({ double }) => {
        (window as typeof window & { result?: number }).result = await double(21);
      }, { double: async (n: number) => n * 2 }, { exposeFunctions: true });
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.waitForFunction(() => (window as typeof window & { result?: number }).result === 42);
      expect(await page.evaluate(() => (window as typeof window & { result?: number }).result)).toBe(42);
    });
  });

  it("should remove exposed functions after dispose", async () => {
    await withPage(async (page) => {
      const received: number[] = [];
      const disposable = await page.addInitScript(({ cb }) => {
        (window as typeof window & { cb?: (n: number) => void }).cb = cb;
      }, { cb: (n: number) => { received.push(n); } }, { exposeFunctions: true });
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.evaluate(() => (window as typeof window & { cb: (n: number) => void }).cb(1));
      await disposable.dispose();
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(await page.evaluate(() => typeof (window as typeof window & { cb?: unknown }).cb)).toBe("undefined");
      expect(received).toEqual([1]);
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
