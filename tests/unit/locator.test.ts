import { describe, expect, it, vi } from "vitest";
import { RoxyElementHandle } from "../../src/elementHandle.js";
import { RoxyFrameLocator, RoxyLocator } from "../../src/locator.js";
import { parseSelectorChain } from "../../src/selectors.js";
import { createElementHandleAdapterStub, createLocatorAdapterStub } from "../helpers/fakes.js";

describe("RoxyLocator", () => {
  it("matches Playwright selector parser errors for non-string selectors", () => {
    expect(() => (parseSelectorChain as any)(null)).toThrow("selector: expected string, got object");
  });

  it("auto-detects parenthesized xpath selectors", () => {
    expect(parseSelectorChain("(//section)[1]")).toEqual([
      {
        strategy: "xpath",
        value: "(//section)[1]"
      }
    ]);
  });

  it("does not split selector separators inside CSS attribute values", () => {
    expect(parseSelectorChain(`[attr2 = "hello-''>>foo=bar[]"] >> span`)).toEqual([
      {
        strategy: "css",
        value: `[attr2 = "hello-''>>foo=bar[]"]`
      },
      {
        strategy: "css",
        value: "span"
      }
    ]);
  });

  it("parses Playwright visible selector engine", () => {
    expect(parseSelectorChain(".item >> visible=true")).toEqual([
      {
        strategy: "css",
        value: ".item"
      },
      {
        strategy: "control",
        value: "visible",
        filter: true,
        visible: true
      }
    ]);
    expect(parseSelectorChain("visible=false")).toEqual([
      {
        strategy: "control",
        value: "visible",
        filter: true,
        visible: false
      }
    ]);
  });

  it("builds nested css locators from the adapter", () => {
    const rootAdapter = createLocatorAdapterStub();
    const childAdapter = createLocatorAdapterStub();
    rootAdapter.locator = vi.fn(() => childAdapter);
    const controller = {
      click: vi.fn(),
      hover: vi.fn(),
      fill: vi.fn(),
      type: vi.fn(),
      press: vi.fn()
    };
    const locator = new RoxyLocator(rootAdapter, controller);

    const nested = locator.locator(".child");

    expect(rootAdapter.locator).toHaveBeenCalledWith({
      strategy: "css",
      value: ".child"
    });
    expect(nested).toBeInstanceOf(RoxyLocator);
  });

  it("throws on capture with nth like Playwright", () => {
    const locator = new RoxyLocator(createLocatorAdapterStub(), {
      click: vi.fn(),
      hover: vi.fn(),
      fill: vi.fn(),
      type: vi.fn(),
      press: vi.fn()
    });

    expect(() => locator.locator("*css=div >> p").nth(1)).toThrow("Can't query n-th element");
  });

  it("matches Playwright locator description semantics", () => {
    const rootAdapter = createLocatorAdapterStub();
    rootAdapter.locator = vi.fn(() => rootAdapter);
    rootAdapter.getByRole = vi.fn(() => rootAdapter);
    const controller = {
      click: vi.fn(),
      hover: vi.fn(),
      fill: vi.fn(),
      type: vi.fn(),
      press: vi.fn()
    };
    const locator = new RoxyLocator(rootAdapter, controller);

    expect(locator.locator("button").description()).toBe(null);
    expect(locator.locator("button").describe("Submit button").description()).toBe("Submit button");

    const described = locator.locator("foo").describe("First description");
    expect(described.description()).toBe("First description");
    const nested = described.locator("button").describe("Second description");
    expect(nested.description()).toBe("Second description");
    expect(nested.locator("button").description()).toBe(null);
  });

  it("formats locator.toString like Playwright for css and role locators", () => {
    const rootAdapter = createLocatorAdapterStub();
    rootAdapter.locator = vi.fn(() => rootAdapter);
    rootAdapter.getByRole = vi.fn(() => rootAdapter);
    const controller = {
      click: vi.fn(),
      hover: vi.fn(),
      fill: vi.fn(),
      type: vi.fn(),
      press: vi.fn()
    };
    const locator = new RoxyLocator(rootAdapter, controller);

    expect(locator.locator("button").toString()).toBe("locator('button')");
    expect(locator.locator("form").locator("input").toString()).toBe("locator('form').locator('input')");
    expect(locator.getByRole("button", { name: "Submit" }).toString()).toBe(
      "getByRole('button', { name: 'Submit' })"
    );
    expect(locator.getByRole("button", { name: "Submit", exact: true }).toString()).toBe(
      "getByRole('button', { name: 'Submit', exact: true })"
    );
    expect(locator.getByRole("button", { name: /send/i }).toString()).toBe(
      "getByRole('button', { name: /send/i })"
    );
    expect(locator.getByRole("button", { name: "Submit" }).describe("Submit button").toString()).toBe(
      "Submit button"
    );
  });

  it("applies Playwright locator filter options when nesting locators", () => {
    const rootAdapter = createLocatorAdapterStub();
    const childAdapter = createLocatorAdapterStub();
    const filteredAdapter = createLocatorAdapterStub();
    rootAdapter.locator = vi.fn(() => childAdapter);
    childAdapter.locator = vi.fn(() => filteredAdapter);
    const controller = {
      click: vi.fn(),
      hover: vi.fn(),
      fill: vi.fn(),
      type: vi.fn(),
      press: vi.fn()
    };
    const locator = new RoxyLocator(rootAdapter, controller);
    const hasText = /submit/i;

    const nested = locator.locator(".child", { hasText });

    expect(rootAdapter.locator).toHaveBeenNthCalledWith(1, {
      strategy: "css",
      value: ".child"
    });
    expect(childAdapter.locator).toHaveBeenCalledWith({
      strategy: "text",
      value: "submit",
      isRegex: true,
      regexFlags: "i",
      internal: true,
      filter: true
    });
    expect(nested).toBeInstanceOf(RoxyLocator);
  });

  it("applies Playwright hasNotText locator filters when nesting locators", () => {
    const rootAdapter = createLocatorAdapterStub();
    const childAdapter = createLocatorAdapterStub();
    const filteredAdapter = createLocatorAdapterStub();
    rootAdapter.locator = vi.fn(() => childAdapter);
    childAdapter.locator = vi.fn(() => filteredAdapter);
    const controller = {
      click: vi.fn(),
      hover: vi.fn(),
      fill: vi.fn(),
      type: vi.fn(),
      press: vi.fn()
    };
    const locator = new RoxyLocator(rootAdapter, controller);

    const nested = locator.locator(".child", { hasNotText: "hidden" });

    expect(rootAdapter.locator).toHaveBeenNthCalledWith(1, {
      strategy: "css",
      value: ".child"
    });
    expect(childAdapter.locator).toHaveBeenCalledWith({
      strategy: "text",
      value: "hidden",
      internal: true,
      filter: true,
      negate: true
    });
    expect(nested).toBeInstanceOf(RoxyLocator);
  });

  it("applies Playwright visible locator filters", () => {
    const rootAdapter = createLocatorAdapterStub();
    const childAdapter = createLocatorAdapterStub();
    const filteredAdapter = createLocatorAdapterStub();
    rootAdapter.locator = vi.fn(() => childAdapter);
    childAdapter.locator = vi.fn(() => filteredAdapter);
    const controller = {
      click: vi.fn(),
      hover: vi.fn(),
      fill: vi.fn(),
      type: vi.fn(),
      press: vi.fn()
    };
    const locator = new RoxyLocator(rootAdapter, controller);

    const nested = locator.locator(".child").filter({ visible: false });

    expect(rootAdapter.locator).toHaveBeenCalledWith({
      strategy: "css",
      value: ".child"
    });
    expect(childAdapter.locator).toHaveBeenCalledWith({
      strategy: "control",
      value: "visible",
      filter: true,
      visible: false
    });
    expect(nested).toBeInstanceOf(RoxyLocator);
  });

  it("applies Playwright has locator filters when nesting locators", () => {
    const rootAdapter = createLocatorAdapterStub();
    const childAdapter = createLocatorAdapterStub();
    const filteredAdapter = createLocatorAdapterStub();
    rootAdapter.locator = vi.fn(() => childAdapter);
    childAdapter.locator = vi.fn(() => filteredAdapter);
    const controller = {
      click: vi.fn(),
      hover: vi.fn(),
      fill: vi.fn(),
      type: vi.fn(),
      press: vi.fn()
    };
    const locator = new RoxyLocator(rootAdapter, controller);
    const inner = new RoxyLocator(rootAdapter, controller).locator("span", { hasText: "world" });

    const nested = locator.locator("div", { has: inner });

    expect(rootAdapter.locator).toHaveBeenNthCalledWith(1, {
      strategy: "css",
      value: "span"
    });
    expect(rootAdapter.locator).toHaveBeenNthCalledWith(2, {
      strategy: "css",
      value: "div"
    });
    expect(childAdapter.locator).toHaveBeenCalledWith({
      strategy: "control",
      value: "has",
      filter: true,
      hasChain: [
        {
          strategy: "css",
          value: "span"
        },
        {
          strategy: "text",
          value: "world",
          internal: true,
          filter: true
        }
      ]
    });
    expect(nested).toBeInstanceOf(RoxyLocator);
  });

  it("applies Playwright hasNot locator filters when nesting locators", () => {
    const rootAdapter = createLocatorAdapterStub();
    const childAdapter = createLocatorAdapterStub();
    const filteredAdapter = createLocatorAdapterStub();
    rootAdapter.locator = vi.fn(() => childAdapter);
    childAdapter.locator = vi.fn(() => filteredAdapter);
    const controller = {
      click: vi.fn(),
      hover: vi.fn(),
      fill: vi.fn(),
      type: vi.fn(),
      press: vi.fn()
    };
    const locator = new RoxyLocator(rootAdapter, controller);
    const inner = new RoxyLocator(rootAdapter, controller).locator("span");

    const nested = locator.locator("div", { hasNot: inner });

    expect(childAdapter.locator).toHaveBeenCalledWith({
      strategy: "control",
      value: "has-not",
      filter: true,
      negate: true,
      hasChain: [
        {
          strategy: "css",
          value: "span"
        }
      ]
    });
    expect(nested).toBeInstanceOf(RoxyLocator);
  });

  it("builds Playwright internal chain locators when nesting a locator", () => {
    const rootAdapter = createLocatorAdapterStub();
    const chainedAdapter = createLocatorAdapterStub();
    rootAdapter.locator = vi.fn(() => chainedAdapter);
    const controller = {
      click: vi.fn(),
      hover: vi.fn(),
      fill: vi.fn(),
      type: vi.fn(),
      press: vi.fn()
    };
    const locator = new RoxyLocator(rootAdapter, controller).locator("div");
    const inner = new RoxyLocator(rootAdapter, controller).locator("button");

    const nested = locator.locator(inner);

    expect(chainedAdapter.locator).toHaveBeenCalledWith({
      strategy: "control",
      value: "chain",
      composite: "chain",
      hasChain: [
        {
          strategy: "css",
          value: "button"
        }
      ]
    });
    expect(nested).toBeInstanceOf(RoxyLocator);
  });

  it("builds Playwright internal and/or composite locators", () => {
    const rootAdapter = createLocatorAdapterStub();
    const divAdapter = createLocatorAdapterStub();
    const andAdapter = createLocatorAdapterStub();
    const orAdapter = createLocatorAdapterStub();
    rootAdapter.locator = vi.fn(() => divAdapter);
    divAdapter.locator = vi
      .fn()
      .mockReturnValueOnce(andAdapter)
      .mockReturnValueOnce(orAdapter);
    const controller = {
      click: vi.fn(),
      hover: vi.fn(),
      fill: vi.fn(),
      type: vi.fn(),
      press: vi.fn()
    };
    const locator = new RoxyLocator(rootAdapter, controller).locator("div");
    const testIdLocator = new RoxyLocator(rootAdapter, controller).getByTestId("foo");
    const spanLocator = new RoxyLocator(rootAdapter, controller).locator("span");

    expect(locator.and(testIdLocator)).toBeInstanceOf(RoxyLocator);
    expect(locator.or(spanLocator)).toBeInstanceOf(RoxyLocator);
    expect(divAdapter.locator).toHaveBeenNthCalledWith(1, {
      strategy: "control",
      value: "and",
      composite: "and",
      hasChain: [
        {
          strategy: "css",
          value: "foo",
          label: "testId"
        }
      ]
    });
    expect(divAdapter.locator).toHaveBeenNthCalledWith(2, {
      strategy: "control",
      value: "or",
      composite: "or",
      hasChain: [
        {
          strategy: "css",
          value: "span"
        }
      ]
    });
  });

  it("enforces same-frame locators for Playwright composite options", () => {
    const rootAdapter = createLocatorAdapterStub();
    const mainLocator = new RoxyLocator(
      rootAdapter,
      undefined,
      [{ strategy: "css", value: "div" }],
      undefined,
      undefined,
      undefined,
      undefined,
      "main"
    );
    const childLocator = new RoxyLocator(
      rootAdapter,
      undefined,
      [{ strategy: "css", value: "span" }],
      undefined,
      undefined,
      undefined,
      undefined,
      "child"
    );

    expect(() => mainLocator.locator(childLocator)).toThrow("Locators must belong to the same frame.");
    expect(() => mainLocator.and(childLocator)).toThrow("Locators must belong to the same frame.");
    expect(() => mainLocator.or(childLocator)).toThrow("Locators must belong to the same frame.");
    expect(() => mainLocator.filter({ has: childLocator })).toThrow('Inner "has" locator must belong to the same frame.');
    expect(() => mainLocator.filter({ hasNot: childLocator })).toThrow('Inner "hasNot" locator must belong to the same frame.');
  });

  it("builds frame locators by inserting an enter-frame control step", () => {
    const rootAdapter = createLocatorAdapterStub();
    const frameAdapter = createLocatorAdapterStub();
    const contentAdapter = createLocatorAdapterStub();
    rootAdapter.locator = vi
      .fn()
      .mockReturnValueOnce(frameAdapter)
      .mockReturnValueOnce(contentAdapter);
    frameAdapter.locator = vi.fn(() => contentAdapter);
    const controller = {
      click: vi.fn(),
      hover: vi.fn(),
      fill: vi.fn(),
      type: vi.fn(),
      press: vi.fn()
    };
    const locator = new RoxyLocator(rootAdapter, controller);

    const frameLocator = locator.frameLocator("iframe");

    expect(frameLocator).toBeInstanceOf(RoxyFrameLocator);
    expect(rootAdapter.locator).toHaveBeenNthCalledWith(1, {
      strategy: "css",
      value: "iframe"
    });
    expect(frameAdapter.locator).toHaveBeenCalledWith({
      strategy: "control",
      value: "enter-frame"
    });
  });

  it("exposes contentFrame and owner relationships", () => {
    const adapter = createLocatorAdapterStub();
    const contentAdapter = createLocatorAdapterStub();
    adapter.locator = vi.fn(() => contentAdapter);
    const controller = {
      click: vi.fn(),
      hover: vi.fn(),
      fill: vi.fn(),
      type: vi.fn(),
      press: vi.fn()
    };
    const locator = new RoxyLocator(adapter, controller);

    const frameLocator = locator.contentFrame();

    expect(frameLocator.owner()).toBe(locator);
    expect(adapter.locator).toHaveBeenCalledWith({
      strategy: "control",
      value: "enter-frame"
    });
  });

  it("preserves regex metadata for text and role locators", () => {
    const rootAdapter = createLocatorAdapterStub();
    const childAdapter = createLocatorAdapterStub();
    const controller = {
      click: vi.fn(),
      hover: vi.fn(),
      fill: vi.fn(),
      type: vi.fn(),
      press: vi.fn()
    };
    const locator = new RoxyLocator(rootAdapter, controller);

    locator.getByText(/hello/i, { exact: true });
    locator.getByAltText(/logo/i, { exact: true });
    locator.getByLabel(/name/i);
    locator.getByPlaceholder(/search/i);
    locator.getByTestId(/card/i);
    locator.getByRole("button", { name: /send/i, exact: false });
    locator.getByTitle(/hint/i, { exact: false });

    expect(rootAdapter.getByText).toHaveBeenCalledWith(/hello/i, { exact: true });
    expect(rootAdapter.getByAltText).toHaveBeenCalledWith(/logo/i, { exact: true });
    expect(rootAdapter.getByLabel).toHaveBeenCalledWith(/name/i, undefined);
    expect(rootAdapter.getByPlaceholder).toHaveBeenCalledWith(/search/i, undefined);
    expect(rootAdapter.getByTestId).toHaveBeenCalledWith(/card/i);
    expect(rootAdapter.getByRole).toHaveBeenCalledWith("button", { name: /send/i, exact: false });
    expect(rootAdapter.getByTitle).toHaveBeenCalledWith(/hint/i, { exact: false });
  });

  it("omits optional selector metadata when plain strings are used", () => {
    const rootAdapter = createLocatorAdapterStub();
    const childAdapter = createLocatorAdapterStub();
    const controller = {
      click: vi.fn(),
      hover: vi.fn(),
      fill: vi.fn(),
      type: vi.fn(),
      press: vi.fn()
    };
    const locator = new RoxyLocator(rootAdapter, controller);

    locator.getByText("hello");
    locator.getByAltText("logo");
    locator.getByLabel("Name");
    locator.getByPlaceholder("Search");
    locator.getByTestId("card");
    locator.getByRole("button", { name: "Send" });
    locator.getByRole("link");
    locator.getByTitle("Hint");

    expect(rootAdapter.getByText).toHaveBeenCalledWith("hello", undefined);
    expect(rootAdapter.getByAltText).toHaveBeenCalledWith("logo", undefined);
    expect(rootAdapter.getByLabel).toHaveBeenCalledWith("Name", undefined);
    expect(rootAdapter.getByPlaceholder).toHaveBeenCalledWith("Search", undefined);
    expect(rootAdapter.getByTestId).toHaveBeenCalledWith("card");
    expect(rootAdapter.getByRole).toHaveBeenNthCalledWith(1, "button", { name: "Send" });
    expect(rootAdapter.getByRole).toHaveBeenNthCalledWith(2, "link", undefined);
    expect(rootAdapter.getByTitle).toHaveBeenCalledWith("Hint", undefined);
  });

  it("delegates actions and state reads to the human controller and adapter", async () => {
    const adapter = createLocatorAdapterStub();
    const controller = {
      click: vi.fn(async () => {}),
      hover: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
      press: vi.fn(async () => {})
    };
    const locator = new RoxyLocator(adapter, controller);

    expect(locator.first()).toBeInstanceOf(RoxyLocator);
    expect(locator.last()).toBeInstanceOf(RoxyLocator);
    expect(locator.nth(2)).toBeInstanceOf(RoxyLocator);

    await locator.click({ delay: 5 });
    await locator.dblclick();
    await locator.check();
    await locator.hover();
    await locator.fill("value");
    await locator.type("typed");
    await locator.press("Enter");
    await locator.focus();

    expect(controller.click).toHaveBeenCalledWith(adapter, { delay: 5 });
    expect(adapter.dblclick).toHaveBeenCalledWith(undefined);
    expect(adapter.check).toHaveBeenCalledWith(undefined);
    expect(controller.hover).toHaveBeenCalledWith(adapter, undefined);
    expect(controller.fill).toHaveBeenCalledWith(adapter, "value", undefined);
    expect(controller.type).toHaveBeenCalledWith(adapter, "typed", undefined);
    expect(controller.press).toHaveBeenCalledWith(adapter, "Enter", undefined);
    expect(adapter.focus).toHaveBeenCalledTimes(1);
    expect(await locator.getAttribute("data-id")).toBe("attr-value");
    expect(await locator.innerHTML()).toBe("<span>html-value</span>");
    expect(await locator.innerText()).toBe("inner-text-value");
    expect(await locator.inputValue()).toBe("input-value");
    expect(await locator.isChecked()).toBe(true);
    expect(await locator.isDisabled()).toBe(false);
    expect(await locator.isEditable()).toBe(true);
    expect(await locator.isEnabled()).toBe(true);
    expect(await locator.isHidden()).toBe(false);
    expect(await locator.selectOption("blue")).toEqual(["selected-value"]);
    await locator.uncheck();
    expect(adapter.uncheck).toHaveBeenCalledWith(undefined);
    expect(await locator.textContent()).toBe("text-value");
    expect(await locator.isVisible()).toBe(true);
  });

  it("forwards optional human overrides through locator and element handle actions", async () => {
    const locatorAdapter = createLocatorAdapterStub();
    const elementAdapter = createElementHandleAdapterStub();
    const controller = {
      click: vi.fn(async () => {}),
      hover: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
      press: vi.fn(async () => {})
    };
    const locator = new RoxyLocator(locatorAdapter, controller);
    const elementHandle = new RoxyElementHandle(
      elementAdapter,
      {
        enabled: true,
        profile: "balanced",
        moveJitterMs: 16,
        clickHoldMs: 60,
        scrollStepPx: 280,
        typingDelayMs: 95,
        typingVarianceMs: 35,
        hoverBeforeClickMs: 110
      }
    );

    await locator.click({ human: { enabled: false }, trial: true });
    await locator.hover({ human: { enabled: false }, timeout: 22 });
    await locator.fill("value", { human: { enabled: false }, force: true });
    await locator.type("typed", { human: { enabled: false }, delay: 12 });
    await locator.press("Enter", { human: { enabled: false }, delay: 8 });
    await locator.tap({ human: { enabled: false }, trial: true });
    await locator.check({ human: { enabled: false }, trial: true });
    await locator.uncheck({ human: { enabled: false }, trial: true });
    await locator.setChecked(true, { human: { enabled: false }, trial: true });
    await locator.clear({ human: { enabled: false }, timeout: 12 });
    await locator.dblclick({ human: { enabled: false }, delay: 5 });
    await locator.pressSequentially("slow", { human: { enabled: false }, delay: 3 });

    expect(controller.click).toHaveBeenCalledWith(locatorAdapter, { human: { enabled: false }, trial: true });
    expect(controller.hover).toHaveBeenCalledWith(locatorAdapter, { human: { enabled: false }, timeout: 22 });
    expect(controller.fill).toHaveBeenCalledWith(locatorAdapter, "value", { human: { enabled: false }, force: true });
    expect(controller.type).toHaveBeenCalledWith(locatorAdapter, "typed", { human: { enabled: false }, delay: 12 });
    expect(controller.press).toHaveBeenCalledWith(locatorAdapter, "Enter", { human: { enabled: false }, delay: 8 });
    expect(locatorAdapter.tap).toHaveBeenCalledWith({ human: { enabled: false }, trial: true });
    expect(locatorAdapter.check).toHaveBeenCalledWith({ human: { enabled: false }, trial: true });
    expect(locatorAdapter.uncheck).toHaveBeenCalledWith({ human: { enabled: false }, trial: true });
    expect(locatorAdapter.check).toHaveBeenNthCalledWith(2, { human: { enabled: false }, trial: true });
    expect(controller.fill).toHaveBeenNthCalledWith(2, locatorAdapter, "", { human: { enabled: false }, timeout: 12 });
    expect(locatorAdapter.dblclick).toHaveBeenCalledWith({ human: { enabled: false }, delay: 5 });
    expect(controller.type).toHaveBeenNthCalledWith(2, locatorAdapter, "slow", { human: { enabled: false }, delay: 3 });

    await elementHandle.click({ human: { enabled: false }, trial: true });
    await elementHandle.hover({ human: { enabled: false }, timeout: 14 });
    await elementHandle.fill("value", { human: { enabled: false }, force: true });
    await elementHandle.type("typed", { human: { enabled: false }, delay: 11 });
    await elementHandle.press("Enter", { human: { enabled: false }, delay: 7 });
    await elementHandle.tap({ human: { enabled: false }, trial: true });
    await elementHandle.check({ human: { enabled: false }, trial: true });
    await elementHandle.uncheck({ human: { enabled: false }, trial: true });
    await elementHandle.setChecked(true, { human: { enabled: false }, trial: true });
    await elementHandle.dblclick({ human: { enabled: false }, delay: 6 });

    expect(elementAdapter.click).toHaveBeenCalledWith(expect.objectContaining({
      human: { enabled: false },
      trial: true
    }));
    expect(elementAdapter.hover).toHaveBeenCalledWith(expect.objectContaining({
      human: { enabled: false },
      timeout: 14
    }));
    expect(elementAdapter.fill).toHaveBeenCalledWith("value", { human: { enabled: false }, force: true });
    expect(elementAdapter.type).toHaveBeenCalledWith("typed", { human: { enabled: false }, delay: 11 });
    expect(elementAdapter.press).toHaveBeenCalledWith("Enter", { human: { enabled: false }, delay: 7 });
    expect(elementAdapter.check).toHaveBeenCalledWith({ human: { enabled: false }, trial: true });
    expect(elementAdapter.uncheck).toHaveBeenCalledWith({ human: { enabled: false }, trial: true });
    expect(elementAdapter.check).toHaveBeenNthCalledWith(2, { human: { enabled: false }, trial: true });
    expect(elementAdapter.dblclick).toHaveBeenCalledWith({ human: { enabled: false }, delay: 6 });
  });

  it("dispatches drop through an element handle with normalized payloads", async () => {
    const adapter = createLocatorAdapterStub();
    const elementAdapter = createElementHandleAdapterStub();
    adapter.elementHandle = vi.fn(async () => elementAdapter);
    const locator = new RoxyLocator(adapter);

    await locator.drop(
      {
        data: { "text/plain": "hello" },
        files: { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("file-body") }
      },
      { position: { x: 3, y: 4 }, timeout: 25 }
    );

    expect(adapter.elementHandle).toHaveBeenCalledTimes(1);
    expect(elementAdapter.evaluate).toHaveBeenCalledTimes(1);
    const [source, payload] = vi.mocked(elementAdapter.evaluate).mock.calls[0]!;
    expect(source).toEqual(expect.stringContaining("new DataTransfer()"));
    expect(payload).toEqual({
      data: { "text/plain": "hello" },
      files: [{
        buffer: Buffer.from("file-body").toString("base64"),
        mimeType: "text/plain",
        name: "note.txt"
      }],
      position: { x: 3, y: 4 }
    });
  });

  it("requires locator.drop to include files or data", async () => {
    const locator = new RoxyLocator(createLocatorAdapterStub());

    await expect(locator.drop({})).rejects.toThrow('At least one of "files" or "data" must be provided.');
  });
});
