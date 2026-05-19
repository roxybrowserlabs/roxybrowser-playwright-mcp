import { describe, expect, it, vi } from "vitest";
import { RoxyLocator } from "../../src/locator.js";
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

  it("preserves regex metadata for text and role locators", () => {
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

    locator.getByText(/hello/i, { exact: true });
    locator.getByRole("button", { name: /send/i, exact: false });

    expect(rootAdapter.locator).toHaveBeenNthCalledWith(1, {
      strategy: "text",
      value: "hello",
      exact: true,
      isRegex: true,
      regexFlags: "i"
    });
    expect(rootAdapter.locator).toHaveBeenNthCalledWith(2, {
      strategy: "role",
      value: "button",
      exact: false,
      nameIsRegex: true,
      nameRegexFlags: "i"
    });
  });

  it("omits optional selector metadata when plain strings are used", () => {
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

    locator.getByText("hello");
    locator.getByRole("button", { name: "Send" });
    locator.getByRole("link");

    expect(rootAdapter.locator).toHaveBeenNthCalledWith(1, {
      strategy: "text",
      value: "hello"
    });
    expect(rootAdapter.locator).toHaveBeenNthCalledWith(2, {
      strategy: "role",
      value: "button",
      name: "Send"
    });
    expect(rootAdapter.locator).toHaveBeenNthCalledWith(3, {
      strategy: "role",
      value: "link"
    });
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
    await locator.hover();
    await locator.fill("value");
    await locator.type("typed");
    await locator.press("Enter");

    expect(controller.click).toHaveBeenCalledWith(adapter, { delay: 5 });
    expect(controller.hover).toHaveBeenCalledWith(adapter, undefined);
    expect(controller.fill).toHaveBeenCalledWith(adapter, "value", undefined);
    expect(controller.type).toHaveBeenCalledWith(adapter, "typed", undefined);
    expect(controller.press).toHaveBeenCalledWith(adapter, "Enter", undefined);
    expect(await locator.textContent()).toBe("text-value");
    expect(await locator.isVisible()).toBe(true);
  });
});
