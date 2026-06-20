import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoxyBrowserContext } from "../../src/browserContext.js";
import { RoxyPage } from "../../src/page.js";
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

  it("falls back to context websocket routes after page routes are cleared", async () => {
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
      id: "websocket:context-after-page-unroute",
      url: "wss://example.com/ws1",
      protocols: []
    });
    await (page as any).dispatchWebSocketEvent({
      id: "websocket:context-after-page-unroute",
      kind: "message",
      message: "request"
    });

    expect(decision).toEqual({ action: "mock" });
    expect(seen).toEqual(["context:request"]);
  });

  it("clears browser-context websocket routes when unrouteAll is called", async () => {
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
      id: "websocket:context-unroute-all",
      url: "wss://example.com/ws2",
      protocols: []
    });

    expect(decision).toEqual({ action: "passthrough" });
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
  const ffmpegPath = join(directory, "fake-ffmpeg.sh");
  await writeFile(
    ffmpegPath,
    "#!/bin/sh\nout=\"\"\nfor arg in \"$@\"; do out=\"$arg\"; done\ncat > \"$out\"\n"
  );
  await chmod(ffmpegPath, 0o755);
  return ffmpegPath;
}
