import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import type { Frame } from "../../../src/types/api.js";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture, type HistoryPageFixture } from "../../helpers/server.js";

async function networkIdleTest(
  frame: Frame,
  fixture: HistoryPageFixture,
  action: () => Promise<unknown>,
  isSetContent = false
): Promise<void> {
  const waitForRequest = (suffix: string) => Promise.all([
    fixture.server.waitForRequest(suffix),
    frame.page().waitForRequest(fixture.server.PREFIX + suffix)
  ]);

  let responseA!: ServerResponse;
  let responseB!: ServerResponse;
  fixture.server.setRoute("/fetch-request-a.js", (_request, response) => {
    responseA = response;
  });
  const firstFetchResourceRequested = waitForRequest("/fetch-request-a.js");
  fixture.server.setRoute("/fetch-request-b.js", (_request, response) => {
    responseB = response;
  });
  const secondFetchResourceRequested = waitForRequest("/fetch-request-b.js");

  const waitForLoadPromise = isSetContent
    ? Promise.resolve()
    : frame.waitForNavigation({ waitUntil: "load" });
  const actionPromise = action();

  let actionFinished = false;
  void actionPromise.then(() => actionFinished = true);

  await waitForLoadPromise;
  expect(actionFinished).toBe(false);

  await firstFetchResourceRequested;
  expect(actionFinished).toBe(false);

  await frame.page().evaluate(() => window["fetchSecond"]());
  responseA.statusCode = 404;
  responseA.end("File not found");

  await secondFetchResourceRequested;
  expect(actionFinished).toBe(false);

  let timerTriggered = false;
  const timer = setTimeout(() => timerTriggered = true, 500);
  responseB.statusCode = 404;
  responseB.end("File not found");

  const response = await actionPromise;
  clearTimeout(timer);
  expect(timerTriggered).toBe(true);
  if (!isSetContent) {
    expect((response as Awaited<ReturnType<Frame["goto"]>>)?.ok()).toBe(true);
  }
}

describe("page networkidle contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("should navigate to empty page with networkidle", async () => {
    await withPage(async (page) => {
      const response = await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "networkidle" });
      expect(response?.status()).toBe(200);
    });
  });

  it("should wait for networkidle to succeed navigation", async () => {
    await withPage(async (page) => {
      await networkIdleTest(page.mainFrame(), fixture, () => {
        return page.goto(fixture.server.PREFIX + "/networkidle.html", { waitUntil: "networkidle" });
      });
    });
  });

  it("should wait for networkidle to succeed navigation with request from previous navigation", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/foo.js", () => {});
      await page.setContent(`<script>fetch('foo.js');</script>`);
      await networkIdleTest(page.mainFrame(), fixture, () => {
        return page.goto(fixture.server.PREFIX + "/networkidle.html", { waitUntil: "networkidle" });
      });
    });
  });

  it("should wait for networkidle in waitForNavigation", async () => {
    await withPage(async (page) => {
      await networkIdleTest(page.mainFrame(), fixture, () => {
        const promise = page.waitForNavigation({ waitUntil: "networkidle" });
        void page.goto(fixture.server.PREFIX + "/networkidle.html");
        return promise;
      });
    });
  });

  it("should wait for networkidle in setContent", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await networkIdleTest(page.mainFrame(), fixture, () => {
        return page.setContent(`<script src='networkidle.js'></script>`, { waitUntil: "networkidle" });
      }, true);
    });
  });

  it("should wait for networkidle in setContent with request from previous navigation", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      fixture.server.setRoute("/foo.js", () => {});
      await page.setContent(`<script>fetch('foo.js');</script>`);
      await networkIdleTest(page.mainFrame(), fixture, () => {
        return page.setContent(`<script src='networkidle.js'></script>`, { waitUntil: "networkidle" });
      }, true);
    });
  });

  it("should wait for networkidle when navigating iframe", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/frames/one-frame.html");
      const frame = page.mainFrame().childFrames()[0]!;
      await networkIdleTest(frame, fixture, () => {
        return frame.goto(fixture.server.PREFIX + "/networkidle.html", { waitUntil: "networkidle" });
      });
    });
  });

  it("should wait for networkidle in setContent from the child frame", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await networkIdleTest(page.mainFrame(), fixture, () => {
        return page.setContent(`<iframe src='networkidle.html'></iframe>`, { waitUntil: "networkidle" });
      }, true);
    });
  });

  it("should wait for networkidle from the child frame", async () => {
    await withPage(async (page) => {
      await networkIdleTest(page.mainFrame(), fixture, () => {
        return page.goto(fixture.server.PREFIX + "/networkidle-frame.html", { waitUntil: "networkidle" });
      });
    });
  });

  it("should wait for networkidle from the popup like Playwright", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE);
      await page.setContent(`
        <button id=box1 onclick="window.open('./popup/popup.html')">Button1</button>
        <button id=box2 onclick="window.open('./popup/popup.html')">Button2</button>
        <button id=box3 onclick="window.open('./popup/popup.html')">Button3</button>
        <button id=box4 onclick="window.open('./popup/popup.html')">Button4</button>
        <button id=box5 onclick="window.open('./popup/popup.html')">Button5</button>
      `);

      for (let index = 1; index < 6; index += 1) {
        const [popup] = await Promise.all([
          page.waitForEvent("popup"),
          page.click(`#box${index}`)
        ]);
        await popup.waitForLoadState("networkidle");
      }
    });
  });

  it("should wait for networkidle when iframe attaches and detaches like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/empty.html", () => {});
      let done = false;
      const promise = page.setContent(`
        <body>
          <script>
            const iframe = document.createElement('iframe');
            iframe.src = ${JSON.stringify(fixture.server.EMPTY_PAGE)};
            document.body.appendChild(iframe);
          </script>
        </body>
      `, { waitUntil: "networkidle" }).then(() => {
        done = true;
      });

      await page.waitForTimeout(600);
      expect(done).toBe(false);
      await page.evaluate(() => {
        document.querySelector("iframe")?.remove();
      });
      await promise;
      expect(done).toBe(true);
    });
  });
});
