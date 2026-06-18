import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page event pageerror contract e2e", () => {
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

  it("should fire", async () => {
    await withPage(async (page) => {
      fixture.server.setRoute("/error.html", (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html>
          <script>
            function a() { b(); }
            function b() { c(); }
            function c() { throw new Error('Fancy error!'); }
            a();
            //# sourceURL=myscript.js
          </script>`);
      });

      const [error] = await Promise.all([
        page.waitForEvent("pageerror"),
        page.goto(fixture.server.PREFIX + "/error.html")
      ]);
      expect(error.name).toBe("Error");
      expect(error.message).toBe("Fancy error!");
      expect(error.stack).toContain("Fancy error!");
      expect(error.stack).toContain("myscript.js");
    });
  });

  it("should contain the Error.name property", async () => {
    await withPage(async (page) => {
      const [error] = await Promise.all([
        page.waitForEvent("pageerror"),
        page.evaluate(() => {
          setTimeout(() => {
            const error = new Error("my-message");
            error.name = "my-name";
            throw error;
          }, 0);
        })
      ]);
      expect(error.name).toBe("my-name");
      expect(error.message).toBe("my-message");
    });
  });

  it("should support an empty Error.name property", async () => {
    await withPage(async (page) => {
      const [error] = await Promise.all([
        page.waitForEvent("pageerror"),
        page.evaluate(() => {
          setTimeout(() => {
            const error = new Error("my-message");
            error.name = "";
            throw error;
          }, 0);
        })
      ]);
      expect(error.name).toBe("");
      expect(error.message).toBe("my-message");
    });
  });

  it("should handle odd values", async () => {
    await withPage(async (page) => {
      const cases: Array<[unknown, string]> = [
        [null, "null"],
        [undefined, "undefined"],
        [0, "0"],
        ["", ""]
      ];
      for (const [value, message] of cases) {
        const [error] = await Promise.all([
          page.waitForEvent("pageerror"),
          page.evaluate((thrownValue) => {
            setTimeout(() => {
              throw thrownValue;
            }, 0);
          }, value)
        ]);
        expect(error.message).toBe(message);
      }
    });
  });

  it("should handle object and window", async () => {
    await withPage(async (page) => {
      {
        const [error] = await Promise.all([
          page.waitForEvent("pageerror"),
          page.evaluate(() => {
            setTimeout(() => {
              throw {};
            }, 0);
          })
        ]);
        expect(error.message).toBe("Object");
      }

      {
        const [error] = await Promise.all([
          page.waitForEvent("pageerror"),
          page.evaluate(() => {
            setTimeout(() => {
              throw window;
            }, 0);
          })
        ]);
        expect(error.message).toBe("Window");
      }
    });
  });

  it("pageErrors should work", async () => {
    await withPage(async (page) => {
      await page.evaluate(async () => {
        for (let index = 0; index < 301; index += 1) {
          setTimeout(() => {
            throw new Error("error" + index);
          }, 0);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      });

      const messages = (await page.pageErrors()).map((error) => error.message);
      const expected = [];
      for (let index = 201; index < 301; index += 1) {
        expected.push("error" + index);
      }

      expect(messages.length).toBeGreaterThanOrEqual(100);
      expect(messages.slice(messages.length - expected.length)).toEqual(expected);
    });
  });

  it("clearPageErrors should work", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => {
        setTimeout(() => { throw new Error("error1"); }, 0);
        setTimeout(() => { throw new Error("error2"); }, 0);
      });
      await page.waitForTimeout(1000);

      let errors = await page.pageErrors();
      expect(errors.map((error) => error.message)).toContain("error1");
      expect(errors.map((error) => error.message)).toContain("error2");

      await page.clearPageErrors();
      expect(await page.pageErrors()).toEqual([]);

      await page.evaluate(() => {
        setTimeout(() => { throw new Error("error3"); }, 0);
      });
      await page.waitForTimeout(1000);

      errors = await page.pageErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain("error3");
    });
  });

  it("pageErrors defaults to since-navigation like Playwright", async () => {
    await withPage(async (page) => {
      fixture.server.setContent("/page1", `<script>throw new Error("page1 error");</script>`, "text/html");
      fixture.server.setContent("/page2", `<script>throw new Error("page2 error");</script>`, "text/html");

      await page.goto(fixture.server.PREFIX + "/page1").catch(() => null);
      await page.goto(fixture.server.PREFIX + "/page2").catch(() => null);

      const all = await page.pageErrors({ filter: "all" });
      expect(all.map((error) => error.message)).toContain("page1 error");
      expect(all.map((error) => error.message)).toContain("page2 error");

      const defaultErrors = await page.pageErrors();
      expect(defaultErrors.map((error) => error.message)).not.toContain("page1 error");
      expect(defaultErrors.map((error) => error.message)).toContain("page2 error");
      expect((await page.pageErrors({ filter: "since-navigation" })).map((error) => error.message)).toEqual(
        defaultErrors.map((error) => error.message)
      );
    });
  });
});
