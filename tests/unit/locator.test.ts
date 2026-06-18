import { describe, expect, it, vi } from "vitest";
import { RoxyFrameLocator, RoxyLocator } from "../../src/locator.js";
import { createLocatorAdapterStub } from "../helpers/fakes.js";

describe("RoxyLocator", () => {
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
});
