import {
  ARIA_REF_SELECTOR_EVALUATE_SOURCE,
  type ResolvedAriaRefResult,
  normalizeAriaSnapshotOptions,
  withOptionalTimeout
} from "../../ariaSnapshot.js";
import { PLAYWRIGHT_ARIA_SNAPSHOT_EVALUATE_SOURCE as ARIA_SNAPSHOT_EVALUATE_SOURCE } from "../../vendor/playwright/ariaSnapshotEvaluate.js";
import { NotImplementedInProtocolError, TimeoutError } from "../../errors.js";
import { mergeExtraHTTPHeaders } from "../../httpHeaders.js";
import { createPageResponse } from "../../pageResponse.js";
import {
  parseSerializedEvaluationResult,
  wrapWithSerializedEvaluationResult
} from "../evaluationSerializer.js";
import {
  isKeyboardModifier,
  isUsKeyboardLayoutKey,
  keyDescriptionForString,
  resolveSmartModifierString,
  splitKeyboardShortcut
} from "../keyboardInput.js";
import type { Disposable, ResolvedAriaRef } from "../../types/api.js";
import {
  SCROLL_INTO_VIEW_IF_NEEDED_SOURCE,
  SELECTOR_RUNTIME_SOURCE,
  type SelectOptionRetryResult,
  type SelectorRuntimePayload
} from "../selectorRuntime.js";
import type { NormalizedSelectOption } from "../../selectOptionValues.js";
import {
  createChapterOverlayHtml,
  RENDER_SCREencast_OVERLAYS_SOURCE
} from "../../screencastOverlay.js";
import { RENDER_SCREENCAST_ACTIONS_SOURCE } from "../../screencastActions.js";
import {
  createAltTextLocatorSelector,
  createLabelLocatorSelector,
  createPlaceholderLocatorSelector,
  createRoleLocatorSelector,
  createTestIdLocatorSelector,
  createTextLocatorSelector,
  createTitleLocatorSelector
} from "../../locatorSelectors.js";
import type {
  AddScriptTagOptions,
  AddStyleTagOptions,
  AriaSnapshotOptions,
  ClickOptions,
  BrowserConnectOptions,
  BrowserContextOptions,
  DispatchEventOptions,
  FillOptions,
  HoverOptions,
  MouseButton,
  PageCloseOptions,
  PageGotoOptions,
  PageSetContentOptions,
  PdfOptions,
  PressOptions,
  Rect,
  ScreenshotOptions,
  TapOptions,
  TypeOptions,
  ViewportSize
} from "../../types/options.js";
import type {
  PageDialog,
  RawPageEventListener,
  RawPageEventMap,
  RawPageEventName,
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
import { terminateProcessTree } from "../../processCleanup.js";
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

const CLEANUP_FIREFOX_PROCESS_TIMEOUT_MS = 5_000;
const HYDRATE_DECLARATIVE_SHADOW_ROOTS_SOURCE = `() => {
  const hydrate = (root) => {
    for (const template of Array.from(root.querySelectorAll('template[shadowrootmode]'))) {
      const mode = template.getAttribute('shadowrootmode');
      if (mode !== 'open' && mode !== 'closed')
        continue;
      const host = template.parentElement;
      if (!host)
        continue;
      const shadowRoot = host.shadowRoot || host.attachShadow({ mode });
      shadowRoot.append(...Array.from(template.content.childNodes));
      template.remove();
      if (mode === 'open')
        hydrate(shadowRoot);
    }
  };
  hydrate(document);
}`;

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

type BidiMouseAction =
  | {
      type: "pointerMove";
      x: number;
      y: number;
      origin: "viewport";
    }
  | {
      type: "pointerDown" | "pointerUp";
      button: number;
    }
  | {
      type: "pause";
      duration: number;
    };

interface StateWaiter {
  state: NonNullable<PageGotoOptions["waitUntil"]>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface NavigationResponseCapture {
  lastResponse: PageResponse | null;
}

interface BidiScreencastOverlayState {
  kind?: "chapter";
  html: string;
  removeTimer?: ReturnType<typeof setTimeout>;
}

interface ScreencastActionOptions {
  duration?: number;
  position?: "top-left" | "top" | "top-right" | "bottom-left" | "bottom" | "bottom-right";
  fontSize?: number;
  cursor?: "none" | "pointer";
}

interface ScreencastActionAnnotationState {
  title: string;
  point: ActionPoint;
  cursorPoint?: ActionPoint;
  highlightBox?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
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
  timeoutMs?: number;
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
  const hasVisibleStyle = (element: Element): boolean => {
    let current: Element | null = element;
    while (current) {
      const style = window.getComputedStyle(current);
      if (
        style.visibility === "hidden" ||
        style.display === "none" ||
        Number.parseFloat(style.opacity || "1") === 0
      ) {
        return false;
      }
      current = current.parentElement;
    }
    return true;
  };
  const chooseActionRect = (element: Element): DOMRect | null => {
    const viewport = {
      bottom: window.innerHeight,
      left: 0,
      right: window.innerWidth,
      top: 0
    };
    const intersect = (rect: DOMRect): DOMRect | null => {
      const left = Math.max(rect.left, viewport.left);
      const right = Math.min(rect.right, viewport.right);
      const top = Math.max(rect.top, viewport.top);
      const bottom = Math.min(rect.bottom, viewport.bottom);
      if (right - left <= 0 || bottom - top <= 0) {
        return null;
      }
      return new DOMRect(left, top, right - left, bottom - top);
    };
    for (const rect of Array.from(element.getClientRects())) {
      const visiblePart = intersect(rect);
      if (visiblePart && visiblePart.width * visiblePart.height > 0.99) {
        return visiblePart;
      }
    }
    const visibleBoundingBox = intersect(element.getBoundingClientRect());
    return visibleBoundingBox && visibleBoundingBox.width * visibleBoundingBox.height > 0.99 ? visibleBoundingBox : null;
  };
  const isDisabled = (element: Element): boolean => {
    if (
      element instanceof HTMLButtonElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLOptGroupElement ||
      element instanceof HTMLOptionElement ||
      element instanceof HTMLFieldSetElement
    ) {
      return element.disabled;
    }
    return element.getAttribute("aria-disabled") === "true";
  };
  const isEditable = (element: Element): boolean => {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      return !element.hasAttribute("readonly") && !isDisabled(element);
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      return !isDisabled(element);
    }
    const ariaReadonlyRoles = new Set([
      "checkbox",
      "combobox",
      "grid",
      "gridcell",
      "listbox",
      "radiogroup",
      "slider",
      "spinbutton",
      "textbox",
      "columnheader",
      "rowheader",
      "searchbox",
      "switch",
      "treegrid"
    ]);
    if (ariaReadonlyRoles.has(element.getAttribute("role") ?? "")) {
      return !isDisabled(element) && element.getAttribute("aria-readonly") !== "true";
    }
    throw new Error("Element is not an <input>, <textarea>, <select> or [contenteditable] and does not have a role allowing [aria-readonly]");
  };
  const fillActionabilityError = (element: HTMLElement): string | null => {
    if (!payload.force && !isVisible(element)) {
      return "Element is not visible.";
    }
    if (!payload.force && isDisabled(element)) {
      return "Element is not enabled.";
    }
    if (!payload.force && !isEditable(element)) {
      return "Element is not editable.";
    }
    return null;
  };
  const waitForFillActionability = (element: HTMLElement): void | Promise<void> => {
    const assertActionable = () => {
      const error = fillActionabilityError(element);
      if (error) {
        throw new Error(error);
      }
    };
    if (payload.force || !payload.timeoutMs || payload.timeoutMs <= 0) {
      assertActionable();
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + payload.timeoutMs!;
      const tick = () => {
        try {
          assertActionable();
          resolve();
        } catch (error) {
          if (Date.now() + 50 > deadline) {
            reject(error);
            return;
          }
          setTimeout(tick, 50);
        }
      };
      tick();
    });
  };
  const fillInputValue = (input: HTMLInputElement, value: string): string => {
    const type = input.type.toLowerCase();
    const inputTypesToSetValue = new Set(["color", "date", "time", "datetime-local", "month", "range", "week"]);
    const inputTypesToTypeInto = new Set(["", "email", "number", "password", "search", "tel", "text", "url"]);
    if (!inputTypesToTypeInto.has(type) && !inputTypesToSetValue.has(type)) {
      throw new Error(`Input of type "${type}" cannot be filled`);
    }
    if (type === "number") {
      value = value.trim();
      if (isNaN(Number(value))) {
        throw new Error("Cannot type text into input[type=number]");
      }
    }
    if (type === "color") {
      value = value.toLowerCase();
    }
    if (inputTypesToSetValue.has(type)) {
      value = value.trim();
      input.value = value;
      if (input.value !== value) {
        throw new Error("Malformed value");
      }
    }
    return value;
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
      {
        const fillElement = () => {
          firstElement.focus();

          if (firstElement instanceof HTMLInputElement) {
            firstElement.value = fillInputValue(firstElement, payload.value ?? "");
          } else if (firstElement instanceof HTMLTextAreaElement) {
            firstElement.value = payload.value ?? "";
          } else if (firstElement.isContentEditable) {
            firstElement.textContent = payload.value ?? "";
          } else {
            throw new Error("Element is not an <input>, <textarea> or [contenteditable] element");
          }

          firstElement.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          firstElement.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        };
        if (payload.timeoutMs !== undefined) {
          const waitResult = waitForFillActionability(firstElement);
          return waitResult instanceof Promise ? waitResult.then(fillElement) : fillElement();
        }
        const error = fillActionabilityError(firstElement);
        if (error) {
          throw new Error(error);
        }
        return fillElement();
      }
    case "actionPoint":
      if (!firstElement) {
        throw new Error("No element found for locator.");
      }

      firstElement.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "instant"
      });

      if (!payload.force && !hasVisibleStyle(firstElement)) {
        throw new Error("Element is not visible.");
      }

      const rect = chooseActionRect(firstElement);
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        throw new Error("Element is outside of the viewport.");
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
  private readonly pages = new Set<BidiPageAdapter>();

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

    let page!: BidiPageAdapter;
    page = await BidiPageAdapter.create(this.client, response.context, this.options, () => {
      this.pages.delete(page);
    });
    this.pages.add(page);
    return page;
  }

  async setExtraHTTPHeaders(headers: { [key: string]: string }): Promise<void> {
    this.options.extraHTTPHeaders = { ...headers };
    await Promise.all(
      Array.from(this.pages.values()).map(async (page) => {
        await page.updateContextExtraHTTPHeaders();
      })
    );
  }

  async close(): Promise<void> {
    this.pages.clear();
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
  private closeReason: string | undefined;
  private currentUrl = "about:blank";
  private domContentLoaded = false;
  private loadFired = false;
  private sameDocumentNavigation = false;
  private allowSameDocumentNavigationToResolveWaiters = false;
  private responseDataCollector: string | undefined;
  private navigationResponseCapture: NavigationResponseCapture | undefined;
  private readonly stateWaiters = new Set<StateWaiter>();
  private readonly eventListeners = new Map<RawPageEventName, Set<RawPageEventListener<RawPageEventName>>>();
  private readonly bidiListeners = new Map<string, (payload: unknown) => void>();
  private currentViewportSize: ViewportSize | null = null;
  private currentMousePosition: ActionPoint = { x: 0, y: 0 };
  private lastMouseButton: MouseButton | "none" = "none";
  private readonly pressedMouseButtons = new Set<MouseButton>();
  private readonly pressedKeyboardModifiers = new Set<string>();
  private pageExtraHTTPHeaders: Record<string, string> | undefined;
  private screencastActionOptions: ScreencastActionOptions | null = null;
  private screencastActionAnnotation: ScreencastActionAnnotationState | null = null;
  private screencastActionAbortController: AbortController | null = null;
  private screencastOverlaysVisible = true;
  private screencastOverlayId = 0;
  private readonly screencastOverlays = new Map<string, BidiScreencastOverlayState>();

  static async create(
    client: BidiProtocolClient,
    contextId: string,
    contextOptions: BrowserContextOptions,
    onClosed?: () => void
  ): Promise<BidiPageAdapter> {
    const page = new BidiPageAdapter(client, contextId, contextOptions, onClosed);
    await page.initialize();
    return page;
  }

  private constructor(
    private readonly client: BidiProtocolClient,
    private readonly contextId: string,
    private readonly contextOptions: BrowserContextOptions,
    private readonly onClosed?: () => void
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
        "browsingContext.userPromptOpened",
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
    const waitUntil = verifyLifecycle("waitUntil", options.waitUntil ?? "load");
    const targetUrl = completeUserURL(url);
    this.resolveNavigationReferer(options, targetUrl);
    const capture = this.beginNavigationResponseCapture();
    this.resetNavigationState();
    try {
      await this.client.browsingContextNavigate({
        context: this.contextId,
        url: targetUrl,
        wait: waitUntil === "domcontentloaded" ? "interactive" : "complete"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("blockedByPolicy")) {
        throw error;
      }

      await this.navigateViaLocation(targetUrl);
    }
    this.currentUrl = targetUrl;
    if (waitUntil !== "commit") {
      await this.waitForLoadState(waitUntil, options.timeout);
    }

    if (this.navigationResponseCapture === capture) {
      this.navigationResponseCapture = undefined;
    }
    return capture.lastResponse;
  }

  url(): string {
    return this.currentUrl;
  }

  async goBack(options: PageGotoOptions = {}): Promise<PageResponse | null> {
    return this.navigateHistory(-1, options);
  }

  async goForward(options: PageGotoOptions = {}): Promise<PageResponse | null> {
    return this.navigateHistory(1, options);
  }

  async reload(options: PageGotoOptions = {}): Promise<PageResponse | null> {
    const waitUntil = verifyLifecycle("waitUntil", options.waitUntil ?? "load");
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
        const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) : "";
        const documentElement = document.documentElement.cloneNode(true);
        if (documentElement instanceof Element) {
          documentElement.querySelectorAll([
            "#__roxy_screencast_actions_style__",
            "#__roxy_screencast_overlay_style__",
            "x-pw-action-overlays",
            "x-pw-user-overlays",
            "[data-roxy-highlight-overlay]"
          ].join(",")).forEach((node) => node.remove());
        }
        return doctype + documentElement.outerHTML;
      })()`
    );
  }

  async setContent(html: string, options: PageSetContentOptions = {}): Promise<void> {
    const waitUntil = verifyLifecycle("waitUntil", options.waitUntil ?? "load");
    this.resetNavigationState();

    await this.evaluateFunction<void>(
      `(payload) => {
        document.open();
        document.write(payload.html);
        document.close();
      }`,
      { html }
    );
    await this.evaluateFunction<void>(HYDRATE_DECLARATIVE_SHADOW_ROOTS_SOURCE);

    if (waitUntil !== "commit") {
      await this.waitForLoadState(waitUntil, options.timeout);
    }
  }

  async addInitScript(source: string, _arg?: unknown): Promise<Disposable> {
    const result = await this.client.scriptAddPreloadScript({
      functionDeclaration: `() => { ${source} }`,
      contexts: [this.contextId]
    });
    const script = (result as { script?: string }).script;
    return {
      dispose: async () => {
        if (!script) {
          return;
        }
        await this.client.scriptRemovePreloadScript({ script }).catch(() => {});
      }
    };
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

  async addScriptTag(options?: AddScriptTagOptions): Promise<ProtocolElementHandleAdapter> {
    await this.evaluateFunction<void>(
      `async (payload) => {
        const script = document.createElement('script');
        script.type = payload.type || 'text/javascript';
        if (payload.url) {
          script.src = payload.url;
          const promise = new Promise((resolve, reject) => {
            script.onload = resolve;
            script.onerror = event => reject(typeof event === 'string' ? new Error(event) : new Error('Failed to load script at ' + script.src));
          });
          document.head.appendChild(script);
          await promise;
          return;
        }
        script.text = payload.content || '';
        let error = null;
        script.onerror = event => error = event;
        document.head.appendChild(script);
        if (error)
          throw error;
      }`,
      options ?? {}
    );
    return new BidiElementHandleAdapter(this, {
      chain: [{ strategy: "css", value: "script:last-of-type" }],
      pick: { kind: "first" }
    });
  }

  async addStyleTag(options?: AddStyleTagOptions): Promise<ProtocolElementHandleAdapter> {
    await this.evaluateFunction<void>(
      `async (payload) => {
        const element = document.createElement(payload.url ? 'link' : 'style');
        if (payload.url) {
          element.rel = 'stylesheet';
          element.href = payload.url;
          const promise = new Promise((resolve, reject) => {
            element.onload = resolve;
            element.onerror = event => reject(typeof event === 'string' ? new Error(event) : new Error('Failed to load stylesheet at ' + element.href));
          });
          document.head.appendChild(element);
          await promise;
          return;
        } else {
          element.type = 'text/css';
          element.appendChild(document.createTextNode(payload.content || ''));
          const promise = new Promise((resolve, reject) => {
            element.onload = resolve;
            element.onerror = reject;
          });
          document.head.appendChild(element);
          await promise;
        }
      }`,
      options ?? {}
    );
    return new BidiElementHandleAdapter(this, {
      chain: [{ strategy: "css", value: "style:last-of-type,link[rel=stylesheet]:last-of-type" }],
      pick: { kind: "first" }
    });
  }

  async waitForLoadState(
    state: "load" | "domcontentloaded" | "networkidle" | "commit" = "load",
    timeout = 30_000
  ): Promise<void> {
    const targetState = verifyLifecycle("state", state ?? "load");
    if (targetState === "commit" || this.isStateSatisfied(targetState)) {
      return;
    }

    if (await this.isCurrentDocumentReadyFor(targetState)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = timeout === 0
        ? null
        : setTimeout(() => {
            this.stateWaiters.delete(waiter);
            reject(new TimeoutError(`page.waitForLoadState: Timeout ${timeout}ms exceeded.`));
          }, timeout);

      const waiter: StateWaiter = {
        state: targetState,
        resolve: () => {
          if (timer) {
            clearTimeout(timer);
          }
          this.stateWaiters.delete(waiter);
          resolve();
        },
        reject: (error) => {
          if (timer) {
            clearTimeout(timer);
          }
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

  async setExtraHTTPHeaders(headers: { [key: string]: string }): Promise<void> {
    this.pageExtraHTTPHeaders = { ...headers };
    await this.updateExtraHTTPHeaders();
  }

  private resolveNavigationReferer(options: PageGotoOptions, targetUrl: string): string | undefined {
    const headers = mergeExtraHTTPHeaders(
      this.contextOptions.extraHTTPHeaders,
      this.pageExtraHTTPHeaders
    );
    const headerEntry = Object.entries(headers)
      .find(([name]) => name.toLowerCase() === "referer");
    const headerReferer = headerEntry?.[1];
    if (options.referer !== undefined && headerReferer !== undefined && headerReferer !== options.referer) {
      throw new Error(`"referer" is already specified as extra HTTP header\n${targetUrl}`);
    }
    return options.referer ?? headerReferer;
  }

  async updateContextExtraHTTPHeaders(): Promise<void> {
    await this.updateExtraHTTPHeaders();
  }

  screenshotClipOrigin(): "viewport" {
    return "viewport";
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const response = await this.client.browsingContextCaptureScreenshot({
      context: this.contextId,
      ...(options.clip
        ? {
            origin: "viewport" as const,
            clip: {
              type: "box" as const,
              x: options.clip.x,
              y: options.clip.y,
              width: options.clip.width,
              height: options.clip.height
            }
          }
        : options.fullPage ? { origin: "document" as const } : {}),
      format: {
        type: options.type ?? "png",
        ...(options.quality !== undefined ? { quality: options.quality } : {})
      }
    });
    return Buffer.from(response.data, "base64");
  }

  async pdf(_options: PdfOptions = {}): Promise<Buffer> {
    throw new Error("PDF generation is only supported for Headless Chromium");
  }

  viewportSize(): ViewportSize | null {
    return this.currentViewportSize;
  }

  async setViewportSize(viewportSize: ViewportSize): Promise<void> {
    await this.client.browsingContextSetViewport({
      context: this.contextId,
      viewport: {
        width: viewportSize.width,
        height: viewportSize.height
      },
      devicePixelRatio: 1
    });
    this.currentViewportSize = viewportSize;
  }

  async dispatchEvent(
    selector: LocatorSelector[],
    type: string,
    eventInit?: unknown
  ): Promise<void> {
    await this.runSelectorOperation<void>({
      operation: "dispatchEvent",
      reference: {
        chain: selector,
        pick: { kind: "first" }
      },
      name: type,
      arg: eventInit
    });
  }

  async requestGC(): Promise<void> {
    await this.evaluateFunction<void>(
      `() => {
        if (typeof globalThis.gc === "function") {
          globalThis.gc();
        }
      }`
    );
  }

  async textContent(selector: LocatorSelector[]): Promise<string | null> {
    return this.textContentLocator({ chain: selector });
  }

  async innerText(selector: LocatorSelector[]): Promise<string> {
    return this.innerTextLocator({ chain: selector });
  }

  async innerHTML(selector: LocatorSelector[]): Promise<string> {
    return this.innerHTMLLocator({ chain: selector });
  }

  async getAttribute(selector: LocatorSelector[], name: string): Promise<string | null> {
    return this.getAttributeLocator({ chain: selector }, name);
  }

  async inputValue(selector: LocatorSelector[]): Promise<string> {
    return this.inputValueLocator({ chain: selector });
  }

  async isChecked(selector: LocatorSelector[]): Promise<boolean> {
    return this.isCheckedLocator({ chain: selector });
  }

  async isDisabled(selector: LocatorSelector[]): Promise<boolean> {
    return this.isDisabledLocator({ chain: selector });
  }

  async isEditable(selector: LocatorSelector[]): Promise<boolean> {
    return this.isEditableLocator({ chain: selector });
  }

  async isEnabled(selector: LocatorSelector[]): Promise<boolean> {
    return this.isEnabledLocator({ chain: selector });
  }

  async focus(selector: LocatorSelector[]): Promise<void> {
    await this.focusLocator({ chain: selector });
  }

  async setChecked(
    selector: LocatorSelector[],
    checked: boolean,
    options?: ClickOptions
  ): Promise<void> {
    if (checked) {
      await this.checkLocator({ chain: selector }, options);
      return;
    }
    await this.uncheckLocator({ chain: selector }, options);
  }

  async selectOption(
    selector: LocatorSelector[],
    values: NormalizedSelectOption[],
    options?: { timeout?: number }
  ): Promise<string[]> {
    return this.selectOptionLocator({ chain: selector }, values, options);
  }

  async startCSSCoverage(_options?: { resetOnNavigation?: boolean }): Promise<void> {
    throw new NotImplementedInProtocolError("bidi", "page.coverage.startCSSCoverage");
  }

  async startJSCoverage(
    _options?: {
      reportAnonymousScripts?: boolean;
      resetOnNavigation?: boolean;
    }
  ): Promise<void> {
    throw new NotImplementedInProtocolError("bidi", "page.coverage.startJSCoverage");
  }

  async stopCSSCoverage(): Promise<
    Array<{
      url: string;
      text?: string;
      ranges: Array<{
        start: number;
        end: number;
      }>;
    }>
  > {
    throw new NotImplementedInProtocolError("bidi", "page.coverage.stopCSSCoverage");
  }

  async stopJSCoverage(): Promise<
    Array<{
      url: string;
      scriptId: string;
      source?: string;
      functions: Array<{
        functionName: string;
        isBlockCoverage: boolean;
        ranges: Array<{
          count: number;
          startOffset: number;
          endOffset: number;
        }>;
      }>;
    }>
  > {
    throw new NotImplementedInProtocolError("bidi", "page.coverage.stopJSCoverage");
  }

  async screencastStart(): Promise<void> {
    // Playwright's BiDi backend currently exposes screencast.start/stop as no-op delegates.
  }

  async screencastStop(): Promise<void> {
    // Playwright's BiDi backend currently exposes screencast.start/stop as no-op delegates.
  }

  async screencastShowActions(options?: ScreencastActionOptions): Promise<void> {
    this.screencastActionOptions = { ...(options ?? {}) };
    await this.renderScreencastActions();
  }

  async screencastHideActions(): Promise<void> {
    this.resetScreencastActions();
    await this.renderScreencastActions();
  }

  async screencastShowOverlay(options: {
    html: string;
    duration?: number;
  }): Promise<{ id: string }> {
    const id = `overlay-${++this.screencastOverlayId}`;
    this.setScreencastOverlay(id, { html: options.html }, options.duration);
    await this.renderScreencastOverlays();
    return { id };
  }

  async screencastRemoveOverlay(id: string): Promise<void> {
    this.clearScreencastOverlay(id);
    await this.renderScreencastOverlays();
  }

  async screencastChapter(options: {
    title: string;
    description?: string;
    duration?: number;
  }): Promise<void> {
    const id = `chapter-${++this.screencastOverlayId}`;
    this.setScreencastOverlay(
      id,
      {
        kind: "chapter",
        html: createChapterOverlayHtml(options.title, options.description)
      },
      options.duration ?? 2000
    );
    await this.renderScreencastOverlays();
  }

  async screencastSetOverlayVisible(visible: boolean): Promise<void> {
    this.screencastOverlaysVisible = visible;
    await this.renderScreencastOverlays();
  }

  async keyboardDown(key: string): Promise<void> {
    const keyDefinition = keyDescriptionForString(key, this.pressedKeyboardModifiers);
    await this.client.inputPerformActions({
      context: this.contextId,
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [{ type: "keyDown", value: toBiDiKeyValue(resolveSmartModifierString(key)) }]
        }
      ]
    });
    if (isKeyboardModifier(keyDefinition.key)) {
      this.pressedKeyboardModifiers.add(keyDefinition.key);
    }
  }

  async keyboardInsertText(text: string): Promise<void> {
    await this.evaluateFunction<void>(
      `({ value }) => {
        const activeElement = document.activeElement;
        if (
          activeElement instanceof HTMLInputElement ||
          activeElement instanceof HTMLTextAreaElement
        ) {
          const start = activeElement.selectionStart ?? activeElement.value.length;
          const end = activeElement.selectionEnd ?? activeElement.value.length;
          activeElement.setRangeText(value, start, end, "end");
          activeElement.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            data: value,
            inputType: "insertText"
          }));
          return;
        }

        if (activeElement instanceof HTMLElement && activeElement.isContentEditable) {
          document.execCommand("insertText", false, value);
        }
      }`,
      { value: text }
    );
  }

  async keyboardPress(
    key: string,
    options?: {
      delay?: number;
    }
  ): Promise<void> {
    const tokens = splitKeyboardShortcut(key);
    const keyName = tokens[tokens.length - 1] ?? "";
    for (let index = 0; index < tokens.length - 1; index += 1) {
      await this.keyboardDown(tokens[index] ?? "");
    }

    await this.keyboardDown(keyName);
    if (options?.delay) {
      await new Promise((resolve) => setTimeout(resolve, options.delay));
    }
    await this.keyboardUp(keyName);

    for (let index = tokens.length - 2; index >= 0; index -= 1) {
      await this.keyboardUp(tokens[index] ?? "");
    }
  }

  async keyboardType(
    text: string,
    options?: {
      delay?: number;
    }
  ): Promise<void> {
    for (const character of text) {
      if (isUsKeyboardLayoutKey(character)) {
        await this.keyboardPress(
          character,
          options?.delay === undefined ? undefined : { delay: options.delay }
        );
        continue;
      }
      if (options?.delay) {
        await new Promise((resolve) => setTimeout(resolve, options.delay));
      }
      await this.keyboardInsertText(character);
    }
  }

  async keyboardUp(key: string): Promise<void> {
    const keyDefinition = keyDescriptionForString(key, this.pressedKeyboardModifiers);
    await this.client.inputPerformActions({
      context: this.contextId,
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [{ type: "keyUp", value: toBiDiKeyValue(resolveSmartModifierString(key)) }]
        }
      ]
    });
    if (isKeyboardModifier(keyDefinition.key)) {
      this.pressedKeyboardModifiers.delete(keyDefinition.key);
    }
  }

  async mouseClick(
    x: number,
    y: number,
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
      delay?: number;
    }
  ): Promise<void> {
    const point = { x, y };
    await this.performMouseClickActions(point, options);
    this.currentMousePosition = point;
  }

  async mouseDblclick(
    x: number,
    y: number,
    options?: {
      button?: "left" | "right" | "middle";
      delay?: number;
    }
  ): Promise<void> {
    await this.mouseClick(x, y, { ...options, clickCount: 2 });
  }

  async mouseDown(
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
    }
  ): Promise<void> {
    await this.performMousePointerActions([
      this.mousePointerDown(options?.button ?? "left")
    ]);
  }

  async mouseMove(
    x: number,
    y: number,
    options?: {
      steps?: number;
    }
  ): Promise<void> {
    const steps = Math.max(options?.steps ?? 1, 1);
    const start = this.currentMousePosition;
    const actions = [];
    for (let index = 1; index <= steps; index += 1) {
      actions.push(this.mousePointerMove({
        x: start.x + ((x - start.x) * index) / steps,
        y: start.y + ((y - start.y) * index) / steps
      }));
    }

    await this.performMousePointerActions(actions);
    this.currentMousePosition = { x, y };
  }

  async mouseUp(
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
    }
  ): Promise<void> {
    await this.performMousePointerActions([
      this.mousePointerUp(options?.button ?? "left")
    ]);
  }

  async mouseWheel(deltaX: number, deltaY: number): Promise<void> {
    await this.evaluateFunction<void>(
      `({ x, y, deltaX, deltaY, ctrlKey, shiftKey, altKey, metaKey }) => {
        const target =
          document.elementFromPoint(x, y) ??
          document.scrollingElement ??
          document.documentElement;
        const event = new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          deltaMode: 0,
          deltaX,
          deltaY,
          ctrlKey,
          shiftKey,
          altKey,
          metaKey
        });
        const shouldContinue = target.dispatchEvent(event);
        if (shouldContinue && !event.defaultPrevented) {
          globalThis.scrollBy(deltaX, deltaY);
        }
      }`,
      {
        x: Math.round(this.currentMousePosition.x),
        y: Math.round(this.currentMousePosition.y),
        deltaX,
        deltaY,
        ...keyboardModifierState(this.pressedKeyboardModifiers)
      }
    );
  }

  private async performMousePointerActions(actions: BidiMouseAction[]): Promise<void> {
    await this.client.inputPerformActions({
      context: this.contextId,
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions
        }
      ]
    });
  }

  private async performMouseClickActions(
    point: ActionPoint,
    options?: ClickOptions,
    movePointer = true
  ): Promise<void> {
    const button = options?.button ?? "left";
    const clickCount = options?.clickCount ?? 1;
    const delayMs = options?.delay ?? 0;
    if (delayMs > 0) {
      if (movePointer) {
        await this.performMousePointerActions([this.mousePointerMove(point)]);
      }
      for (let index = 1; index <= clickCount; index += 1) {
        await this.performMousePointerActions([this.mousePointerDown(button)]);
        await delay(delayMs);
        await this.performMousePointerActions([this.mousePointerUp(button)]);
        if (index < clickCount) {
          await delay(delayMs);
        }
      }
      return;
    }

    const promises: Array<Promise<void>> = [];
    if (movePointer) {
      promises.push(this.performMousePointerActions([this.mousePointerMove(point)]));
    }
    for (let index = 0; index < clickCount; index += 1) {
      promises.push(this.performMousePointerActions([this.mousePointerDown(button)]));
      promises.push(this.performMousePointerActions([this.mousePointerUp(button)]));
    }
    await Promise.all(promises);
  }

  private mousePointerMove(point: ActionPoint): BidiMouseAction {
    return {
      type: "pointerMove",
      x: Math.round(point.x),
      y: Math.round(point.y),
      origin: "viewport"
    };
  }

  private mousePointerDown(button: MouseButton): BidiMouseAction {
    this.lastMouseButton = button;
    this.pressedMouseButtons.add(button);
    return {
      type: "pointerDown",
      button: buttonNumber(button)
    };
  }

  private mousePointerUp(button: MouseButton): BidiMouseAction {
    this.lastMouseButton = "none";
    this.pressedMouseButtons.delete(button);
    return {
      type: "pointerUp",
      button: buttonNumber(button)
    };
  }

  async touchscreenTap(x: number, y: number): Promise<void> {
    await this.client.inputPerformActions({
      context: this.contextId,
      actions: [
        {
          type: "pointer",
          id: "touchscreen",
          parameters: { pointerType: "touch" },
          actions: [
            {
              type: "pointerMove",
              x: Math.round(x),
              y: Math.round(y),
              origin: "viewport"
            },
            {
              type: "pointerDown",
              button: 0
            },
            {
              type: "pointerUp",
              button: 0
            }
          ]
        }
      ]
    });
    this.currentMousePosition = { x, y };
  }

  async tap(selector: LocatorSelector[], options?: TapOptions): Promise<void> {
    await this.clickLocator({ chain: selector }, options);
  }

  on<K extends RawPageEventName>(event: K, listener: RawPageEventListener<K>): () => void {
    const listeners =
      this.eventListeners.get(event) ?? new Set<RawPageEventListener<RawPageEventName>>();
    listeners.add(listener as RawPageEventListener<RawPageEventName>);
    this.eventListeners.set(event, listeners);

    return () => {
      const registeredListeners = this.eventListeners.get(event);
      registeredListeners?.delete(listener as RawPageEventListener<RawPageEventName>);
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

  createHandle(reference: ProtocolElementHandleReference): ProtocolElementHandleAdapter {
    return new BidiElementHandleAdapter(this, reference);
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
    isFunction?: boolean,
    arg?: unknown
  ): Promise<TResult> {
    return this.evaluateOnReference<TResult>(
      {
        chain: selector,
        pick: { kind: "first" }
      },
      expression,
      arg,
      `page.$eval: Failed to find element matching selector "${formatSelectorChain(selector)}"`,
      isFunction
    );
  }

  async evalOnSelectorAll<TResult>(
    selector: LocatorSelector[],
    expression: string,
    isFunction?: boolean,
    arg?: unknown
  ): Promise<TResult> {
    return this.evaluateOnReferenceAll<TResult>(
      {
        chain: selector
      },
      expression,
      arg,
      isFunction
    );
  }

  locator(selector: LocatorSelector): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter(this, {
      chain: [selector]
    });
  }

  getByText(text: string | RegExp, options?: { exact?: boolean }): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter(this, {
      chain: [createTextLocatorSelector(text, options)]
    });
  }

  getByAltText(text: string | RegExp, options?: { exact?: boolean }): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter(this, {
      chain: [createAltTextLocatorSelector(text, options)]
    });
  }

  getByLabel(text: string | RegExp, options?: { exact?: boolean }): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter(this, {
      chain: [createLabelLocatorSelector(text, options)]
    });
  }

  getByPlaceholder(
    text: string | RegExp,
    options?: { exact?: boolean }
  ): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter(this, {
      chain: [createPlaceholderLocatorSelector(text, options)]
    });
  }

  getByTestId(testId: string | RegExp): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter(this, {
      chain: [createTestIdLocatorSelector(testId)]
    });
  }

  getByRole(role: string, options?: { exact?: boolean; name?: string | RegExp }): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter(this, {
      chain: [createRoleLocatorSelector(role, options)]
    });
  }

  getByTitle(text: string | RegExp, options?: { exact?: boolean }): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter(this, {
      chain: [createTitleLocatorSelector(text, options)]
    });
  }

  async close(options: PageCloseOptions = {}): Promise<void> {
    if (options.runBeforeUnload) {
      await this.client.browsingContextClose({
        context: this.contextId,
        promptUnload: true
      });
      return;
    }

    if (this.closed) {
      return;
    }

    this.closeReason = options.reason;
    this.closed = true;
    this.resetScreencastActions();
    for (const overlay of this.screencastOverlays.values()) {
      if (overlay.removeTimer) {
        clearTimeout(overlay.removeTimer);
      }
    }
    this.screencastOverlays.clear();
    this.rejectWaiters(this.createClosedError());

    await this.client.browsingContextClose({
      context: this.contextId,
      promptUnload: false
    });
    this.onClosed?.();
    this.emit("close", undefined);
    await this.cleanupBiDiListeners();
  }

  async bringToFront(): Promise<void> {
    await this.client.browsingContextActivate({
      context: this.contextId
    });
  }

  isClosed(): boolean {
    return this.closed;
  }

  async applyContextOptions(): Promise<void> {
    if (this.contextOptions.viewport) {
      await this.setViewportSize(this.contextOptions.viewport);
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

    if (this.contextOptions.extraHTTPHeaders) {
      await this.updateExtraHTTPHeaders();
    }
  }

  private async updateExtraHTTPHeaders(): Promise<void> {
    const headers = mergeExtraHTTPHeaders(
      this.contextOptions.extraHTTPHeaders,
      this.pageExtraHTTPHeaders
    );
    await this.client.networkSetExtraHeaders({
      contexts: [this.contextId],
      headers: toBiDiOutgoingHeaders(headers)
    });
  }

  private async evaluateExpression<TResult>(expression: string): Promise<TResult> {
    const response = await this.client.scriptEvaluate({
      expression: wrapWithSerializedEvaluationResult(expression),
      target: {
        context: this.contextId
      },
      awaitPromise: true,
      resultOwnership: "none"
    }) as BidiEvaluateResult;

    if (response.type === "exception") {
      throw new Error(response.exceptionDetails.text || "BiDi evaluation failed.");
    }

    return parseSerializedEvaluationResult<TResult>(extractBiDiValue(response.result));
  }

  private async evaluateFunction<TResult>(expression: string, arg?: unknown): Promise<TResult> {
    const serializedArg = arg === undefined ? "" : serializeForEvaluation(arg);
    const wrappedExpression =
      arg === undefined ? `(${expression})()` : `(${expression})(${serializedArg})`;
    return this.evaluateExpression<TResult>(wrappedExpression);
  }

  async clickLocator(
    locator: BidiLocatorState,
    options?: ClickOptions,
    retargetForAction?: "follow-label"
  ): Promise<void> {
    await this.bringToFront();
    const point = await this.resolveActionPoint(locator, options, true, retargetForAction);
    await this.performMousePointerActions([this.mousePointerMove(point)]);
    await this.resolveActionPoint(locator, options, true, retargetForAction);
    await this.performMouseClickActions(point, options, false);
    this.currentMousePosition = point;
    await this.showScreencastAction("click", point);
  }

  async hoverLocator(locator: BidiLocatorState, options?: HoverOptions): Promise<void> {
    const point = await this.resolveActionPoint(locator, options);
    await this.performMousePointerActions([
      this.mousePointerMove(point)
    ]);
    this.currentMousePosition = point;
  }

  async fillLocator(locator: BidiLocatorState, value: string, options?: FillOptions): Promise<void> {
    await this.runFillLocatorWithRetry(locator, value, options);
    try {
      const point = await this.resolveActionPoint(locator);
      await this.showScreencastAction("fill", point);
    } catch {}
  }

  private async runFillLocatorWithRetry(
    locator: BidiLocatorState,
    value: string,
    options?: FillOptions
  ): Promise<void> {
    const timeout = options?.timeout ?? 30_000;
    const deadline = Date.now() + timeout;
    while (true) {
      try {
        await this.runLocatorOperation<boolean>(locator, {
          operation: "fill",
          ...(options?.force !== undefined ? { force: options.force } : {}),
          value
        });
        return;
      } catch (error) {
        if (options?.force || !shouldRetryFillActionabilityError(error)) {
          throw error;
        }
        if (timeout === 0 || Date.now() + 50 > deadline) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async typeLocator(locator: BidiLocatorState, value: string, options?: TypeOptions): Promise<void> {
    await this.runLocatorOperation<boolean>(locator, {
      operation: "focus",
      resetSelectionIfNotFocused: true
    });

    await this.keyboardType(value, options);
  }

  async pressLocator(locator: BidiLocatorState, key: string, options?: PressOptions): Promise<void> {
    await this.runLocatorOperation<boolean>(locator, {
      operation: "focus",
      resetSelectionIfNotFocused: true
    });

    await this.keyboardPress(key, options);
  }

  async dblclickLocator(locator: BidiLocatorState, options?: ClickOptions): Promise<void> {
    await this.clickLocator(locator, { ...options, clickCount: 2 });
  }

  async checkLocator(locator: BidiLocatorState, options?: ClickOptions): Promise<void> {
    await this.setCheckedLocator(locator, true, options);
  }

  async uncheckLocator(locator: BidiLocatorState, options?: ClickOptions): Promise<void> {
    await this.setCheckedLocator(locator, false, options);
  }

  private async setCheckedLocator(locator: BidiLocatorState, checked: boolean, options?: ClickOptions): Promise<void> {
    await this.runLocatorOperation<boolean>(locator, {
      operation: "check",
      checked,
      ...(options?.force !== undefined ? { force: options.force } : {})
    });
    if (await this.checkedStateLocator(locator) === checked) {
      return;
    }
    if (options?.trial) {
      return;
    }
    await this.clickLocator(locator, options, "follow-label");
    if (await this.checkedStateLocator(locator) !== checked) {
      throw new Error("Clicking the checkbox did not change its state");
    }
  }

  private async checkedStateLocator(locator: BidiLocatorState): Promise<boolean> {
    return this.runLocatorOperation<boolean>(locator, {
      operation: "checkedState"
    });
  }

  async focusLocator(locator: BidiLocatorState): Promise<void> {
    await this.runLocatorOperation<boolean>(locator, {
      operation: "focus"
    });
  }

  async getAttributeLocator(locator: BidiLocatorState, name: string): Promise<string | null> {
    return this.runLocatorOperation<string | null>(locator, {
      operation: "getAttribute",
      name
    });
  }

  async innerHTMLLocator(locator: BidiLocatorState): Promise<string> {
    return this.runLocatorOperation<string>(locator, {
      operation: "innerHTML"
    });
  }

  async innerTextLocator(locator: BidiLocatorState): Promise<string> {
    return this.runLocatorOperation<string>(locator, {
      operation: "innerText"
    });
  }

  async inputValueLocator(locator: BidiLocatorState): Promise<string> {
    return this.runLocatorOperation<string>(locator, {
      operation: "inputValue"
    });
  }

  async isCheckedLocator(locator: BidiLocatorState): Promise<boolean> {
    return this.runLocatorOperation<boolean>(locator, {
      operation: "isChecked"
    });
  }

  async isDisabledLocator(locator: BidiLocatorState): Promise<boolean> {
    return this.runLocatorOperation<boolean>(locator, {
      operation: "isDisabled"
    });
  }

  async isEditableLocator(locator: BidiLocatorState): Promise<boolean> {
    return this.runLocatorOperation<boolean>(locator, {
      operation: "isEditable"
    });
  }

  async isEnabledLocator(locator: BidiLocatorState): Promise<boolean> {
    return this.runLocatorOperation<boolean>(locator, {
      operation: "isEnabled"
    });
  }

  async selectOptionLocator(
    locator: BidiLocatorState,
    values: NormalizedSelectOption[],
    options?: { timeout?: number }
  ): Promise<string[]> {
    return this.runSelectOptionWithRetry(() => this.runLocatorOperation<string[] | SelectOptionRetryResult>(locator, {
      operation: "selectOption",
      values
    }), options?.timeout);
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

  async getAttributeReference(
    reference: ProtocolElementHandleReference,
    name: string
  ): Promise<string | null> {
    return this.runSelectorOperation<string | null>({
      operation: "getAttribute",
      reference,
      name
    });
  }

  async innerHTMLReference(reference: ProtocolElementHandleReference): Promise<string> {
    return this.runSelectorOperation<string>({
      operation: "innerHTML",
      reference
    });
  }

  async innerTextReference(reference: ProtocolElementHandleReference): Promise<string> {
    return this.runSelectorOperation<string>({
      operation: "innerText",
      reference
    });
  }

  async inputValueReference(reference: ProtocolElementHandleReference): Promise<string> {
    return this.runSelectorOperation<string>({
      operation: "inputValue",
      reference
    });
  }

  async isCheckedReference(reference: ProtocolElementHandleReference): Promise<boolean> {
    return this.runSelectorOperation<boolean>({
      operation: "isChecked",
      reference
    });
  }

  async isDisabledReference(reference: ProtocolElementHandleReference): Promise<boolean> {
    return this.runSelectorOperation<boolean>({
      operation: "isDisabled",
      reference
    });
  }

  async isEditableReference(reference: ProtocolElementHandleReference): Promise<boolean> {
    return this.runSelectorOperation<boolean>({
      operation: "isEditable",
      reference
    });
  }

  async isEnabledReference(reference: ProtocolElementHandleReference): Promise<boolean> {
    return this.runSelectorOperation<boolean>({
      operation: "isEnabled",
      reference
    });
  }

  async focusReference(reference: ProtocolElementHandleReference): Promise<void> {
    await this.runSelectorOperation<boolean>({
      operation: "focus",
      reference
    });
  }

  async checkReference(reference: ProtocolElementHandleReference, checked: boolean): Promise<void> {
    await this.setCheckedReference(reference, checked);
  }

  async setCheckedReference(
    reference: ProtocolElementHandleReference,
    checked: boolean,
    options?: ClickOptions
  ): Promise<void> {
    await this.runSelectorOperation<boolean>({
      operation: "check",
      reference,
      checked
    });
    if (await this.checkedStateReference(reference) === checked) {
      return;
    }
    if (options?.trial) {
      return;
    }
    await this.clickReference(reference, options);
    if (await this.checkedStateReference(reference) !== checked) {
      throw new Error("Clicking the checkbox did not change its state");
    }
  }

  private async checkedStateReference(reference: ProtocolElementHandleReference): Promise<boolean> {
    return this.runSelectorOperation<boolean>({
      operation: "checkedState",
      reference
    });
  }

  async selectOptionReference(
    reference: ProtocolElementHandleReference,
    values: NormalizedSelectOption[],
    options?: { timeout?: number }
  ): Promise<string[]> {
    return this.runSelectOptionWithRetry(() => this.runSelectorOperation<string[] | SelectOptionRetryResult>({
      operation: "selectOption",
      reference,
      values
    }), options?.timeout);
  }

  private async resolveActionPoint(
    locator: BidiLocatorState,
    options?: HoverOptions,
    waitForEnabled?: boolean,
    retargetForAction?: "follow-label"
  ): Promise<ActionPoint> {
    return this.runSelectorOperation<ActionPoint>({
      operation: "actionPoint",
      reference: {
        chain: locator.chain,
        ...(locator.pick ? { pick: locator.pick } : {})
      },
      ...(options?.force !== undefined ? { force: options.force } : {}),
      ...(options?.position ? { position: options.position } : {}),
      ...(waitForEnabled ? { waitForEnabled } : {}),
      ...(retargetForAction ? { retargetForAction } : {})
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

  private async runSelectOptionWithRetry(
    action: () => Promise<string[] | SelectOptionRetryResult>,
    timeout: number | undefined
  ): Promise<string[]> {
    const effectiveTimeout = timeout ?? 30_000;
    const deadline = Date.now() + effectiveTimeout;
    while (true) {
      const result = await action();
      if (!isSelectOptionRetryResult(result)) {
        return result;
      }
      if (effectiveTimeout === 0 || Date.now() + 50 > deadline) {
        throw new TimeoutError(`page.selectOption: Timeout ${effectiveTimeout}ms exceeded.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async countSelector(reference: ProtocolElementHandleReference): Promise<number> {
    return this.runSelectorOperation<number>({
      operation: "count",
      reference
    });
  }

  async boundingBoxReference(reference: ProtocolElementHandleReference): Promise<Rect | null> {
    return this.runSelectorOperation<Rect | null>({
      operation: "boundingBox",
      reference
    });
  }

  async evaluateOnReference<TResult>(
    reference: ProtocolElementHandleReference,
    expression: string,
    arg?: unknown,
    missingMessage?: string,
    isFunction?: boolean
  ): Promise<TResult> {
    return this.runSelectorOperation<TResult>({
      operation: "evaluate",
      reference,
      expression,
      arg,
      ...(isFunction !== undefined ? { isFunction } : {}),
      ...(missingMessage ? { missingMessage } : {})
    });
  }

  async createHandleReference(
    reference: ProtocolElementHandleReference,
    missingMessage?: string
  ): Promise<ProtocolElementHandleReference> {
    const result = await this.runSelectorOperation<{ handleId: string }>({
      operation: "createHandle",
      reference,
      ...(missingMessage ? { missingMessage } : {})
    });
    return {
      chain: [],
      handleId: result.handleId
    };
  }

  async evaluateOnReferenceAll<TResult>(
    reference: ProtocolElementHandleReference,
    expression: string,
    arg?: unknown,
    isFunction?: boolean
  ): Promise<TResult> {
    return this.runSelectorOperation<TResult>({
      operation: "evaluateAll",
      reference,
      expression,
      arg,
      ...(isFunction !== undefined ? { isFunction } : {})
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
    await this.bringToFront();
    const point = await this.runSelectorOperation<ActionPoint>({
      operation: "actionPoint",
      reference,
      ...(options?.force !== undefined ? { force: options.force } : {}),
      ...(options?.position ? { position: options.position } : {}),
      waitForEnabled: true
    });
    await this.performMousePointerActions([this.mousePointerMove(point)]);
    await this.runSelectorOperation<ActionPoint>({
      operation: "actionPoint",
      reference,
      ...(options?.force !== undefined ? { force: options.force } : {}),
      ...(options?.position ? { position: options.position } : {}),
      waitForEnabled: true
    });
    await this.performMouseClickActions(point, options, false);
    this.currentMousePosition = point;
    await this.showScreencastAction("click", point);
  }

  async hoverReference(reference: ProtocolElementHandleReference, options?: HoverOptions): Promise<void> {
    const point = await this.runSelectorOperation<ActionPoint>({
      operation: "actionPoint",
      reference,
      ...(options?.force !== undefined ? { force: options.force } : {}),
      ...(options?.position ? { position: options.position } : {})
    });
    await this.performMousePointerActions([
      this.mousePointerMove(point)
    ]);
    this.currentMousePosition = point;
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
      ...(options?.force !== undefined ? { force: options.force } : {}),
      timeoutMs: options?.timeout ?? 30_000
    });
    try {
      const point = await this.runSelectorOperation<ActionPoint>({
        operation: "actionPoint",
        reference
      });
      await this.showScreencastAction("fill", point);
    } catch {}
  }

  async typeReference(
    reference: ProtocolElementHandleReference,
    value: string,
    options?: TypeOptions
  ): Promise<void> {
    await this.runSelectorOperation<boolean>({
      operation: "focus",
      reference,
      resetSelectionIfNotFocused: true
    });

    await this.keyboardType(value, options);
  }

  async pressReference(
    reference: ProtocolElementHandleReference,
    key: string,
    options?: PressOptions
  ): Promise<void> {
    await this.runSelectorOperation<boolean>({
      operation: "focus",
      reference,
      resetSelectionIfNotFocused: true
    });

    await this.keyboardPress(key, options);
  }

  private async runSelectorOperation<TResult>(payload: SelectorRuntimePayload): Promise<TResult> {
    return this.evaluateFunction<TResult>(SELECTOR_RUNTIME_SOURCE, payload);
  }

  private setScreencastOverlay(
    id: string,
    overlay: Omit<BidiScreencastOverlayState, "removeTimer">,
    duration?: number
  ): void {
    this.clearScreencastOverlay(id);
    const state: BidiScreencastOverlayState = { ...overlay };
    if (duration !== undefined) {
      state.removeTimer = setTimeout(() => {
        this.clearScreencastOverlay(id);
        void this.renderScreencastOverlays();
      }, duration);
    }
    this.screencastOverlays.set(id, state);
  }

  private clearScreencastOverlay(id: string): void {
    const existing = this.screencastOverlays.get(id);
    if (existing?.removeTimer) {
      clearTimeout(existing.removeTimer);
    }
    this.screencastOverlays.delete(id);
  }

  private async renderScreencastOverlays(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.evaluateFunction<void>(RENDER_SCREencast_OVERLAYS_SOURCE, {
      visible: this.screencastOverlaysVisible,
      overlays: Array.from(this.screencastOverlays.entries()).map(([id, overlay]) => ({
        id,
        html: overlay.html,
        ...(overlay.kind ? { kind: overlay.kind } : {})
      }))
    }).catch(() => {});
  }

  private resetScreencastActions(): void {
    this.screencastActionAbortController?.abort();
    this.screencastActionAbortController = null;
    this.screencastActionAnnotation = null;
    this.screencastActionOptions = null;
  }

  private async showScreencastAction(title: string, point: ActionPoint): Promise<void> {
    if (!this.screencastActionOptions || this.closed) {
      return;
    }

    const abortController = new AbortController();
    this.screencastActionAbortController?.abort();
    this.screencastActionAbortController = abortController;
    this.screencastActionAnnotation = {
      title,
      point,
      ...(this.screencastActionOptions.cursor !== "none" ? { cursorPoint: point } : {}),
      highlightBox: createScreencastHighlightBox(point)
    };

    await this.renderScreencastActions();
    const completed = await waitForAbortableTimeout(
      this.screencastActionOptions.duration ?? 500,
      abortController.signal
    );
    if (!completed || this.screencastActionAbortController !== abortController) {
      return;
    }

    this.screencastActionAbortController = null;
    this.screencastActionAnnotation = null;
    await this.renderScreencastActions();
  }

  private async renderScreencastActions(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.evaluateFunction<void>(RENDER_SCREENCAST_ACTIONS_SOURCE, {
      enabled: Boolean(this.screencastActionOptions),
      annotation:
        this.screencastActionOptions && this.screencastActionAnnotation
          ? {
              title: this.screencastActionAnnotation.title,
              point: this.screencastActionAnnotation.point,
              ...(this.screencastActionAnnotation.cursorPoint
                ? { cursorPoint: this.screencastActionAnnotation.cursorPoint }
                : {}),
              ...(this.screencastActionAnnotation.highlightBox
                ? { highlightBox: this.screencastActionAnnotation.highlightBox }
                : {}),
              ...(this.screencastActionOptions.position
                ? { position: this.screencastActionOptions.position }
                : {}),
              ...(this.screencastActionOptions.fontSize !== undefined
                ? { fontSize: this.screencastActionOptions.fontSize }
                : {}),
              ...(this.screencastActionOptions.cursor
                ? { cursor: this.screencastActionOptions.cursor }
                : {})
            }
          : null
    }).catch(() => {});
  }

  private attachBiDiListeners(): void {
    this.attachBiDiListener("browsingContext.domContentLoaded", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }
      this.currentUrl = extractBiDiContextUrl(payload) ?? this.currentUrl;

      this.domContentLoaded = true;
      this.flushWaiters();
      this.emit("domcontentloaded", undefined);
      void this.renderScreencastActions();
      void this.renderScreencastOverlays();
    });

    this.attachBiDiListener("browsingContext.fragmentNavigated", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }
      this.currentUrl = extractBiDiContextUrl(payload) ?? this.currentUrl;

      this.sameDocumentNavigation = true;
      this.domContentLoaded = true;
      this.loadFired = true;
      void this.renderScreencastActions();
      void this.renderScreencastOverlays();
      if (this.allowSameDocumentNavigationToResolveWaiters) {
        this.flushWaiters();
      }
    });

    this.attachBiDiListener("browsingContext.historyUpdated", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }
      this.currentUrl = extractBiDiContextUrl(payload) ?? this.currentUrl;

      this.sameDocumentNavigation = true;
      this.domContentLoaded = true;
      this.loadFired = true;
      void this.renderScreencastActions();
      void this.renderScreencastOverlays();
      if (this.allowSameDocumentNavigationToResolveWaiters) {
        this.flushWaiters();
      }
    });

    this.attachBiDiListener("browsingContext.load", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }
      this.currentUrl = extractBiDiContextUrl(payload) ?? this.currentUrl;

      this.loadFired = true;
      this.flushWaiters();
      this.emit("load", undefined);
      void this.renderScreencastActions();
      void this.renderScreencastOverlays();
    });

    this.attachBiDiListener("browsingContext.userPromptOpened", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }
      const prompt = payload as {
        defaultValue?: string;
        message?: string;
        type?: "alert" | "beforeunload" | "confirm" | "prompt";
      };
      this.emit(
        "dialog",
        this.createDialogPayload({
          defaultValue: prompt.defaultValue ?? "",
          message: prompt.message ?? "",
          type: prompt.type ?? "alert"
        })
      );
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
        args: () => [],
        location: () => ({
          column: 0,
          columnNumber: 0,
          line: 0,
          lineNumber: 0,
          url: ""
        }),
        page: () => null,
        text: () => logPayload.text ?? "",
        timestamp: () => Date.now(),
        type: () => normalizeConsoleMessageType(logPayload.method ?? logPayload.type ?? "log"),
        worker: () => null
      });
    });

    this.attachBiDiListener("network.beforeRequestSent", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }

      const requestPayload = payload as {
        context: string | null;
        navigation?: string | null;
        request: {
          destination?: string;
          headers: Array<{ name: string; value: { value: string } | string }>;
          method: string;
          request?: string;
          url: string;
        };
      };
      this.emit("request", {
        ...(requestPayload.context ? { frameId: requestPayload.context } : {}),
        headers: mapBiDiHeaders(requestPayload.request.headers),
        ...(requestPayload.request.destination
          ? { isNavigationRequest: requestPayload.request.destination === "document" && requestPayload.navigation !== null }
          : {}),
        method: requestPayload.request.method,
        ...(requestPayload.request.request ? { requestId: requestPayload.request.request } : {}),
        ...(requestPayload.request.destination
          ? { resourceType: requestPayload.request.destination.toLowerCase() }
          : {}),
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
        ...(responsePayload.context ? { frameId: responsePayload.context } : {}),
        headers: mapBiDiHeaders(responsePayload.response.headers),
        isNavigationRequest:
          responsePayload.request.destination === "document" &&
          responsePayload.navigation !== null,
        mimeType: responsePayload.response.mimeType,
        requestId: responsePayload.request.request,
        resourceType: responsePayload.request.destination.toLowerCase(),
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
      const completedPayload = payload as {
        context: string | null;
        navigation: string | null;
        request: { destination: string; method?: string; request: string; url: string };
      };
      this.emit("requestfinished", {
        ...(completedPayload.context ? { frameId: completedPayload.context } : {}),
        headers: [],
        isNavigationRequest:
          completedPayload.request.destination === "document" &&
          completedPayload.navigation !== null,
        method: completedPayload.request.method ?? "GET",
        requestId: completedPayload.request.request,
        resourceType: completedPayload.request.destination.toLowerCase(),
        url: completedPayload.request.url
      });
    });

    this.attachBiDiListener("network.fetchError", (payload) => {
      if (!hasContext(payload, this.contextId)) {
        return;
      }

      const failedPayload = payload as {
        errorText: string;
        request: {
          destination?: string;
          method: string;
          request?: string;
          url: string;
        };
      };
      this.emit("requestfailed", {
        errorText: failedPayload.errorText,
        ...(failedPayload.request.destination
          ? { isNavigationRequest: failedPayload.request.destination === "document" }
          : {}),
        method: failedPayload.request.method,
        ...(failedPayload.request.request ? { requestId: failedPayload.request.request } : {}),
        ...(failedPayload.request.destination
          ? { resourceType: failedPayload.request.destination.toLowerCase() }
          : {}),
        url: failedPayload.request.url
      });
    });

    this.attachBiDiListener("browsingContext.contextDestroyed", (payload) => {
      if (!hasContext(payload, this.contextId) || this.closed) {
        return;
      }

      this.closed = true;
      this.rejectWaiters(this.createClosedError());
      this.onClosed?.();
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

  private emit<K extends RawPageEventName>(event: K, payload: RawPageEventMap[K]): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners) {
      return;
    }

    for (const listener of Array.from(listeners)) {
      if (payload === undefined) {
        (listener as () => void)();
        continue;
      }

      (listener as (eventPayload: RawPageEventMap[K]) => void)(payload);
    }
  }

  private createClosedError(): Error {
    return new Error(this.closeReason ?? "Target page, context or browser has been closed");
  }

  private createDialogPayload(input: {
    defaultValue: string;
    message: string;
    type: "alert" | "beforeunload" | "confirm" | "prompt";
  }): PageDialog {
    let handled = false;
    const respond = async (accept: boolean, promptText?: string): Promise<void> => {
      if (handled) {
        return;
      }
      handled = true;
      await this.client.browsingContextHandleUserPrompt({
        context: this.contextId,
        accept,
        ...(promptText !== undefined ? { userText: promptText } : {})
      });
    };

    const dialog = {
      accept: (promptText?: string) => respond(true, promptText),
      defaultValue: () => input.defaultValue,
      dismiss: () => respond(false),
      message: () => input.message,
      type: () => input.type
    };
    if ((this.eventListeners.get("dialog")?.size ?? 0) === 0) {
      void dialog.dismiss().catch(() => {});
    }
    return dialog;
  }

  private async navigateHistory(
    delta: -1 | 1,
    options: PageGotoOptions
  ): Promise<PageResponse | null> {
    const previousUrl = this.url();
    const capture = this.beginNavigationResponseCapture();
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

    const waitUntil = verifyLifecycle("waitUntil", options.waitUntil ?? "load");
    if (waitUntil !== "commit") {
      await this.waitForLoadState(waitUntil, options.timeout);
    }

    const currentUrl = this.url();
    if (this.navigationResponseCapture === capture) {
      this.navigationResponseCapture = undefined;
    }
    if (currentUrl === previousUrl) {
      return null;
    }
    if (capture.lastResponse) {
      return capture.lastResponse;
    }
    if (this.sameDocumentNavigation) {
      return null;
    }
    return createPageResponse({
      fromCache: false,
      headers: [],
      mimeType: "text/html",
      status: 200,
      statusText: "OK",
      text: async () => "",
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

  getByText(text: string | RegExp, options?: { exact?: boolean }): ProtocolLocatorAdapter {
    return this.locator(createTextLocatorSelector(text, options));
  }

  getByAltText(text: string | RegExp, options?: { exact?: boolean }): ProtocolLocatorAdapter {
    return this.locator(createAltTextLocatorSelector(text, options));
  }

  getByLabel(text: string | RegExp, options?: { exact?: boolean }): ProtocolLocatorAdapter {
    return this.locator(createLabelLocatorSelector(text, options));
  }

  getByPlaceholder(
    text: string | RegExp,
    options?: { exact?: boolean }
  ): ProtocolLocatorAdapter {
    return this.locator(createPlaceholderLocatorSelector(text, options));
  }

  getByTestId(testId: string | RegExp): ProtocolLocatorAdapter {
    return this.locator(createTestIdLocatorSelector(testId));
  }

  getByRole(role: string, options?: { exact?: boolean; name?: string | RegExp }): ProtocolLocatorAdapter {
    return this.locator(createRoleLocatorSelector(role, options));
  }

  getByTitle(text: string | RegExp, options?: { exact?: boolean }): ProtocolLocatorAdapter {
    return this.locator(createTitleLocatorSelector(text, options));
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

  async dblclick(options?: ClickOptions): Promise<void> {
    await this.page.dblclickLocator(this.state, options);
  }

  async check(options?: ClickOptions): Promise<void> {
    await this.page.checkLocator(this.state, options);
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

  async focus(): Promise<void> {
    await this.page.focusLocator(this.state);
  }

  async blur(): Promise<void> {
    await this.evaluate("(element) => element.blur()", undefined, true);
  }

  async count(): Promise<number> {
    return this.page.countSelector({
      chain: this.state.chain,
      ...(this.state.pick ? { pick: this.state.pick } : {})
    });
  }

  async dispatchEvent(
    type: string,
    eventInit?: unknown,
    options?: DispatchEventOptions
  ): Promise<void> {
    void options;
    await this.page.dispatchEvent(this.state.chain, type, eventInit);
  }

  async evaluate<TResult>(
    expression: string,
    arg?: unknown,
    isFunction?: boolean
  ): Promise<TResult> {
    return this.page.evaluateOnReference(
      {
        chain: this.state.chain,
        ...(this.state.pick ? { pick: this.state.pick } : {})
      },
      expression,
      arg,
      `Could not resolve ${formatSelectorChain(this.state.chain)} to DOM Element`,
      isFunction
    );
  }

  async evaluateAll<TResult>(
    expression: string,
    arg?: unknown,
    isFunction?: boolean
  ): Promise<TResult> {
    return this.page.evaluateOnReferenceAll(
      {
        chain: this.state.chain,
        ...(this.state.pick ? { pick: this.state.pick } : {})
      },
      expression,
      arg,
      isFunction
    );
  }

  async boundingBox(): Promise<Rect | null> {
    return this.page.boundingBoxReference({
      chain: this.state.chain,
      ...(this.state.pick ? { pick: this.state.pick } : {})
    });
  }

  async getAttribute(name: string): Promise<string | null> {
    return this.page.getAttributeLocator(this.state, name);
  }

  async innerHTML(): Promise<string> {
    return this.page.innerHTMLLocator(this.state);
  }

  async innerText(): Promise<string> {
    return this.page.innerTextLocator(this.state);
  }

  async inputValue(): Promise<string> {
    return this.page.inputValueLocator(this.state);
  }

  async isChecked(): Promise<boolean> {
    return this.page.isCheckedLocator(this.state);
  }

  async isDisabled(): Promise<boolean> {
    return this.page.isDisabledLocator(this.state);
  }

  async isEditable(): Promise<boolean> {
    return this.page.isEditableLocator(this.state);
  }

  async isEnabled(): Promise<boolean> {
    return this.page.isEnabledLocator(this.state);
  }

  async isHidden(): Promise<boolean> {
    return !(await this.page.isVisibleLocator(this.state));
  }

  async textContent(): Promise<string | null> {
    return this.page.textContentLocator(this.state);
  }

  async uncheck(options?: ClickOptions): Promise<void> {
    await this.page.uncheckLocator(this.state, options);
  }

  async selectOption(
    values: NormalizedSelectOption[],
    options?: { timeout?: number }
  ): Promise<string[]> {
    return this.page.selectOptionLocator(this.state, values, options);
  }

  async isVisible(): Promise<boolean> {
    return this.page.isVisibleLocator(this.state);
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    void await this.elementHandle();
    return this.page.screenshot(options);
  }

  async scrollIntoViewIfNeeded(): Promise<void> {
    await this.evaluate(SCROLL_INTO_VIEW_IF_NEEDED_SOURCE, undefined, true);
  }

  async selectText(): Promise<void> {
    await this.evaluate(`(element) => {
      const retarget = (node) => {
        let target = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (!target)
          throw new Error("Element is not attached to the DOM");
        if (!target.matches("input, textarea, select") && !target.isContentEditable)
          target = target.closest("button, [role=button], [role=checkbox], [role=radio]") || target;
        if (!target.matches("a, input, textarea, button, select, [role=link], [role=button], [role=checkbox], [role=radio]") && !target.isContentEditable) {
          const enclosingLabel = target.closest("label");
          if (enclosingLabel?.control)
            target = enclosingLabel.control;
        }
        return target;
      };
      const target = retarget(element);
      if (target instanceof HTMLInputElement) {
        target.select();
        target.focus();
        return;
      }
      if (target instanceof HTMLTextAreaElement) {
        target.selectionStart = 0;
        target.selectionEnd = target.value.length;
        target.focus();
        return;
      }
      if (typeof target.focus === "function")
        target.focus();
      const range = target.ownerDocument.createRange();
      range.selectNodeContents(target);
      const selection = target.ownerDocument.defaultView?.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }`, undefined, true);
  }

  async tap(options?: TapOptions): Promise<void> {
    await this.page.tap(this.state.chain, options);
  }

  async elementHandle(): Promise<ProtocolElementHandleAdapter> {
    const reference: ProtocolElementHandleReference = {
      chain: this.state.chain,
      ...(this.state.pick ? { pick: this.state.pick } : {})
    };
    const handleReference = await this.page.createHandleReference(
      reference,
      `Could not resolve ${formatSelectorChain(this.state.chain)} to DOM Element`
    );
    return this.page.createHandle(handleReference);
  }

  async elementHandles(): Promise<ProtocolElementHandleAdapter[]> {
    const count = await this.page.countSelector({
      chain: this.state.chain,
      ...(this.state.pick ? { pick: this.state.pick } : {})
    });
    const handles: ProtocolElementHandleAdapter[] = [];
    for (let index = 0; index < count; index += 1) {
      const reference: ProtocolElementHandleReference = {
        chain: this.state.chain,
        pick: { kind: "nth", index }
      };
      handles.push(this.page.createHandle(await this.page.createHandleReference(reference)));
    }
    return handles;
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
      ...(this.referenceState.handleId ? { handleId: this.referenceState.handleId } : {}),
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
    isFunction?: boolean,
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
      `elementHandle.$eval: Failed to find element matching selector "${formatSelectorChain(selector)}"`,
      isFunction
    );
  }

  async evalOnSelectorAll<TResult>(
    selector: LocatorSelector[],
    expression: string,
    isFunction?: boolean,
    arg?: unknown
  ): Promise<TResult> {
    return this.page.evaluateOnReferenceAll(
      {
        scope: this.reference(),
        chain: selector
      },
      expression,
      arg,
      isFunction
    );
  }

  async evaluate<TResult>(expression: string, arg?: unknown): Promise<TResult> {
    return this.page.evaluateOnReference(this.reference(), expression, arg, "No element found.");
  }

  async boundingBox(): Promise<Rect | null> {
    return this.page.boundingBoxReference(this.reference());
  }

  async dispatchEvent(type: string, eventInit?: unknown): Promise<void> {
    await this.evaluate(
      `(element, payload) => {
        const createDOMEvent = (type, eventInit) => {
          const baseInit = {
            bubbles: true,
            cancelable: true,
            composed: true,
            ...(eventInit && typeof eventInit === "object" ? eventInit : {})
          };
          if (type.startsWith("mouse") || type === "click" || type === "dblclick" || type === "contextmenu")
            return new MouseEvent(type, baseInit);
          if (type === "wheel")
            return new WheelEvent(type, baseInit);
          if (type.startsWith("drag") || type === "drop")
            return new DragEvent(type, baseInit);
          if (type.startsWith("key"))
            return new KeyboardEvent(type, baseInit);
          if (type === "input")
            return new InputEvent(type, baseInit);
          return new Event(type, baseInit);
        };
        const event = createDOMEvent(payload.type, payload.eventInit);
        element.dispatchEvent(event);
      }`,
      { type, eventInit }
    );
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    void await this.boundingBox();
    return this.page.screenshot(options);
  }

  async scrollIntoViewIfNeeded(): Promise<void> {
    await this.evaluate(SCROLL_INTO_VIEW_IF_NEEDED_SOURCE, undefined);
  }

  async selectText(): Promise<void> {
    await this.evaluate(`(element) => {
      const retarget = (node) => {
        let target = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (!target)
          throw new Error("Element is not attached to the DOM");
        if (!target.matches("input, textarea, select") && !target.isContentEditable)
          target = target.closest("button, [role=button], [role=checkbox], [role=radio]") || target;
        if (!target.matches("a, input, textarea, button, select, [role=link], [role=button], [role=checkbox], [role=radio]") && !target.isContentEditable) {
          const enclosingLabel = target.closest("label");
          if (enclosingLabel?.control)
            target = enclosingLabel.control;
        }
        return target;
      };
      const target = retarget(element);
      if (target instanceof HTMLInputElement) {
        target.select();
        target.focus();
        return;
      }
      if (target instanceof HTMLTextAreaElement) {
        target.selectionStart = 0;
        target.selectionEnd = target.value.length;
        target.focus();
        return;
      }
      if (typeof target.focus === "function")
        target.focus();
      const range = target.ownerDocument.createRange();
      range.selectNodeContents(target);
      const selection = target.ownerDocument.defaultView?.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }`, undefined);
  }

  async tap(options?: TapOptions): Promise<void> {
    await this.page.tap(this.reference().chain, options);
  }

  async click(options?: ClickOptions): Promise<void> {
    await this.page.clickReference(this.reference(), options);
  }

  async dblclick(options?: ClickOptions): Promise<void> {
    await this.page.clickReference(this.reference(), { ...options, clickCount: 2 });
  }

  async check(options?: ClickOptions): Promise<void> {
    await this.page.setCheckedReference(this.reference(), true, options);
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

  async innerText(): Promise<string> {
    return this.page.innerTextReference(this.reference());
  }

  async innerHTML(): Promise<string> {
    return this.page.innerHTMLReference(this.reference());
  }

  async getAttribute(name: string): Promise<string | null> {
    return this.page.getAttributeReference(this.reference(), name);
  }

  async inputValue(): Promise<string> {
    return this.page.inputValueReference(this.reference());
  }

  async isChecked(): Promise<boolean> {
    return this.page.isCheckedReference(this.reference());
  }

  async isDisabled(): Promise<boolean> {
    return this.page.isDisabledReference(this.reference());
  }

  async isEditable(): Promise<boolean> {
    return this.page.isEditableReference(this.reference());
  }

  async isEnabled(): Promise<boolean> {
    return this.page.isEnabledReference(this.reference());
  }

  async isHidden(): Promise<boolean> {
    return !(await this.page.elementIsVisible(this.reference()));
  }

  async isVisible(): Promise<boolean> {
    return this.page.elementIsVisible(this.reference());
  }

  async focus(): Promise<void> {
    await this.page.focusReference(this.reference());
  }

  async uncheck(options?: ClickOptions): Promise<void> {
    await this.page.setCheckedReference(this.reference(), false, options);
  }

  async selectOption(
    values: NormalizedSelectOption[],
    options?: { timeout?: number }
  ): Promise<string[]> {
    return this.page.selectOptionReference(this.reference(), values, options);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function extractBiDiContextUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("url" in payload)) {
    return null;
  }

  const url = (payload as { url?: unknown }).url;
  return typeof url === "string" ? url : null;
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

function toBiDiOutgoingHeaders(headers: Record<string, string>): Array<{
  name: string;
  value: { type: "string"; value: string };
}> {
  return Object.entries(headers).map(([name, value]) => ({
    name,
    value: {
      type: "string",
      value
    }
  }));
}

function toBiDiKeyValue(key: string): string {
  switch (key) {
    case "\r":
    case "\n":
      key = "Enter";
      break;
  }
  if ([...key].length === 1) {
    return key;
  }
  switch (key) {
    case "Cancel":
      return "\uE001";
    case "Help":
      return "\uE002";
    case "Backspace":
      return "\uE003";
    case "Tab":
      return "\uE004";
    case "Clear":
      return "\uE005";
    case "Enter":
      return "\uE007";
    case "Shift":
    case "ShiftLeft":
      return "\uE008";
    case "Control":
    case "ControlLeft":
      return "\uE009";
    case "Alt":
    case "AltLeft":
      return "\uE00A";
    case "Pause":
      return "\uE00B";
    case "Escape":
      return "\uE00C";
    case "PageUp":
      return "\uE00E";
    case "PageDown":
      return "\uE00F";
    case "End":
      return "\uE010";
    case "Home":
      return "\uE011";
    case "ArrowLeft":
      return "\uE012";
    case "ArrowUp":
      return "\uE013";
    case "ArrowRight":
      return "\uE014";
    case "ArrowDown":
      return "\uE015";
    case "Insert":
      return "\uE016";
    case "Delete":
      return "\uE017";
    case "NumpadEqual":
      return "\uE019";
    case "Numpad0":
      return "\uE01A";
    case "Numpad1":
      return "\uE01B";
    case "Numpad2":
      return "\uE01C";
    case "Numpad3":
      return "\uE01D";
    case "Numpad4":
      return "\uE01E";
    case "Numpad5":
      return "\uE01F";
    case "Numpad6":
      return "\uE020";
    case "Numpad7":
      return "\uE021";
    case "Numpad8":
      return "\uE022";
    case "Numpad9":
      return "\uE023";
    case "NumpadMultiply":
      return "\uE024";
    case "NumpadAdd":
      return "\uE025";
    case "NumpadSubtract":
      return "\uE027";
    case "NumpadDecimal":
      return "\uE028";
    case "NumpadDivide":
      return "\uE029";
    case "F1":
      return "\uE031";
    case "F2":
      return "\uE032";
    case "F3":
      return "\uE033";
    case "F4":
      return "\uE034";
    case "F5":
      return "\uE035";
    case "F6":
      return "\uE036";
    case "F7":
      return "\uE037";
    case "F8":
      return "\uE038";
    case "F9":
      return "\uE039";
    case "F10":
      return "\uE03A";
    case "F11":
      return "\uE03B";
    case "F12":
      return "\uE03C";
    case "Meta":
    case "MetaLeft":
      return "\uE03D";
    case "ShiftRight":
      return "\uE050";
    case "ControlRight":
      return "\uE051";
    case "AltRight":
      return "\uE052";
    case "MetaRight":
      return "\uE053";
    case "Space":
      return " ";
    case "Digit0":
      return "0";
    case "Digit1":
      return "1";
    case "Digit2":
      return "2";
    case "Digit3":
      return "3";
    case "Digit4":
      return "4";
    case "Digit5":
      return "5";
    case "Digit6":
      return "6";
    case "Digit7":
      return "7";
    case "Digit8":
      return "8";
    case "Digit9":
      return "9";
    case "KeyA":
      return "a";
    case "KeyB":
      return "b";
    case "KeyC":
      return "c";
    case "KeyD":
      return "d";
    case "KeyE":
      return "e";
    case "KeyF":
      return "f";
    case "KeyG":
      return "g";
    case "KeyH":
      return "h";
    case "KeyI":
      return "i";
    case "KeyJ":
      return "j";
    case "KeyK":
      return "k";
    case "KeyL":
      return "l";
    case "KeyM":
      return "m";
    case "KeyN":
      return "n";
    case "KeyO":
      return "o";
    case "KeyP":
      return "p";
    case "KeyQ":
      return "q";
    case "KeyR":
      return "r";
    case "KeyS":
      return "s";
    case "KeyT":
      return "t";
    case "KeyU":
      return "u";
    case "KeyV":
      return "v";
    case "KeyW":
      return "w";
    case "KeyX":
      return "x";
    case "KeyY":
      return "y";
    case "KeyZ":
      return "z";
    case "Semicolon":
      return ";";
    case "Equal":
      return "=";
    case "Comma":
      return ",";
    case "Minus":
      return "-";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    case "Backquote":
      return "`";
    case "BracketLeft":
      return "[";
    case "Backslash":
      return "\\";
    case "BracketRight":
      return "]";
    case "Quote":
      return "\"";
    default:
      throw new Error(`Unknown key: "${key}"`);
  }
}

function createScreencastHighlightBox(point: ActionPoint): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  const size = 48;
  return {
    left: point.x - size / 2,
    top: point.y - size / 2,
    width: size,
    height: size
  };
}

async function waitForAbortableTimeout(duration: number, signal: AbortSignal): Promise<boolean> {
  if (duration <= 0) {
    return !signal.aborted;
  }

  return await new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, duration);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function keyboardModifierState(modifiers: ReadonlySet<string>): {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
} {
  return {
    altKey: modifiers.has("Alt"),
    ctrlKey: modifiers.has("Control"),
    metaKey: modifiers.has("Meta"),
    shiftKey: modifiers.has("Shift")
  };
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
    detached: process.platform !== "win32",
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
    await terminateProcessTree(proc, { timeoutMs: CLEANUP_FIREFOX_PROCESS_TIMEOUT_MS });
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

function completeUserURL(urlString: string): string {
  if (/\s/.test(urlString)) {
    throw new Error(`Invalid URL: ${urlString}`);
  }
  if (urlString.startsWith("localhost") || urlString.startsWith("127.0.0.1")) {
    return `http://${urlString}`;
  }
  return urlString;
}

function shouldRetryFillActionabilityError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message.replace(/^(LocatorError:\s*)?(Error:\s*)?/, "").replace(/\s+Selector:.*$/s, "")
    : "";
  return (
    message === "No element found." ||
    message === "Element is not visible." ||
    message === "Element is not enabled." ||
    message === "Element is not editable."
  );
}

function verifyLifecycle(
  name: string,
  waitUntil: NonNullable<PageGotoOptions["waitUntil"]>
): NonNullable<PageGotoOptions["waitUntil"]> {
  if ((waitUntil as unknown) === "networkidle0") {
    waitUntil = "networkidle";
  }
  if (
    waitUntil !== "load" &&
    waitUntil !== "domcontentloaded" &&
    waitUntil !== "networkidle" &&
    waitUntil !== "commit"
  ) {
    throw new Error(`${name}: expected one of (load|domcontentloaded|networkidle|commit)`);
  }
  return waitUntil;
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

function isSelectOptionRetryResult(value: string[] | SelectOptionRetryResult): value is SelectOptionRetryResult {
  return !Array.isArray(value) && value.__needsRetry === true;
}

function normalizeConsoleMessageType(
  value: string
):
  | "log"
  | "debug"
  | "info"
  | "error"
  | "warning"
  | "dir"
  | "dirxml"
  | "table"
  | "trace"
  | "clear"
  | "startGroup"
  | "startGroupCollapsed"
  | "endGroup"
  | "assert"
  | "profile"
  | "profileEnd"
  | "count"
  | "time"
  | "timeEnd" {
  if (value === "warn") {
    return "warning";
  }

  switch (value) {
    case "log":
    case "debug":
    case "info":
    case "error":
    case "warning":
    case "dir":
    case "dirxml":
    case "table":
    case "trace":
    case "clear":
    case "startGroup":
    case "startGroupCollapsed":
    case "endGroup":
    case "assert":
    case "profile":
    case "profileEnd":
    case "count":
    case "time":
    case "timeEnd":
      return value;
    default:
      return "log";
  }
}
