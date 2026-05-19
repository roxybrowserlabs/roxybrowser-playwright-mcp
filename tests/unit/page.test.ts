import { describe, expect, it, vi } from "vitest";
import { RoxyLocator } from "../../src/locator.js";
import { RoxyPage } from "../../src/page.js";
import { createPageAdapterStub } from "../helpers/fakes.js";

describe("RoxyPage", () => {
  it("proxies page-level methods to the page adapter", async () => {
    const adapter = createPageAdapterStub();
    const page = new RoxyPage(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
    expect(await page.title()).toBe("Example title");
    expect(await page.content()).toBe("<html></html>");
    await page.setContent("<div>ok</div>");
    expect(await page.evaluate<{ ok: boolean }>("() => ({ ok: true })")).toEqual({ ok: true });
    await page.waitForLoadState("load");
    await page.close();

    expect(adapter.goto).toHaveBeenCalledWith("https://example.com", {
      waitUntil: "domcontentloaded"
    });
    expect(adapter.setContent).toHaveBeenCalledWith("<div>ok</div>");
    expect(adapter.waitForLoadState).toHaveBeenCalledWith("load");
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it("creates locator wrappers from selector, text and role helpers", () => {
    const adapter = createPageAdapterStub();
    const locatorAdapter = adapter.locator(".target");
    const page = new RoxyPage(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    const cssLocator = page.locator(".target");
    const textLocator = page.getByText(/hello/i, { exact: true });
    const roleLocator = page.getByRole("button", { name: "Send" });

    expect(cssLocator).toBeInstanceOf(RoxyLocator);
    expect(textLocator).toBeInstanceOf(RoxyLocator);
    expect(roleLocator).toBeInstanceOf(RoxyLocator);
    expect(adapter.locator).toHaveBeenCalledWith({
      strategy: "css",
      value: ".target"
    });
    expect(adapter.getByText).toHaveBeenCalledWith(/hello/i, { exact: true });
    expect(adapter.getByRole).toHaveBeenCalledWith("button", { name: "Send" });
    expect(locatorAdapter).toBeTruthy();
  });

  it("routes selector-based actions through a locator instance", async () => {
    const adapter = createPageAdapterStub();
    const page = new RoxyPage(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const locator = page.locator(".action");

    const clickSpy = vi.spyOn(locator, "click");
    const hoverSpy = vi.spyOn(locator, "hover");
    const fillSpy = vi.spyOn(locator, "fill");
    const typeSpy = vi.spyOn(locator, "type");
    const pressSpy = vi.spyOn(locator, "press");
    const locatorSpy = vi.spyOn(page, "locator").mockReturnValue(locator);

    await page.click(".action", { delay: 5 });
    await page.hover(".action");
    await page.fill(".action", "abc");
    await page.type(".action", "def");
    await page.press(".action", "Enter");

    expect(locatorSpy).toHaveBeenCalledTimes(5);
    expect(clickSpy).toHaveBeenCalledWith({ delay: 5 });
    expect(hoverSpy).toHaveBeenCalledWith(undefined);
    expect(fillSpy).toHaveBeenCalledWith("abc", undefined);
    expect(typeSpy).toHaveBeenCalledWith("def", undefined);
    expect(pressSpy).toHaveBeenCalledWith("Enter", undefined);
  });
});

