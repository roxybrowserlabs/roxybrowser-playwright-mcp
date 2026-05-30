import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoxyElementHandle } from "../../src/elementHandle.js";
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

    expect((await page.goto("https://example.com", { waitUntil: "domcontentloaded" }))?.url).toBe(
      "https://example.com"
    );
    expect(await page.url()).toBe("https://example.com");
    expect((await page.goBack())?.url()).toBe("https://example.com/back");
    expect((await page.goForward())?.url()).toBe("https://example.com/forward");
    expect((await page.reload())?.url).toBe("https://example.com/reload");
    expect(await page.title()).toBe("Example title");
    expect(await page.content()).toBe("<html></html>");
    await page.setContent("<div>ok</div>");
    expect(await page.evaluate<{ ok: boolean }>("() => ({ ok: true })")).toEqual({ ok: true });
    await page.waitForLoadState("load");
    expect(await page.ariaSnapshot({ mode: "ai", depth: 2 })).toBe('- document\n  - button "Example"');
    expect(await page.resolveAriaRef("e1")).toEqual({
      ref: "e1",
      selector: "#example",
      xpath: '//*[@id="example"]',
      querySelector: 'document.querySelector("#example")',
      querySelectorChain: 'document.querySelector("#example")',
      framePath: [],
      inShadowTree: false
    });
    expect(await page.screenshot({ type: "png" })).toEqual(Buffer.from("fake-screenshot"));
    await page.close();

    expect(adapter.goto).toHaveBeenCalledWith("https://example.com", {
      waitUntil: "domcontentloaded"
    });
    expect(adapter.url).toHaveBeenCalledTimes(1);
    expect(adapter.goBack).toHaveBeenCalledWith(undefined);
    expect(adapter.goForward).toHaveBeenCalledWith(undefined);
    expect(adapter.reload).toHaveBeenCalledWith(undefined);
    expect(adapter.setContent).toHaveBeenCalledWith("<div>ok</div>");
    expect(adapter.waitForLoadState).toHaveBeenCalledWith("load");
    expect(adapter.ariaSnapshot).toHaveBeenCalledWith({ mode: "ai", depth: 2 });
    expect(adapter.resolveAriaRef).toHaveBeenCalledWith("e1");
    expect(adapter.screenshot).toHaveBeenCalledWith({ type: "png" });
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it("writes screenshot data to disk when a path is provided", async () => {
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
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-test-"));
    const outputPath = join(directory, "page.jpg");

    const screenshot = await page.screenshot({ path: outputPath });

    expect(adapter.screenshot).toHaveBeenCalledWith({
      path: outputPath,
      type: "jpeg"
    });
    expect(screenshot).toEqual(Buffer.from("fake-screenshot"));
    expect(await readFile(outputPath)).toEqual(Buffer.from("fake-screenshot"));
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

  it("waitForSelector parses chained selectors and returns an element handle", async () => {
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

    const handle = await page.waitForSelector("div >> text=Hello", {
      state: "attached",
      timeout: 100
    });

    expect(handle).toBeInstanceOf(RoxyElementHandle);
    expect(adapter.query).toHaveBeenCalledWith([
      {
        strategy: "css",
        value: "div"
      },
      {
        strategy: "text",
        value: "Hello"
      }
    ]);
  });

  it("proxies page query and eval helpers to the page adapter", async () => {
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

    const handle = await page.$("div");
    const handles = await page.$$("div");
    const value = await page.$eval("div", (element, suffix: string) => {
      return `${String(element)}${suffix}`;
    }, "!");
    const values = await page.$$eval("div", (elements, suffix: string) => {
      return elements.map((element) => `${String(element)}${suffix}`);
    }, "!");

    expect(handle).toBeInstanceOf(RoxyElementHandle);
    expect(handles[0]).toBeInstanceOf(RoxyElementHandle);
    expect(value).toBe("page-selector-value");
    expect(values).toEqual(["page-selector-value"]);
    expect(adapter.query).toHaveBeenCalledWith([
      {
        strategy: "css",
        value: "div"
      }
    ]);
    expect(adapter.queryAll).toHaveBeenCalledWith([
      {
        strategy: "css",
        value: "div"
      }
    ]);
    expect(adapter.evalOnSelector).toHaveBeenCalledWith([
      {
        strategy: "css",
        value: "div"
      }
    ], expect.stringContaining("suffix"), "!");
    expect(adapter.evalOnSelectorAll).toHaveBeenCalledWith([
      {
        strategy: "css",
        value: "div"
      }
    ], expect.stringContaining("suffix"), "!");
  });

  it("wraps element handle subtree methods", async () => {
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

    const handle = (await page.$("div"))!;
    const child = await handle.$("span");
    const children = await handle.$$("span");
    const value = await handle.$eval("span", (element, suffix: string) => {
      return `${String(element)}${suffix}`;
    }, "!");
    const values = await handle.$$eval("span", (elements, suffix: string) => {
      return elements.map((element) => `${String(element)}${suffix}`);
    }, "!");
    const self = await handle.evaluate((element, suffix: string) => {
      return `${String(element)}${suffix}`;
    }, "!");

    expect(child).toBeInstanceOf(RoxyElementHandle);
    expect(children[0]).toBeInstanceOf(RoxyElementHandle);
    expect(value).toBe("selector-value");
    expect(values).toEqual(["selector-value"]);
    expect(self).toBe("handle-value");

    const queryHandle = await vi.mocked(adapter.query).mock.results[0]?.value;
    expect(queryHandle?.query).toHaveBeenCalledWith([
      {
        strategy: "css",
        value: "span"
      }
    ]);
    expect(queryHandle?.queryAll).toHaveBeenCalledWith([
      {
        strategy: "css",
        value: "span"
      }
    ]);
    expect(queryHandle?.evalOnSelector).toHaveBeenCalledWith([
      {
        strategy: "css",
        value: "span"
      }
    ], expect.stringContaining("suffix"), "!");
    expect(queryHandle?.evalOnSelectorAll).toHaveBeenCalledWith([
      {
        strategy: "css",
        value: "span"
      }
    ], expect.any(String), "!");
  });

  it("subscribes, unsubscribes, and deduplicates adapter listeners for page events", () => {
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
    const logRequest = vi.fn();
    const secondRequestListener = vi.fn();
    const onLoad = vi.fn();

    page.on("request", logRequest);
    page.on("request", secondRequestListener);
    page.once("load", onLoad);

    expect(adapter.on).toHaveBeenCalledTimes(2);
    expect(adapter.on).toHaveBeenNthCalledWith(1, "request", expect.any(Function));
    expect(adapter.on).toHaveBeenNthCalledWith(2, "load", expect.any(Function));

    adapter.emit("request", {
      headers: [{ name: "accept", value: "*/*" }],
      method: "GET",
      url: "https://example.com/data"
    });
    adapter.emit("load", undefined);
    adapter.emit("load", undefined);

    expect(logRequest).toHaveBeenCalledWith({
      headers: [{ name: "accept", value: "*/*" }],
      method: "GET",
      url: "https://example.com/data"
    });
    expect(secondRequestListener).toHaveBeenCalledTimes(1);
    expect(onLoad).toHaveBeenCalledTimes(1);

    page.removeListener("request", logRequest);
    adapter.emit("request", {
      headers: [],
      method: "POST",
      url: "https://example.com/submit"
    });

    expect(logRequest).toHaveBeenCalledTimes(1);
    expect(secondRequestListener).toHaveBeenCalledWith({
      headers: [],
      method: "POST",
      url: "https://example.com/submit"
    });

    page.removeListener("request", secondRequestListener);
    adapter.emit("request", {
      headers: [],
      method: "DELETE",
      url: "https://example.com/delete"
    });

    expect(secondRequestListener).toHaveBeenCalledTimes(2);
  });

  it("waits for console events and applies the predicate", async () => {
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

    const waited = page.waitForEvent("console", (message) => message.text() === "match");

    adapter.emit("console", {
      text: () => "skip",
      type: () => "log"
    });
    adapter.emit("console", {
      text: () => "match",
      type: () => "log"
    });

    const message = await waited;
    expect(message.text()).toBe("match");
    expect(message.type()).toBe("log");
  });
});
