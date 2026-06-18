import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium } from "../../../src/index.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

function launchBrowser() {
  return chromium.launch({
    headless: true,
    ...(process.env.ROXY_E2E_EXECUTABLE_PATH
      ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
      : {})
  });
}

describe("browser context contract e2e", () => {
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

  it("isolates localStorage and cookies across contexts", async () => {
    const browser = await launchBrowser();
    try {
      const contextOne = await browser.newContext();
      const contextTwo = await browser.newContext();

      try {
        const pageOne = await contextOne.newPage();
        const pageTwo = await contextTwo.newPage();

        try {
          await pageOne.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          await pageTwo.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });

          await pageOne.evaluate(() => {
            localStorage.setItem("name", "page-one");
            document.cookie = "name=page-one";
          });
          await pageTwo.evaluate(() => {
            localStorage.setItem("name", "page-two");
            document.cookie = "name=page-two";
          });

          expect(await pageOne.evaluate(() => localStorage.getItem("name"))).toBe("page-one");
          expect(await pageTwo.evaluate(() => localStorage.getItem("name"))).toBe("page-two");
          expect(await pageOne.evaluate(() => document.cookie)).toContain("name=page-one");
          expect(await pageTwo.evaluate(() => document.cookie)).toContain("name=page-two");
        } finally {
          await pageOne.close();
          await pageTwo.close();
        }
      } finally {
        await contextOne.close();
        await contextTwo.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("clicks independently across two contexts in parallel", async () => {
    const browser = await launchBrowser();
    try {
      const contextOne = await browser.newContext();
      const contextTwo = await browser.newContext();

      try {
        const pageOne = await contextOne.newPage();
        const pageTwo = await contextTwo.newPage();

        try {
          const html = `
            <button>Click me</button>
            <script>
              window.__clicks = 0;
              document.querySelector("button").addEventListener("click", () => ++window.__clicks, false);
            </script>
          `;
          await pageOne.setContent(html);
          await pageTwo.setContent(html);

          await Promise.all([
            (async () => {
              for (let index = 0; index < 12; index += 1) {
                await pageOne.click("button");
              }
            })(),
            (async () => {
              for (let index = 0; index < 8; index += 1) {
                await pageTwo.click("button");
              }
            })()
          ]);

          expect(await pageOne.evaluate<number>(() => window.__clicks)).toBe(12);
          expect(await pageTwo.evaluate<number>(() => window.__clicks)).toBe(8);
        } finally {
          await pageOne.close();
          await pageTwo.close();
        }
      } finally {
        await contextOne.close();
        await contextTwo.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("applies Playwright strictSelectors context option to page selector APIs", async () => {
    const browser = await launchBrowser();
    try {
      const looseContext = await browser.newContext();
      const strictContext = await browser.newContext({ strictSelectors: true });

      try {
        const loosePage = await looseContext.newPage();
        const strictPage = await strictContext.newPage();

        try {
          const html = `<span>span1</span><div><span>target</span></div>`;
          await loosePage.setContent(html);
          await strictPage.setContent(html);

          expect(await loosePage.textContent("span")).toBe("span1");
          await expect(strictPage.textContent("span")).rejects.toThrow(/strict mode violation/);
          expect(await strictPage.textContent("span", { strict: false })).toBe("span1");

          await strictPage.setContent(`<button>button1</button><button>target</button>`);
          await expect(strictPage.click("button")).rejects.toThrow(/strict mode violation/);
          await strictPage.click("button", { strict: false });

          await strictPage.setContent(`<input><div><input></div>`);
          await expect(strictPage.type("input", "abc")).rejects.toThrow(/strict mode violation/);
          await strictPage.type("input", "abc", { strict: false });
          await expect(strictPage.press("input", "Backspace")).rejects.toThrow(/strict mode violation/);
          await strictPage.press("input", "Backspace", { strict: false });

          await strictPage.setContent(`<input type="checkbox"><div><input type="checkbox"></div>`);
          await expect(strictPage.check("input")).rejects.toThrow(/strict mode violation/);
          await strictPage.check("input", { strict: false });
          await expect(strictPage.uncheck("input")).rejects.toThrow(/strict mode violation/);
          await strictPage.uncheck("input", { strict: false });

          await strictPage.setContent(`
            <select><option value="a">A</option></select>
            <div><select><option value="b">B</option></select></div>
          `);
          await expect(strictPage.selectOption("select", "a")).rejects.toThrow(/strict mode violation/);
          expect(await strictPage.selectOption("select", "a", { strict: false })).toEqual(["a"]);
        } finally {
          await loosePage.close();
          await strictPage.close();
        }
      } finally {
        await looseContext.close();
        await strictContext.close();
      }
    } finally {
      await browser.close();
    }
  });
});
