import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("locator waitForFunction contract e2e", () => {
  it("should wait for an attribute to appear", async () => {
    await withPage(async (page) => {
      await page.setContent("<button id=toggle>Menu</button>");
      await page.evaluate(() => window.builtins.setTimeout(() => document.querySelector("#toggle")!.setAttribute("aria-expanded", "true"), 1000));
      await page.locator("#toggle").waitForFunction((element) => element.hasAttribute("aria-expanded"));
    });
  });

  it("should return immediately when already truthy", async () => {
    await withPage(async (page) => {
      await page.setContent("<div id=target>yes</div>");
      expect(await page.locator("#target").waitForFunction((element) => element.textContent === "yes")).toBe(undefined);
    });
  });

  it("should accept ElementHandle arguments", async () => {
    await withPage(async (page) => {
      await page.setContent("<div id=a></div><div id=b>value</div>");
      const handle = await page.$("#b");
      await page.locator("#a").waitForFunction((element, other) => other.textContent === "value", handle);
    });
  });

  it("should accept string expression", async () => {
    await withPage(async (page) => {
      await page.setContent("<div id=target>yes</div>");
      await page.locator("#target").waitForFunction(`element => element.textContent === 'yes'`);
    });
  });

  it("should resolve a promise returned by the predicate", async () => {
    await withPage(async (page) => {
      await page.setContent("<div id=target>yes</div>");
      await page.locator("#target").waitForFunction(async (element) => element.textContent === "yes");
    });
  });

  it("should wait for element to appear and survive rerender", async () => {
    await withPage(async (page) => {
      await page.setContent("<span>nothing here</span>");
      await page.evaluate(() => {
        let count = 0;
        let prev: Element | null = null;
        const tick = () => {
          count += 1;
          const next = document.createElement("div");
          next.id = "target";
          next.textContent = String(count);
          if (prev) {
            prev.remove();
          }
          document.body.appendChild(next);
          prev = next;
          if (count < 3) {
            window.builtins.setTimeout(tick, 500);
          }
        };
        window.builtins.setTimeout(tick, 500);
      });
      await page.locator("#target").waitForFunction((element) => element.textContent === "3");
    });
  });

  it("should throw when predicate throws", async () => {
    await withPage(async (page) => {
      await page.setContent("<div id=target>no</div>");
      const error = await page.locator("#target").waitForFunction(() => {
        throw new Error("oh my");
      }).catch((caught) => caught);
      expect(error.message).toContain("oh my");
    });
  });

  it("should throw on strict mode violation", async () => {
    await withPage(async (page) => {
      await page.setContent("<div class=x>1</div><div class=x>2</div>");
      const error = await page.locator("div.x").waitForFunction(() => true).catch((caught) => caught);
      expect(error.message).toContain("strict mode violation");
    });
  });

  it("should abort via signal", async () => {
    await withPage(async (page) => {
      await page.setContent("<div id=target>no</div>");
      const controller = new AbortController();
      const promise = page.locator("#target").waitForFunction((element) => element.textContent === "yes", undefined, { timeout: 0, signal: controller.signal }).catch((caught) => caught);

      await page.waitForTimeout(100);
      const reason = new Error("Aborted by user");
      controller.abort(reason);

      const error = await promise;
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe(reason);
    });
  });

  it("should abort via already-aborted signal", async () => {
    await withPage(async (page) => {
      await page.setContent("<div id=target>no</div>");
      const controller = new AbortController();
      controller.abort("already aborted");
      const error = await page.locator("#target").waitForFunction(() => true, undefined, { signal: controller.signal }).catch((caught) => caught);
      expect(error.name).toBe("AbortError");
      expect(error.cause).toBe("already aborted");
    });
  });
});
