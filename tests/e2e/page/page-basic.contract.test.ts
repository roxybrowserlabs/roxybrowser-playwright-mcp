import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page basic contract e2e", () => {
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

  it("fires load when expected", async () => {
    await withPage(async (page) => {
      await Promise.all([
        page.goto("about:blank"),
        page.waitForEvent("load")
      ]);
    });
  });

  it("preserves async stacks on navigation errors like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/empty.html", (request, _response) => {
        request.socket.end();
      });

      let error: Error | null = null;
      await page.goto(fixture.server.EMPTY_PAGE).catch((caught) => {
        error = caught;
      });

      expect(error).not.toBeNull();
      expect(error!.stack).toContain("page-basic.contract.test.ts");
    });
  });

  it("fires domcontentloaded when expected", async () => {
    await withPage(async (page) => {
      const navigatedPromise = page.goto("about:blank");
      await page.waitForEvent("domcontentloaded");
      await navigatedPromise;
    });
  });

  it("passes self as argument to domcontentloaded event", async () => {
    await withPage(async (page) => {
      const [eventArg] = await Promise.all([
        new Promise((resolve) => page.on("domcontentloaded", resolve)),
        page.goto("about:blank")
      ]);
      expect(eventArg).toBe(page);
    });
  });

  it("passes self as argument to load event", async () => {
    await withPage(async (page) => {
      const [eventArg] = await Promise.all([
        new Promise((resolve) => page.on("load", resolve)),
        page.goto("about:blank")
      ]);
      expect(eventArg).toBe(page);
    });
  });

  it("page.url should work", async () => {
    await withPage(async (page) => {
      expect(page.url()).toBe("about:blank");
      await page.goto(fixture.server.EMPTY_PAGE);
      expect(page.url()).toBe(fixture.server.EMPTY_PAGE);
    });
  });

  it("keeps page.url in sync with hash navigations", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE + "#hash");
      expect(await page.url()).toBe(fixture.server.EMPTY_PAGE + "#hash");

      await page.evaluate(() => {
        window.location.hash = "dynamic";
      });

      expect(await page.url()).toBe(fixture.server.EMPTY_PAGE + "#dynamic");
    });
  });

  it("returns the page title", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/title.html");
      expect(await page.title()).toBe("Woof-Woof");
    });
  });

  it("returns frame title", async () => {
    fixture.server.setContent("/frame-title.html", "<title>Frame title</title><body>child</body>", "text/html");
    await withPage(async (page) => {
      await page.setContent(`<title>Main title</title><iframe src="${fixture.server.PREFIX}/frame-title.html"></iframe>`);
      const frame = page.frames()[1]!;
      expect(await page.title()).toBe("Main title");
      expect(await frame.title()).toBe("Frame title");
    });
  });

  it("page.title should not throw during navigation", async () => {
    await withPage(async (page) => {
      await page.setContent("<title>hello</title>");
      const promise = page.goto(fixture.server.PREFIX + "/title.html");
      const [titleOrError] = await Promise.all([
        page.title().catch((error) => error),
        promise
      ]);
      expect(typeof titleOrError).toBe("string");
      expect(titleOrError).toMatch(/^(hello|Loading http.*title.html|Woof-Woof)$/);
      expect(await page.title()).toBe("Woof-Woof");
    });
  });

  it("emits close on popups closed via window.close()", async () => {
    await withPage(async (page) => {
      const popupPromise = page.waitForEvent("popup");
      await page.evaluate(() => {
        window.__newPage = window.open("about:blank");
      });
      const popup = await popupPromise;

      const closePromise = popup.waitForEvent("close");
      await page.evaluate(() => {
        window.__newPage.close();
      });

      await expect(closePromise).resolves.toBe(popup);
    });
  });

  it("page.frame should respect name", async () => {
    await withPage(async (page) => {
      await page.setContent("<iframe name=target></iframe>");
      expect(page.frame({ name: "bogus" })).toBe(null);
      const frame = page.frame({ name: "target" });
      expect(frame).toBeTruthy();
      expect(frame === page.mainFrame().childFrames()[0]).toBe(true);
    });
  });

  it("page.frame should respect url", async () => {
    await withPage(async (page) => {
      await page.setContent(`<iframe src="${fixture.server.EMPTY_PAGE}"></iframe>`);
      expect(page.frame({ url: /bogus/ })).toBe(null);
      expect(page.frame({ url: /empty/ })!.url()).toBe(fixture.server.EMPTY_PAGE);
    });
  });

  it("should have sane user agent", async () => {
    await withPage(async (page) => {
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const [
        part1,
        ,
        part3,
        part4,
        part5
      ] = userAgent.split(/[()]/).map((part) => part.trim());
      expect(part1).toBe("Mozilla/5.0");
      expect(part3.startsWith("AppleWebKit/")).toBe(true);
      expect(part4).toBe("KHTML, like Gecko");
      const [engine, browser] = part5.split(" ");
      expect(browser.startsWith("Safari/")).toBe(true);
      expect(engine.includes("Chrome/")).toBe(true);
    });
  });

  it("page.press should work", async () => {
    await withPage(async (page) => {
      await page.setContent("<textarea></textarea>");
      await page.press("textarea", "a");
      expect(await page.evaluate(() => document.querySelector("textarea")!.value)).toBe("a");
    });
  });

  it("page.press should work for Enter", async () => {
    await withPage(async (page) => {
      await page.setContent("<input onkeypress=\"console.log('press')\"></input>");
      const messages: Array<{ text(): string }> = [];
      page.on("console", (message) => messages.push(message));
      await page.press("input", "Enter");
      expect(messages[0].text()).toBe("press");
    });
  });

  it("frame.press should work", async () => {
    await withPage(async (page) => {
      await page.setContent(`<iframe name=inner src="${fixture.server.PREFIX}/input/textarea.html"></iframe>`);
      const frame = page.frame("inner")!;
      expect(await frame.$("textarea")).toBeTruthy();
      expect(await frame.$eval("textarea", (textarea) => textarea.tagName)).toBe("TEXTAREA");
      expect(await frame.$$eval("textarea,input", (elements) => elements.length)).toBe(2);
      await frame.press("textarea", "a");
      expect(await frame.evaluate(() => document.querySelector("textarea")!.value)).toBe("a");
    });
  });

  it("has navigator.webdriver set to true", async () => {
    await withPage(async (page) => {
      expect(await page.evaluate(() => navigator.webdriver)).toBe(true);
    });
  });

  it("should iterate over page properties", async () => {
    await withPage(async (page) => {
      const props = [];
      for (const prop in page) {
        const value = page[prop as keyof typeof page];
        if (value && typeof value === "object") {
          props.push((value as { [Symbol.iterator]?: unknown })[Symbol.iterator]);
        }
      }
    });
  });
});
