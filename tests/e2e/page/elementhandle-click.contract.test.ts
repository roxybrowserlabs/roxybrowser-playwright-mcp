import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("elementHandle click contract e2e", () => {
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

  it("clicks a button", async () => {
    await withPage(async (page) => {
      await page.setContent(`<button onclick="window.result = 'Clicked'">Click me</button>`);
      const button = await page.$("button");

      await button!.click();

      expect(await page.evaluate(() => window.result)).toBe("Clicked");
    });
  });

  it("clicks with Node removed", async () => {
    await withPage(async (page) => {
      await page.setContent(`<button onclick="window.result = 'Clicked'">Click me</button>`);
      await page.evaluate(() => {
        delete (window as Window & { Node?: typeof Node }).Node;
      });
      const button = await page.$("button");

      await button!.click();

      expect(await page.evaluate(() => window.result)).toBe("Clicked");
    });
  });

  it("clicks Shadow DOM elements", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div id="host"></div>`);
      const buttonHandle = await page.evaluateHandle(() => {
        const host = document.querySelector("#host")!;
        const root = host.attachShadow({ mode: "open" });
        const button = document.createElement("button");
        button.textContent = "Click me";
        button.addEventListener("click", () => {
          window.clicked = true;
        });
        root.appendChild(button);
        return button;
      });

      await buttonHandle.asElement()!.click();

      expect(await page.evaluate(() => window.clicked)).toBe(true);
    });
  });

  it("clicks TextNodes", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div id="outer" onclick="window.result = 'Clicked ' + event.target.id;">
          <div id="inner" style="max-width: 50px">Lorem ipsum dolor sit amet consectetur adipiscing elit proin, integer curabitur imperdiet rhoncus cursus tincidunt bibendum.</div>
          Custom Text.
        </div>
      `);
      const textNode = await page.evaluateHandle(() => document.querySelector("#outer")!.lastChild);

      await textNode.asElement()!.click();

      expect(await page.evaluate(() => window.result)).toBe("Clicked outer");
    });
  });

  it("throws for detached nodes", async () => {
    await withPage(async (page) => {
      await page.setContent(`<button onclick="window.result = 'Clicked'">Click me</button>`);
      const button = await page.$("button");
      await page.evaluate((element) => element!.remove(), button);

      const error = await button!.click().catch((caught) => caught);

      expect(String(error?.message ?? error)).toContain("Element is not attached to the DOM");
    });
  });

  it("throws for hidden nodes with force", async () => {
    await withPage(async (page) => {
      await page.setContent(`<button onclick="window.result = 'Clicked'">Click me</button>`);
      const button = await page.$("button");
      await page.evaluate((element) => {
        element!.style.display = "none";
      }, button);

      const error = await button!.click({ force: true }).catch((caught) => caught);

      expect(String(error?.message ?? error)).toContain("Element is not visible");
    });
  });

  it("throws for recursively hidden nodes with force", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div><button onclick="window.result = 'Clicked'">Click me</button></div>`);
      const button = await page.$("button");
      await page.evaluate((element) => {
        element!.parentElement!.style.display = "none";
      }, button);

      const error = await button!.click({ force: true }).catch((caught) => caught);

      expect(String(error?.message ?? error)).toContain("Element is not visible");
    });
  });

  it("throws for <br> elements with force", async () => {
    await withPage(async (page) => {
      await page.setContent("hello<br>goodbye");
      const br = await page.$("br");

      const error = await br!.click({ force: true }).catch((caught) => caught);

      expect(String(error?.message ?? error)).toContain("Element is outside of the viewport");
    });
  });

  it("double-clicks a button", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button onclick="window.result = 'Clicked'">Click me</button>
        <script>
          window.double = false;
          document.querySelector("button").addEventListener("dblclick", () => window.double = true);
        </script>
      `);
      const button = await page.$("button");

      await button!.dblclick();

      expect(await page.evaluate(() => window.double)).toBe(true);
      expect(await page.evaluate(() => window.result)).toBe("Clicked");
    });
  });
});
