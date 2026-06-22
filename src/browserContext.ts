import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoxyAPIRequestContext } from "./apiRequestContext.js";
import { RoxyBrowserContextClockDelegate } from "./browserContextClock.js";
import { RoxyClock } from "./clock.js";
import { normalizeExtraHTTPHeaders } from "./httpHeaders.js";
import { RoxyPage } from "./page.js";
import type { RouteHandlerEntry, RouteMatcher } from "./routeHandler.js";
import { urlMatches } from "./urlMatch.js";
import { RoxyVideo } from "./video.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";
import type {
  ProtocolBrowserContextAdapter,
  ProtocolPageAdapter
} from "./protocol/adapter.js";
import type { BrowserContext, Clock, Dialog, Page, Request, Response } from "./types/api.js";
import type {
  BrowserContextEventListener,
  BrowserContextEventMap,
  BrowserContextEventName,
  BrowserContextEventPredicate,
  PageConsoleMessage
} from "./types/events.js";
import type { BrowserContextOptions, BrowserName, RecordVideoOptions } from "./types/options.js";

const DEFAULT_CONTEXT_EVENT_TIMEOUT_MS = 30_000;
const BUBBLED_PAGE_EVENTS = [
  "console",
  "dialog",
  "request",
  "requestfailed",
  "requestfinished",
  "response"
] as const;
type BubbledPageEvent = typeof BUBBLED_PAGE_EVENTS[number];

interface ContextListenerEntry<K extends BrowserContextEventName> {
  original: BrowserContextEventListener<K>;
  wrapped: BrowserContextEventListener<K>;
}

interface InternalPageAdapterMetadata {
  __roxyOpenerTargetId?: string | null;
  __roxyTargetId?: string;
}

interface WebSocketRouteHandlerEntry {
  matcher: string | RegExp | URLPattern | ((url: URL) => boolean);
  handler: (websocketroute: import("./types/api.js").WebSocketRoute) => Promise<any> | any;
}

export class RoxyBrowserContext implements BrowserContext {
  private readonly pageSet = new Set<RoxyPage>();
  private readonly pageByAdapter = new Map<ProtocolPageAdapter, RoxyPage>();
  private readonly adapterByPage = new WeakMap<RoxyPage, ProtocolPageAdapter>();
  private readonly pendingPageRegistrations = new Map<ProtocolPageAdapter, Promise<RoxyPage>>();
  private readonly emittedPages = new WeakSet<RoxyPage>();
  private readonly clockDelegate: RoxyBrowserContextClockDelegate;
  private readonly listeners = new Map<BrowserContextEventName, Set<ContextListenerEntry<BrowserContextEventName>>>();
  private readonly pageEventDisposers = new WeakMap<RoxyPage, Array<() => void>>();
  private readonly routeHandlers: RouteHandlerEntry[] = [];
  private readonly websocketRouteHandlers: WebSocketRouteHandlerEntry[] = [];
  private readonly routeMatcherIds = new WeakMap<object, string>();
  private readonly disposeAdapterPageListener: (() => void) | null;
  private closed = false;
  private nextRouteMatcherId = 0;
  private videoOutputDirPromise: Promise<string> | null = null;
  readonly clock: Clock;
  readonly request = new RoxyAPIRequestContext();

  constructor(
    private readonly adapter: ProtocolBrowserContextAdapter,
    private readonly humanDefaults: ResolvedHumanizationOptions,
    private readonly options: BrowserContextOptions = {},
    browserName: BrowserName = "chromium"
  ) {
    this.clockDelegate = new RoxyBrowserContextClockDelegate(browserName);
    this.clock = new RoxyClock(this.clockDelegate);
    this.disposeAdapterPageListener =
      this.adapter.onPage?.((pageAdapter, openerAdapter, hasWindowOpener) =>
        this.attachDiscoveredPage(
          pageAdapter,
          openerAdapter ?? null,
          hasWindowOpener ?? true
        )
      ) ?? null;
  }

  async newPage(): Promise<Page> {
    const pageAdapter = await this.adapter.newPage();
    const page = await this.registerPage(pageAdapter);
    this.emitPageEventOnce(page);
    return page;
  }

  async addCookies(cookies: ReadonlyArray<{
    name: string;
    value: string;
    url?: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
    partitionKey?: string;
  }>): Promise<void> {
    if (!this.adapter.addCookies) {
      throw new Error("Browser context cookies are not supported by this protocol adapter.");
    }
    await this.adapter.addCookies(cookies);
  }

  async cookies(urls?: string | ReadonlyArray<string>): Promise<Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
    partitionKey?: string;
  }>> {
    if (!this.adapter.cookies) {
      throw new Error("Browser context cookies are not supported by this protocol adapter.");
    }
    const normalizedUrls =
      urls === undefined ? undefined : Array.isArray(urls) ? [...urls] : [urls];
    return this.adapter.cookies(normalizedUrls);
  }

  async clearCookies(options?: {
    domain?: string | RegExp;
    name?: string | RegExp;
    path?: string | RegExp;
  }): Promise<void> {
    if (!this.adapter.clearCookies) {
      throw new Error("Browser context cookies are not supported by this protocol adapter.");
    }
    await this.adapter.clearCookies(options);
  }

  pages(): Page[] {
    return Array.from(this.pageSet);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.disposeAdapterPageListener?.();
      await Promise.all(
        Array.from(this.pageSet).map(async (page) => {
          await page.close();
        })
      );
    } finally {
      await this.request.dispose();
      await this.adapter.close();
      this.emit("close", this);
    }
  }

  async setExtraHTTPHeaders(headers: { [key: string]: string }): Promise<void> {
    await this.adapter.setExtraHTTPHeaders(normalizeExtraHTTPHeaders(headers));
  }

  async route(
    url: RouteMatcher,
    handler: (route: import("./types/api.js").Route, request: Request) => Promise<any> | any,
    options: { times?: number } = {}
  ): Promise<import("./types/api.js").Disposable> {
    this.routeHandlers.push({
      matcher: url,
      handler,
      activeInvocations: new Set(),
      ignoreExceptions: false,
      remainingTimes: options.times ?? null
    });
    await this.installRouteInterceptorsOnPages();
    return {
      dispose: async () => {
        const index = this.routeHandlers.findIndex((entry) => entry.matcher === url && entry.handler === handler);
        if (index >= 0) {
          this.routeHandlers.splice(index, 1);
        }
        await this.syncRouteInterceptionOnPages();
      }
    };
  }

  async routeWebSocket(
    url: string | RegExp | URLPattern | ((url: URL) => boolean),
    handler: (websocketroute: import("./types/api.js").WebSocketRoute) => Promise<any> | any
  ): Promise<void> {
    this.websocketRouteHandlers.push({
      matcher: url,
      handler
    });
    await this.installRouteInterceptorsOnPages();
  }

  async unroute(
    url: RouteMatcher,
    handler?: (route: import("./types/api.js").Route, request: Request) => Promise<any> | any
  ): Promise<void> {
    const removed: RouteHandlerEntry[] = [];
    for (let index = this.routeHandlers.length - 1; index >= 0; index -= 1) {
      const entry = this.routeHandlers[index];
      if (!entry) {
        continue;
      }
      if (this.routeMatcherKey(entry.matcher) !== this.routeMatcherKey(url)) {
        continue;
      }
      if (handler && entry.handler !== handler) {
        continue;
      }
      removed.push(entry);
      this.routeHandlers.splice(index, 1);
    }
    await this.stopRouteHandlers(removed, "default");
    await this.syncRouteInterceptionOnPages();
  }

  async unrouteAll(options?: {
    behavior?: "wait" | "ignoreErrors" | "default";
  }): Promise<void> {
    const removed = [...this.routeHandlers];
    this.routeHandlers.length = 0;
    await this.stopRouteHandlers(removed, options?.behavior ?? "default");
    await this.syncRouteInterceptionOnPages();
  }

  async storageState(options?: {
    indexedDB?: boolean;
    path?: string;
  }): Promise<{
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: "Strict" | "Lax" | "None";
    }>;
    origins: Array<{
      origin: string;
      localStorage: Array<{
        name: string;
        value: string;
      }>;
    }>;
  }> {
    return this.request.storageState(options);
  }

  detachPage(page: RoxyPage): void {
    this.pageSet.delete(page);
    const disposers = this.pageEventDisposers.get(page);
    if (disposers) {
      for (const dispose of disposers) {
        dispose();
      }
      this.pageEventDisposers.delete(page);
    }
    const adapter = this.adapterByPage.get(page);
    if (adapter) {
      this.pageByAdapter.delete(adapter);
      this.pendingPageRegistrations.delete(adapter);
      this.adapterByPage.delete(page);
    }
    this.clockDelegate.detachPage(page);
  }

  on<K extends BrowserContextEventName>(
    event: K,
    listener: BrowserContextEventListener<K>
  ): this {
    return this.addListener(event, listener);
  }

  once<K extends BrowserContextEventName>(
    event: K,
    listener: BrowserContextEventListener<K>
  ): this {
    const wrapped = ((payload: BrowserContextEventMap[K]) => {
      this.removeListener(event, listener);
      listener(payload);
    }) as BrowserContextEventListener<K>;
    const entries = this.ensureListenerSet(event);
    entries.add({
      original: listener as BrowserContextEventListener<BrowserContextEventName>,
      wrapped: wrapped as BrowserContextEventListener<BrowserContextEventName>
    });
    return this;
  }

  addListener<K extends BrowserContextEventName>(
    event: K,
    listener: BrowserContextEventListener<K>
  ): this {
    const entries = this.ensureListenerSet(event);
    entries.add({
      original: listener as BrowserContextEventListener<BrowserContextEventName>,
      wrapped: listener as BrowserContextEventListener<BrowserContextEventName>
    });
    return this;
  }

  removeListener<K extends BrowserContextEventName>(
    event: K,
    listener: BrowserContextEventListener<K>
  ): this {
    const entries = this.listeners.get(event);
    if (!entries) {
      return this;
    }
    for (const entry of Array.from(entries)) {
      if (entry.original === listener) {
        entries.delete(entry);
      }
    }
    if (entries.size === 0) {
      this.listeners.delete(event);
    }
    return this;
  }

  off<K extends BrowserContextEventName>(
    event: K,
    listener: BrowserContextEventListener<K>
  ): this {
    return this.removeListener(event, listener);
  }

  async waitForEvent<K extends BrowserContextEventName>(
    event: K,
    optionsOrPredicate?:
      | BrowserContextEventPredicate<K>
      | {
          predicate?: BrowserContextEventPredicate<K>;
          timeout?: number;
        }
  ): Promise<BrowserContextEventMap[K]> {
    const predicate =
      typeof optionsOrPredicate === "function"
        ? optionsOrPredicate
        : optionsOrPredicate?.predicate;
    const timeout =
      typeof optionsOrPredicate === "function"
        ? DEFAULT_CONTEXT_EVENT_TIMEOUT_MS
        : optionsOrPredicate?.timeout ?? DEFAULT_CONTEXT_EVENT_TIMEOUT_MS;

    return new Promise<BrowserContextEventMap[K]>((resolve, reject) => {
      const timer =
        timeout === 0
          ? null
          : setTimeout(() => {
              cleanup();
              reject(new Error(`Timeout ${timeout}ms exceeded while waiting for event "${String(event)}"`));
            }, timeout);
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
        }
        this.removeListener(event, listener);
        if (event !== "close") {
          this.removeListener("close", closeListener as BrowserContextEventListener<"close">);
        }
      };
      const closeListener = (() => {
        cleanup();
        reject(new Error("Browser context has been closed."));
      }) as BrowserContextEventListener<"close">;
      const listener = (async (payload: BrowserContextEventMap[K]) => {
        try {
          if (predicate && !(await predicate(payload))) {
            return;
          }
          cleanup();
          resolve(payload);
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }) as BrowserContextEventListener<K>;

      if (event !== "close") {
        this.on("close", closeListener);
      }
      this.on(event, listener);
    });
  }

  private async attachDiscoveredPage(
    pageAdapter: ProtocolPageAdapter,
    openerAdapter: ProtocolPageAdapter | null,
    hasWindowOpener: boolean
  ): Promise<void> {
    const page = await this.registerPage(pageAdapter);
    const resolvedOpenerAdapter =
      openerAdapter ?? await this.resolvePageAdapterByTargetId(this.openerTargetIdOf(pageAdapter));
    const opener = resolvedOpenerAdapter
      ? await this.registerPage(resolvedOpenerAdapter)
      : hasWindowOpener
        ? this.resolveFallbackPopupOpener(page)
        : null;
    if (!opener) {
      this.emitPageEventOnce(page);
      return;
    }
    if (opener === page) {
      return;
    }

    page.setOpener(hasWindowOpener ? opener : null);
    this.emitPageEventOnce(page);
    opener.emitPopup(page);
  }

  private async registerPage(pageAdapter: ProtocolPageAdapter): Promise<RoxyPage> {
    const pending = this.pendingPageRegistrations.get(pageAdapter);
    if (pending) {
      return pending;
    }

    const existing = this.pageByAdapter.get(pageAdapter);
    if (existing) {
      return existing;
    }

    const registration = this.createPage(pageAdapter);
    this.pendingPageRegistrations.set(pageAdapter, registration);
    try {
      return await registration;
    } finally {
      this.pendingPageRegistrations.delete(pageAdapter);
    }
  }

  private async createPage(pageAdapter: ProtocolPageAdapter): Promise<RoxyPage> {
    const page = new RoxyPage(pageAdapter, this.humanDefaults, this, this.options);
    this.pageSet.add(page);
    this.pageByAdapter.set(pageAdapter, page);
    this.adapterByPage.set(page, pageAdapter);
    this.attachPageEventBubbling(page);

    try {
      await page._ensurePlaywrightBuiltinsInstalled();
      await this.clockDelegate.attachPage(page);
      if (this.options.recordVideo) {
        await this.enableRecordVideo(page, this.options.recordVideo);
      }
      if (this._hasRouteInterception()) {
        await page._ensureRouteInterceptorsInstalled();
      }
      return page;
    } catch (error) {
      if (isClosedPageRegistrationError(error)) {
        return page;
      }
      this.pageSet.delete(page);
      this.pageByAdapter.delete(pageAdapter);
      this.adapterByPage.delete(page);
      this.clockDelegate.detachPage(page);
      throw error;
    }
  }

  private emitPageEventOnce(page: RoxyPage): void {
    if (this.emittedPages.has(page)) {
      return;
    }
    this.emittedPages.add(page);
    this.emit("page", page);
  }

  private async enableRecordVideo(page: RoxyPage, options: RecordVideoOptions): Promise<void> {
    const directory = await this.resolveVideoOutputDirectory(options.dir);
    const videoPath = join(directory, `${randomUUID()}.webm`);
    const videoSize = options.size ?? this.deriveDefaultRecordVideoSize();
    let resolveFinished!: () => void;
    let rejectFinished!: (error: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    const video = new RoxyVideo(videoPath, finished);
    page.setVideo(video);

    try {
      const recording = await page.startVideoRecording({
        path: videoPath,
        size: videoSize,
        ...(options.showActions ? { showActions: options.showActions } : {})
      });

      page.setVideo(video, async () => {
        try {
          await recording.dispose();
          resolveFinished();
        } catch (error) {
          rejectFinished(error);
          throw error;
        }
      }, rejectFinished);
    } catch (error) {
      page.setVideo(null);
      rejectFinished(error);
      throw error;
    }
  }

  private async resolveVideoOutputDirectory(configuredDirectory?: string): Promise<string> {
    if (configuredDirectory) {
      return configuredDirectory;
    }
    if (!this.videoOutputDirPromise) {
      this.videoOutputDirPromise = mkdtemp(join(tmpdir(), "roxy-videos-"));
    }
    return this.videoOutputDirPromise;
  }

  private deriveDefaultRecordVideoSize(): { width: number; height: number } {
    if (Object.prototype.hasOwnProperty.call(this.options, "viewport") && this.options.viewport === null) {
      return {
        width: 800,
        height: 600
      };
    }

    if (this.options.viewport) {
      const scale = Math.min(1, 800 / Math.max(this.options.viewport.width, this.options.viewport.height));
      return {
        width: Math.max(2, Math.floor(this.options.viewport.width * scale)) & ~1,
        height: Math.max(2, Math.floor(this.options.viewport.height * scale)) & ~1
      };
    }

    return {
      width: 800,
      height: 450
    };
  }

  private async resolvePageAdapterByTargetId(targetId: string | null | undefined): Promise<ProtocolPageAdapter | null> {
    if (!targetId) {
      return null;
    }

    for (const adapter of this.pageByAdapter.keys()) {
      if (this.targetIdOf(adapter) === targetId) {
        return adapter;
      }
    }

    for (const adapter of this.pendingPageRegistrations.keys()) {
      if (this.targetIdOf(adapter) === targetId) {
        return adapter;
      }
    }

    return null;
  }

  private openerTargetIdOf(pageAdapter: ProtocolPageAdapter): string | null | undefined {
    return (pageAdapter as ProtocolPageAdapter & InternalPageAdapterMetadata).__roxyOpenerTargetId;
  }

  private targetIdOf(pageAdapter: ProtocolPageAdapter): string | undefined {
    return (pageAdapter as ProtocolPageAdapter & InternalPageAdapterMetadata).__roxyTargetId;
  }

  private resolveFallbackPopupOpener(page: RoxyPage): RoxyPage | null {
    const candidates = Array.from(this.pageSet).filter((candidate) => candidate !== page);
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  }

  private ensureListenerSet<K extends BrowserContextEventName>(
    event: K
  ): Set<ContextListenerEntry<BrowserContextEventName>> {
    const existing = this.listeners.get(event);
    if (existing) {
      return existing;
    }
    const created = new Set<ContextListenerEntry<BrowserContextEventName>>();
    this.listeners.set(event, created);
    return created;
  }

  private emit<K extends BrowserContextEventName>(
    event: K,
    payload: BrowserContextEventMap[K]
  ): boolean {
    const entries = this.listeners.get(event);
    if (!entries?.size) {
      return false;
    }
    for (const entry of Array.from(entries)) {
      const listener = entry.wrapped as BrowserContextEventListener<K>;
      listener(payload);
    }
    return true;
  }

  shouldAutoHandleDialog(_page: RoxyPage): boolean {
    return (this.listeners.get("dialog")?.size ?? 0) === 0;
  }

  private attachPageEventBubbling(page: RoxyPage): void {
    const disposers: Array<() => void> = [];
    for (const event of BUBBLED_PAGE_EVENTS) {
      const listener = ((payload: PageConsoleMessage | Dialog | Request | Response) => {
        this.emit(event, payload as BrowserContextEventMap[typeof event]);
      }) as (...args: any[]) => any;
      disposers.push(
        page.attachInternalListener(event, listener as never)
      );
    }
    this.pageEventDisposers.set(page, disposers);
  }

  async _onWebSocketRoute(websocketroute: import("./types/api.js").WebSocketRoute): Promise<boolean> {
    for (let index = this.websocketRouteHandlers.length - 1; index >= 0; index -= 1) {
      const entry = this.websocketRouteHandlers[index];
      if (!entry || !this.matchesWebSocketRoute(websocketroute.url(), entry.matcher)) {
        continue;
      }

      await entry.handler(websocketroute);
      return true;
    }

    return false;
  }

  _hasRequestRoutes(): boolean {
    return this.routeHandlers.length > 0;
  }

  _hasRouteInterception(): boolean {
    return this.routeHandlers.length > 0 || this.websocketRouteHandlers.length > 0;
  }

  _contextRouteHandlers(): RouteHandlerEntry[] {
    return [...this.routeHandlers];
  }

  _findLiveContextRouteHandlerIndex(entry: RouteHandlerEntry): number {
    return this.routeHandlers.indexOf(entry);
  }

  _consumeContextRouteHandler(entry: RouteHandlerEntry, liveIndex: number): void {
    if (entry.remainingTimes !== null && entry.remainingTimes <= 1) {
      this.routeHandlers.splice(liveIndex, 1);
    } else if (entry.remainingTimes !== null) {
      entry.remainingTimes -= 1;
    }
  }

  _matchesRouteMatcher(url: string, matcher: RouteMatcher): boolean {
    if (url.startsWith("data:")) {
      return false;
    }
    const normalizedUrl = tryParseUrl(url)?.toString() ?? url;
    return urlMatches(this.options.baseURL, normalizedUrl, matcher, true);
  }

  private matchesWebSocketRoute(
    url: string,
    matcher: string | RegExp | URLPattern | ((url: URL) => boolean)
  ): boolean {
    const normalizedUrl = tryParseUrl(url)?.toString() ?? url;
    return urlMatches(this.options.baseURL, normalizedUrl, matcher, true);
  }

  private async installRouteInterceptorsOnPages(): Promise<void> {
    await Promise.all(Array.from(this.pageSet, async (page) => page._ensureRouteInterceptorsInstalled()));
  }

  private async syncRouteInterceptionOnPages(): Promise<void> {
    await Promise.all(Array.from(this.pageSet, async (page) => page._syncRouteInterceptionForContext()));
  }

  private async stopRouteHandlers(
    entries: RouteHandlerEntry[],
    behavior: "wait" | "ignoreErrors" | "default"
  ): Promise<void> {
    if (behavior === "ignoreErrors") {
      for (const entry of entries) {
        entry.ignoreExceptions = true;
        for (const invocation of entry.activeInvocations) {
          invocation.resolve();
        }
      }
      return;
    }

    if (behavior === "wait") {
      await Promise.all(
        entries.flatMap((entry) => Array.from(entry.activeInvocations, (invocation) => invocation.complete))
      );
    }
  }

  private routeMatcherKey(matcher: RouteMatcher): string {
    if (typeof matcher === "string") {
      return `string:${matcher}`;
    }
    if (matcher instanceof RegExp) {
      return `regexp:${matcher.source}/${matcher.flags}`;
    }

    const existing = this.routeMatcherIds.get(matcher as object);
    if (existing) {
      return existing;
    }

    const id = `matcher:${++this.nextRouteMatcherId}`;
    this.routeMatcherIds.set(matcher as object, id);
    return id;
  }
}

function tryParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isClosedPageRegistrationError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes("target page, context or browser has been closed")
    || message.includes("browser context has been closed")
    || message.includes("session closed")
    || message.includes("connection closed")
    || message.includes("target closed")
  );
}
