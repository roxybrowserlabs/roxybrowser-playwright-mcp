import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page addScriptTag/addStyleTag contract e2e", () => {
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

  it("addScriptTag should throw an error if no options are provided", async () => {
    await withPage(async (page) => {
      const error = await page.addScriptTag("/injectedfile.js" as never).catch((caught) => caught);
      expect(error.message).toContain("Provide an object with a `url`, `path` or `content` property");
    });
  });

  it("addScriptTag should work with a url", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const scriptHandle = await page.addScriptTag({ url: "/injectedfile.js" });
      expect(scriptHandle.asElement()).not.toBeNull();
      expect(await page.evaluate(() => (window as typeof window & { __injected?: number }).__injected)).toBe(42);
    });
  });

  it("addScriptTag should work with type=module", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.addScriptTag({ url: "/es6/es6import.js", type: "module" });
      expect(await page.evaluate(() => (window as typeof window & { __es6injected?: number }).__es6injected)).toBe(42);
    });
  });

  it("addScriptTag should work with a path and type=module", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.addScriptTag({ path: fixture.asset("es6/es6pathimport.js"), type: "module" });
      await page.waitForFunction(() => (window as typeof window & { __es6injected?: number }).__es6injected);
      expect(await page.evaluate(() => (window as typeof window & { __es6injected?: number }).__es6injected)).toBe(42);
    });
  });

  it("addScriptTag should work with content and type=module", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.addScriptTag({
        content: "import num from '/es6/es6module.js';window.__es6injected = num;",
        type: "module"
      });
      await page.waitForFunction(() => (window as typeof window & { __es6injected?: number }).__es6injected);
      expect(await page.evaluate(() => (window as typeof window & { __es6injected?: number }).__es6injected)).toBe(42);
    });
  });

  it("addScriptTag should throw an error if loading from url fails", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const error = await page.addScriptTag({ url: "/nonexistfile.js" }).catch((caught) => caught);
      expect(error).toBeTruthy();
    });
  });

  it("addScriptTag should work with a path and include sourceURL", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const scriptHandle = await page.addScriptTag({ path: fixture.asset("injectedfile.js") });
      expect(scriptHandle.asElement()).not.toBeNull();
      expect(await page.evaluate(() => (window as typeof window & { __injected?: number }).__injected)).toBe(42);
      const stack = await page.evaluate(() => (window as typeof window & { __injectedError?: Error }).__injectedError?.stack);
      expect(stack).toContain(path.join("assets", "injectedfile.js"));
    });
  });

  it("addScriptTag should work with content", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const scriptHandle = await page.addScriptTag({ content: 'window["__injected"] = 35;' });
      expect(scriptHandle.asElement()).not.toBeNull();
      expect(await page.evaluate(() => (window as typeof window & { __injected?: number }).__injected)).toBe(35);
    });
  });

  it("addScriptTag should throw a nice error when the request fails", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const url = fixture.server.PREFIX + "/this_does_not_exist.js";
      const error = await page.addScriptTag({ url }).catch((caught) => caught);
      expect(error.message).toContain(url);
    });
  });

  it("addStyleTag should throw an error if no options are provided", async () => {
    await withPage(async (page) => {
      const error = await page.addStyleTag("/injectedstyle.css" as never).catch((caught) => caught);
      expect(error.message).toContain("Provide an object with a `url`, `path` or `content` property");
    });
  });

  it("addStyleTag should work with a url", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const styleHandle = await page.addStyleTag({ url: "/injectedstyle.css" });
      expect(styleHandle.asElement()).not.toBeNull();
      expect(await page.evaluate("window.getComputedStyle(document.querySelector('body')).getPropertyValue('background-color')")).toBe("rgb(255, 0, 0)");
    });
  });

  it("addStyleTag should throw an error if loading from url fails", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const error = await page.addStyleTag({ url: "/nonexistfile.js" }).catch((caught) => caught);
      expect(error).toBeTruthy();
    });
  });

  it("addStyleTag should work with a path and include sourceURL", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const styleHandle = await page.addStyleTag({ path: fixture.asset("injectedstyle.css") });
      expect(styleHandle.asElement()).not.toBeNull();
      expect(await page.evaluate("window.getComputedStyle(document.querySelector('body')).getPropertyValue('background-color')")).toBe("rgb(255, 0, 0)");
      const styleContent = await styleHandle.textContent();
      expect(styleContent).toContain(path.join("assets", "injectedstyle.css"));
    });
  });

  it("addStyleTag should work with content", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      const styleHandle = await page.addStyleTag({ content: "body { background-color: green; }" });
      expect(styleHandle.asElement()).not.toBeNull();
      expect(await page.evaluate("window.getComputedStyle(document.querySelector('body')).getPropertyValue('background-color')")).toBe("rgb(0, 128, 0)");
    });
  });

  it("addScriptTag should throw when added with content to the CSP page", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/csp.html");
      const error = await page.addScriptTag({ content: 'window["__injected"] = 35;' }).catch((caught) => caught);
      expect(error).toBeTruthy();
    });
  });

  it("addScriptTag should throw when added with URL to the CSP page", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/csp.html");
      const error = await page.addScriptTag({
        url: fixture.server.CROSS_PROCESS_PREFIX + "/injectedfile.js"
      }).catch((caught) => caught);
      expect(error).toBeTruthy();
    });
  });

  it("addStyleTag should throw when added with content to the CSP page", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/csp.html");
      const error = await page.addStyleTag({ content: "body { background-color: green; }" }).catch((caught) => caught);
      expect(error).toBeTruthy();
    });
  });

  it("addStyleTag should throw when added with URL to the CSP page", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/csp.html");
      const error = await page.addStyleTag({
        url: fixture.server.CROSS_PROCESS_PREFIX + "/injectedstyle.css"
      }).catch((caught) => caught);
      expect(error).toBeTruthy();
    });
  });
});
