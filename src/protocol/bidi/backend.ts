import {
  ARIA_REF_SELECTOR_EVALUATE_SOURCE,
  ARIA_SNAPSHOT_EVALUATE_SOURCE,
  type ResolvedAriaRefResult,
  normalizeAriaSnapshotOptions,
  withOptionalTimeout
} from "../../ariaSnapshot.js";
import { NotImplementedInProtocolError } from "../../errors.js";
import type { ResolvedAriaRef } from "../../types/api.js";
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
  PageEventName
} from "../../types/events.js";
import type {
  LocatorSelector,
  ProtocolBrowserAdapter,
  ProtocolBrowserAdapterFactory,
  ProtocolBrowserContextAdapter,
  ProtocolBrowserSession,
  ProtocolLocatorAdapter,
  ProtocolPageAdapter
} from "../adapter.js";
import type { ProtocolCapabilities } from "../capabilities.js";
import WebDriver from "webdriver";
import type { Client as WebDriverClient } from "webdriver";

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

  private client: WebDriverClient | undefined;

  constructor(private readonly options: BrowserConnectOptions) {}

  async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    if (this.options.browserName !== "firefox") {
      throw new Error('The BiDi backend currently only supports browserName "firefox".');
    }

    if (this.options.wsEndpoint) {
      throw new Error("Firefox BiDi attach by wsEndpoint is not implemented on the webdriver backend yet.");
    }

    this.client = await WebDriver.newSession({
      capabilities: {
        alwaysMatch: {
          browserName: "firefox",
          acceptInsecureCerts: true,
          "moz:firefoxOptions": {
            ...(this.options.executablePath ? { binary: this.options.executablePath } : {}),
            args: [
              ...(this.options.headless === false ? [] : ["-headless"]),
              ...(this.options.args ?? [])
            ]
          }
        },
        firstMatch: [{}]
      }
    });
  }

  async browser(): Promise<ProtocolBrowserSession> {
    if (!this.client) {
      throw new Error("BiDi browser adapter is not connected.");
    }

    return new BidiBrowserSession(this.client);
  }

  async close(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      await this.client.deleteSession();
    } finally {
      this.client = undefined;
    }
  }
}

class BidiBrowserSession implements ProtocolBrowserSession {
  constructor(private readonly client: WebDriverClient) {}

  async version(): Promise<string> {
    return `${this.client.capabilities.browserName}/${this.client.capabilities.browserVersion}`;
  }

  async newContext(
    options: BrowserContextOptions = {}
  ): Promise<ProtocolBrowserContextAdapter> {
    const response = await this.client.browserCreateUserContext({});
    return new BidiBrowserContextAdapter(this.client, response.userContext, options);
  }

  async close(): Promise<void> {}
}

class BidiBrowserContextAdapter implements ProtocolBrowserContextAdapter {
  constructor(
    private readonly client: WebDriverClient,
    private readonly userContext: string,
    private readonly options: BrowserContextOptions
  ) {}

  async newPage(): Promise<ProtocolPageAdapter> {
    const response = await this.client.browsingContextCreate({
      type: "tab",
      userContext: this.userContext
    });

    const page = await BidiPageAdapter.create(this.client, response.context, this.options);
    return page;
  }

  async close(): Promise<void> {
    await this.client.browserRemoveUserContext({
      userContext: this.userContext
    });
  }
}

class BidiPageAdapter implements ProtocolPageAdapter {
  private closed = false;
  private readonly eventListeners = new Map<PageEventName, Set<PageEventListener<PageEventName>>>();
  private readonly bidiListeners = new Map<string, (payload: unknown) => void>();

  static async create(
    client: WebDriverClient,
    contextId: string,
    contextOptions: BrowserContextOptions
  ): Promise<BidiPageAdapter> {
    const page = new BidiPageAdapter(client, contextId, contextOptions);
    await page.initialize();
    return page;
  }

  private constructor(
    private readonly client: WebDriverClient,
    private readonly contextId: string,
    private readonly contextOptions: BrowserContextOptions
  ) {}

  private async initialize(): Promise<void> {
    await this.client.sessionSubscribe({
      contexts: [this.contextId],
      events: [
        "browsingContext.contextDestroyed",
        "browsingContext.domContentLoaded",
        "browsingContext.load",
        "network.beforeRequestSent",
        "network.fetchError",
        "network.responseStarted"
      ]
    });
    this.attachBiDiListeners();
    await this.applyContextOptions();
  }

  async goto(url: string, options: PageGotoOptions = {}): Promise<void> {
    await this.client.browsingContextNavigate({
      context: this.contextId,
      url,
      wait: options.waitUntil === "domcontentloaded" ? "interactive" : "complete"
    });
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

  async evaluate<TResult>(expression: string, arg?: unknown): Promise<TResult> {
    if (arg === undefined) {
      return this.evaluateExpression<TResult>(expression);
    }

    return this.evaluateFunction<TResult>(expression, arg);
  }

  async waitForLoadState(_state?: PageGotoOptions["waitUntil"]): Promise<void> {}

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
    return this.runLocatorOperation<ActionPoint>(locator, {
      operation: "actionPoint",
      ...(options?.force !== undefined ? { force: options.force } : {}),
      ...(options?.position ? { position: options.position } : {})
    });
  }

  private async runLocatorOperation<TResult>(
    locator: BidiLocatorState,
    payload: Omit<LocatorPayload, "chain" | "pick">
  ): Promise<TResult> {
    return this.evaluateFunction<TResult>(LOCATOR_OPERATION_SOURCE, {
      ...payload,
      chain: locator.chain,
      pick: locator.pick
    });
  }

  private attachBiDiListeners(): void {
    this.attachBiDiListener("browsingContext.domContentLoaded", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }

      this.emit("domcontentloaded", undefined);
    });

    this.attachBiDiListener("browsingContext.load", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }

      this.emit("load", undefined);
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
        request: { url: string };
        response: {
          fromCache: boolean;
          headers: Array<{ name: string; value: { value: string } | string }>;
          mimeType: string;
          status: number;
          statusText: string;
          url: string;
        };
      };
      this.emit("response", {
        fromCache: responsePayload.response.fromCache,
        headers: mapBiDiHeaders(responsePayload.response.headers),
        mimeType: responsePayload.response.mimeType,
        status: responsePayload.response.status,
        statusText: responsePayload.response.statusText,
        url: responsePayload.response.url || responsePayload.request.url
      });
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
          "browsingContext.load",
          "network.beforeRequestSent",
          "network.fetchError",
          "network.responseStarted"
        ]
      });
    } catch {}
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

function extractBiDiValue<TResult>(value: BidiRemoteValue): TResult {
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
