import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("frame addScriptTag/addStyleTag contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("addScriptTag works from the main frame with url, content, and path", async () => {
    await withPage(async (page) => {
      const frame = page.mainFrame();
      await page.goto(fixture.server.EMPTY_PAGE);

      const urlHandle = await frame.addScriptTag({ url: "/injectedfile.js" });
      expect(urlHandle.asElement()).not.toBeNull();
      expect(await page.evaluate(() => (window as typeof window & { __injected?: number }).__injected)).toBe(42);

      await frame.addScriptTag({ content: 'window["__frameInjected"] = 35;' });
      expect(await page.evaluate(() => (window as typeof window & { __frameInjected?: number }).__frameInjected)).toBe(35);

      await frame.addScriptTag({ path: fixture.asset("injectedfile.js") });
      const stack = await page.evaluate(() => (window as typeof window & { __injectedError?: Error }).__injectedError?.stack);
      expect(stack).toContain(path.join("assets", "injectedfile.js"));
    });
  });

  it("addStyleTag works from the main frame with url, content, and path", async () => {
    await withPage(async (page) => {
      const frame = page.mainFrame();
      await page.goto(fixture.server.EMPTY_PAGE);

      const urlHandle = await frame.addStyleTag({ url: "/injectedstyle.css" });
      expect(urlHandle.asElement()).not.toBeNull();
      expect(await page.evaluate("window.getComputedStyle(document.body).getPropertyValue('background-color')")).toBe("rgb(255, 0, 0)");

      await frame.addStyleTag({ content: "body { background-color: green; }" });
      expect(await page.evaluate("window.getComputedStyle(document.body).getPropertyValue('background-color')")).toBe("rgb(0, 128, 0)");

      const pathHandle = await frame.addStyleTag({ path: fixture.asset("injectedstyle.css") });
      expect(await pathHandle.textContent()).toContain(path.join("assets", "injectedstyle.css"));
    });
  });

  it("throws when no frame addScriptTag/addStyleTag source is provided", async () => {
    await withPage(async (page) => {
      const frame = page.mainFrame();

      await expect(frame.addScriptTag()).rejects.toThrow("Provide an object with a `url`, `path` or `content` property");
      await expect(frame.addStyleTag()).rejects.toThrow("Provide an object with a `url`, `path` or `content` property");
    });
  });
});
