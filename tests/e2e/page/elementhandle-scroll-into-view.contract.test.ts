import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("elementHandle scrollIntoViewIfNeeded contract e2e", () => {
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

  it("should work", async () => {
    await withPage(async (page) => {
      await page.goto(`${fixture.server.PREFIX}/offscreenbuttons.html`);
      for (let index = 0; index < 11; index += 1) {
        const button = await page.$(`#btn${index}`);
        const before = await button!.evaluate((node) => {
          return node.getBoundingClientRect().right - window.innerWidth;
        });
        expect(before).toBe(10 * index);

        await button!.scrollIntoViewIfNeeded();

        const after = await button!.evaluate((node) => {
          return node.getBoundingClientRect().right - window.innerWidth;
        });
        expect(after <= 0).toBe(true);
        await page.evaluate(() => window.scrollTo(0, 0));
      }
    });
  });

  it("should throw for detached element", async () => {
    await withPage(async (page) => {
      await page.setContent("<div>Hello</div>");
      const div = await page.$("div");
      await div!.evaluate((node) => node.remove());

      const error = await div!.scrollIntoViewIfNeeded().catch((caught: Error) => caught);

      expect(error.message).toContain("Element is not attached to the DOM");
    });
  });

  it("should wait for display:none to become visible", async () => {
    await withPage(async (page) => {
      await page.setContent('<div style="display:none">Hello</div>');
      const div = await page.$("div");
      let done = false;

      const promise = div!.scrollIntoViewIfNeeded().then(() => {
        done = true;
      });
      await page.waitForTimeout(1000);
      expect(done).toBe(false);

      await div!.evaluate((node) => {
        node.style.display = "block";
      });
      await promise;
      expect(done).toBe(true);
    });
  });

  it("should scroll display:contents into view", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <style>
          html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
          ::-webkit-scrollbar { display: none; }
          * { scrollbar-width: none; }
        </style>
        <div id=container style="width:200px;height:200px;overflow:scroll;border:1px solid black;">
          <div style="margin-top:500px;background:red;">
            <div style="height:50px;width:100px;background:cyan;">
              <div id=target style="display:contents">Hello</div>
            </div>
          <div>
        </div>
      `);
      const div = await page.$("#target");

      await div!.scrollIntoViewIfNeeded();

      const scrollTop = await page.$eval("#container", (node) => (node as HTMLElement).scrollTop);
      expect(Math.abs(scrollTop - 350)).toBeLessThan(1);
    });
  });

  it("should work for visibility:hidden element", async () => {
    await withPage(async (page) => {
      await page.setContent('<div style="visibility:hidden">Hello</div>');
      const div = await page.$("div");

      await div!.scrollIntoViewIfNeeded();
    });
  });

  it("should work for zero-sized element", async () => {
    await withPage(async (page) => {
      await page.setContent('<div style="height:0">Hello</div>');
      const div = await page.$("div");

      await div!.scrollIntoViewIfNeeded();
    });
  });

  it("should wait for nested display:none to become visible", async () => {
    await withPage(async (page) => {
      await page.setContent('<span style="display:none"><div>Hello</div></span>');
      const div = await page.$("div");
      let done = false;

      const promise = div!.scrollIntoViewIfNeeded().then(() => {
        done = true;
      });
      await page.waitForTimeout(1000);
      expect(done).toBe(false);

      await div!.evaluate((node) => {
        node.parentElement!.style.display = "block";
      });
      await promise;
      expect(done).toBe(true);
    });
  });

  it("should timeout waiting for visible", async () => {
    await withPage(async (page) => {
      await page.setContent('<div style="display:none">Hello</div>');
      const div = await page.$("div");

      const error = await div!.scrollIntoViewIfNeeded({ timeout: 3000 }).catch((caught: Error) => caught);

      expect(error.message).toContain("element is not visible");
      expect(error.message).toContain("retrying scroll into view action");
    });
  });
});
