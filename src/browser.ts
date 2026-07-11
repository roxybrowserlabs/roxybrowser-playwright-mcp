import { resolve } from "node:path";
import { AssetManager } from "./assets/manager.js";
import { RoxyBrowserContext } from "./browserContext.js";
import { resolveHumanizationOptions } from "./human/profile.js";
import { normalizeExtraHTTPHeaders } from "./httpHeaders.js";
import type {
  ProtocolBrowserAdapter,
  ProtocolBrowserSession
} from "./protocol/adapter.js";
import type { Browser, BrowserContext, BrowserType, Page } from "./types/api.js";
import type { BrowserContextOptions } from "./types/options.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";

type BrowserEventName = 'context' | 'disconnected';

interface BrowserListenerEntry {
  original: (...args: any[]) => any;
  wrapped: (...args: any[]) => any;
}

const BROWSER_SESSION_CLOSE_TIMEOUT_MS = 5_000;

export class RoxyBrowser implements Browser {
  private readonly _contexts: BrowserContext[] = [];
  private readonly _listeners = new Map<BrowserEventName, Set<BrowserListenerEntry>>();
  private _connected = true;

  constructor(
    private readonly session: ProtocolBrowserSession,
    private readonly adapter: ProtocolBrowserAdapter,
    private readonly humanDefaults: ResolvedHumanizationOptions,
    private readonly _browserName: "chromium" | "firefox",
    private readonly _browserType: BrowserType,
    private readonly _version: string,
    private readonly assetManager = new AssetManager()
  ) {}

  on(event: 'context', listener: (context: BrowserContext) => any): this;
  on(event: 'disconnected', listener: (browser: Browser) => any): this;
  on(event: BrowserEventName, listener: (...args: any[]) => any): this {
    return this._addListenerInternal(event, listener);
  }

  once(event: 'context', listener: (context: BrowserContext) => any): this;
  once(event: 'disconnected', listener: (browser: Browser) => any): this;
  once(event: BrowserEventName, listener: (...args: any[]) => any): this {
    const wrapped = (payload: any) => {
      this._removeListenerInternal(event, listener);
      listener(payload);
    };
    this._ensureListenerSet(event).add({ original: listener, wrapped });
    return this;
  }

  addListener(event: 'context', listener: (context: BrowserContext) => any): this;
  addListener(event: 'disconnected', listener: (browser: Browser) => any): this;
  addListener(event: BrowserEventName, listener: (...args: any[]) => any): this {
    return this._addListenerInternal(event, listener);
  }

  removeListener(event: 'context', listener: (context: BrowserContext) => any): this;
  removeListener(event: 'disconnected', listener: (browser: Browser) => any): this;
  removeListener(event: BrowserEventName, listener: (...args: any[]) => any): this {
    return this._removeListenerInternal(event, listener);
  }

  off(event: 'context', listener: (context: BrowserContext) => any): this;
  off(event: 'disconnected', listener: (browser: Browser) => any): this;
  off(event: BrowserEventName, listener: (...args: any[]) => any): this {
    return this._removeListenerInternal(event, listener);
  }

  prependListener(event: 'context', listener: (context: BrowserContext) => any): this;
  prependListener(event: 'disconnected', listener: (browser: Browser) => any): this;
  prependListener(event: BrowserEventName, listener: (...args: any[]) => any): this {
    const entry: BrowserListenerEntry = { original: listener, wrapped: listener };
    const existing = this._listeners.get(event);
    if (!existing) {
      const s = new Set<BrowserListenerEntry>([entry]);
      this._listeners.set(event, s);
    } else {
      const s = new Set<BrowserListenerEntry>([entry, ...Array.from(existing)]);
      this._listeners.set(event, s);
    }
    return this;
  }

  removeAllListeners(type?: string): this {
    if (type === undefined) {
      this._listeners.clear();
    } else {
      this._listeners.delete(type as BrowserEventName);
    }
    return this;
  }

  browserType(): BrowserType {
    return this._browserType;
  }

  contexts(): BrowserContext[] {
    return [...this._contexts];
  }

  isConnected(): boolean {
    return this._connected;
  }

  version(): string {
    return this._version;
  }

  async newContext(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    const normalizedOptions: BrowserContextOptions = {
      acceptDownloads: options.acceptDownloads ?? true,
      downloadsDir: options.downloadsDir ?? this.assetManager.roots.downloadsDir,
      ...options,
      ...(options.extraHTTPHeaders
        ? { extraHTTPHeaders: normalizeExtraHTTPHeaders(options.extraHTTPHeaders) }
        : {}),
      ...(options.recordVideo
        ? {
            recordVideo: {
              ...options.recordVideo,
              ...(options.recordVideo.dir ? { dir: resolve(options.recordVideo.dir) } : {})
            }
          }
        : {})
    };
    const contextAdapter = await this.session.newContext(normalizedOptions);
    const context = new RoxyBrowserContext(
      contextAdapter,
      resolveHumanizationOptions(normalizedOptions.human, this.humanDefaults),
      normalizedOptions,
      this._browserName
    );
    this._contexts.push(context);
    context.on("close", () => {
      const index = this._contexts.indexOf(context);
      if (index !== -1) this._contexts.splice(index, 1);
    });
    this._emit('context', context);
    // Wait for the adapter's initial page discovery to complete before returning.
    // For CDP contexts this means waiting until all pre-existing tabs have been
    // attached and their page objects emitted to listeners, so context.pages()
    // is non-empty immediately after newContext() resolves.
    // The onPage listener is already registered above (via new RoxyBrowserContext),
    // so pages emitted during ready() will be captured correctly.
    await contextAdapter.ready?.();
    return context;
  }

  async newPage(options?: BrowserContextOptions): Promise<Page> {
    const context = await this.newContext(options);
    const page = await context.newPage();
    const roxyPage = page as Page & { setOwnedContext?: (context: BrowserContext) => void };
    if (typeof roxyPage.setOwnedContext === "function") {
      // Closing an owned page tears down its browser context, mirroring
      // Playwright. Other Page implementations fall back to a best-effort
      // close listener.
      roxyPage.setOwnedContext(context);
    } else {
      page.once('close', () => context.close().catch(() => {}));
    }
    return page;
  }

  async close(options?: { reason?: string }): Promise<void> {
    if (!this._connected) return;
    this._connected = false;
    try {
      await withCloseTimeout(this.session.close(), BROWSER_SESSION_CLOSE_TIMEOUT_MS);
    } finally {
      await this.adapter.close();
      this._emit('disconnected', this);
    }
  }

  private _addListenerInternal(event: BrowserEventName, listener: (...args: any[]) => any): this {
    this._ensureListenerSet(event).add({ original: listener, wrapped: listener });
    return this;
  }

  private _removeListenerInternal(event: BrowserEventName, listener: (...args: any[]) => any): this {
    const entries = this._listeners.get(event);
    if (!entries) return this;
    for (const entry of Array.from(entries)) {
      if (entry.original === listener) entries.delete(entry);
    }
    if (entries.size === 0) this._listeners.delete(event);
    return this;
  }

  private _ensureListenerSet(event: BrowserEventName): Set<BrowserListenerEntry> {
    const existing = this._listeners.get(event);
    if (existing) return existing;
    const created = new Set<BrowserListenerEntry>();
    this._listeners.set(event, created);
    return created;
  }

  private _emit(event: BrowserEventName, payload: BrowserContext | Browser): boolean {
    const entries = this._listeners.get(event);
    if (!entries?.size) return false;
    for (const entry of Array.from(entries)) entry.wrapped(payload);
    return true;
  }
}

async function withCloseTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out closing browser session after ${timeoutMs}ms.`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
