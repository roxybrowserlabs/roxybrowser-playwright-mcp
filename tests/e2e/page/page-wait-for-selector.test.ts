import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPage } from "../helpers/browser.js";
import { createHistoryPageFixture } from "../helpers/server.js";

describe("page.waitForSelector e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("should throw on waitFor", async () => {
    await withPage(async (page) => {
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
    await withPage(async (page) => {
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
    await withPage(async (page) => {
      await page.setContent("<div>hello</div>");
      const handle = await page.waitForSelector("div", { state: "attached" });
      expect(handle).toBeTruthy();
      expect(await handle!.textContent()).toBe("hello");
    });
  });

  it("should resolve promise when node is added", async () => {
    await withPage(async (page) => {
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
    await withPage(async (page) => {
      await page.setContent("<div><span>Hello</span></div>");
      const handle = await page.waitForSelector("div >> text=Hello");
      expect(handle).toBeTruthy();
      expect(await handle!.textContent()).toContain("Hello");
    });
  });

  it("should waitForSelector with distributed elements", async () => {
    await withPage(async (page) => {
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
});
