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

          await pageOne.evaluate(`() => {
            localStorage.setItem("name", "page-one");
            document.cookie = "name=page-one";
          }`);
          await pageTwo.evaluate(`() => {
            localStorage.setItem("name", "page-two");
            document.cookie = "name=page-two";
          }`);

          expect(await pageOne.evaluate("() => localStorage.getItem('name')")).toBe("page-one");
          expect(await pageTwo.evaluate("() => localStorage.getItem('name')")).toBe("page-two");
          expect(await pageOne.evaluate("() => document.cookie")).toContain("name=page-one");
          expect(await pageTwo.evaluate("() => document.cookie")).toContain("name=page-two");
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
            ...Array.from({ length: 12 }, () => pageOne.click("button")),
            ...Array.from({ length: 8 }, () => pageTwo.click("button"))
          ]);

          expect(await pageOne.evaluate<number>("() => window.__clicks")).toBe(12);
          expect(await pageTwo.evaluate<number>("() => window.__clicks")).toBe(8);
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
});
