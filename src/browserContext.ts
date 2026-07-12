import { STATUS_CODES } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiResponse, fetchWithRetries, RoxyAPIRequestContext } from "./apiRequestContext.js";
import { RoxyBrowserContextClockDelegate } from "./browserContextClock.js";
import { RoxyClock } from "./clock.js";
import { TimeoutError } from "./errors.js";
import { normalizeExtraHTTPHeaders } from "./httpHeaders.js";
import { RoxyPage } from "./page.js";
import { serializePageFunction } from "./evaluation.js";
import type { RouteHandlerEntry, RouteMatcher } from "./routeHandler.js";
import { urlMatches } from "./urlMatch.js";
import { RoxyVideo } from "./video.js";
import type {
  ProtocolBrowserContextAdapter,
  ProtocolPageAdapter
} from "./protocol/adapter.js";
import type { BrowserContext, Clock, Dialog, Page, Request, Response } from "./types/api.js";
import type { Disposable, PageFunction } from "./types/api.js";
import type {
  BrowserContextEventListener,
  BrowserContextEventMap,
  BrowserContextEventName,
  BrowserContextEventPredicate,
  PageConsoleMessage
} from "./types/events.js";
import type { BrowserContextOptions, BrowserName, RecordVideoOptions } from "./types/options.js";
import type { Route } from "./types/api.js";
import type { PageResponse } from "./types/events.js";
import type { RoutedRequestCall, RoutedRequestDecision } from "./protocol/routing.js";

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

interface ContextInitScriptEntry {
  source: string;
  disposablesByPage: WeakMap<RoxyPage, Disposable>;
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
  private readonly initScripts = new Set<ContextInitScriptEntry>();
  private readonly routeMatcherIds = new WeakMap<object, string>();
  private readonly disposeAdapterPageListener: (() => void) | null;
  private closed = false;
  private nextRouteMatcherId = 0;
  private videoOutputDirPromise: Promise<string> | null = null;
  readonly clock: Clock;
  readonly request = new RoxyAPIRequestContext();

  constructor(
    private readonly adapter: ProtocolBrowserContextAdapter,
    _unusedSecondArgument?: unknown,
    private readonly options: BrowserContextOptions = {},
    browserName: BrowserName = "chromium"
  ) {
    void _unusedSecondArgument;
    this.clockDelegate = new RoxyBrowserContextClockDelegate(this, browserName);
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

  async addInitScript<Arg>(
    script: PageFunction<Arg, any> | { path?: string; content?: string },
    arg?: Arg
  ): Promise<Disposable> {
    const source = await evaluationScript(script, arg as any);
    if (this.adapter.addInitScript) {
      return this.adapter.addInitScript(source);
    }
    const entry: ContextInitScriptEntry = {
      source,
      disposablesByPage: new WeakMap<RoxyPage, Disposable>()
    };
    this.initScripts.add(entry);
    await Promise.all(Array.from(this.pageSet, async (page) => {
      const disposable = await page.addInitScript(source);
      entry.disposablesByPage.set(page, disposable);
    }));
    const dispose = async () => {
      if (!this.initScripts.delete(entry)) {
        return;
      }
      await Promise.all(Array.from(this.pageSet, async (page) => {
        await entry.disposablesByPage.get(page)?.dispose();
      }));
    };
    return {
      dispose,
      [Symbol.asyncDispose]: dispose
    };
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
    const dispose = async () => {
      const index = this.routeHandlers.findIndex((entry) => entry.matcher === url && entry.handler === handler);
      if (index >= 0) {
        this.routeHandlers.splice(index, 1);
      }
      await this.syncRouteInterceptionOnPages();
    };
    return {
      dispose,
      [Symbol.asyncDispose]: dispose
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
    const pageRegistration = this.registerPage(pageAdapter);
    const page = await pageRegistration;
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
    await pageRegistration;
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
    const page = new RoxyPage(pageAdapter, undefined, this, this.options);
    this.pageSet.add(page);
    this.pageByAdapter.set(pageAdapter, page);
    this.adapterByPage.set(page, pageAdapter);
    this.attachPageEventBubbling(page);
    try {
      for (const entry of this.initScripts) {
        const disposable = await page.addInitScript(entry.source);
        entry.disposablesByPage.set(page, disposable);
      }
      await page._ensurePlaywrightBuiltinsInstalled().catch((error) => {
        if (isClosedPageRegistrationError(error)) {
          return;
        }
        throw error;
      });
      await this.clockDelegate.attachPage(page).catch((error) => {
        if (isClosedPageRegistrationError(error)) {
          return;
        }
        throw error;
      });
      if (this.options.recordVideo) {
        await this.enableRecordVideo(page, this.options.recordVideo).catch((error) => {
          if (isClosedPageRegistrationError(error)) {
            return;
          }
          throw error;
        });
      }
      if (this._hasRouteInterception()) {
        await page._ensureRouteInterceptorsInstalled().catch((error) => {
          if (isClosedPageRegistrationError(error)) {
            return;
          }
          throw error;
        });
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

  _hasWebSocketRoutes(): boolean {
    return this.websocketRouteHandlers.length > 0;
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

  _buildRouteFulfillDecision(
    request: RoutedRequestCall,
    options: {
      body?: string | Buffer;
      contentType?: string;
      headers?: { [key: string]: string };
      json?: unknown;
      path?: string;
      response?: import("./types/api.js").APIResponse | Response | PageResponse;
      status?: number;
    }
  ): Promise<Extract<RoutedRequestDecision, { action: "fulfill" }>> {
    return buildFulfillDecision(request, options);
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
    if (this.adapter.setRequestInterceptor) {
      await this.adapter.setRequestInterceptor((call) => this.dispatchContextRoutedRequest(call));
      return;
    }
    await Promise.all(Array.from(this.pageSet, async (page) => page._ensureRouteInterceptorsInstalled()));
  }

  private async syncRouteInterceptionOnPages(): Promise<void> {
    if (this.adapter.setRequestInterceptor) {
      await this.adapter.setRequestInterceptor(
        this._hasRequestRoutes() ? (call) => this.dispatchContextRoutedRequest(call) : null
      );
      return;
    }
    await Promise.all(Array.from(this.pageSet, async (page) => page._syncRouteInterceptionForContext()));
  }

  private async dispatchContextRoutedRequest(call: RoutedRequestCall): Promise<RoutedRequestDecision> {
    let requestState: RoutedRequestCall = {
      ...call,
      headers: normalizeHeaderRecord(call.headers)
    };

    let routedResponse: Response | null = null;
    let routedFailure: { errorText: string } | null = null;
    const request = createContextRouteRequest(
      () => requestState,
      () => routedResponse,
      () => routedFailure
    );
    const handlers = [...this.routeHandlers];

    for (let index = handlers.length - 1; index >= 0; index -= 1) {
      const entry = handlers[index];
      if (!entry || !this._matchesRouteMatcher(requestState.url, entry.matcher)) {
        continue;
      }
      const liveIndex = this._findLiveContextRouteHandlerIndex(entry);
      if (liveIndex === -1) {
        continue;
      }
      this._consumeContextRouteHandler(entry, liveIndex);

      type RouteOutcome =
        | { kind: "fallback" }
        | { kind: "finish"; decision: RoutedRequestDecision };
      let routeOutcome: RouteOutcome | null = null;
      let routeHandled = false;
      let resolveRouteHandled!: (value: RouteOutcome) => void;
      const routeHandledPromise = new Promise<RouteOutcome>((resolve) => {
        resolveRouteHandled = resolve;
      });

      const ensureRouteIsUnhandled = () => {
        if (routeHandled) {
          throw new Error("Route is already handled!");
        }
      };

      const reportRouteHandled = (outcome: RouteOutcome) => {
        routeOutcome ??= outcome;
        resolveRouteHandled(routeOutcome);
      };

      const route: Route = {
        abort: async (errorCode?: string) => {
          ensureRouteIsUnhandled();
          routeHandled = true;
          routedFailure = { errorText: errorCode ?? "failed" };
          reportRouteHandled({
            kind: "finish",
            decision: {
              action: "abort",
              ...(errorCode !== undefined ? { errorCode } : {})
            }
          });
        },
        continue: async (options) => {
          ensureRouteIsUnhandled();
          routeHandled = true;
          requestState = applyContextRouteOverrides(requestState, options);
          reportRouteHandled({
            kind: "finish",
            decision: {
              action: "continue",
              headers: { ...requestState.headers },
              method: requestState.method,
              ...serializePostDataFields(
                requestState.postData,
                deserializeSerializedPostData(
                  requestState.postData,
                  requestState.postDataBufferBase64 ?? null
                ).buffer
              ),
              url: requestState.url
            }
          });
        },
        fallback: async (options) => {
          ensureRouteIsUnhandled();
          routeHandled = true;
          requestState = applyContextRouteOverrides(requestState, options);
          reportRouteHandled({ kind: "fallback" });
        },
        fetch: async (options) => {
          ensureRouteIsUnhandled();
          const fetchedRequest = applyContextRouteOverrides(requestState, options);
          const response = await fetchContextRouteRequest(fetchedRequest, options);
          routedResponse = createRoutedResponse(await responseDataFromResponse(response), request);
          return response;
        },
        fulfill: async (options = {}) => {
          ensureRouteIsUnhandled();
          const decision = await this._buildRouteFulfillDecision(requestState, options);
          routeHandled = true;
          routedResponse = createRoutedResponse(
            {
              body: decision.body,
              ...(decision.bodyBufferBase64 != null
                ? { bodyBufferBase64: decision.bodyBufferBase64 }
                : {}),
              headers: { ...decision.headers },
              status: decision.status,
              statusText: decision.statusText,
              url: decision.url
            },
            request
          );
          reportRouteHandled({
            kind: "finish",
            decision
          });
        },
        request: () => request
      };

      let resolveInvocation!: () => void;
      const invocation = {
        complete: new Promise<void>((resolve) => {
          resolveInvocation = resolve;
        }),
        resolve: () => {
          resolveInvocation();
        }
      };
      entry.activeInvocations.add(invocation);
      let resolvedOutcome: RouteOutcome | null = null;
      try {
        const [handledOutcome] = await Promise.all([
          routeHandledPromise,
          Promise.resolve().then(() => entry.handler(route, request))
        ]);
        resolvedOutcome = handledOutcome;
      } catch (error) {
        if (!entry.ignoreExceptions) {
          throw error;
        }
        resolvedOutcome = routeOutcome;
      } finally {
        invocation.resolve();
        entry.activeInvocations.delete(invocation);
      }

      if (!resolvedOutcome) {
        continue;
      }
      if (resolvedOutcome.kind === "fallback") {
        continue;
      }

      return resolvedOutcome.decision;
    }

    return {
      action: "continue",
      headers: { ...requestState.headers },
      method: requestState.method,
      ...serializePostDataFields(
        requestState.postData,
        deserializeSerializedPostData(
          requestState.postData,
          requestState.postDataBufferBase64 ?? null
        ).buffer
      ),
      url: requestState.url
    };
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
    || message.includes("session with given id not found")
    || message.includes("connection closed")
    || message.includes("target closed")
    || message.includes("websocket connection closed")
    || message.includes("write epipe")
  );
}

async function evaluationScript<Arg>(
  script: string | ((arg: Arg) => unknown) | { path?: string; content?: string },
  arg?: Arg
): Promise<string> {
  if (typeof script === "function") {
    const source = serializePageFunction(script as unknown as (arg: unknown) => unknown);
    const argString = Object.is(arg, undefined) ? "undefined" : JSON.stringify(arg);
    return `(${source})(${argString})`;
  }
  if (arg !== undefined) {
    throw new Error("Cannot evaluate a string with arguments");
  }
  if (typeof script === "string") {
    return script;
  }
  if (script.content !== undefined) {
    return script.content;
  }
  if (script.path !== undefined) {
    const source = await readFile(script.path, "utf8");
    return `${source}\n//# sourceURL=${script.path.replace(/\n/g, "")}`;
  }
  throw new Error("Either path or content property must be present");
}

function applyContextRouteOverrides(
  request: RoutedRequestCall,
  options?: {
    headers?: { [key: string]: string } | Array<{ name: string; value: string }>;
    method?: string;
    postData?: string | Buffer | unknown;
    url?: string;
  }
): RoutedRequestCall {
  if (!options) {
    return request;
  }
  const headers =
    options.headers === undefined
      ? request.headers
      : Array.isArray(options.headers)
        ? Object.fromEntries(options.headers.map((header) => [header.name, header.value]))
        : { ...options.headers };
  const normalizedPostData = options.postData !== undefined
    ? normalizeSerializedPostData(options.postData)
    : deserializeSerializedPostData(request.postData, request.postDataBufferBase64 ?? null);
  return {
    ...request,
    headers,
    method: options.method ?? request.method,
    ...serializePostDataFields(normalizedPostData.text, normalizedPostData.buffer),
    url: options.url ?? request.url
  };
}

function normalizeSerializedPostData(value: string | Buffer | unknown): {
  buffer: Buffer | null;
  text: string | null;
} {
  if (value === undefined || value === null) {
    return { buffer: null, text: null };
  }
  if (typeof value === "string") {
    return {
      buffer: Buffer.from(value, "utf8"),
      text: value
    };
  }
  if (Buffer.isBuffer(value)) {
    return {
      buffer: Buffer.from(value),
      text: value.toString("utf8")
    };
  }

  const text = JSON.stringify(value);
  return {
    buffer: Buffer.from(text, "utf8"),
    text
  };
}

function deserializeSerializedPostData(
  text: string | null,
  base64: string | null
): {
  buffer: Buffer | null;
  text: string | null;
} {
  if (base64 !== null) {
    const buffer = Buffer.from(base64, "base64");
    return {
      buffer,
      text: text ?? buffer.toString("utf8")
    };
  }
  if (text === null) {
    return { buffer: null, text: null };
  }
  return {
    buffer: Buffer.from(text, "utf8"),
    text
  };
}

function serializePostDataFields(
  text: string | null,
  buffer: Buffer | null
): {
  postData: string | null;
  postDataBufferBase64?: string;
} {
  return {
    postData: text,
    ...(buffer ? { postDataBufferBase64: buffer.toString("base64") } : {})
  };
}

function createContextRouteRequest(
  current: () => RoutedRequestCall,
  currentResponse: () => Response | null,
  currentFailure: () => { errorText: string } | null
): Request {
  return {
    allHeaders: async () => ({ ...current().headers }),
    existingResponse: () => currentResponse(),
    failure: () => currentFailure(),
    frame: () => {
      throw new Error("Request.frame is not available for context-level protocol interception.");
    },
    headers: () => ({ ...current().headers }),
    headersArray: async () =>
      Object.entries(current().headers).map(([name, value]) => ({ name, value })),
    headerValue: async (name: string) => current().headers[name.toLowerCase()] ?? null,
    isNavigationRequest: () => current().isNavigationRequest ?? false,
    method: () => current().method,
    postData: () => deserializeSerializedPostData(
      current().postData,
      current().postDataBufferBase64 ?? null
    ).text,
    postDataBuffer: () => {
      const buffer = deserializeSerializedPostData(
        current().postData,
        current().postDataBufferBase64 ?? null
      ).buffer;
      return buffer ? Buffer.from(buffer) : null;
    },
    postDataJSON: () => {
      const { text } = deserializeSerializedPostData(
        current().postData,
        current().postDataBufferBase64 ?? null
      );
      if (text === null) {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    redirectedFrom: () => null,
    redirectedTo: () => null,
    resourceType: () => current().resourceType ?? "fetch",
    response: async () => currentResponse(),
    serviceWorker: () => null,
    sizes: async () => {
      const response = currentResponse();
      const requestBody = deserializeSerializedPostData(
        current().postData,
        current().postDataBufferBase64 ?? null
      ).buffer;
      const responseHeaders = response ? await response.allHeaders() : {};
      return {
        requestBodySize: requestBody?.byteLength ?? 0,
        requestHeadersSize: headerSize(current().headers),
        responseBodySize: response ? await measureResponseBodySize(response) : 0,
        responseHeadersSize: headerSize(responseHeaders)
      };
    },
    timing: () => ({
      startTime: Date.now(),
      domainLookupStart: -1,
      domainLookupEnd: -1,
      connectStart: -1,
      secureConnectionStart: -1,
      connectEnd: -1,
      requestStart: 0,
      responseStart: -1,
      responseEnd: -1
    }),
    url: () => current().url
  };
}

async function fetchContextRouteRequest(
  request: RoutedRequestCall,
  options?: {
    headers?: { [key: string]: string };
    maxRedirects?: number;
    maxRetries?: number;
    method?: string;
    postData?: string | Buffer | unknown;
    timeout?: number;
    url?: string;
  }
): Promise<import("./types/api.js").APIResponse> {
  const fetchRequest = applyContextRouteOverrides(request, options);
  const requestBody = deserializeSerializedPostData(
    fetchRequest.postData,
    fetchRequest.postDataBufferBase64 ?? null
  ).buffer;
  const headers = { ...fetchRequest.headers };
  if (options?.postData !== undefined && headers["content-type"] === undefined) {
    if (Buffer.isBuffer(options.postData)) {
      headers["content-type"] = "application/octet-stream";
    } else if (
      typeof options.postData === "object" &&
      options.postData !== null &&
      !Buffer.isBuffer(options.postData)
    ) {
      headers["content-type"] = "application/json";
    }
  }
  const controller = new AbortController();
  const timeout = options?.timeout ?? DEFAULT_CONTEXT_EVENT_TIMEOUT_MS;
  const timeoutHandle =
    timeout > 0
      ? setTimeout(() => controller.abort(new TimeoutError(`route.fetch: Timeout ${timeout}ms exceeded`)), timeout)
      : null;

  try {
    const response = await fetchWithRetries(fetchRequest.url, {
      allowGetOrHeadBody: true,
      ...(!requestBody ? {} : { body: requestBody }),
      headers,
      method: fetchRequest.method,
      signal: controller.signal,
      ...(options?.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}),
      ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {})
    });
    return createApiResponse(response);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function bufferToText(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function normalizeHeaderRecord(
  headers: Record<string, string>
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
}

function hasExplicitHeader(
  headers: Record<string, string> | undefined,
  name: string
): boolean {
  if (!headers) {
    return false;
  }
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === name.toLowerCase());
}

function statusTextForCode(status: number): string {
  return STATUS_CODES[status] ?? "Unknown";
}

function inferMimeType(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".txt")) return "text/plain";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function headerSize(headers: Record<string, string>): number {
  return Object.entries(headers).reduce(
    (size, [name, value]) => size + Buffer.byteLength(`${name}: ${value}\r\n`, "utf8"),
    2
  );
}

async function measureResponseBodySize(response: Response): Promise<number> {
  const body = await response.body();
  return body ? body.length : 0;
}

function createRoutedResponse(
  data: {
    body: string;
    bodyBufferBase64?: string;
    headers: Record<string, string>;
    status: number;
    statusText: string;
    url: string;
  },
  request: Request
): Response {
  const body = data.bodyBufferBase64 !== undefined
    ? Buffer.from(data.bodyBufferBase64, "base64")
    : Buffer.from(data.body, "utf8");
  return {
    allHeaders: async () => ({ ...data.headers }),
    body: async () => Buffer.from(body),
    finished: async () => null,
    frame: () => {
      throw new Error("Response.frame is not available for context-level protocol interception.");
    },
    fromServiceWorker: () => false,
    headerValue: async (name: string) => data.headers[name.toLowerCase()] ?? null,
    headerValues: async (name: string) => {
      const value = data.headers[name.toLowerCase()];
      return value === undefined ? [] : [value];
    },
    headers: () => ({ ...data.headers }),
    headersArray: async () =>
      Object.entries(data.headers).map(([name, value]) => ({ name, value })),
    httpVersion: async () => "HTTP/1.1",
    json: async () => JSON.parse(body.toString("utf8")),
    ok: () => data.status >= 200 && data.status <= 299,
    request: () => request,
    securityDetails: async () => null,
    serverAddr: async () => null,
    status: () => data.status,
    statusText: () => data.statusText,
    text: async () => body.toString("utf8"),
    url: () => data.url
  };
}

async function responseDataFromResponse(
  response: Response | import("./types/api.js").APIResponse
): Promise<{
  body: string;
  bodyBufferBase64?: string;
  headers: Record<string, string>;
  status: number;
  statusText: string;
  url: string;
}> {
  const bodyBuffer = await responseBodyBuffer(response);
  return {
    body: bodyBuffer.toString("utf8"),
    ...(bodyBuffer.length ? { bodyBufferBase64: bodyBuffer.toString("base64") } : {}),
    headers: normalizeHeaderRecord(await responseHeadersRecord(response)),
    status: getResponseStatus(response),
    statusText: getResponseStatusText(response),
    url: response.url()
  };
}

async function responseHeadersRecord(
  response: import("./types/api.js").APIResponse | Response | PageResponse
): Promise<Record<string, string>> {
  if ("allHeaders" in response && typeof response.allHeaders === "function") {
    return response.allHeaders();
  }
  if (typeof response.headers === "function") {
    return response.headers();
  }
  return Object.fromEntries(response.headers.map((header) => [header.name, header.value]));
}

function getResponseStatus(
  response: import("./types/api.js").APIResponse | Response | PageResponse
): number {
  return typeof response.status === "function" ? response.status() : response.status;
}

function getResponseStatusText(
  response: import("./types/api.js").APIResponse | Response | PageResponse
): string {
  return typeof response.statusText === "function" ? response.statusText() : response.statusText;
}

async function responseBodyBuffer(
  response: import("./types/api.js").APIResponse | Response | PageResponse
): Promise<Buffer> {
  if ("body" in response && typeof response.body === "function") {
    return response.body();
  }
  return Buffer.from(await response.text(), "utf8");
}

async function buildFulfillDecision(
  request: RoutedRequestCall,
  options: {
    body?: string | Buffer;
    contentType?: string;
    headers?: { [key: string]: string };
    json?: unknown;
    path?: string;
    response?: import("./types/api.js").APIResponse | Response | PageResponse;
    status?: number;
  }
): Promise<Extract<RoutedRequestDecision, { action: "fulfill" }>> {
  if (options.json !== undefined && options.body !== undefined) {
    throw new Error("Can specify either body or json parameters");
  }

  const responseHeaders = options.response ? await responseHeadersRecord(options.response) : {};
  const headers = normalizeHeaderRecord({
    ...responseHeaders,
    ...(options.headers ?? {})
  });

  let body = "";
  let bodyBuffer: Buffer | null = null;
  if (options.path) {
    bodyBuffer = await readFile(options.path);
    body = bodyBuffer.toString("utf8");
    if (!hasExplicitHeader(options.headers, "content-type")) {
      headers["content-type"] = inferMimeType(options.path);
    }
  } else if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    bodyBuffer = Buffer.from(body, "utf8");
    if (!("content-type" in headers) && !options.contentType) {
      headers["content-type"] = "application/json";
    }
  } else if (options.body !== undefined) {
    body = bufferToText(options.body);
    bodyBuffer = Buffer.isBuffer(options.body)
      ? Buffer.from(options.body)
      : Buffer.from(body, "utf8");
  } else if (options.response) {
    bodyBuffer = await responseBodyBuffer(options.response);
    body = bodyBuffer.toString("utf8");
  }

  if (options.contentType && !options.path) {
    headers["content-type"] = options.contentType;
  }
  if (bodyBuffer !== null && !hasExplicitHeader(options.headers, "content-length")) {
    headers["content-length"] = String(bodyBuffer.byteLength);
  }
  maybeAddCorsHeaders(request, headers);

  const inheritedStatus = options.response ? getResponseStatus(options.response) : undefined;
  const inheritedStatusText = options.response ? getResponseStatusText(options.response) : undefined;
  const status = options.status ?? inheritedStatus ?? 200;
  return {
    action: "fulfill",
    body,
    ...(bodyBuffer ? { bodyBufferBase64: bodyBuffer.toString("base64") } : {}),
    headers,
    status,
    statusText: inheritedStatusText ?? statusTextForCode(status),
    url: request.url
  };
}

function maybeAddCorsHeaders(request: RoutedRequestCall, headers: Record<string, string>): void {
  const origin = request.headers.origin;
  if (!origin) {
    return;
  }
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return;
  }
  if (!requestUrl.protocol.startsWith("http")) {
    return;
  }
  if (requestUrl.origin === origin.trim()) {
    return;
  }
  if (Object.keys(headers).some((name) => name.toLowerCase() === "access-control-allow-origin")) {
    return;
  }
  headers["access-control-allow-origin"] = origin;
  headers["access-control-allow-credentials"] = "true";
  headers.vary = "Origin";
}
