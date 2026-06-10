import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cdpModule from "chrome-remote-interface";
import {
  ARIA_REF_SELECTOR_EVALUATE_SOURCE,
  ARIA_SNAPSHOT_EVALUATE_SOURCE,
  type AriaSnapshotResult,
  type ResolvedAriaRefResult,
  normalizeAriaSnapshotOptions,
  retryUntilReady,
  withOptionalTimeout
} from "../../ariaSnapshot.js";
import { LocatorError, TimeoutError } from "../../errors.js";
import { createPageResponse } from "../../pageResponse.js";
import type { ResolvedAriaRef } from "../../types/api.js";
import { createNavigationResult } from "../../navigationResult.js";
import {
  SELECTOR_RUNTIME_SOURCE,
  type SelectorRuntimePayload
} from "../selectorRuntime.js";
import type {
  AriaSnapshotOptions,
  BrowserConnectOptions,
  BrowserContextOptions,
  ClickOptions,
  FillOptions,
  GetByRoleOptions,
  HoverOptions,
  LaunchOptions,
  MouseButton,
  PageGotoOptions,
  PressOptions,
  ScreenshotOptions,
  TypeOptions,
  WaitUntilState
} from "../../types/options.js";
import type {
  PageEventListener,
  PageEventMap,
  PageEventName,
  PageResponse
} from "../../types/events.js";
import type {
  LocatorSelector,
  ProtocolBrowserAdapter,
  ProtocolBrowserAdapterFactory,
  ProtocolBrowserContextAdapter,
  ProtocolBrowserSession,
  ProtocolElementHandleAdapter,
  ProtocolElementHandleReference,
  ProtocolLocatorAdapter,
  ProtocolPageAdapter
} from "../adapter.js";
import type { ProtocolCapabilities } from "../capabilities.js";
import { looksLikeFunctionExpression } from "../evaluate.js";
import type CDP from "chrome-remote-interface";

const chromeRemoteInterface = ("default" in cdpModule
  ? cdpModule.default
  : cdpModule) as unknown as {
  (options?: CDP.Options): Promise<CDP.Client>;
  Version(options?: CDP.BaseOptions): Promise<CDP.VersionResult>;
};

const CDP_CAPABILITIES: ProtocolCapabilities = {
  protocol: "cdp",
  supportsMultipleContexts: true,
  supportsIsolatedWorlds: true,
  supportsLocatorChaining: true,
  supportsInputDispatch: true,
  supportsDownloads: true,
  supportsTracing: true
};

const DEFAULT_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_MS = 500;

type CdpClient = CDP.Client;
type CdpVersionResult = CDP.VersionResult;
type CdpTarget = CDP.Target;

interface CdpConnectionDetails {
  browserWsEndpoint: string;
  host: string;
  port: number;
  spawnedProcess?: BrowserProcess;
  userDataDir?: string;
}

interface BrowserProcess {
  kill(signal?: string): boolean;
  once(event: string, listener: (...args: unknown[]) => void): BrowserProcess;
  stdout?: StreamLike;
  stderr?: StreamLike;
}

interface StreamLike {
  on(event: string, listener: (chunk: unknown) => void): StreamLike;
}

interface CdpBrowserState {
  browserClient: CdpClient;
  version: CdpVersionResult;
  connection: CdpConnectionDetails;
}

type LocatorPick =
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "nth"; index: number };

interface CdpLocatorState {
  chain: LocatorSelector[];
  pick?: LocatorPick;
}

interface ActionPoint {
  x: number;
  y: number;
}

interface StateWaiter {
  state: WaitUntilState;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ResponseBodyState {
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  text?: Promise<string>;
}

interface NavigationResponseCapture {
  lastResponse: PageResponse | null;
}

interface LocatorPayload {
  operation:
    | "actionPoint"
    | "fill"
    | "focus"
    | "isVisible"
    | "textContent";
  chain: LocatorSelector[];
  pick?: LocatorPick;
  value?: string;
  force?: boolean;
  position?: { x: number; y: number };
}

function locatorOperation(payload: LocatorPayload) {
  const normalize = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();

  const unique = <T>(items: T[]): T[] => Array.from(new Set(items));

  const compilePattern = (selector: LocatorSelector, kind: "value" | "name") => {
    const value = kind === "value" ? selector.value : selector.name ?? "";
    const isRegex = kind === "value" ? selector.isRegex : selector.nameIsRegex;
    const flags = kind === "value" ? selector.regexFlags : selector.nameRegexFlags;
    if (isRegex) {
      return new RegExp(value, flags ?? "");
    }
    return value;
  };

  const matchesPattern = (
    candidate: string,
    selector: LocatorSelector,
    kind: "value" | "name"
  ): boolean => {
    const pattern = compilePattern(selector, kind);
    const normalizedCandidate = normalize(candidate);

    if (pattern instanceof RegExp) {
      return pattern.test(normalizedCandidate);
    }

    return selector.exact ? normalizedCandidate === pattern : normalizedCandidate.includes(pattern);
  };

  const implicitRole = (element: Element): string | null => {
    const tagName = element.tagName.toLowerCase();
    if (tagName === "button") return "button";
    if (tagName === "a" && element.hasAttribute("href")) return "link";
    if (tagName === "textarea") return "textbox";
    if (tagName === "select") {
      return element.hasAttribute("multiple") ? "listbox" : "combobox";
    }
    if (tagName === "img") return "img";
    if (tagName !== "input") return null;

    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    switch (type) {
      case "button":
      case "submit":
      case "reset":
        return "button";
      case "checkbox":
        return "checkbox";
      case "radio":
        return "radio";
      case "range":
        return "slider";
      case "email":
      case "password":
      case "search":
      case "tel":
      case "text":
      case "url":
        return "textbox";
      default:
        return null;
    }
  };

  const roleOf = (element: Element): string | null =>
    normalize(element.getAttribute("role")) || implicitRole(element);

  const accessibleName = (element: Element): string => {
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return normalize(ariaLabel);

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((node): node is HTMLElement => Boolean(node))
        .map((node) => normalize(node.innerText || node.textContent))
        .join(" ");

      if (text) return normalize(text);
    }

    if (
      element instanceof HTMLInputElement &&
      ["button", "submit", "reset"].includes(element.type)
    ) {
      return normalize(element.value);
    }

    return normalize((element as HTMLElement).innerText || element.textContent);
  };

  const candidatesFromRoot = (root: ParentNode | Element, selector: LocatorSelector): Element[] => {
    if (selector.strategy === "css") {
      const matches: Element[] = [];
      if (root instanceof Element && root.matches(selector.value)) {
        matches.push(root);
      }
      matches.push(...Array.from(root.querySelectorAll(selector.value)));
      return unique(matches);
    }

    const descendants: Element[] =
      root instanceof Document
        ? [root.documentElement, ...Array.from(root.querySelectorAll("*"))]
        : [root as Element, ...Array.from(root.querySelectorAll("*"))];

    if (selector.strategy === "text") {
      return descendants.filter((element) =>
        matchesPattern((element as HTMLElement).innerText || element.textContent || "", selector, "value")
      );
    }

    return descendants.filter((element) => {
      if (roleOf(element) !== selector.value) {
        return false;
      }

      if (selector.name === undefined && !selector.nameIsRegex) {
        return true;
      }

      return matchesPattern(accessibleName(element), selector, "name");
    });
  };

  const resolveElements = (): HTMLElement[] => {
    let current: ParentNode[] = [document];

    for (const selector of payload.chain) {
      current = unique(current.flatMap((root) => candidatesFromRoot(root, selector)));
    }

    let elements = current.filter((node): node is HTMLElement => node instanceof HTMLElement);

    if (payload.pick?.kind === "first") {
      elements = elements.slice(0, 1);
    } else if (payload.pick?.kind === "last") {
      elements = elements.slice(-1);
    } else if (payload.pick?.kind === "nth") {
      const pickedElement = elements[payload.pick.index];
      elements = pickedElement ? [pickedElement] : [];
    }

    return elements;
  };

  const isVisible = (element: HTMLElement): boolean => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number.parseFloat(style.opacity || "1") !== 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  const firstElement = resolveElements()[0] ?? null;

  switch (payload.operation) {
    case "textContent":
      return firstElement ? firstElement.textContent : null;
    case "isVisible":
      return firstElement ? isVisible(firstElement) : false;
    case "focus":
      if (!firstElement) {
        throw new Error("No element found for locator.");
      }
      firstElement.focus();
      return true;
    case "fill":
      if (!firstElement) {
        throw new Error("No element found for locator.");
      }
      firstElement.focus();

      if (firstElement instanceof HTMLInputElement || firstElement instanceof HTMLTextAreaElement) {
        firstElement.value = payload.value ?? "";
      } else if (firstElement.isContentEditable) {
        firstElement.textContent = payload.value ?? "";
      } else {
        throw new Error("Element does not support fill().");
      }

      firstElement.dispatchEvent(new Event("input", { bubbles: true }));
      firstElement.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    case "actionPoint":
      if (!firstElement) {
        throw new Error("No element found for locator.");
      }

      firstElement.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "instant"
      });

      if (!payload.force && !isVisible(firstElement)) {
        throw new Error("Element is not visible.");
      }

      const rect = firstElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        throw new Error("Element does not have an actionable bounding box.");
      }

      const offsetX = payload.position ? payload.position.x : rect.width / 2;
      const offsetY = payload.position ? payload.position.y : rect.height / 2;

      return {
        x: rect.left + offsetX,
        y: rect.top + offsetY
      };
    default:
      throw new Error(`Unsupported locator operation: ${payload.operation as string}`);
  }
}

const LOCATOR_OPERATION_SOURCE = locatorOperation.toString();

export class CdpBrowserAdapterFactory implements ProtocolBrowserAdapterFactory {
  create(options: BrowserConnectOptions): ProtocolBrowserAdapter {
    return new CdpBrowserAdapter(options);
  }
}

export class CdpBrowserAdapter implements ProtocolBrowserAdapter {
  readonly protocol = "cdp" as const;
  readonly capabilities = CDP_CAPABILITIES;

  private state: CdpBrowserState | undefined;

  constructor(private readonly options: BrowserConnectOptions) {}

  async connect(): Promise<void> {
    if (this.state) {
      return;
    }

    const connection = await resolveConnectionDetails(this.options);
    const version = await chromeRemoteInterface.Version({
      host: connection.host,
      port: connection.port
    });
    const browserClient = await chromeRemoteInterface({
      target: connection.browserWsEndpoint,
      local: this.options.isLocal
    });

    this.state = {
      browserClient,
      version,
      connection
    };
  }

  async browser(): Promise<ProtocolBrowserSession> {
    if (!this.state) {
      throw new Error("CDP browser adapter is not connected.");
    }

    return new CdpBrowserSession(this.state);
  }

  async close(): Promise<void> {
    if (!this.state) {
      return;
    }

    await safelyCloseClient(this.state.browserClient);
    await cleanupConnection(this.state.connection);
    this.state = undefined;
  }
}

class CdpBrowserSession implements ProtocolBrowserSession {
  constructor(private readonly state: CdpBrowserState) {}

  async version(): Promise<string> {
    return this.state.version.Browser;
  }

  async newContext(
    options: BrowserContextOptions = {}
  ): Promise<ProtocolBrowserContextAdapter> {
    const response = await this.state.browserClient.Target.createBrowserContext({});

    return new CdpBrowserContextAdapter(
      this.state,
      response.browserContextId,
      options
    );
  }

  async close(): Promise<void> {}
}

class CdpBrowserContextAdapter implements ProtocolBrowserContextAdapter {
  private readonly pages = new Map<string, CdpPageAdapter>();
  private closing = false;

  constructor(
    private readonly state: CdpBrowserState,
    private readonly browserContextId: string | undefined,
    private readonly options: BrowserContextOptions
  ) {}

  async newPage(): Promise<ProtocolPageAdapter> {
    const response = await this.state.browserClient.Target.createTarget({
      url: "about:blank",
      ...(this.browserContextId ? { browserContextId: this.browserContextId } : {})
    });

    const client = await connectToTarget(this.state.connection, response.targetId);
    const page = await CdpPageAdapter.create({
      browserClient: this.state.browserClient,
      client,
      targetId: response.targetId,
      contextOptions: this.options,
      onClosed: (targetId) => {
        this.pages.delete(targetId);
      }
    });

    this.pages.set(response.targetId, page);
    return page;
  }

  async close(): Promise<void> {
    if (this.closing) {
      return;
    }

    this.closing = true;

    await Promise.all(
      Array.from(this.pages.values()).map(async (page) => {
        await page.close();
      })
    );
    this.pages.clear();

    if (this.browserContextId) {
      await this.state.browserClient.Target.disposeBrowserContext({
        browserContextId: this.browserContextId
      });
    }
  }
}

class CdpPageAdapter implements ProtocolPageAdapter {
  private mainFrameId: string | undefined;
  private domContentLoaded = false;
  private loadFired = false;
  private networkIdleReached = false;
  private sameDocumentNavigation = false;
  private allowSameDocumentNavigationToResolveWaiters = false;
  private activeRequests = 0;
  private closed = false;
  private networkIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly stateWaiters = new Set<StateWaiter>();
  private readonly eventListeners = new Map<PageEventName, Set<PageEventListener<PageEventName>>>();
  private readonly requestMetadata = new Map<
    string,
    { frameId?: string; method: string; type?: string; url: string }
  >();
  private readonly responseBodies = new Map<string, ResponseBodyState>();
  private navigationResponseCapture: NavigationResponseCapture | undefined;

  static async create(options: {
    browserClient: CdpClient;
    client: CdpClient;
    targetId: string;
    contextOptions: BrowserContextOptions;
    onClosed: (targetId: string) => void;
  }): Promise<CdpPageAdapter> {
    const page = new CdpPageAdapter(options);
    await page.initialize();
    return page;
  }

  private constructor(
    private readonly options: {
      browserClient: CdpClient;
      client: CdpClient;
      targetId: string;
      contextOptions: BrowserContextOptions;
      onClosed: (targetId: string) => void;
    }
  ) {
    this.options.client.on("disconnect", () => {
      if (this.closed) {
        return;
      }

      this.closed = true;
      this.rejectWaiters(new Error("Page disconnected."));
      this.emit("close", undefined);
      this.options.onClosed(this.options.targetId);
    });
  }

  private async initialize(): Promise<void> {
    const { client } = this.options;
    await Promise.all([
      client.Page.enable(),
      client.Page.setLifecycleEventsEnabled({ enabled: true }).catch(() => {}),
    client.Runtime.enable(),
      client.DOM.enable({}),
      client.Network.enable({})
    ]);

    client.Page.domContentEventFired(() => {
      this.domContentLoaded = true;
      this.flushWaiters();
      this.emit("domcontentloaded", undefined);
    });

    client.Page.navigatedWithinDocument(() => {
      this.sameDocumentNavigation = true;
      this.domContentLoaded = true;
      this.loadFired = true;
      this.networkIdleReached = true;
      if (this.allowSameDocumentNavigationToResolveWaiters) {
        this.flushWaiters();
      }
    });

    client.Page.frameNavigated((event) => {
      if (event.frame.parentId) {
        return;
      }

      this.mainFrameId = event.frame.id;

      if (event.type === "BackForwardCacheRestore") {
        this.domContentLoaded = true;
        this.loadFired = true;
        this.networkIdleReached = true;
        this.flushWaiters();
      }
    });

    client.Page.frameStoppedLoading((event) => {
      if (!this.isMainFrameId(event.frameId)) {
        return;
      }

      this.domContentLoaded = true;
      this.loadFired = true;
      this.maybeArmNetworkIdleTimer();
      this.flushWaiters();
    });

    client.Page.loadEventFired(() => {
      this.loadFired = true;
      this.flushWaiters();
      this.emit("load", undefined);
    });

    client.Runtime.consoleAPICalled((event) => {
      this.emit("console", {
        text: () => formatConsoleText(event.args),
        type: () => event.type
      });
    });

    client.Network.requestWillBeSent((event) => {
      const requestEvent = event as typeof event & { frameId?: string; type?: string };
      this.activeRequests += 1;
      this.networkIdleReached = false;
      this.clearNetworkIdleTimer();
      this.requestMetadata.set(event.requestId, {
        method: event.request.method,
        url: event.request.url,
        ...(requestEvent.frameId ? { frameId: requestEvent.frameId } : {}),
        ...(requestEvent.type ? { type: requestEvent.type } : {})
      });
      this.emit("request", {
        headers: mapCdpHeaders(event.request.headers),
        method: event.request.method,
        url: event.request.url
      });
    });

    const onRequestSettled = (requestId?: string) => {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      if (requestId) {
        this.requestMetadata.delete(requestId);
      }
      this.maybeArmNetworkIdleTimer();
    };

    client.Network.responseReceived((event) => {
      const responseEvent = event as typeof event & { frameId?: string; type?: string };
      const response = createPageResponse({
        fromCache: Boolean(event.response.fromDiskCache || event.response.fromPrefetchCache),
        headers: mapCdpHeaders(event.response.headers),
        mimeType: event.response.mimeType,
        status: event.response.status,
        statusText: event.response.statusText,
        text: () => this.getResponseText(event.requestId),
        url: event.response.url
      });

      this.emit("response", response);

      if (
        this.navigationResponseCapture &&
        responseEvent.type === "Document" &&
        responseEvent.frameId &&
        this.isMainFrameId(responseEvent.frameId) &&
        shouldCaptureNavigationResponseUrl(response.url)
      ) {
        this.navigationResponseCapture.lastResponse = response;
      }
    });

    client.Network.loadingFinished((event) => {
      this.ensureResponseBodyState(event.requestId).resolveReady();
      onRequestSettled(event.requestId);
    });
    client.Network.loadingFailed((event) => {
      const request = this.requestMetadata.get(event.requestId);
      this.ensureResponseBodyState(event.requestId).rejectReady(
        new Error(event.errorText || "Network loading failed.")
      );
      onRequestSettled(event.requestId);
      this.emit("requestfailed", {
        errorText: event.errorText,
        method: request?.method ?? "UNKNOWN",
        url: request?.url ?? "unknown://request"
      });
    });

    await this.applyContextOptions();
    this.maybeArmNetworkIdleTimer();
  }

  async goto(url: string, options: PageGotoOptions = {}): Promise<PageResponse | null> {
    const waitUntil = options.waitUntil ?? "load";
    const targetUrl = resolveUrl(url, this.options.contextOptions.baseURL);
    const capture = this.beginNavigationResponseCapture();
    this.resetNavigationState();

    await withTimeout(
      this.options.client.Page.navigate({ url: targetUrl }),
      options.timeout,
      `Timed out while navigating to "${targetUrl}".`
    );

    if (waitUntil !== "commit") {
      await this.waitForLoadState(waitUntil, options.timeout);
    }

    if (this.navigationResponseCapture === capture) {
      this.navigationResponseCapture = undefined;
    }
    return capture.lastResponse;
  }

  async url(): Promise<string> {
    return this.evaluateExpression<string>("String(globalThis.location?.href || '')");
  }

  async goBack(options: PageGotoOptions = {}): Promise<ReturnType<typeof createNavigationResult> | null> {
    return this.navigateHistory(-1, options);
  }

  async goForward(options: PageGotoOptions = {}): Promise<ReturnType<typeof createNavigationResult> | null> {
    return this.navigateHistory(1, options);
  }

  async reload(options: PageGotoOptions = {}): Promise<PageResponse | null> {
    const waitUntil = options.waitUntil ?? "load";
    const capture = this.beginNavigationResponseCapture();
    this.resetNavigationState();

    await withTimeout(
      (this.options.client.Page as typeof this.options.client.Page & {
        reload(): Promise<void>;
      }).reload(),
      options.timeout,
      "Timed out while reloading page."
    );

    if (waitUntil !== "commit") {
      await this.waitForLoadState(waitUntil, options.timeout);
    }

    if (this.navigationResponseCapture === capture) {
      this.navigationResponseCapture = undefined;
    }
    return capture.lastResponse;
  }

  async title(): Promise<string> {
    return this.evaluateExpression<string>("document.title");
  }

  async content(): Promise<string> {
    return this.evaluateFunction<string>(
      `() => {
        const doctype = document.doctype
          ? "<!DOCTYPE " + document.doctype.name + ">"
          : "";
        return doctype + document.documentElement.outerHTML;
      }`
    );
  }

  async setContent(html: string): Promise<void> {
    this.resetNavigationState();

    await this.evaluateFunction<void>(
      `(payload) => {
        document.open();
        document.write(payload.html);
        document.close();
      }`,
      { html }
    );

    await this.waitForLoadState("load");
  }

  async evaluate<TResult>(expression: string, arg?: unknown): Promise<TResult> {
    if (arg === undefined && !looksLikeFunctionExpression(expression)) {
      return this.evaluateExpression<TResult>(expression);
    }

    return this.evaluateFunction<TResult>(expression, arg);
  }

  async waitForLoadState(
    state: PageGotoOptions["waitUntil"] = "load",
    timeout = DEFAULT_TIMEOUT_MS
  ): Promise<void> {
    const targetState = state ?? "load";
    if (targetState === "commit" || this.isStateSatisfied(targetState)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stateWaiters.delete(waiter);
        reject(new TimeoutError(`Timed out waiting for load state "${targetState}".`));
      }, timeout);

      const waiter: StateWaiter = {
        state: targetState,
        resolve: () => {
          clearTimeout(timer);
          this.stateWaiters.delete(waiter);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          this.stateWaiters.delete(waiter);
          reject(error);
        },
        timer
      };

      this.stateWaiters.add(waiter);
      this.flushWaiters();
    });
  }

  async ariaSnapshot(options: AriaSnapshotOptions = {}): Promise<string> {
    const normalizedOptions = normalizeAriaSnapshotOptions(options);
    const result = await retryUntilReady(
      () => this.evaluateFunction<AriaSnapshotResult>(ARIA_SNAPSHOT_EVALUATE_SOURCE, {
        options: normalizedOptions
      }),
      { timeoutMs: normalizedOptions.timeout ?? 15_000 }
    );
    return result.text;
  }

  async resolveAriaRef(ref: string): Promise<ResolvedAriaRef> {
    const result = await this.evaluateFunction<ResolvedAriaRefResult>(
      ARIA_REF_SELECTOR_EVALUATE_SOURCE,
      { ref }
    );
    if (!result.ok) {
      throw new Error(
        `Ref "${ref}" is not available on this page. Call page.ariaSnapshot({ mode: "ai" }) again first.`
      );
    }

    return {
      ref: result.ref ?? ref,
      selector: result.selector ?? null,
      xpath: result.xpath ?? null,
      querySelector: result.querySelector ?? null,
      querySelectorChain: result.querySelectorChain ?? null,
      framePath: result.framePath ?? [],
      inShadowTree: Boolean(result.inShadowTree)
    };
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const format = options.type ?? "png";
    const response = await this.options.client.Page.captureScreenshot({
      captureBeyondViewport: options.fullPage ?? false,
      ...(format === "jpeg"
        ? {
            format,
            ...(options.quality !== undefined ? { quality: options.quality } : {})
          }
        : { format })
    });
    return Buffer.from(response.data, "base64");
  }

  on<K extends PageEventName>(event: K, listener: PageEventListener<K>): () => void {
    const listeners =
      this.eventListeners.get(event) ?? new Set<PageEventListener<PageEventName>>();
    listeners.add(listener as PageEventListener<PageEventName>);
    this.eventListeners.set(event, listeners);

    return () => {
      const registeredListeners = this.eventListeners.get(event);
      registeredListeners?.delete(listener as PageEventListener<PageEventName>);
      if (registeredListeners?.size === 0) {
        this.eventListeners.delete(event);
      }
    };
  }

  async query(selector: LocatorSelector[]): Promise<ProtocolElementHandleAdapter | null> {
    const count = await this.countSelector({
      chain: selector
    });
    if (count === 0) {
      return null;
    }
    return new CdpElementHandleAdapter(this, {
      chain: selector,
      pick: { kind: "first" }
    });
  }

  async queryAll(selector: LocatorSelector[]): Promise<ProtocolElementHandleAdapter[]> {
    const count = await this.countSelector({
      chain: selector
    });
    return Array.from({ length: count }, (_value, index) => {
      return new CdpElementHandleAdapter(this, {
        chain: selector,
        pick: { kind: "nth", index }
      });
    });
  }

  async evalOnSelector<TResult>(
    selector: LocatorSelector[],
    expression: string,
    arg?: unknown
  ): Promise<TResult> {
    return this.evaluateOnReference<TResult>(
      {
        chain: selector,
        pick: { kind: "first" }
      },
      expression,
      arg,
      `page.$eval: Failed to find element matching selector "${formatSelectorChain(selector)}"`
    );
  }

  async evalOnSelectorAll<TResult>(
    selector: LocatorSelector[],
    expression: string,
    arg?: unknown
  ): Promise<TResult> {
    return this.evaluateOnReferenceAll<TResult>(
      {
        chain: selector
      },
      expression,
      arg
    );
  }

  locator(selector: LocatorSelector): ProtocolLocatorAdapter {
    return new CdpLocatorAdapter(this, {
      chain: [selector]
    });
  }

  getByText(text: string | RegExp, options?: { exact?: boolean }): ProtocolLocatorAdapter {
    return new CdpLocatorAdapter(this, {
      chain: [
        {
          strategy: "text",
          value: text instanceof RegExp ? text.source : text,
          ...(options?.exact !== undefined ? { exact: options.exact } : {}),
          ...(text instanceof RegExp
            ? {
                isRegex: true,
                regexFlags: text.flags
              }
            : {})
        }
      ]
    });
  }

  getByRole(role: string, options?: GetByRoleOptions): ProtocolLocatorAdapter {
    return new CdpLocatorAdapter(this, {
      chain: [
        {
          strategy: "role",
          value: role,
          ...(options?.exact !== undefined ? { exact: options.exact } : {}),
      ...(typeof options?.name === "string" ? { name: options.name } : {}),
      ...(options?.name instanceof RegExp
        ? {
            name: options.name.source,
            nameIsRegex: true,
            nameRegexFlags: options.name.flags
          }
        : {})
        }
      ]
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.clearNetworkIdleTimer();
    this.rejectWaiters(new Error("Page closed."));
    this.emit("close", undefined);

    try {
      await this.options.browserClient.Target.closeTarget({
        targetId: this.options.targetId
      });
    } finally {
      await safelyCloseClient(this.options.client);
      this.options.onClosed(this.options.targetId);
    }
  }

  async clickLocator(locator: CdpLocatorState, options?: ClickOptions): Promise<void> {
    const actionPoint = await this.resolveActionPoint(locator, options);
    const button = options?.button ?? "left";
    const clickCount = options?.clickCount ?? 1;

    await this.dispatchMouseMove(actionPoint);
    for (let index = 0; index < clickCount; index += 1) {
      await this.dispatchMouseEvent("mousePressed", actionPoint, button, index + 1);
      await delay(options?.delay ?? 0);
      await this.dispatchMouseEvent("mouseReleased", actionPoint, button, index + 1);
    }
  }

  async hoverLocator(locator: CdpLocatorState, options?: HoverOptions): Promise<void> {
    const actionPoint = await this.resolveActionPoint(locator, options);
    await this.dispatchMouseMove(actionPoint);
  }

  async fillLocator(
    locator: CdpLocatorState,
    value: string,
    options?: FillOptions
  ): Promise<void> {
    await this.runLocatorOperation<boolean>(locator, {
      operation: "fill",
      ...(options?.force !== undefined ? { force: options.force } : {}),
      value
    });
  }

  async typeLocator(
    locator: CdpLocatorState,
    value: string,
    options?: TypeOptions
  ): Promise<void> {
    await this.runLocatorOperation<boolean>(locator, {
      operation: "focus"
    });

    for (const character of value) {
      await this.options.client.Input.dispatchKeyEvent({
        type: "char",
        text: character
      });
      await delay(options?.delay ?? 0);
    }
  }

  async pressLocator(
    locator: CdpLocatorState,
    key: string,
    options?: PressOptions
  ): Promise<void> {
    await this.runLocatorOperation<boolean>(locator, {
      operation: "focus"
    });

    const keyDefinition = resolveKeyDefinition(key);
    await this.options.client.Input.dispatchKeyEvent({
      type: "keyDown",
      key: keyDefinition.key,
      code: keyDefinition.code,
      ...(keyDefinition.text !== undefined
        ? {
            text: keyDefinition.text,
            unmodifiedText: keyDefinition.text
          }
        : {}),
      windowsVirtualKeyCode: keyDefinition.keyCode,
      nativeVirtualKeyCode: keyDefinition.keyCode
    });

    if (options?.delay) {
      await delay(options.delay);
    }

    await this.options.client.Input.dispatchKeyEvent({
      type: "keyUp",
      key: keyDefinition.key,
      code: keyDefinition.code,
      windowsVirtualKeyCode: keyDefinition.keyCode,
      nativeVirtualKeyCode: keyDefinition.keyCode
    });
  }

  async textContentLocator(locator: CdpLocatorState): Promise<string | null> {
    return this.runLocatorOperation<string | null>(locator, {
      operation: "textContent"
    });
  }

  async isVisibleLocator(locator: CdpLocatorState): Promise<boolean> {
    return this.runLocatorOperation<boolean>(locator, {
      operation: "isVisible"
    });
  }

  private async applyContextOptions(): Promise<void> {
    const { contextOptions, client } = this.options;

    if (contextOptions.viewport) {
      await client.Emulation.setDeviceMetricsOverride({
        width: contextOptions.viewport.width,
        height: contextOptions.viewport.height,
        mobile: false,
        deviceScaleFactor: 1
      });
    }

    if (contextOptions.userAgent || contextOptions.locale) {
      await client.Network.setUserAgentOverride({
        userAgent: contextOptions.userAgent ?? "Mozilla/5.0",
        ...(contextOptions.locale ? { acceptLanguage: contextOptions.locale } : {})
      });
    }

    if (contextOptions.timezoneId) {
      try {
        await client.Emulation.setTimezoneOverride({
          timezoneId: contextOptions.timezoneId
        });
      } catch {}
    }

    if (contextOptions.locale) {
      try {
        await client.Emulation.setLocaleOverride({
          locale: contextOptions.locale
        });
      } catch {}
    }
  }

  private async dispatchMouseMove(point: ActionPoint): Promise<void> {
    await this.options.client.Input.dispatchMouseEvent({
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none"
    });
  }

  private async dispatchMouseEvent(
    type: "mousePressed" | "mouseReleased",
    point: ActionPoint,
    button: MouseButton,
    clickCount: number
  ): Promise<void> {
    await this.options.client.Input.dispatchMouseEvent({
      type,
      x: point.x,
      y: point.y,
      button,
      clickCount
    });
  }

  private async resolveActionPoint(
    locator: CdpLocatorState,
    options?: HoverOptions
  ): Promise<ActionPoint> {
    try {
      return await this.runSelectorOperation<ActionPoint>({
        operation: "actionPoint",
        reference: {
          chain: locator.chain,
          ...(locator.pick ? { pick: locator.pick } : {})
        },
        ...(options?.force !== undefined ? { force: options.force } : {}),
        ...(options?.position ? { position: options.position } : {})
      });
    } catch (error) {
      throw wrapLocatorError(locator, error);
    }
  }

  private async runLocatorOperation<TResult>(
    locator: CdpLocatorState,
    payload: Omit<SelectorRuntimePayload, "reference">
  ): Promise<TResult> {
    try {
      return await this.runSelectorOperation<TResult>({
        ...payload,
        reference: {
          chain: locator.chain,
          ...(locator.pick ? { pick: locator.pick } : {})
        }
      });
    } catch (error) {
      throw wrapLocatorError(locator, error);
    }
  }

  async countSelector(reference: ProtocolElementHandleReference): Promise<number> {
    return this.runSelectorOperation<number>({
      operation: "count",
      reference
    });
  }

  async evaluateOnReference<TResult>(
    reference: ProtocolElementHandleReference,
    expression: string,
    arg?: unknown,
    missingMessage?: string
  ): Promise<TResult> {
    return this.runSelectorOperation<TResult>({
      operation: "evaluate",
      reference,
      expression,
      arg,
      ...(missingMessage ? { missingMessage } : {})
    });
  }

  async evaluateOnReferenceAll<TResult>(
    reference: ProtocolElementHandleReference,
    expression: string,
    arg?: unknown
  ): Promise<TResult> {
    return this.runSelectorOperation<TResult>({
      operation: "evaluateAll",
      reference,
      expression,
      arg
    });
  }

  async elementTextContent(reference: ProtocolElementHandleReference): Promise<string | null> {
    return this.runSelectorOperation<string | null>({
      operation: "textContent",
      reference
    });
  }

  async elementIsVisible(reference: ProtocolElementHandleReference): Promise<boolean> {
    return this.runSelectorOperation<boolean>({
      operation: "isVisible",
      reference
    });
  }

  async clickReference(reference: ProtocolElementHandleReference, options?: ClickOptions): Promise<void> {
    const actionPoint = await this.runSelectorOperation<ActionPoint>({
      operation: "actionPoint",
      reference,
      ...(options?.force !== undefined ? { force: options.force } : {}),
      ...(options?.position ? { position: options.position } : {})
    });
    const button = options?.button ?? "left";
    const clickCount = options?.clickCount ?? 1;

    await this.dispatchMouseMove(actionPoint);
    for (let index = 0; index < clickCount; index += 1) {
      await this.dispatchMouseEvent("mousePressed", actionPoint, button, index + 1);
      await delay(options?.delay ?? 0);
      await this.dispatchMouseEvent("mouseReleased", actionPoint, button, index + 1);
    }
  }

  async hoverReference(reference: ProtocolElementHandleReference, options?: HoverOptions): Promise<void> {
    const actionPoint = await this.runSelectorOperation<ActionPoint>({
      operation: "actionPoint",
      reference,
      ...(options?.force !== undefined ? { force: options.force } : {}),
      ...(options?.position ? { position: options.position } : {})
    });
    await this.dispatchMouseMove(actionPoint);
  }

  async fillReference(
    reference: ProtocolElementHandleReference,
    value: string,
    options?: FillOptions
  ): Promise<void> {
    await this.runSelectorOperation<boolean>({
      operation: "fill",
      reference,
      value,
      ...(options?.force !== undefined ? { force: options.force } : {})
    });
  }

  async typeReference(
    reference: ProtocolElementHandleReference,
    value: string,
    options?: TypeOptions
  ): Promise<void> {
    await this.runSelectorOperation<boolean>({
      operation: "focus",
      reference
    });

    for (const character of value) {
      await this.options.client.Input.dispatchKeyEvent({
        type: "char",
        text: character
      });
      await delay(options?.delay ?? 0);
    }
  }

  async pressReference(
    reference: ProtocolElementHandleReference,
    key: string,
    options?: PressOptions
  ): Promise<void> {
    await this.runSelectorOperation<boolean>({
      operation: "focus",
      reference
    });

    const keyDefinition = resolveKeyDefinition(key);
    await this.options.client.Input.dispatchKeyEvent({
      type: "keyDown",
      key: keyDefinition.key,
      code: keyDefinition.code,
      ...(keyDefinition.text !== undefined
        ? {
            text: keyDefinition.text,
            unmodifiedText: keyDefinition.text
          }
        : {}),
      windowsVirtualKeyCode: keyDefinition.keyCode,
      nativeVirtualKeyCode: keyDefinition.keyCode
    });

    if (options?.delay) {
      await delay(options.delay);
    }

    await this.options.client.Input.dispatchKeyEvent({
      type: "keyUp",
      key: keyDefinition.key,
      code: keyDefinition.code,
      windowsVirtualKeyCode: keyDefinition.keyCode,
      nativeVirtualKeyCode: keyDefinition.keyCode
    });
  }

  private async runSelectorOperation<TResult>(payload: SelectorRuntimePayload): Promise<TResult> {
    return this.evaluateFunction<TResult>(SELECTOR_RUNTIME_SOURCE, payload);
  }

  private async evaluateExpression<TResult>(expression: string): Promise<TResult> {
    const response = await this.options.client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true
    });

    if (response.exceptionDetails) {
      throw new Error(formatCdpEvaluationError(response));
    }

    return extractRemoteValue<TResult>(response.result);
  }

  private async evaluateFunction<TResult>(
    expression: string,
    arg?: unknown
  ): Promise<TResult> {
    const serializedArg = arg === undefined ? "" : serializeForEvaluation(arg);
    const wrappedExpression =
      arg === undefined ? `(${expression})()` : `(${expression})(${serializedArg})`;
    return this.evaluateExpression<TResult>(wrappedExpression);
  }

  private isStateSatisfied(state: WaitUntilState): boolean {
    if (this.sameDocumentNavigation && this.allowSameDocumentNavigationToResolveWaiters) {
      return true;
    }

    switch (state) {
      case "domcontentloaded":
        return this.domContentLoaded;
      case "load":
        return this.loadFired;
      case "networkidle":
        return this.networkIdleReached;
      case "commit":
        return true;
    }
  }

  private resetNavigationState(): void {
    this.domContentLoaded = false;
    this.loadFired = false;
    this.networkIdleReached = false;
    this.sameDocumentNavigation = false;
    this.allowSameDocumentNavigationToResolveWaiters = false;
    this.activeRequests = 0;
    this.clearNetworkIdleTimer();
  }

  private async navigateHistory(
    delta: -1 | 1,
    options: PageGotoOptions
  ): Promise<ReturnType<typeof createNavigationResult> | null> {
    const pageDomain = this.options.client.Page as typeof this.options.client.Page & {
      getNavigationHistory(): Promise<{
        currentIndex: number;
        entries: Array<{ id: number; url: string }>;
      }>;
      navigateToHistoryEntry(options: { entryId: number }): Promise<void>;
    };
    const history = await retryOnNotAttachedToActivePage(() => {
      return pageDomain.getNavigationHistory();
    });
    const nextEntry = history.entries[history.currentIndex + delta];
    if (!nextEntry) {
      return null;
    }

    const waitUntil = options.waitUntil ?? "load";
    this.resetNavigationState();
    this.allowSameDocumentNavigationToResolveWaiters = true;
    await withTimeout(
      retryOnNotAttachedToActivePage(() => {
        return pageDomain.navigateToHistoryEntry({ entryId: nextEntry.id });
      }),
      options.timeout,
      `Timed out while navigating ${delta < 0 ? "back" : "forward"}.`
    );

    if (waitUntil !== "commit") {
      await this.waitForLoadState(waitUntil, options.timeout);
    }

    return createNavigationResult({
      url: nextEntry.url
    });
  }

  private maybeArmNetworkIdleTimer(): void {
    if (this.activeRequests !== 0 || this.networkIdleTimer) {
      return;
    }

    this.networkIdleTimer = setTimeout(() => {
      this.networkIdleReached = true;
      this.networkIdleTimer = undefined;
      this.flushWaiters();
    }, NETWORK_IDLE_MS);
  }

  private clearNetworkIdleTimer(): void {
    if (!this.networkIdleTimer) {
      return;
    }

    clearTimeout(this.networkIdleTimer);
    this.networkIdleTimer = undefined;
  }

  private flushWaiters(): void {
    for (const waiter of Array.from(this.stateWaiters)) {
      if (this.isStateSatisfied(waiter.state)) {
        waiter.resolve();
      }
    }
  }

  private isMainFrameId(frameId: string): boolean {
    return this.mainFrameId === undefined || this.mainFrameId === frameId;
  }

  private beginNavigationResponseCapture(): NavigationResponseCapture {
    const capture: NavigationResponseCapture = {
      lastResponse: null
    };
    this.navigationResponseCapture = capture;
    return capture;
  }

  private ensureResponseBodyState(requestId: string): ResponseBodyState {
    const existing = this.responseBodies.get(requestId);
    if (existing) {
      return existing;
    }

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = (error: Error) => reject(error);
    });
    const created: ResponseBodyState = {
      ready,
      rejectReady,
      resolveReady
    };
    this.responseBodies.set(requestId, created);
    return created;
  }

  private async getResponseText(requestId: string): Promise<string> {
    const state = this.ensureResponseBodyState(requestId);
    if (!state.text) {
      state.text = (async () => {
        await state.ready;
        const response = await (
          this.options.client.Network as typeof this.options.client.Network & {
            getResponseBody(options: {
              requestId: string;
            }): Promise<{ base64Encoded: boolean; body: string }>;
          }
        ).getResponseBody({
          requestId
        });
        const buffer = response.base64Encoded
          ? Buffer.from(response.body, "base64")
          : Buffer.from(response.body, "utf8");
        return buffer.toString("utf8");
      })();
    }
    return state.text;
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of Array.from(this.stateWaiters)) {
      waiter.reject(error);
    }
    this.stateWaiters.clear();
  }

  private emit<K extends PageEventName>(event: K, payload: PageEventMap[K]): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners) {
      return;
    }

    for (const listener of Array.from(listeners)) {
      if (payload === undefined) {
        (listener as () => void)();
        continue;
      }

      (listener as (eventPayload: PageEventMap[K]) => void)(payload);
    }
  }
}

class CdpLocatorAdapter implements ProtocolLocatorAdapter {
  constructor(
    private readonly page: CdpPageAdapter,
    private readonly state: CdpLocatorState
  ) {}

  locator(selector: LocatorSelector): ProtocolLocatorAdapter {
    return new CdpLocatorAdapter(this.page, {
      chain: [...this.state.chain, selector]
    });
  }

  first(): ProtocolLocatorAdapter {
    return new CdpLocatorAdapter(this.page, {
      ...this.state,
      pick: { kind: "first" }
    });
  }

  last(): ProtocolLocatorAdapter {
    return new CdpLocatorAdapter(this.page, {
      ...this.state,
      pick: { kind: "last" }
    });
  }

  nth(index: number): ProtocolLocatorAdapter {
    return new CdpLocatorAdapter(this.page, {
      ...this.state,
      pick: { kind: "nth", index }
    });
  }

  async click(options?: ClickOptions): Promise<void> {
    await this.page.clickLocator(this.state, options);
  }

  async hover(options?: HoverOptions): Promise<void> {
    await this.page.hoverLocator(this.state, options);
  }

  async fill(value: string, options?: FillOptions): Promise<void> {
    await this.page.fillLocator(this.state, value, options);
  }

  async type(value: string, options?: TypeOptions): Promise<void> {
    await this.page.typeLocator(this.state, value, options);
  }

  async press(key: string, options?: PressOptions): Promise<void> {
    await this.page.pressLocator(this.state, key, options);
  }

  async textContent(): Promise<string | null> {
    return this.page.textContentLocator(this.state);
  }

  async isVisible(): Promise<boolean> {
    return this.page.isVisibleLocator(this.state);
  }
}

class CdpElementHandleAdapter implements ProtocolElementHandleAdapter {
  constructor(
    private readonly page: CdpPageAdapter,
    private readonly referenceState: ProtocolElementHandleReference
  ) {}

  reference(): ProtocolElementHandleReference {
    return {
      chain: [...this.referenceState.chain],
      ...(this.referenceState.pick ? { pick: this.referenceState.pick } : {}),
      ...(this.referenceState.scope ? { scope: this.referenceState.scope } : {})
    };
  }

  async query(selector: LocatorSelector[]): Promise<ProtocolElementHandleAdapter | null> {
    const reference: ProtocolElementHandleReference = {
      scope: this.reference(),
      chain: selector
    };
    const count = await this.page.countSelector(reference);
    if (count === 0) {
      return null;
    }
    return new CdpElementHandleAdapter(this.page, {
      ...reference,
      pick: { kind: "first" }
    });
  }

  async queryAll(selector: LocatorSelector[]): Promise<ProtocolElementHandleAdapter[]> {
    const reference: ProtocolElementHandleReference = {
      scope: this.reference(),
      chain: selector
    };
    const count = await this.page.countSelector(reference);
    return Array.from({ length: count }, (_value, index) => {
      return new CdpElementHandleAdapter(this.page, {
        ...reference,
        pick: { kind: "nth", index }
      });
    });
  }

  async evalOnSelector<TResult>(
    selector: LocatorSelector[],
    expression: string,
    arg?: unknown
  ): Promise<TResult> {
    return this.page.evaluateOnReference(
      {
        scope: this.reference(),
        chain: selector,
        pick: { kind: "first" }
      },
      expression,
      arg,
      `elementHandle.$eval: Failed to find element matching selector "${formatSelectorChain(selector)}"`
    );
  }

  async evalOnSelectorAll<TResult>(
    selector: LocatorSelector[],
    expression: string,
    arg?: unknown
  ): Promise<TResult> {
    return this.page.evaluateOnReferenceAll(
      {
        scope: this.reference(),
        chain: selector
      },
      expression,
      arg
    );
  }

  async evaluate<TResult>(expression: string, arg?: unknown): Promise<TResult> {
    return this.page.evaluateOnReference(this.reference(), expression, arg, "No element found.");
  }

  async click(options?: ClickOptions): Promise<void> {
    await this.page.clickReference(this.reference(), options);
  }

  async hover(options?: HoverOptions): Promise<void> {
    await this.page.hoverReference(this.reference(), options);
  }

  async fill(value: string, options?: FillOptions): Promise<void> {
    await this.page.fillReference(this.reference(), value, options);
  }

  async type(value: string, options?: TypeOptions): Promise<void> {
    await this.page.typeReference(this.reference(), value, options);
  }

  async press(key: string, options?: PressOptions): Promise<void> {
    await this.page.pressReference(this.reference(), key, options);
  }

  async textContent(): Promise<string | null> {
    return this.page.elementTextContent(this.reference());
  }

  async isVisible(): Promise<boolean> {
    return this.page.elementIsVisible(this.reference());
  }
}

async function connectToTarget(
  connection: CdpConnectionDetails,
  targetId: string
): Promise<CdpClient> {
  return chromeRemoteInterface({
    host: connection.host,
    port: connection.port,
    target: targetId
  });
}

async function resolveConnectionDetails(
  options: LaunchOptions
): Promise<CdpConnectionDetails> {
  if (options.wsEndpoint) {
    return buildConnectionFromWsEndpoint(options.wsEndpoint);
  }

  if (options.host || options.port) {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 9222;
    const version = await chromeRemoteInterface.Version({ host, port });
    return {
      browserWsEndpoint: version.webSocketDebuggerUrl,
      host,
      port
    };
  }

  return launchBrowser(options);
}

async function launchBrowser(options: LaunchOptions): Promise<CdpConnectionDetails> {
  const userDataDir = await mkdtemp(join(tmpdir(), "roxybrowser-cdp-"));
  const executableCandidates = resolveExecutableCandidates(options);
  const args = buildChromiumLaunchArgs(options, userDataDir);

  let lastError: unknown;

  for (const executable of executableCandidates) {
    const processRef = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"]
    }) as BrowserProcess;

    try {
      const browserWsEndpoint = await waitForDebuggerEndpoint(processRef, 15_000);
      const connection = buildConnectionFromWsEndpoint(browserWsEndpoint);
      return {
        ...connection,
        spawnedProcess: processRef,
        userDataDir
      };
    } catch (error) {
      lastError = error;
      processRef.kill("SIGKILL");
    }
  }

  await rm(userDataDir, {
    force: true,
    recursive: true
  });

  throw new Error(
    lastError instanceof Error
      ? lastError.message
      : "Unable to launch a Chromium browser for CDP."
  );
}

async function cleanupConnection(connection: CdpConnectionDetails): Promise<void> {
  const { spawnedProcess, userDataDir } = connection;

  if (spawnedProcess) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      spawnedProcess.once("exit", finish);
      spawnedProcess.kill("SIGTERM");
      setTimeout(() => {
        spawnedProcess.kill("SIGKILL");
        finish();
      }, 3_000);
    });
  }

  if (userDataDir) {
    await rm(userDataDir, {
      force: true,
      recursive: true
    });
  }
}

async function waitForDebuggerEndpoint(
  processRef: BrowserProcess,
  timeoutMs: number
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let stderr = "";

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      callback();
    };

    const onData = (chunk: unknown) => {
      const text = String(chunk);
      stderr += text;
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      const endpoint = match?.[1];
      if (endpoint) {
        finish(() => resolve(endpoint));
      }
    };

    const onError = (error: unknown) => {
      finish(() =>
        reject(error instanceof Error ? error : new Error(String(error)))
      );
    };

    const onExit = () => {
      finish(() =>
        reject(
          new Error(
            stderr
              ? `Browser exited before exposing CDP endpoint: ${stderr.trim()}`
              : "Browser exited before exposing CDP endpoint."
          )
        )
      );
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(new TimeoutError("Timed out waiting for the DevTools endpoint."))
      );
    }, timeoutMs);

    processRef.stderr?.on("data", onData);
    processRef.stdout?.on("data", onData);
    processRef.once("error", onError);
    processRef.once("exit", onExit);
  });
}

function buildConnectionFromWsEndpoint(browserWsEndpoint: string): CdpConnectionDetails {
  const parsed = new URL(browserWsEndpoint);
  return {
    browserWsEndpoint,
    host: parsed.hostname,
    port: Number(parsed.port)
  };
}

function defaultExecutableCandidates(platform = currentPlatform()): string[] {
  return executableCandidatesForChannel("chrome", platform).concat(
    executableCandidatesForChannel("chromium", platform),
    executableCandidatesForChannel("msedge", platform)
  );
}

function currentPlatform(): string {
  return (
    (globalThis as typeof globalThis & { process?: { platform?: string } }).process?.platform ??
    "unknown"
  );
}

export function resolveExecutableCandidates(
  options: Pick<LaunchOptions, "channel" | "executablePath">,
  platform = currentPlatform()
): string[] {
  if (options.executablePath) {
    return [options.executablePath];
  }

  if (options.channel) {
    return executableCandidatesForChannel(options.channel, platform);
  }

  return defaultExecutableCandidates(platform);
}

export function buildChromiumLaunchArgs(
  options: Pick<LaunchOptions, "args" | "headless">,
  userDataDir: string
): string[] {
  return [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
    ...(options.headless === false ? [] : ["--headless=new"]),
    ...(options.args ?? [])
  ];
}

function executableCandidatesForChannel(
  channel: NonNullable<LaunchOptions["channel"]>,
  platform: string
): string[] {
  const candidates = CHANNEL_EXECUTABLE_CANDIDATES[channel]?.[platform];
  if (!candidates?.length) {
    throw new Error(`Unsupported browser channel "${channel}" for platform "${platform}".`);
  }

  return candidates;
}

const CHANNEL_EXECUTABLE_CANDIDATES: Record<
  NonNullable<LaunchOptions["channel"]>,
  Partial<Record<string, string[]>>
> = {
  chromium: {
    darwin: ["/Applications/Chromium.app/Contents/MacOS/Chromium"],
    win32: [
      "C:\\Program Files\\Chromium\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe"
    ],
    linux: ["chromium", "chromium-browser"]
  },
  chrome: {
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    ],
    linux: ["google-chrome", "chrome"]
  },
  "chrome-beta": {
    darwin: ["/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"],
    win32: [
      "C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome Beta\\Application\\chrome.exe"
    ],
    linux: ["google-chrome-beta"]
  },
  "chrome-dev": {
    darwin: ["/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev"],
    win32: [
      "C:\\Program Files\\Google\\Chrome Dev\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome Dev\\Application\\chrome.exe"
    ],
    linux: ["google-chrome-unstable"]
  },
  "chrome-canary": {
    darwin: ["/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"],
    win32: ["C:\\Users\\%USERNAME%\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe"]
  },
  msedge: {
    darwin: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    win32: [
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    ],
    linux: ["microsoft-edge"]
  },
  "msedge-beta": {
    darwin: ["/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta"],
    win32: [
      "C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe"
    ],
    linux: ["microsoft-edge-beta"]
  },
  "msedge-dev": {
    darwin: ["/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev"],
    win32: [
      "C:\\Program Files\\Microsoft\\Edge Dev\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe"
    ],
    linux: ["microsoft-edge-dev"]
  },
  "msedge-canary": {
    darwin: ["/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary"],
    win32: [
      "C:\\Users\\%USERNAME%\\AppData\\Local\\Microsoft\\Edge SxS\\Application\\msedge.exe"
    ]
  }
};

function mapCdpHeaders(headers: Record<string, string | number | boolean>): Array<{
  name: string;
  value: string;
}> {
  return Object.entries(headers).map(([name, value]) => ({
    name,
    value: String(value)
  }));
}

async function safelyCloseClient(client: CdpClient): Promise<void> {
  try {
    await client.close();
  } catch {}
}

function resolveUrl(url: string, baseURL?: string): string {
  return baseURL ? new URL(url, baseURL).toString() : url;
}

function serializeForEvaluation(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function extractRemoteValue<TResult>(result: { value?: unknown; type?: string }): TResult {
  return (result.value as TResult | undefined) as TResult;
}

function formatCdpEvaluationError(response: {
  exceptionDetails?: {
    exception?: {
      description?: string;
      value?: unknown;
    };
    text?: string;
  };
}): string {
  const description = response.exceptionDetails?.exception?.description;
  if (description) {
    const firstLine = description
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (firstLine) {
      return firstLine;
    }
  }

  const value = response.exceptionDetails?.exception?.value;
  if (typeof value === "string" && value) {
    return value;
  }

  return response.exceptionDetails?.text || "Runtime evaluation failed.";
}

function formatConsoleText(
  args: Array<{
    description?: string;
    type?: string;
    unserializableValue?: string;
    value?: unknown;
  }>
): string {
  return args
    .map((arg) => {
      if (typeof arg.value === "string") {
        return arg.value;
      }
      if (arg.value !== undefined) {
        return String(arg.value);
      }
      if (arg.unserializableValue) {
        return arg.unserializableValue;
      }
      if (arg.description) {
        return arg.description;
      }
      return arg.type ?? "";
    })
    .join(" ");
}

function resolveKeyDefinition(key: string): {
  code: string;
  key: string;
  keyCode: number;
  text?: string;
} {
  const definitions: Record<string, { code: string; key: string; keyCode: number; text?: string }> =
    {
      Enter: { code: "Enter", key: "Enter", keyCode: 13, text: "\r" },
      Tab: { code: "Tab", key: "Tab", keyCode: 9 },
      Escape: { code: "Escape", key: "Escape", keyCode: 27 },
      Backspace: { code: "Backspace", key: "Backspace", keyCode: 8 },
      Delete: { code: "Delete", key: "Delete", keyCode: 46 },
      ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", keyCode: 37 },
      ArrowUp: { code: "ArrowUp", key: "ArrowUp", keyCode: 38 },
      ArrowRight: { code: "ArrowRight", key: "ArrowRight", keyCode: 39 },
      ArrowDown: { code: "ArrowDown", key: "ArrowDown", keyCode: 40 },
      Space: { code: "Space", key: " ", keyCode: 32, text: " " }
    };

  if (definitions[key]) {
    return definitions[key];
  }

  if (key.length === 1) {
    const upper = key.toUpperCase();
    return {
      code: `Key${upper}`,
      key,
      keyCode: upper.charCodeAt(0),
      text: key
    };
  }

  return {
    code: key,
    key,
    keyCode: 0
  };
}

async function retryOnNotAttachedToActivePage<TResult>(
  run: () => Promise<TResult>,
  attempts = 5
): Promise<TResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isNotAttachedToActivePageError(error) || attempt === attempts - 1) {
        throw error;
      }
      await delay(50);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isNotAttachedToActivePageError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Not attached to an active page/i.test(error.message)
  );
}

function shouldCaptureNavigationResponseUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function formatSelectorChain(chain: LocatorSelector[]): string {
  return chain
    .map((selector) => {
      if (selector.strategy === "css") {
        return selector.value;
      }
      if (selector.strategy === "xpath") {
        return `xpath=${selector.value}`;
      }
      if (selector.strategy === "text") {
        return `text=${selector.value}`;
      }
      return `${selector.strategy}=${selector.value}`;
    })
    .join(" >> ");
}

async function withTimeout<TResult>(
  promise: Promise<TResult>,
  timeoutMs: number | undefined,
  message: string
): Promise<TResult> {
  const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<TResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(message));
    }, effectiveTimeout);

    promise.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function delay(timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

function wrapLocatorError(locator: CdpLocatorState, error: unknown): LocatorError {
  if (error instanceof LocatorError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new LocatorError(`${message} Selector: ${formatLocator(locator)}`);
}

function formatLocator(locator: CdpLocatorState): string {
  const chain = locator.chain
    .map((selector) => {
      if (selector.strategy === "css") {
        return `css=${selector.value}`;
      }

      if (selector.strategy === "text") {
        return `text=${selector.isRegex ? `/${selector.value}/${selector.regexFlags ?? ""}` : selector.value}`;
      }

      const namePart =
        selector.name !== undefined || selector.nameIsRegex
          ? `, name=${
              selector.nameIsRegex
                ? `/${selector.name ?? ""}/${selector.nameRegexFlags ?? ""}`
                : selector.name
            }`
          : "";
      return `role=${selector.value}${namePart}`;
    })
    .join(" >> ");

  if (!locator.pick) {
    return chain;
  }

  if (locator.pick.kind === "nth") {
    return `${chain} >> nth=${locator.pick.index}`;
  }

  return `${chain} >> ${locator.pick.kind}`;
}
