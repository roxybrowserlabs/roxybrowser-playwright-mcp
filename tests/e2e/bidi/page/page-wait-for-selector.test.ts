import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withBidiPage } from "../../../helpers/bidi.js";
import { createHistoryPageFixture } from "../../../helpers/server.js";

describe("page.waitForSelector e2e (bidi/firefox)", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("should throw on waitFor", async () => {
    await withBidiPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      let error: Error | undefined;

      await page
        .waitForSelector("*", { waitFor: "attached" })
        .catch((caughtError: Error) => {
          error = caughtError;
          return null;
        });

      expect(error?.message).toContain(
        "options.waitFor is not supported, did you mean options.state?"
      );
    });
  });

  it("should tolerate waitFor=visible", async () => {
    await withBidiPage(async (page) => {
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      let threw = false;

      await page.waitForSelector("*", { waitFor: "visible" }).catch(() => {
        threw = true;
        return null;
      });

      expect(threw).toBe(false);
    });
  });

  it("should immediately resolve promise if node exists", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div>hello</div>");
      const handle = await page.waitForSelector("div", { state: "attached" });
      expect(handle).toBeTruthy();
      expect(await handle!.textContent()).toBe("hello");
    });
  });

  it("should resolve promise when node is added", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div></div>");
      const waitForSelector = page.waitForSelector("span", { state: "attached" });
      await page.evaluate(`() => {
        document.querySelector("div").innerHTML = "<span>target</span>";
      }`);
      const handle = await waitForSelector;
      expect(await handle!.textContent()).toBe("target");
    });
  });

  it("should support text selectors", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div><span>Hello</span></div>");
      const handle = await page.waitForSelector("div >> text=Hello");
      expect(handle).toBeTruthy();
      expect(await handle!.textContent()).toContain("Hello");
    });
  });

  it("should waitForSelector with distributed elements", async () => {
    await withBidiPage(async (page) => {
      const promise = page.waitForSelector("div >> text=Hello");
      await page.evaluate(`() => {
        const div = document.createElement("div");
        document.body.appendChild(div);

        div.attachShadow({ mode: "open" });
        const shadowSpan = document.createElement("span");
        shadowSpan.textContent = "Hello from shadow";
        div.shadowRoot.appendChild(shadowSpan);
        div.shadowRoot.appendChild(document.createElement("slot"));

        const lightSpan = document.createElement("span");
        lightSpan.textContent = "Hello from light";
        div.appendChild(lightSpan);
      }`);
      const handle = await promise;
      expect(await handle!.textContent()).toBe("Hello from light");
    });
  });

  it("elementHandle.waitForSelector should immediately resolve if node exists", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<span>extra</span><div><span>target</span></div>");
      const div = (await page.$("div"))!;
      const span = await div.waitForSelector("span", { state: "attached" });
      expect(await span!.evaluate((e) => (e as HTMLElement).textContent)).toBe("target");
    });
  });

  it("elementHandle.waitForSelector should wait", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div></div>");
      const div = (await page.$("div"))!;
      const promise = div.waitForSelector("span", { state: "attached" });
      await div.evaluate((element) => {
        (element as HTMLElement).innerHTML = "<span>target</span>";
      });
      const span = await promise;
      expect(await span!.evaluate((e) => (e as HTMLElement).textContent)).toBe("target");
    });
  });

  it("elementHandle.waitForSelector should timeout", async () => {
    await withBidiPage(async (page) => {
      await page.setContent("<div></div>");
      const div = (await page.$("div"))!;
      const error = await div.waitForSelector("span", { timeout: 100 }).catch((caughtError: Error) => {
        return caughtError;
      });
      expect(error.message).toContain("Timeout 100ms exceeded.");
    });
  });
});
