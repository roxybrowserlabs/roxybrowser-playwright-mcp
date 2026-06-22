import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page popup contract e2e", () => {
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

  it("emits popup for window.open about:blank", async () => {
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

  it("emits popup for window.open with window features", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);

      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate(() => {
          window.__popup = window.open(
            window.location.href,
            "Title",
            "toolbar=no,location=no,directories=no,status=no,menubar=no,scrollbars=yes,resizable=yes,width=780,height=200,top=0,left=0"
          );
        })
      ]);

      expect(await popup.opener()).toBe(page);
      expect(await popup.evaluate(() => !!window.opener)).toBe(true);
    });
  });

  it("emits popup for noopener windows and reports null opener", async () => {
    await withPage(async (page) => {
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate(() => {
          window.__popup = window.open("about:blank", null, "noopener");
        })
      ]);

      expect(await popup.opener()).toBeNull();
      expect(await popup.evaluate(() => !!window.opener)).toBe(false);
    });
  });

  it("emits popup for noopener about:blank windows", async () => {
    await withPage(async (page) => {
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate(() => {
          window.__popup = window.open("about:blank", null, "noopener");
        })
      ]);

      expect(await popup.opener()).toBeNull();
      expect(await popup.evaluate(() => !!window.opener)).toBe(false);
    });
  });

  it("emits popup for empty window.open urls", async () => {
    await withPage(async (page) => {
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate(() => {
          window.__popup = window.open("");
        })
      ]);

      expect(await popup.opener()).toBe(page);
      expect(await popup.evaluate(() => !!window.opener)).toBe(true);
    });
  });

  it("emits popup for noopener windows without an explicit url", async () => {
    await withPage(async (page) => {
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate(() => {
          window.__popup = window.open(undefined, null, "noopener");
        })
      ]);

      expect((await popup.url()).split("#")[0]).toBe("about:blank");
      expect(await popup.opener()).toBeNull();
      expect(await popup.evaluate(() => !!window.opener)).toBe(false);
    });
  });

  it("emits popup even when it closes immediately", async () => {
    await withPage(async (page) => {
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate(() => {
          const win = window.open("about:blank");
          win?.close();
        })
      ]);

      expect(popup).toBeTruthy();
    });
  });

  it("emits popup even when an immediately navigated popup closes", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);

      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate(() => {
          const win = window.open(window.location.href);
          win?.close();
        })
      ]);

      expect(popup).toBeTruthy();
    });
  });

  it("captures dialogs opened by a popup and associates them to that popup", async () => {
    await withPage(async (page) => {
      const evaluatePromise = page.evaluate(() => {
        const win = window.open("");
        win?.alert("hello");
      });

      const [popup, dialog] = await Promise.all([
        page.waitForEvent("popup"),
        page.context().waitForEvent("dialog")
      ]);

      expect(dialog.message()).toBe("hello");
      expect(dialog.page()).toBe(popup);
      await dialog.dismiss();
      await evaluatePromise;
    });
  });

  it("emits popup when clicking target=_blank links", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent('<a target="_blank" rel="opener" href="/one-style.html">open popup</a>');

      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.click("a")
      ]);

      expect(await popup.opener()).toBe(page);
      expect(await popup.evaluate(() => !!window.opener)).toBe(true);
      expect(popup.mainFrame().page()).toBe(popup);
    });
  });

  it("emits popup when clicking cross-process target=_blank links", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent(
        `<a target="_blank" rel="opener" href="${fixture.server.CROSS_PROCESS_PREFIX}/empty.html">open popup</a>`
      );

      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.click("a")
      ]);

      expect(await popup.opener()).toBe(page);
      expect(await popup.evaluate(() => !!window.opener)).toBe(true);
      expect(popup.mainFrame().page()).toBe(popup);
    });
  });

  it("emits popup for target=_blank forms using get and post", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/done.html?", (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("Done");
      });
      fixture.server.setRoute("/done.html", (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("Done");
      });

      await page.goto(fixture.server.EMPTY_PAGE);

      await page.setContent(`<form target="_blank" action="done.html">
        <input type="submit" value="Click me">
      </form>`);
      const [getPopup] = await Promise.all([
        page.waitForEvent("popup"),
        page.click('"Click me"')
      ]);
      await getPopup.waitForLoadState("load");
      expect(await getPopup.textContent("body")).toBe("Done");

      await page.setContent(`<form target="_blank" action="done.html" method="post">
        <input type="submit" value="Click me">
      </form>`);
      const [postPopup] = await Promise.all([
        page.waitForEvent("popup"),
        page.click('"Click me"')
      ]);
      await postPopup.waitForLoadState("load");
      expect(await postPopup.textContent("body")).toBe("Done");
    });
  });

  it("emits popup for rel=noopener target=_blank links", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent('<a target="_blank" rel="noopener" href="/one-style.html">open popup</a>');

      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.click("a")
      ]);

      expect(await popup.opener()).toBeNull();
      expect(await popup.evaluate(() => !!window.opener)).toBe(false);
    });
  });

  it("emits popup for fake-clicked rel=noopener target=_blank links", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent('<a target="_blank" rel="noopener" href="/one-style.html">open popup</a>');

      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.$eval("a", (anchor) => {
          (anchor as HTMLAnchorElement).click();
        })
      ]);

      expect(await popup.opener()).toBeNull();
      expect(await popup.evaluate(() => !!window.opener)).toBe(false);
    });
  });

  it("reports popups opened from iframes on the page", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/popup-frame.html", (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html>
          <html lang="en">
            <body>
              <iframe id="popup-frame" src="/popup-frame-child.html"></iframe>
            </body>
          </html>`);
      });
      fixture.server.setRoute("/popup-frame-child.html", (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<!doctype html><html><body>child frame</body></html>");
      });

      await page.goto(fixture.server.PREFIX + "/popup-frame.html");
      const frame = page.frames()[1];
      expect(frame).toBeTruthy();

      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        frame!.evaluate(() => {
          window.open("about:blank");
        })
      ]);

      expect(await popup.opener()).toBe(page);
    });
  });

  it("emits popup for noopener windows that navigate to a URL", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);

      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate((url) => {
          window.__popup = window.open(url, null, "noopener");
        }, fixture.server.EMPTY_PAGE)
      ]);

      expect(await popup.opener()).toBeNull();
      expect(await popup.evaluate(() => !!window.opener)).toBe(false);
    });
  });

  it("inherits context routes for popups opened by window.open like Playwright", async () => {
    await withPage(async (page, context) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      let intercepted = false;
      await context.route("**/empty.html", async (route) => {
        intercepted = true;
        await route.continue();
      });

      await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate((url) => {
          window.__popup = window.open(url);
        }, fixture.server.EMPTY_PAGE)
      ]);

      expect(intercepted).toBe(true);
    });
  });

  it("inherits browser context addInitScript in in-process popups like Playwright", async () => {
    await withPage(async (page, context) => {
      await context.addInitScript(() => {
        window["injected"] = 123;
      });
      await page.goto(fixture.server.EMPTY_PAGE);

      const injected = await page.evaluate(() => {
        const popup = window.open("about:blank");
        return popup?.["injected"];
      });

      expect(injected).toBe(123);
    });
  });

  it("inherits browser context addInitScript in cross-process popups like Playwright", async () => {
    await withPage(async (page, context) => {
      await context.addInitScript(() => {
        window["injected"] = 123;
      });
      await page.goto(fixture.server.EMPTY_PAGE);

      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        page.evaluate((url) => {
          window.open(url);
        }, fixture.server.CROSS_PROCESS_PREFIX + "/title.html")
      ]);

      expect(await popup.evaluate("injected")).toBe(123);
      await popup.reload();
      expect(await popup.evaluate("injected")).toBe(123);
    });
  });
});
