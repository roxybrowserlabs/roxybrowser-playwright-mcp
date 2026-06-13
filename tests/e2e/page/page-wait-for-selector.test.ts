import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

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

  it("should respond to node attribute mutation", async () => {
    await withPage(async (page) => {
      let found = false;
      const waitForSelector = page
        .waitForSelector(".zombo", { state: "attached" })
        .then(() => {
          found = true;
        });

      await page.setContent("<div class='notZombo'></div>");
      expect(found).toBe(false);

      await page.evaluate(`() => {
        document.querySelector("div").className = "zombo";
      }`);

      await waitForSelector;
      expect(found).toBe(true);
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

  it("should wait for visible", async () => {
    await withPage(async (page) => {
      let found = false;
      const waitForSelector = page.waitForSelector("div").then(() => {
        found = true;
      });

      await page.setContent("<div style='display: none; visibility: hidden;'>1</div>");
      expect(found).toBe(false);

      await page.evaluate(`() => {
        document.querySelector("div").style.removeProperty("display");
      }`);
      expect(found).toBe(false);

      await page.evaluate(`() => {
        document.querySelector("div").style.removeProperty("visibility");
      }`);

      await waitForSelector;
      expect(found).toBe(true);
    });
  });

  it("should not consider zero-sized elements visible", async () => {
    await withPage(async (page) => {
      await page.setContent("<div style='width: 0; height: 0;'>1</div>");

      let error = await page.waitForSelector("div", { timeout: 100 }).catch((caughtError: Error) => {
        return caughtError;
      });
      expect(error.message).toContain("Timeout 100ms exceeded.");

      await page.evaluate(`() => {
        document.querySelector("div").style.width = "10px";
      }`);

      error = await page.waitForSelector("div", { timeout: 100 }).catch((caughtError: Error) => {
        return caughtError;
      });
      expect(error.message).toContain("Timeout 100ms exceeded.");

      await page.evaluate(`() => {
        document.querySelector("div").style.height = "10px";
      }`);

      expect(await page.waitForSelector("div", { timeout: 100 })).toBeTruthy();
    });
  });

  it("should wait for hidden after display:none", async () => {
    await withPage(async (page) => {
      let hidden = false;
      await page.setContent("<div style='display: block;'>content</div>");
      const waitForSelector = page.waitForSelector("div", { state: "hidden" }).then(() => {
        hidden = true;
      });

      await page.waitForSelector("div");
      expect(hidden).toBe(false);

      await page.evaluate(`() => {
        document.querySelector("div").style.setProperty("display", "none");
      }`);

      await waitForSelector;
      expect(hidden).toBe(true);
    });
  });

  it("should wait for hidden after removal", async () => {
    await withPage(async (page) => {
      let hidden = false;
      await page.setContent("<div>content</div>");
      const waitForSelector = page.waitForSelector("div", { state: "hidden" }).then(() => {
        hidden = true;
      });

      await page.waitForSelector("div");
      expect(hidden).toBe(false);

      await page.evaluate(`() => {
        document.querySelector("div").remove();
      }`);

      await waitForSelector;
      expect(hidden).toBe(true);
    });
  });

  it("should return null if waiting to hide a non-existing element", async () => {
    await withPage(async (page) => {
      expect(await page.waitForSelector("non-existing", { state: "hidden" })).toBe(null);
    });
  });

  it("should wait for detached if already detached", async () => {
    await withPage(async (page) => {
      await page.setContent("<section id='testAttribute'>43543</section>");
      expect(await page.waitForSelector("css=div", { state: "detached" })).toBe(null);
    });
  });

  it("should wait for detached after removal", async () => {
    await withPage(async (page) => {
      await page.setContent("<section id='testAttribute'><div>43543</div></section>");
      let done = false;
      const waitForSelector = page.waitForSelector("css=div", { state: "detached" }).then(() => {
        done = true;
      });

      expect(done).toBe(false);
      await page.waitForSelector("css=section");
      expect(done).toBe(false);

      await page.evaluate(`() => {
        document.querySelector("div").remove();
      }`);

      await waitForSelector;
      expect(done).toBe(true);
    });
  });

  it("should throw for unknown state options", async () => {
    await withPage(async (page) => {
      await page.setContent("<section>test</section>");

      const error = await page
        .waitForSelector("section", { state: "foo" as never })
        .catch((caughtError: Error) => caughtError);

      expect(error.message).toContain("state: expected one of (attached|detached|visible|hidden)");
    });
  });

  it("should throw for visibility options", async () => {
    await withPage(async (page) => {
      await page.setContent("<section>test</section>");

      const error = await page
        .waitForSelector("section", { visibility: "hidden" } as never)
        .catch((caughtError: Error) => caughtError);

      expect(error.message).toContain("options.visibility is not supported, did you mean options.state?");
    });
  });

  it("elementHandle.waitForSelector should immediately resolve if node exists", async () => {
    await withPage(async (page) => {
      await page.setContent("<span>extra</span><div><span>target</span></div>");
      const div = (await page.$("div"))!;
      const span = await div.waitForSelector("span", { state: "attached" });
      expect(await span!.evaluate((e) => (e as HTMLElement).textContent)).toBe("target");
    });
  });

  it("elementHandle.waitForSelector should wait", async () => {
    await withPage(async (page) => {
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
    await withPage(async (page) => {
      await page.setContent("<div></div>");
      const div = (await page.$("div"))!;
      const error = await div.waitForSelector("span", { timeout: 100 }).catch((caughtError: Error) => {
        return caughtError;
      });
      expect(error.message).toContain("Timeout 100ms exceeded.");
    });
  });
});
