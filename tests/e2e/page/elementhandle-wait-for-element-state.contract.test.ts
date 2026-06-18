import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

async function giveItAChanceToResolve(page: { evaluate<R>(fn: () => Promise<R>): Promise<R> }): Promise<void> {
  await page.evaluate(async () => {
    for (let index = 0; index < 5; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
}

describe("elementHandle waitForElementState contract e2e", () => {
  it("waits for visible", async () => {
    await withPage(async (page) => {
      await page.setContent("<div style='display:none'>content</div>");
      const div = await page.$("div");
      let done = false;
      const promise = div!.waitForElementState("visible").then(() => {
        done = true;
      });

      await giveItAChanceToResolve(page);
      expect(done).toBe(false);

      await div!.evaluate((element) => {
        (element as HTMLDivElement).style.display = "block";
      });
      await promise;
    });
  });

  it("resolves immediately for already visible", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>content</div>");
      const div = await page.$("div");

      await div!.waitForElementState("visible");
    });
  });

  it("times out waiting for visible", async () => {
    await withPage(async (page) => {
      await page.setContent("<div style='display:none'>content</div>");
      const div = await page.$("div");

      await expect(div!.waitForElementState("visible", { timeout: 100 })).rejects.toThrow("Timeout 100ms exceeded");
    });
  });

  it("throws waiting for visible when detached", async () => {
    await withPage(async (page) => {
      await page.setContent("<div style='display:none'>content</div>");
      const div = await page.$("div");
      const promise = div!.waitForElementState("visible").catch((error) => error);

      await div!.evaluate((element) => element.remove());

      const error = await promise;
      expect(error.message).toContain("Element is not attached to the DOM");
    });
  });

  it("waits for hidden and resolves when detached", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>content</div>");
      const div = await page.$("div");
      let done = false;
      const promise = div!.waitForElementState("hidden").then(() => {
        done = true;
      });

      await giveItAChanceToResolve(page);
      expect(done).toBe(false);

      await div!.evaluate((element) => element.remove());
      await promise;
    });
  });

  it("waits for aria enabled descendants", async () => {
    await withPage(async (page) => {
      await page.setContent('<div role="group" aria-disabled=true><button><span>Target</span></button></div>');
      const span = await page.$("text=Target");
      let done = false;
      const promise = span!.waitForElementState("enabled").then(() => {
        done = true;
      });

      await giveItAChanceToResolve(page);
      expect(done).toBe(false);

      await span!.evaluate((element) => {
        element.parentElement!.parentElement!.setAttribute("aria-disabled", "false");
      });
      await promise;
    });
  });

  it("waits for editable input", async () => {
    await withPage(async (page) => {
      await page.setContent("<input readonly>");
      const input = await page.$("input");
      let done = false;
      const promise = input!.waitForElementState("editable").then(() => {
        done = true;
      });

      await giveItAChanceToResolve(page);
      expect(done).toBe(false);

      await input!.evaluate((element) => {
        (element as HTMLInputElement).readOnly = false;
      });
      await promise;
    });
  });
});
