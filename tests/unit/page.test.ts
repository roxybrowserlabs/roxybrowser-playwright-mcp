import util from "node:util";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoxyElementHandle } from "../../src/elementHandle.js";
import { TimeoutError } from "../../src/errors.js";
import { RoxyFrameLocator } from "../../src/locator.js";
import { RoxyJSHandle } from "../../src/jsHandle.js";
import { RoxyLocator } from "../../src/locator.js";
import { RoxyPage } from "../../src/page.js";
import { RoxyVideo } from "../../src/video.js";
import { RoxyWorker } from "../../src/worker.js";
import type { Download, Request } from "../../src/types/api.js";
import { createElementHandleAdapterStub, createPageAdapterStub } from "../helpers/fakes.js";

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

    expect((await page.goto("https://example.com", { waitUntil: "domcontentloaded" }))?.url()).toBe(
      "https://example.com"
    );
    expect(await page.url()).toBe("https://example.com");
    expect((await page.goBack())?.url()).toBe("https://example.com/back");
    expect((await page.goForward())?.url()).toBe("https://example.com/forward");
    expect((await page.reload())?.url()).toBe("https://example.com/reload");
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
      timeout: 30000,
      waitUntil: "domcontentloaded"
    });
    expect(adapter.url).toHaveBeenCalled();
    expect(adapter.goBack).toHaveBeenCalledWith({ timeout: 30000 });
    expect(adapter.goForward).toHaveBeenCalledWith({ timeout: 30000 });
    expect(adapter.reload).toHaveBeenCalledWith({ timeout: 30000 });
    expect(adapter.setContent).toHaveBeenCalledWith("<div>ok</div>", { timeout: 30000 });
    expect(adapter.waitForLoadState).toHaveBeenCalledWith("load", 30000);
    expect(adapter.ariaSnapshot).toHaveBeenCalledWith({ mode: "ai", depth: 2 });
    expect(adapter.resolveAriaRef).toHaveBeenCalledWith("e1");
    expect(adapter.screenshot).toHaveBeenCalledWith({
      __fitsViewport: true,
      clip: { height: 720, width: 1280, x: 0, y: 0 },
      type: "png"
    });
    expect(adapter.close).toHaveBeenCalledWith({});
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
      __fitsViewport: true,
      clip: {
        height: 720,
        width: 1280,
        x: 0,
        y: 0
      },
      path: outputPath,
      type: "jpeg"
    });
    expect(screenshot).toEqual(Buffer.from("fake-screenshot"));
    expect(await readFile(outputPath)).toEqual(Buffer.from("fake-screenshot"));
  });

  it("creates screenshot output subdirectories", async () => {
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
    const outputPath = join(directory, "these", "are", "directories", "screenshot.png");

    const screenshot = await page.screenshot({ path: outputPath });

    expect(adapter.screenshot).toHaveBeenCalledWith({
      __fitsViewport: true,
      clip: {
        height: 720,
        width: 1280,
        x: 0,
        y: 0
      },
      path: outputPath,
      type: "png"
    });
    expect(screenshot).toEqual(Buffer.from("fake-screenshot"));
    expect(await readFile(outputPath)).toEqual(Buffer.from("fake-screenshot"));
  });

  it("throws for unsupported screenshot path mime type", async () => {
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

    const error = await page.screenshot({ path: "file.txt" }).catch((caught: Error) => caught);

    expect(error.message).toContain('path: unsupported mime type "text/plain"');
    expect(adapter.screenshot).not.toHaveBeenCalled();
  });

  it("throws when png screenshot uses quality", async () => {
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

    const error = await page.screenshot({ quality: 10 }).catch((caught: Error) => caught);

    expect(error.message).toContain("options.quality is unsupported for the png");
    expect(adapter.screenshot).not.toHaveBeenCalled();
  });

  it("sets and restores transparent screenshot background for png omitBackground", async () => {
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

    await page.screenshot({ omitBackground: true });

    expect(adapter.setScreenshotBackgroundColor).toHaveBeenNthCalledWith(1, {
      r: 0,
      g: 0,
      b: 0,
      a: 0
    });
    expect(adapter.screenshot).toHaveBeenCalled();
    expect(adapter.setScreenshotBackgroundColor).toHaveBeenNthCalledWith(2);
  });

  it("does not set transparent screenshot background for jpeg omitBackground", async () => {
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

    await page.screenshot({ omitBackground: true, type: "jpeg" });

    expect(adapter.setScreenshotBackgroundColor).not.toHaveBeenCalled();
  });

  it("delegates pdf generation to the adapter and writes the buffer to disk", async () => {
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
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-pdf-"));
    const outputPath = join(directory, "nested", "page.pdf");

    const pdf = await page.pdf({
      format: "A4",
      outline: true,
      path: outputPath,
      tagged: true
    });

    expect(adapter.pdf).toHaveBeenCalledWith({
      format: "A4",
      outline: true,
      path: outputPath,
      tagged: true
    });
    expect(pdf).toEqual(Buffer.from("%PDF-fake"));
    expect(await readFile(outputPath)).toEqual(Buffer.from("%PDF-fake"));
  });

  it("delegates extra http headers to the adapter", async () => {
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

    await page.setExtraHTTPHeaders({
      Foo: "Bar"
    });

    expect(adapter.setExtraHTTPHeaders).toHaveBeenCalledWith({
      Foo: "Bar"
    });
  });

  it("validates extra http header values before delegating", async () => {
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

    await expect(page.setExtraHTTPHeaders({ foo: null as never })).rejects.toThrow(
      'Expected value of header "foo" to be String, but "object" is found.'
    );
    expect(adapter.setExtraHTTPHeaders).not.toHaveBeenCalled();
  });

  it("restores page timeouts after pause resumes", async () => {
    const adapter = createPageAdapterStub();
    let sawInstall = false;
    adapter.evaluate = vi.fn(async <TResult>(expression: string) => {
      if (expression.includes("isPauseControllerResumed")) {
        return sawInstall as TResult;
      }
      sawInstall = true;
      return undefined as TResult;
    });
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
    page.setDefaultNavigationTimeout(456);
    page.setDefaultTimeout(123);

    await page.pause();

    expect(page.defaultTimeout()).toBe(123);
    expect((page as unknown as { defaultNavigationTimeoutMs: number }).defaultNavigationTimeoutMs).toBe(
      456
    );
  });

  it("provides Playwright-style page storage helpers", async () => {
    const adapter = createPageAdapterStub();
    const state = {
      localStorage: new Map<string, string>(),
      sessionStorage: new Map<string, string>()
    };
    adapter.evaluate = vi.fn(async <TResult>(
      expression: string,
      arg?: {
        name?: string;
        storageName?: "localStorage" | "sessionStorage";
        value?: string;
      }
    ) => {
      const storage = state[arg?.storageName ?? "localStorage"];
      if (expression.includes(".clear()")) {
        storage.clear();
        return undefined as TResult;
      }
      if (expression.includes(".setItem(")) {
        storage.set(arg?.name ?? "", arg?.value ?? "");
        return undefined as TResult;
      }
      if (expression.includes(".removeItem(")) {
        storage.delete(arg?.name ?? "");
        return undefined as TResult;
      }
      if (expression.includes("entries.push")) {
        return Array.from(storage.entries()).map(([name, value]) => ({ name, value })) as TResult;
      }
      if (expression.includes(".getItem(")) {
        return (storage.get(arg?.name ?? "") ?? null) as TResult;
      }
      throw new Error(`Unexpected storage expression: ${expression}`);
    });
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

    await page.localStorage.setItem("token", "abc");
    await page.sessionStorage.setItem("flag", "1");

    expect(await page.localStorage.getItem("token")).toBe("abc");
    expect(await page.sessionStorage.getItem("flag")).toBe("1");
    expect(await page.localStorage.items()).toEqual([{ name: "token", value: "abc" }]);
    expect(await page.sessionStorage.items()).toEqual([{ name: "flag", value: "1" }]);

    await page.localStorage.removeItem("token");
    await page.sessionStorage.clear();

    expect(await page.localStorage.getItem("token")).toBeNull();
    expect(await page.sessionStorage.items()).toEqual([]);
  });

  it("matches Playwright localStorage/sessionStorage overwrite and independence semantics", async () => {
    const adapter = createPageAdapterStub();
    const state = {
      localStorage: new Map<string, string>(),
      sessionStorage: new Map<string, string>()
    };
    adapter.evaluate = vi.fn(async <TResult>(
      expression: string,
      arg?: {
        name?: string;
        storageName?: "localStorage" | "sessionStorage";
        value?: string;
      }
    ) => {
      const storage = state[arg?.storageName ?? "localStorage"];
      if (expression.includes(".clear()")) {
        storage.clear();
        return undefined as TResult;
      }
      if (expression.includes(".setItem(")) {
        storage.set(arg?.name ?? "", arg?.value ?? "");
        return undefined as TResult;
      }
      if (expression.includes(".removeItem(")) {
        storage.delete(arg?.name ?? "");
        return undefined as TResult;
      }
      if (expression.includes("entries.push")) {
        return Array.from(storage.entries()).map(([name, value]) => ({ name, value })) as TResult;
      }
      if (expression.includes(".getItem(")) {
        return (storage.get(arg?.name ?? "") ?? null) as TResult;
      }
      throw new Error(`Unexpected storage expression: ${expression}`);
    });
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

    await page.localStorage.setItem("shared", "first");
    await page.localStorage.setItem("shared", "second");
    await page.sessionStorage.setItem("shared", "session");

    expect(await page.localStorage.getItem("shared")).toBe("second");
    expect(await page.sessionStorage.getItem("shared")).toBe("session");

    await page.localStorage.clear();

    expect(await page.localStorage.items()).toEqual([]);
    expect(await page.sessionStorage.items()).toEqual([{ name: "shared", value: "session" }]);
  });

  it("exposes page-level keyboard, mouse and touchscreen objects", async () => {
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

    await page.keyboard.down("Shift");
    await page.keyboard.insertText("hello");
    await page.keyboard.press("Enter", { delay: 7 });
    await page.keyboard.type("world", { delay: 9 });
    await page.keyboard.up("Shift");
    await page.mouse.move(10, 20, { steps: 3 });
    await page.mouse.down({ button: "right", clickCount: 2 });
    await page.mouse.up({ button: "right", clickCount: 2 });
    await page.mouse.click(11, 21, { delay: 5 });
    await page.mouse.dblclick(12, 22, { button: "middle", delay: 6 });
    await page.mouse.wheel(30, 40);
    await page.touchscreen.tap(13, 23);

    expect(adapter.keyboardDown).toHaveBeenCalledWith("Shift");
    expect(adapter.keyboardInsertText).toHaveBeenCalledWith("hello");
    expect(adapter.keyboardPress).toHaveBeenCalledWith("Enter", { delay: 7 });
    expect(adapter.keyboardType).toHaveBeenCalledWith("world", { delay: 9 });
    expect(adapter.keyboardUp).toHaveBeenCalledWith("Shift");
    expect(adapter.mouseMove).toHaveBeenCalledWith(10, 20, { steps: 3 });
    expect(adapter.mouseDown).toHaveBeenCalledWith({ button: "right", clickCount: 2 });
    expect(adapter.mouseUp).toHaveBeenCalledWith({ button: "right", clickCount: 2 });
    expect(adapter.mouseClick).toHaveBeenCalledWith(11, 21, { delay: 5 });
    expect(adapter.mouseDblclick).toHaveBeenCalledWith(12, 22, {
      button: "middle",
      delay: 6
    });
    expect(adapter.mouseWheel).toHaveBeenCalledWith(30, 40);
    expect(adapter.touchscreenTap).toHaveBeenCalledWith(13, 23);
  });

  it("proxies Playwright-style coverage helpers to the page adapter", async () => {
    const adapter = createPageAdapterStub();
    adapter.stopJSCoverage = vi.fn(async () => [
      {
        url: "https://example.com/app.js",
        scriptId: "script-1",
        source: "console.log('ok')",
        functions: [
          {
            functionName: "run",
            isBlockCoverage: true,
            ranges: [{ startOffset: 0, endOffset: 17, count: 1 }]
          }
        ]
      }
    ]);
    adapter.stopCSSCoverage = vi.fn(async () => [
      {
        url: "https://example.com/app.css",
        text: "body { color: red; }",
        ranges: [{ start: 0, end: 20 }]
      }
    ]);
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

    await page.coverage.startJSCoverage({
      reportAnonymousScripts: true,
      resetOnNavigation: false
    });
    await page.coverage.startCSSCoverage({
      resetOnNavigation: false
    });

    expect(await page.coverage.stopJSCoverage()).toEqual([
      {
        url: "https://example.com/app.js",
        scriptId: "script-1",
        source: "console.log('ok')",
        functions: [
          {
            functionName: "run",
            isBlockCoverage: true,
            ranges: [{ startOffset: 0, endOffset: 17, count: 1 }]
          }
        ]
      }
    ]);
    expect(await page.coverage.stopCSSCoverage()).toEqual([
      {
        url: "https://example.com/app.css",
        text: "body { color: red; }",
        ranges: [{ start: 0, end: 20 }]
      }
    ]);

    expect(adapter.startJSCoverage).toHaveBeenCalledWith({
      reportAnonymousScripts: true,
      resetOnNavigation: false
    });
    expect(adapter.startCSSCoverage).toHaveBeenCalledWith({
      resetOnNavigation: false
    });
    expect(adapter.stopJSCoverage).toHaveBeenCalledWith();
    expect(adapter.stopCSSCoverage).toHaveBeenCalledWith();
  });

  it("matches Playwright-style screencast lifecycle helpers", async () => {
    const adapter = createPageAdapterStub();
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-screencast-"));
    const videoPath = join(directory, "video.webm");
    const ffmpegPath = await createFakeFfmpeg(directory);
    const previousFfmpegPath = process.env.ROXY_FFMPEG_PATH;
    process.env.ROXY_FFMPEG_PATH = ffmpegPath;
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
    const seenFrames: Array<{
      data: Buffer;
      timestamp: number;
      viewportWidth: number;
      viewportHeight: number;
    }> = [];
    try {
      const recording = await page.screencast.start({
        path: videoPath,
        quality: 75,
        size: {
          width: 640,
          height: 480
        },
        annotate: {
          duration: 900,
          position: "bottom-right",
          fontSize: 28
        },
        onFrame: (frame) => {
          seenFrames.push(frame);
        }
      });

      await expect(page.screencast.start()).rejects.toThrow("Screencast is already started");
      expect(adapter.screencastStart).toHaveBeenCalledWith({
        size: {
          width: 640,
          height: 480
        },
        quality: 75,
        sendFrames: true,
        annotate: {
          duration: 900,
          position: "bottom-right",
          fontSize: 28
        }
      });

      adapter.emit("screencastFrame", {
        data: Buffer.from("frame-1"),
        timestamp: 100,
        viewportWidth: 1280,
        viewportHeight: 720
      });
      expect(seenFrames).toEqual([
        {
          data: Buffer.from("frame-1"),
          timestamp: 100,
          viewportWidth: 1280,
          viewportHeight: 720
        }
      ]);

      await recording.dispose();
      expect(adapter.screencastStop).toHaveBeenCalledTimes(1);
      expect((await stat(videoPath)).size).toBeGreaterThan(0);
      expect((await readFile(videoPath)).subarray(0, "frame-1".length)).toEqual(Buffer.from("frame-1"));

      adapter.emit("screencastFrame", {
        data: Buffer.from("frame-2"),
        timestamp: 200,
        viewportWidth: 1280,
        viewportHeight: 720
      });
      expect(seenFrames).toHaveLength(1);

      await page.screencast.stop();
      expect(adapter.screencastStop).toHaveBeenCalledTimes(1);

      const actions = await page.screencast.showActions({
        cursor: "none",
        duration: 1000,
        fontSize: 24,
        position: "top-left"
      });
      expect(adapter.screencastShowActions).toHaveBeenCalledWith({
        cursor: "none",
        duration: 1000,
        fontSize: 24,
        position: "top-left"
      });
      await actions.dispose();
      expect(adapter.screencastHideActions).toHaveBeenCalledTimes(1);

      const overlay = await page.screencast.showOverlay("<div>Overlay</div>", {
        duration: 10
      });
      expect(adapter.screencastShowOverlay).toHaveBeenCalledWith({
        html: "<div>Overlay</div>",
        duration: 10
      });
      await overlay.dispose();
      expect(adapter.screencastRemoveOverlay).toHaveBeenCalledWith("overlay-1");

      await page.screencast.showChapter("Chapter 1", {
        description: "desc",
        duration: 2000
      });
      expect(adapter.screencastChapter).toHaveBeenCalledWith({
        title: "Chapter 1",
        description: "desc",
        duration: 2000
      });

      await page.screencast.hideOverlays();
      await page.screencast.showOverlays();
      expect(adapter.screencastSetOverlayVisible).toHaveBeenNthCalledWith(1, false);
      expect(adapter.screencastSetOverlayVisible).toHaveBeenNthCalledWith(2, true);
    } finally {
      if (previousFfmpegPath === undefined) {
        delete process.env.ROXY_FFMPEG_PATH;
      } else {
        process.env.ROXY_FFMPEG_PATH = previousFfmpegPath;
      }
    }
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

    const filterSpy = vi.spyOn(RoxyLocator.prototype, "filter");
    const cssLocator = page.locator(".target", { hasText: "Ready" });
    const textLocator = page.getByText(/hello/i, { exact: true });
    const roleLocator = page.getByRole("button", { name: "Send" });

    expect(cssLocator).toBeInstanceOf(RoxyLocator);
    expect(textLocator).toBeInstanceOf(RoxyLocator);
    expect(roleLocator).toBeInstanceOf(RoxyLocator);
    expect(adapter.locator).toHaveBeenCalledWith({
      strategy: "css",
      value: ".target"
    });
    expect(filterSpy).toHaveBeenCalledWith({ hasText: "Ready" });
    expect(locatorAdapter.getByText).toHaveBeenCalledWith(/hello/i, { exact: true });
    expect(locatorAdapter.getByRole).toHaveBeenCalledWith("button", { name: "Send" });
    expect(locatorAdapter).toBeTruthy();
    filterSpy.mockRestore();
  });

  it("creates frame locators from page selectors", () => {
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

    const frameLocator = page.frameLocator("iframe");

    expect(frameLocator).toBeInstanceOf(RoxyFrameLocator);
    expect(adapter.locator).toHaveBeenCalledWith({
      strategy: "css",
      value: "iframe"
    });
  });

  it("builds a frame graph for mainFrame, frames and frame lookups", async () => {
    const adapter = createPageAdapterStub();
    adapter.evaluate = vi.fn(async <TResult>(expression: string) => {
      if (expression.includes("const snapshots")) {
        return [
          {
            id: "main",
            name: "",
            ownerElementChain: [],
            parentId: null,
            referenceChain: [],
            url: "https://example.com"
          },
          {
            id: "main.1",
            name: "frame-one",
            ownerElementChain: [{ strategy: "css", value: "iframe:nth-of-type(1)" }],
            parentId: "main",
            referenceChain: [
              { strategy: "css", value: "iframe:nth-of-type(1)" },
              { strategy: "control", value: "enter-frame" }
            ],
            url: "https://example.com/frame"
          }
        ] as TResult;
      }
      return "https://example.com" as TResult;
    });
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

    await page.goto("https://example.com");

    const frames = page.frames();
    const mainFrame = page.mainFrame();
    const childFrame = page.frame({ name: "frame-one" });

    expect(frames).toHaveLength(2);
    expect(mainFrame.page()).toBe(page);
    expect(mainFrame.parentFrame()).toBeNull();
    expect(mainFrame.childFrames()).toHaveLength(1);
    expect(childFrame?.parentFrame()).toBe(mainFrame);
    expect(childFrame?.url()).toBe("https://example.com/frame");
    expect(page.frame("frame-one")).toBe(childFrame);
    expect(page.frame({ url: /\/frame$/ })?.name()).toBe("frame-one");
  });

  it("creates Playwright-style getBy helpers on page and locator", () => {
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

    page.getByAltText("logo");
    page.getByLabel("Name");
    page.getByPlaceholder("Search");
    page.getByTestId("id");
    page.getByTitle("Hint");

    const locatorAdapter = adapter.locator.mock.results[0]!.value;
    expect(locatorAdapter.getByAltText).toHaveBeenCalledWith("logo", undefined);
    expect(locatorAdapter.getByLabel).toHaveBeenCalledWith("Name", undefined);
    expect(locatorAdapter.getByPlaceholder).toHaveBeenCalledWith("Search", undefined);
    expect(locatorAdapter.getByTestId).toHaveBeenCalledWith("id");
    expect(locatorAdapter.getByTitle).toHaveBeenCalledWith("Hint", undefined);
  });

  it("forwards page.setChecked to the main frame", async () => {
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
    const setCheckedSpy = vi.spyOn(page.mainFrame(), "setChecked").mockResolvedValue(undefined);

    await page.setChecked("input", true, { force: true });

    expect(setCheckedSpy).toHaveBeenCalledWith("input", true, { force: true });
    expect(adapter.setChecked).not.toHaveBeenCalled();
  });

  it("dispatches routes in newest-first order and supports fallback chaining", async () => {
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
    const calls: number[] = [];

    await page.route("**/bar", async (route) => {
      calls.push(1);
      await route.fallback();
    });
    await page.route("**/foo", async (route) => {
      calls.push(2);
      await route.fallback({ url: "https://example.com/bar" });
    });
    await page.route("**/empty.html", async (route) => {
      calls.push(3);
      await route.fallback({ url: "https://example.com/foo" });
    });

    const decision = await (page as any).dispatchRoutedRequest({
      id: "request:1",
      url: "https://example.com/empty.html",
      method: "GET",
      headers: {
        "x-test": "route"
      },
      postData: null
    });

    expect(calls).toEqual([3, 2, 1]);
    expect(decision).toEqual({
      action: "continue",
      headers: {
        "x-test": "route"
      },
      method: "GET",
      postData: null,
      url: "https://example.com/bar"
    });
  });

  it("supports route disposal, unroute and times lifecycle", async () => {
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
    const calls: string[] = [];

    const firstHandler = vi.fn(async (route: any) => {
      calls.push("first");
      await route.fallback();
    });
    const secondHandler = vi.fn(async (route: any) => {
      calls.push("second");
      await route.fallback();
    });

    const disposable = await page.route("**/empty.html", firstHandler, { times: 1 });
    await page.route(/empty\.html$/, secondHandler);

    await (page as any).dispatchRoutedRequest({
      id: "request:2",
      url: "https://example.com/empty.html",
      method: "GET",
      headers: {},
      postData: null
    });
    expect(calls).toEqual(["second", "first"]);

    calls.length = 0;
    await (page as any).dispatchRoutedRequest({
      id: "request:3",
      url: "https://example.com/empty.html",
      method: "GET",
      headers: {},
      postData: null
    });
    expect(calls).toEqual(["second"]);

    calls.length = 0;
    await page.unroute(/empty\.html$/, secondHandler);
    await disposable.dispose();
    await (page as any).dispatchRoutedRequest({
      id: "request:4",
      url: "https://example.com/empty.html",
      method: "GET",
      headers: {},
      postData: null
    });
    expect(calls).toEqual([]);
  });

  it("waits for pending route handlers during page.unrouteAll like Playwright", async () => {
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
    let secondHandlerCalled = false;
    await page.route(/.*/, async (route) => {
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

    await page.route(/.*/, async (route) => {
      routeCallback();
      await routeBarrier;
      await route.fallback();
    });

    const dispatchPromise = (page as any).dispatchRoutedRequest({
      id: "request:unroute-wait",
      url: "https://example.com/empty.html",
      method: "GET",
      headers: {},
      postData: null
    });

    await routePromise;

    let didUnroute = false;
    const unroutePromise = page.unrouteAll({ behavior: "wait" }).then(() => {
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

  it("ignores pending route handler errors during page.unrouteAll like Playwright", async () => {
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
    let secondHandlerCalled = false;
    await page.route(/.*/, async (route) => {
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

    await page.route(/.*/, async () => {
      routeCallback();
      await routeBarrier;
      throw new Error("Handler error");
    });

    const dispatchPromise = (page as any).dispatchRoutedRequest({
      id: "request:unroute-ignore-errors",
      url: "https://example.com/empty.html",
      method: "GET",
      headers: {},
      postData: null
    });

    await routePromise;

    let didUnroute = false;
    await page.unrouteAll({ behavior: "ignoreErrors" }).then(() => {
      didUnroute = true;
    });
    expect(didUnroute).toBe(true);

    continueRouteCallback();
    expect(await dispatchPromise).toEqual({
      action: "continue",
      headers: {},
      method: "GET",
      postData: null,
      url: "https://example.com/empty.html"
    });
    expect(secondHandlerCalled).toBe(false);
  });

  it("deletes headers with undefined values and preserves non-overridden headers", async () => {
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

    await page.route("**/something", async (route, request) => {
      const headers = await request.allHeaders();
      await route.continue({
        headers: {
          ...headers,
          foo: undefined
        }
      });
    });

    const decision = await (page as any).dispatchRoutedRequest({
      id: "request:headers-undefined",
      url: "https://example.com/something",
      method: "GET",
      headers: {
        foo: "a",
        bar: "b"
      },
      postData: null
    });

    expect(decision).toEqual({
      action: "continue",
      headers: {
        bar: "b"
      },
      method: "GET",
      postData: null,
      url: "https://example.com/something"
    });
  });

  it("does not allow changing protocol when overriding url", async () => {
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

    await page.route("**/*", async (route) => {
      await route.continue({ url: "file:///tmp/foo" });
    });

    await expect(
      (page as any).dispatchRoutedRequest({
        id: "request:protocol",
        url: "https://example.com/empty.html",
        method: "GET",
        headers: {},
        postData: null
      })
    ).rejects.toThrow("New URL must have same protocol as overridden URL");
  });

  it("preserves forbidden headers and recomputes content-length for overridden postData", async () => {
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

    await page.route("**/*", async (route, request) => {
      await route.continue({
        headers: {
          ...request.headers(),
          host: "bar",
          trailer: "baz",
          "x-test": "2"
        },
        postData: "doggo"
      });
    });

    const decision = await (page as any).dispatchRoutedRequest({
      id: "request:forbidden-headers",
      url: "https://example.com/sleep.zzz",
      method: "POST",
      headers: {
        host: "example.com",
        trailer: "trail",
        "x-test": "1",
        "content-type": "text/plain",
        "content-length": "5"
      },
      postData: "birdy"
    });

    expect(decision).toEqual({
      action: "continue",
      headers: {
        host: "example.com",
        trailer: "trail",
        "x-test": "2",
        "content-type": "text/plain",
        "content-length": "5"
      },
      method: "POST",
      postData: "doggo",
      postDataBufferBase64: Buffer.from("doggo", "utf8").toString("base64"),
      url: "https://example.com/sleep.zzz"
    });
  });

  it("replays matching requests from HAR files", async () => {
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
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-har-"));
    const harPath = join(directory, "fixture.har");

    await writeFile(
      harPath,
      JSON.stringify({
        log: {
          entries: [
            {
              request: {
                method: "GET",
                url: "https://example.com/data.json"
              },
              response: {
                status: 200,
                headers: [
                  { name: "content-type", value: "application/json" }
                ],
                content: {
                  text: "{\"ok\":true}"
                }
              }
            }
          ]
        }
      })
    );

    await page.routeFromHAR(harPath);

    const decision = await (page as any).dispatchRoutedRequest({
      id: "request:5",
      url: "https://example.com/data.json",
      method: "GET",
      headers: {},
      postData: null
    });

    expect(decision).toEqual({
      action: "fulfill",
      body: "{\"ok\":true}",
      headers: {
        "content-type": "application/json"
      },
      status: 200,
      statusText: "OK",
      url: "https://example.com/data.json"
    });
  });

  it("exposes Playwright-like routed request helpers and fulfilled response metadata", async () => {
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
    let capturedRequest: any;

    await page.route("**/submit", async (route, request) => {
      capturedRequest = request;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ ok: true })
      });
    });

    await (page as any).dispatchRoutedRequest({
      id: "request:6",
      url: "https://example.com/submit",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test": "yes"
      },
      postData: JSON.stringify({ value: 42 }),
      isNavigationRequest: true,
      resourceType: "document"
    });

    expect(await capturedRequest.allHeaders()).toEqual({
      "content-type": "application/json",
      "x-test": "yes"
    });
    expect(await capturedRequest.headersArray()).toEqual([
      { name: "content-type", value: "application/json" },
      { name: "x-test", value: "yes" }
    ]);
    expect(await capturedRequest.headerValue("Content-Type")).toBe("application/json");
    expect(capturedRequest.method()).toBe("POST");
    expect(capturedRequest.postData()).toBe("{\"value\":42}");
    expect(capturedRequest.postDataBuffer()).toEqual(Buffer.from("{\"value\":42}", "utf8"));
    expect(capturedRequest.postDataJSON()).toEqual({ value: 42 });
    expect(capturedRequest.frame()).toBe(page.mainFrame());
    expect(capturedRequest.isNavigationRequest()).toBe(true);
    expect(capturedRequest.resourceType()).toBe("document");
    expect(capturedRequest.failure()).toBeNull();

    const response = await capturedRequest.response();
    expect(response).toBeTruthy();
    expect(await response.allHeaders()).toEqual({
      "content-length": "11",
      "content-type": "application/json"
    });
    expect(response.status()).toBe(201);
    expect(response.statusText()).toBe("Created");
    expect(response.url()).toBe("https://example.com/submit");
    expect(await response.json()).toEqual({ ok: true });
    expect(response.request()).toBe(capturedRequest);
  });

  it("tracks request failures for aborted routes", async () => {
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
    let capturedRequest: any;

    await page.route("**/offline", async (route, request) => {
      capturedRequest = request;
      await route.abort("internetdisconnected");
    });

    const decision = await (page as any).dispatchRoutedRequest({
      id: "request:7",
      url: "https://example.com/offline",
      method: "GET",
      headers: {},
      postData: null
    });

    expect(decision).toEqual({
      action: "abort",
      errorCode: "internetdisconnected"
    });
    expect(capturedRequest.failure()).toEqual({
      errorText: "internetdisconnected"
    });
    expect(await capturedRequest.response()).toBeNull();
  });

  it("throws when a route is handled twice", async () => {
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
    let capturedRoute: any;

    await page.route("**/*", async (route) => {
      capturedRoute = route;
      await route.fulfill({
        body: "ok"
      });
    });

    await (page as any).dispatchRoutedRequest({
      id: "request:8",
      url: "https://example.com/handled-once",
      method: "GET",
      headers: {},
      postData: null
    });

    const error = await capturedRoute.fulfill({ body: "again" }).catch((caught: Error) => caught);
    expect(error.message).toContain("Route is already handled!");
  });

  it("implements Playwright-like route.fetch and fulfill(response) semantics", async () => {
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
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(Buffer.from([0, 1, 2, 3]), {
        headers: {
          "content-type": "application/octet-stream"
        },
        status: 203,
        statusText: "Non-Authoritative Information"
      })
    );
    let fetchedResponse: any;

    try {
      await page.route("**/binary", async (route) => {
        fetchedResponse = await route.fetch({
          postData: Buffer.from([9, 8, 7])
        });
        expect(fetchedResponse.status()).toBe(203);
        expect(fetchedResponse.statusText()).toBe("Non-Authoritative Information");
        expect(fetchedResponse.headers()["content-type"]).toBe("application/octet-stream");
        expect(fetchedResponse.headersArray()).toEqual([
          { name: "content-type", value: "application/octet-stream" }
        ]);
        expect(await fetchedResponse.body()).toEqual(Buffer.from([0, 1, 2, 3]));

        await route.fulfill({ response: fetchedResponse });
      });

      const decision = await (page as any).dispatchRoutedRequest({
        id: "request:9",
        url: "https://example.com/binary",
        method: "POST",
        headers: {},
        postData: null
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://example.com/binary",
        expect.objectContaining({
          body: Buffer.from([9, 8, 7]),
          headers: {
            "content-length": "3",
            "content-type": "application/octet-stream"
          },
          method: "POST",
          redirect: "manual"
        })
      );
      expect(decision).toEqual({
        action: "fulfill",
        body: "\u0000\u0001\u0002\u0003",
        bodyBufferBase64: Buffer.from([0, 1, 2, 3]).toString("base64"),
        headers: {
          "content-length": "4",
          "content-type": "application/octet-stream"
        },
        status: 203,
        statusText: "Non-Authoritative Information",
        url: "https://example.com/binary"
      });
      await fetchedResponse.dispose();
      await expect(fetchedResponse.body()).rejects.toThrow("Response has been disposed");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("sets json content-type for object postData in route.fetch", async () => {
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
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", {
        status: 200,
        statusText: "OK"
      })
    );

    try {
      await page.route("**/json", async (route) => {
        await route.fetch({
          postData: { value: 42 }
        });
        await route.fulfill({ body: "done" });
      });

      await (page as any).dispatchRoutedRequest({
        id: "request:10",
        url: "https://example.com/json",
        method: "POST",
        headers: {},
        postData: null
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://example.com/json",
        expect.objectContaining({
          body: Buffer.from(JSON.stringify({ value: 42 }), "utf8"),
          headers: {
            "content-length": "12",
            "content-type": "application/json"
          }
        })
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("supports page.request.fetch(route.request()) for fulfill flows", async () => {
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
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"foo":"bar"}', {
        headers: {
          "content-type": "application/json"
        },
        status: 200,
        statusText: "OK"
      })
    );

    try {
      await page.route("**/simple.json", async (route) => {
        const response = await page.request.fetch(route.request());
        await route.fulfill({ response });
      });

      const decision = await (page as any).dispatchRoutedRequest({
        id: "request:11",
        url: "https://example.com/simple.json",
        method: "POST",
        headers: {
          "x-test": "1"
        },
        postData: "{\"value\":42}",
        postDataBufferBase64: Buffer.from("{\"value\":42}", "utf8").toString("base64")
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://example.com/simple.json",
        expect.objectContaining({
          body: Buffer.from("{\"value\":42}", "utf8"),
          headers: expect.objectContaining({
            "content-length": "12",
            "x-test": "1"
          }),
          method: "POST",
          redirect: "manual"
        })
      );
      expect(decision).toEqual({
        action: "fulfill",
        body: '{"foo":"bar"}',
        bodyBufferBase64: Buffer.from('{"foo":"bar"}', "utf8").toString("base64"),
        headers: {
          "content-length": "13",
          "content-type": "application/json"
        },
        status: 200,
        statusText: "OK",
        url: "https://example.com/simple.json"
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses standard status text for fulfilled responses", async () => {
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
    let response422: any;
    let response430: any;

    await page.route("**/422", async (route, request) => {
      await route.fulfill({
        status: 422,
        body: "Yo, page!"
      });
      response422 = await request.response();
    });
    await page.route("**/430", async (route, request) => {
      await route.fulfill({
        status: 430,
        body: "Yo, page!"
      });
      response430 = await request.response();
    });

    await (page as any).dispatchRoutedRequest({
      id: "request:12",
      url: "https://example.com/422",
      method: "GET",
      headers: {},
      postData: null
    });
    await (page as any).dispatchRoutedRequest({
      id: "request:13",
      url: "https://example.com/430",
      method: "GET",
      headers: {},
      postData: null
    });

    expect(response422.statusText()).toBe("Unprocessable Entity");
    expect(response430.statusText()).toBe("Unknown");
  });

  it("fulfills json with Playwright headers and rejects body plus json", async () => {
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

    await page.route("**/data.json", async (route) => {
      await route.fulfill({
        status: 201,
        headers: {
          foo: "bar"
        },
        json: { bar: "baz" }
      });
    });

    const decision = await (page as any).dispatchRoutedRequest({
      id: "request:json-fulfill",
      url: "https://example.com/data.json",
      method: "GET",
      headers: {},
      postData: null
    });

    expect(decision).toEqual({
      action: "fulfill",
      body: JSON.stringify({ bar: "baz" }),
      bodyBufferBase64: Buffer.from(JSON.stringify({ bar: "baz" }), "utf8").toString("base64"),
      headers: {
        foo: "bar",
        "content-length": "13",
        "content-type": "application/json"
      },
      status: 201,
      statusText: "Created",
      url: "https://example.com/data.json"
    });

    await page.unrouteAll();
    await page.route("**/invalid.json", async (route) => {
      await route.fulfill({
        body: "text",
        json: { ok: true }
      });
    });

    await expect(
      (page as any).dispatchRoutedRequest({
        id: "request:json-body",
        url: "https://example.com/invalid.json",
        method: "GET",
        headers: {},
        postData: null
      })
    ).rejects.toThrow("Can specify either body or json parameters");
  });

  it("infers mime type and preserves bytes when fulfilling from path", async () => {
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
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-fulfill-path-"));
    const filePath = join(directory, "image.png");
    const fileBody = Buffer.from([0, 1, 2, 3, 4]);
    await writeFile(filePath, fileBody);
    let capturedResponse: any;

    await page.route("**/asset", async (route, request) => {
      await route.fulfill({ contentType: "shouldBeIgnored", path: filePath });
      capturedResponse = await request.response();
    });

    const decision = await (page as any).dispatchRoutedRequest({
      id: "request:14",
      url: "https://example.com/asset",
      method: "GET",
      headers: {},
      postData: null
    });

    expect(decision).toEqual({
      action: "fulfill",
      body: fileBody.toString("utf8"),
      bodyBufferBase64: fileBody.toString("base64"),
      headers: {
        "content-length": String(fileBody.byteLength),
        "content-type": "image/png"
      },
      status: 200,
      statusText: "OK",
      url: "https://example.com/asset"
    });
    expect(await capturedResponse.body()).toEqual(fileBody);
    expect(await capturedResponse.allHeaders()).toEqual({
      "content-length": String(fileBody.byteLength),
      "content-type": "image/png"
    });
  });

  it("dispatches websocket routes and relays mocked message handling", async () => {
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
    const seen: Array<{ type: string; value?: string; protocols?: string[] }> = [];

    await page.routeWebSocket("**/ws", async (ws) => {
      seen.push({
        type: "open",
        protocols: ws.protocols()
      });
      ws.onMessage((message) => {
        seen.push({
          type: "message",
          value: String(message)
        });
        ws.send(`echo:${String(message)}`);
      });
      ws.onClose((code, reason) => {
        seen.push({
          type: "close",
          value: `${String(code)}:${String(reason)}`
        });
      });
    });

    const openDecision = await (page as any).dispatchWebSocketOpen({
      id: "websocket:1",
      url: "wss://example.com/ws",
      protocols: ["chat.v2"]
    });
    expect(openDecision).toEqual({ action: "mock" });
    expect(seen).toEqual([
      {
        type: "open",
        protocols: ["chat.v2"]
      }
    ]);

    await (page as any).dispatchWebSocketEvent({
      id: "websocket:1",
      kind: "message",
      message: "hello"
    });
    expect(seen[1]).toEqual({
      type: "message",
      value: "hello"
    });
    expect(adapter.evaluate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        socketId: "websocket:1",
        value: expect.arrayContaining([
          expect.objectContaining({
            kind: "message",
            message: "echo:hello"
          })
        ])
      }),
      true
    );

    await (page as any).dispatchWebSocketEvent({
      id: "websocket:1",
      kind: "close",
      code: 1000,
      reason: "done"
    });
    expect(seen[2]).toEqual({
      type: "close",
      value: "1000:done"
    });
  });

  it("falls back to passthrough when no websocket route matches", async () => {
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

    const decision = await (page as any).dispatchWebSocketOpen({
      id: "websocket:2",
      url: "wss://example.com/other",
      protocols: []
    });

    expect(decision).toEqual({ action: "passthrough" });
  });

  it("connectToServer forwards page messages to the server route by default", async () => {
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
    const seen: string[] = [];

    await page.routeWebSocket("**/ws", async (ws) => {
      const server = ws.connectToServer();
      server.onMessage((message) => {
        seen.push(`server:${String(message)}`);
        server.send(`server-echo:${String(message)}`);
      });
    });

    await (page as any).dispatchWebSocketOpen({
      id: "websocket:3",
      url: "wss://example.com/ws",
      protocols: []
    });
    await (page as any).dispatchWebSocketEvent({
      id: "websocket:3",
      kind: "message",
      message: "ping"
    });

    expect(seen).toEqual(["server:ping"]);
    expect(adapter.evaluate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        socketId: "websocket:3",
        value: expect.arrayContaining([
          expect.objectContaining({
            kind: "message",
            message: "server-echo:ping"
          })
        ])
      }),
      true
    );
  });

  it("stops default forwarding once the original websocket route handles messages", async () => {
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
    const seen: string[] = [];

    await page.routeWebSocket("**/ws", async (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        seen.push(`page:${String(message)}`);
      });
      server.onMessage((message) => {
        seen.push(`server:${String(message)}`);
      });
    });

    await (page as any).dispatchWebSocketOpen({
      id: "websocket:4",
      url: "wss://example.com/ws",
      protocols: []
    });
    await (page as any).dispatchWebSocketEvent({
      id: "websocket:4",
      kind: "message",
      message: "hello"
    });

    expect(seen).toEqual(["page:hello"]);
  });

  it("proxies dispatchEvent and requestGC to the adapter", async () => {
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

    await page.dispatchEvent("button", "click", { bubbles: false });
    await page.requestGC();

    const locatorAdapter = adapter.locator.mock.results[0]!.value;
    expect(locatorAdapter.dispatchEvent).toHaveBeenCalledWith("click", { bubbles: false }, undefined);
    expect(adapter.requestGC).toHaveBeenCalledTimes(1);
  });

  it("returns a handle from evaluateHandle and waitForFunction", async () => {
    const adapter = createPageAdapterStub();
    adapter.evaluate = vi.fn(async <TResult>() => 3 as TResult);
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

    expect(await (await page.evaluateHandle("1 + 2")).jsonValue()).toBe(3);
    expect(await (await page.waitForFunction(() => 5)).jsonValue()).toBe(3);
  });

  it("serializes nested JSHandle arguments through page.evaluate", async () => {
    const adapter = createPageAdapterStub();
    let callCount = 0;
    adapter.evaluate = vi.fn(async <TResult>(_expression: string, arg?: unknown) => {
      callCount += 1;
      if (callCount === 1) {
        return { x: 1, y: "foo" } as TResult;
      }
      if (callCount === 2) {
        return 5 as TResult;
      }
      return arg as TResult;
    });
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

    await page.evaluate((arg) => arg, {
      foo: await page.evaluateHandle(() => ({ x: 1, y: "foo" })),
      nested: [await page.evaluateHandle(() => 5)]
    });

    expect(adapter.evaluate).toHaveBeenLastCalledWith(
      expect.any(String),
      {
        foo: expect.any(RoxyJSHandle),
        nested: [expect.any(RoxyJSHandle)]
      },
      true
    );
  });

  it("supports JSHandle property access helpers", async () => {
    const adapter = createPageAdapterStub();
    adapter.evaluate = vi.fn(async <TResult>() => ({ foo: "bar", num: 3 } as TResult));
    const handle = await (new RoxyPage(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    })).evaluateHandle(() => ({ foo: "bar", num: 3 }));

    expect(await handle.getProperty("foo")).toBeTruthy();
    expect(await (await handle.getProperty("foo")).jsonValue()).toBe("bar");
    expect((await handle.getProperties()).get("num")).toBeTruthy();
  });

  it("waits for function success after retries", async () => {
    const adapter = createPageAdapterStub();
    let count = 0;
    adapter.evaluate = vi.fn(async () => {
      count += 1;
      return (count > 1 ? 5 : 0) as unknown as number;
    });
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

    expect(await (await page.waitForFunction(() => 5, {}, { polling: 1, timeout: 100 })).jsonValue()).toBe(5);
  });

  it("forwards page.tap to the main frame", async () => {
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
    const tapSpy = vi.spyOn(page.mainFrame(), "tap").mockResolvedValue(undefined);

    await page.tap(".action", { timeout: 123 });

    expect(tapSpy).toHaveBeenCalledWith(".action", { timeout: 123 });
    expect(adapter.tap).not.toHaveBeenCalled();
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
    expect(adapter.createHandleReference).toHaveBeenCalledWith({
      chain: [
        {
          strategy: "css",
          value: "div"
        },
        {
          strategy: "text",
          value: "Hello"
        }
      ],
      pick: {
        kind: "first"
      }
    }, 'Failed to find element matching selector "div >> text=Hello"');
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
    expect(adapter.createHandleReference).toHaveBeenCalledWith({
      chain: [
        {
          strategy: "css",
          value: "div"
        }
      ],
      pick: {
        kind: "first"
      }
    }, 'Failed to find element matching selector "div"');
    expect(adapter.evaluateOnReference).toHaveBeenCalledWith({
      chain: [
        {
          strategy: "css",
          value: "div"
        }
      ],
      pick: {
        kind: "first"
      }
    }, expect.stringContaining("suffix"), "!", 'Failed to find element matching selector "div"', true);
    expect(adapter.evaluateOnReferenceAll).toHaveBeenCalledWith({
      chain: [
        {
          strategy: "css",
          value: "div"
        }
      ]
    }, expect.stringContaining("suffix"), "!", true);
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

    const handleAdapter = adapter.createHandle.mock.results[0]!.value;
    expect(handleAdapter.query).toHaveBeenCalledWith([
      {
        strategy: "css",
        value: "span"
      }
    ]);
    expect(handleAdapter.queryAll).toHaveBeenCalledWith([
      {
        strategy: "css",
        value: "span"
      }
    ]);
    expect(handleAdapter.evalOnSelector).toHaveBeenCalledWith([
      {
        strategy: "css",
        value: "span"
      }
    ], expect.stringContaining("suffix"), true, "!");
    expect(handleAdapter.evalOnSelectorAll).toHaveBeenCalledWith([
      {
        strategy: "css",
        value: "span"
      }
    ], expect.any(String), true, "!");
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

    const userVisibleSubscriptions = vi
      .mocked(adapter.on)
      .mock.calls.filter(([event]) => event === "request" || event === "load");
    expect(userVisibleSubscriptions.length).toBeGreaterThanOrEqual(2);
    expect(userVisibleSubscriptions.some(([event]) => event === "request")).toBe(true);
    expect(userVisibleSubscriptions.some(([event]) => event === "load")).toBe(true);

    adapter.emit("request", {
      headers: [{ name: "accept", value: "*/*" }],
      method: "GET",
      url: "https://example.com/data"
    });
    adapter.emit("load", undefined);
    adapter.emit("load", undefined);

    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: expect.any(Function),
        url: expect.any(Function)
      })
    );
    expect(logRequest.mock.calls[0]?.[0]?.method()).toBe("GET");
    expect(logRequest.mock.calls[0]?.[0]?.url()).toBe("https://example.com/data");
    expect(logRequest.mock.calls[0]?.[0]?.headers()).toEqual({ accept: "*/*" });
    expect(secondRequestListener).toHaveBeenCalledTimes(1);
    expect(onLoad).toHaveBeenCalledTimes(1);

    page.removeListener("request", logRequest);
    adapter.emit("request", {
      headers: [],
      method: "POST",
      url: "https://example.com/submit"
    });

    expect(logRequest).toHaveBeenCalledTimes(1);
    expect(secondRequestListener.mock.calls[1]?.[0]?.method()).toBe("POST");
    expect(secondRequestListener.mock.calls[1]?.[0]?.url()).toBe("https://example.com/submit");

    page.removeListener("request", secondRequestListener);
    adapter.emit("request", {
      headers: [],
      method: "DELETE",
      url: "https://example.com/delete"
    });

    expect(secondRequestListener).toHaveBeenCalledTimes(2);
  });

  it("supports synthetic popup events without subscribing the raw adapter", async () => {
    const adapter = createPageAdapterStub();
    const opener = new RoxyPage(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    const popup = new RoxyPage(createPageAdapterStub(), {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    const popupPromise = opener.waitForEvent("popup");
    opener.emitPopup(popup);

    await expect(popupPromise).resolves.toBe(popup);
    expect(vi.mocked(adapter.on).mock.calls.some(([event]) => event === "popup")).toBe(false);
  });

  it("passes self for load, domcontentloaded and close events", async () => {
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
    const domcontentloaded = vi.fn();
    const load = vi.fn();
    const closePromise = page.waitForEvent("close");

    page.on("domcontentloaded", domcontentloaded);
    page.on("load", load);

    adapter.emit("domcontentloaded", undefined);
    adapter.emit("load", undefined);
    adapter.emit("close", undefined);

    expect(domcontentloaded).toHaveBeenCalledWith(page);
    expect(load).toHaveBeenCalledWith(page);
    await expect(closePromise).resolves.toBe(page);
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
      args: () => [],
      location: () => ({
        column: 0,
        columnNumber: 0,
        line: 0,
        lineNumber: 0,
        url: ""
      }),
      page: () => null,
      text: () => "skip",
      timestamp: () => 1,
      type: () => "log",
      worker: () => null
    });
    adapter.emit("console", {
      args: () => [],
      location: () => ({
        column: 0,
        columnNumber: 0,
        line: 0,
        lineNumber: 0,
        url: ""
      }),
      page: () => null,
      text: () => "match",
      timestamp: () => 2,
      type: () => "log",
      worker: () => null
    });

    const message = await waited;
    expect(message.text()).toBe("match");
    expect(message.type()).toBe("log");
  });

  it("waits for dialog events and exposes dialog helpers", async () => {
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

    const accept = vi.fn(async () => {});
    const dismiss = vi.fn(async () => {});
    const waited = page.waitForEvent("dialog");

    adapter.emit("dialog", {
      accept,
      defaultValue: () => "",
      dismiss,
      message: () => "Leave?",
      type: () => "beforeunload"
    });

    const dialog = await waited;
    expect(dialog.type()).toBe("beforeunload");
    expect(dialog.message()).toBe("Leave?");
    expect(dialog.defaultValue()).toBe("");
    expect(dialog.page()).toBe(page);
    await dialog.accept("ignored");
    await dialog.dismiss();
    expect(accept).toHaveBeenCalledWith("ignored");
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("supports waitForEvent options with predicate and timeout", async () => {
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

    const waited = page.waitForEvent("response", {
      timeout: 100,
      predicate: (response) => response.url().endsWith("/match")
    });

    adapter.emit("response", {
      url: "https://example.com/nope",
      status: 200,
      statusText: "OK",
      headers: [],
      mimeType: "text/plain",
      fromCache: false,
      text: async () => "nope"
    });
    adapter.emit("response", {
      url: "https://example.com/match",
      status: 200,
      statusText: "OK",
      headers: [],
      mimeType: "text/plain",
      fromCache: false,
      text: async () => "ok"
    });

    expect((await waited).url()).toBe("https://example.com/match");
  });

  it("surfaces waitForResponse timeout stacks from the api call site", async () => {
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

    page.setDefaultTimeout(1);
    const error = await page.waitForResponse(() => false).catch((caught) => caught as Error);
    const firstFrame = String(error.stack)
      .split("\n")
      .find((line) => line.startsWith("    at "));

    expect(error).toBeInstanceOf(TimeoutError);
    expect(firstFrame).toContain("page.test.ts");
  });

  it("surfaces waitForRequest timeout stacks from the api call site", async () => {
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

    page.setDefaultTimeout(1);
    const error = await page.waitForRequest(() => false).catch((caught) => caught as Error);
    const firstFrame = String(error.stack)
      .split("\n")
      .find((line) => line.startsWith("    at "));

    expect(error).toBeInstanceOf(TimeoutError);
    expect(firstFrame).toContain("page.test.ts");
  });

  it("waits for request and response by url matcher", async () => {
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

    const requestPromise = page.waitForRequest(/target\.json/);
    const responsePromise = page.waitForResponse("**/target.json");

    adapter.emit("request", {
      url: "https://example.com/target.json",
      method: "GET",
      headers: []
    });
    adapter.emit("response", {
      url: "https://example.com/target.json",
      status: 200,
      statusText: "OK",
      headers: [],
      mimeType: "application/json",
      fromCache: false,
      text: async () => '{"ok":true}'
    });

    expect((await requestPromise).url()).toContain("target.json");
    expect((await responsePromise).url()).toContain("target.json");
  });

  it("rejects pending waiters with the close reason", async () => {
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

    const requestPromise = page.waitForRequest(/target\.json/);
    await page.close({ reason: "custom reason" });

    await expect(requestPromise).rejects.toThrow("custom reason");
    expect(adapter.close).toHaveBeenCalledWith({ reason: "custom reason" });
  });

  it("does not mark the page closed when running beforeunload", async () => {
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

    await page.close({ runBeforeUnload: true });

    expect(adapter.close).toHaveBeenCalledWith({ runBeforeUnload: true });
    expect(page.isClosed()).toBe(false);
  });

  it("returns observed request and response wrappers for network events", async () => {
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

    const requestPromise = page.waitForRequest(/event\.json$/);
    const responsePromise = page.waitForResponse(/event\.json$/);

    adapter.emit("request", {
      frameId: "main",
      url: "https://example.com/event.json",
      isNavigationRequest: true,
      method: "GET",
      requestId: "req-1",
      resourceType: "document",
      headers: [{ name: "accept", value: "application/json" }]
    });
    const request = await requestPromise;
    expect(request.headers()).toEqual({ accept: "application/json" });
    expect(request.existingResponse()).toBeNull();
    expect(request.frame()).toBe(page.mainFrame());
    expect(request.isNavigationRequest()).toBe(true);
    expect(request.resourceType()).toBe("document");

    adapter.emit("response", {
      frameId: "main",
      url: "https://example.com/event.json",
      isNavigationRequest: true,
      status: 200,
      statusText: "OK",
      headers: [{ name: "content-type", value: "application/json" }],
      mimeType: "application/json",
      fromCache: false,
      requestId: "req-1",
      resourceType: "document",
      text: async () => '{"ok":true}'
    });
    const response = await responsePromise;

    expect(request.existingResponse()).toBe(response);
    expect(await request.response()).toBe(response);
    expect(response.request()).toBe(request);
    expect(await response.allHeaders()).toEqual({
      "content-type": "application/json"
    });
    expect(await response.json()).toEqual({ ok: true });
  });

  it("resolves request.response() to null after main-frame navigation", async () => {
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

    const requestPromise = page.waitForRequest(/pending\.json$/);
    adapter.emit("request", {
      frameId: "main",
      url: "https://example.com/pending.json",
      isNavigationRequest: true,
      method: "GET",
      requestId: "req-pending",
      resourceType: "document",
      headers: []
    });
    const request = await requestPromise;

    const responsePromise = request.response();

    adapter.emit("framenavigated", {
      frameId: "main",
      parentFrameId: null,
      url: "https://example.com/next"
    });

    await expect(responsePromise).resolves.toBe(null);
  });

  it("links redirect chains between observed requests", async () => {
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

    const firstRequestPromise = page.waitForRequest(/redirect$/);
    adapter.emit("request", {
      requestId: "redirect-1",
      url: "https://example.com/redirect",
      method: "GET",
      headers: []
    });
    const firstRequest = await firstRequestPromise;

    adapter.emit("response", {
      requestId: "redirect-1",
      url: "https://example.com/redirect",
      status: 302,
      statusText: "Found",
      headers: [{ name: "location", value: "/final" }],
      mimeType: "text/html",
      fromCache: false,
      text: async () => ""
    });

    const secondRequestPromise = page.waitForRequest(/final$/);
    adapter.emit("request", {
      requestId: "redirect-2",
      url: "https://example.com/final",
      method: "GET",
      headers: []
    });
    const secondRequest = await secondRequestPromise;

    expect(secondRequest.redirectedFrom()).toBe(firstRequest);
    expect(firstRequest.redirectedTo()).toBe(secondRequest);
  });

  it("maps observed subframe requests onto the matching frame", async () => {
    const adapter = createPageAdapterStub();
    adapter.evaluate = vi.fn(async <TResult>(expression: string) => {
      if (expression.includes("const snapshots")) {
        return [
          {
            id: "main",
            name: "",
            ownerElementChain: [],
            parentId: null,
            referenceChain: [],
            url: "https://example.com"
          },
          {
            id: "main.1",
            name: "child",
            ownerElementChain: [{ strategy: "css", value: "iframe:nth-of-type(1)" }],
            parentId: "main",
            referenceChain: [
              { strategy: "css", value: "iframe:nth-of-type(1)" },
              { strategy: "control", value: "enter-frame" }
            ],
            url: "https://example.com/frame"
          }
        ] as TResult;
      }
      return "https://example.com" as TResult;
    });

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

    await page.goto("https://example.com");
    const seen: Request[] = [];
    page.on("request", (request) => seen.push(request));

    adapter.emit("request", {
      frameId: "native-child-1",
      headers: [],
      isNavigationRequest: true,
      method: "GET",
      requestId: "child-doc-1",
      resourceType: "document",
      url: "https://example.com/frame"
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.frame()).toBe(page.frames()[1]);
  });

  it("exposes postData helpers on observed network requests", async () => {
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

    const requestPromise = page.waitForRequest(/post\.json$/);
    adapter.emit("request", {
      headers: [{ name: "content-type", value: "application/json" }],
      method: "POST",
      postData: "{\"value\":42}",
      requestId: "post-json-1",
      url: "https://example.com/post.json"
    });

    const request = await requestPromise;
    expect(request.postData()).toBe("{\"value\":42}");
    expect(request.postDataBuffer()).toEqual(Buffer.from("{\"value\":42}", "utf8"));
    expect(request.postDataJSON()).toEqual({ value: 42 });
  });

  it("preserves binary request bodies on observed network requests", async () => {
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

    const multipartBody =
      "--boundary\r\n" +
      "Content-Disposition: form-data; name=\"file\"; filename=\"foo.txt\"\r\n" +
      "Content-Type: application/octet-stream\r\n\r\n" +
      "file-value\r\n" +
      "--boundary--\r\n";
    const requestPromise = page.waitForRequest(/upload$/);
    adapter.emit("request", {
      headers: [
        { name: "content-type", value: "multipart/form-data; boundary=boundary" }
      ],
      method: "POST",
      postData: multipartBody,
      postDataBufferBase64: Buffer.from(multipartBody, "utf8").toString("base64"),
      requestId: "post-multipart-1",
      url: "https://example.com/upload"
    });

    const request = await requestPromise;
    expect(request.postDataBuffer()?.toString("utf8")).toBe(multipartBody);
    expect(request.postData()).toBe(multipartBody);
  });

  it("parses form-urlencoded request bodies on observed network requests", async () => {
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

    const requestPromise = page.waitForRequest(/post$/);
    adapter.emit("request", {
      headers: [
        { name: "content-type", value: "application/x-www-form-urlencoded; charset=UTF-8" }
      ],
      method: "POST",
      postData: "foo=bar&baz=123",
      requestId: "post-form-1",
      url: "https://example.com/post"
    });

    const request = await requestPromise;
    expect(request.postDataJSON()).toEqual({ foo: "bar", baz: "123" });
  });

  it("throws for invalid JSON request postData on observed network requests", async () => {
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

    const requestPromise = page.waitForRequest(/broken$/);
    adapter.emit("request", {
      headers: [],
      method: "POST",
      postData: "<not a json>",
      requestId: "post-invalid-1",
      url: "https://example.com/broken"
    });

    const request = await requestPromise;
    expect(() => request.postDataJSON()).toThrow(
      "POST data is not a valid JSON object: <not a json>"
    );
  });

  it("preserves duplicate request headers in headersArray and merges headerValue", async () => {
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

    const requestPromise = page.waitForRequest(/headers$/);
    adapter.emit("request", {
      headers: [
        { name: "header-a", value: "value-a" },
        { name: "header-b", value: "value-b" },
        { name: "header-a", value: "value-a-1" },
        { name: "header-a", value: "value-a-2" }
      ],
      method: "GET",
      requestId: "headers-1",
      url: "https://example.com/headers"
    });

    const request = await requestPromise;
    expect(await request.headersArray()).toEqual([
      { name: "header-a", value: "value-a" },
      { name: "header-b", value: "value-b" },
      { name: "header-a", value: "value-a-1" },
      { name: "header-a", value: "value-a-2" }
    ]);
    expect(await request.headerValue("header-a")).toBe("value-a, value-a-1, value-a-2");
    expect(await request.headerValue("not-there")).toBeNull();
  });

  it("preserves duplicate response headers and set-cookie separators", async () => {
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

    const responsePromise = page.waitForResponse(/cookies$/);
    adapter.emit("request", {
      headers: [],
      method: "GET",
      requestId: "cookies-1",
      url: "https://example.com/cookies"
    });
    adapter.emit("response", {
      headers: [
        { name: "set-cookie", value: "a=b" },
        { name: "set-cookie", value: "c=d" },
        { name: "x-test", value: "ok" }
      ],
      mimeType: "text/plain",
      fromCache: false,
      requestId: "cookies-1",
      status: 200,
      statusText: "OK",
      text: async () => "ok",
      url: "https://example.com/cookies"
    });

    const response = await responsePromise;
    expect(await response.headersArray()).toEqual([
      { name: "set-cookie", value: "a=b" },
      { name: "set-cookie", value: "c=d" },
      { name: "x-test", value: "ok" }
    ]);
    expect(await response.headerValue("set-cookie")).toBe("a=b\nc=d");
    expect(await response.headerValues("set-cookie")).toEqual(["a=b", "c=d"]);
  });

  it("rejects redirected response bodies like Playwright", async () => {
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

    const finalResponsePromise = page.waitForResponse(/final$/);
    adapter.emit("request", {
      headers: [],
      method: "GET",
      requestId: "redirect-body-1",
      url: "https://example.com/start"
    });
    adapter.emit("response", {
      headers: [{ name: "location", value: "/final" }],
      mimeType: "text/html",
      fromCache: false,
      requestId: "redirect-body-1",
      status: 302,
      statusText: "Found",
      text: async () => "redirect body",
      url: "https://example.com/start"
    });
    adapter.emit("request", {
      headers: [],
      method: "GET",
      requestId: "redirect-body-2",
      url: "https://example.com/final"
    });
    adapter.emit("response", {
      headers: [],
      mimeType: "text/html",
      fromCache: false,
      requestId: "redirect-body-2",
      status: 200,
      statusText: "OK",
      text: async () => "final body",
      url: "https://example.com/final"
    });

    const response = await finalResponsePromise;
    const redirectedFrom = response.request().redirectedFrom();
    expect(redirectedFrom).toBeTruthy();
    const redirectedResponse = await redirectedFrom!.response();
    expect(redirectedResponse?.status()).toBe(302);
    await expect(redirectedResponse!.text()).rejects.toThrow(
      "Response body is unavailable for redirect responses"
    );
    await expect(redirectedResponse!.finished()).resolves.toBeNull();
  });

  it("waits for response completion and surfaces body read failures", async () => {
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

    let resolveBody!: (value: string) => void;
    const responsePromise = page.waitForResponse(/slow$/);
    adapter.emit("request", {
      headers: [],
      method: "GET",
      requestId: "slow-response-1",
      url: "https://example.com/slow"
    });
    adapter.emit("response", {
      headers: [],
      mimeType: "text/plain",
      fromCache: false,
      requestId: "slow-response-1",
      status: 200,
      statusText: "OK",
      text: () =>
        new Promise<string>((resolve) => {
          resolveBody = resolve;
        }),
      url: "https://example.com/slow"
    });

    const response = await responsePromise;
    let finished = false;
    const finishedPromise = response.finished().then((value) => {
      finished = true;
      return value;
    });
    await Promise.resolve();
    expect(finished).toBe(false);

    resolveBody("done");
    await expect(finishedPromise).resolves.toBeNull();
    expect(finished).toBe(true);

    const brokenResponsePromise = page.waitForResponse(/broken-response$/);
    adapter.emit("request", {
      headers: [],
      method: "GET",
      requestId: "broken-response-1",
      url: "https://example.com/broken-response"
    });
    adapter.emit("response", {
      headers: [],
      mimeType: "text/plain",
      fromCache: false,
      requestId: "broken-response-1",
      status: 200,
      statusText: "OK",
      text: async () => {
        throw new Error("socket closed");
      },
      url: "https://example.com/broken-response"
    });

    const brokenResponse = await brokenResponsePromise;
    const error = await brokenResponse.finished();
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("socket closed");
  });

  it("tracks page default timeouts and viewport state", async () => {
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

    page.setDefaultTimeout(123);
    page.setDefaultNavigationTimeout(456);
    await page.setViewportSize({ width: 800, height: 600 });

    expect(page.viewportSize()).toEqual({ width: 800, height: 600 });
    expect(adapter.setViewportSize).toHaveBeenCalledWith({ width: 800, height: 600 });
  });

  it("prepends listeners ahead of earlier listeners", () => {
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
    const calls: string[] = [];

    page.on("request", () => {
      calls.push("on");
    });
    page.prependListener("request", () => {
      calls.push("prepend");
    });

    adapter.emit("request", {
      url: "https://example.com",
      method: "GET",
      headers: []
    });

    expect(calls).toEqual(["prepend", "on"]);
  });

  it("records and clears console messages", async () => {
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

    adapter.emit("console", {
      args: () => [],
      location: () => ({
        column: 0,
        columnNumber: 0,
        line: 0,
        lineNumber: 0,
        url: ""
      }),
      page: () => null,
      text: () => "before",
      timestamp: () => 10,
      type: () => "log",
      worker: () => null
    });
    adapter.emit("framenavigated", { frameId: "main", parentFrameId: null, url: "https://example.com/after" });
    adapter.emit("console", {
      args: () => [],
      location: () => ({
        column: 0,
        columnNumber: 0,
        line: 0,
        lineNumber: 0,
        url: ""
      }),
      page: () => null,
      text: () => "after",
      timestamp: () => 20,
      type: () => "warning",
      worker: () => null
    });

    expect((await page.consoleMessages({ filter: "all" })).map((message) => message.text())).toEqual([
      "before",
      "after"
    ]);
    expect((await page.consoleMessages()).map((message) => message.text())).toEqual(["after"]);
    expect((await page.consoleMessages({ filter: "since-navigation" })).map((message) => message.text())).toEqual(["after"]);

    await page.clearConsoleMessages();
    expect(await page.consoleMessages()).toEqual([]);
  });

  it("exposes Playwright-style console message metadata", async () => {
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

    adapter.emit("console", {
      args: () => [new RoxyJSHandle("hello"), new RoxyJSHandle(42)],
      location: () => ({
        column: 7,
        columnNumber: 7,
        line: 3,
        lineNumber: 3,
        url: "https://example.com/app.js"
      }),
      page: () => null,
      text: () => "hello 42",
      timestamp: () => 12345,
      type: () => "info",
      worker: () => null
    });

    const [message] = await page.consoleMessages();
    expect(message.page()).toBe(page);
    expect(message.timestamp()).toBe(12345);
    expect(message.location()).toEqual({
      column: 7,
      columnNumber: 7,
      line: 3,
      lineNumber: 3,
      url: "https://example.com/app.js"
    });
    expect(message.worker()).toBe(null);
    const args = message.args();
    expect(args).toHaveLength(2);
    await expect(args[0].jsonValue()).resolves.toBe("hello");
    await expect(args[1].jsonValue()).resolves.toBe(42);
    expect(util.inspect(message)).toBe("hello 42");
  });

  it("records and clears page errors", async () => {
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

    adapter.emit("pageerror", Object.assign(new Error("before"), { timestamp: 1 }));
    adapter.emit("framenavigated", { frameId: "main", parentFrameId: null, url: "https://example.com/after" });
    adapter.emit("pageerror", Object.assign(new Error("after"), { timestamp: 2 }));

    expect((await page.pageErrors({ filter: "all" })).map((error) => error.message)).toEqual([
      "before",
      "after"
    ]);
    expect((await page.pageErrors()).map((error) => error.message)).toEqual(["after"]);
    expect((await page.pageErrors({ filter: "since-navigation" })).map((error) => error.message)).toEqual(["after"]);

    await page.clearPageErrors();
    expect(await page.pageErrors()).toEqual([]);
  });

  it("tracks recent requests history", async () => {
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

    adapter.emit("request", {
      url: "https://example.com/data",
      method: "GET",
      headers: []
    });
    adapter.emit("requestfinished", {
      url: "https://example.com/data",
      method: "GET",
      headers: []
    });

    const requests = await page.requests();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url()).toBe("https://example.com/data");
    expect(requests[0]!.method()).toBe("GET");
    expect(requests[0]!.headers()).toEqual({});
  });

  it("supports opener, workers and video object helpers", async () => {
    const adapter = createPageAdapterStub();
    const opener = new RoxyPage(createPageAdapterStub(), {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
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
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-video-"));
    const videoPath = join(directory, "video.webm");
    await writeFile(videoPath, "video");

    page.setOpener(opener);
    page.attachWorker();
    page.setVideoPath(videoPath);

    expect(await page.opener()).toBe(opener);
    expect(page.workers()).toHaveLength(1);
    expect(await page.video()?.path()).toBe(videoPath);
  });

  it("emits worker events and supports waitForEvent", async () => {
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
    const worker = new RoxyWorker("https://example.com/worker.js");
    const seen: Worker[] = [];
    page.on("worker", (eventWorker) => {
      seen.push(eventWorker);
    });

    const workerPromise = page.waitForEvent("worker");
    page.attachWorker(worker);

    await expect(workerPromise).resolves.toBe(worker);
    expect(seen).toEqual([worker]);
    expect(page.workers()).toEqual([worker]);
  });

  it("supports worker close events", async () => {
    const worker = new RoxyWorker("https://example.com/worker.js");
    const seen: Worker[] = [];
    worker.on("close", (eventWorker) => {
      seen.push(eventWorker);
    });

    const closePromise = worker.waitForEvent("close");
    worker.emitClose();

    await expect(closePromise).resolves.toBe(worker);
    expect(seen).toEqual([worker]);
  });

  it("supports Playwright page crash, download and websocket events", async () => {
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
    const download = {
      suggestedFilename: () => "example.txt",
      url: () => "https://example.com/example.txt"
    } as Download;
    const seen: Array<unknown> = [];
    const socketLog: string[] = [];

    page.on("crash", (crashedPage) => {
      seen.push(crashedPage);
    });
    page.on("download", (eventDownload) => {
      seen.push(eventDownload);
    });
    page.on("websocket", (eventWebSocket) => {
      seen.push(eventWebSocket);
      eventWebSocket.on("framesent", (data) => {
        socketLog.push(`sent:${data.payload.toString()}`);
      });
      eventWebSocket.on("framereceived", (data) => {
        socketLog.push(`received:${data.payload.toString()}`);
      });
      eventWebSocket.on("close", (closedWebSocket) => {
        socketLog.push(`close:${closedWebSocket.url()}:${closedWebSocket.isClosed()}`);
      });
    });

    const crashPromise = page.waitForEvent("crash");
    const downloadPromise = page.waitForEvent("download");
    const webSocketPromise = page.waitForEvent("websocket");

    adapter.emit("crash", undefined);
    adapter.emit("download", download);
    adapter.emit("websocket", {
      kind: "created",
      requestId: "ws-1",
      url: "wss://example.com/socket"
    });
    const webSocket = await webSocketPromise;
    const framePromise = webSocket.waitForEvent("framereceived");
    adapter.emit("websocket", {
      data: "outgoing",
      kind: "frameSent",
      opcode: 1,
      requestId: "ws-1"
    });
    adapter.emit("websocket", {
      data: "incoming",
      kind: "frameReceived",
      opcode: 1,
      requestId: "ws-1"
    });
    adapter.emit("websocket", {
      kind: "closed",
      requestId: "ws-1"
    });

    await expect(crashPromise).resolves.toBe(page);
    await expect(downloadPromise).resolves.toBe(download);
    expect(seen).toEqual([page, download, webSocket]);
    await expect(framePromise).resolves.toEqual({ payload: "incoming" });
    expect(socketLog).toEqual([
      "sent:outgoing",
      "received:incoming",
      "close:wss://example.com/socket:true"
    ]);
  });

  it("rejects pending video saveAs when the page closes externally", async () => {
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
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-video-abort-"));
    const videoPath = join(directory, "video.webm");
    const saveAsPath = join(directory, "saved.webm");
    await writeFile(videoPath, "video");
    let rejectFinished!: (error: unknown) => void;
    const finished = new Promise<void>((_, reject) => {
      rejectFinished = reject;
    });

    page.setVideo(new RoxyVideo(videoPath, finished), async () => {}, rejectFinished);

    const saveAsPromise = page.video()!.saveAs(saveAsPath);
    adapter.emit("close", undefined);

    await expect(saveAsPromise).rejects.toThrow("Target page, context or browser has been closed");
  });

  it("emulates media and installs state through init scripts", async () => {
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

    await page.emulateMedia({ media: "print", colorScheme: "dark" });

    expect(adapter.addInitScript).toHaveBeenCalledTimes(1);
    expect(adapter.evaluate).toHaveBeenCalledWith(expect.stringContaining("__roxyEmulatedMediaState"), {
      colorScheme: "dark",
      media: "print"
    }, true);
  });

  it("sets input files through element handle evaluation", async () => {
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
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-input-files-"));
    const filePath = join(directory, "hello.txt");
    await writeFile(filePath, "hello");

    const setInputFilesSpy = vi.spyOn(page.mainFrame(), "setInputFiles").mockResolvedValue(undefined);
    await page.setInputFiles("input[type=file]", filePath);
    await page.setInputFiles("input[type=file]", {
      name: "data.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"ok":true}')
    });

    expect(setInputFilesSpy).toHaveBeenNthCalledWith(1, "input[type=file]", filePath, undefined);
    expect(setInputFilesSpy).toHaveBeenNthCalledWith(2, "input[type=file]", {
      name: "data.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"ok":true}')
    }, undefined);
  });

  it("forwards page.dragAndDrop to the main frame", async () => {
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
    const dragAndDropSpy = vi.spyOn(page.mainFrame(), "dragAndDrop").mockResolvedValue(undefined);

    await page.dragAndDrop("#source", "#target", { trial: true });

    expect(dragAndDropSpy).toHaveBeenCalledWith("#source", "#target", { trial: true });
  });

  it("adds and removes locator handlers around locator actions", async () => {
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
    const overlay = page.getByRole("button", { name: "close" });
    const actionLocator = page.locator("#target");
    const handler = vi.fn(async () => {});
    vi.spyOn(overlay, "isVisible").mockResolvedValue(true);
    vi.spyOn(overlay, "isHidden").mockResolvedValue(true);

    await page.addLocatorHandler(overlay, handler, { times: 1 });
    await actionLocator.click();

    expect(handler).toHaveBeenCalledWith(overlay);

    await page.removeLocatorHandler(page.getByRole("button", { name: "close" }));
    await actionLocator.click();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("supports pickLocator cancellation and highlight cleanup", async () => {
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

    const pickPromise = page.pickLocator();
    await expect(page.cancelPickLocator()).resolves.toBeUndefined();
    await expect(pickPromise).rejects.toThrow("Locator picking was cancelled");

    await page.hideHighlight();
    expect(adapter.evaluate).toHaveBeenCalledWith(
      expect.stringContaining("data-roxy-highlight-overlay"),
      undefined,
      true
    );
  });

  it("resolves pickLocator on the next actioned locator", async () => {
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
    const locator = page.locator("#picked");

    const pickPromise = page.pickLocator();
    await locator.click();
    const picked = await pickPromise;

    expect(picked._roxySelectorChain?.()).toEqual([{ strategy: "css", value: "#picked" }]);
  });

  it("exposes functions into page context and supports dispose", async () => {
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

    const binding = await page.exposeFunction("compute", (a: number, b: number) => a * b);

    expect(adapter.addInitScript).toHaveBeenCalled();
    await binding.dispose();
    await expect(page.exposeFunction("compute", () => 1)).resolves.toBeTruthy();
  });

  it("rejects duplicate exposed function registrations", async () => {
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

    await page.exposeFunction("compute", () => 1);
    await expect(page.exposeFunction("compute", () => 2)).rejects.toThrow(
      'page.exposeFunction: Function "compute" has been already registered'
    );
  });

  it("exposes bindings with Playwright-style source", async () => {
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
    const callback = vi.fn((_source, a: number, b: number) => a + b);

    await page.exposeBinding("add", callback);

    expect(callback).not.toHaveBeenCalled();
    expect(adapter.addInitScript).toHaveBeenCalled();
  });

  it("removeAllListeners with ignoreErrors swallows async listener failures", async () => {
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
    let release!: () => void;
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });

    page.on("console", async () => {
      await unblock;
      throw new Error("Error in console handler");
    });

    adapter.emit("console", {
      args: () => [],
      location: () => ({
        column: 0,
        columnNumber: 0,
        line: 0,
        lineNumber: 0,
        url: ""
      }),
      page: () => null,
      text: () => "hello",
      timestamp: () => 1,
      type: () => "log",
      worker: () => null
    });

    await page.removeAllListeners("console", { behavior: "ignoreErrors" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("removeAllListeners with wait waits for async listeners", async () => {
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
    let release!: () => void;
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });
    let value = 0;

    page.on("console", async () => {
      await unblock;
      value = 42;
    });

    adapter.emit("console", {
      args: () => [],
      location: () => ({
        column: 0,
        columnNumber: 0,
        line: 0,
        lineNumber: 0,
        url: ""
      }),
      page: () => null,
      text: () => "hello",
      timestamp: () => 1,
      type: () => "log",
      worker: () => null
    });

    const removePromise = page.removeAllListeners("console", { behavior: "wait" });
    release();
    await removePromise;

    expect(value).toBe(42);
  });

  it("removeAllListeners with wait rethrows async listener failures", async () => {
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
    let release!: () => void;
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });

    page.on("console", async () => {
      await unblock;
      throw new Error("Error in handler");
    });

    adapter.emit("console", {
      args: () => [],
      location: () => ({
        column: 0,
        columnNumber: 0,
        line: 0,
        lineNumber: 0,
        url: ""
      }),
      page: () => null,
      text: () => "hello",
      timestamp: () => 1,
      type: () => "log",
      worker: () => null
    });

    const removePromise = page.removeAllListeners("console", { behavior: "wait" });
    release();
    await expect(removePromise).rejects.toThrow("Error in handler");
  });
});

async function createFakeFfmpeg(directory: string): Promise<string> {
  const ffmpegPath = join(directory, "fake-ffmpeg.sh");
  await writeFile(
    ffmpegPath,
    "#!/bin/sh\nout=\"\"\nfor arg in \"$@\"; do out=\"$arg\"; done\ncat > \"$out\"\n"
  );
  await chmod(ffmpegPath, 0o755);
  return ffmpegPath;
}
