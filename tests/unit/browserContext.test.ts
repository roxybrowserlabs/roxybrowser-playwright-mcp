import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoxyBrowserContext } from "../../src/browserContext.js";
import { RoxyPage } from "../../src/page.js";
import { RoxyWorker } from "../../src/worker.js";
import {
  createBrowserContextAdapterStub,
  createPageAdapterStub
} from "../helpers/fakes.js";

function createResponseWithSetCookies(
  body: string,
  cookies: string[]
): Response {
  const response = new Response(body, {
    status: 200,
    statusText: "OK"
  });
  Object.defineProperty(response.headers, "getSetCookie", {
    value: () => cookies
  });
  return response;
}

describe("RoxyBrowserContext", () => {
  it("tracks current service workers like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const worker1 = new RoxyWorker("https://example.test/sw.js");
    const worker2 = new RoxyWorker("https://other.test/sw.js");

    const eventPromise = context.waitForEvent("serviceworker");
    await adapter.emitServiceWorker(worker1);
    await adapter.emitServiceWorker(worker2);

    expect(await eventPromise).toBe(worker1);
    expect(context.serviceWorkers()).toEqual([worker1, worker2]);
  });

  it("auto-handles page dialogs when only context bubbling listeners are attached internally", async () => {
    const adapter = createBrowserContextAdapterStub();
    const pageAdapter = createPageAdapterStub();
    adapter.newPage = async () => pageAdapter;
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    await context.newPage();

    const dismiss = vi.fn(async () => {});
    pageAdapter.emit("dialog", {
      accept: vi.fn(async () => {}),
      defaultValue: () => "",
      dismiss,
      message: () => "hello",
      type: () => "alert"
    });

    await vi.waitFor(() => {
      expect(dismiss).toHaveBeenCalledTimes(1);
    });
  });

  it("does not auto-handle dialogs when the browser context has dialog listeners", async () => {
    const adapter = createBrowserContextAdapterStub();
    const pageAdapter = createPageAdapterStub();
    adapter.newPage = async () => pageAdapter;
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    const seen: string[] = [];
    context.on("dialog", (dialog) => {
      seen.push(dialog.message());
    });
    await context.newPage();

    const dismiss = vi.fn(async () => {});
    pageAdapter.emit("dialog", {
      accept: vi.fn(async () => {}),
      defaultValue: () => "",
      dismiss,
      message: () => "hello",
      type: () => "alert"
    });

    await vi.waitFor(() => {
      expect(seen).toEqual(["hello"]);
    });
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("creates roxy pages from the underlying adapter", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    const page = await context.newPage();

    expect(page).toBeInstanceOf(RoxyPage);
    expect(page.context()).toBe(context);
  });

  it("applies browser context init scripts to existing and future pages like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    const firstPageAdapter = createPageAdapterStub();
    const secondPageAdapter = createPageAdapterStub();
    adapter.newPage = vi
      .fn()
      .mockResolvedValueOnce(firstPageAdapter)
      .mockResolvedValueOnce(secondPageAdapter);
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    const firstPage = await context.newPage();
    const disposable = await context.addInitScript(() => {
      window["injected"] = 123;
    });
    const secondPage = await context.newPage();

    expect(firstPage).toBeInstanceOf(RoxyPage);
    expect(secondPage).toBeInstanceOf(RoxyPage);
    expect(adapter.addInitScript).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(adapter.addInitScript).mock.calls.some(([source]) => source.includes('window["injected"] = 123'))
    ).toBe(true);
    expect(
      vi.mocked(firstPageAdapter.addInitScript).mock.calls.some(([source]) => source.includes('window["injected"] = 123'))
    ).toBe(false);
    expect(
      vi.mocked(secondPageAdapter.addInitScript).mock.calls.some(([source]) => source.includes('window["injected"] = 123'))
    ).toBe(false);

    await disposable.dispose();

    const contextDisposable = await vi.mocked(adapter.addInitScript).mock.results[0]!.value;
    expect(contextDisposable.dispose).toHaveBeenCalledTimes(1);
  });

  it("registers browser context init script callback bindings before the user script", async () => {
    const adapter = createBrowserContextAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    const disposable = await context.addInitScript(({ cb }) => {
      void cb(42);
    }, { cb: (n: number) => n * 2 }, { exposeFunctions: true });

    expect(adapter.addInitScript).toHaveBeenCalledTimes(2);
    const [bindingScriptCall, userScriptCall] = vi.mocked(adapter.addInitScript).mock.calls;
    expect(bindingScriptCall?.[0]).toContain("installExposedBindingFunction");
    expect(bindingScriptCall?.[0]).toContain("__roxy_fn_");
    expect(userScriptCall?.[0]).toContain("__roxyParseEvaluationResultValue");
    expect(userScriptCall?.[0]).toContain("__roxy_fn_");

    await disposable.dispose();
    const bindingDisposable = await vi.mocked(adapter.addInitScript).mock.results[0]!.value;
    const userScriptDisposable = await vi.mocked(adapter.addInitScript).mock.results[1]!.value;
    expect(bindingDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(userScriptDisposable.dispose).toHaveBeenCalledTimes(1);
  });

  it("falls back to page-level browser context init scripts when the adapter does not support them", async () => {
    const adapter = createBrowserContextAdapterStub();
    delete adapter.addInitScript;
    const firstPageAdapter = createPageAdapterStub();
    const secondPageAdapter = createPageAdapterStub();
    adapter.newPage = vi
      .fn()
      .mockResolvedValueOnce(firstPageAdapter)
      .mockResolvedValueOnce(secondPageAdapter);
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    const firstPage = await context.newPage();
    const disposable = await context.addInitScript(() => {
      window["injected"] = 123;
    });
    const secondPage = await context.newPage();

    expect(firstPage).toBeInstanceOf(RoxyPage);
    expect(secondPage).toBeInstanceOf(RoxyPage);
    expect(
      vi.mocked(firstPageAdapter.addInitScript).mock.calls.some(([source]) => source.includes('window["injected"] = 123'))
    ).toBe(true);
    expect(
      vi.mocked(secondPageAdapter.addInitScript).mock.calls.some(([source]) => source.includes('window["injected"] = 123'))
    ).toBe(true);

    await disposable.dispose();

    expect(firstPageAdapter.initScriptDisposables.some((entry) => entry.dispose.mock.calls.length === 1)).toBe(true);
    expect(secondPageAdapter.initScriptDisposables.some((entry) => entry.dispose.mock.calls.length === 1)).toBe(true);
  });

  it("registers browser context init script callback bindings for page-level fallback", async () => {
    const adapter = createBrowserContextAdapterStub();
    delete adapter.addInitScript;
    const firstPageAdapter = createPageAdapterStub();
    adapter.newPage = vi.fn().mockResolvedValueOnce(firstPageAdapter);
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    await context.newPage();
    await context.addInitScript(({ cb }) => {
      void cb(42);
    }, { cb: (n: number) => n * 2 }, { exposeFunctions: true });

    const addInitScriptCalls = vi.mocked(firstPageAdapter.addInitScript).mock.calls;
    expect(addInitScriptCalls.length).toBeGreaterThanOrEqual(2);
    expect(addInitScriptCalls.some(([source]) => source.includes("__roxy_fn_"))).toBe(true);
    expect(addInitScriptCalls.some(([source]) => source.includes("__roxyParseEvaluationResultValue"))).toBe(true);
  });

  it("emits popup events for discovered pages and wires opener()", async () => {
    const adapter = createBrowserContextAdapterStub();
    const openerAdapter = createPageAdapterStub();
    const popupAdapter = createPageAdapterStub();
    adapter.newPage = async () => openerAdapter;
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    const opener = await context.newPage();
    const popupPromise = opener.waitForEvent("popup");

    await adapter.emitPage(popupAdapter, openerAdapter);

    const popup = await popupPromise;
    expect(popup).toBeInstanceOf(RoxyPage);
    expect(popup.context()).toBe(context);
    expect(await popup.opener()).toBe(opener);
  });

  it("emits page events for discovered pages like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    const openerAdapter = createPageAdapterStub();
    const popupAdapter = createPageAdapterStub();
    adapter.newPage = async () => openerAdapter;
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    await context.newPage();
    const popupPromise = context.waitForEvent("page");

    await adapter.emitPage(popupAdapter, openerAdapter);

    const popup = await popupPromise;
    expect(popup).toBeInstanceOf(RoxyPage);
    expect(popup.context()).toBe(context);
  });

  it("aborts browserContext.waitForEvent before registering the waiter like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const controller = new AbortController();
    const reason = new Error("Already aborted");
    controller.abort(reason);

    const errorPromise = context.waitForEvent("page", { signal: controller.signal }).catch((caught: Error) => caught);
    const error = await Promise.race([
      errorPromise,
      new Promise<Error>((resolve) => setTimeout(() => resolve(new Error("waitForEvent did not abort")), 25))
    ]);

    expect(error.name).toBe("AbortError");
    expect(error.cause).toBe(reason);
  });

  it("aborts browserContext.waitForEvent while waiting for an event like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const controller = new AbortController();
    const waitPromise = context
      .waitForEvent("page", { signal: controller.signal, timeout: 0 })
      .catch((caught: Error) => caught);

    const reason = new Error("cancelled");
    controller.abort(reason);
    const error = await Promise.race([
      waitPromise,
      new Promise<Error>((resolve) => setTimeout(() => resolve(new Error("waitForEvent did not abort")), 25))
    ]);

    expect(error.name).toBe("AbortError");
    expect(error.cause).toBe(reason);
  });

  it("removes closed adapter pages from pages like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    const pageAdapter = createPageAdapterStub();
    adapter.newPage = async () => pageAdapter;
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    const page = await context.newPage();
    pageAdapter.emit("close", undefined);

    await vi.waitFor(() => {
      expect(context.pages()).toEqual([]);
    });
    expect(page.isClosed()).toBe(true);
  });

  it("closes via the context adapter", async () => {
    const adapter = createBrowserContextAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    await context.close();

    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it("delegates extra http headers to the context adapter", async () => {
    const adapter = createBrowserContextAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    await context.setExtraHTTPHeaders({
      Foo: "Bar"
    });

    expect(adapter.setExtraHTTPHeaders).toHaveBeenCalledWith({
      Foo: "Bar"
    });
  });

  it("routes websockets through the browser context like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const page = await context.newPage();
    const seen: string[] = [];

    await context.routeWebSocket(/ws2/, (ws) => {
      ws.onMessage((message) => {
        seen.push(`context:${String(message)}`);
        ws.send("context-mock-2");
      });
    });

    const decision = await (page as any).dispatchWebSocketOpen({
      id: "websocket:context-route",
      url: "wss://example.com/ws2",
      protocols: []
    });
    await (page as any).dispatchWebSocketEvent({
      id: "websocket:context-route",
      kind: "message",
      message: "request"
    });

    expect(decision).toEqual({ action: "mock" });
    expect(seen).toEqual(["context:request"]);
  });

  it("falls back to browser-context request routes like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const page = await context.newPage();

    await context.route("**/empty.html", async (route) => {
      await route.fulfill({
        body: "context",
        contentType: "text/plain",
        status: 200
      });
    });
    await page.route("**/non-empty.html", async (route) => {
      await route.fulfill({
        body: "page",
        contentType: "text/plain",
        status: 200
      });
    });

    const decision = await (page as any).dispatchRoutedRequest({
      id: "request:context-fallback",
      url: "https://example.com/empty.html",
      method: "GET",
      headers: {},
      postData: null
    });

    expect(decision).toMatchObject({
      action: "fulfill",
      body: "context",
      status: 200,
      url: "https://example.com/empty.html"
    });
  });

  it("does not chain browser-context fulfill after fallback like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const page = await context.newPage();
    let failed = false;

    await context.route("**/empty.html", async () => {
      failed = true;
    });
    await context.route("**/empty.html", async (route) => {
      await route.fulfill({
        body: "fulfilled",
        contentType: "text/plain",
        status: 200
      });
    });
    await context.route("**/empty.html", async (route) => {
      await route.fallback();
    });

    const decision = await (page as any).dispatchRoutedRequest({
      id: "request:context-fallback-fulfill",
      url: "https://example.com/empty.html",
      method: "GET",
      headers: {},
      postData: null
    });

    expect(decision).toMatchObject({
      action: "fulfill",
      body: "fulfilled",
      status: 200,
      url: "https://example.com/empty.html"
    });
    expect(failed).toBe(false);
  });

  it("prefers page request routes over browser-context routes like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const page = await context.newPage();

    await context.route("**/empty.html", async (route) => {
      await route.fulfill({
        body: "context",
        contentType: "text/plain",
        status: 200
      });
    });
    await page.route("**/empty.html", async (route) => {
      await route.fulfill({
        body: "page",
        contentType: "text/plain",
        status: 200
      });
    });

    const decision = await (page as any).dispatchRoutedRequest({
      id: "request:page-over-context",
      url: "https://example.com/empty.html",
      method: "GET",
      headers: {},
      postData: null
    });

    expect(decision).toMatchObject({
      action: "fulfill",
      body: "page",
      status: 200,
      url: "https://example.com/empty.html"
    });
  });

  it("supports browser-context route disposal, unroute and times lifecycle like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const page = await context.newPage();
    const calls: string[] = [];

    const firstHandler = vi.fn(async (route: any) => {
      calls.push("first");
      await route.fallback();
    });
    const secondHandler = vi.fn(async (route: any) => {
      calls.push("second");
      await route.fallback();
    });

    const disposable = await context.route("**/empty.html", firstHandler, { times: 1 });
    await context.route(/empty\.html$/, secondHandler);

    await (page as any).dispatchRoutedRequest({
      id: "request:ctx-1",
      url: "https://example.com/empty.html",
      method: "GET",
      headers: {},
      postData: null
    });
    expect(calls).toEqual(["second", "first"]);

    calls.length = 0;
    await (page as any).dispatchRoutedRequest({
      id: "request:ctx-2",
      url: "https://example.com/empty.html",
      method: "GET",
      headers: {},
      postData: null
    });
    expect(calls).toEqual(["second"]);

    calls.length = 0;
    await context.unroute(/empty\.html$/, secondHandler);
    await disposable.dispose();
    await (page as any).dispatchRoutedRequest({
      id: "request:ctx-3",
      url: "https://example.com/empty.html",
      method: "GET",
      headers: {},
      postData: null
    });
    expect(calls).toEqual([]);
  });

  it("waits for pending browser-context route handlers during context.unrouteAll like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const page = await context.newPage();
    let secondHandlerCalled = false;

    await context.route(/.*/, async (route) => {
      secondHandlerCalled = true;
      await route.abort();
    });

    let routeCallback!: () => void;
    const routePromise = new Promise<void>((resolve) => {
      routeCallback = resolve;
    });
    let continueRouteCallback!: () => void;
    const routeBarrier = new Promise<void>((resolve) => {
      continueRouteCallback = resolve;
    });

    await context.route(/.*/, async (route) => {
      routeCallback();
      await routeBarrier;
      await route.fallback();
    });

    const dispatchPromise = (page as any).dispatchRoutedRequest({
      id: "request:context-unroute-wait",
      url: "https://example.com/empty.html",
      method: "GET",
      headers: {},
      postData: null
    });

    await routePromise;

    let didUnroute = false;
    const unroutePromise = context.unrouteAll({ behavior: "wait" }).then(() => {
      didUnroute = true;
    });

    await Promise.resolve();
    expect(didUnroute).toBe(false);

    continueRouteCallback();
    await unroutePromise;
    expect(didUnroute).toBe(true);
    expect(await dispatchPromise).toEqual({
      action: "continue",
      headers: {},
      method: "GET",
      postData: null,
      url: "https://example.com/empty.html"
    });
    expect(secondHandlerCalled).toBe(false);
  });

  it("prefers page websocket routes over context websocket routes like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const page = await context.newPage();
    const seen: string[] = [];

    await context.routeWebSocket(/ws1/, (ws) => {
      ws.onMessage((message) => {
        seen.push(`context:${String(message)}`);
        ws.send("context-mock");
      });
    });
    await page.routeWebSocket(/ws1/, (ws) => {
      ws.onMessage((message) => {
        seen.push(`page:${String(message)}`);
        ws.send("page-mock");
      });
    });

    const decision = await (page as any).dispatchWebSocketOpen({
      id: "websocket:page-over-context",
      url: "wss://example.com/ws1",
      protocols: []
    });
    await (page as any).dispatchWebSocketEvent({
      id: "websocket:page-over-context",
      kind: "message",
      message: "request"
    });

    expect(decision).toEqual({ action: "mock" });
    expect(seen).toEqual(["page:request"]);
  });

  it("keeps page websocket routes after page.unrouteAll like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const page = await context.newPage();
    const seen: string[] = [];

    await context.routeWebSocket(/ws1/, (ws) => {
      ws.onMessage((message) => {
        seen.push(`context:${String(message)}`);
        ws.send("context-mock");
      });
    });
    await page.routeWebSocket(/ws1/, (ws) => {
      ws.onMessage((message) => {
        seen.push(`page:${String(message)}`);
        ws.send("page-mock");
      });
    });

    await page.unrouteAll();

    const decision = await (page as any).dispatchWebSocketOpen({
      id: "websocket:page-still-routed-after-unroute-all",
      url: "wss://example.com/ws1",
      protocols: []
    });
    await (page as any).dispatchWebSocketEvent({
      id: "websocket:page-still-routed-after-unroute-all",
      kind: "message",
      message: "request"
    });

    expect(decision).toEqual({ action: "mock" });
    expect(seen).toEqual(["page:request"]);
  });

  it("keeps browser-context websocket routes after context.unrouteAll like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const page = await context.newPage();

    await context.routeWebSocket(/ws2/, (ws) => {
      ws.onMessage(() => {
        ws.send("context-mock");
      });
    });

    await context.unrouteAll({ behavior: "wait" });

    const decision = await (page as any).dispatchWebSocketOpen({
      id: "websocket:context-still-routed-after-unroute-all",
      url: "wss://example.com/ws2",
      protocols: []
    });

    expect(decision).toEqual({ action: "mock" });
  });

  it("validates extra http header values before delegating to the context adapter", async () => {
    const adapter = createBrowserContextAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    await expect(context.setExtraHTTPHeaders({ foo: null as never })).rejects.toThrow(
      'Expected value of header "foo" to be String, but "object" is found.'
    );
    expect(adapter.setExtraHTTPHeaders).not.toHaveBeenCalled();
  });

  it("exposes a shared Playwright-like request context on context and pages", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const page = await context.newPage();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"ok":true}', {
        headers: {
          "content-type": "application/json"
        },
        status: 200,
        statusText: "OK"
      })
    );

    try {
      expect(page.request).toBe(context.request);

      const response = await page.request.get("https://example.com/data", {
        params: {
          q: "1"
        }
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://example.com/data?q=1",
        expect.objectContaining({
          headers: {},
          method: "GET",
          redirect: "manual"
        })
      );
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("shares browser context cookies with page.request like Playwright", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    adapter.cookies = vi.fn(async (urls?: string[]) => {
      expect(urls).toEqual(["https://example.com/data"]);
      return [
        {
          domain: "example.com",
          expires: -1,
          httpOnly: false,
          name: "session",
          path: "/",
          sameSite: "Lax",
          secure: false,
          value: "from-browser"
        }
      ];
    });
    adapter.addCookies = vi.fn(async () => {});
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const page = await context.newPage();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createResponseWithSetCookies("{}", ["fresh=from-api; path=/"])
    );

    try {
      await page.request.get("https://example.com/data");

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://example.com/data",
        expect.objectContaining({
          headers: {
            cookie: "session=from-browser"
          }
        })
      );
      expect(adapter.addCookies).toHaveBeenCalledWith([
        expect.objectContaining({
          domain: "example.com",
          name: "fresh",
          path: "/",
          value: "from-api"
        })
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("inherits baseURL, extraHTTPHeaders, and userAgent for context request fetches", async () => {
    const adapter = createBrowserContextAdapterStub();
    const context = new RoxyBrowserContext(
      adapter,
      {
        enabled: true,
        profile: "balanced",
        moveJitterMs: 16,
        clickHoldMs: 60,
        scrollStepPx: 280,
        typingDelayMs: 95,
        typingVarianceMs: 35,
        hoverBeforeClickMs: 110
      },
      {
        baseURL: "https://example.com/base/",
        extraHTTPHeaders: {
          "X-Context": "yes"
        },
        userAgent: "RoxyTest/1.0"
      }
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        statusText: "OK"
      })
    );

    try {
      await context.request.get("data.json", {
        headers: {
          "X-Request": "override"
        }
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://example.com/base/data.json",
        expect.objectContaining({
          headers: {
            "user-agent": "RoxyTest/1.0",
            "x-context": "yes",
            "x-request": "override"
          }
        })
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("aborts APIRequestContext fetches with a Playwright-style AbortSignal", async () => {
    const adapter = createBrowserContextAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    let fetchSignal: AbortSignal | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      fetchSignal = init?.signal as AbortSignal | undefined;
      if (fetchSignal?.aborted) {
        throw fetchSignal.reason;
      }
      await new Promise((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => reject(fetchSignal?.reason), { once: true });
      });
      throw new Error("unreachable");
    });
    const controller = new AbortController();

    try {
      const errorPromise = context.request
        .get("https://example.com/slow", {
          signal: controller.signal,
          timeout: 0
        })
        .catch((error: Error) => error);

      await Promise.resolve();
      controller.abort("cancelled");
      const error = await Promise.race([
        errorPromise,
        new Promise<Error>((resolve) => setTimeout(() => resolve(new Error("request did not abort")), 25))
      ]);

      expect(error.name).toBe("AbortError");
      expect(fetchSignal?.aborted).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("aborts browser-context route.fetch with a Playwright-style AbortSignal", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const page = await context.newPage();
    let fetchSignal: AbortSignal | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      fetchSignal = init?.signal as AbortSignal | undefined;
      if (fetchSignal?.aborted) {
        throw fetchSignal.reason;
      }
      await new Promise((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => reject(fetchSignal?.reason), { once: true });
      });
      throw new Error("unreachable");
    });
    const controller = new AbortController();

    try {
      await context.route("**/slow", async (route) => {
        const errorPromise = route
          .fetch({
            signal: controller.signal,
            timeout: 0
          })
          .catch((error: Error) => error);
        await Promise.resolve();
        controller.abort("cancelled");
        const error = await errorPromise;
        expect(error.name).toBe("AbortError");
        expect(fetchSignal?.aborted).toBe(true);
        await route.abort();
      });

      await (page as any).dispatchRoutedRequest({
        id: "request:context-route-fetch-abort",
        url: "https://example.com/slow",
        method: "GET",
        headers: {},
        postData: null
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses updated context extraHTTPHeaders for later context request fetches", async () => {
    const adapter = createBrowserContextAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        statusText: "OK"
      })
    );

    try {
      await context.setExtraHTTPHeaders({
        "X-Context": "updated"
      });
      await context.request.get("https://example.com/data.json");

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://example.com/data.json",
        expect.objectContaining({
          headers: {
            "x-context": "updated"
          }
        })
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("exposes a shared Playwright-like clock on context and pages", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    const page = await context.newPage();

    expect(page.clock).toBe(context.clock);
  });

  it("starts and finalizes recordVideo for new pages", async () => {
    const adapter = createBrowserContextAdapterStub();
    const pageAdapter = createPageAdapterStub();
    adapter.newPage = async () => pageAdapter;
    const directory = await mkdtemp(join(tmpdir(), "roxy-context-video-"));
    const ffmpegPath = await createFakeFfmpeg(directory);
    const previousFfmpegPath = process.env.ROXY_FFMPEG_PATH;
    process.env.ROXY_FFMPEG_PATH = ffmpegPath;
    const context = new RoxyBrowserContext(
      adapter,
      {
        enabled: true,
        profile: "balanced",
        moveJitterMs: 16,
        clickHoldMs: 60,
        scrollStepPx: 280,
        typingDelayMs: 95,
        typingVarianceMs: 35,
        hoverBeforeClickMs: 110
      },
      {
        recordVideo: {
          dir: directory,
          size: {
            width: 320,
            height: 240
          },
          showActions: {
            duration: 400
          }
        }
      }
    );

    try {
      const page = await context.newPage();
      const video = page.video();
      expect(video).not.toBeNull();
      const videoPath = await video!.path();

      expect(pageAdapter.screencastStart).toHaveBeenCalledWith({
        sendFrames: true,
        size: {
          width: 320,
          height: 240
        }
      });
      expect(pageAdapter.screencastShowActions).toHaveBeenCalledWith({
        duration: 400
      });

      pageAdapter.emit("screencastFrame", {
        data: Buffer.from("frame-1"),
        timestamp: 100,
        viewportWidth: 1280,
        viewportHeight: 720
      });

      await page.close();

      expect(pageAdapter.screencastHideActions).toHaveBeenCalledTimes(1);
      expect(pageAdapter.screencastStop).toHaveBeenCalledTimes(1);
      expect((await stat(videoPath)).size).toBeGreaterThan(0);
    } finally {
      if (previousFfmpegPath === undefined) {
        delete process.env.ROXY_FFMPEG_PATH;
      } else {
        process.env.ROXY_FFMPEG_PATH = previousFfmpegPath;
      }
    }
  });

  it("derives 800x450 default video size when viewport is not configured", async () => {
    const adapter = createBrowserContextAdapterStub();
    const pageAdapter = createPageAdapterStub();
    adapter.newPage = async () => pageAdapter;
    const directory = await mkdtemp(join(tmpdir(), "roxy-context-video-"));
    const ffmpegPath = await createFakeFfmpeg(directory);
    const previousFfmpegPath = process.env.ROXY_FFMPEG_PATH;
    process.env.ROXY_FFMPEG_PATH = ffmpegPath;
    const context = new RoxyBrowserContext(
      adapter,
      {
        enabled: true,
        profile: "balanced",
        moveJitterMs: 16,
        clickHoldMs: 60,
        scrollStepPx: 280,
        typingDelayMs: 95,
        typingVarianceMs: 35,
        hoverBeforeClickMs: 110
      },
      {
        recordVideo: {}
      }
    );

    try {
      const page = await context.newPage();
      expect(page.video()).not.toBeNull();
      expect(pageAdapter.screencastStart).toHaveBeenCalledWith({
        sendFrames: true,
        size: {
          width: 800,
          height: 450
        }
      });
      await page.close();
    } finally {
      if (previousFfmpegPath === undefined) {
        delete process.env.ROXY_FFMPEG_PATH;
      } else {
        process.env.ROXY_FFMPEG_PATH = previousFfmpegPath;
      }
    }
  });

  it("derives 800x600 default video size when viewport is explicitly null", async () => {
    const adapter = createBrowserContextAdapterStub();
    const pageAdapter = createPageAdapterStub();
    adapter.newPage = async () => pageAdapter;
    const directory = await mkdtemp(join(tmpdir(), "roxy-context-video-"));
    const ffmpegPath = await createFakeFfmpeg(directory);
    const previousFfmpegPath = process.env.ROXY_FFMPEG_PATH;
    process.env.ROXY_FFMPEG_PATH = ffmpegPath;
    const context = new RoxyBrowserContext(
      adapter,
      {
        enabled: true,
        profile: "balanced",
        moveJitterMs: 16,
        clickHoldMs: 60,
        scrollStepPx: 280,
        typingDelayMs: 95,
        typingVarianceMs: 35,
        hoverBeforeClickMs: 110
      },
      {
        viewport: null,
        recordVideo: {}
      }
    );

    try {
      const page = await context.newPage();
      expect(pageAdapter.screencastStart).toHaveBeenCalledWith({
        sendFrames: true,
        size: {
          width: 800,
          height: 600
        }
      });
      await page.close();
    } finally {
      if (previousFfmpegPath === undefined) {
        delete process.env.ROXY_FFMPEG_PATH;
      } else {
        process.env.ROXY_FFMPEG_PATH = previousFfmpegPath;
      }
    }
  });

  it("scales configured viewport down to fit within 800x800 by default", async () => {
    const adapter = createBrowserContextAdapterStub();
    const pageAdapter = createPageAdapterStub();
    adapter.newPage = async () => pageAdapter;
    const directory = await mkdtemp(join(tmpdir(), "roxy-context-video-"));
    const ffmpegPath = await createFakeFfmpeg(directory);
    const previousFfmpegPath = process.env.ROXY_FFMPEG_PATH;
    process.env.ROXY_FFMPEG_PATH = ffmpegPath;
    const context = new RoxyBrowserContext(
      adapter,
      {
        enabled: true,
        profile: "balanced",
        moveJitterMs: 16,
        clickHoldMs: 60,
        scrollStepPx: 280,
        typingDelayMs: 95,
        typingVarianceMs: 35,
        hoverBeforeClickMs: 110
      },
      {
        viewport: {
          width: 1600,
          height: 1200
        },
        recordVideo: {}
      }
    );

    try {
      const page = await context.newPage();
      expect(pageAdapter.screencastStart).toHaveBeenCalledWith({
        sendFrames: true,
        size: {
          width: 800,
          height: 600
        }
      });
      await page.close();
    } finally {
      if (previousFfmpegPath === undefined) {
        delete process.env.ROXY_FFMPEG_PATH;
      } else {
        process.env.ROXY_FFMPEG_PATH = previousFfmpegPath;
      }
    }
  });

  it("proxies storageState through the shared request context", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const page = await context.newPage();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(createResponseWithSetCookies("ok", ["a=b", "c=d"]));

    try {
      await context.request.get("https://example.com/setcookie.html");
      const contextState = await context.storageState();
      expect(contextState.cookies).toHaveLength(2);
      expect(await context.request.storageState()).toEqual(contextState);
      expect(await page.request.storageState()).toEqual(contextState);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

async function createFakeFfmpeg(directory: string): Promise<string> {
  const isWindows = process.platform === "win32";
  const ffmpegPath = join(directory, isWindows ? "fake-ffmpeg.cmd" : "fake-ffmpeg.sh");
  await writeFile(ffmpegPath, isWindows
    ? "@echo off\r\nset out=\r\n:loop\r\nif \"%~1\"==\"\" goto done\r\nset out=%~1\r\nshift\r\ngoto loop\r\n:done\r\nnode -e \"const fs=require('fs'); process.stdin.pipe(fs.createWriteStream(process.argv[1]));\" \"%out%\"\r\n"
    : "#!/bin/sh\nout=\"\"\nfor arg in \"$@\"; do out=\"$arg\"; done\ncat > \"$out\"\n"
  );
  await chmod(ffmpegPath, 0o755);
  return ffmpegPath;
}
