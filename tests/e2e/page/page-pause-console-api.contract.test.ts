import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page pause console api contract e2e", () => {
  it("exposes Playwright-style console helpers while paused", async () => {
    await withPage(async (page) => {
      await page.setContent("<body><div id='root'>pause</div></body>");

      const pausePromise = (page as typeof page & {
        pause(options?: { __testHookKeepTestTimeout?: boolean }): Promise<void>;
      }).pause({ __testHookKeepTestTimeout: true });

      await page.waitForFunction(() => Boolean((window as Window & { playwright?: unknown }).playwright));

      expect(
        await page.evaluate(() => Object.keys((window as Window & { playwright: Record<string, unknown> }).playwright))
      ).toEqual([
        "$",
        "$$",
        "inspect",
        "selector",
        "generateLocator",
        "ariaSnapshot",
        "resume",
        "locator",
        "getByTestId",
        "getByAltText",
        "getByLabel",
        "getByPlaceholder",
        "getByText",
        "getByTitle",
        "getByRole"
      ]);

      expect(
        await page.evaluate(
          () => (window as Window & { playwright: { $(selector: string): Element | null } }).playwright.$("body")?.nodeName
        )
      ).toBe("BODY");
      expect(
        await page.evaluate(
          () => (window as Window & { playwright: { $$(selector: string): Element[] } }).playwright.$$("body").length
        )
      ).toBe(1);
      expect(
        await page.evaluate(
          () =>
            (window as Window & { playwright: { selector(node: Node): string | null } }).playwright.selector(
              document.body
            )
        )
      ).toBe("body");

      await page.evaluate(() => {
        (window as Window & { playwright: { resume(): boolean } }).playwright.resume();
      });
      await pausePromise;
    });
  });

  it("supports locator and getBy helpers while paused", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div data-testid="Hey">Hi</div>
        <div><span>Hello</span></div>
        <div><span>dont match</span></div>
        <span title="world">World</span>
        <div>one</div>
        <div style="display:none">two</div>
        <label for="email">Email</label>
        <input id="email" placeholder="name@example.com" aria-label="Email" />
        <button>Submit</button>
      `);

      const pausePromise = (page as typeof page & {
        pause(options?: { __testHookKeepTestTimeout?: boolean }): Promise<void>;
      }).pause({ __testHookKeepTestTimeout: true });

      await page.waitForFunction(() => Boolean((window as Window & { playwright?: unknown }).playwright));

      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                locator(selector: string, options?: { hasText?: string | RegExp }): { elements: Element[] };
              };
            }).playwright.locator("div", { hasText: "Hello" }).elements.length
        )
      ).toBe(1);
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                locator(selector: string, options?: { hasText?: string | RegExp }): { elements: Element[] };
              };
            }).playwright.locator("div", { hasText: "HElLo" }).elements.length
        )
      ).toBe(1);
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                locator(selector: string, options?: { hasText?: string | RegExp }): { elements: Element[] };
              };
            }).playwright.locator("div", { hasText: /ELL/ }).elements.length
        )
      ).toBe(0);
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                locator(selector: string, options?: { hasText?: string | RegExp }): { elements: Element[] };
              };
            }).playwright.locator("div", { hasText: /Hello/ }).elements.length
        )
      ).toBe(1);
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                locator(selector: string, options?: { hasNotText?: string | RegExp }): { elements: Element[] };
              };
            }).playwright.locator("div", { hasNotText: /Bar/ }).elements.length
        )
      ).toBe(5);
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                locator(selector: string, options?: { hasNotText?: string | RegExp }): { elements: Element[] };
              };
            }).playwright.locator("div", { hasNotText: /Hello/ }).elements.length
        )
      ).toBe(4);
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                locator(
                  selector: string,
                  options?: { has?: { element: Element | null } }
                ): { element: Element | null };
              };
            }).playwright.locator("div", {
              has: (window as Window & {
                playwright: {
                  locator(selector: string): { element: Element | null };
                };
              }).playwright.locator("span")
            }).element?.innerHTML
        )
      ).toContain("Hello");
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                locator(
                  selector: string,
                  options?: { has?: { element: Element | null } }
                ): { element: Element | null };
              };
            }).playwright.locator("div", {
              has: (window as Window & {
                playwright: {
                  locator(selector: string): { element: Element | null };
                };
              }).playwright.locator("text=Hello")
            }).element?.innerHTML
        )
      ).toContain("span");
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                locator(
                  selector: string,
                  options?: { has?: { elements: Element[] } }
                ): { elements: Element[] };
              };
            }).playwright.locator("div", {
              has: (window as Window & {
                playwright: {
                  locator(
                    selector: string,
                    options?: { hasText?: string | RegExp }
                  ): { elements: Element[] };
                };
              }).playwright.locator("span", { hasText: "Hello" })
            }).elements.length
        )
      ).toBe(1);
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                locator(
                  selector: string,
                  options?: { hasNot?: { elements: Element[] } }
                ): { element: Element | null };
              };
            }).playwright.locator("div", {
              hasNot: (window as Window & {
                playwright: {
                  locator(selector: string): { elements: Element[] };
                };
              }).playwright.locator("span")
            }).element?.innerHTML
        )
      ).toContain("Hi");
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                locator(selector: string): {
                  and(other: { elements: Element[] }): { elements: Element[] };
                  elements: Element[];
                };
                getByTestId(testId: string): { elements: Element[] };
              };
            }).playwright
              .locator("div")
              .and((window as Window & { playwright: { getByTestId(testId: string): { elements: Element[] } } }).playwright.getByTestId("Hey"))
              .elements.map((element) => element.innerHTML)
        )
      ).toEqual(["Hi"]);
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                locator(selector: string): {
                  or(other: { elements: Element[] }): { elements: Element[] };
                  elements: Element[];
                };
              };
            }).playwright
              .locator("div[data-testid='Hey']")
              .or((window as Window & { playwright: { locator(selector: string): { elements: Element[] } } }).playwright.locator("span[title='world']"))
              .elements.map((element) => element.textContent)
        )
      ).toEqual(["Hi", "World"]);
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                getByText(text: string): { element: Element | null };
              };
            }).playwright.getByText("hello").element?.innerHTML
        )
      ).toContain("Hello");
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                getByTitle(text: string): { element: Element | null };
              };
            }).playwright.getByTitle("world").element?.innerHTML
        )
      ).toContain("World");
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                locator(selector: string): {
                  filter(options: { visible: boolean }): { element: Element | null };
                };
              };
            }).playwright.locator("div").filter({ visible: false }).element?.innerHTML
        )
      ).toContain("two");
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                getByLabel(text: string): { element: Element | null };
              };
            }).playwright.getByLabel("Email").element?.id
        )
      ).toBe("email");
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                getByPlaceholder(text: string): { element: Element | null };
              };
            }).playwright.getByPlaceholder("name@example.com").element?.id
        )
      ).toBe("email");
      expect(
        await page.evaluate(
          () =>
            (window as Window & {
              playwright: {
                getByRole(
                  role: string,
                  options?: { name?: string | RegExp }
                ): { element: Element | null };
              };
            }).playwright.getByRole("button", { name: "Submit" }).element?.textContent
        )
      ).toContain("Submit");

      await page.evaluate(() => {
        (window as Window & { playwright: { resume(): boolean } }).playwright.resume();
      });
      await pausePromise;
    });
  });
});
