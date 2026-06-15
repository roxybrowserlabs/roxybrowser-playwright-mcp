import {
  ARIA_REF_SELECTOR_EVALUATE_SOURCE,
  type ResolvedAriaRefResult,
  normalizeAriaSnapshotOptions,
  withOptionalTimeout
} from "../../ariaSnapshot.js";
import { PLAYWRIGHT_ARIA_SNAPSHOT_EVALUATE_SOURCE as ARIA_SNAPSHOT_EVALUATE_SOURCE } from "../../vendor/playwright/ariaSnapshotEvaluate.js";
import { NotImplementedInProtocolError, TimeoutError } from "../../errors.js";
import { createPageResponse } from "../../pageResponse.js";
import { createNavigationResult } from "../../navigationResult.js";
import type { ResolvedAriaRef } from "../../types/api.js";
import {
  SELECTOR_RUNTIME_SOURCE,
  type SelectorRuntimePayload
} from "../selectorRuntime.js";
import type {
  AriaSnapshotOptions,
  ClickOptions,
  BrowserConnectOptions,
  BrowserContextOptions,
  FillOptions,
  HoverOptions,
  MouseButton,
  PageGotoOptions,
  PressOptions,
  ScreenshotOptions,
  TypeOptions
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
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BidiProtocolClient } from "./client.js";
import { getBidiClientFactory } from "./client.js";

const BIDI_CAPABILITIES: ProtocolCapabilities = {
  protocol: "bidi",
  supportsMultipleContexts: true,
  supportsIsolatedWorlds: true,
  supportsLocatorChaining: true,
  supportsInputDispatch: true,
  supportsDownloads: false,
  supportsTracing: false
};

type BidiEvaluateResult =
  | {
      type: "success";
      result: BidiRemoteValue;
    }
  | {
      type: "exception";
      exceptionDetails: {
        text: string;
      };
    };

interface BidiRemoteValue {
  type: string | null;
  value?: unknown;
}

type LocatorPick =
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "nth"; index: number };

interface BidiLocatorState {
  chain: LocatorSelector[];
  pick?: LocatorPick;
}

interface ActionPoint {
  x: number;
  y: number;
}

interface StateWaiter {
  state: NonNullable<PageGotoOptions["waitUntil"]>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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

export class BidiBrowserAdapterFactory implements ProtocolBrowserAdapterFactory {
  create(options: BrowserConnectOptions): ProtocolBrowserAdapter {
    return new BidiBrowserAdapter(options);
  }
}

class BidiBrowserAdapter implements ProtocolBrowserAdapter {
  readonly protocol = "bidi" as const;
  readonly capabilities = BIDI_CAPABILITIES;

  private client: BidiProtocolClient | undefined;
  private ownsSession = false;
  private spawnedProcess: ReturnType<typeof spawn> | undefined;
  private userDataDir: string | undefined;

  constructor(private readonly options: BrowserConnectOptions) {}

  async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    if (this.options.browserName !== "firefox") {
      throw new Error('The BiDi backend currently only supports browserName "firefox".');
    }

    if (this.options.wsEndpoint) {
      const connection = await connectBidiFromWsEndpoint(
        this.options.wsEndpoint,
        this.options.sessionId
      );
      this.client = connection.client;
      this.ownsSession = connection.ownsSession;
      return;
    }

    const { client, ownsSession, process: proc, userDataDir } = await launchFirefoxBidi(this.options);
    this.client = client;
    this.ownsSession = ownsSession;
    this.spawnedProcess = proc;
    this.userDataDir = userDataDir;
  }

  async browser(): Promise<ProtocolBrowserSession> {
    if (!this.client) {
      throw new Error("BiDi browser adapter is not connected.");
    }

    return new BidiBrowserSession(this.client, this.ownsSession);
  }

  async close(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      this.client.close();
    } finally {
      this.client = undefined;
      this.ownsSession = false;
    }

    if (this.spawnedProcess) {
      await cleanupFirefoxProcess(this.spawnedProcess, this.userDataDir);
      this.spawnedProcess = undefined;
      this.userDataDir = undefined;
    }
  }
}

class BidiBrowserSession implements ProtocolBrowserSession {
  constructor(
    private readonly client: BidiProtocolClient,
    private readonly ownsSession: boolean
  ) {}

  async version(): Promise<string> {
    const browserName = this.client.capabilities.browserName ?? "firefox";
    const browserVersion = this.client.capabilities.browserVersion;
    return browserVersion ? `${browserName}/${browserVersion}` : browserName;
  }

  async newContext(
    options: BrowserContextOptions = {}
  ): Promise<ProtocolBrowserContextAdapter> {
    if (options.reuseDefaultUserContext) {
      return new BidiBrowserContextAdapter(this.client, undefined, options);
    }

    const response = await this.client.browserCreateUserContext({});
    return new BidiBrowserContextAdapter(this.client, response.userContext, options);
  }

  async close(): Promise<void> {
    if (this.ownsSession) {
      await this.client.sessionEnd({});
    }
  }
}

class BidiBrowserContextAdapter implements ProtocolBrowserContextAdapter {
  constructor(
    private readonly client: BidiProtocolClient,
    private readonly userContext: string | undefined,
    private readonly options: BrowserContextOptions
  ) {}

  async newPage(): Promise<ProtocolPageAdapter> {
    const response = await this.client.browsingContextCreate(
      this.userContext
        ? {
            type: "tab",
            userContext: this.userContext
          }
        : {
            type: "tab"
          }
    );

    const page = await BidiPageAdapter.create(this.client, response.context, this.options);
    return page;
  }

  async close(): Promise<void> {
    if (!this.userContext) {
      return;
    }

    await this.client.browserRemoveUserContext({
      userContext: this.userContext
    });
  }
}

class BidiPageAdapter implements ProtocolPageAdapter {
  private closed = false;
  private domContentLoaded = false;
  private loadFired = false;
  private sameDocumentNavigation = false;
  private allowSameDocumentNavigationToResolveWaiters = false;
  private responseDataCollector: string | undefined;
  private navigationResponseCapture: NavigationResponseCapture | undefined;
  private readonly stateWaiters = new Set<StateWaiter>();
  private readonly eventListeners = new Map<PageEventName, Set<PageEventListener<PageEventName>>>();
  private readonly bidiListeners = new Map<string, (payload: unknown) => void>();

  static async create(
    client: BidiProtocolClient,
    contextId: string,
    contextOptions: BrowserContextOptions
  ): Promise<BidiPageAdapter> {
    const page = new BidiPageAdapter(client, contextId, contextOptions);
    await page.initialize();
    return page;
  }

  private constructor(
    private readonly client: BidiProtocolClient,
    private readonly contextId: string,
    private readonly contextOptions: BrowserContextOptions
  ) {}

  private async initialize(): Promise<void> {
    await this.client.sessionSubscribe({
      contexts: [this.contextId],
      events: [
        "browsingContext.contextDestroyed",
        "browsingContext.domContentLoaded",
        "browsingContext.fragmentNavigated",
        "browsingContext.historyUpdated",
        "browsingContext.load",
        "log.entryAdded",
        "network.beforeRequestSent",
        "network.responseCompleted",
        "network.fetchError",
        "network.responseStarted"
      ]
    });
    const collectorResult = await this.client.networkAddDataCollector({
      contexts: [this.contextId],
      dataTypes: ["response"],
      maxEncodedDataSize: 10_000_000
    });
    this.responseDataCollector = collectorResult.collector;
    this.attachBiDiListeners();
    await this.applyContextOptions();
  }

  async goto(url: string, options: PageGotoOptions = {}): Promise<PageResponse | null> {
    const waitUntil = options.waitUntil ?? "load";
    const capture = this.beginNavigationResponseCapture();
    this.resetNavigationState();
    try {
      await this.client.browsingContextNavigate({
        context: this.contextId,
        url,
        wait: waitUntil === "domcontentloaded" ? "interactive" : "complete"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("blockedByPolicy")) {
        throw error;
      }

      await this.navigateViaLocation(url);
    }
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

    await this.client.browsingContextReload({
      context: this.contextId,
      wait: waitUntil === "domcontentloaded" ? "interactive" : "complete"
    });

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
    return this.evaluateExpression<string>(
      `(() => {
        const doctype = document.doctype
          ? "<!DOCTYPE " + document.doctype.name + ">"
          : "";
        return doctype + document.documentElement.outerHTML;
      })()`
    );
  }

  async setContent(html: string): Promise<void> {
    await this.evaluateFunction<void>(
      `(payload) => {
        document.open();
        document.write(payload.html);
        document.close();
      }`,
      { html }
    );
  }

  private async navigateViaLocation(url: string): Promise<void> {
    await this.evaluateFunction<void>(
      `(payload) => {
        globalThis.location.href = payload.url;
      }`,
      { url }
    );
  }

  async evaluate<TResult>(expression: string, arg?: unknown): Promise<TResult> {
    // Convert function to string if needed (handles cases where a function is passed instead of string)
    const expressionStr = typeof expression === "function"
      ? (expression as unknown as Function).toString()
      : expression;

    if (arg === undefined && !looksLikeFunctionExpression(expressionStr)) {
      return this.evaluateExpression<TResult>(expressionStr);
    }

    return this.evaluateFunction<TResult>(expressionStr, arg);
  }

  async waitForLoadState(
    state: PageGotoOptions["waitUntil"] = "load",
    timeout = 30_000
  ): Promise<void> {
    const targetState = state ?? "load";
    if (targetState === "commit" || this.isStateSatisfied(targetState)) {
      return;
    }

    if (await this.isCurrentDocumentReadyFor(targetState)) {
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
    const result = await withOptionalTimeout(
      this.evaluateFunction<{ text: string }>(ARIA_SNAPSHOT_EVALUATE_SOURCE, {
        options: normalizedOptions
      }),
      normalizedOptions.timeout,
      'Timed out while generating page.ariaSnapshot().'
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
    const response = await this.client.browsingContextCaptureScreenshot({
      context: this.contextId,
      ...(options.fullPage ? { origin: "document" } : {}),
      format: {
        type: options.type ?? "png",
        ...(options.quality !== undefined ? { quality: options.quality } : {})
      }
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
    return new BidiElementHandleAdapter(this, {
      chain: selector,
      pick: { kind: "first" }
    });
  }

  async queryAll(selector: LocatorSelector[]): Promise<ProtocolElementHandleAdapter[]> {
    const count = await this.countSelector({
      chain: selector
    });
    return Array.from({ length: count }, (_value, index) => {
      return new BidiElementHandleAdapter(this, {
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
    return new BidiLocatorAdapter(this, {
      chain: [selector]
    });
  }

  getByText(text: string | RegExp, options?: { exact?: boolean }): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter(this, {
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

  getByRole(role: string, options?: { exact?: boolean; name?: string | RegExp }): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter(this, {
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
    this.rejectWaiters(new Error("Page closed."));

    await this.client.browsingContextClose({
      context: this.contextId
    });
    this.emit("close", undefined);
    await this.cleanupBiDiListeners();
  }

  async applyContextOptions(): Promise<void> {
    if (this.contextOptions.viewport) {
      await this.client.browsingContextSetViewport({
        context: this.contextId,
        viewport: {
          width: this.contextOptions.viewport.width,
          height: this.contextOptions.viewport.height
        },
        devicePixelRatio: 1
      });
    }

    if (this.contextOptions.locale) {
      await this.client.emulationSetLocaleOverride({
        locale: this.contextOptions.locale,
        contexts: [this.contextId]
      });
    }

    if (this.contextOptions.timezoneId) {
      await this.client.emulationSetTimezoneOverride({
        timezone: this.contextOptions.timezoneId,
        contexts: [this.contextId]
      });
    }

    if (this.contextOptions.userAgent) {
      await this.client.emulationSetUserAgentOverride({
        userAgent: this.contextOptions.userAgent,
        contexts: [this.contextId]
      });
    }
  }

  private async evaluateExpression<TResult>(expression: string): Promise<TResult> {
    const response = await this.client.scriptEvaluate({
      expression,
      target: {
        context: this.contextId
      },
      awaitPromise: true,
      resultOwnership: "none"
    }) as BidiEvaluateResult;

    if (response.type === "exception") {
      throw new Error(response.exceptionDetails.text || "BiDi evaluation failed.");
    }

    return extractBiDiValue<TResult>(response.result);
  }

  private async evaluateFunction<TResult>(expression: string, arg?: unknown): Promise<TResult> {
    const serializedArg = arg === undefined ? "" : serializeForEvaluation(arg);
    const wrappedExpression =
      arg === undefined ? `(${expression})()` : `(${expression})(${serializedArg})`;
    return this.evaluateExpression<TResult>(wrappedExpression);
  }

  async clickLocator(locator: BidiLocatorState, options?: ClickOptions): Promise<void> {
    const point = await this.resolveActionPoint(locator, options);
    const button = buttonNumber(options?.button ?? "left");
    const clickCount = options?.clickCount ?? 1;

    for (let index = 0; index < clickCount; index += 1) {
      await this.client.inputPerformActions({
        context: this.contextId,
        actions: [
          {
            type: "pointer",
            id: "mouse",
            parameters: { pointerType: "mouse" },
            actions: [
              {
                type: "pointerMove",
                x: Math.round(point.x),
                y: Math.round(point.y),
                origin: "viewport"
              },
              {
                type: "pointerDown",
                button
              },
              ...(options?.delay ? [{ type: "pause", duration: options.delay } as const] : []),
              {
                type: "pointerUp",
                button
              }
            ]
          }
        ]
      });
    }
  }

  async hoverLocator(locator: BidiLocatorState, options?: HoverOptions): Promise<void> {
    const point = await this.resolveActionPoint(locator, options);
    await this.client.inputPerformActions({
      context: this.contextId,
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              x: Math.round(point.x),
              y: Math.round(point.y),
              origin: "viewport"
            }
          ]
        }
      ]
    });
  }

  async fillLocator(locator: BidiLocatorState, value: string, options?: FillOptions): Promise<void> {
    await this.runLocatorOperation<boolean>(locator, {
      operation: "fill",
      ...(options?.force !== undefined ? { force: options.force } : {}),
      value
    });
  }

  async typeLocator(locator: BidiLocatorState, value: string, options?: TypeOptions): Promise<void> {
    await this.runLocatorOperation<boolean>(locator, {
      operation: "focus"
    });

    const actions = value.split("").flatMap((character) => [
      { type: "keyDown" as const, value: character },
      ...(options?.delay ? [{ type: "pause" as const, duration: options.delay }] : []),
      { type: "keyUp" as const, value: character }
    ]);

    await this.client.inputPerformActions({
      context: this.contextId,
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions
        }
      ]
    });
  }

  async pressLocator(locator: BidiLocatorState, key: string, options?: PressOptions): Promise<void> {
    await this.runLocatorOperation<boolean>(locator, {
      operation: "focus"
    });

    const bidiKey = toBiDiKeyValue(key);
    await this.client.inputPerformActions({
      context: this.contextId,
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            { type: "keyDown", value: bidiKey },
            ...(options?.delay ? [{ type: "pause" as const, duration: options.delay }] : []),
            { type: "keyUp", value: bidiKey }
          ]
        }
      ]
    });
  }

  async textContentLocator(locator: BidiLocatorState): Promise<string | null> {
    return this.runLocatorOperation<string | null>(locator, {
      operation: "textContent"
    });
  }

  async isVisibleLocator(locator: BidiLocatorState): Promise<boolean> {
    return this.runLocatorOperation<boolean>(locator, {
      operation: "isVisible"
    });
  }

  private async resolveActionPoint(
    locator: BidiLocatorState,
    options?: HoverOptions
  ): Promise<ActionPoint> {
    return this.runSelectorOperation<ActionPoint>({
      operation: "actionPoint",
      reference: {
        chain: locator.chain,
        ...(locator.pick ? { pick: locator.pick } : {})
      },
      ...(options?.force !== undefined ? { force: options.force } : {}),
      ...(options?.position ? { position: options.position } : {})
    });
  }

  private async runLocatorOperation<TResult>(
    locator: BidiLocatorState,
    payload: Omit<SelectorRuntimePayload, "reference">
  ): Promise<TResult> {
    return this.runSelectorOperation<TResult>({
      ...payload,
      reference: {
        chain: locator.chain,
        ...(locator.pick ? { pick: locator.pick } : {})
      }
    });
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
    const point = await this.runSelectorOperation<ActionPoint>({
      operation: "actionPoint",
      reference,
      ...(options?.force !== undefined ? { force: options.force } : {}),
      ...(options?.position ? { position: options.position } : {})
    });
    const button = buttonNumber(options?.button ?? "left");
    const clickCount = options?.clickCount ?? 1;

    for (let index = 0; index < clickCount; index += 1) {
      await this.client.inputPerformActions({
        context: this.contextId,
        actions: [
          {
            type: "pointer",
            id: "mouse",
            parameters: { pointerType: "mouse" },
            actions: [
              {
                type: "pointerMove",
                x: Math.round(point.x),
                y: Math.round(point.y),
                origin: "viewport"
              },
              {
                type: "pointerDown",
                button
              },
              ...(options?.delay ? [{ type: "pause", duration: options.delay } as const] : []),
              {
                type: "pointerUp",
                button
              }
            ]
          }
        ]
      });
    }
  }

  async hoverReference(reference: ProtocolElementHandleReference, options?: HoverOptions): Promise<void> {
    const point = await this.runSelectorOperation<ActionPoint>({
      operation: "actionPoint",
      reference,
      ...(options?.force !== undefined ? { force: options.force } : {}),
      ...(options?.position ? { position: options.position } : {})
    });
    await this.client.inputPerformActions({
      context: this.contextId,
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              x: Math.round(point.x),
              y: Math.round(point.y),
              origin: "viewport"
            }
          ]
        }
      ]
    });
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

    const actions = value.split("").flatMap((character) => [
      { type: "keyDown" as const, value: character },
      ...(options?.delay ? [{ type: "pause" as const, duration: options.delay }] : []),
      { type: "keyUp" as const, value: character }
    ]);

    await this.client.inputPerformActions({
      context: this.contextId,
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions
        }
      ]
    });
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

    const bidiKey = toBiDiKeyValue(key);
    await this.client.inputPerformActions({
      context: this.contextId,
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            { type: "keyDown", value: bidiKey },
            ...(options?.delay ? [{ type: "pause" as const, duration: options.delay }] : []),
            { type: "keyUp", value: bidiKey }
          ]
        }
      ]
    });
  }

  private async runSelectorOperation<TResult>(payload: SelectorRuntimePayload): Promise<TResult> {
    return this.evaluateFunction<TResult>(SELECTOR_RUNTIME_SOURCE, payload);
  }

  private attachBiDiListeners(): void {
    this.attachBiDiListener("browsingContext.domContentLoaded", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }

      this.domContentLoaded = true;
      this.flushWaiters();
      this.emit("domcontentloaded", undefined);
    });

    this.attachBiDiListener("browsingContext.fragmentNavigated", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }

      this.sameDocumentNavigation = true;
      this.domContentLoaded = true;
      this.loadFired = true;
      if (this.allowSameDocumentNavigationToResolveWaiters) {
        this.flushWaiters();
      }
    });

    this.attachBiDiListener("browsingContext.historyUpdated", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }

      this.sameDocumentNavigation = true;
      this.domContentLoaded = true;
      this.loadFired = true;
      if (this.allowSameDocumentNavigationToResolveWaiters) {
        this.flushWaiters();
      }
    });

    this.attachBiDiListener("browsingContext.load", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }

      this.loadFired = true;
      this.flushWaiters();
      this.emit("load", undefined);
    });

    this.attachBiDiListener("log.entryAdded", (payload) => {
      if (!hasLogContext(payload, this.contextId)) {
        return;
      }

      const logPayload = payload as {
        method?: string;
        text?: string | null;
        type?: string;
      };
      this.emit("console", {
        text: () => logPayload.text ?? "",
        type: () => logPayload.method ?? logPayload.type ?? "log"
      });
    });

    this.attachBiDiListener("network.beforeRequestSent", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }

      const requestPayload = payload as {
        request: {
          headers: Array<{ name: string; value: { value: string } | string }>;
          method: string;
          url: string;
        };
      };
      this.emit("request", {
        headers: mapBiDiHeaders(requestPayload.request.headers),
        method: requestPayload.request.method,
        url: requestPayload.request.url
      });
    });

    this.attachBiDiListener("network.responseStarted", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }

      const responsePayload = payload as {
        context: string | null;
        navigation: string | null;
        request: { destination: string; request: string; url: string };
        response: {
          fromCache: boolean;
          headers: Array<{ name: string; value: { value: string } | string }>;
          mimeType: string;
          status: number;
          statusText: string;
          url: string;
        };
      };
      const response = createPageResponse({
        fromCache: responsePayload.response.fromCache,
        headers: mapBiDiHeaders(responsePayload.response.headers),
        mimeType: responsePayload.response.mimeType,
        status: responsePayload.response.status,
        statusText: responsePayload.response.statusText,
        text: () => this.getResponseText(responsePayload.request.request),
        url: responsePayload.response.url || responsePayload.request.url
      });
      this.emit("response", response);
      if (
        this.navigationResponseCapture &&
        responsePayload.context === this.contextId &&
        responsePayload.navigation !== null &&
        responsePayload.request.destination === "document" &&
        shouldCaptureNavigationResponseUrl(response.url)
      ) {
        this.navigationResponseCapture.lastResponse = response;
      }
    });

    this.attachBiDiListener("network.responseCompleted", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }

      void payload;
    });

    this.attachBiDiListener("network.fetchError", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }

      const failedPayload = payload as {
        errorText: string;
        request: {
          method: string;
          url: string;
        };
      };
      this.emit("requestfailed", {
        errorText: failedPayload.errorText,
        method: failedPayload.request.method,
        url: failedPayload.request.url
      });
    });

    this.attachBiDiListener("browsingContext.contextDestroyed", (payload) => {
      if (!hasContext(payload, this.contextId) || this.closed) {
        return;
      }

      this.closed = true;
      this.rejectWaiters(new Error("Page closed."));
      this.emit("close", undefined);
      void this.cleanupBiDiListeners();
    });
  }

  private attachBiDiListener(
    event: string,
    listener: (payload: unknown) => void
  ): void {
    this.bidiListeners.set(event, listener);
    this.client.on(event as never, listener as never);
  }

  private async cleanupBiDiListeners(): Promise<void> {
    for (const [event, listener] of this.bidiListeners) {
      this.client.removeListener(event, listener);
    }
    this.bidiListeners.clear();

    try {
      await this.client.sessionUnsubscribe({
        contexts: [this.contextId],
        events: [
          "browsingContext.contextDestroyed",
          "browsingContext.domContentLoaded",
          "browsingContext.fragmentNavigated",
          "browsingContext.historyUpdated",
          "browsingContext.load",
          "log.entryAdded",
          "network.beforeRequestSent",
          "network.responseCompleted",
          "network.fetchError",
          "network.responseStarted"
        ]
      });
    } catch {}

    if (this.responseDataCollector) {
      try {
        await this.client.networkRemoveDataCollector({
          collector: this.responseDataCollector
        });
      } catch {}
      this.responseDataCollector = undefined;
    }
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

  private async navigateHistory(
    delta: -1 | 1,
    options: PageGotoOptions
  ): Promise<ReturnType<typeof createNavigationResult> | null> {
    const previousUrl = await this.url();
    this.resetNavigationState();
    this.allowSameDocumentNavigationToResolveWaiters = true;
    try {
      await this.client.browsingContextTraverseHistory({
        context: this.contextId,
        delta
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/history/i.test(message) || /no such/i.test(message)) {
        return null;
      }
      throw error;
    }

    const waitUntil = options.waitUntil ?? "load";
    if (waitUntil !== "commit") {
      await this.waitForLoadState(waitUntil, options.timeout);
    }

    const currentUrl = await this.url();
    if (currentUrl === previousUrl) {
      return null;
    }

    return createNavigationResult({
      url: currentUrl
    });
  }

  private isStateSatisfied(state: NonNullable<PageGotoOptions["waitUntil"]>): boolean {
    if (this.sameDocumentNavigation && this.allowSameDocumentNavigationToResolveWaiters) {
      return true;
    }

    switch (state) {
      case "domcontentloaded":
        return this.domContentLoaded;
      case "load":
      case "networkidle":
        return this.loadFired;
      case "commit":
        return true;
    }
  }

  private async isCurrentDocumentReadyFor(
    state: NonNullable<PageGotoOptions["waitUntil"]>
  ): Promise<boolean> {
    try {
      const readyState = await this.evaluateExpression<string>("document.readyState");
      if (state === "domcontentloaded") {
        return readyState === "interactive" || readyState === "complete";
      }
      return readyState === "complete";
    } catch {
      return false;
    }
  }

  private flushWaiters(): void {
    for (const waiter of Array.from(this.stateWaiters)) {
      if (this.isStateSatisfied(waiter.state)) {
        waiter.resolve();
      }
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of Array.from(this.stateWaiters)) {
      waiter.reject(error);
    }
    this.stateWaiters.clear();
  }

  private resetNavigationState(): void {
    this.domContentLoaded = false;
    this.loadFired = false;
    this.sameDocumentNavigation = false;
    this.allowSameDocumentNavigationToResolveWaiters = false;
  }

  private beginNavigationResponseCapture(): NavigationResponseCapture {
    const capture: NavigationResponseCapture = {
      lastResponse: null
    };
    this.navigationResponseCapture = capture;
    return capture;
  }

  private async getResponseText(requestId: string): Promise<string> {
    if (!this.responseDataCollector) {
      return "";
    }
    const response = await this.client.networkGetData({
      collector: this.responseDataCollector,
      dataType: "response",
      request: requestId
    });
    return response.bytes.type === "base64"
      ? Buffer.from(response.bytes.value, "base64").toString("utf8")
      : response.bytes.value;
  }
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

class BidiLocatorAdapter implements ProtocolLocatorAdapter {
  constructor(
    private readonly page: BidiPageAdapter,
    private readonly state: BidiLocatorState
  ) {}

  locator(selector: LocatorSelector): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter(this.page, {
      ...this.state,
      chain: [...this.state.chain, selector]
    });
  }

  first(): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter(this.page, {
      ...this.state,
      pick: { kind: "first" }
    });
  }

  last(): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter(this.page, {
      ...this.state,
      pick: { kind: "last" }
    });
  }

  nth(index: number): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter(this.page, {
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

class BidiElementHandleAdapter implements ProtocolElementHandleAdapter {
  constructor(
    private readonly page: BidiPageAdapter,
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
    return new BidiElementHandleAdapter(this.page, {
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
      return new BidiElementHandleAdapter(this.page, {
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

function extractBiDiValue<TResult>(value: BidiRemoteValue): TResult {
  if (value.type === "array" && Array.isArray(value.value)) {
    return value.value.map((entry) => extractBiDiValue(entry as BidiRemoteValue)) as TResult;
  }

  // BiDi returns objects as arrays of [key, value] pairs
  if (value.type === "object" && Array.isArray(value.value)) {
    const obj: Record<string, unknown> = {};
    for (const [key, val] of value.value as Array<[string, BidiRemoteValue]>) {
      obj[key] = extractBiDiValue(val);
    }
    return obj as TResult;
  }

  return value.value as TResult;
}

function serializeForEvaluation(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function buttonNumber(button: MouseButton): number {
  switch (button) {
    case "left":
      return 0;
    case "middle":
      return 1;
    case "right":
      return 2;
  }
}

function hasContext(payload: unknown, contextId: string): boolean {
  if (!payload || typeof payload !== "object" || !("context" in payload)) {
    return false;
  }

  return (payload as { context: string | null }).context === contextId;
}

function hasLogContext(payload: unknown, contextId: string): boolean {
  if (!payload || typeof payload !== "object" || !("source" in payload)) {
    return false;
  }

  return (
    (payload as { source?: { context?: string | null } }).source?.context ===
    contextId
  );
}

function mapBiDiHeaders(
  headers: Array<{ name: string; value: { value: string } | string }>
): Array<{ name: string; value: string }> {
  return headers.map((header) => ({
    name: header.name,
    value:
      typeof header.value === "string"
        ? header.value
        : header.value.value
  }));
}

function toBiDiKeyValue(key: string): string {
  switch (key) {
    case "Enter":
      return "\uE007";
    case "Tab":
      return "\uE004";
    case "Backspace":
      return "\uE003";
    case "Escape":
      return "\uE00C";
    default:
      return key;
  }
}

async function connectBidiFromWsEndpoint(
  wsEndpoint: string,
  sessionId?: string
): Promise<BidiConnectionResult> {
  const bidiEndpoint = buildFirefoxBidiEndpoint(wsEndpoint, sessionId);
  // Firefox BiDi endpoints are direct WebSocket connections and do not expose
  // CDP-style discovery endpoints such as /json/version.
  const client = await getBidiClientFactory()({
    webSocketUrl: bidiEndpoint,
    browserName: "firefox"
  });

  try {
    const ownsSession = await ensureBiDiSession(client, sessionId, wsEndpoint);
    return {
      client,
      ownsSession
    };
  } catch (error) {
    client.close();
    throw error;
  }
}

interface FirefoxLaunchResult {
  client: BidiProtocolClient;
  process: ReturnType<typeof spawn> | undefined;
  ownsSession: boolean;
  userDataDir: string;
}

interface BidiConnectionResult {
  client: BidiProtocolClient;
  ownsSession: boolean;
}

async function launchFirefoxBidi(options: BrowserConnectOptions): Promise<FirefoxLaunchResult> {
  const userDataDir = await mkdtemp(join(tmpdir(), "roxybrowser-bidi-"));
  const executable = options.executablePath ?? defaultFirefoxExecutable();
  await assertFirefoxExecutable(executable);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? await pickFreePort();
  const args = buildFirefoxLaunchArgs(options, userDataDir, port);
  const proc = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const wsEndpoint = await waitForFirefoxBiDiEndpoint(proc, host, port, 15_000);
    const connection = await connectBidiFromWsEndpoint(wsEndpoint, options.sessionId);
    return {
      client: connection.client,
      ownsSession: connection.ownsSession,
      process: proc,
      userDataDir
    };
  } catch (error) {
    await cleanupFirefoxProcess(proc, userDataDir);
    throw error;
  }
}

async function cleanupFirefoxProcess(
  proc: ReturnType<typeof spawn> | undefined,
  userDataDir: string | undefined
): Promise<void> {
  if (proc) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      proc.once("exit", finish);
      proc.once("close", finish);
      proc.once("error", finish);
      try {
        proc.kill("SIGTERM");
      } catch {
        finish();
        return;
      }
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // The process may have failed to spawn or already exited.
        }
        finish();
      }, 5_000);
    });
  }

  if (userDataDir) {
    await rm(userDataDir, { force: true, recursive: true });
  }
}

async function assertFirefoxExecutable(executable: string): Promise<void> {
  if (!isExplicitExecutablePath(executable)) {
    return;
  }

  try {
    await access(executable);
  } catch {
    throw new Error(
      `Firefox executable was not found at "${executable}". Pass executablePath or set ROXY_EXECUTABLE_PATH/ROXY_BIDI_EXECUTABLE_PATH to a Firefox binary with WebDriver BiDi support.`
    );
  }
}

function isExplicitExecutablePath(executable: string): boolean {
  return executable.includes("/") || executable.includes("\\");
}

function waitForFirefoxBiDiEndpoint(
  proc: ReturnType<typeof spawn>,
  host: string,
  port: number,
  timeoutMs: number
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let stdout = "";

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stderr?.off("data", onStderr);
      proc.stdout?.off("data", onStdout);
      proc.off("error", onError);
      proc.off("exit", onExit);
      callback();
    };

    const maybeResolveFromOutput = () => {
      const output = `${stderr}\n${stdout}`;
      const endpoint = output.match(/WebDriver BiDi listening on (ws:\/\/[^\s]+)/)?.[1];
      if (endpoint) {
        finish(() => resolve(endpoint));
        return;
      }

      if (output.includes("WebDriver BiDi listening")) {
        finish(() => resolve(`ws://${host}:${port}`));
      }
    };

    const onStderr = (chunk: unknown) => {
      stderr += String(chunk);
      maybeResolveFromOutput();
    };

    const onStdout = (chunk: unknown) => {
      stdout += String(chunk);
      maybeResolveFromOutput();
    };

    const onError = (error: unknown) => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    };

    const onExit = () => {
      finish(() =>
        reject(new Error(
          stderr || stdout
            ? `Firefox exited before exposing BiDi endpoint:\nstderr: ${stderr.trim()}\nstdout: ${stdout.trim()}`
            : "Firefox exited before exposing BiDi endpoint."
        ))
      );
    };

    const timer = setTimeout(() => {
      finish(() => reject(new TimeoutError(
        `Timed out waiting for Firefox BiDi endpoint.\nstderr: ${stderr.trim()}\nstdout: ${stdout.trim()}`
      )));
    }, timeoutMs);

    proc.stderr?.on("data", onStderr);
    proc.stdout?.on("data", onStdout);
    proc.once("error", onError);
    proc.once("exit", onExit);
  });
}

async function pickFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Failed to pick a free port."));
        }
      });
    });
  });
}

function buildFirefoxBidiEndpoint(wsEndpoint: string, sessionId?: string): string {
  const url = new URL(wsEndpoint);

  if (sessionId) {
    url.pathname = `/session/${sessionId}`;
    return url.toString();
  }

  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/session";
  }

  return url.toString();
}

function isSessionSpecificFirefoxBidiEndpoint(wsEndpoint: string): boolean {
  const pathname = new URL(wsEndpoint).pathname;
  return /^\/session\/[^/]+$/.test(pathname);
}

async function ensureBiDiSession(
  client: BidiProtocolClient,
  sessionId: string | undefined,
  wsEndpoint: string
): Promise<boolean> {
  await client.sessionStatus({});

  if (sessionId || isSessionSpecificFirefoxBidiEndpoint(wsEndpoint)) {
    return false;
  }

  try {
    await client.browsingContextGetTree({});
    return false;
  } catch (error) {
    if (!String(error instanceof Error ? error.message : error).includes("session does not exist")) {
      throw error;
    }
  }

  try {
    await client.sessionNew({
      capabilities: {
        alwaysMatch: {
          acceptInsecureCerts: true
        }
      }
    });
    return true;
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (message.includes("Maximum number of active sessions")) {
      throw new Error(
        "Maximum number of active BiDi sessions. Reuse an existing one with sessionId or close the current session first."
      );
    }
    throw error;
  }
}

export function buildFirefoxLaunchArgs(
  options: Pick<BrowserConnectOptions, "args" | "headless">,
  userDataDir: string,
  port: number
): string[] {
  return [
    "-profile",
    userDataDir,
    "-no-remote",
    `--remote-debugging-port=${port}`,
    ...(options.headless === false ? [] : ["-headless"]),
    ...(options.args ?? [])
  ];
}

function defaultFirefoxExecutable(): string {
  switch (process.platform) {
    case "darwin":
      return "/Applications/Firefox.app/Contents/MacOS/firefox";
    case "win32":
      return "C:\\Program Files\\Mozilla Firefox\\firefox.exe";
    default:
      return "firefox";
  }
}
