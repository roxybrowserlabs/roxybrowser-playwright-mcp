import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page click contract e2e", () => {
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

  it("clicks a button like Playwright's basic click smoke test", async () => {
    await withPage(async (page) => {
      await page.setContent(`<button onclick="window.__clicked = (window.__clicked || 0) + 1">Click me</button>`);

      await page.click("button");

      expect(await page.evaluate<number>("() => window.__clicked")).toBe(1);
    });
  });

  it("clicks svg targets", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <svg height="100" width="100">
          <circle onclick="window.__clicked = 42" cx="50" cy="50" r="40" stroke="black" stroke-width="3" fill="red" />
        </svg>
      `);

      await page.click("circle");

      expect(await page.evaluate<number>("() => window.__clicked")).toBe(42);
    });
  });

  it("clicks the aligned 1x1 div", async () => {
    await withPage(async (page) => {
      await page.setContent(`<div style="width: 1px; height: 1px;" onclick="window.__clicked = true"></div>`);

      await page.click("div");

      expect(await page.evaluate<boolean>("() => window.__clicked")).toBe(true);
    });
  });

  it("clicks the half-aligned 1x1 div", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div
          style="margin-left: 20.5px; margin-top: 11.5px; width: 1px; height: 1px;"
          onclick="window.__clicked = true"></div>
      `);

      await page.click("div");

      expect(await page.evaluate<boolean>("() => window.__clicked")).toBe(true);
    });
  });

  it("clicks the unaligned 1x1 div", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div
          style="margin-left: 20.68px; margin-top: 11.52px; width: 1px; height: 1px;"
          onclick="window.__clicked = true"></div>
      `);

      await page.click("div");

      expect(await page.evaluate<boolean>("() => window.__clicked")).toBe(true);
    });
  });

  it("clicks a span that has inline generated content", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <style>
          span::before {
            content: "q";
          }
        </style>
        <span onclick="window.__clicked = 42"></span>
      `);

      await page.click("span");

      expect(await page.evaluate<number>("() => window.__clicked")).toBe(42);
    });
  });

  it("clicks when one inline child is outside of the viewport", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <style>
          i {
            position: absolute;
            top: -1000px;
          }
        </style>
        <span onclick="window.__clicked = 42"><i>woof</i><b>doggo</b></span>
      `);

      await page.click("span");

      expect(await page.evaluate<number>("() => window.__clicked")).toBe(42);
    });
  });

  it("triple-clicks to select textarea text", async () => {
    await withPage(async (page) => {
      const text = "This is the text that we are going to try to select. Let's see how it goes.";
      await page.setContent(`<textarea></textarea>`);
      await page.fill("textarea", text);

      await page.click("textarea", { clickCount: 3 });

      expect(
        await page.evaluate<string>(`() => {
          const textarea = document.querySelector("textarea");
          return textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
        }`)
      ).toBe(text);
    });
  });

  it("clicks wrapped links", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <a href="#" onclick="window.__clicked = true; return false;">
          <span>Wrapped link</span>
        </a>
      `);

      await page.click("a");

      expect(await page.evaluate<boolean>("() => window.__clicked")).toBe(true);
    });
  });

  it("clicks checkbox inputs and toggles checked state", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input id="agree" type="checkbox" />`);

      await page.click("#agree");

      expect(await page.evaluate<boolean>("() => document.querySelector('#agree').checked")).toBe(true);
    });
  });

  it("clicks a button after navigation", async () => {
    await withPage(async (page) => {
      fixture.server.setContent(
        "/click-a.html",
        `<button onclick="window.__clicked = 'a'">Page A</button>`,
        "text/html"
      );
      fixture.server.setContent(
        "/click-b.html",
        `<button onclick="window.__clicked = 'b'">Page B</button>`,
        "text/html"
      );

      await page.goto(fixture.server.PREFIX + "/click-a.html", { waitUntil: "load" });
      await page.click("button");
      expect(await page.evaluate<string>("() => window.__clicked")).toBe("a");

      await page.goto(fixture.server.PREFIX + "/click-b.html", { waitUntil: "load" });
      await page.click("button");
      expect(await page.evaluate<string>("() => window.__clicked")).toBe("b");
    });
  });

  it("waits for display:none to be removed before clicking", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button style="display: none" onclick="window.__clicked = true">Click me</button>
      `);

      const clickPromise = page
        .click("button", { timeout: 1_000 })
        .then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error })
        );
      await page.evaluate(`() => {
        setTimeout(() => {
          document.querySelector("button").style.display = "block";
        }, 100);
      }`);
      const result = await clickPromise;

      expect(result.ok).toBe(true);
      expect(await page.evaluate<boolean>("() => window.__clicked")).toBe(true);
    });
  });

  it("waits for visibility:hidden to be removed before clicking", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button style="visibility: hidden" onclick="window.__clicked = true">Click me</button>
      `);

      const clickPromise = page
        .click("button", { timeout: 1_000 })
        .then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error })
        );
      await page.evaluate(`() => {
        setTimeout(() => {
          document.querySelector("button").style.visibility = "visible";
        }, 100);
      }`);
      const result = await clickPromise;

      expect(result.ok).toBe(true);
      expect(await page.evaluate<boolean>("() => window.__clicked")).toBe(true);
    });
  });

  it("waits for disabled buttons to become enabled before clicking", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button disabled onclick="window.__clicked = true">Click me</button>
      `);

      const clickPromise = page
        .click("button", { timeout: 1_000 })
        .then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error })
        );
      await page.evaluate(`() => {
        setTimeout(() => {
          document.querySelector("button").disabled = false;
        }, 100);
      }`);
      const result = await clickPromise;

      expect(result.ok).toBe(true);
      expect(await page.evaluate<boolean>("() => window.__clicked")).toBe(true);
    });
  });

  it("issues clicks in parallel across two pages in the same context", async () => {
    await withPage(async (page, context) => {
      const secondPage = await context.newPage();
      try {
        const html = `
          <button>Click me</button>
          <script>
            window.__count = 0;
            document.querySelector("button").addEventListener("click", () => window.__count++);
          </script>
        `;
        await page.setContent(html);
        await secondPage.setContent(html);

        const clickPromises: Array<Promise<void>> = [];
        for (let index = 0; index < 18; index++) {
          clickPromises.push((index % 2 === 0 ? page : secondPage).click("button"));
        }
        await Promise.all(clickPromises);

        expect(await page.evaluate<number>("() => window.__count")).toBe(9);
        expect(await secondPage.evaluate<number>("() => window.__count")).toBe(9);
      } finally {
        await secondPage.close();
      }
    });
  });
});
