import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cdpModule from "chrome-remote-interface";
import {
  ARIA_REF_SELECTOR_EVALUATE_SOURCE,
  type AriaSnapshotResult,
  type ResolvedAriaRefResult,
  normalizeAriaSnapshotOptions,
  retryUntilReady,
  withOptionalTimeout
} from "../../ariaSnapshot.js";
import { PLAYWRIGHT_ARIA_SNAPSHOT_EVALUATE_SOURCE as ARIA_SNAPSHOT_EVALUATE_SOURCE } from "../../vendor/playwright/ariaSnapshotEvaluate.js";
import { LocatorError, NotImplementedInProtocolError, TimeoutError } from "../../errors.js";
import { mergeExtraHTTPHeaders } from "../../httpHeaders.js";
import { RoxyElementHandle } from "../../elementHandle.js";
import { RoxyJSHandle, createJSHandle, createRemoteJSHandle } from "../../jsHandle.js";
import { RoxyWorker, type WorkerDelegate } from "../../worker.js";
import { createPageResponse } from "../../pageResponse.js";
import {
  PARSE_EVALUATION_RESULT_SOURCE,
  SERIALIZE_EVALUATION_RESULT_SOURCE,
  parseSerializedEvaluationResult,
  wrapWithSerializedEvaluationResult
} from "../evaluationSerializer.js";
import {
  isKeyboardModifier,
  isUsKeyboardLayoutKey,
  keyboardModifierMask,
  keyDescriptionForString,
  keypadLocation,
  resolveSmartModifierString,
  splitKeyboardShortcut,
  type KeyDescription
} from "../keyboardInput.js";
import type { Disposable, ResolvedAriaRef } from "../../types/api.js";
import type { PageFunction, SmartHandle, Worker } from "../../types/api.js";
import {
  createAltTextLocatorSelector,
  createLabelLocatorSelector,
  createPlaceholderLocatorSelector,
  createRoleLocatorSelector,
  createTestIdLocatorSelector,
  createTextLocatorSelector,
  createTitleLocatorSelector
} from "../../locatorSelectors.js";
import {
  SCROLL_INTO_VIEW_IF_NEEDED_SOURCE,
  SELECTOR_RUNTIME_SOURCE,
  type SelectOptionRetryResult,
  type SelectorRuntimePayload
} from "../selectorRuntime.js";
import {
  createChapterOverlayHtml,
  RENDER_SCREencast_OVERLAYS_SOURCE
} from "../../screencastOverlay.js";
import { RENDER_SCREENCAST_ACTIONS_SOURCE } from "../../screencastActions.js";
import {
  registerTestBrowserProcessForCleanup,
  terminateProcessTree
} from "../../processCleanup.js";
import type {
  AddScriptTagOptions,
  AddStyleTagOptions,
  AriaSnapshotOptions,
  BrowserConnectOptions,
  BrowserContextOptions,
  ClickOptions,
  DispatchEventOptions,
  FillOptions,
  GetByTextOptions,
  GetByRoleOptions,
  HoverOptions,
  KeyboardModifier,
  LaunchOptions,
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
  ViewportSize,
  WaitUntilState
} from "../../types/options.js";
import type {
  PageDialog,
  RawPageEventListener,
  RawPageEventMap,
  RawPageEventName,
  PageResponse
} from "../../types/events.js";
import type { RoutedRequestCall, RoutedRequestDecision } from "../routing.js";
import type {
  LocatorSelector,
  ProtocolBrowserAdapter,
  ProtocolBrowserAdapterFactory,
  ProtocolBrowserContextAdapter,
  ProtocolBrowserSession,
  ProtocolElementHandleAdapter,
  ProtocolElementHandleReference,
  ProtocolJSHandleAdapter,
  ProtocolLocatorAdapter,
  ProtocolPageAdapter
} from "../adapter.js";
import { locatorSelectorForPick } from "../adapter.js";
import type { ProtocolCapabilities } from "../capabilities.js";
import { looksLikeFunctionExpression } from "../evaluate.js";
import {
  parseEvaluationResultValue,
  serializeAsCallArgument,
  serializeAsCallArgumentNoHandles,
  type SerializedValue
} from "../../utilityScriptSerializers.js";
import type { InternalScreenshotOptions } from "../../screenshotOptions.js";
import type { NormalizedSelectOption } from "../../selectOptionValues.js";
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

const CDP_CLIENT_CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_MS = 500;
const REQUEST_EXTRA_INFO_FALLBACK_MS = 250;
const POPUP_ATTACH_MATCH_WINDOW_MS = 1_000;
const POPUP_FALLBACK_BINDING_NAME = "__roxyOnPopupOpenedFallback";
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

function toPlaywrightResourceType(type?: string): string {
  switch (type) {
    case "Document":
      return "document";
    case "Stylesheet":
      return "stylesheet";
    case "Image":
      return "image";
    case "Media":
      return "media";
    case "Font":
      return "font";
    case "Script":
      return "script";
    case "TextTrack":
      return "texttrack";
    case "XHR":
      return "xhr";
    case "Fetch":
      return "fetch";
    case "EventSource":
      return "eventsource";
    case "WebSocket":
      return "websocket";
    case "Manifest":
      return "manifest";
    case "Ping":
      return "ping";
    case "CSPViolationReport":
      return "cspreport";
    case "Prefetch":
      return "prefetch";
    default:
      return "other";
  }
}

function isFaviconRequestUrl(url: string): boolean {
  return url.endsWith("/favicon.ico");
}

function isBufferedEarlyEvent(
  event: RawPageEventName
): event is "dialog" | "request" | "response" | "requestfinished" | "requestfailed" {
  return (
    event === "dialog"
    || event === "request"
    || event === "response"
    || event === "requestfinished"
    || event === "requestfailed"
  );
}

const PAGE_PAPER_FORMATS: Record<string, { width: number; height: number }> = {
  letter: { width: 8.5, height: 11 },
  legal: { width: 8.5, height: 14 },
  tabloid: { width: 11, height: 17 },
  ledger: { width: 17, height: 11 },
  a0: { width: 33.1, height: 46.8 },
  a1: { width: 23.4, height: 33.1 },
  a2: { width: 16.54, height: 23.4 },
  a3: { width: 11.7, height: 16.54 },
  a4: { width: 8.27, height: 11.7 },
  a5: { width: 5.83, height: 8.27 },
  a6: { width: 4.13, height: 5.83 }
};
const DEBUG_POPUP_RESOLVE = process.env.ROXY_DEBUG_POPUP_RESOLVE === "1";
const DEBUG_PAGE_CLOSE = process.env.ROXY_DEBUG_PAGE_CLOSE === "1";

const UNIT_TO_PIXELS: Record<string, number> = {
  px: 1,
  in: 96,
  cm: 37.8,
  mm: 3.78
};

type CdpClient = CDP.Client;
type CdpVersionResult = CDP.VersionResult;
type CdpTarget = CDP.Target;

interface CdpRemoteObject {
  className?: string;
  description?: string;
  objectId?: string;
  preview?: {
    properties?: Array<{
      name: string;
      type?: string;
      value?: string;
      valuePreview?: { description?: string };
    }>;
    subtype?: string;
  };
  subtype?: string;
  type?: string;
  unserializableValue?: string;
  value?: unknown;
}

interface CdpDispatchMouseEventParams {
  button?: MouseButton | "none";
  buttons?: number;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  force?: number;
  modifiers?: number;
  type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel";
  x: number;
  y: number;
}

interface CdpRuntimeClient {
  send(
    method: "Runtime.evaluate",
    params: {
      expression: string;
      awaitPromise?: boolean;
      returnByValue?: boolean;
      userGesture?: boolean;
    }
  ): Promise<{ exceptionDetails?: CdpExceptionDetails; result: CdpRemoteObject }>;
  send(
    method: "Runtime.callFunctionOn",
    params: {
      arguments?: Array<{ objectId?: string; unserializableValue?: string; value?: unknown }>;
      awaitPromise?: boolean;
      executionContextId?: number;
      functionDeclaration: string;
      objectId?: string;
      returnByValue?: boolean;
      userGesture?: boolean;
    }
  ): Promise<{ exceptionDetails?: CdpExceptionDetails; result: CdpRemoteObject }>;
  send(
    method: "Runtime.getProperties",
    params: {
      objectId: string;
      ownProperties?: boolean;
    }
  ): Promise<{
    result: Array<{
      enumerable?: boolean;
      name: string;
      value?: CdpRemoteObject;
    }>;
  }>;
  send(method: "Runtime.releaseObject", params: { objectId: string }): Promise<unknown>;
}

type CdpPendingRequestEvent = {
  fallbackTimer?: ReturnType<typeof setTimeout>;
  payload: RawPageEventMap["request"];
  responseCallbacks: Array<() => void>;
};

interface CdpEvaluationTargetContext {
  executionContextId?: number;
  frameId?: string;
  objectId?: string;
  sessionId?: string;
}

interface CdpDomClient {
  send(
    method: "DOM.getBoxModel",
    params: { objectId: string }
  ): Promise<{
    model: {
      border: [number, number, number, number, number, number, number, number];
    };
  }>;
  send(
    method: "DOM.describeNode",
    params: { objectId: string },
    sessionId?: string
  ): Promise<{
    node: {
      backendNodeId?: number;
      frameId?: string;
      nodeName?: string;
    };
  }>;
  send(
    method: "DOM.getFrameOwner",
    params: { frameId: string }
  ): Promise<{
    backendNodeId: number;
  }>;
  send(
    method: "DOM.resolveNode",
    params: { backendNodeId: number; executionContextId?: number },
    sessionId?: string
  ): Promise<{
    object: CdpRemoteObject;
  }>;
}

interface CdpPageFramePayload {
  id: string;
  loaderId?: string;
  name?: string;
  parentId?: string;
  url?: string;
}

interface CdpFrameTreePayload {
  childFrames?: CdpFrameTreePayload[];
  frame: CdpPageFramePayload;
}

interface CdpNativeFrameState {
  id: string;
  loaderId?: string;
  name: string;
  parentId: string | null;
  url: string;
}

interface CdpPageFrameClient {
  send(
    method: "Page.getFrameTree"
  ): Promise<{
    frameTree: CdpFrameTreePayload;
  }>;
  send(
    method: "Page.setDocumentContent",
    params: {
      frameId: string;
      html: string;
    }
  ): Promise<unknown>;
}

interface CdpExceptionDetails {
  exception?: {
    description?: string;
    preview?: {
      properties?: Array<{ name: string; value?: string }>;
    };
    value?: unknown;
  };
  stackTrace?: {
    callFrames: Array<{
      columnNumber: number;
      functionName?: string;
      lineNumber: number;
      url: string;
    }>;
  };
  text: string;
}

interface CdpConnectionDetails {
  browserWsEndpoint: string;
  host: string;
  port: number;
  spawnedProcess?: ChildProcess;
  userDataDir?: string;
  unregisterTestBrowserProcess?: () => void;
}

interface StreamLike {
  on(event: string, listener: (chunk: unknown) => void): StreamLike;
}

interface CdpBrowserState {
  browserClient: CdpClient;
  version: CdpVersionResult;
  connection: CdpConnectionDetails;
  // Tracks IDs returned by Target.createBrowserContext so the default context
  // adapter (browserContextId === undefined) can exclude targets that explicitly
  // belong to an isolated context. Populated in CdpBrowserSession.newContext().
  isolatedBrowserContextIds: Set<string>;
}

type LocatorPick =
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "nth"; index: number };

interface CdpLocatorState {
  chain: LocatorSelector[];
  pick?: LocatorPick;
  strict?: boolean;
  protocolFrameId?: string;
}

interface ActionPoint {
  x: number;
  y: number;
}

interface StateWaiter {
  frameId?: string;
  state: WaitUntilState;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ResponseBodyState {
  failure?: Error;
  ready: Promise<void>;
  markFailed: (error: Error) => void;
  resolveReady: () => void;
  body?: Promise<Buffer>;
  expectedLength?: number;
  frameId?: string;
  fulfilledBody?: Buffer;
  sessionId?: string;
  url?: string;
}

type FetchErrorReason =
  | "Failed"
  | "Aborted"
  | "TimedOut"
  | "AccessDenied"
  | "ConnectionClosed"
  | "ConnectionReset"
  | "ConnectionRefused"
  | "ConnectionAborted"
  | "ConnectionFailed"
  | "NameNotResolved"
  | "InternetDisconnected"
  | "AddressUnreachable"
  | "BlockedByClient"
  | "BlockedByResponse";

interface NavigationResponseCapture {
  lastResponse: PageResponse | null;
  predicate?: (response: PageResponse) => boolean;
  resolve?: (response: PageResponse) => void;
}

interface NavigationFailureCapture {
  apiName: string;
  allowCommittedRedirectTimeout?: boolean;
  committed?: boolean;
  expectedLoaderId?: string;
  resolveCommittedInterruption: () => void;
  targetUrl?: string;
  reject: (error: Error) => void;
}

const COMMITTED_NAVIGATION_INTERRUPTED = Symbol("committedNavigationInterrupted");

interface CdpCoverageRange {
  count: number;
  endOffset: number;
  startOffset: number;
}

interface CdpFrameNetworkIdleState {
  activeRequests: number;
  idleReached: boolean;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

interface CdpJsCoverageState {
  enabled: boolean;
  eventListeners: Array<{
    event: string;
    listener: (...args: any[]) => void;
  }>;
  reportAnonymousScripts: boolean;
  resetOnNavigation: boolean;
  scriptIds: Set<string>;
  scriptSources: Map<string, string>;
}

interface CdpCssCoverageState {
  enabled: boolean;
  eventListeners: Array<{
    event: string;
    listener: (...args: any[]) => void;
  }>;
  resetOnNavigation: boolean;
  stylesheetSources: Map<string, string>;
  stylesheetUrls: Map<string, string>;
}

interface CdpContextInitScriptRegistration {
  source: string;
  onInstalled(disposable: Disposable): void;
}

interface CdpScreencastOverlayState {
  kind?: "chapter";
  html: string;
  removeTimer?: ReturnType<typeof setTimeout>;
}

interface CdpScreencastSessionState {
  quality: number;
  record: boolean;
  sendFrames: boolean;
  size: {
    width: number;
    height: number;
  };
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

interface CheckedStateDetails {
  matches: boolean;
  isRadio: boolean;
}

interface LocatorPayload {
  operation:
    | "actionPoint"
    | "checkedState"
    | "checkedStateDetails"
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

function convertPrintParameterToInches(value?: string | number): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "number") {
    return value / 96;
  }

  const text = value.trim();
  let unit = text.slice(-2).toLowerCase();
  let valueText = "";

  if (Object.prototype.hasOwnProperty.call(UNIT_TO_PIXELS, unit)) {
    valueText = text.slice(0, -2);
  } else {
    unit = "px";
    valueText = text;
  }

  const parsedValue = Number(valueText);
  if (Number.isNaN(parsedValue)) {
    throw new Error(`Failed to parse parameter value: ${value}`);
  }

  const pixelsPerUnit = UNIT_TO_PIXELS[unit];
  if (pixelsPerUnit === undefined) {
    throw new Error(`Unknown unit: ${unit}`);
  }

  return (parsedValue * pixelsPerUnit) / 96;
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

    if (selector.exact) {
      return normalizedCandidate === pattern;
    }

    return normalizedCandidate.toLowerCase().includes(pattern.toLowerCase());
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

    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return normalize(ariaLabel);

    if (
      element instanceof HTMLInputElement &&
      ["button", "submit", "reset"].includes(element.type)
    ) {
      return normalize(element.value);
    }

    return normalize((element as HTMLElement).innerText || element.textContent);
  };

  const textSelectorValue = (element: Element): string => {
    if (
      element instanceof HTMLInputElement &&
      ["button", "submit", "reset"].includes(element.type)
    ) {
      return element.value;
    }

    return (element as HTMLElement).innerText || element.textContent || "";
  };

  const shouldSkipTextSelectorElement = (element: Element): boolean => {
    const tagName = element.tagName.toLowerCase();
    return tagName === "head" || tagName === "title" || tagName === "script" || tagName === "style";
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
      const matching = descendants.filter((element) => {
        if (shouldSkipTextSelectorElement(element)) {
          return false;
        }
        return matchesPattern(textSelectorValue(element), selector, "value");
      });

      return matching.filter((element) =>
        !Array.from(element.querySelectorAll("*")).some((child) =>
          !shouldSkipTextSelectorElement(child) &&
          matchesPattern(textSelectorValue(child), selector, "value")
        )
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
    const rect = element.getBoundingClientRect();
    return (
      hasVisibleStyle(element) &&
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
        const waitResult = waitForFillActionability(firstElement);
        return waitResult instanceof Promise ? waitResult.then(fillElement) : fillElement();
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
      connection,
      isolatedBrowserContextIds: new Set<string>()
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

    const state = this.state;
    this.state = undefined;

    try {
      await safelyCloseClient(state.browserClient);
    } finally {
      await cleanupConnection(state.connection);
    }
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
    if (options.reuseDefaultUserContext) {
      return new CdpBrowserContextAdapter(this.state, undefined, options);
    }

    const response = await this.state.browserClient.Target.createBrowserContext({});
    // Track the new isolated context so the default context adapter (reuseDefaultUserContext)
    // can distinguish default-context targets from explicitly isolated ones.
    this.state.isolatedBrowserContextIds.add(response.browserContextId);

    return new CdpBrowserContextAdapter(
      this.state,
      response.browserContextId,
      options
    );
  }

  async close(): Promise<void> {}
}

async function applyCdpBrowserDownloadBehavior(
  browserClient: CdpClient,
  browserContextId: string | undefined,
  options: BrowserContextOptions
): Promise<void> {
  const behavior = cdpDownloadBehavior(options);
  if (!behavior) {
    return;
  }
  const client = browserClient as CdpClient & {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
  await client.send("Browser.setDownloadBehavior", {
    ...behavior,
    eventsEnabled: true,
    ...(browserContextId ? { browserContextId } : {})
  }).catch(() => undefined);
}

async function applyCdpPageDownloadBehavior(
  pageClient: CdpClient,
  options: BrowserContextOptions
): Promise<void> {
  const behavior = cdpDownloadBehavior(options);
  if (!behavior) {
    return;
  }
  const client = pageClient as CdpClient & {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
  await client.send("Page.setDownloadBehavior", behavior).catch(() => undefined);
}

function cdpDownloadBehavior(options: BrowserContextOptions): Record<string, unknown> | undefined {
  if (options.acceptDownloads === false) {
    return { behavior: "deny" };
  }
  if (!options.downloadsDir) {
    return undefined;
  }
  return {
    behavior: "allow",
    downloadPath: options.downloadsDir
  };
}

class CdpBrowserContextAdapter implements ProtocolBrowserContextAdapter {
  private readonly pages = new Map<string, ProtocolPageAdapter>();
  private readonly pageSessionIds = new Map<string, string>();
  private readonly initializingPages = new Map<string, CdpPageAdapter>();
  private readonly pendingPages = new Map<string, Promise<ProtocolPageAdapter>>();
  private readonly initScripts = new Set<{
    source: string;
    disposablesByPage: WeakMap<ProtocolPageAdapter, Disposable>;
  }>();
  private readonly pendingSyntheticPopupsByOpener = new Map<
    string,
    Array<{
      timer: ReturnType<typeof setTimeout>;
      url: string;
    }>
  >();
  private readonly recentAttachedPopupsByOpener = new Map<string, number[]>();
  private readonly detachedTargetIds = new Set<string>();
  private readonly pendingTargetDetachWaiters = new Map<string, Set<() => void>>();
  private readonly pointerActionScheduler = new CdpPointerActionScheduler();
  private readonly manuallyCreatedTargetIds = new Set<string>();
  private readonly creatingPageTargetIds = new Set<string>();
  private pendingManualPageCreations = 0;
  private requestInterceptor:
    | ((call: RoutedRequestCall) => Promise<RoutedRequestDecision>)
    | null = null;
  private requestInterceptionEnabled = false;
  private readonly pageListeners = new Set<
    (
      page: ProtocolPageAdapter,
      opener?: ProtocolPageAdapter | null,
      hasWindowOpener?: boolean
    ) => void | Promise<void>
  >();
  private readonly targetDiscoveryReady: Promise<void>;
  private targetPollTimer: ReturnType<typeof setInterval> | null = null;
  private closing = false;

  constructor(
    private readonly state: CdpBrowserState,
    private readonly browserContextId: string | undefined,
    private readonly options: BrowserContextOptions
  ) {
    this.targetDiscoveryReady = this.initializeTargetDiscovery();
  }

  // Resolves once target discovery and the initial page-population batch have
  // completed. RoxyBrowser.newContext() awaits this so context.pages() is
  // non-empty by the time the caller receives the BrowserContext object.
  async ready(): Promise<void> {
    await this.targetDiscoveryReady;
  }

  async newPage(): Promise<ProtocolPageAdapter> {
    await this.targetDiscoveryReady;
    this.pendingManualPageCreations += 1;
    let response: { targetId: string };
    try {
      response = await this.state.browserClient.Target.createTarget({
        url: "about:blank",
        ...(this.browserContextId ? { browserContextId: this.browserContextId } : {})
      });
    } catch (error) {
      this.pendingManualPageCreations = Math.max(0, this.pendingManualPageCreations - 1);
      throw error;
    }
    if (!this.creatingPageTargetIds.has(response.targetId)) {
      this.pendingManualPageCreations = Math.max(0, this.pendingManualPageCreations - 1);
    }
    this.creatingPageTargetIds.add(response.targetId);
    this.manuallyCreatedTargetIds.add(response.targetId);
    this.detachedTargetIds.delete(response.targetId);

    const autoAttached = this.pendingPages.get(response.targetId);
    if (autoAttached) {
      return autoAttached;
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const pendingPage = this.pendingPages.get(response.targetId);
      if (pendingPage) {
        return pendingPage;
      }
      const existing = this.pages.get(response.targetId);
      if (existing) {
        return existing;
      }
      await delay(5);
    }
    return this.getOrCreatePage(response.targetId, {
      skipDetachRace: true
    });
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
    const storageClient = this.state.browserClient as CdpClient & {
      send(
        method: "Storage.setCookies",
        params: {
          browserContextId?: string;
          cookies: Array<Record<string, unknown>>;
        }
      ): Promise<unknown>;
    };
    await storageClient.send("Storage.setCookies", {
      cookies: rewriteCdpCookies(cookies).map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        ...(cookie.url !== undefined ? { url: cookie.url } : {}),
        ...(cookie.domain !== undefined ? { domain: cookie.domain } : {}),
        ...(cookie.path !== undefined ? { path: cookie.path } : {}),
        ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
        ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
        ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
        ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
        ...(cookie.partitionKey !== undefined
          ? {
              partitionKey: {
                hasCrossSiteAncestor: true,
                topLevelSite: cookie.partitionKey
              }
            }
          : {})
      })),
      ...(this.browserContextId ? { browserContextId: this.browserContextId } : {})
    });
  }

  async cookies(urls?: string[]): Promise<Array<{
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
    const storageClient = this.state.browserClient as CdpClient & {
      send(
        method: "Storage.getCookies",
        params: { browserContextId?: string }
      ): Promise<{
        cookies: Array<{
          name: string;
          value: string;
          domain: string;
          path: string;
          expires: number;
          httpOnly: boolean;
          secure: boolean;
          sameSite?: "Strict" | "Lax" | "None";
          partitionKey?: { topLevelSite?: string };
        }>;
      }>;
    };
    const { cookies } = await storageClient.send("Storage.getCookies", {
      ...(this.browserContextId ? { browserContextId: this.browserContextId } : {})
    });
    return filterCdpCookies(
      cookies.map((cookie) => ({
        domain: cookie.domain,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        name: cookie.name,
        path: cookie.path,
        ...(cookie.partitionKey?.topLevelSite ? { partitionKey: cookie.partitionKey.topLevelSite } : {}),
        sameSite: cookie.sameSite ?? "Lax",
        secure: cookie.secure,
        value: cookie.value
      })),
      urls ?? []
    );
  }

  async clearCookies(options?: {
    domain?: string | RegExp;
    name?: string | RegExp;
    path?: string | RegExp;
  }): Promise<void> {
    const storageClient = this.state.browserClient as CdpClient & {
      send(
        method: "Storage.clearCookies",
        params: { browserContextId?: string }
      ): Promise<unknown>;
    };
    if (!options?.domain && !options?.name && !options?.path) {
      await storageClient.send("Storage.clearCookies", {
        ...(this.browserContextId ? { browserContextId: this.browserContextId } : {})
      });
      return;
    }

    const cookies = await this.cookies();
    const retained = cookies.filter((cookie) => !matchesCookieFilter(cookie, options));
    await storageClient.send("Storage.clearCookies", {
      ...(this.browserContextId ? { browserContextId: this.browserContextId } : {})
    });
    if (retained.length) {
      await this.addCookies(retained);
    }
  }

  onPage(
    listener: (
      page: ProtocolPageAdapter,
      opener?: ProtocolPageAdapter | null,
      hasWindowOpener?: boolean
    ) => void | Promise<void>
  ): () => void {
    this.pageListeners.add(listener);
    return () => {
      this.pageListeners.delete(listener);
    };
  }

  async setExtraHTTPHeaders(headers: { [key: string]: string }): Promise<void> {
    this.options.extraHTTPHeaders = { ...headers };
    await Promise.all(
      Array.from(this.pages.values()).map(async (page) => {
        if ("updateContextExtraHTTPHeaders" in page && typeof page.updateContextExtraHTTPHeaders === "function") {
          await page.updateContextExtraHTTPHeaders();
        }
      })
    );
  }

  async addInitScript(source: string, _arg?: unknown): Promise<Disposable> {
    const entry = {
      source,
      disposablesByPage: new WeakMap<ProtocolPageAdapter, Disposable>()
    };
    this.initScripts.add(entry);
    await Promise.all(Array.from(this.pages.values(), async (page) => {
      const disposable = await page.addInitScript(source);
      entry.disposablesByPage.set(page, disposable);
    }));
    const dispose = async () => {
      if (!this.initScripts.delete(entry)) {
        return;
      }
      await Promise.all(Array.from(this.pages.values(), async (page) => {
        await entry.disposablesByPage.get(page)?.dispose();
      }));
    };
    return {
      dispose,
      [Symbol.asyncDispose]: dispose
    };
  }

  async setRequestInterceptor(
    handler: ((call: RoutedRequestCall) => Promise<RoutedRequestDecision>) | null
  ): Promise<void> {
    this.requestInterceptor = handler;
    const shouldEnable = Boolean(handler);
    this.requestInterceptionEnabled = shouldEnable;
    await Promise.all(
      Array.from(this.pages.values(), async (page) => {
        await page.setRequestInterceptor?.(handler);
      })
    );
  }

  async close(): Promise<void> {
    if (this.closing) {
      return;
    }

    this.closing = true;
    for (const entries of this.pendingSyntheticPopupsByOpener.values()) {
      for (const entry of entries) {
        clearTimeout(entry.timer);
      }
    }
    this.pendingSyntheticPopupsByOpener.clear();
    if (this.targetPollTimer) {
      clearInterval(this.targetPollTimer);
      this.targetPollTimer = null;
    }
    await this.targetDiscoveryReady.catch(() => {});

    const pendingPages = Array.from(this.pendingPages.values());

    await Promise.all(
      Array.from(this.pages.values()).map(async (page) => {
        await page.close();
      })
    );
    this.pages.clear();

    if (this.browserContextId) {
      try {
        await this.state.browserClient.Target.disposeBrowserContext({
          browserContextId: this.browserContextId
        });
      } catch (error) {
        if (!isClosedCdpConnectionError(error)) {
          throw error;
        }
      }
      // Remove from the shared set so the default context adapter stops
      // excluding targets that belonged to this now-disposed context.
      this.state.isolatedBrowserContextIds.delete(this.browserContextId);
    }

    await Promise.allSettled(pendingPages);
    this.pendingPages.clear();
    this.initializingPages.clear();
  }

  private async initializeTargetDiscovery(): Promise<void> {
    await applyCdpBrowserDownloadBehavior(this.state.browserClient, this.browserContextId, this.options);
    this.state.browserClient.Target.attachedToTarget?.((event: {
      sessionId: string;
      targetInfo: {
        targetId: string;
        type: string;
        browserContextId?: string;
        openerId?: string;
        canAccessOpener?: boolean;
        url?: string;
      };
      waitingForDebugger?: boolean;
    }) => {
      void this.handleTargetAttached(event);
    });
    this.state.browserClient.Target.targetCreated?.((event: {
      targetInfo: {
        targetId: string;
        type: string;
        browserContextId?: string;
        openerId?: string;
        canAccessOpener?: boolean;
      };
    }) => {
      void this.handleTargetCreated(event.targetInfo);
    });
    this.state.browserClient.Target.detachedFromTarget?.((event: {
      sessionId: string;
      targetId?: string;
    }) => {
      if (event.targetId) {
        void this.handleTargetDetached(event.targetId, event.sessionId);
      }
    });
    this.state.browserClient.Target.targetDestroyed?.((event: {
      targetId: string;
    }) => {
      void this.handleTargetDetached(event.targetId);
    });

    // Bug fix: when connecting to an existing browser's default user context
    // (reuseDefaultUserContext: true), use waitForDebuggerOnStart: false.
    //
    // With waitForDebuggerOnStart: true, Chrome pauses EVERY new renderer process
    // — including the ones created by cross-origin navigations — and waits for
    // Runtime.runIfWaitingForDebugger before allowing them to execute.
    // resumeOnInitialized only unblocks the initial attachment; subsequent
    // navigations to cross-origin pages spin up fresh renderer processes that
    // never get resumed, so page.goto() hangs indefinitely. The navigation
    // appears to succeed only after our process exits and Chrome auto-detaches.
    //
    // For newly isolated contexts (normal newContext()), we keep true so that
    // init scripts are injected before any page JavaScript executes.
    await this.state.browserClient.Target.setAutoAttach?.({
      autoAttach: true,
      waitForDebuggerOnStart: !this.options.reuseDefaultUserContext,
      flatten: true
    }).catch(() => {});

    // Await pages that were attached synchronously via setAutoAttach events.
    // In practice Chrome does NOT fire attachedToTarget for pre-existing page
    // targets from the browser session, so this batch is usually empty — but
    // it's still needed for targets attached via other mechanisms (workers, etc.).
    const initialPagePromises = Array.from(this.pendingPages.values());
    await Promise.allSettled(initialPagePromises);

    await (
      this.state.browserClient.Target as typeof this.state.browserClient.Target & {
        getTargetInfo?: () => Promise<unknown>;
      }
    ).getTargetInfo?.().catch(() => {});
    await this.state.browserClient.Target.setDiscoverTargets?.({
      discover: true
    });

    // Explicitly discover and attach to any pre-existing page targets that
    // setAutoAttach did not fire attachedToTarget for (Chrome's browser-level
    // setAutoAttach only triggers attachedToTarget for new targets, not for
    // tabs that were already open before our session connected).
    // This is the primary mechanism that populates context.pages() after
    // connect — without it, pages() is always empty on connect.
    await this.discoverTargets();

    this.targetPollTimer = setInterval(() => {
      void this.discoverTargets().catch(() => {});
    }, 100);
  }

  private async handleTargetAttached(event: {
    sessionId: string;
    targetInfo: {
      targetId: string;
      type: string;
      browserContextId?: string;
      openerId?: string;
      canAccessOpener?: boolean;
      url?: string;
    };
    waitingForDebugger?: boolean;
  }): Promise<void> {
    const { targetInfo } = event;
    if (this.closing) {
      return;
    }
    if (targetInfo.type !== "page") {
      if (!this.matchesBrowserContextTarget(targetInfo)) {
        return;
      }
      await sendBrowserCommandInSession(this.state.browserClient, "Runtime.enable", {}, event.sessionId).catch(() => {});
      await sendBrowserCommandInSession(this.state.browserClient, "Runtime.runIfWaitingForDebugger", {}, event.sessionId).catch(() => {});
      return;
    }
    if (!this.matchesTargetInfo(targetInfo)) {
      return;
    }
    if (this.pages.has(targetInfo.targetId) || this.pendingPages.has(targetInfo.targetId)) {
      await sendBrowserCommandInSession(this.state.browserClient, "Runtime.runIfWaitingForDebugger", {}, event.sessionId).catch(() => {});
      return;
    }

    const isPendingManualPage =
      this.pendingManualPageCreations > 0 &&
      !targetInfo.openerId &&
      (!targetInfo.url || targetInfo.url === "about:blank");
    if (isPendingManualPage) {
      this.pendingManualPageCreations = Math.max(0, this.pendingManualPageCreations - 1);
      this.creatingPageTargetIds.add(targetInfo.targetId);
      this.manuallyCreatedTargetIds.add(targetInfo.targetId);
    }
    if (targetInfo.openerId && !this.hasPendingSyntheticPopup(targetInfo.openerId)) {
      this.noteAttachedPopup(targetInfo.openerId);
    }

    const pagePromise = this.getOrCreatePage(targetInfo.targetId, {
      client: createSessionTargetClient(this.state.browserClient, event.sessionId),
      fallbackUrl: targetInfo.url ?? "about:blank",
      hasWindowOpener: targetInfo.canAccessOpener ?? true,
      openerTargetId: targetInfo.openerId ?? null,
      emitPage: !this.manuallyCreatedTargetIds.has(targetInfo.targetId),
      sessionId: event.sessionId
    });
    this.pageSessionIds.set(targetInfo.targetId, event.sessionId);
    if (targetInfo.openerId) {
      this.cancelNextSyntheticPopup(targetInfo.openerId);
    }
    this.pendingPages.set(targetInfo.targetId, pagePromise);
    void pagePromise.catch(() => {});
    void pagePromise.finally(() => {
      if (this.pendingPages.get(targetInfo.targetId) === pagePromise) {
        this.pendingPages.delete(targetInfo.targetId);
      }
    });
  }

  private async discoverTargets(): Promise<void> {
    if (this.closing) {
      return;
    }

    const result = await (
      this.state.browserClient.Target as typeof this.state.browserClient.Target & {
        getTargets(): Promise<{
          targetInfos: Array<{
            targetId: string;
            type: string;
            browserContextId?: string;
            openerId?: string;
            canAccessOpener?: boolean;
            url?: string;
          }>;
        }>;
      }
    ).getTargets();

    // Filter to page targets we own that haven't been attached yet.
    // Chrome's browser-level setAutoAttach does not fire attachedToTarget for
    // tabs that were already open before our CDP session connected, so we must
    // discover and attach to them explicitly here.
    const unattached = result.targetInfos.filter(
      targetInfo =>
        this.matchesTargetInfo(targetInfo) &&
        !this.pages.has(targetInfo.targetId) &&
        !this.pendingPages.has(targetInfo.targetId)
    );

    if (!unattached.length) {
      return;
    }

    // Attach to all unattached targets concurrently — mirrors Playwright's approach
    // of starting all attachments in parallel for faster connection on multi-tab browsers.
    const sessions = (
      await Promise.all(
        unattached.map(async targetInfo => {
          try {
            const attachResult = await (
              this.state.browserClient.Target as typeof this.state.browserClient.Target & {
                attachToTarget(params: {
                  targetId: string;
                  flatten?: boolean;
                }): Promise<{ sessionId: string }>;
              }
            ).attachToTarget({ targetId: targetInfo.targetId, flatten: true });
            return { targetInfo, sessionId: attachResult.sessionId };
          } catch {
            return null;
          }
        })
      )
    ).filter((s): s is { targetInfo: (typeof unattached)[number]; sessionId: string } => s !== null);

    // Kick off page initialization for all targets concurrently. Do not reorder
    // the resulting page events: Playwright's client-side BrowserContext.pages()
    // follows the order in which page events are reported, not the browser UI tab
    // strip order or a Target.getTargets() snapshot order.
    //
    // handleTargetAttached runs synchronously until its first internal await, so
    // pendingPages entries are populated for all targets before this loop ends.
    for (const { targetInfo, sessionId } of sessions) {
      void this.handleTargetAttached({
        sessionId,
        targetInfo,
        waitingForDebugger: false
      });
    }

    // Capture all pending page promises now (they were set synchronously above).
    const pagePromises = sessions
      .map(({ targetInfo }) => this.pendingPages.get(targetInfo.targetId))
      .filter((p): p is Promise<ProtocolPageAdapter> => p !== undefined);

    // Wait for all initializations concurrently — mirrors Playwright's
    // Promise.all(crPages.map(crPage => crPage._page.waitForInitializedOrError())).
    // Individual page events are emitted by getOrCreatePage as each page becomes
    // reportable.
    await Promise.allSettled(pagePromises);
  }

  private async handleTargetCreated(targetInfo: {
    targetId: string;
    type: string;
    browserContextId?: string;
    openerId?: string;
    canAccessOpener?: boolean;
    url?: string;
  }): Promise<void> {
    if (this.closing || !this.matchesTargetInfo(targetInfo)) {
      return;
    }
    // New targets created after our session connected are handled by the
    // attachedToTarget events fired by setAutoAttach. Pre-existing targets are
    // handled by discoverTargets() at initialization time and on each poll tick.
  }

  private async handleTargetDetached(targetId: string, sessionId?: string): Promise<void> {
    const attachedSessionId = this.pageSessionIds.get(targetId);
    if (attachedSessionId && sessionId && attachedSessionId !== sessionId) {
      return;
    }
    this.markTargetDetached(targetId);
    const page = (
      this.pages.get(targetId)
      ?? this.initializingPages.get(targetId)
    ) as (ProtocolPageAdapter & { didClose?: () => void }) | undefined;
    if (DEBUG_PAGE_CLOSE) {
      console.error("[roxy-page-close] browser-context-target-detached", JSON.stringify({
        targetId,
        sessionId,
        attachedSessionId,
        hasPage: Boolean(page)
      }));
    }
    page?.didClose?.();
  }

  private matchesTargetInfo(targetInfo: {
    targetId: string;
    type: string;
    browserContextId?: string;
    openerId?: string;
    canAccessOpener?: boolean;
  }): boolean {
    if (targetInfo.type !== "page") {
      return false;
    }
    if (targetInfo.browserContextId === this.browserContextId) {
      return true;
    }
    if (targetInfo.openerId && this.pages.has(targetInfo.openerId)) {
      return true;
    }
    if (targetInfo.openerId && this.pendingPages.has(targetInfo.openerId)) {
      return true;
    }
    // When we represent the default browser context (no browserContextId), match
    // all page targets that do NOT belong to a known isolated context.
    //
    // Chrome 119+ assigns a non-empty UUID to ALL targets — including those in the
    // default context — so the old check `!targetInfo.browserContextId` incorrectly
    // excluded every tab that had been given a default-context UUID, making
    // context.pages() always empty after connect.
    //
    // Isolated contexts are tracked in state.isolatedBrowserContextIds (populated
    // in CdpBrowserSession.newContext when Target.createBrowserContext is called).
    // Any target NOT in that set belongs to the default context.
    return !this.browserContextId &&
      !this.state.isolatedBrowserContextIds.has(targetInfo.browserContextId ?? "");
  }

  private matchesBrowserContextTarget(targetInfo: {
    browserContextId?: string;
  }): boolean {
    if (targetInfo.browserContextId === this.browserContextId) {
      return true;
    }
    // Same reasoning as matchesTargetInfo: default context adapter accepts all
    // non-isolated targets regardless of whether browserContextId is a UUID.
    return !this.browserContextId &&
      !this.state.isolatedBrowserContextIds.has(targetInfo.browserContextId ?? "");
  }

  private async getOrCreatePage(
    targetId: string,
    options: {
      client?: CdpClient;
      fallbackUrl?: string;
      openerTargetId?: string | null;
      hasWindowOpener?: boolean;
      emitPage?: boolean;
      sessionId?: string;
      skipDetachRace?: boolean;
    } = {}
  ): Promise<ProtocolPageAdapter> {
    const existing = this.pages.get(targetId);
    if (existing) {
      return existing;
    }

    const pending = this.pendingPages.get(targetId);
    if (pending) {
      return pending;
    }

    const pagePromise = (async () => {
      let page: ProtocolPageAdapter;
      try {
        const createPagePromise = (async () => {
          const client = options.client ?? await connectToTarget(this.state.connection, targetId);
          await applyCdpPageDownloadBehavior(client, this.options);
          let constructedPage: ProtocolPageAdapter | undefined;
          return CdpPageAdapter.create({
            browserClient: this.state.browserClient,
            client,
            targetId,
            contextOptions: this.options,
            contextInitScripts: Array.from(this.initScripts, (entry) => ({
              source: entry.source,
              onInstalled: (disposable) => {
                if (constructedPage) {
                  entry.disposablesByPage.set(constructedPage, disposable);
                }
              }
            })),
            initialRequestInterceptor: this.requestInterceptionEnabled
              ? this.requestInterceptor
              : null,
            suppressClosedInitScriptErrors: true,
            onWindowOpenFallback: (url) => {
              this.queueSyntheticPopup(targetId, url);
            },
            onPageConstructed: (page) => {
              constructedPage = page;
              this.initializingPages.set(targetId, page);
            },
            pointerActionScheduler: this.pointerActionScheduler,
            initialNavigationFrameUnavailable: Boolean(options.openerTargetId),
            ...(options.sessionId
              ? {
                  resumeOnInitialized: async () => {
                    await sendBrowserCommandInSession(this.state.browserClient, "Runtime.runIfWaitingForDebugger", {}, options.sessionId!).catch(() => {});
                  }
                }
              : {}),
            onClosed: (closedTargetId) => {
              this.initializingPages.delete(closedTargetId);
              this.pages.delete(closedTargetId);
              this.pendingPages.delete(closedTargetId);
              this.pageSessionIds.delete(closedTargetId);
              this.manuallyCreatedTargetIds.delete(closedTargetId);
              this.creatingPageTargetIds.delete(closedTargetId);
              this.detachedTargetIds.delete(closedTargetId);
            }
          });
        })();
        page = options.skipDetachRace || !options.emitPage
          ? await createPagePromise
          : await Promise.race([
              createPagePromise,
              this.waitForTargetDetached(targetId).then(() => {
                throw new Error("Target closed");
              })
            ]);
      } catch (error) {
        const hasPendingSyntheticPopup = options.openerTargetId
          ? this.hasPendingSyntheticPopup(options.openerTargetId)
          : false;
        const shouldCreateClosedPopupFallback =
          options.emitPage &&
          Boolean(options.openerTargetId) &&
          (hasPendingSyntheticPopup || options.hasWindowOpener === true) &&
          isPageClosedInitializationError(error);

        if (!shouldCreateClosedPopupFallback && (!options.emitPage || options.client)) {
          throw error;
        }
        if (!shouldCreateClosedPopupFallback && options.client) {
          throw error;
        }
        page = createTransientClosedPageAdapter(options.fallbackUrl ?? "about:blank");
      }
      const pageWithMetadata = page as ProtocolPageAdapter & {
        __roxyOpenerTargetId?: string | null;
        __roxyTargetId?: string;
      };
      this.initializingPages.delete(targetId);
      pageWithMetadata.__roxyTargetId = targetId;
      pageWithMetadata.__roxyOpenerTargetId = options.openerTargetId ?? null;
      if (options.openerTargetId) {
        this.cancelNextSyntheticPopup(options.openerTargetId);
      }
      if (this.requestInterceptionEnabled) {
        await page.setRequestInterceptor?.(this.requestInterceptor);
      }
      for (const entry of this.initScripts) {
        if (entry.disposablesByPage.has(page)) {
          continue;
        }
        try {
          const disposable = await page.addInitScript(entry.source);
          entry.disposablesByPage.set(page, disposable);
        } catch (error) {
          if (isPageClosedInitializationError(error)) {
            break;
          }
          throw error;
        }
      }
      this.pages.set(targetId, page);

      if (options.emitPage && !this.creatingPageTargetIds.has(targetId)) {
        const opener = options.openerTargetId
          ? await this.resolveKnownPage(options.openerTargetId)
          : null;
        await this.emitPage(page, opener, options.hasWindowOpener ?? true);
      }
      this.creatingPageTargetIds.delete(targetId);

      return page;
    })();

    this.pendingPages.set(targetId, pagePromise);
    try {
      return await pagePromise;
    } finally {
      if (this.pendingPages.get(targetId) === pagePromise) {
        this.pendingPages.delete(targetId);
      }
    }
  }

  private async resolveKnownPage(targetId: string): Promise<ProtocolPageAdapter | null> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const existing = this.pages.get(targetId);
      if (existing) {
        return existing;
      }

      const pending = this.pendingPages.get(targetId);
      if (pending) {
        try {
          return await pending;
        } catch {
          return null;
        }
      }

      if (attempt < 19) {
        await delay(5);
      }
    }

    if (DEBUG_POPUP_RESOLVE) {
      console.error(
        "[roxy-popup-resolve] missing",
        JSON.stringify({
          targetId,
          pageKeys: Array.from(this.pages.keys()),
          pendingKeys: Array.from(this.pendingPages.keys())
        })
      );
    }

    return null;
  }

  private async emitPage(
    page: ProtocolPageAdapter,
    opener: ProtocolPageAdapter | null,
    hasWindowOpener: boolean
  ): Promise<void> {
    for (const listener of Array.from(this.pageListeners)) {
      await listener(page, opener, hasWindowOpener);
    }
  }

  private queueSyntheticPopup(openerTargetId: string, url: string): void {
    if (this.consumeRecentlyAttachedPopup(openerTargetId)) {
      return;
    }
    const queue = this.pendingSyntheticPopupsByOpener.get(openerTargetId) ?? [];
    const entry = {
      timer: setTimeout(() => {
        void this.emitSyntheticPopup(openerTargetId, url);
      }, 500),
      url
    };
    queue.push(entry);
    this.pendingSyntheticPopupsByOpener.set(openerTargetId, queue);
  }

  private cancelNextSyntheticPopup(openerTargetId: string): void {
    const queue = this.pendingSyntheticPopupsByOpener.get(openerTargetId);
    if (!queue?.length) {
      return;
    }
    const entry = queue.shift();
    if (entry) {
      clearTimeout(entry.timer);
    }
    if (queue.length === 0) {
      this.pendingSyntheticPopupsByOpener.delete(openerTargetId);
    }
  }

  private hasPendingSyntheticPopup(openerTargetId: string): boolean {
    return (this.pendingSyntheticPopupsByOpener.get(openerTargetId)?.length ?? 0) > 0;
  }

  private async emitSyntheticPopup(openerTargetId: string, url: string): Promise<void> {
    const queue = this.pendingSyntheticPopupsByOpener.get(openerTargetId);
    if (queue?.length) {
      queue.shift();
      if (queue.length === 0) {
        this.pendingSyntheticPopupsByOpener.delete(openerTargetId);
      }
    }
    if (this.closing) {
      return;
    }
    const opener = await this.resolveKnownPage(openerTargetId);
    if (!opener) {
      return;
    }
    const page = createTransientClosedPageAdapter(url) as ProtocolPageAdapter & {
      __roxyOpenerTargetId?: string | null;
      __roxyTargetId?: string;
    };
    page.__roxyTargetId = `synthetic-popup:${openerTargetId}:${Date.now()}`;
    page.__roxyOpenerTargetId = openerTargetId;
    await this.emitPage(page, opener, true);
  }

  private waitForTargetDetached(targetId: string): Promise<void> {
    if (this.detachedTargetIds.has(targetId)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const waiters = this.pendingTargetDetachWaiters.get(targetId) ?? new Set<() => void>();
      const done = () => {
        waiters.delete(done);
        if (waiters.size === 0) {
          this.pendingTargetDetachWaiters.delete(targetId);
        }
        resolve();
      };
      waiters.add(done);
      this.pendingTargetDetachWaiters.set(targetId, waiters);
    });
  }

  private markTargetDetached(targetId: string): void {
    this.detachedTargetIds.add(targetId);
    const waiters = this.pendingTargetDetachWaiters.get(targetId);
    if (!waiters) {
      return;
    }
    this.pendingTargetDetachWaiters.delete(targetId);
    for (const waiter of waiters) {
      waiter();
    }
  }

  private noteAttachedPopup(openerTargetId: string): void {
    const now = Date.now();
    const queue = this.recentAttachedPopupsByOpener.get(openerTargetId) ?? [];
    queue.push(now);
    this.recentAttachedPopupsByOpener.set(
      openerTargetId,
      queue.filter((timestamp) => now - timestamp <= POPUP_ATTACH_MATCH_WINDOW_MS)
    );
  }

  private consumeRecentlyAttachedPopup(openerTargetId: string): boolean {
    const now = Date.now();
    const queue = (this.recentAttachedPopupsByOpener.get(openerTargetId) ?? [])
      .filter((timestamp) => now - timestamp <= POPUP_ATTACH_MATCH_WINDOW_MS);
    if (!queue.length) {
      this.recentAttachedPopupsByOpener.delete(openerTargetId);
      return false;
    }
    queue.shift();
    if (queue.length) {
      this.recentAttachedPopupsByOpener.set(openerTargetId, queue);
    } else {
      this.recentAttachedPopupsByOpener.delete(openerTargetId);
    }
    return true;
  }
}

function isPageClosedInitializationError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes("target page, context or browser has been closed")
    || message.includes("target closed")
    || message.includes("session closed")
    || message.includes("connection closed")
  );
}

function isClosedCdpConnectionError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes("target page, context or browser has been closed")
    || message.includes("target closed")
    || message.includes("session closed")
    || message.includes("session with given id not found")
    || message.includes("connection closed")
    || message.includes("websocket is not open")
  );
}

function createTransientClosedPageAdapter(url: string): ProtocolPageAdapter {
  const closedError = () => new Error("Target page, context or browser has been closed");
  const asyncClosed = async <T>(): Promise<T> => {
    throw closedError();
  };
  const syncClosed = () => {
    throw closedError();
  };
  const createClosedHandle = (
    reference: ProtocolElementHandleReference
  ): ProtocolElementHandleAdapter => ({
    reference: () => reference,
    query: asyncClosed,
    queryAll: asyncClosed,
    evalOnSelector: asyncClosed,
    evalOnSelectorAll: asyncClosed,
    evaluate: asyncClosed,
    evaluateHandle: asyncClosed,
    boundingBox: asyncClosed,
    dispatchEvent: asyncClosed,
    screenshot: asyncClosed,
    scrollIntoViewIfNeeded: asyncClosed,
    selectText: asyncClosed,
    tap: asyncClosed,
    click: asyncClosed,
    dblclick: asyncClosed,
    check: asyncClosed,
    hover: asyncClosed,
    fill: asyncClosed,
    type: asyncClosed,
    press: asyncClosed,
    textContent: asyncClosed,
    innerText: asyncClosed,
    innerHTML: asyncClosed,
    getAttribute: asyncClosed,
    inputValue: asyncClosed,
    isChecked: asyncClosed,
    isDisabled: asyncClosed,
    isEditable: asyncClosed,
    isEnabled: asyncClosed,
    isHidden: asyncClosed,
    isVisible: asyncClosed,
    focus: asyncClosed,
    uncheck: asyncClosed,
    selectOption: asyncClosed
  });

  return {
    goto: asyncClosed,
    url: () => url,
    goBack: asyncClosed,
    goForward: asyncClosed,
    reload: asyncClosed,
    title: async () => "",
    content: async () => "",
    setContent: asyncClosed,
    addInitScript: asyncClosed,
    evaluate: asyncClosed,
    addScriptTag: asyncClosed,
    addStyleTag: asyncClosed,
    waitForLoadState: async () => {},
    ariaSnapshot: asyncClosed,
    resolveAriaRef: asyncClosed,
    setExtraHTTPHeaders: async () => {},
    screenshot: asyncClosed,
    pdf: asyncClosed,
    viewportSize: () => null,
    setViewportSize: asyncClosed,
    dispatchEvent: asyncClosed,
    requestGC: asyncClosed,
    textContent: asyncClosed,
    innerText: asyncClosed,
    innerHTML: asyncClosed,
    getAttribute: asyncClosed,
    inputValue: asyncClosed,
    isChecked: asyncClosed,
    isDisabled: asyncClosed,
    isEditable: asyncClosed,
    isEnabled: asyncClosed,
    focus: asyncClosed,
    setChecked: asyncClosed,
    selectOption: asyncClosed,
    bringToFront: asyncClosed,
    isClosed: () => true,
    on: () => () => {},
    createHandle: createClosedHandle,
    createHandleReference: async (reference) => reference,
    evaluateOnReference: asyncClosed,
    evaluateOnReferenceAll: asyncClosed,
    query: async () => null,
    queryAll: async () => [],
    evalOnSelector: asyncClosed,
    evalOnSelectorAll: asyncClosed,
    locator: syncClosed,
    getByText: syncClosed,
    getByAltText: syncClosed,
    getByLabel: syncClosed,
    getByPlaceholder: syncClosed,
    getByTestId: syncClosed,
    getByRole: syncClosed,
    getByTitle: syncClosed,
    startCSSCoverage: asyncClosed,
    startJSCoverage: asyncClosed,
    stopCSSCoverage: asyncClosed,
    stopJSCoverage: asyncClosed,
    screencastStart: asyncClosed,
    screencastStop: asyncClosed,
    screencastShowActions: asyncClosed,
    screencastHideActions: asyncClosed,
    screencastShowOverlay: asyncClosed,
    screencastRemoveOverlay: asyncClosed,
    screencastChapter: asyncClosed,
    screencastSetOverlayVisible: asyncClosed,
    keyboardDown: asyncClosed,
    keyboardInsertText: asyncClosed,
    keyboardPress: asyncClosed,
    keyboardType: asyncClosed,
    keyboardUp: asyncClosed,
    mouseClick: asyncClosed,
    mouseDblclick: asyncClosed,
    mouseDown: asyncClosed,
    mouseMove: asyncClosed,
    mouseUp: asyncClosed,
    mouseWheel: asyncClosed,
    touchscreenTap: asyncClosed,
    tap: asyncClosed,
    close: async (_options?: PageCloseOptions) => {}
  };
}

class CdpPointerActionScheduler {
  private queue = Promise.resolve();

  async enqueue<TResult>(action: () => Promise<TResult>): Promise<TResult> {
    const run = this.queue.then(action, action);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

class CdpPageAdapter implements ProtocolPageAdapter {
  private readonly closePromise: Promise<void>;
  private resolveClosePromise!: () => void;
  private closePromiseResolved = false;
  private mainFrameId: string | undefined;
  private readonly defaultExecutionContextByFrameId = new Map<string, number>();
  private readonly defaultExecutionContextSessionByFrameId = new Map<string, string | undefined>();
  private readonly workersByTargetId = new Map<string, {
    delegate: CdpWorkerDelegate;
    sessionId: string;
    worker: RoxyWorker;
  }>();
  private readonly pendingDefaultExecutionContextWaiters = new Map<
    string,
    Set<{
      reject: (error: Error) => void;
      resolve: (contextId: number) => void;
      timer: ReturnType<typeof setTimeout>;
    }>
  >();
  private readonly frameSessionIds = new Map<string, string>();
  private readonly nativeFrames = new Map<string, CdpNativeFrameState>();
  private readonly frameLifecycleStates = new Map<string, {
    domContentLoaded: boolean;
    loadFired: boolean;
  }>();
  private readonly loadingFrameIds = new Set<string>();
  private pendingRunBeforeUnloadCloseCount = 0;
  private currentUrl = "about:blank";
  private domContentLoaded = false;
  private loadFired = false;
  private networkIdleReached = false;
  private sameDocumentNavigation = false;
  private allowSameDocumentNavigationToResolveWaiters = false;
  private activeRequests = 0;
  private closed = false;
  private closeReason: string | undefined;
  private networkIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private currentViewportSize: ViewportSize | null = null;
  private currentMousePosition: ActionPoint = { x: 0, y: 0 };
  private lastMouseButton: MouseButton | "none" = "none";
  private readonly pressedMouseButtons = new Set<MouseButton>();
  private readonly pressedKeyboardModifiers = new Set<string>();
  private readonly pressedKeyboardCodes = new Set<string>();
  private pointerActionModifiers: Set<string> | null = null;
  private readonly jsCoverageState: CdpJsCoverageState = {
    enabled: false,
    eventListeners: [],
    reportAnonymousScripts: false,
    resetOnNavigation: true,
    scriptIds: new Set(),
    scriptSources: new Map()
  };
  private readonly cssCoverageState: CdpCssCoverageState = {
    enabled: false,
    eventListeners: [],
    resetOnNavigation: true,
    stylesheetSources: new Map(),
    stylesheetUrls: new Map()
  };
  private screencastActionOptions: ScreencastActionOptions | null = null;
  private screencastActionAnnotation: ScreencastActionAnnotationState | null = null;
  private screencastActionAbortController: AbortController | null = null;
  private screencastSession: CdpScreencastSessionState | null = null;
  private screencastOverlaysVisible = true;
  private screencastOverlayId = 0;
  private readonly screencastOverlays = new Map<string, CdpScreencastOverlayState>();
  private readonly stateWaiters = new Set<StateWaiter>();
  private readonly eventListeners = new Map<RawPageEventName, Set<RawPageEventListener<RawPageEventName>>>();
  private popupFallbackBindingInstalled = false;
  private readonly fileChooserOpenedListeners = new Set<(payload: {
    element: ProtocolElementHandleReference;
    frameId: string | null;
    isMultiple: boolean;
  }) => void | Promise<void>>();
  private readonly earlyEvents = new Map<
    "dialog" | "request" | "response" | "requestfinished" | "requestfailed",
    Array<
      | RawPageEventMap["dialog"]
      | RawPageEventMap["request"]
      | RawPageEventMap["response"]
      | RawPageEventMap["requestfailed"]
    >
  >();
  private readonly requestMetadata = new Map<
    string,
    {
      frameId?: string;
      isFavicon?: boolean;
      isNavigationRequest?: boolean;
      isPreflight?: boolean;
      method: string;
      responseStatus?: number;
      type?: string;
      url: string;
    }
  >();
  private readonly pendingResponseEvents = new Map<
    string,
    Array<{
      event: {
        frameId?: string;
        requestId: string;
        response: {
          fromDiskCache?: boolean;
          fromServiceWorker?: boolean;
          fromPrefetchCache?: boolean;
          headers: Record<string, string | number | boolean>;
          mimeType: string;
          status: number;
          statusText: string;
          url: string;
        };
        type?: string;
      };
    }>
  >();
  private readonly pendingResponseFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly servedFromCacheRequestIds = new Set<string>();
  private readonly pendingRequestEvents = new Map<string, CdpPendingRequestEvent[]>();
  private readonly requestExtraInfoHeaders = new Map<
    string,
    Array<Array<{ name: string; value: string }>>
  >();
  private readonly responseExtraInfoHeaders = new Map<
    string,
    Array<Array<{ name: string; value: string }>>
  >();
  private readonly responseExtraInfoDiscardCounts = new Map<string, number>();
  private readonly fulfilledDocumentResponseHeaders = new Map<
    string,
    Array<{ name: string; value: string }>
  >();
  private readonly fulfilledRequestIds = new Set<string>();
  private readonly failedRouteErrorTexts = new Map<string, string>();
  private readonly ignoredRequestIds = new Set<string>();
  private readonly pausedFetchRequestIds = new Set<string>();
  private readonly continuedRequestHeaders = new Map<string, Array<{ name: string; value: string }>>();
  private readonly continuedRequestUrls = new Map<string, string>();
  private readonly responseBodies = new Map<string, ResponseBodyState>();
  private readonly responseBodyRequestIds = new Map<string, string>();
  private readonly workerRequestAliases = new Map<string, string>();
  private readonly frameNetworkIdleStates = new Map<string, CdpFrameNetworkIdleState>();
  private readonly navigationResponseCaptures = new Set<NavigationResponseCapture>();
  private readonly navigationFailureCaptures = new Set<NavigationFailureCapture>();
  private pageExtraHTTPHeaders: Record<string, string> | undefined;
  private requestInterceptor: ((call: RoutedRequestCall) => Promise<RoutedRequestDecision>) | null = null;
  private requestInterceptionEnabled = false;

  private scopedWorkerRequestId(sessionId: string, requestId: string): string {
    return `${sessionId}:${requestId}`;
  }

  private adoptWorkerRequestMetadata(
    sessionId: string,
    requestId: string
  ): {
    scopedRequestId: string;
    metadata: {
      frameId?: string;
      isFavicon?: boolean;
      isNavigationRequest?: boolean;
      isPreflight?: boolean;
      method: string;
      responseStatus?: number;
      type?: string;
      url: string;
    } | undefined;
  } {
    const scopedRequestId = this.scopedWorkerRequestId(sessionId, requestId);
    const existing = this.requestMetadata.get(scopedRequestId);
    if (existing) {
      return {
        scopedRequestId,
        metadata: existing
      };
    }

    const unscoped = this.requestMetadata.get(requestId);
    if (!unscoped) {
      return {
        scopedRequestId,
        metadata: undefined
      };
    }

    this.requestMetadata.set(scopedRequestId, unscoped);
    this.requestMetadata.delete(requestId);
    return {
      scopedRequestId,
      metadata: unscoped
    };
  }

  private synthesizeWorkerRedirectRequest(
    sessionId: string,
    workerFrameId: string | undefined,
    requestId: string,
    request: {
      headers?: Record<string, string | number | boolean>;
      method: string;
      postData?: string;
      postDataEntries?: Array<{ bytes?: string }>;
      url: string;
    },
    type: string | undefined,
    previousUrl: string
  ): string {
    const redirectedRequestId =
      `${this.scopedWorkerRequestId(sessionId, requestId)}:redirect-target:${request.url}`;
    this.requestMetadata.set(redirectedRequestId, {
      ...(workerFrameId ? { frameId: workerFrameId } : {}),
      isNavigationRequest: false,
      method: request.method,
      ...(type ? { type } : {}),
      url: request.url
    });
    this.queueRequestEvent(redirectedRequestId, {
      headers: request.headers ? mapCdpHeaders(request.headers) : [],
      ...(workerFrameId ? { frameId: workerFrameId } : {}),
      isNavigationRequest: false,
      method: request.method,
      ...(request.postData !== undefined ? { postData: request.postData } : {}),
      ...postDataBufferFieldsFromCdpEntries(request.postDataEntries),
      requestId: redirectedRequestId,
      resourceType: toPlaywrightResourceType(type),
      url: request.url
    });
    this.flushPendingRequestEvent(redirectedRequestId);
    this.continuedRequestUrls.set(redirectedRequestId, request.url);
    return redirectedRequestId;
  }

  private resolveWorkerRequestIdAlias(requestId: string): string {
    let resolved = requestId;
    const visited = new Set<string>();
    while (!visited.has(resolved)) {
      visited.add(resolved);
      const alias = this.workerRequestAliases.get(resolved);
      if (!alias) {
        break;
      }
      resolved = alias;
    }
    return resolved;
  }

  private aliasWorkerRequest(
    sourceRequestId: string,
    targetRequestId: string,
    sessionId: string,
    frameId: string | undefined
  ): void {
    if (sourceRequestId === targetRequestId) {
      return;
    }
    this.workerRequestAliases.set(sourceRequestId, targetRequestId);
    this.responseBodyRequestIds.set(targetRequestId, this.responseBodyRequestIds.get(sourceRequestId) ?? sourceRequestId);
    const sourceState = this.responseBodies.get(sourceRequestId);
    if (sourceState) {
      const targetState = this.ensureResponseBodyState(targetRequestId);
      if (sourceState.body) {
        targetState.body = sourceState.body;
      }
      if (targetState.expectedLength === undefined && sourceState.expectedLength !== undefined) {
        targetState.expectedLength = sourceState.expectedLength;
      }
      if (!targetState.failure && sourceState.failure) {
        targetState.failure = sourceState.failure;
      }
      const resolvedFrameId = sourceState.frameId ?? frameId;
      if (!targetState.frameId && resolvedFrameId) {
        targetState.frameId = resolvedFrameId;
      }
      if (!targetState.fulfilledBody && sourceState.fulfilledBody) {
        targetState.fulfilledBody = sourceState.fulfilledBody;
      }
      if (!targetState.sessionId) {
        targetState.sessionId = sourceState.sessionId ?? sessionId;
      }
      if (!targetState.url && sourceState.url) {
        targetState.url = sourceState.url;
      }
      if (sourceState.failure) {
        targetState.markFailed(sourceState.failure);
      } else {
        sourceState.ready.then(() => {
          targetState.resolveReady();
        }).catch((error: unknown) => {
          targetState.markFailed(error instanceof Error ? error : new Error(String(error)));
        });
      }
    }
  }

  private remapWorkerRequestToScopedId(
    sessionId: string,
    requestId: string,
    frameId: string | undefined
  ): {
    scopedRequestId: string;
    metadata: {
      frameId?: string;
      isFavicon?: boolean;
      isNavigationRequest?: boolean;
      isPreflight?: boolean;
      method: string;
      responseStatus?: number;
      type?: string;
      url: string;
    } | undefined;
  } {
    const { scopedRequestId, metadata } = this.adoptWorkerRequestMetadata(sessionId, requestId);
    const resolvedRequestId = this.resolveWorkerRequestIdAlias(scopedRequestId);
    if (resolvedRequestId !== scopedRequestId) {
      this.aliasWorkerRequest(scopedRequestId, resolvedRequestId, sessionId, frameId);
      return {
        scopedRequestId: resolvedRequestId,
        metadata: this.requestMetadata.get(resolvedRequestId) ?? metadata
      };
    }
    return {
      scopedRequestId,
      metadata
    };
  }

  static async create(options: {
    browserClient: CdpClient;
    client: CdpClient;
    targetId: string;
    contextOptions: BrowserContextOptions;
    contextInitScripts?: CdpContextInitScriptRegistration[];
    initialRequestInterceptor?: ((call: RoutedRequestCall) => Promise<RoutedRequestDecision>) | null;
    suppressClosedInitScriptErrors?: boolean;
    onWindowOpenFallback?: (url: string) => void;
    onPageConstructed?: (page: CdpPageAdapter) => void;
    pointerActionScheduler: CdpPointerActionScheduler;
    initialNavigationFrameUnavailable?: boolean;
    resumeOnInitialized?: () => Promise<void>;
    onClosed: (targetId: string) => void;
  }): Promise<CdpPageAdapter> {
    const page = new CdpPageAdapter(options);
    options.onPageConstructed?.(page);
    try {
      await Promise.race([
        page.initialize(),
        page.closePromise.then(() => {
          throw page.createClosedError();
        })
      ]);
    } catch (error) {
      if (page.closed && isPageClosedInitializationError(error)) {
        throw error;
      }
      throw error;
    }
    return page;
  }

  private constructor(
    private readonly options: {
      browserClient: CdpClient;
      client: CdpClient;
      targetId: string;
      contextOptions: BrowserContextOptions;
      contextInitScripts?: CdpContextInitScriptRegistration[];
      initialRequestInterceptor?: ((call: RoutedRequestCall) => Promise<RoutedRequestDecision>) | null;
      suppressClosedInitScriptErrors?: boolean;
      onWindowOpenFallback?: (url: string) => void;
      onPageConstructed?: (page: CdpPageAdapter) => void;
      pointerActionScheduler: CdpPointerActionScheduler;
      initialNavigationFrameUnavailable?: boolean;
      resumeOnInitialized?: () => Promise<void>;
      onClosed: (targetId: string) => void;
    }
  ) {
    this.requestInterceptor = options.initialRequestInterceptor ?? null;
    this.requestInterceptionEnabled = Boolean(options.initialRequestInterceptor);
    this.closePromise = new Promise<void>((resolve) => {
      this.resolveClosePromise = resolve;
    });
  }

  didClose(): void {
    if (this.closed) {
      this.resolveCloseSignal();
      return;
    }

    this.closed = true;
    if (this.jsCoverageState.enabled) {
      void this.stopJSCoverage().catch(() => {});
    }
    if (this.cssCoverageState.enabled) {
      void this.stopCSSCoverage().catch(() => {});
    }
    if (this.screencastSession) {
      void this.screencastStop().catch(() => {});
    }
    this.resetScreencastActions();
    for (const overlay of this.screencastOverlays.values()) {
      if (overlay.removeTimer) {
        clearTimeout(overlay.removeTimer);
      }
    }
    this.screencastOverlays.clear();
    this.clearNetworkIdleTimer();
    this.rejectWaiters(this.createClosedError());
    this.emit("close", undefined);
    this.resolveCloseSignal();
    this.options.onClosed(this.options.targetId);
  }

  private async initialize(): Promise<void> {
    const { client } = this.options;
    const initializeCommand = async (command: Promise<unknown> | undefined) => {
      if (!command) {
        return;
      }
      await command;
    };

    client.Page.domContentEventFired(() => {
      this.domContentLoaded = true;
      if (this.mainFrameId) {
        this.updateFrameLifecycleState(this.mainFrameId, {
          domContentLoaded: true
        });
      }
      this.flushWaiters();
      this.emit("domcontentloaded", undefined);
      void this.syncCurrentUrlFromDocument();
      void this.renderScreencastActions();
      void this.renderScreencastOverlays();
    });

    client.Page.navigatedWithinDocument((event) => {
      this.currentUrl = event.url ?? this.currentUrl;
      void this.syncCurrentUrlFromDocument();
      this.updateFrameLifecycleState(event.frameId, {
        domContentLoaded: true,
        loadFired: true
      });
      this.emit("framenavigated", {
        frameId: event.frameId,
        ...(event.frameId === this.mainFrameId ? { parentFrameId: null } : {}),
        url: event.url
      });
      this.sameDocumentNavigation = true;
      this.domContentLoaded = true;
      this.loadFired = true;
      this.networkIdleReached = true;
      void this.renderScreencastActions();
      void this.renderScreencastOverlays();
      if (this.allowSameDocumentNavigationToResolveWaiters) {
        this.flushWaiters();
      }
    });

    client.Page.javascriptDialogOpening((event) => {
      this.emit(
        "dialog",
        this.createDialogPayload({
          defaultValue: event.defaultPrompt ?? "",
          message: event.message,
          page: () => null,
          type: event.type
        })
      );
    });
    client.on("Runtime.bindingCalled", (event: {
      executionContextId?: number;
      name?: string;
      payload?: string;
    }) => {
      if (event.name !== POPUP_FALLBACK_BINDING_NAME || !event.payload) {
        return;
      }
      try {
        const payload = JSON.parse(event.payload) as { url?: string };
        this.options.onWindowOpenFallback?.(payload.url ?? "about:blank");
      } catch {
        this.options.onWindowOpenFallback?.("about:blank");
      }
    });

    client.Page.frameNavigated((event) => {
      this.upsertNativeFrame(event.frame);
      this.loadingFrameIds.add(event.frame.id);
      const existingNetworkIdleState = this.frameNetworkIdleStates.get(event.frame.id);
      this.clearFrameNetworkIdleTimer(event.frame.id);
      this.frameNetworkIdleStates.set(event.frame.id, {
        activeRequests: existingNetworkIdleState?.activeRequests ?? 0,
        idleReached: false,
        idleTimer: undefined
      });
      this.updateFrameLifecycleState(event.frame.id, {
        domContentLoaded: false,
        loadFired: false
      });
      this.loadFired = false;
      if (!event.frame.parentId) {
        this.domContentLoaded = false;
        this.networkIdleReached = false;
        this.sameDocumentNavigation = false;
        this.allowSameDocumentNavigationToResolveWaiters = false;
        this.clearNetworkIdleTimer();
        this.clearScreencastActionAnnotation();
        this.rejectInterruptedNavigationFailureCapturesForCommittedNavigation(
          event.frame.loaderId,
          event.frame.url
        );
        this.mainFrameId = event.frame.id;
        this.currentUrl = event.frame.url ?? this.currentUrl;
        void this.syncCurrentUrlFromDocument();
      }
      this.emit("framenavigated", {
        frameId: event.frame.id,
        parentFrameId: event.frame.parentId ?? null,
        url: event.frame.url
      });

      if (event.type === "BackForwardCacheRestore") {
        this.domContentLoaded = true;
        this.loadFired = true;
        this.networkIdleReached = true;
        this.flushWaiters();
      }
    });

    client.Page.lifecycleEvent?.((event: {
      frameId: string;
      name: string;
    }) => {
      if (event.name === "DOMContentLoaded" && this.isMainFrameId(event.frameId)) {
        this.domContentLoaded = true;
      }
      if (event.name === "DOMContentLoaded") {
        this.updateFrameLifecycleState(event.frameId, {
          domContentLoaded: true
        });
      }
      if (event.name === "load") {
        this.loadingFrameIds.delete(event.frameId);
        this.updateFrameLifecycleState(event.frameId, {
          loadFired: true
        });
        this.loadFired = this.loadingFrameIds.size === 0;
        this.maybeArmFrameNetworkIdleTimer(event.frameId);
        this.maybeArmNetworkIdleTimer();
      }
      this.flushWaiters();
    });

    client.Page.frameAttached?.((event: {
      frameId: string;
      parentFrameId?: string;
    }) => {
      this.nativeFrames.set(event.frameId, {
        id: event.frameId,
        name: this.nativeFrames.get(event.frameId)?.name ?? "",
        parentId: event.parentFrameId ?? null,
        url: this.nativeFrames.get(event.frameId)?.url ?? "about:blank"
      });
      this.emit("frameattached", undefined);
    });

    client.Page.fileChooserOpened?.((event: {
      backendNodeId?: number;
      frameId: string;
      mode: "selectSingle" | "selectMultiple";
    }) => {
      if (!event.backendNodeId || !this.fileChooserOpenedListeners.size) {
        return;
      }
      void this.handleFileChooserOpened(event);
    });

    client.Page.frameStartedLoading?.((event: { frameId: string }) => {
      this.loadingFrameIds.add(event.frameId);
      this.updateFrameLifecycleState(event.frameId, {
        domContentLoaded: false,
        loadFired: false
      });
      this.networkIdleReached = false;
      this.clearNetworkIdleTimer();
    });

    client.Page.frameDetached?.((event: { frameId: string; reason?: "remove" | "swap" }) => {
      if (event.reason === "swap") {
        return;
      }
      this.loadingFrameIds.delete(event.frameId);
      this.frameLifecycleStates.delete(event.frameId);
      this.settleRequestsForDetachedFrame(event.frameId);
      this.frameSessionIds.delete(event.frameId);
      this.removeNativeFrame(event.frameId);
      this.emit("framedetached", { frameId: event.frameId });
      this.flushWaiters();
    });

    client.Target?.attachedToTarget?.((event: {
      sessionId: string;
      targetInfo: {
        parentFrameId?: string;
        targetId: string;
        type: string;
        url?: string;
      };
    }) => {
      if (event.targetInfo.type === "worker") {
        const workerClient = createSessionTargetClient(this.options.browserClient, event.sessionId);
        const delegate = new CdpWorkerDelegate(this, workerClient, event.sessionId, event.targetInfo.url ?? "");
        const worker = new RoxyWorker(
          event.targetInfo.url ?? "",
          delegate
        );
        const workerFrameId = event.targetInfo.parentFrameId ?? this.mainFrameId ?? undefined;
        this.workersByTargetId.set(event.targetInfo.targetId, {
          delegate,
          sessionId: event.sessionId,
          worker
        });
        this.emit("worker", worker);
        workerClient.on("Runtime.consoleAPICalled", (params: unknown) => {
          const consoleEvent = params as {
            args: CdpRemoteObject[];
            stackTrace?: {
              callFrames?: Array<{
                columnNumber?: number;
                lineNumber?: number;
                url?: string;
              }>;
            };
            timestamp?: number;
            type: RawPageEventMap["console"]["type"] extends () => infer T ? T : string;
          };
          const args = consoleEvent.args.map((arg) =>
            createCdpConsoleHandle(this, arg, event.sessionId)
          );
          const message: RawPageEventMap["console"] = {
            args: () => args,
            location: () => consoleStackTraceLocation(consoleEvent.stackTrace, event.targetInfo.url ?? ""),
            page: () => null,
            text: () => args.map((arg) => String(arg)).join(" "),
            timestamp: () => normalizeConsoleTimestamp(consoleEvent.timestamp),
            type: () => consoleEvent.type,
            worker: () => worker
          };
          this.emit("console", message);
        });
        workerClient.on("Runtime.exceptionThrown", (params: unknown) => {
          const exceptionEvent = params as {
            exceptionDetails: CdpExceptionDetails;
          };
          this.emit("pageerror", exceptionToError(exceptionEvent.exceptionDetails));
        });
        workerClient.on("Network.requestWillBeSent", (params: unknown) => {
          const requestEvent = params as {
            redirectResponse?: {
              fromDiskCache?: boolean;
              fromPrefetchCache?: boolean;
              fromServiceWorker?: boolean;
              headers: Record<string, string | number | boolean>;
              mimeType: string;
              status: number;
              statusText: string;
              url: string;
            };
            initiator?: { type?: string };
            loaderId?: string;
            request: {
              headers: Record<string, string | number | boolean>;
              method: string;
              postData?: string;
              postDataEntries?: Array<{ bytes?: string }>;
              url: string;
            };
            requestId: string;
            type?: string;
          };
	          if (requestEvent.request.url.startsWith("data:")) {
	            this.ignoredRequestIds.add(requestEvent.requestId);
	            return;
	          }
	          if (isNetworkIdleIgnoredRequestUrl(requestEvent.request.url)) {
	            return;
	          }
	          const pageOwnedRequest = this.requestMetadata.get(requestEvent.requestId);
          if (
            pageOwnedRequest
            && !requestEvent.redirectResponse
            && pageOwnedRequest.url === requestEvent.request.url
          ) {
            return;
          }
          const scopedRequestId = this.scopedWorkerRequestId(event.sessionId, requestEvent.requestId);
          const previousRequest = this.requestMetadata.get(scopedRequestId);
          if (requestEvent.redirectResponse) {
            if (!previousRequest) {
              const redirectRequestId =
                `${scopedRequestId}:redirect:${requestEvent.redirectResponse.url}`;
              this.queueRequestEvent(redirectRequestId, {
                headers: mapCdpHeaders(requestEvent.request.headers),
                ...(workerFrameId ? { frameId: workerFrameId } : {}),
                isNavigationRequest: false,
                method: requestEvent.request.method,
                requestId: redirectRequestId,
                resourceType: toPlaywrightResourceType(requestEvent.type),
                url: requestEvent.redirectResponse.url
              });
              this.flushPendingRequestEvent(redirectRequestId);
              this.emitRedirectResponse({
                ...requestEvent,
                ...(workerFrameId ? { frameId: workerFrameId } : {}),
                requestId: redirectRequestId
              }, requestEvent.redirectResponse);
            } else {
              this.flushPendingRequestEvent(scopedRequestId);
              this.emitRedirectResponse({
                ...requestEvent,
                ...(workerFrameId ? { frameId: workerFrameId } : {})
              }, requestEvent.redirectResponse);
            }
            this.discardNextResponseExtraInfo(scopedRequestId);
          }
          const continuedHeaders = requestEvent.redirectResponse
            ? this.continuedRequestHeaders.get(scopedRequestId)
            : undefined;
          const requestHeaders = continuedHeaders
            ? applyCdpHeaderOverrides(normalizeHeaderRecord(requestEvent.request.headers), continuedHeaders)
            : mapCdpHeaders(requestEvent.request.headers);
	          this.activeRequests += 1;
	          this.networkIdleReached = false;
	          this.clearNetworkIdleTimer();
	          if (workerFrameId) {
	            this.markFrameNetworkBusy(workerFrameId);
	          }
	          this.requestMetadata.set(scopedRequestId, {
            ...(workerFrameId ? { frameId: workerFrameId } : {}),
            isNavigationRequest: false,
            method: requestEvent.request.method,
            ...(requestEvent.type ? { type: requestEvent.type } : {}),
            url: requestEvent.request.url
          });
          this.queueRequestEvent(scopedRequestId, {
            headers: requestHeaders,
            ...(workerFrameId ? { frameId: workerFrameId } : {}),
            isNavigationRequest: false,
            method: requestEvent.request.method,
            ...(requestEvent.request.postData !== undefined ? { postData: requestEvent.request.postData } : {}),
            ...postDataBufferFieldsFromCdpEntries(requestEvent.request.postDataEntries),
            requestId: scopedRequestId,
            resourceType: toPlaywrightResourceType(requestEvent.type),
            url: requestEvent.request.url
          });
          this.flushPendingRequestEvent(scopedRequestId);
        });
        workerClient.on("Network.responseReceived", (params: unknown) => {
          const responseEvent = params as {
            request?: {
              headers: Record<string, string | number | boolean>;
              method: string;
              postData?: string;
              postDataEntries?: Array<{ bytes?: string }>;
              url: string;
            };
            requestId: string;
            response: {
              fromDiskCache?: boolean;
              fromPrefetchCache?: boolean;
              fromServiceWorker?: boolean;
              headers: Record<string, string | number | boolean>;
              mimeType: string;
              status: number;
              statusText: string;
              url: string;
            };
            type?: string;
          };
          const scopedRequestId = this.scopedWorkerRequestId(event.sessionId, responseEvent.requestId);
          let metadata = this.requestMetadata.get(scopedRequestId);
          const pageOwnedRequest = this.requestMetadata.get(responseEvent.requestId);
          let activeRequestId = scopedRequestId;
          let activeBodySourceRequestId = scopedRequestId;
          if (!metadata && pageOwnedRequest && pageOwnedRequest.url !== responseEvent.response.url) {
            this.emitRedirectResponse({
              request: {
                method: pageOwnedRequest.method
              },
              requestId: responseEvent.requestId,
              ...(pageOwnedRequest.frameId ? { frameId: pageOwnedRequest.frameId } : {}),
              ...(pageOwnedRequest.type ? { type: pageOwnedRequest.type } : {})
            }, {
              headers: {
                location: responseEvent.response.url
              },
              mimeType: responseEvent.response.mimeType,
              status: 302,
              statusText: "Found",
              url: pageOwnedRequest.url,
              ...(responseEvent.response.fromDiskCache !== undefined
                ? { fromDiskCache: responseEvent.response.fromDiskCache }
                : {}),
              ...(responseEvent.response.fromPrefetchCache !== undefined
                ? { fromPrefetchCache: responseEvent.response.fromPrefetchCache }
                : {})
            });
            activeRequestId = this.synthesizeWorkerRedirectRequest(
              event.sessionId,
              workerFrameId,
              responseEvent.requestId,
              {
                method: pageOwnedRequest.method,
                url: responseEvent.response.url
              },
              pageOwnedRequest.type,
              pageOwnedRequest.url
            );
            this.aliasWorkerRequest(scopedRequestId, activeRequestId, event.sessionId, workerFrameId);
            this.responseBodyRequestIds.set(activeRequestId, responseEvent.requestId);
            this.requestMetadata.delete(responseEvent.requestId);
            metadata = this.requestMetadata.get(activeRequestId);
          } else if (!metadata && pageOwnedRequest) {
            this.requestMetadata.set(scopedRequestId, pageOwnedRequest);
            this.requestMetadata.delete(responseEvent.requestId);
            metadata = pageOwnedRequest;
          }
          const bodyState = this.ensureResponseBodyState(activeRequestId);
          bodyState.sessionId = event.sessionId;
          if (workerFrameId) {
            bodyState.frameId = workerFrameId;
          }
          bodyState.url = responseEvent.response.url;
          const request = this.requestMetadata.get(activeRequestId) ?? metadata ?? this.requestMetadata.get(scopedRequestId);
          if (request) {
            request.responseStatus = responseEvent.response.status;
          }
          if (this.runAfterPendingRequestEvent(activeRequestId, () => {
            this.handleNetworkResponseReceived({
              ...responseEvent,
              requestId: activeRequestId,
              ...(workerFrameId ? { frameId: workerFrameId } : {})
            }, Boolean(responseEvent.response.fromDiskCache || responseEvent.response.fromPrefetchCache));
          })) {
            return;
          }
          this.handleNetworkResponseReceived({
            ...responseEvent,
            requestId: activeRequestId,
            ...(workerFrameId ? { frameId: workerFrameId } : {})
          }, Boolean(responseEvent.response.fromDiskCache || responseEvent.response.fromPrefetchCache));
        });
        workerClient.on("Network.loadingFinished", (params: unknown) => {
          const loadingFinished = params as { requestId: string };
          const { scopedRequestId, metadata } = this.remapWorkerRequestToScopedId(
            event.sessionId,
            loadingFinished.requestId,
            workerFrameId
          );
          this.flushPendingResponseEvent(scopedRequestId);
          const bodyState = this.ensureResponseBodyState(scopedRequestId);
          bodyState.sessionId = event.sessionId;
          bodyState.resolveReady();
          const request = metadata ?? this.requestMetadata.get(scopedRequestId);
          this.emit("requestfinished", {
            headers: [],
            ...(request?.frameId ? { frameId: request.frameId } : {}),
            isNavigationRequest: request?.isNavigationRequest ?? false,
            method: request?.method ?? "UNKNOWN",
            requestId: scopedRequestId,
            resourceType: toPlaywrightResourceType(request?.type),
            url: request?.url ?? "unknown://request"
          });
          this.activeRequests = Math.max(0, this.activeRequests - 1);
          this.flushPendingRequestEvent(scopedRequestId);
          this.requestExtraInfoHeaders.delete(scopedRequestId);
          this.responseExtraInfoDiscardCounts.delete(scopedRequestId);
          this.requestMetadata.delete(scopedRequestId);
          this.continuedRequestUrls.delete(scopedRequestId);
          this.workerRequestAliases.delete(this.scopedWorkerRequestId(event.sessionId, loadingFinished.requestId));
          this.maybeArmNetworkIdleTimer();
        });
        workerClient.on("Network.loadingFailed", (params: unknown) => {
          const loadingFailed = params as { errorText: string; requestId: string };
          const { scopedRequestId, metadata } = this.remapWorkerRequestToScopedId(
            event.sessionId,
            loadingFailed.requestId,
            workerFrameId
          );
          this.flushPendingResponseEvent(scopedRequestId);
          this.ensureResponseBodyState(scopedRequestId).markFailed(
            new Error(formatNavigationFailureMessage(loadingFailed.errorText || "Network loading failed.", this.requestMetadata.get(scopedRequestId)?.url))
          );
          const request = metadata ?? this.requestMetadata.get(scopedRequestId);
          this.emit("requestfailed", {
            errorText: loadingFailed.errorText,
            ...(request?.frameId ? { frameId: request.frameId } : {}),
            isNavigationRequest: request?.isNavigationRequest ?? false,
            method: request?.method ?? "UNKNOWN",
            requestId: scopedRequestId,
            resourceType: toPlaywrightResourceType(request?.type),
            url: request?.url ?? "unknown://request"
          });
          this.activeRequests = Math.max(0, this.activeRequests - 1);
          this.flushPendingRequestEvent(scopedRequestId);
          this.requestExtraInfoHeaders.delete(scopedRequestId);
          this.responseExtraInfoDiscardCounts.delete(scopedRequestId);
          this.requestMetadata.delete(scopedRequestId);
          this.continuedRequestUrls.delete(scopedRequestId);
          this.workerRequestAliases.delete(this.scopedWorkerRequestId(event.sessionId, loadingFailed.requestId));
          this.maybeArmNetworkIdleTimer();
        });
        const sessionClient = this.options.client as typeof this.options.client & {
          send(method: string, params?: Record<string, never>, sessionId?: string): Promise<unknown>;
        };
        void sessionClient.send("Network.enable", {}, event.sessionId).catch(() => {});
        void sessionClient.send("Runtime.enable", {}, event.sessionId).catch(() => {});
        void sessionClient.send("Runtime.runIfWaitingForDebugger", {}, event.sessionId).catch(() => {});
        return;
      }
      if (event.targetInfo.type !== "iframe") {
        const sessionClient = this.options.client as typeof this.options.client & {
          send(method: string, params?: Record<string, never>, sessionId?: string): Promise<unknown>;
        };
        void sessionClient.send("Runtime.enable", {}, event.sessionId).catch(() => {});
        void sessionClient.send("Runtime.runIfWaitingForDebugger", {}, event.sessionId).catch(() => {});
        return;
      }
      this.nativeFrames.set(event.targetInfo.targetId, {
        id: event.targetInfo.targetId,
        name: this.nativeFrames.get(event.targetInfo.targetId)?.name ?? "",
        parentId: event.targetInfo.parentFrameId ?? this.mainFrameId ?? null,
        url: event.targetInfo.url ?? this.nativeFrames.get(event.targetInfo.targetId)?.url ?? "about:blank"
      });
      this.frameSessionIds.set(event.targetInfo.targetId, event.sessionId);
      const sessionClient = this.options.client as typeof this.options.client & {
        send(
          method: "Runtime.enable" | "Page.enable" | "Runtime.runIfWaitingForDebugger",
          params?: Record<string, never>,
          sessionId?: string
        ): Promise<unknown>;
        send(
          method: "Target.setAutoAttach",
          params: { autoAttach: boolean; waitForDebuggerOnStart: boolean; flatten: boolean },
          sessionId?: string
        ): Promise<unknown>;
      };
      void sessionClient.send("Runtime.enable", {}, event.sessionId).catch(() => {});
      void sessionClient.send("Page.enable", {}, event.sessionId).catch(() => {});
      void sessionClient.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true
      }, event.sessionId).catch(() => {});
      void sessionClient.send("Runtime.runIfWaitingForDebugger", {}, event.sessionId).catch(() => {});
    });

    client.Target?.detachedFromTarget?.((event: {
      sessionId: string;
      targetId?: string;
    }) => {
      const targetId = event.targetId;
      if (!targetId) {
        return;
      }
      if (this.frameSessionIds.get(targetId) === event.sessionId) {
        this.frameSessionIds.delete(targetId);
        this.loadingFrameIds.delete(targetId);
        this.frameLifecycleStates.delete(targetId);
        return;
      }
      const worker = this.workersByTargetId.get(targetId);
      if (!worker) {
        return;
      }
      if (worker.sessionId !== event.sessionId) {
        return;
      }
      this.workersByTargetId.delete(targetId);
      worker.delegate.markClosed();
      worker.worker.emitClose();
    });

    const onExecutionContextCreated = (event: {
      context: {
        auxData?: {
          frameId?: string;
          isDefault?: boolean;
          type?: string;
        };
        id: number;
      };
    }, sessionId?: string) => {
      const frameId = event.context.auxData?.frameId;
      const isDefault = event.context.auxData?.isDefault !== false &&
        event.context.auxData?.type !== "isolated";
      if (frameId && isDefault) {
        if (sessionId) {
          this.frameSessionIds.set(frameId, sessionId);
        }
        this.defaultExecutionContextByFrameId.set(frameId, event.context.id);
        this.defaultExecutionContextSessionByFrameId.set(frameId, sessionId);
        const waiters = this.pendingDefaultExecutionContextWaiters.get(frameId);
        if (waiters) {
          this.pendingDefaultExecutionContextWaiters.delete(frameId);
          for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve(event.context.id);
          }
        }
      }
    };

    client.Runtime.executionContextCreated?.((event: {
      context: {
        auxData?: {
          frameId?: string;
          isDefault?: boolean;
          type?: string;
        };
        id: number;
      };
    }) => onExecutionContextCreated(event));
    client.on?.("Runtime.executionContextCreated", (event: {
      context: {
        auxData?: {
          frameId?: string;
          isDefault?: boolean;
          type?: string;
        };
        id: number;
      };
    }, sessionId?: string) => onExecutionContextCreated(event, sessionId));

    const onExecutionContextsCleared = (sessionId?: string) => {
      this.clearDefaultExecutionContexts(sessionId);
    };

    client.Runtime.executionContextsCleared?.(() => onExecutionContextsCleared());
    client.on?.("Runtime.executionContextsCleared", (_event: unknown, sessionId?: string) => {
      onExecutionContextsCleared(sessionId);
    });

    client.Page.frameStoppedLoading((event) => {
      this.loadingFrameIds.delete(event.frameId);
      this.updateFrameLifecycleState(event.frameId, {
        domContentLoaded: true,
        loadFired: true
      });
      if (this.isMainFrameId(event.frameId)) {
        this.domContentLoaded = true;
      }
      this.loadFired = this.loadingFrameIds.size === 0;
      this.maybeArmNetworkIdleTimer();
      this.flushWaiters();
    });

    client.Page.loadEventFired(() => {
      this.loadFired = true;
      this.flushWaiters();
      this.emit("load", undefined);
      void this.renderScreencastActions();
      void this.renderScreencastOverlays();
    });

    client.Page.screencastFrame?.((payload) => {
      this.emit("screencastFrame", {
        data: Buffer.from(payload.data, "base64"),
        timestamp: payload.metadata.timestamp ? payload.metadata.timestamp * 1000 : Date.now(),
        viewportWidth: payload.metadata.deviceWidth ?? this.currentViewportSize?.width ?? 0,
        viewportHeight: payload.metadata.deviceHeight ?? this.currentViewportSize?.height ?? 0
      });
      const ack = this.options.client.Page.screencastFrameAck?.({
        sessionId: payload.sessionId
      });
      void ack?.catch(() => {});
    });

    client.Runtime.consoleAPICalled((event) => {
      const args = event.args.map((arg) => createCdpConsoleHandle(this, arg));
      this.emit("console", {
        args: () => args,
        location: () => consoleStackTraceLocation(event.stackTrace),
        page: () => null,
        text: () => args.map((arg) => String(arg)).join(" "),
        timestamp: () => normalizeConsoleTimestamp(event.timestamp),
        type: () => event.type,
        worker: () => null
      });
    });

    client.Log?.entryAdded?.((event) => {
      const entry = event.entry;
      if (entry.source === "worker") {
        return;
      }
      if (entry.text.startsWith("Failed to load resource:")) {
        return;
      }
      this.emit("console", {
        args: () => [],
        location: () => ({
          url: entry.url ?? "",
          line: entry.lineNumber ?? 0,
          lineNumber: entry.lineNumber ?? 0,
          column: 0,
          columnNumber: 0
        }),
        page: () => null,
        text: () => entry.text,
        timestamp: () => normalizeConsoleTimestamp(entry.timestamp),
        type: () => normalizeLogEntryLevel(entry.level),
        worker: () => null
      });
    });

    client.Runtime.exceptionThrown?.((event) => {
      this.emit("pageerror", exceptionToError(event.exceptionDetails));
    });

    client.Network.requestWillBeSent((event) => {
      const requestEvent = event as typeof event & {
        frameId?: string;
        initiator?: { type?: string };
        loaderId?: string;
        request: typeof event.request & {
          postDataEntries?: Array<{ bytes?: string }>;
        };
        type?: string;
      };
      if (event.request.url.startsWith("data:")) {
        this.ignoredRequestIds.add(event.requestId);
        return;
      }
      if (isNetworkIdleIgnoredRequestUrl(event.request.url)) {
        return;
      }
      const isFavicon = isFaviconRequestUrl(event.request.url);
      const isNavigationRequest =
        event.requestId === requestEvent.loaderId && requestEvent.type === "Document";
      if (event.redirectResponse) {
        this.flushPendingRequestEvent(event.requestId);
        this.emitRedirectResponse(requestEvent, event.redirectResponse);
        this.discardNextResponseExtraInfo(event.requestId);
      }
      const isPreflightRequest =
        event.request.method === "OPTIONS" && requestEvent.initiator?.type === "preflight";
      const continuedHeaders = event.redirectResponse
        ? this.continuedRequestHeaders.get(event.requestId)
        : undefined;
      const requestHeaders = continuedHeaders
        ? applyCdpHeaderOverrides(event.request.headers, continuedHeaders)
        : mapCdpHeaders(event.request.headers);
      this.activeRequests += 1;
      this.networkIdleReached = false;
      this.clearNetworkIdleTimer();
      const frameId =
        this.options.initialNavigationFrameUnavailable && isNavigationRequest
          ? undefined
          : requestEvent.frameId;
      if (frameId) {
        this.markFrameNetworkBusy(frameId);
      }
      this.requestMetadata.set(event.requestId, {
        ...(isFavicon ? { isFavicon: true } : {}),
        isNavigationRequest,
        method: event.request.method,
        url: event.request.url,
        ...(isPreflightRequest ? { isPreflight: true } : {}),
        ...(frameId ? { frameId } : {}),
        ...(requestEvent.type ? { type: requestEvent.type } : {})
      });
      if (isPreflightRequest) {
        return;
      }
      if (isFavicon) {
        return;
      }
      this.queueRequestEvent(event.requestId, {
        headers: requestHeaders,
        ...(frameId ? { frameId } : {}),
        isNavigationRequest,
        method: event.request.method,
        ...(event.request.postData !== undefined ? { postData: event.request.postData } : {}),
        ...postDataBufferFieldsFromCdpEntries(requestEvent.request.postDataEntries),
        requestId: event.requestId,
        resourceType: toPlaywrightResourceType(requestEvent.type),
        url: event.request.url
      });
    });

    client.Network.webSocketCreated?.((event: {
      requestId: string;
      url: string;
    }) => {
      this.emit("websocket", {
        kind: "created",
        requestId: event.requestId,
        url: event.url
      });
    });

    client.Network.webSocketFrameSent?.((event: {
      requestId: string;
      response: {
        opcode: number;
        payloadData?: string;
      };
    }) => {
      if (event.response.payloadData === undefined) {
        return;
      }
      this.emit("websocket", {
        data: event.response.payloadData,
        kind: "frameSent",
        opcode: event.response.opcode,
        requestId: event.requestId
      });
    });

    client.Network.webSocketFrameReceived?.((event: {
      requestId: string;
      response: {
        opcode: number;
        payloadData?: string;
      };
    }) => {
      if (event.response.payloadData === undefined) {
        return;
      }
      this.emit("websocket", {
        data: event.response.payloadData,
        kind: "frameReceived",
        opcode: event.response.opcode,
        requestId: event.requestId
      });
    });

    client.Network.webSocketFrameError?.((event: {
      errorMessage: string;
      requestId: string;
    }) => {
      this.emit("websocket", {
        errorMessage: event.errorMessage,
        kind: "socketError",
        requestId: event.requestId
      });
    });

    client.Network.webSocketClosed?.((event: {
      requestId: string;
    }) => {
      this.emit("websocket", {
        kind: "closed",
        requestId: event.requestId
      });
    });

    client.Network.requestWillBeSentExtraInfo?.((event) => {
      if (this.ignoredRequestIds.has(event.requestId)) {
        return;
      }
      const request = this.requestMetadata.get(event.requestId);
      if (request?.isPreflight || request?.isFavicon) {
        return;
      }
      const headers = mapCdpHeaders(event.headers, "\n");
      const pending = this.pendingRequestEvents.get(event.requestId);
      if (pending?.length) {
        const next = pending.shift()!;
        if (next.fallbackTimer) {
          clearTimeout(next.fallbackTimer);
        }
        if (pending.length === 0) {
          this.pendingRequestEvents.delete(event.requestId);
        }
        this.emit("request", {
          ...next.payload,
          headers
        });
        for (const callback of next.responseCallbacks) {
          callback();
        }
        return;
      }
      const queued = this.requestExtraInfoHeaders.get(event.requestId) ?? [];
      queued.push(headers);
      this.requestExtraInfoHeaders.set(event.requestId, queued);
    });

    client.Fetch?.requestPaused?.((event) => {
      void this.handleFetchRequestPaused(event);
    });

    const onRequestSettled = (requestId?: string) => {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      if (requestId) {
        const frameId = this.requestMetadata.get(requestId)?.frameId;
        this.flushPendingRequestEvent(requestId);
        this.requestExtraInfoHeaders.delete(requestId);
        this.servedFromCacheRequestIds.delete(requestId);
        this.responseExtraInfoDiscardCounts.delete(requestId);
        this.failedRouteErrorTexts.delete(requestId);
        this.requestMetadata.delete(requestId);
        this.continuedRequestUrls.delete(requestId);
        if (frameId) {
          this.markFrameNetworkRequestSettled(frameId);
        }
      }
      this.maybeArmNetworkIdleTimer();
    };

    client.Network.responseReceived((event) => {
      if (this.ignoredRequestIds.has(event.requestId)) {
        return;
      }
      const responseEvent = event as typeof event & {
        frameId?: string;
        hasExtraInfo?: boolean;
        type?: string;
      };
      const request = this.requestMetadata.get(event.requestId);
      if (request) {
        request.responseStatus = event.response.status;
      }
      if (request?.isPreflight || request?.isFavicon) {
        this.ensureResponseBodyState(event.requestId).resolveReady();
        return;
      }
      const fromCache = Boolean(event.response.fromDiskCache || event.response.fromPrefetchCache);
      if (fromCache) {
        this.servedFromCacheRequestIds.add(event.requestId);
      }
      if (this.runAfterPendingRequestEvent(event.requestId, () => {
        this.handleNetworkResponseReceived(responseEvent, fromCache);
      })) {
        return;
      }
      this.handleNetworkResponseReceived(responseEvent, fromCache);
    });

    client.Network.requestServedFromCache?.((event: { requestId: string }) => {
      this.servedFromCacheRequestIds.add(event.requestId);
    });

    client.Network.responseReceivedExtraInfo?.((event) => {
      if (this.ignoredRequestIds.has(event.requestId)) {
        return;
      }
      const request = this.requestMetadata.get(event.requestId);
      if (request?.isPreflight || request?.isFavicon) {
        return;
      }
      const discardCount = this.responseExtraInfoDiscardCounts.get(event.requestId) ?? 0;
      if (discardCount > 0) {
        if (discardCount === 1) {
          this.responseExtraInfoDiscardCounts.delete(event.requestId);
        } else {
          this.responseExtraInfoDiscardCounts.set(event.requestId, discardCount - 1);
        }
        return;
      }
      const headers = parseCdpHeadersText((event as typeof event & { headersText?: string }).headersText) ??
        mapCdpHeaders(event.headers, "\n");
      const pending = this.pendingResponseEvents.get(event.requestId);
      if (pending?.length) {
        const fallbackTimer = this.pendingResponseFallbackTimers.get(event.requestId);
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          this.pendingResponseFallbackTimers.delete(event.requestId);
        }
        const next = pending.shift()!;
        if (pending.length === 0) {
          this.pendingResponseEvents.delete(event.requestId);
        }
        this.emitResponseReceived(next.event, headers);
        return;
      }
      const queued = this.responseExtraInfoHeaders.get(event.requestId) ?? [];
      queued.push(headers);
      this.responseExtraInfoHeaders.set(event.requestId, queued);
    });

    client.Network.loadingFinished((event) => {
      if (this.ignoredRequestIds.delete(event.requestId)) {
        return;
      }
      this.flushPendingResponseEvent(event.requestId);
      this.ensureResponseBodyState(event.requestId).resolveReady();
      const request = this.requestMetadata.get(event.requestId);
      if (request?.isPreflight || request?.isFavicon) {
        onRequestSettled(event.requestId);
        return;
      }
      this.emit("requestfinished", {
        headers: [],
        ...(request?.frameId ? { frameId: request.frameId } : {}),
        isNavigationRequest: request?.isNavigationRequest ?? false,
        method: request?.method ?? "UNKNOWN",
        requestId: event.requestId,
        resourceType: toPlaywrightResourceType(request?.type),
        url: request?.url ?? "unknown://request"
      });
      onRequestSettled(event.requestId);
    });
    client.Network.loadingFailed((event) => {
      if (this.ignoredRequestIds.delete(event.requestId)) {
        return;
      }
      this.flushPendingResponseEvent(event.requestId);
      const request = this.requestMetadata.get(event.requestId);
      if (request?.type === "Document" && request.frameId) {
        this.loadingFrameIds.delete(request.frameId);
        this.updateFrameLifecycleState(request.frameId, {
          loadFired: true
        });
        if (this.isMainFrameId(request.frameId)) {
          this.domContentLoaded = true;
        }
        this.loadFired = this.loadingFrameIds.size === 0;
      }
      if (request?.isPreflight || request?.isFavicon) {
        this.ensureResponseBodyState(event.requestId).resolveReady();
        onRequestSettled(event.requestId);
        return;
      }
      const failureErrorText = this.failedRouteErrorTexts.get(event.requestId) ?? event.errorText;
      if (this.fulfilledRequestIds.has(event.requestId)) {
        this.ensureResponseBodyState(event.requestId).resolveReady();
        this.fulfilledRequestIds.delete(event.requestId);
        this.emit("requestfinished", {
          headers: [],
          ...(request?.frameId ? { frameId: request.frameId } : {}),
          isNavigationRequest: request?.isNavigationRequest ?? false,
          method: request?.method ?? "UNKNOWN",
          requestId: event.requestId,
          resourceType: toPlaywrightResourceType(request?.type),
          url: request?.url ?? "unknown://request"
        });
        onRequestSettled(event.requestId);
        return;
      }
      if (request?.responseStatus === 204) {
        if (request.type === "Document" && request.frameId && this.isMainFrameId(request.frameId)) {
          this.ensureResponseBodyState(event.requestId).markFailed(
            new Error(formatNavigationFailureMessage(failureErrorText || "Navigation failed.", request.url))
          );
          this.rejectNavigationFailureCaptures(
            new Error(formatNavigationFailureMessage(failureErrorText || "Navigation failed.", request.url)),
            request.url
          );
          onRequestSettled(event.requestId);
          this.emit("requestfailed", {
            errorText: failureErrorText,
            ...(request.frameId ? { frameId: request.frameId } : {}),
            isNavigationRequest: request.isNavigationRequest ?? false,
            method: request.method,
            requestId: event.requestId,
            resourceType: toPlaywrightResourceType(request.type),
            url: request.url
          });
          return;
        }
        this.ensureResponseBodyState(event.requestId).resolveReady();
        this.emit("requestfinished", {
          headers: [],
          ...(request.frameId ? { frameId: request.frameId } : {}),
          isNavigationRequest: request.isNavigationRequest ?? false,
          method: request.method,
          requestId: event.requestId,
          resourceType: toPlaywrightResourceType(request.type),
          url: request.url
        });
        onRequestSettled(event.requestId);
        return;
      }
      this.ensureResponseBodyState(event.requestId).markFailed(
        new Error(formatNavigationFailureMessage(failureErrorText || "Network loading failed.", request?.url))
      );
      if (request?.type === "Document" && request.frameId && this.isMainFrameId(request.frameId)) {
        this.rejectNavigationFailureCaptures(
          new Error(formatNavigationFailureMessage(failureErrorText || "Navigation failed.", request.url)),
          request.url
        );
      }
      onRequestSettled(event.requestId);
      this.emit("requestfailed", {
        errorText: failureErrorText,
        ...(request?.frameId ? { frameId: request.frameId } : {}),
        isNavigationRequest: request?.isNavigationRequest ?? false,
        method: request?.method ?? "UNKNOWN",
        requestId: event.requestId,
        resourceType: toPlaywrightResourceType(request?.type),
        url: request?.url ?? "unknown://request"
      });
      this.flushWaiters();
    });

    const popupFallbackBridgeSource = this.installPopupFallbackBridge();
    await Promise.all([
      initializeCommand(client.Page.enable()),
      initializeCommand(client.Page.getFrameTree?.().then((response) => {
        this.syncNativeFrameTree(response.frameTree);
        this.mainFrameId = response.frameTree.frame.id;
        this.currentUrl = response.frameTree.frame.url ?? this.currentUrl;
      }).catch(() => {})),
      initializeCommand(client.Page.setLifecycleEventsEnabled({ enabled: true }).catch(() => {})),
      initializeCommand(client.Runtime.enable()),
      initializeCommand(client.Log?.enable?.().catch(() => {})),
      initializeCommand(client.DOM.enable({})),
      initializeCommand(client.Network.enable({})),
      ...(this.requestInterceptionEnabled
        ? [
            initializeCommand(client.Network.setCacheDisabled({ cacheDisabled: true }).catch(() => {})),
            initializeCommand(client.Fetch.enable({
              patterns: [
                {
                  urlPattern: "*",
                  requestStage: "Request"
                }
              ]
            }).catch(() => {}))
          ]
        : []),
      initializeCommand(client.Target?.setAutoAttach?.({
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true
      }).catch(() => {})),
      ...((this.options.contextInitScripts ?? []).map((entry) =>
        initializeCommand(this.installInitScript(entry.source, {
          evaluateInCurrentDocument: true
        }).then((disposable) => {
          entry.onInstalled(disposable);
        }).catch((error) => {
          if (isClosedCdpConnectionError(error)) {
            return;
          }
          throw error;
        }))
      )),
      initializeCommand(popupFallbackBridgeSource.then(() => {})),
      initializeCommand(this.options.resumeOnInitialized?.())
    ]);
    await this.syncLifecycleStateFromDocument();
    this.maybeResolveInitialAboutBlankLifecycle();
    this.maybeArmNetworkIdleTimer();
    await this.applyContextOptions();
  }

  private async installPopupFallbackBridge(): Promise<string | null> {
    if (this.popupFallbackBindingInstalled) {
      return null;
    }
    const runtimeClient = this.options.client as CdpClient & {
      Runtime: CdpRuntimeClient & {
        addBinding?(params: { name: string }): Promise<unknown>;
      };
    };
    try {
      await runtimeClient.Runtime.addBinding?.({
        name: POPUP_FALLBACK_BINDING_NAME
      });
    } catch (error) {
      if (isClosedCdpConnectionError(error)) {
        return null;
      }
      throw error;
    }
    if (typeof this.options.client.Page.addScriptToEvaluateOnNewDocument !== "function") {
      return null;
    }
    const installSource = `
      (() => {
        const globalState = globalThis;
        if (globalState.__roxyPopupOpenFallbackInstalled) {
          return;
        }
        const binding = globalState.${POPUP_FALLBACK_BINDING_NAME};
        if (typeof binding !== "function") {
          return;
        }
        const originalWindowOpen = globalThis.open.bind(globalThis);
        globalState.open = (...args) => {
          const popup = originalWindowOpen(...args);
          try {
            binding(JSON.stringify({
              url: typeof args[0] === "string" && args[0] ? args[0] : "about:blank"
            }));
          } catch {}
          return popup;
        };
        globalState.__roxyPopupOpenFallbackInstalled = true;
      })();
    `;
    try {
      await this.installInitScript(installSource, {
        evaluateInCurrentDocument: true
      });
    } catch (error) {
      if (isClosedCdpConnectionError(error)) {
        return null;
      }
      throw error;
    }
    this.popupFallbackBindingInstalled = true;
    return installSource;
  }

  private async evaluateInitScriptInCurrentDocument(source: string): Promise<void> {
    const runtimeClient = this.options.client as CdpRuntimeClient;
    await this.raceWithClose(runtimeClient.send("Runtime.evaluate", {
      expression: `(() => { ${source}\n})();`,
      awaitPromise: true,
      returnByValue: false
    }));
  }

  private handleNetworkResponseReceived(
    responseEvent: {
      frameId?: string;
      hasExtraInfo?: boolean;
      requestId: string;
      response: {
        fromDiskCache?: boolean;
        fromServiceWorker?: boolean;
        fromPrefetchCache?: boolean;
        headers: Record<string, string | number | boolean>;
        mimeType: string;
        status: number;
        statusText: string;
        url: string;
      };
      type?: string;
    },
    fromCache: boolean
  ): void {
    fromCache = fromCache || this.servedFromCacheRequestIds.has(responseEvent.requestId);
    if (responseEvent.hasExtraInfo && !fromCache) {
      const extraInfoHeaders = this.shiftResponseExtraInfoHeaders(responseEvent.requestId);
      if (extraInfoHeaders) {
        this.emitResponseReceived(responseEvent, extraInfoHeaders);
        return;
      }
      const pending = this.pendingResponseEvents.get(responseEvent.requestId) ?? [];
      pending.push({
        event: {
          requestId: responseEvent.requestId,
          ...(responseEvent.frameId ? { frameId: responseEvent.frameId } : {}),
          response: {
            ...(responseEvent.response.fromDiskCache !== undefined
              ? { fromDiskCache: responseEvent.response.fromDiskCache }
              : {}),
            ...(responseEvent.response.fromServiceWorker !== undefined
              ? { fromServiceWorker: responseEvent.response.fromServiceWorker }
              : {}),
            ...(responseEvent.response.fromPrefetchCache !== undefined
              ? { fromPrefetchCache: responseEvent.response.fromPrefetchCache }
              : {}),
            headers: responseEvent.response.headers,
            mimeType: responseEvent.response.mimeType,
            status: responseEvent.response.status,
            statusText: responseEvent.response.statusText,
            url: responseEvent.response.url
          },
          ...(responseEvent.type ? { type: responseEvent.type } : {})
        }
      });
      this.pendingResponseEvents.set(responseEvent.requestId, pending);
      if (!this.pendingResponseFallbackTimers.has(responseEvent.requestId)) {
        this.pendingResponseFallbackTimers.set(
          responseEvent.requestId,
          setTimeout(() => {
            this.pendingResponseFallbackTimers.delete(responseEvent.requestId);
            this.flushPendingResponseEvent(responseEvent.requestId);
          }, 50)
        );
      }
      return;
    }
    this.emitResponseReceived(responseEvent);
  }

  async goto(url: string, options: PageGotoOptions = {}): Promise<PageResponse | null> {
    const waitUntil = verifyLifecycle("waitUntil", options.waitUntil ?? "load");
    const targetUrl = resolveUrl(url, this.options.contextOptions.baseURL);
    const referer = this.resolveNavigationReferer(options, targetUrl);
    const navigationClient = this.navigationClient();
    await this.interruptPendingNavigations(targetUrl);
    const capture = this.beginNavigationResponseCapture();
    const failureCapture = this.beginNavigationFailureCapture(targetUrl, "page.goto");
    failureCapture.allowCommittedRedirectTimeout = waitUntil === "networkidle";
    this.resetNavigationState();
    this.allowSameDocumentNavigationToResolveWaiters = true;

    try {
      const navigationResult = await this.raceNavigationFailure(
        withTimeout(
          retryOnDetachedNavigationSession(() => {
            return (navigationClient.Page as typeof navigationClient.Page & {
              navigate(params: {
                url: string;
                referrer?: string;
                referrerPolicy?: string;
              }): Promise<{ errorText?: string; loaderId?: string }>;
            }).navigate({
              url: targetUrl,
              ...(referer !== undefined
                ? {
                    referrer: referer,
                    referrerPolicy: "unsafeUrl"
                  }
                : {})
            });
          }),
          options.timeout,
          `page.goto: Timeout ${options.timeout}ms exceeded.\n` +
            `navigating to "${targetUrl}", waiting until "${waitUntil}"`
        ),
        failureCapture
      ) as {
        errorText?: string;
        loaderId?: string;
      } | typeof COMMITTED_NAVIGATION_INTERRUPTED;
      if (navigationResult === COMMITTED_NAVIGATION_INTERRUPTED) {
        return capture.lastResponse;
      }
      if (navigationResult.errorText) {
        throw new Error(formatNavigationFailureMessage(navigationResult.errorText, targetUrl));
      }
      if (navigationResult.loaderId) {
        failureCapture.expectedLoaderId = navigationResult.loaderId;
        failureCapture.committed = true;
      }
      this.currentUrl = targetUrl;

      if (waitUntil !== "commit") {
        const loadStateResult = await this.raceNavigationFailure(
          this.waitForLoadState(waitUntil, options.timeout).catch((error) => {
            if (error instanceof TimeoutError) {
              throw new TimeoutError(
                `page.goto: Timeout ${options.timeout}ms exceeded.\n` +
                  `navigating to "${targetUrl}", waiting until "${waitUntil}"`
              );
            }
            throw error;
          }),
          failureCapture,
          { includeCommittedInterruption: waitUntil !== "networkidle" }
        );
        if (loadStateResult === COMMITTED_NAVIGATION_INTERRUPTED) {
          return capture.lastResponse;
        }
      }
      await this.syncCurrentUrlFromDocument();

      return capture.lastResponse;
    } finally {
      this.endNavigationResponseCapture(capture);
      this.endNavigationFailureCapture(failureCapture);
    }
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
    const navigationClient = this.navigationClient();
    await this.interruptPendingNavigations(this.currentUrl);
    const capture = this.beginNavigationResponseCapture();
    const failureCapture = this.beginNavigationFailureCapture(this.currentUrl, "page.reload");
    this.resetNavigationState();

    try {
      await this.raceNavigationFailure(
        withTimeout(
          retryOnDetachedNavigationSession(() => {
            return (navigationClient.Page as typeof navigationClient.Page & {
              reload(): Promise<void>;
            }).reload();
          }),
          options.timeout,
          "Timed out while reloading page."
        ),
        failureCapture
      );

      if (waitUntil !== "commit") {
        await this.raceNavigationFailure(
          this.waitForLoadState(waitUntil, options.timeout),
          failureCapture
        );
      }
      await this.syncCurrentUrlFromDocument();

      return capture.lastResponse;
    } finally {
      this.endNavigationResponseCapture(capture);
      this.endNavigationFailureCapture(failureCapture);
    }
  }

  async waitForNavigationResponse(options: {
    frameId?: string;
    initialUrl?: string;
    signal?: AbortSignal;
    timeout?: number;
    url?: string | RegExp | ((url: URL) => boolean);
  } = {}): Promise<PageResponse | null> {
    const capture = this.beginNavigationResponseCapture({
      predicate: (response) => {
        if (options.frameId && response.frameId !== options.frameId) {
          return false;
        }
        if (options.initialUrl && response.url === options.initialUrl) {
          return false;
        }
        if (!options.url) {
          return true;
        }
        return matchesNavigationResponseUrl(response.url, options.url);
      }
    });

    try {
      if (options.signal?.aborted) {
        return null;
      }
      return await withTimeout(
        new Promise<PageResponse | null>((resolve) => {
          const onAbort = () => {
            options.signal?.removeEventListener("abort", onAbort);
            resolve(null);
          };
          options.signal?.addEventListener("abort", onAbort, { once: true });
          capture.resolve = resolve;
        }),
        options.timeout,
        `Timed out while waiting for navigation response.`
      );
    } finally {
      this.endNavigationResponseCapture(capture);
    }
  }

  async title(): Promise<string> {
    return this.evaluateExpression<string>("document.title");
  }

  async content(): Promise<string> {
    return this.evaluateFunction<string>(
      `() => {
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
      }`
    );
  }

  async setContent(html: string, options: PageSetContentOptions = {}): Promise<void> {
    const waitUntil = verifyLifecycle("waitUntil", options.waitUntil ?? "load");
    this.resetNavigationState();
    this.clearScreencastActionAnnotation();
    await this.evaluateFunction<void>(
      `(payload) => {
        document.open();
        document.write(payload.html);
        document.close();
      }`,
      { html }
    ).catch((error) => {
      if (!isSetContentEvaluationInterruption(error)) {
        throw error;
      }
    });

    if (waitUntil !== "commit") {
      await this.waitForLoadState(waitUntil, options.timeout, undefined, {
        skipDocumentReadyStateSync: true
      });
    }

    await this.evaluateFunction<void>(HYDRATE_DECLARATIVE_SHADOW_ROOTS_SOURCE).catch((error) => {
      if (!isSetContentEvaluationInterruption(error)) {
        throw error;
      }
    });
  }

  async addInitScript(source: string, _arg?: unknown): Promise<Disposable> {
    return this.installInitScript(source);
  }

  private async installInitScript(
    source: string,
    options: {
      evaluateInCurrentDocument?: boolean;
      runImmediately?: boolean;
    } = {}
  ): Promise<Disposable> {
    let result: { identifier?: string };
    try {
      result = await this.raceWithClose(this.options.client.Page.addScriptToEvaluateOnNewDocument({
        source,
        ...(options.runImmediately !== undefined
          ? { runImmediately: options.runImmediately }
          : {})
      })) as { identifier?: string };
    } catch (error) {
      if (this.options.suppressClosedInitScriptErrors && isClosedCdpConnectionError(error)) {
        const dispose = async () => {};
        return {
          dispose,
          [Symbol.asyncDispose]: dispose
        };
      }
      throw error;
    }
    if (options.evaluateInCurrentDocument) {
      await this.evaluateInitScriptInCurrentDocument(source).catch((error) => {
        if (isClosedCdpConnectionError(error)) {
          return;
        }
        throw error;
      });
    }
    const identifier = (result as { identifier?: string }).identifier;
    const dispose = async () => {
      if (!identifier) {
        return;
      }
      await this.options.client.Page.removeScriptToEvaluateOnNewDocument?.({
        identifier
      }).catch(() => {});
    };
    return {
      dispose,
      [Symbol.asyncDispose]: dispose
    };
  }

  async evaluate<TResult>(
    expression: string,
    arg?: unknown,
    isFunction = looksLikeFunctionExpression(expression)
  ): Promise<TResult> {
    if (arg === undefined && !isFunction) {
      return this.evaluateExpression<TResult>(expression);
    }

    return this.evaluateWithArguments<TResult>(
      expression,
      true,
      arg === undefined ? [] : [arg],
      isFunction
    );
  }

  async evaluateHandle<TResult>(
    expression: string,
    arg?: unknown,
    isFunction = looksLikeFunctionExpression(expression)
  ): Promise<ProtocolJSHandleAdapter<TResult>> {
    return this.evaluateWithArguments<TResult>(
      expression,
      false,
      arg === undefined ? [] : [arg],
      isFunction
    );
  }

  async evaluateInFrame<TResult>(
    frameId: string,
    expression: string,
    arg?: unknown,
    isFunction = looksLikeFunctionExpression(expression)
  ): Promise<TResult> {
    return this.evaluateWithArgumentsInFrame<TResult>(
      frameId,
      expression,
      true,
      arg === undefined ? [] : [arg],
      isFunction
    );
  }

  async evaluateHandleInFrame<TResult>(
    frameId: string,
    expression: string,
    arg?: unknown,
    isFunction = looksLikeFunctionExpression(expression)
  ): Promise<ProtocolJSHandleAdapter<TResult>> {
    return this.evaluateWithArgumentsInFrame<TResult>(
      frameId,
      expression,
      false,
      arg === undefined ? [] : [arg],
      isFunction
    );
  }

  async frameSnapshots(): Promise<Array<{
    id: string;
    name: string;
    nativeFrameId?: string;
    ownerElementReference?: ProtocolElementHandleReference;
    ownerElementChain: LocatorSelector[];
    parentId: string | null;
    referenceChain: LocatorSelector[];
    url: string;
  }>> {
    const domSnapshots = await this.collectDomFrameSnapshots().catch(() => []);
    const domById = new Map(domSnapshots.map((snapshot) => [snapshot.id, snapshot]));
    const frameTree = await (this.options.client as CdpPageFrameClient).send("Page.getFrameTree").catch(() => null);
    if (frameTree) {
      this.syncNativeFrameTree(frameTree.frameTree);
    }

    const snapshots: Array<{
      id: string;
      name: string;
      nativeFrameId?: string;
      ownerElementReference?: ProtocolElementHandleReference;
      ownerElementChain: LocatorSelector[];
      parentId: string | null;
      referenceChain: LocatorSelector[];
      url: string;
    }> = [];
    const childrenByParent = new Map<string | null, CdpNativeFrameState[]>();
    for (const frame of this.nativeFrames.values()) {
      const parentFrames = childrenByParent.get(frame.parentId) ?? [];
      parentFrames.push(frame);
      childrenByParent.set(frame.parentId, parentFrames);
    }

    const usedDomSnapshotIds = new Set<string>();
    const takeDomSnapshot = (
      frame: CdpNativeFrameState,
      parentId: string | null,
      syntheticId: string
    ) => {
      const exact = domById.get(syntheticId);
      if (exact && !usedDomSnapshotIds.has(exact.id)) {
        usedDomSnapshotIds.add(exact.id);
        return exact;
      }

      const matching = domSnapshots.find((snapshot) => {
        if (usedDomSnapshotIds.has(snapshot.id) || snapshot.parentId !== parentId) {
          return false;
        }
        if (frame.url && snapshot.url === frame.url) {
          return true;
        }
        return Boolean(frame.name && snapshot.name === frame.name);
      });
      if (matching) {
        usedDomSnapshotIds.add(matching.id);
      }
      return matching;
    };

    const visit = async (frame: CdpNativeFrameState, parentId: string | null, syntheticId: string) => {
      const domSnapshot = takeDomSnapshot(frame, parentId, syntheticId);
      const normalizedFrameUrl =
        frame.url && frame.url !== ":"
          ? frame.url
          : undefined;
      snapshots.push({
        id: syntheticId,
        name: frame.name || domSnapshot?.name || "",
        nativeFrameId: frame.id,
        ...(parentId ? await this.ownerElementReferenceForFrame(frame.id).then(
          (ownerElementReference) => ownerElementReference ? { ownerElementReference } : {},
          () => ({})
        ) : {}),
        ownerElementChain: domSnapshot?.ownerElementChain ?? [],
        parentId,
        referenceChain: domSnapshot?.referenceChain ?? [],
        url: normalizedFrameUrl || domSnapshot?.url || "about:blank"
      });
      const children = childrenByParent.get(frame.id) ?? [];
      for (const [index, child] of children.entries()) {
        await visit(child, syntheticId, `${syntheticId}.${index + 1}`);
      }
    };
    const rootFrame = this.mainFrameId ? this.nativeFrames.get(this.mainFrameId) : undefined;
    if (rootFrame) {
      await visit(rootFrame, null, "main");
    } else if (frameTree) {
      await visit({
        id: frameTree.frameTree.frame.id,
        name: frameTree.frameTree.frame.name ?? "",
        parentId: null,
        url: frameTree.frameTree.frame.url ?? "about:blank"
      }, null, "main");
    } else {
      snapshots.push({
        id: "main",
        name: "",
        ownerElementChain: [],
        parentId: null,
        referenceChain: [],
        url: this.currentUrl || "about:blank"
      });
    }
    const seenSnapshotIds = new Set(snapshots.map((snapshot) => snapshot.id));
    for (const domSnapshot of domSnapshots) {
      if (seenSnapshotIds.has(domSnapshot.id) || usedDomSnapshotIds.has(domSnapshot.id)) {
        continue;
      }
      snapshots.push(domSnapshot);
    }
    return snapshots;
  }

  async frameElementReference(frameId: string): Promise<ProtocolElementHandleReference | null> {
    return this.ownerElementReferenceForFrame(frameId);
  }

  private async ownerElementReferenceForFrame(frameId: string): Promise<ProtocolElementHandleReference | null> {
    const { backendNodeId } = await (this.options.client as CdpDomClient).send("DOM.getFrameOwner", {
      frameId
    });
    const parentFrameId = this.nativeFrames.get(frameId)?.parentId ?? undefined;
    const executionContextId = parentFrameId
      ? await this.defaultExecutionContextIdForFrame(parentFrameId).catch(() => undefined)
      : undefined;
    const resolved = await (this.options.client as CdpDomClient).send("DOM.resolveNode", {
      backendNodeId,
      ...(executionContextId !== undefined ? { executionContextId } : {})
    });
    const objectId = resolved.object.objectId;
    if (!objectId || resolved.object.subtype === "null") {
      return null;
    }
    const handle = new CdpJSHandleAdapter<unknown>(this, resolved.object, undefined, parentFrameId);
    return this.storeRemoteElementHandle(handle, { disposeHandle: false });
  }

  private syncNativeFrameTree(root: CdpFrameTreePayload): void {
    const visit = (node: CdpFrameTreePayload) => {
      this.upsertNativeFrame(node.frame);
      node.childFrames?.forEach(visit);
    };
    visit(root);
  }

  private upsertNativeFrame(frame: CdpPageFramePayload): void {
    this.nativeFrames.set(frame.id, {
      id: frame.id,
      name: frame.name ?? this.nativeFrames.get(frame.id)?.name ?? "",
      parentId: frame.parentId ?? null,
      url: frame.url ?? this.nativeFrames.get(frame.id)?.url ?? "about:blank"
    });
  }

  private removeNativeFrame(frameId: string): void {
    this.nativeFrames.delete(frameId);
    for (const frame of Array.from(this.nativeFrames.values())) {
      if (frame.parentId === frameId) {
        this.removeNativeFrame(frame.id);
      }
    }
  }

  private async collectDomFrameSnapshots(): Promise<Array<{
    id: string;
    name: string;
    ownerElementChain: LocatorSelector[];
    parentId: string | null;
    referenceChain: LocatorSelector[];
    url: string;
  }>> {
    return this.evaluate<Array<{
      id: string;
      name: string;
      ownerElementChain: LocatorSelector[];
      parentId: string | null;
      referenceChain: LocatorSelector[];
      url: string;
    }>>(`function() {
      const snapshots = [
        {
          id: "main",
          name: "",
          ownerElementChain: [],
          parentId: null,
          referenceChain: [],
          url: String(globalThis.location?.href || "")
        }
      ];

      const escapeCss = (value) => {
        if ("CSS" in globalThis && typeof CSS.escape === "function") {
          return CSS.escape(value);
        }
        return value.replace(/["\\]/g, "\\$&");
      };

      const cssPath = (element) => {
        if (element.id) {
          return "#" + escapeCss(element.id);
        }

        const segments = [];
        let current = element;
        while (current && current.parentElement) {
          const tag = current.tagName.toLowerCase();
          const siblings = Array.from(current.parentElement.children).filter(
            (child) => child.tagName === current.tagName
          );
          const index = siblings.indexOf(current) + 1;
          segments.unshift(tag + ":nth-of-type(" + index + ")");
          current = current.parentElement;
        }

        return segments.join(" > ");
      };

      const visit = (
        documentRoot,
        parentId,
        chain
      ) => {
        const frames = [];
        const collectFrames = (root) => {
          frames.push(...Array.from(root.querySelectorAll("iframe,frame")));
          for (const element of Array.from(root.querySelectorAll("*"))) {
            if (element.shadowRoot)
              collectFrames(element.shadowRoot);
          }
        };
        collectFrames(documentRoot);
        frames.forEach((frameElement, index) => {
          const iframe = frameElement;
          let contentDocument = null;
          try {
            contentDocument = iframe.contentDocument;
          } catch {
            contentDocument = null;
          }
          const selector = cssPath(iframe);
          const frameId = parentId + "." + (index + 1);
          const ownerElementChain = [
            ...chain,
            { strategy: "css", value: selector }
          ];
          const referenceChain = [
            ...ownerElementChain,
            { strategy: "control", value: "enter-frame" }
          ];
          snapshots.push({
            id: frameId,
            name: iframe.getAttribute("name") ?? iframe.id ?? "",
            ownerElementChain,
            parentId,
            referenceChain,
            url: (() => {
              try {
                return String(iframe.contentWindow?.location?.href || iframe.src || "about:blank");
              } catch {
                return String(iframe.src || "about:blank");
              }
            })()
          });
          if (contentDocument) {
            visit(contentDocument, frameId, referenceChain);
          }
        });
      };

      visit(document, "main", []);
      return snapshots;
    }`, undefined, true);
  }

  async addScriptTag(options?: AddScriptTagOptions): Promise<ProtocolElementHandleAdapter> {
    if (!options?.url && !options?.content) {
      throw new Error("Provide an object with a `url`, `path` or `content` property");
    }

    const handle = options.url
      ? await this.evaluateHandle<HTMLElement>(
        `async (payload) => {
          const script = document.createElement('script');
          script.src = payload.url;
          if (payload.type)
            script.type = payload.type;
          const promise = new Promise((resolve, reject) => {
            script.onload = resolve;
            script.onerror = event => reject(typeof event === 'string' ? new Error(event) : new Error('Failed to load script at ' + script.src));
          });
          document.head.appendChild(script);
          await promise;
          return script;
        }`,
        { url: options.url, type: options.type ?? "" },
        true
      )
      : await this.evaluateHandle<HTMLElement>(
        `(payload) => {
        const script = document.createElement('script');
        script.type = payload.type || 'text/javascript';
        script.text = payload.content;
        let error = null;
        script.onerror = event => error = event;
        document.head.appendChild(script);
        if (error)
          throw error;
        return script;
      }`,
        { content: options.content!, type: options.type ?? "" },
        true
      );
    return new CdpElementHandleAdapter(this, await this.storeRemoteElementHandle(handle));
  }

  async addStyleTag(options?: AddStyleTagOptions): Promise<ProtocolElementHandleAdapter> {
    if (!options?.url && !options?.content) {
      throw new Error("Provide an object with a `url`, `path` or `content` property");
    }

    const handle = options.url
      ? await this.evaluateHandle<HTMLElement>(
        `async (url) => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = url;
          const promise = new Promise((resolve, reject) => {
            link.onload = resolve;
            link.onerror = reject;
          });
          document.head.appendChild(link);
          await promise;
          return link;
        }`,
        options.url,
        true
      )
      : await this.evaluateHandle<HTMLElement>(
        `async (content) => {
          const style = document.createElement('style');
          style.type = 'text/css';
          style.appendChild(document.createTextNode(content));
          const promise = new Promise((resolve, reject) => {
            style.onload = resolve;
            style.onerror = reject;
          });
          document.head.appendChild(style);
          await promise;
          return style;
        }`,
        options.content!,
        true
      );
    return new CdpElementHandleAdapter(this, await this.storeRemoteElementHandle(handle));
  }

  async waitForLoadState(
    state: "load" | "domcontentloaded" | "networkidle" | "commit" = "load",
    timeout = DEFAULT_TIMEOUT_MS,
    frameId?: string,
    options: { skipDocumentReadyStateSync?: boolean } = {}
  ): Promise<void> {
    const targetState = verifyLifecycle("state", state ?? "load");
    if (targetState === "commit") {
      return;
    }

    if (!frameId && !options.skipDocumentReadyStateSync) {
      await this.syncLifecycleStateFromDocument();
    }
    if (this.isStateSatisfied(targetState, frameId)) {
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
        ...(frameId ? { frameId } : {}),
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

  async setExtraHTTPHeaders(headers: { [key: string]: string }): Promise<void> {
    this.pageExtraHTTPHeaders = { ...headers };
    await this.updateExtraHTTPHeaders();
  }

  private resolveNavigationReferer(options: PageGotoOptions, targetUrl: string): string | undefined {
    const headers = mergeExtraHTTPHeaders(
      this.options.contextOptions.extraHTTPHeaders,
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

  async setScreenshotBackgroundColor(color?: { a: number; b: number; g: number; r: number }): Promise<void> {
    await this.options.client.Emulation.setDefaultBackgroundColorOverride(
      color ? { color } : {}
    );
  }

  screenshotClipOrigin(): "document" {
    return "document";
  }

  async screenshot(options: InternalScreenshotOptions = {}): Promise<Buffer> {
    const format = options.type ?? "png";
    const response = await this.options.client.Page.captureScreenshot({
      captureBeyondViewport: !(options.__fitsViewport ?? !options.fullPage),
      ...(options.clip
        ? {
            clip: {
              x: options.clip.x,
              y: options.clip.y,
              width: options.clip.width,
              height: options.clip.height,
              scale: 1
            }
          }
        : {}),
      ...(format === "jpeg"
        ? {
            format,
            ...(options.quality !== undefined ? { quality: options.quality } : {})
          }
        : { format })
    });
    return Buffer.from(response.data, "base64");
  }

  async pdf(options: PdfOptions = {}): Promise<Buffer> {
    const {
      scale = 1,
      displayHeaderFooter = false,
      headerTemplate = "",
      footerTemplate = "",
      printBackground = false,
      landscape = false,
      pageRanges = "",
      preferCSSPageSize = false,
      margin = {},
      tagged = false,
      outline = false
    } = options;

    let paperWidth = 8.5;
    let paperHeight = 11;
    if (options.format) {
      const format = PAGE_PAPER_FORMATS[options.format.toLowerCase()];
      if (!format) {
        throw new Error(`Unknown paper format: ${options.format}`);
      }
      paperWidth = format.width;
      paperHeight = format.height;
    } else {
      paperWidth = convertPrintParameterToInches(options.width) ?? paperWidth;
      paperHeight = convertPrintParameterToInches(options.height) ?? paperHeight;
    }

    const result = await (
      this.options.client as typeof this.options.client & {
        send(
          method: "Page.printToPDF",
          params: {
            displayHeaderFooter: boolean;
            footerTemplate: string;
            generateDocumentOutline: boolean;
            generateTaggedPDF: boolean;
            headerTemplate: string;
            landscape: boolean;
            marginBottom: number;
            marginLeft: number;
            marginRight: number;
            marginTop: number;
            pageRanges: string;
            paperHeight: number;
            paperWidth: number;
            preferCSSPageSize: boolean;
            printBackground: boolean;
            scale: number;
          }
        ): Promise<{ data: string }>;
      }
    ).send("Page.printToPDF", {
      landscape,
      displayHeaderFooter,
      headerTemplate,
      footerTemplate,
      printBackground,
      scale,
      paperWidth,
      paperHeight,
      marginTop: convertPrintParameterToInches(margin.top) ?? 0,
      marginBottom: convertPrintParameterToInches(margin.bottom) ?? 0,
      marginLeft: convertPrintParameterToInches(margin.left) ?? 0,
      marginRight: convertPrintParameterToInches(margin.right) ?? 0,
      pageRanges,
      preferCSSPageSize,
      generateTaggedPDF: tagged,
      generateDocumentOutline: outline
    });

    return Buffer.from(result.data, "base64");
  }

  viewportSize(): ViewportSize | null {
    return this.currentViewportSize;
  }

  async setViewportSize(viewportSize: ViewportSize): Promise<void> {
    await this.options.client.Emulation.setDeviceMetricsOverride({
      width: viewportSize.width,
      height: viewportSize.height,
      mobile: false,
      deviceScaleFactor: 1
    });
    this.currentViewportSize = viewportSize;
  }

  async emulateMedia(options: {
    colorScheme?: "light" | "dark" | "no-preference" | "no-override";
    contrast?: "no-preference" | "more" | "no-override";
    forcedColors?: "active" | "none" | "no-override";
    media?: "screen" | "print" | "no-override";
    reducedMotion?: "reduce" | "no-preference" | "no-override";
  }): Promise<void> {
    const media = options.media === "no-override" ? "" : options.media ?? "";
    const features: Array<{ name: string; value: string }> = [];
    if (options.colorScheme !== undefined && options.colorScheme !== "no-override") {
      features.push({ name: "prefers-color-scheme", value: options.colorScheme });
    }
    if (options.reducedMotion !== undefined && options.reducedMotion !== "no-override") {
      features.push({ name: "prefers-reduced-motion", value: options.reducedMotion });
    }
    if (options.forcedColors !== undefined && options.forcedColors !== "no-override") {
      features.push({ name: "forced-colors", value: options.forcedColors });
    }
    if (options.contrast !== undefined && options.contrast !== "no-override") {
      features.push({ name: "prefers-contrast", value: options.contrast });
    }
    await (
      this.options.client as typeof this.options.client & {
        send(
          method: "Emulation.setEmulatedMedia",
          params: {
            media?: string;
            features?: Array<{ name: string; value: string }>;
          }
        ): Promise<unknown>;
      }
    ).send("Emulation.setEmulatedMedia", {
      media,
      features
    });
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
    await (
      this.options.client as typeof this.options.client & {
        send(method: "HeapProfiler.collectGarbage"): Promise<unknown>;
      }
    ).send("HeapProfiler.collectGarbage");
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

  async tap(selector: LocatorSelector[], options?: TapOptions): Promise<void> {
    const point = await this.resolveActionPoint({ chain: selector }, options, true);
    await this.withPointerActionModifiers(options?.modifiers, async () => {
      if (options?.trial) {
        return;
      }
      await this.touchscreenTap(point.x, point.y);
    });
  }

  on<K extends RawPageEventName>(event: K, listener: RawPageEventListener<K>): () => void {
    const listeners =
      this.eventListeners.get(event) ?? new Set<RawPageEventListener<RawPageEventName>>();
    listeners.add(listener as RawPageEventListener<RawPageEventName>);
    this.eventListeners.set(event, listeners);
    this.replayEarlyEvents(event, listener);

    return () => {
      const registeredListeners = this.eventListeners.get(event);
      registeredListeners?.delete(listener as RawPageEventListener<RawPageEventName>);
      if (registeredListeners?.size === 0) {
        this.eventListeners.delete(event);
      }
    };
  }

  onFileChooserOpened(listener: (payload: {
    element: ProtocolElementHandleReference;
    frameId: string | null;
    isMultiple: boolean;
  }) => void | Promise<void>): () => void {
    this.fileChooserOpenedListeners.add(listener);
    void this.options.client.Page.setInterceptFileChooserDialog?.({
      enabled: true
    }).catch(() => {});
    return () => {
      this.fileChooserOpenedListeners.delete(listener);
      if (!this.fileChooserOpenedListeners.size) {
        void this.options.client.Page.setInterceptFileChooserDialog?.({
          enabled: false
        }).catch(() => {});
      }
    };
  }

  async setRequestInterceptor(
    handler: ((call: RoutedRequestCall) => Promise<RoutedRequestDecision>) | null
  ): Promise<void> {
    this.requestInterceptor = handler;
    const shouldEnable = Boolean(handler);
    if (shouldEnable === this.requestInterceptionEnabled) {
      return;
    }
    this.requestInterceptionEnabled = shouldEnable;
    if (shouldEnable) {
      await this.options.client.Network.setCacheDisabled({ cacheDisabled: true }).catch(() => {});
      await this.options.client.Fetch.enable({
        patterns: [
          {
            urlPattern: "*",
            requestStage: "Request"
          }
        ]
      });
      return;
    }
    void (async () => {
      await Promise.all(
        Array.from(this.pausedFetchRequestIds, async (requestId) => {
          await this.options.client.Fetch.continueRequest({
            requestId
          }).catch(() => {});
        })
      );
      await this.options.client.Network.setCacheDisabled({ cacheDisabled: false }).catch(() => {});
      await this.options.client.Fetch.disable().catch(() => {});
    })();
  }

  async query(selector: LocatorSelector[]): Promise<ProtocolElementHandleAdapter | null> {
    const count = await this.countSelector({
      chain: selector
    });
    if (count === 0) {
      return null;
    }
    const reference = await this.createHandleReference({
      chain: selector,
      pick: { kind: "first" }
    });
    return new CdpElementHandleAdapter(this, reference);
  }

  createHandle(reference: ProtocolElementHandleReference): ProtocolElementHandleAdapter {
    return new CdpElementHandleAdapter(this, reference);
  }

  async queryAll(selector: LocatorSelector[]): Promise<ProtocolElementHandleAdapter[]> {
    const count = await this.countSelector({
      chain: selector
    });
    const handles: ProtocolElementHandleAdapter[] = [];
    for (let index = 0; index < count; index += 1) {
      const reference = await this.createHandleReference({
        chain: selector,
        pick: { kind: "nth", index }
      });
      handles.push(new CdpElementHandleAdapter(this, reference));
    }
    return handles;
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
    return new CdpLocatorAdapter(this, {
      chain: [selector]
    });
  }

  locatorInFrame(frameId: string, selector: LocatorSelector): ProtocolLocatorAdapter {
    return new CdpLocatorAdapter(this, {
      chain: [selector],
      protocolFrameId: frameId
    });
  }

  getByText(text: string | RegExp, options?: { exact?: boolean }): ProtocolLocatorAdapter {
    return new CdpLocatorAdapter(this, {
      chain: [createTextLocatorSelector(text, options)]
    });
  }

  getByAltText(text: string | RegExp, options?: { exact?: boolean }): ProtocolLocatorAdapter {
    return new CdpLocatorAdapter(this, {
      chain: [createAltTextLocatorSelector(text, options)]
    });
  }

  getByLabel(text: string | RegExp, options?: { exact?: boolean }): ProtocolLocatorAdapter {
    return new CdpLocatorAdapter(this, {
      chain: [createLabelLocatorSelector(text, options)]
    });
  }

  getByPlaceholder(
    text: string | RegExp,
    options?: { exact?: boolean }
  ): ProtocolLocatorAdapter {
    return new CdpLocatorAdapter(this, {
      chain: [createPlaceholderLocatorSelector(text, options)]
    });
  }

  getByTestId(testId: string | RegExp): ProtocolLocatorAdapter {
    return new CdpLocatorAdapter(this, {
      chain: [createTestIdLocatorSelector(testId)]
    });
  }

  getByRole(role: string, options?: GetByRoleOptions): ProtocolLocatorAdapter {
    return new CdpLocatorAdapter(this, {
      chain: [createRoleLocatorSelector(role, options)]
    });
  }

  getByTitle(text: string | RegExp, options?: { exact?: boolean }): ProtocolLocatorAdapter {
    return new CdpLocatorAdapter(this, {
      chain: [createTitleLocatorSelector(text, options)]
    });
  }

  async startCSSCoverage(
    options: {
      resetOnNavigation?: boolean;
    } = {}
  ): Promise<void> {
    if (this.cssCoverageState.enabled) {
      throw new Error("CSSCoverage is already enabled");
    }

    this.cssCoverageState.enabled = true;
    this.cssCoverageState.resetOnNavigation = options.resetOnNavigation ?? true;
    this.cssCoverageState.stylesheetUrls.clear();
    this.cssCoverageState.stylesheetSources.clear();

    const onStyleSheetAdded = async (event: {
      header: {
        sourceURL?: string;
        styleSheetId: string;
      };
    }) => {
      const header = event.header;
      if (!header.sourceURL) {
        return;
      }
      try {
        const response = await (
          this.options.client as typeof this.options.client & {
            send(method: "CSS.getStyleSheetText", params: { styleSheetId: string }): Promise<{ text: string }>;
          }
        ).send("CSS.getStyleSheetText", { styleSheetId: header.styleSheetId });
        this.cssCoverageState.stylesheetUrls.set(header.styleSheetId, header.sourceURL);
        this.cssCoverageState.stylesheetSources.set(header.styleSheetId, response.text);
      } catch {}
    };
    const onExecutionContextsCleared = () => {
      if (!this.cssCoverageState.resetOnNavigation) {
        return;
      }
      this.cssCoverageState.stylesheetUrls.clear();
      this.cssCoverageState.stylesheetSources.clear();
    };

    this.attachCoverageListener(this.cssCoverageState, "CSS.styleSheetAdded", onStyleSheetAdded);
    this.attachCoverageListener(
      this.cssCoverageState,
      "Runtime.executionContextsCleared",
      onExecutionContextsCleared
    );

    try {
      await Promise.all([
        (this.options.client as typeof this.options.client & { send(method: "DOM.enable"): Promise<unknown> }).send("DOM.enable"),
        (this.options.client as typeof this.options.client & { send(method: "CSS.enable"): Promise<unknown> }).send("CSS.enable"),
        (this.options.client as typeof this.options.client & {
          send(method: "CSS.startRuleUsageTracking"): Promise<unknown>;
        }).send("CSS.startRuleUsageTracking")
      ]);
    } catch (error) {
      this.detachCoverageListeners(this.cssCoverageState);
      this.cssCoverageState.enabled = false;
      throw error;
    }
  }

  async startJSCoverage(
    options: {
      reportAnonymousScripts?: boolean;
      resetOnNavigation?: boolean;
    } = {}
  ): Promise<void> {
    if (this.jsCoverageState.enabled) {
      throw new Error("JSCoverage is already enabled");
    }

    this.jsCoverageState.enabled = true;
    this.jsCoverageState.resetOnNavigation = options.resetOnNavigation ?? true;
    this.jsCoverageState.reportAnonymousScripts = options.reportAnonymousScripts ?? false;
    this.jsCoverageState.scriptIds.clear();
    this.jsCoverageState.scriptSources.clear();

    const onScriptParsed = async (event: {
      scriptId: string;
      url: string;
    }) => {
      this.jsCoverageState.scriptIds.add(event.scriptId);
      if (!event.url && !this.jsCoverageState.reportAnonymousScripts) {
        return;
      }
      try {
        const response = await (
          this.options.client as typeof this.options.client & {
            send(method: "Debugger.getScriptSource", params: { scriptId: string }): Promise<{ scriptSource: string }>;
          }
        ).send("Debugger.getScriptSource", { scriptId: event.scriptId });
        this.jsCoverageState.scriptSources.set(event.scriptId, response.scriptSource);
      } catch {}
    };
    const onExecutionContextsCleared = () => {
      if (!this.jsCoverageState.resetOnNavigation) {
        return;
      }
      this.jsCoverageState.scriptIds.clear();
      this.jsCoverageState.scriptSources.clear();
    };
    const onDebuggerPaused = () => {
      void (this.options.client as typeof this.options.client & {
        send(method: "Debugger.resume"): Promise<unknown>;
      }).send("Debugger.resume").catch(() => {});
    };

    this.attachCoverageListener(this.jsCoverageState, "Debugger.scriptParsed", onScriptParsed);
    this.attachCoverageListener(
      this.jsCoverageState,
      "Runtime.executionContextsCleared",
      onExecutionContextsCleared
    );
    this.attachCoverageListener(this.jsCoverageState, "Debugger.paused", onDebuggerPaused);

    try {
      await Promise.all([
        (this.options.client as typeof this.options.client & { send(method: "Profiler.enable"): Promise<unknown> }).send("Profiler.enable"),
        (this.options.client as typeof this.options.client & {
          send(
            method: "Profiler.startPreciseCoverage",
            params: { callCount: boolean; detailed: boolean }
          ): Promise<unknown>;
        }).send("Profiler.startPreciseCoverage", { callCount: true, detailed: true }),
        (this.options.client as typeof this.options.client & { send(method: "Debugger.enable"): Promise<unknown> }).send("Debugger.enable"),
        (this.options.client as typeof this.options.client & {
          send(method: "Debugger.setSkipAllPauses", params: { skip: boolean }): Promise<unknown>;
        }).send("Debugger.setSkipAllPauses", { skip: true })
      ]);
    } catch (error) {
      this.detachCoverageListeners(this.jsCoverageState);
      this.jsCoverageState.enabled = false;
      throw error;
    }
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
    if (!this.cssCoverageState.enabled) {
      return [];
    }

    const ruleTrackingResponse = await (
      this.options.client as typeof this.options.client & {
        send(method: "CSS.stopRuleUsageTracking"): Promise<{
          ruleUsage: Array<{
            endOffset: number;
            startOffset: number;
            styleSheetId: string;
            used: boolean;
          }>;
        }>;
      }
    ).send("CSS.stopRuleUsageTracking");
    await Promise.all([
      (this.options.client as typeof this.options.client & { send(method: "CSS.disable"): Promise<unknown> }).send("CSS.disable"),
      (this.options.client as typeof this.options.client & { send(method: "DOM.disable"): Promise<unknown> }).send("DOM.disable")
    ]);
    this.detachCoverageListeners(this.cssCoverageState);
    this.cssCoverageState.enabled = false;

    const styleSheetIdToCoverage = new Map<string, CdpCoverageRange[]>();
    for (const entry of ruleTrackingResponse.ruleUsage) {
      const ranges = styleSheetIdToCoverage.get(entry.styleSheetId) ?? [];
      ranges.push({
        startOffset: entry.startOffset,
        endOffset: entry.endOffset,
        count: entry.used ? 1 : 0
      });
      styleSheetIdToCoverage.set(entry.styleSheetId, ranges);
    }

    const coverage = [];
    for (const styleSheetId of this.cssCoverageState.stylesheetUrls.keys()) {
      const url = this.cssCoverageState.stylesheetUrls.get(styleSheetId)!;
      const text = this.cssCoverageState.stylesheetSources.get(styleSheetId)!;
      coverage.push({
        url,
        text,
        ranges: convertToDisjointCoverageRanges(styleSheetIdToCoverage.get(styleSheetId) ?? [])
      });
    }
    return coverage;
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
    if (!this.jsCoverageState.enabled) {
      return [];
    }

    const profileResponse = await (
      this.options.client as typeof this.options.client & {
        send(method: "Profiler.takePreciseCoverage"): Promise<{
          result: Array<{
            url: string;
            scriptId: string;
            functions: Array<{
              functionName: string;
              isBlockCoverage: boolean;
              ranges: Array<{
                count: number;
                endOffset: number;
                startOffset: number;
              }>;
            }>;
          }>;
        }>;
      }
    ).send("Profiler.takePreciseCoverage");
    await Promise.all([
      (this.options.client as typeof this.options.client & {
        send(method: "Profiler.stopPreciseCoverage"): Promise<unknown>;
      }).send("Profiler.stopPreciseCoverage"),
      (this.options.client as typeof this.options.client & { send(method: "Profiler.disable"): Promise<unknown> }).send("Profiler.disable"),
      (this.options.client as typeof this.options.client & { send(method: "Debugger.disable"): Promise<unknown> }).send("Debugger.disable")
    ]);
    this.detachCoverageListeners(this.jsCoverageState);
    this.jsCoverageState.enabled = false;

    const coverage = [];
    for (const entry of profileResponse.result) {
      if (!this.jsCoverageState.scriptIds.has(entry.scriptId)) {
        continue;
      }
      if (!entry.url && !this.jsCoverageState.reportAnonymousScripts) {
        continue;
      }
      const source = this.jsCoverageState.scriptSources.get(entry.scriptId);
      coverage.push(source ? { ...entry, source } : entry);
    }
    return coverage;
  }

  async screencastStart(options?: {
    size?: {
      width: number;
      height: number;
    };
    quality?: number;
    sendFrames?: boolean;
    record?: boolean;
    annotate?: {
      duration?: number;
      position?: "top-left" | "top" | "top-right" | "bottom-left" | "bottom" | "bottom-right";
      fontSize?: number;
    };
  }): Promise<void> {
    if (this.screencastSession) {
      await this.screencastStop();
    }
    const size = options?.size ?? this.deriveDefaultScreencastSize();
    const quality = options?.quality ?? 90;
    this.screencastSession = {
      quality,
      record: Boolean(options?.record),
      sendFrames: Boolean(options?.sendFrames),
      size
    };
    await this.options.client.Page.startScreencast({
      format: "jpeg",
      quality,
      maxWidth: size.width,
      maxHeight: size.height
    });
  }

  async screencastStop(): Promise<void> {
    if (!this.screencastSession) {
      return;
    }
    this.screencastSession = null;
    await this.options.client.Page.stopScreencast().catch(() => {});
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
    await this.bringToFront();
    const keyDefinition = keyDescriptionForString(key, this.pressedKeyboardModifiers);
    const autoRepeat = this.pressedKeyboardCodes.has(keyDefinition.code);
    const nextModifiers = new Set(this.pressedKeyboardModifiers);
    if (isKeyboardModifier(keyDefinition.key)) {
      nextModifiers.add(keyDefinition.key);
    }
    this.pressedKeyboardCodes.add(keyDefinition.code);
    await this.dispatchKeyboardDown(keyDefinition, nextModifiers, autoRepeat);
    this.pressedKeyboardModifiers.clear();
    for (const modifier of nextModifiers) {
      this.pressedKeyboardModifiers.add(modifier);
    }
  }

  async keyboardInsertText(text: string): Promise<void> {
    await this.bringToFront();
    await this.options.client.Input.insertText({
      text
    });
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
      await delay(options.delay);
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
    await this.bringToFront();
    const chars = [...text];
    for (let index = 0; index < chars.length; index += 1) {
      const character = chars[index]!;
      const charDelay = options?.delay;
      if (isUsKeyboardLayoutKey(character)) {
        await this.keyboardPress(
          character,
          charDelay === undefined ? undefined : { delay: charDelay }
        );
        continue;
      }
      if (charDelay) {
        await delay(charDelay);
      }
      await this.keyboardInsertText(character);
    }
  }

  private async dispatchKeyboardDown(
    keyDefinition: KeyDescription,
    modifiers: Set<string>,
    autoRepeat: boolean
  ): Promise<void> {
    await this.options.client.Input.dispatchKeyEvent({
      type: keyDefinition.text ? "keyDown" : "rawKeyDown",
      key: keyDefinition.key,
      code: keyDefinition.code,
      text: keyDefinition.text,
      unmodifiedText: keyDefinition.text,
      autoRepeat,
      windowsVirtualKeyCode: keyDefinition.keyCodeWithoutLocation,
      modifiers: keyboardModifierMask(modifiers),
      location: keyDefinition.location,
      isKeypad: keyDefinition.location === keypadLocation
    });
  }

  private async dispatchKeyboardUp(keyDefinition: KeyDescription, modifiers: Set<string>): Promise<void> {
    await this.options.client.Input.dispatchKeyEvent({
      type: "keyUp",
      key: keyDefinition.key,
      code: keyDefinition.code,
      windowsVirtualKeyCode: keyDefinition.keyCodeWithoutLocation,
      modifiers: keyboardModifierMask(modifiers),
      location: keyDefinition.location
    });
  }

  async keyboardUp(key: string): Promise<void> {
    await this.bringToFront();
    const keyDefinition = keyDescriptionForString(key, this.pressedKeyboardModifiers);
    const nextModifiers = new Set(this.pressedKeyboardModifiers);
    if (isKeyboardModifier(keyDefinition.key)) {
      nextModifiers.delete(keyDefinition.key);
    }
    this.pressedKeyboardCodes.delete(keyDefinition.code);
    await this.dispatchKeyboardUp(keyDefinition, nextModifiers);
    this.pressedKeyboardModifiers.clear();
    for (const modifier of nextModifiers) {
      this.pressedKeyboardModifiers.add(modifier);
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
    await this.enqueuePointerAction(async () => {
      await this.bringToFront();
      const point = { x, y };
      const button = options?.button ?? "left";
      const clickCount = options?.clickCount ?? 1;

      await this.moveMouseInternal(point);
      for (let index = 0; index < clickCount; index += 1) {
        await this.dispatchMouseDown(point, button, index + 1);
        await delay(options?.delay ?? 0);
        await this.dispatchMouseUp(point, button, index + 1);
      }
    });
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
    await this.enqueuePointerAction(async () => {
      await this.bringToFront();
      await this.dispatchMouseDown(
        this.currentMousePosition,
        options?.button ?? "left",
        options?.clickCount ?? 1
      );
    });
  }

  async mouseMove(
    x: number,
    y: number,
    options?: {
      steps?: number;
    }
  ): Promise<void> {
    await this.enqueuePointerAction(async () => {
      await this.bringToFront();
      await this.performMouseMoveTo({ x, y }, options);
    });
  }

  async mouseUp(
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
    }
  ): Promise<void> {
    await this.enqueuePointerAction(async () => {
      await this.bringToFront();
      await this.dispatchMouseUp(
        this.currentMousePosition,
        options?.button ?? "left",
        options?.clickCount ?? 1
      );
    });
  }

  async mouseWheel(deltaX: number, deltaY: number): Promise<void> {
    await this.enqueuePointerAction(async () => {
      await this.bringToFront();
      await this.dispatchMouseEvent({
        type: "mouseWheel",
        x: this.currentMousePosition.x,
        y: this.currentMousePosition.y,
        button: "none",
        buttons: mouseButtonsMask(this.pressedMouseButtons),
        deltaX,
        deltaY,
        modifiers: keyboardModifierMask(this.pressedKeyboardModifiers)
      });
    });
  }

  async touchscreenTap(x: number, y: number): Promise<void> {
    const modifiers = keyboardModifierMask(this.activePointerModifiers());
    await (
      this.options.client.Input as typeof this.options.client.Input & {
        dispatchTouchEvent(options: {
          type: "touchStart" | "touchEnd";
          touchPoints: Array<{ x: number; y: number }>;
          modifiers?: number;
        }): Promise<unknown>;
      }
    ).dispatchTouchEvent({
      type: "touchStart",
      touchPoints: [{ x: Math.round(x), y: Math.round(y) }],
      modifiers
    });
    await (
      this.options.client.Input as typeof this.options.client.Input & {
        dispatchTouchEvent(options: {
          type: "touchStart" | "touchEnd";
          touchPoints: Array<{ x: number; y: number }>;
          modifiers?: number;
        }): Promise<unknown>;
      }
    ).dispatchTouchEvent({
      type: "touchEnd",
      touchPoints: [],
      modifiers
    });
    this.currentMousePosition = { x, y };
  }

  async close(options: PageCloseOptions = {}): Promise<void> {
    if (options.runBeforeUnload) {
      this.pendingRunBeforeUnloadCloseCount += 1;
      try {
        await (this.options.client.Page as typeof this.options.client.Page & {
          close(): Promise<void>;
        }).close();
      } finally {
        this.pendingRunBeforeUnloadCloseCount = Math.max(0, this.pendingRunBeforeUnloadCloseCount - 1);
      }
      return;
    }

    if (this.closed) {
      return;
    }

    this.closeReason = options.reason;
    this.closed = true;
    if (this.jsCoverageState.enabled) {
      void this.stopJSCoverage().catch(() => {});
    }
    if (this.cssCoverageState.enabled) {
      void this.stopCSSCoverage().catch(() => {});
    }
    if (this.screencastSession) {
      void this.screencastStop().catch(() => {});
    }
    this.resetScreencastActions();
    for (const overlay of this.screencastOverlays.values()) {
      if (overlay.removeTimer) {
        clearTimeout(overlay.removeTimer);
      }
    }
    this.screencastOverlays.clear();
    this.clearNetworkIdleTimer();
    this.rejectWaiters(this.createClosedError());
    this.emit("close", undefined);
    this.resolveCloseSignal();

    try {
      await this.options.browserClient.Target.closeTarget({
        targetId: this.options.targetId
      }).catch((error) => {
        if (String(error).includes("No target with given id found") || isClosedCdpConnectionError(error)) {
          return;
        }
        throw error;
      });
    } finally {
      await safelyCloseClient(this.options.client);
      this.options.onClosed(this.options.targetId);
    }
  }

  async bringToFront(): Promise<void> {
    await this.options.browserClient.Target.activateTarget({
      targetId: this.options.targetId
    });
  }

  isClosed(): boolean {
    return this.closed;
  }

  async clickLocator(locator: CdpLocatorState, options?: ClickOptions): Promise<void> {
    if (!options?.__roxyBeforeActionRetry) {
      await this.enqueuePointerAction(async () => {
        await this.bringToFront();
        const actionPoint = await this.resolveActionPoint(locator, options, true);
        const button = options?.button ?? "left";
        const clickCount = options?.clickCount ?? 1;
        await this.withPointerActionModifiers(options?.modifiers, async () => {
          await this.performMouseMoveTo(actionPoint, options);
          await this.resolveActionPoint(locator, options, true);
          if (options?.trial) {
            return;
          }
          void this.showScreencastAction("click", actionPoint).catch(() => {});
          for (let index = 0; index < clickCount; index += 1) {
            await this.dispatchMouseDown(actionPoint, button, index + 1);
            await delay(options?.delay ?? 0);
            await this.dispatchMouseUp(actionPoint, button, index + 1);
          }
        });
      });
      return;
    }

    while (true) {
      const actionPoint = await this.resolveActionPoint(locator, options, true);
      const button = options?.button ?? "left";
      const clickCount = options?.clickCount ?? 1;

      await this.enqueuePointerAction(async () => {
        await this.withPointerActionModifiers(options?.modifiers, async () => {
          await this.performMouseMoveTo(actionPoint, options);
        });
      });

      if (await options?.__roxyBeforeActionRetry?.()) {
        await this.enqueuePointerAction(async () => {
          await this.moveMouseInternal({ x: 0, y: 0 });
        });
        continue;
      }
      await this.resolveActionPoint(locator, options, true);

      await this.enqueuePointerAction(async () => {
        await this.withPointerActionModifiers(options?.modifiers, async () => {
          await this.performMouseMoveTo(actionPoint, options);
        });
      });
      await options?.__roxyBeforeActionRetry?.();
      await this.resolveActionPoint(locator, options, true);

      await this.enqueuePointerAction(async () => {
        await this.withPointerActionModifiers(options?.modifiers, async () => {
          if (options?.trial) {
            return;
          }
          void this.showScreencastAction("click", actionPoint).catch(() => {});
          for (let index = 0; index < clickCount; index += 1) {
            await this.dispatchMouseDown(actionPoint, button, index + 1);
            await delay(options?.delay ?? 0);
            await this.dispatchMouseUp(actionPoint, button, index + 1);
          }
        });
      });
      return;
    }
  }

  async hoverLocator(locator: CdpLocatorState, options?: HoverOptions): Promise<void> {
    if (!options?.__roxyBeforeActionRetry) {
      await this.enqueuePointerAction(async () => {
        await this.bringToFront();
        const actionPoint = await this.resolveActionPoint(locator, options);
        await this.withPointerActionModifiers(options?.modifiers, async () => {
          await this.performMouseMoveTo(actionPoint, options);
        });
      });
      return;
    }

    while (true) {
      const actionPoint = await this.resolveActionPoint(locator, options);
      await this.enqueuePointerAction(async () => {
        await this.withPointerActionModifiers(options?.modifiers, async () => {
          await this.performMouseMoveTo(actionPoint, options);
        });
      });
      if (await options?.__roxyBeforeActionRetry?.()) {
        await this.enqueuePointerAction(async () => {
          await this.moveMouseInternal({ x: 0, y: 0 });
        });
        continue;
      }
      return;
    }
  }

  async fillLocator(
    locator: CdpLocatorState,
    value: string,
    options?: FillOptions
  ): Promise<void> {
    try {
      const actionPoint = await this.resolveActionPoint(locator);
      void this.showScreencastAction("fill", actionPoint).catch(() => {});
    } catch {}
    await this.runFillLocatorWithRetry(locator, value, options);
  }

  private async runFillLocatorWithRetry(
    locator: CdpLocatorState,
    value: string,
    options?: FillOptions
  ): Promise<void> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
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
        await delay(50);
      }
    }
  }

  async typeLocator(
    locator: CdpLocatorState,
    value: string,
    options?: TypeOptions
  ): Promise<void> {
    await this.runLocatorOperation<boolean>(locator, {
      operation: "focus",
      resetSelectionIfNotFocused: true
    });

    await this.keyboardType(value, options);
  }

  async pressLocator(
    locator: CdpLocatorState,
    key: string,
    options?: PressOptions
  ): Promise<void> {
    await this.runLocatorOperation<boolean>(locator, {
      operation: "focus",
      resetSelectionIfNotFocused: true
    });

    await this.keyboardPress(key, options);
  }

  async dblclickLocator(locator: CdpLocatorState, options?: ClickOptions): Promise<void> {
    await this.clickLocator(locator, { ...options, clickCount: 2 });
  }

  async checkLocator(locator: CdpLocatorState, options?: ClickOptions): Promise<void> {
    await this.setCheckedLocator(locator, true, options);
  }

  async uncheckLocator(locator: CdpLocatorState, options?: ClickOptions): Promise<void> {
    await this.setCheckedLocator(locator, false, options);
  }

  private async setCheckedLocator(locator: CdpLocatorState, checked: boolean, options?: ClickOptions): Promise<void> {
    const initialState = await this.checkedStateDetailsLocator(locator);
    if (initialState.matches === checked) {
      return;
    }
    if (!checked && initialState.isRadio) {
      throw new Error("Cannot uncheck radio button");
    }
    await this.clickLocator(locator, options);
    if (options?.trial) {
      return;
    }
    if (await this.checkedStateLocator(locator) !== checked) {
      throw new Error(`Clicking the checkbox did not change its state`);
    }
  }

  private async checkedStateLocator(locator: CdpLocatorState): Promise<boolean> {
    return this.runLocatorOperation<boolean>(locator, {
      operation: "checkedState"
    });
  }

  private async checkedStateDetailsLocator(locator: CdpLocatorState): Promise<CheckedStateDetails> {
    return this.runLocatorOperation<CheckedStateDetails>(locator, {
      operation: "checkedStateDetails"
    });
  }

  async focusLocator(locator: CdpLocatorState): Promise<void> {
    await this.runLocatorOperation<boolean>(locator, {
      operation: "focus"
    });
  }

  async getAttributeLocator(locator: CdpLocatorState, name: string): Promise<string | null> {
    return this.runLocatorOperation<string | null>(locator, {
      operation: "getAttribute",
      name
    });
  }

  async innerHTMLLocator(locator: CdpLocatorState): Promise<string> {
    return this.runLocatorOperation<string>(locator, {
      operation: "innerHTML"
    });
  }

  async innerTextLocator(locator: CdpLocatorState): Promise<string> {
    return this.runLocatorOperation<string>(locator, {
      operation: "innerText"
    });
  }

  async inputValueLocator(locator: CdpLocatorState): Promise<string> {
    return this.runLocatorOperation<string>(locator, {
      operation: "inputValue"
    });
  }

  async isCheckedLocator(locator: CdpLocatorState): Promise<boolean> {
    return this.runLocatorOperation<boolean>(locator, {
      operation: "isChecked"
    });
  }

  async isDisabledLocator(locator: CdpLocatorState): Promise<boolean> {
    return this.runLocatorOperation<boolean>(locator, {
      operation: "isDisabled"
    });
  }

  async isEditableLocator(locator: CdpLocatorState): Promise<boolean> {
    return this.runLocatorOperation<boolean>(locator, {
      operation: "isEditable"
    });
  }

  async isEnabledLocator(locator: CdpLocatorState): Promise<boolean> {
    return this.runLocatorOperation<boolean>(locator, {
      operation: "isEnabled"
    });
  }

  async selectOptionLocator(
    locator: CdpLocatorState,
    values: NormalizedSelectOption[],
    options?: { timeout?: number }
  ): Promise<string[]> {
    return this.runSelectOptionWithRetry(() => this.runLocatorOperation<string[] | SelectOptionRetryResult>(locator, {
      operation: "selectOption",
      values
    }), options?.timeout);
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

  private async applyContextOptions(): Promise<void> {
    const { contextOptions, client } = this.options;

    if (contextOptions.viewport) {
      await this.setViewportSize(contextOptions.viewport);
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

    if (contextOptions.extraHTTPHeaders) {
      await this.updateExtraHTTPHeaders();
    }
  }

  private async updateExtraHTTPHeaders(): Promise<void> {
    const headers = mergeExtraHTTPHeaders(
      this.options.contextOptions.extraHTTPHeaders,
      this.pageExtraHTTPHeaders
    );
    await (
      this.options.client.Network as typeof this.options.client.Network & {
        setExtraHTTPHeaders(params: { headers: Record<string, string> }): Promise<unknown>;
      }
    ).setExtraHTTPHeaders({ headers });
  }

  private async dispatchMouseMove(point: ActionPoint): Promise<void> {
    await this.dispatchMouseEvent({
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: this.lastMouseButton,
      buttons: mouseButtonsMask(this.pressedMouseButtons),
      modifiers: keyboardModifierMask(this.activePointerModifiers()),
      force: this.pressedMouseButtons.size > 0 ? 0.5 : 0
    });
  }

  private async moveMouseInternal(point: ActionPoint): Promise<void> {
    await this.dispatchMouseMove(point);
    this.currentMousePosition = point;
  }

  private async performMouseMoveTo(
    point: ActionPoint,
    options?: HoverOptions & {
      steps?: number;
    }
  ): Promise<void> {
    const start = this.currentMousePosition;
    const steps = Math.max(options?.steps ?? 1, 1);
    for (let index = 1; index <= steps; index += 1) {
      await this.moveMouseInternal(interpolateMousePoint(start, point, index / steps));
    }
  }

  private async dispatchMouseDown(
    point: ActionPoint,
    button: MouseButton,
    clickCount: number
  ): Promise<void> {
    this.lastMouseButton = button;
    this.pressedMouseButtons.add(button);
    await this.dispatchMouseEvent({
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button,
      buttons: mouseButtonsMask(this.pressedMouseButtons),
      clickCount,
      modifiers: keyboardModifierMask(this.activePointerModifiers()),
      force: this.pressedMouseButtons.size > 0 ? 0.5 : 0
    });
  }

  private async dispatchMouseUp(
    point: ActionPoint,
    button: MouseButton,
    clickCount: number
  ): Promise<void> {
    this.lastMouseButton = "none";
    this.pressedMouseButtons.delete(button);
    await this.dispatchMouseEvent({
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button,
      buttons: mouseButtonsMask(this.pressedMouseButtons),
      clickCount,
      modifiers: keyboardModifierMask(this.activePointerModifiers())
    });
  }

  private async dispatchMouseEvent(params: CdpDispatchMouseEventParams): Promise<void> {
    await (this.options.client as CdpClient & {
      send(method: "Input.dispatchMouseEvent", params: CdpDispatchMouseEventParams): Promise<unknown>;
    }).send("Input.dispatchMouseEvent", params);
  }

  private activePointerModifiers(): Iterable<string> {
    return this.pointerActionModifiers ?? this.pressedKeyboardModifiers;
  }

  private navigationClient(): CdpClient {
    const mainFrameId = this.mainFrameId;
    const sessionId =
      (mainFrameId ? this.defaultExecutionContextSessionByFrameId.get(mainFrameId) : undefined)
      ?? (mainFrameId ? this.frameSessionIds.get(mainFrameId) : undefined);
    return sessionId
      ? createSessionTargetClient(this.options.browserClient, sessionId)
      : this.options.client;
  }

  private async withPointerActionModifiers<TResult>(
    modifiers: KeyboardModifier[] | undefined,
    action: () => Promise<TResult>
  ): Promise<TResult> {
    const previous = this.pointerActionModifiers;
    const actionModifiers = new Set(this.pressedKeyboardModifiers);
    for (const modifier of modifiers ?? []) {
      const normalized = resolveSmartModifierString(modifier);
      if (isKeyboardModifier(normalized)) {
        actionModifiers.add(normalized);
      }
    }
    try {
      this.pointerActionModifiers = actionModifiers;
      return await action();
    } finally {
      this.pointerActionModifiers = previous;
    }
  }

  private async enqueuePointerAction<TResult>(action: () => Promise<TResult>): Promise<TResult> {
    return this.raceWithClose(this.options.pointerActionScheduler.enqueue(action));
  }

  private attachCoverageListener(
    state: { eventListeners: Array<{ event: string; listener: (...args: any[]) => void }> },
    event: string,
    listener: (...args: any[]) => void
  ): void {
    this.options.client.on(event, listener);
    state.eventListeners.push({ event, listener });
  }

  private detachCoverageListeners(
    state: { eventListeners: Array<{ event: string; listener: (...args: any[]) => void }> }
  ): void {
    const clientWithRemoveListener = this.options.client as typeof this.options.client & {
      removeListener(event: string, listener: (...args: any[]) => void): void;
    };
    for (const entry of state.eventListeners) {
      clientWithRemoveListener.removeListener(entry.event, entry.listener);
    }
    state.eventListeners = [];
  }

  private async resolveActionPoint(
    locator: CdpLocatorState,
    options?: HoverOptions,
    waitForEnabled = false
  ): Promise<ActionPoint> {
    const reference = {
      chain: locator.chain,
      ...(locator.protocolFrameId ? { protocolFrameId: locator.protocolFrameId } : {}),
      ...(locator.pick ? { pick: locator.pick } : {})
    };
    try {
      return await this.resolveActionPointReference(reference, options, waitForEnabled);
    } catch (error) {
      throw wrapLocatorError(locator, error);
    }
  }

  private async resolveActionPointReference(
    reference: ProtocolElementHandleReference,
    options?: HoverOptions,
    waitForEnabled = false
  ): Promise<ActionPoint> {
    const payload: SelectorRuntimePayload = {
      operation: "actionPoint",
      reference,
      ...(options?.force !== undefined ? { force: options.force } : {}),
      ...(options?.position ? { position: options.position } : {}),
      ...(waitForEnabled ? { waitForEnabled } : {})
    };
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    if (options?.force || timeout <= 0) {
      return this.runSelectorOperation<ActionPoint>(payload);
    }
    const deadline = Date.now() + timeout;
    let lastError: unknown;
    while (Date.now() <= deadline) {
      try {
        return await this.runSelectorOperation<ActionPoint>(payload);
      } catch (error) {
        lastError = error;
        if (!shouldRetryActionPointError(error)) {
          throw error;
        }
        await options?.__roxyBeforeActionRetry?.();
        await delay(50);
      }
    }
    void lastError;
    throw new TimeoutError(`Timeout ${timeout}ms exceeded.`);
  }

  async runLocatorOperation<TResult>(
    locator: CdpLocatorState,
    payload: Omit<SelectorRuntimePayload, "reference">
  ): Promise<TResult> {
    try {
      return await this.runSelectorOperation<TResult>({
        ...payload,
        reference: {
          chain: locator.chain,
          ...(locator.protocolFrameId ? { protocolFrameId: locator.protocolFrameId } : {}),
          ...(locator.pick ? { pick: locator.pick } : {})
        }
      });
    } catch (error) {
      throw wrapLocatorError(locator, error);
    }
  }

  private async runSelectOptionWithRetry(
    action: () => Promise<string[] | SelectOptionRetryResult>,
    timeout: number | undefined
  ): Promise<string[]> {
    const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + effectiveTimeout;
    while (true) {
      const result = await action();
      if (!isSelectOptionRetryResult(result)) {
        return result;
      }
      if (effectiveTimeout === 0 || Date.now() + 50 > deadline) {
        throw new TimeoutError(`page.selectOption: Timeout ${effectiveTimeout}ms exceeded.`);
      }
      await delay(50);
    }
  }

  async countSelector(reference: ProtocolElementHandleReference): Promise<number> {
    return this.runSelectorOperation<number>({
      operation: "count",
      reference
    });
  }

  async boundingBoxReference(reference: ProtocolElementHandleReference): Promise<Rect | null> {
    const boxModel = await this.boundingBoxReferenceViaDom(reference);
    if (boxModel) {
      return boxModel;
    }
    return this.runSelectorOperation<Rect | null>({
      operation: "boundingBox",
      reference
    });
  }

  async contentFrameIdForReference(reference: ProtocolElementHandleReference): Promise<string | null> {
    if (reference.protocolObjectId) {
      try {
        const nodeInfo = await (this.options.client as CdpDomClient).send("DOM.describeNode", {
          objectId: reference.protocolObjectId
        }, reference.protocolSessionId);
        if (nodeInfo.node.nodeName !== "IFRAME" && nodeInfo.node.nodeName !== "FRAME") {
          return null;
        }
        return typeof nodeInfo.node.frameId === "string" ? nodeInfo.node.frameId : null;
      } catch {
        return null;
      }
    }

    let handle: CdpJSHandleAdapter<unknown> | null = null;
    try {
      handle = await this.resolveElementReferenceAsHandle(reference);
      const nodeName = await handle.evaluate<string | null>(
        "(node) => node && (node.nodeName === 'IFRAME' || node.nodeName === 'FRAME') ? node.nodeName : null",
        undefined,
        true
      );
      if (!nodeName) {
        return null;
      }
      const objectId = handle.remoteObjectId();
      if (!objectId) {
        return null;
      }
      const nodeInfo = await (this.options.client as CdpDomClient).send("DOM.describeNode", {
        objectId
      }, handle.sessionId());
      return typeof nodeInfo.node.frameId === "string" ? nodeInfo.node.frameId : null;
    } catch {
      return null;
    } finally {
      await handle?.dispose().catch(() => {});
    }
  }

  async ownerFrameIdForReference(reference: ProtocolElementHandleReference): Promise<string | null> {
    if (reference.protocolObjectId) {
      let documentElementObjectId: string | undefined;
      try {
        const response = await this.sendRuntimeCallFunctionOn({
          functionDeclaration: `function() {
            const doc = this;
            if (doc && doc.documentElement && doc.documentElement.ownerDocument === doc)
              return doc.documentElement;
            return this && this.ownerDocument ? this.ownerDocument.documentElement : null;
          }`,
          objectId: reference.protocolObjectId,
          returnByValue: false,
          awaitPromise: true,
          userGesture: true
        }, reference.protocolSessionId);
        if (response.exceptionDetails) {
          return null;
        }
        documentElementObjectId = response.result.objectId;
        if (!documentElementObjectId) {
          return null;
        }
        const nodeInfo = await (this.options.client as CdpDomClient).send("DOM.describeNode", {
          objectId: documentElementObjectId
        }, reference.protocolSessionId);
        return typeof nodeInfo.node.frameId === "string" ? nodeInfo.node.frameId : null;
      } catch {
        return null;
      } finally {
        if (documentElementObjectId) {
          await this.sendRuntimeReleaseObject(
            { objectId: documentElementObjectId },
            reference.protocolSessionId
          ).catch(() => {});
        }
      }
    }

    let handle: CdpJSHandleAdapter<unknown> | null = null;
    let documentElement: ProtocolJSHandleAdapter<unknown> | null = null;
    try {
      handle = await this.resolveElementReferenceAsHandle(reference);
      documentElement = await handle.evaluateHandle<unknown>(`(node) => {
        const doc = node;
        if (doc && doc.documentElement && doc.documentElement.ownerDocument === doc)
          return doc.documentElement;
        return node && node.ownerDocument ? node.ownerDocument.documentElement : null;
      }`, undefined, true);
      const objectId = documentElement.remoteObjectId();
      if (!objectId) {
        return null;
      }
      const sessionId = documentElement instanceof CdpJSHandleAdapter
        ? documentElement.sessionId()
        : handle.sessionId();
      const nodeInfo = await (this.options.client as CdpDomClient).send("DOM.describeNode", {
        objectId
      }, sessionId);
      return typeof nodeInfo.node.frameId === "string" ? nodeInfo.node.frameId : null;
    } catch {
      return null;
    } finally {
      await Promise.resolve(documentElement?.dispose()).catch(() => {});
      await handle?.dispose().catch(() => {});
    }
  }

  private async boundingBoxReferenceViaDom(
    reference: ProtocolElementHandleReference
  ): Promise<Rect | null> {
    let handle: CdpJSHandleAdapter<unknown> | null = null;
    try {
      handle = await this.resolveElementReferenceAsHandle(reference);
      const objectId = handle.remoteObjectId();
      if (!objectId) {
        return null;
      }
      const result = await (this.options.client as CdpDomClient).send("DOM.getBoxModel", {
        objectId
      });
      const quad = result.model.border;
      const x = Math.min(quad[0], quad[2], quad[4], quad[6]);
      const y = Math.min(quad[1], quad[3], quad[5], quad[7]);
      const width = Math.max(quad[0], quad[2], quad[4], quad[6]) - x;
      const height = Math.max(quad[1], quad[3], quad[5], quad[7]) - y;
      if (width <= 0 || height <= 0) {
        return null;
      }
      return {
        x,
        y,
        width,
        height
      };
    } catch {
      return null;
    } finally {
      await handle?.dispose().catch(() => {});
    }
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
    if (reference.handleId) {
      return reference;
    }
    const result = await this.runSelectorOperation<{ handleId: string }>({
      operation: "createHandle",
      reference,
      ...(missingMessage ? { missingMessage } : {})
    });
    return {
      chain: [],
      handleId: result.handleId,
      ...(reference.protocolFrameId ? { protocolFrameId: reference.protocolFrameId } : {}),
      ...(reference.protocolObjectId ? { protocolObjectId: reference.protocolObjectId } : {}),
      ...(reference.protocolSessionId ? { protocolSessionId: reference.protocolSessionId } : {})
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
    if (!options?.__roxyBeforeActionRetry) {
      await this.enqueuePointerAction(async () => {
        await this.bringToFront();
        const actionPoint = await this.resolveActionPointReference(reference, options, true);
        const button = options?.button ?? "left";
        const clickCount = options?.clickCount ?? 1;
        await this.withPointerActionModifiers(options?.modifiers, async () => {
          await this.performMouseMoveTo(actionPoint, options);
          await this.resolveActionPointReference(reference, options, true);
          if (options?.trial) {
            return;
          }
          void this.showScreencastAction("click", actionPoint).catch(() => {});
          for (let index = 0; index < clickCount; index += 1) {
            await this.dispatchMouseDown(actionPoint, button, index + 1);
            await delay(options?.delay ?? 0);
            await this.dispatchMouseUp(actionPoint, button, index + 1);
          }
        });
      });
      return;
    }

    while (true) {
      const actionPoint = await this.resolveActionPointReference(reference, options, true);
      const button = options?.button ?? "left";
      const clickCount = options?.clickCount ?? 1;

      await this.enqueuePointerAction(async () => {
        await this.withPointerActionModifiers(options?.modifiers, async () => {
          await this.performMouseMoveTo(actionPoint, options);
        });
      });

      if (await options?.__roxyBeforeActionRetry?.()) {
        await this.enqueuePointerAction(async () => {
          await this.moveMouseInternal({ x: 0, y: 0 });
        });
        continue;
      }
      await this.resolveActionPointReference(reference, options, true);

      await this.enqueuePointerAction(async () => {
        await this.withPointerActionModifiers(options?.modifiers, async () => {
          await this.performMouseMoveTo(actionPoint, options);
        });
      });
      await options?.__roxyBeforeActionRetry?.();
      await this.resolveActionPointReference(reference, options, true);

      await this.enqueuePointerAction(async () => {
        await this.withPointerActionModifiers(options?.modifiers, async () => {
          if (options?.trial) {
            return;
          }
          void this.showScreencastAction("click", actionPoint).catch(() => {});
          for (let index = 0; index < clickCount; index += 1) {
            await this.dispatchMouseDown(actionPoint, button, index + 1);
            await delay(options?.delay ?? 0);
            await this.dispatchMouseUp(actionPoint, button, index + 1);
          }
        });
      });
      return;
    }
  }

  async tapReference(reference: ProtocolElementHandleReference, options?: TapOptions): Promise<void> {
    const point = await this.resolveActionPointReference(reference, options, true);
    await this.withPointerActionModifiers(options?.modifiers, async () => {
      if (options?.trial) {
        return;
      }
      await this.touchscreenTap(point.x, point.y);
    });
  }

  async setCheckedReference(
    reference: ProtocolElementHandleReference,
    checked: boolean,
    options?: ClickOptions
  ): Promise<void> {
    const initialState = await this.checkedStateDetailsReference(reference);
    if (initialState.matches === checked) {
      return;
    }
    if (!checked && initialState.isRadio) {
      throw new Error("Cannot uncheck radio button");
    }
    await this.clickReference(reference, options);
    if (options?.trial) {
      return;
    }
    if (await this.checkedStateReference(reference) !== checked) {
      throw new Error(`Clicking the checkbox did not change its state`);
    }
  }

  private async checkedStateReference(reference: ProtocolElementHandleReference): Promise<boolean> {
    return this.runSelectorOperation<boolean>({
      operation: "checkedState",
      reference
    });
  }

  private async checkedStateDetailsReference(reference: ProtocolElementHandleReference): Promise<CheckedStateDetails> {
    return this.runSelectorOperation<CheckedStateDetails>({
      operation: "checkedStateDetails",
      reference
    });
  }

  async hoverReference(reference: ProtocolElementHandleReference, options?: HoverOptions): Promise<void> {
    if (!options?.__roxyBeforeActionRetry) {
      await this.enqueuePointerAction(async () => {
        await this.bringToFront();
        const actionPoint = await this.resolveActionPointReference(reference, options);
        await this.withPointerActionModifiers(options?.modifiers, async () => {
          await this.performMouseMoveTo(actionPoint, options);
        });
      });
      return;
    }

    while (true) {
      const actionPoint = await this.resolveActionPointReference(reference, options);
      await this.enqueuePointerAction(async () => {
        await this.withPointerActionModifiers(options?.modifiers, async () => {
          await this.performMouseMoveTo(actionPoint, options);
        });
      });
      if (await options?.__roxyBeforeActionRetry?.()) {
        await this.enqueuePointerAction(async () => {
          await this.moveMouseInternal({ x: 0, y: 0 });
        });
        continue;
      }
      return;
    }
  }

  async fillReference(
    reference: ProtocolElementHandleReference,
    value: string,
    options?: FillOptions
  ): Promise<void> {
    try {
      const actionPoint = await this.runSelectorOperation<ActionPoint>({
        operation: "actionPoint",
        reference
      });
      void this.showScreencastAction("fill", actionPoint).catch(() => {});
    } catch {}
    await this.runSelectorOperation<boolean>({
      operation: "fill",
      reference,
      value,
      ...(options?.force !== undefined ? { force: options.force } : {}),
      timeoutMs: options?.timeout ?? DEFAULT_TIMEOUT_MS
    });
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
    const protocolFrameId = payload.reference.protocolFrameId;
    if (protocolFrameId) {
      return await this.evaluateWithArgumentsInFrame<TResult>(
        protocolFrameId,
        SELECTOR_RUNTIME_SOURCE,
        true,
        [payload],
        true
      );
    }
    return this.evaluateFunction<TResult>(SELECTOR_RUNTIME_SOURCE, payload);
  }

  private setScreencastOverlay(
    id: string,
    overlay: Omit<CdpScreencastOverlayState, "removeTimer">,
    duration?: number
  ): void {
    this.clearScreencastOverlay(id);
    const state: CdpScreencastOverlayState = { ...overlay };
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

  private clearScreencastActionAnnotation(): void {
    this.screencastActionAbortController?.abort();
    this.screencastActionAbortController = null;
    this.screencastActionAnnotation = null;
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

  private deriveDefaultScreencastSize(): {
    width: number;
    height: number;
  } {
    const viewport = this.currentViewportSize ?? this.options.contextOptions.viewport ?? {
      width: 800,
      height: 600
    };
    const scale = Math.min(1, 800 / Math.max(viewport.width, viewport.height));
    return {
      width: Math.max(2, Math.floor(viewport.width * scale)) & ~1,
      height: Math.max(2, Math.floor(viewport.height * scale)) & ~1
    };
  }

  private async evaluateExpression<TResult>(expression: string): Promise<TResult> {
    const response = await this.raceWithClose(
      (this.options.client as CdpRuntimeClient).send("Runtime.evaluate", {
        expression: wrapWithSerializedEvaluationResult(expression),
        returnByValue: true,
        awaitPromise: true
      })
    );

    if (response.exceptionDetails) {
      throw new Error(formatCdpEvaluationError(response));
    }

    return parseSerializedEvaluationResult<TResult>(response.result.value as never);
  }

  private async evaluateFunction<TResult>(
    expression: string,
    arg?: unknown
  ): Promise<TResult> {
    return this.evaluateWithArguments<TResult>(
      expression,
      true,
      arg === undefined ? [] : [arg],
      true
    );
  }

  async evaluateWithArguments<TResult>(
    expression: string,
    returnByValue: true,
    args: unknown[],
    isFunction: boolean
  ): Promise<TResult>;
  async evaluateWithArguments<TResult>(
    expression: string,
    returnByValue: false,
    args: unknown[],
    isFunction: boolean
  ): Promise<ProtocolJSHandleAdapter<TResult>>;
  async evaluateWithArguments<TResult>(
    expression: string,
    returnByValue: boolean,
    args: unknown[],
    isFunction: boolean
  ): Promise<TResult | ProtocolJSHandleAdapter<TResult>> {
    if (this.mainFrameId) {
      try {
        return await this.evaluateWithArgumentsInFrame<TResult>(
          this.mainFrameId,
          expression,
          returnByValue,
          args,
          isFunction
        );
      } catch (error) {
        if (!isFrameExecutionContextTransitionError(error)) {
          throw error;
        }
      }
    }
    return this.evaluateWithArgumentsInContext<TResult>(
      undefined,
      undefined,
      expression,
      returnByValue,
      args,
      isFunction
    );
  }

  async evaluateWithArgumentsInSession<TResult>(
    sessionId: string | undefined,
    frameId: string | undefined,
    expression: string,
    returnByValue: true,
    args: unknown[],
    isFunction: boolean
  ): Promise<TResult>;
  async evaluateWithArgumentsInSession<TResult>(
    sessionId: string | undefined,
    frameId: string | undefined,
    expression: string,
    returnByValue: false,
    args: unknown[],
    isFunction: boolean
  ): Promise<ProtocolJSHandleAdapter<TResult>>;
  async evaluateWithArgumentsInSession<TResult>(
    sessionId: string | undefined,
    frameId: string | undefined,
    expression: string,
    returnByValue: boolean,
    args: unknown[],
    isFunction: boolean
  ): Promise<TResult | ProtocolJSHandleAdapter<TResult>> {
    if (frameId) {
      const frameSessionId =
        this.defaultExecutionContextSessionByFrameId.get(frameId) ??
        this.frameSessionIds.get(frameId) ??
        sessionId;
      const executionContextId = await this.defaultExecutionContextIdForFrame(frameId).catch((error) => {
        if (frameSessionId) {
          return undefined;
        }
        throw error;
      });
      return this.evaluateWithArgumentsInContext<TResult>(
        executionContextId,
        frameSessionId,
        expression,
        returnByValue,
        args,
        isFunction,
        frameId
      );
    }
    return this.evaluateWithArgumentsInContext<TResult>(
      undefined,
      sessionId,
      expression,
      returnByValue,
      args,
      isFunction,
      frameId
    );
  }

  private async evaluateWithArgumentsInFrame<TResult>(
    frameId: string,
    expression: string,
    returnByValue: true,
    args: unknown[],
    isFunction: boolean
  ): Promise<TResult>;
  private async evaluateWithArgumentsInFrame<TResult>(
    frameId: string,
    expression: string,
    returnByValue: false,
    args: unknown[],
    isFunction: boolean
  ): Promise<ProtocolJSHandleAdapter<TResult>>;
  private async evaluateWithArgumentsInFrame<TResult>(
    frameId: string,
    expression: string,
    returnByValue: boolean,
    args: unknown[],
    isFunction: boolean
  ): Promise<TResult | ProtocolJSHandleAdapter<TResult>>;
  private async evaluateWithArgumentsInFrame<TResult>(
    frameId: string,
    expression: string,
    returnByValue: boolean,
    args: unknown[],
    isFunction: boolean
  ): Promise<TResult | ProtocolJSHandleAdapter<TResult>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sessionId = this.defaultExecutionContextSessionByFrameId.get(frameId) ?? this.frameSessionIds.get(frameId);
      const executionContextId = await this.defaultExecutionContextIdForFrame(frameId).catch((error) => {
        if (sessionId) {
          return undefined;
        }
        throw error;
      });
      try {
        return await this.evaluateWithArgumentsInContext<TResult>(
          executionContextId,
          sessionId,
          expression,
          returnByValue,
          args,
          isFunction,
          frameId
        );
      } catch (error) {
        if (
          attempt === 1 ||
          (!isClosedCdpConnectionError(error) &&
            !String(error instanceof Error ? error.message : error).includes("Frame execution context is not available") &&
            !String(error instanceof Error ? error.message : error).includes("Cannot find context with specified id") &&
            !String(error instanceof Error ? error.message : error).includes("Execution context was destroyed"))
        ) {
          throw error;
        }
        this.defaultExecutionContextByFrameId.delete(frameId);
        this.defaultExecutionContextSessionByFrameId.delete(frameId);
        await this.waitForDefaultExecutionContext(frameId, 2_000);
      }
    }

    throw new Error(`Frame execution context is not available for frame "${frameId}".`);
  }

  private async evaluateWithArgumentsInContext<TResult>(
    executionContextId: number | undefined,
    sessionId: string | undefined,
    expression: string,
    returnByValue: boolean,
    args: unknown[],
    isFunction: boolean,
    frameId?: string
  ): Promise<TResult | ProtocolJSHandleAdapter<TResult>> {
    const temporaryHandles: ProtocolJSHandleAdapter[] = [];
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let activeExecutionContextId = executionContextId;
        let activeSessionId = sessionId;
        let globalHandle: CdpJSHandleAdapter | null = null;
        try {
          globalHandle = activeExecutionContextId === undefined
            ? await this.rawEvaluateHandle("globalThis", activeSessionId)
            : null;
          const targetObjectId = globalHandle?.remoteObjectId();
          const targetContext: CdpEvaluationTargetContext = {
            ...(activeExecutionContextId !== undefined ? { executionContextId: activeExecutionContextId } : {}),
            ...(frameId !== undefined ? { frameId } : {}),
            ...(targetObjectId !== undefined ? { objectId: targetObjectId } : {}),
            ...(activeSessionId !== undefined ? { sessionId: activeSessionId } : {})
          };
          const { values, handles } = await serializeCdpEvaluationArguments(args, this, temporaryHandles, targetContext);
          const wrappedExpression = `(...argsAndHandles) => {
            ${PARSE_EVALUATION_RESULT_SOURCE}
            ${returnByValue ? SERIALIZE_EVALUATION_RESULT_SOURCE : ""}
            const argCount = argsAndHandles[0];
            const serializedArgs = argsAndHandles.slice(1, argCount + 1);
            const handles = argsAndHandles.slice(argCount + 1);
            const parameters = [];
            for (let index = 0; index < serializedArgs.length; index += 1) {
              parameters[index] = __roxyParseEvaluationResultValue(serializedArgs[index], handles);
            }
            let result = (0, eval)(${serializeForEvaluation(normalizeEvaluationExpression(expression, isFunction))});
            if (${isFunction ? "true" : "false"})
              result = result(...parameters);
            return ${returnByValue ? "Promise.resolve(result).then(__roxySerializeEvaluationResult)" : "result"};
          }`;
          const callParameters: {
            arguments?: Array<{ objectId?: string; unserializableValue?: string; value?: unknown }>;
            awaitPromise?: boolean;
            executionContextId?: number;
            functionDeclaration: string;
            objectId?: string;
            returnByValue?: boolean;
            userGesture?: boolean;
          } = {
            functionDeclaration: wrappedExpression,
            arguments: [
              { value: values.length },
              ...values.map((value) => ({ value })),
              ...handles.map((handle) => ({ objectId: handle._remoteObjectId()! }))
            ],
            returnByValue,
            awaitPromise: true,
            userGesture: true
          };
          if (globalHandle) {
            callParameters.objectId = targetObjectId!;
          } else if (activeExecutionContextId !== undefined) {
            callParameters.executionContextId = activeExecutionContextId;
          }
          const response = await this.sendRuntimeCallFunctionOn(callParameters, activeSessionId);
          if (response.exceptionDetails) {
            throw new Error(formatCdpEvaluationError(response));
          }
          return returnByValue
            ? parseEvaluationResultValue(response.result.value as SerializedValue)
            : new CdpJSHandleAdapter<TResult>(this, response.result, activeSessionId, frameId);
        } catch (error) {
          if (this.closed && isClosedCdpConnectionError(error)) {
            throw this.createClosedError();
          }
          const message = String(error instanceof Error ? error.message : error);
          if (
            attempt === 1 ||
            (!isClosedCdpConnectionError(error)
              && !message.includes("Frame execution context is not available")
              && !message.includes("Cannot find context with specified id")
              && !message.includes("Execution context was destroyed"))
          ) {
            throw error;
          }
          if (frameId) {
            this.defaultExecutionContextByFrameId.delete(frameId);
            this.defaultExecutionContextSessionByFrameId.delete(frameId);
            const frameSessionId = this.frameSessionIds.get(frameId);
            if (frameSessionId === activeSessionId) {
              this.frameSessionIds.delete(frameId);
            }
            activeExecutionContextId = await this.defaultExecutionContextIdForFrame(frameId).catch(() => undefined);
            activeSessionId = this.defaultExecutionContextSessionByFrameId.get(frameId)
              ?? this.frameSessionIds.get(frameId);
            executionContextId = activeExecutionContextId;
            sessionId = activeSessionId;
            continue;
          }
          throw error;
        } finally {
          await globalHandle?.dispose().catch(() => {});
        }
      }
      throw new Error("Execution context is not available.");
    } finally {
      await Promise.all(
        temporaryHandles.map((handle) => Promise.resolve(handle.dispose()).catch(() => {}))
      );
    }
  }

  private async defaultExecutionContextIdForFrame(frameId: string): Promise<number> {
    const existing = this.defaultExecutionContextByFrameId.get(frameId);
    if (existing !== undefined) {
      return existing;
    }

    await this.options.client.Page.getFrameTree?.().catch(() => null);
    const current = this.defaultExecutionContextByFrameId.get(frameId);
    if (current !== undefined) {
      return current;
    }

    const awaited = await this.waitForDefaultExecutionContext(frameId, 2_000).catch(() => undefined);
    if (awaited !== undefined) {
      return awaited;
    }

    throw new Error(`Frame execution context is not available for frame "${frameId}".`);
  }

  private clearDefaultExecutionContexts(sessionId?: string): void {
    if (sessionId === undefined && this.pendingRunBeforeUnloadCloseCount > 0 && !this.closed) {
      return;
    }
    if (sessionId === undefined) {
      this.defaultExecutionContextByFrameId.clear();
      this.defaultExecutionContextSessionByFrameId.clear();
      return;
    }

    for (const [frameId, contextSessionId] of Array.from(this.defaultExecutionContextSessionByFrameId.entries())) {
      if (contextSessionId !== sessionId) {
        continue;
      }
      this.defaultExecutionContextSessionByFrameId.delete(frameId);
      this.defaultExecutionContextByFrameId.delete(frameId);
    }
  }

  private async waitForDefaultExecutionContext(frameId: string, timeout: number): Promise<number> {
    const existing = this.defaultExecutionContextByFrameId.get(frameId);
    if (existing !== undefined) {
      return existing;
    }

    return await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.pendingDefaultExecutionContextWaiters.get(frameId);
        if (waiters) {
          waiters.delete(waiter);
          if (!waiters.size) {
            this.pendingDefaultExecutionContextWaiters.delete(frameId);
          }
        }
        reject(new Error(`Frame execution context is not available for frame "${frameId}".`));
      }, timeout);
      const waiter = { resolve, reject, timer };
      const waiters = this.pendingDefaultExecutionContextWaiters.get(frameId) ?? new Set<typeof waiter>();
      waiters.add(waiter);
      this.pendingDefaultExecutionContextWaiters.set(frameId, waiters);
    });
  }

  async sendRuntimeCallFunctionOn(
    params: {
      arguments?: Array<{ objectId?: string; unserializableValue?: string; value?: unknown }>;
      awaitPromise?: boolean;
      executionContextId?: number;
      functionDeclaration: string;
      objectId?: string;
      returnByValue?: boolean;
      userGesture?: boolean;
    },
    sessionId?: string
  ): Promise<{ exceptionDetails?: CdpExceptionDetails; result: CdpRemoteObject }> {
    const runtimeClient = this.options.client as CdpRuntimeClient & {
      send(
        method: "Runtime.callFunctionOn",
        params: {
          arguments?: Array<{ objectId?: string; unserializableValue?: string; value?: unknown }>;
          awaitPromise?: boolean;
          executionContextId?: number;
          functionDeclaration: string;
          objectId?: string;
          returnByValue?: boolean;
          userGesture?: boolean;
        },
        sessionId?: string
      ): Promise<{ exceptionDetails?: CdpExceptionDetails; result: CdpRemoteObject }>;
    };
    return this.raceWithClose(runtimeClient.send("Runtime.callFunctionOn", params, sessionId));
  }

  private raceWithClose<TResult>(promise: Promise<TResult>): Promise<TResult> {
    if (this.closed) {
      return Promise.reject(this.createClosedError());
    }
    const guardedPromise = promise.catch((error) => {
      if (this.closed && isClosedCdpConnectionError(error)) {
        throw this.createClosedError();
      }
      throw error;
    });
    guardedPromise.catch(() => {});
    return Promise.race([
      guardedPromise,
      this.closePromise.then(() => {
        throw this.createClosedError();
      })
    ]);
  }

  async sendRuntimeGetProperties(
    params: {
      objectId: string;
      ownProperties?: boolean;
    },
    sessionId?: string
  ): Promise<{
    result: Array<{
      enumerable?: boolean;
      name: string;
      value?: CdpRemoteObject;
    }>;
  }> {
    const runtimeClient = this.options.client as CdpRuntimeClient & {
      send(
        method: "Runtime.getProperties",
        params: {
          objectId: string;
          ownProperties?: boolean;
        },
        sessionId?: string
      ): Promise<{
        result: Array<{
          enumerable?: boolean;
          name: string;
          value?: CdpRemoteObject;
        }>;
      }>;
    };
    return runtimeClient.send("Runtime.getProperties", params, sessionId);
  }

  async sendRuntimeReleaseObject(
    params: { objectId: string },
    sessionId?: string
  ): Promise<unknown> {
    const runtimeClient = this.options.client as CdpRuntimeClient & {
      send(
        method: "Runtime.releaseObject",
        params: { objectId: string },
        sessionId?: string
      ): Promise<unknown>;
    };
    return runtimeClient.send("Runtime.releaseObject", params, sessionId);
  }

  async rawEvaluateHandle<T = unknown>(expression: string, sessionId?: string): Promise<CdpJSHandleAdapter<T>> {
    for (const activeSessionId of sessionId ? [sessionId, undefined] : [undefined]) {
      try {
        const runtimeClient = this.options.client as CdpRuntimeClient & {
          send(
            method: "Runtime.evaluate",
            params: {
              expression: string;
              awaitPromise?: boolean;
              returnByValue?: boolean;
              userGesture?: boolean;
            },
            sessionId?: string
          ): Promise<{ exceptionDetails?: CdpExceptionDetails; result: CdpRemoteObject }>;
        };
        const response = await this.raceWithClose(runtimeClient.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: false
        }, activeSessionId));
        if (response.exceptionDetails) {
          throw new Error(formatCdpEvaluationError(response));
        }
        return new CdpJSHandleAdapter<T>(this, response.result, activeSessionId);
      } catch (error) {
        if (this.closed && isClosedCdpConnectionError(error)) {
          throw this.createClosedError();
        }
        if (activeSessionId !== undefined && isClosedCdpConnectionError(error)) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("Target page, context or browser has been closed");
  }

  async resolveElementReferenceAsHandle<T = unknown>(
    reference: ProtocolElementHandleReference
  ): Promise<CdpJSHandleAdapter<T>> {
    const handleReference = await this.createHandleReference(reference, "No element found.");
    if (!handleReference.handleId) {
      throw new Error("No element found.");
    }
    const handleId = JSON.stringify(handleReference.handleId);
    if (handleReference.protocolFrameId) {
      const sessionId = this.defaultExecutionContextSessionByFrameId.get(handleReference.protocolFrameId) ??
        this.frameSessionIds.get(handleReference.protocolFrameId) ??
        handleReference.protocolSessionId;
      const executionContextId = await this.defaultExecutionContextIdForFrame(handleReference.protocolFrameId);
      return await this.evaluateWithArgumentsInContext<T>(
        executionContextId,
        sessionId,
        `() => {
          const resolveScope = () => {
            const candidates = [globalThis];
            try {
              if (globalThis.top)
                candidates.unshift(globalThis.top);
            } catch {}
            for (const candidate of candidates) {
              try {
                if (candidate.__roxyHandleStore)
                  return candidate;
              } catch {}
            }
            return globalThis;
          };
          const scope = resolveScope();
          return scope.__roxyHandleStore && scope.__roxyHandleStore[${handleId}];
        }`,
        false,
        [],
        true,
        handleReference.protocolFrameId
      ) as CdpJSHandleAdapter<T>;
    }
    return this.rawEvaluateHandle<T>(`(() => {
      const resolveScope = () => {
        const candidates = [globalThis];
        try {
          if (globalThis.top)
            candidates.unshift(globalThis.top);
        } catch {}
        for (const candidate of candidates) {
          try {
            if (candidate.__roxyHandleStore)
              return candidate;
          } catch {}
        }
        return globalThis;
      };
      const scope = resolveScope();
      return scope.__roxyHandleStore && scope.__roxyHandleStore[${handleId}];
    })()`, handleReference.protocolSessionId);
  }

  maybeCreateRemoteHandleFromReference<T = unknown>(
    reference: ProtocolElementHandleReference
  ): CdpJSHandleAdapter<T> | null {
    if (!reference.protocolObjectId) {
      return null;
    }
    return new CdpJSHandleAdapter<T>(
      this,
      { objectId: reference.protocolObjectId, subtype: "node", type: "object" },
      reference.protocolSessionId,
      reference.protocolFrameId
    );
  }

  async adoptElementHandleToContext<T = unknown>(
    reference: ProtocolElementHandleReference,
    target: CdpEvaluationTargetContext
  ): Promise<CdpJSHandleAdapter<T>> {
    const sourceHandle =
      this.maybeCreateRemoteHandleFromReference(reference) ??
      await this.resolveElementReferenceAsHandle(reference).catch((error) => {
        if (isFrameExecutionContextUnavailableError(error)) {
          throw new Error("Unable to adopt element handle from a different document");
        }
        throw error;
      });
    const objectId = sourceHandle.remoteObjectId();
    if (!objectId) {
      throw new Error("JSHandle is not an ElementHandle");
    }

    let backendNodeId: number | undefined;
    try {
      const nodeInfo = await (this.options.client as CdpDomClient).send(
        "DOM.describeNode",
        { objectId },
        sourceHandle.sessionId()
      );
      backendNodeId = nodeInfo.node.backendNodeId;
    } finally {
      if (!reference.protocolObjectId) {
        await sourceHandle.dispose().catch(() => {});
      }
    }
    if (backendNodeId === undefined) {
      throw new Error("Unable to adopt element handle from a different document");
    }

    const resolved = await (this.options.client as CdpDomClient).send(
      "DOM.resolveNode",
      {
        backendNodeId,
        ...(target.executionContextId !== undefined
          ? { executionContextId: target.executionContextId }
          : {})
      },
      target.sessionId
    ).catch(() => null);
    if (!resolved || resolved.object.subtype === "null") {
      throw new Error("Unable to adopt element handle from a different document");
    }
    return new CdpJSHandleAdapter<T>(this, resolved.object, target.sessionId, target.frameId);
  }

  async storeRemoteElementHandle(
    handle: ProtocolJSHandleAdapter<unknown>,
    options: { disposeHandle?: boolean } = {}
  ): Promise<ProtocolElementHandleReference> {
    const disposeHandle = options.disposeHandle ?? true;
    const objectId = handle.remoteObjectId();
    if (!objectId) {
      if (disposeHandle) {
        await handle.dispose();
      }
      throw new Error("JSHandle is not an ElementHandle");
    }
    const sessionId = handle instanceof CdpJSHandleAdapter ? handle.sessionId() : undefined;
    const frameId = handle instanceof CdpJSHandleAdapter
      ? await this.ownerFrameIdForRemoteHandle(handle).catch(() => handle.frameId())
        ?? handle.frameId()
      : undefined;
    const response = await this.sendRuntimeCallFunctionOn({
      functionDeclaration: `function() {
        const node = this;
        if (!node || typeof node.nodeType !== 'number')
          throw new Error('JSHandle is not an ElementHandle');
        const resolveScope = () => {
          const candidates = [globalThis];
          try {
            if (globalThis.top)
              candidates.unshift(globalThis.top);
          } catch {}
          for (const candidate of candidates) {
            try {
              candidate.__roxyHandleStore ||= {};
              candidate.__roxyNextHandleId ||= 0;
              return candidate;
            } catch {}
          }
          globalThis.__roxyHandleStore ||= {};
          globalThis.__roxyNextHandleId ||= 0;
          return globalThis;
        };
        const scope = resolveScope();
        scope.__roxyHandleStore ||= {};
        scope.__roxyNextHandleId ||= 0;
        const handleId = 'handle:' + (++scope.__roxyNextHandleId);
        scope.__roxyHandleStore[handleId] = node;
        return handleId;
      }`,
      objectId,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    }, sessionId);
    if (disposeHandle) {
      await handle.dispose();
    }
    if (response.exceptionDetails) {
      throw new Error(formatCdpEvaluationError(response));
    }
    return {
      chain: [],
      handleId: response.result.value as string,
      ...(frameId ? { protocolFrameId: frameId } : {}),
      protocolObjectId: objectId,
      ...(sessionId ? { protocolSessionId: sessionId } : {})
    };
  }

  private async ownerFrameIdForRemoteHandle(handle: CdpJSHandleAdapter<unknown>): Promise<string | undefined> {
    let documentElement: ProtocolJSHandleAdapter<unknown> | null = null;
    try {
      documentElement = await handle.evaluateHandle<unknown>(`(node) => {
        const doc = node;
        if (doc && doc.documentElement && doc.documentElement.ownerDocument === doc)
          return doc.documentElement;
        return node && node.ownerDocument ? node.ownerDocument.documentElement : null;
      }`, undefined, true);
      const objectId = documentElement.remoteObjectId();
      if (!objectId) {
        return undefined;
      }
      const sessionId = documentElement instanceof CdpJSHandleAdapter
        ? documentElement.sessionId()
        : handle.sessionId();
      const nodeInfo = await (this.options.client as CdpDomClient).send("DOM.describeNode", {
        objectId
      }, sessionId);
      return typeof nodeInfo.node.frameId === "string" ? nodeInfo.node.frameId : undefined;
    } finally {
      await Promise.resolve(documentElement?.dispose()).catch(() => {});
    }
  }

  cdpRuntimeClient(): CdpRuntimeClient {
    return this.options.client as CdpRuntimeClient;
  }

  private async syncCurrentUrlFromDocument(): Promise<void> {
    try {
      this.currentUrl = await this.evaluateExpression<string>("document.URL");
    } catch {
      // Ignore navigation races; url() should keep the last known value.
    }
  }

  private async syncLifecycleStateFromDocument(): Promise<void> {
    try {
      const readyState = await this.evaluateExpression<string>("document.readyState");
      if (readyState === "loading") {
        this.domContentLoaded = false;
        this.loadFired = false;
      } else if (readyState === "interactive") {
        this.domContentLoaded = true;
        this.loadFired = false;
      } else if (readyState === "complete") {
        this.domContentLoaded = true;
        this.loadFired = true;
      }
      if (this.mainFrameId) {
        this.updateFrameLifecycleState(this.mainFrameId, {
          domContentLoaded: this.domContentLoaded,
          loadFired: this.loadFired
        });
      }
      this.flushWaiters();
    } catch {
      // Lifecycle events will update the state once a document is available.
    }
  }

  private maybeResolveInitialAboutBlankLifecycle(): void {
    if (this.currentUrl !== "about:blank") {
      return;
    }
    if (this.domContentLoaded && this.loadFired) {
      return;
    }
    if (this.loadingFrameIds.size > 0 || this.activeRequests > 0) {
      return;
    }

    this.domContentLoaded = true;
    this.loadFired = true;
    this.networkIdleReached = true;
    if (this.mainFrameId) {
      this.updateFrameLifecycleState(this.mainFrameId, {
        domContentLoaded: true,
        loadFired: true
      });
    }
    this.flushWaiters();
  }

  private updateFrameLifecycleState(
    frameId: string,
    patch: Partial<{ domContentLoaded: boolean; loadFired: boolean; }>
  ): void {
    const current = this.frameLifecycleStates.get(frameId) ?? {
      domContentLoaded: false,
      loadFired: false
    };
    this.frameLifecycleStates.set(frameId, {
      ...current,
      ...patch
    });
  }

  private queueRequestEvent(requestId: string, payload: RawPageEventMap["request"]): void {
    const extraInfoHeaders = this.shiftRequestExtraInfoHeaders(requestId);
    if (extraInfoHeaders) {
      this.emit("request", {
        ...payload,
        headers: extraInfoHeaders
      });
      return;
    }

    const pending = this.pendingRequestEvents.get(requestId) ?? [];
    const queued: CdpPendingRequestEvent = {
      payload,
      responseCallbacks: []
    };
    queued.fallbackTimer = setTimeout(() => {
      delete queued.fallbackTimer;
      this.flushPendingRequestEvent(requestId);
    }, REQUEST_EXTRA_INFO_FALLBACK_MS);
    pending.push(queued);
    this.pendingRequestEvents.set(requestId, pending);
  }

  private flushPendingRequestEvent(requestId: string): void {
    const pending = this.pendingRequestEvents.get(requestId);
    if (!pending?.length) {
      return;
    }
    const next = pending.shift()!;
    if (next.fallbackTimer) {
      clearTimeout(next.fallbackTimer);
    }
    if (pending.length === 0) {
      this.pendingRequestEvents.delete(requestId);
    }
    this.emit("request", next.payload);
    for (const callback of next.responseCallbacks) {
      callback();
    }
  }

  private shiftRequestExtraInfoHeaders(requestId: string): Array<{ name: string; value: string }> | null {
    const queued = this.requestExtraInfoHeaders.get(requestId);
    if (!queued?.length) {
      return null;
    }
    const headers = queued.shift() ?? null;
    if (queued.length === 0) {
      this.requestExtraInfoHeaders.delete(requestId);
    }
    return headers;
  }

  private runAfterPendingRequestEvent(requestId: string, callback: () => void): boolean {
    const pending = this.pendingRequestEvents.get(requestId);
    if (!pending?.length) {
      return false;
    }
    pending[0]!.responseCallbacks.push(callback);
    return true;
  }

  private isStateSatisfied(state: WaitUntilState, frameId?: string): boolean {
    if (frameId && state !== "networkidle") {
      const lifecycleState = this.frameLifecycleStates.get(frameId);
      if (!lifecycleState) {
        return false;
      }
      if (state === "domcontentloaded") {
        return lifecycleState.domContentLoaded;
      }
      if (state === "load") {
        return lifecycleState.loadFired;
      }
    }

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
    this.loadingFrameIds.clear();
    this.frameLifecycleStates.clear();
    for (const frameId of Array.from(this.frameNetworkIdleStates.keys())) {
      this.clearFrameNetworkIdleTimer(frameId);
    }
    this.frameNetworkIdleStates.clear();
    this.domContentLoaded = false;
    this.loadFired = false;
    this.networkIdleReached = false;
    this.sameDocumentNavigation = false;
    this.allowSameDocumentNavigationToResolveWaiters = false;
    this.activeRequests = 0;
    this.clearNetworkIdleTimer();
  }

  private settleRequestsForDetachedFrame(frameId: string): void {
    for (const [requestId, request] of Array.from(this.requestMetadata.entries())) {
      if (request.frameId !== frameId) {
        continue;
      }
      this.ensureResponseBodyState(requestId).markFailed(new Error("Frame was detached."));
      this.flushPendingRequestEvent(requestId);
      this.requestMetadata.delete(requestId);
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    }
    this.clearFrameNetworkIdleTimer(frameId);
    this.frameNetworkIdleStates.delete(frameId);
    this.recalculateNetworkIdle();
    this.maybeArmNetworkIdleTimer();
  }

  private async navigateHistory(
    delta: -1 | 1,
    options: PageGotoOptions
  ): Promise<PageResponse | null> {
    const navigationClient = this.navigationClient();
    const pageDomain = navigationClient.Page as typeof navigationClient.Page & {
      getNavigationHistory(): Promise<{
        currentIndex: number;
        entries: Array<{ id: number; url: string }>;
      }>;
      navigateToHistoryEntry(options: { entryId: number }): Promise<void>;
    };
    const history = await retryOnDetachedNavigationSession(() => {
      return pageDomain.getNavigationHistory();
    });
    const nextEntry = history.entries[history.currentIndex + delta];
    if (!nextEntry) {
      return null;
    }

    const waitUntil = verifyLifecycle("waitUntil", options.waitUntil ?? "load");
    await this.interruptPendingNavigations(nextEntry.url);
    const capture = this.beginNavigationResponseCapture({
      predicate: (response) => stripHash(response.url) === stripHash(nextEntry.url)
    });
    const failureCapture = this.beginNavigationFailureCapture(
      nextEntry.url,
      delta < 0 ? "page.goBack" : "page.goForward"
    );
    this.resetNavigationState();
    this.allowSameDocumentNavigationToResolveWaiters = true;
    try {
      await this.raceNavigationFailure(
        withTimeout(
          retryOnDetachedNavigationSession(() => {
            return pageDomain.navigateToHistoryEntry({ entryId: nextEntry.id });
          }),
          options.timeout,
          `Timed out while navigating ${delta < 0 ? "back" : "forward"}.`
        ),
        failureCapture
      );

      if (waitUntil !== "commit") {
        await this.raceNavigationFailure(
          this.waitForLoadState(waitUntil, options.timeout),
          failureCapture
        );
      }
      await this.syncCurrentUrlFromDocument();

      if (capture.lastResponse) {
        const capturedUrl = stripHash(capture.lastResponse.url);
        const currentUrl = stripHash(this.currentUrl);
        const expectedUrl = stripHash(nextEntry.url);
        if (
          capturedUrl === expectedUrl
          || capturedUrl === currentUrl
        ) {
          return capture.lastResponse;
        }
      }
      if (this.sameDocumentNavigation) {
        return null;
      }
    } finally {
      this.endNavigationResponseCapture(capture);
      this.endNavigationFailureCapture(failureCapture);
    }

    return createPageResponse({
      fromCache: false,
      headers: [],
      mimeType: "text/html",
      status: 200,
      statusText: "OK",
      text: async () => "",
      url: this.currentUrl
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

  private ensureFrameNetworkIdleState(frameId: string): CdpFrameNetworkIdleState {
    const existing = this.frameNetworkIdleStates.get(frameId);
    if (existing) {
      return existing;
    }
    const created: CdpFrameNetworkIdleState = {
      activeRequests: 0,
      idleReached: false,
      idleTimer: undefined
    };
    this.frameNetworkIdleStates.set(frameId, created);
    return created;
  }

  private clearFrameNetworkIdleTimer(frameId: string): void {
    const state = this.frameNetworkIdleStates.get(frameId);
    if (!state?.idleTimer) {
      return;
    }
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }

  private markFrameNetworkBusy(frameId: string): void {
    const state = this.ensureFrameNetworkIdleState(frameId);
    state.activeRequests += 1;
    state.idleReached = false;
    this.clearFrameNetworkIdleTimer(frameId);
    this.recalculateNetworkIdle();
  }

  private markFrameNetworkRequestSettled(frameId: string): void {
    const state = this.ensureFrameNetworkIdleState(frameId);
    state.activeRequests = Math.max(0, state.activeRequests - 1);
    this.maybeArmFrameNetworkIdleTimer(frameId);
  }

  private maybeArmFrameNetworkIdleTimer(frameId: string): void {
    const state = this.ensureFrameNetworkIdleState(frameId);
    if (state.activeRequests !== 0 || state.idleTimer) {
      return;
    }
    state.idleTimer = setTimeout(() => {
      state.idleReached = true;
      state.idleTimer = undefined;
      this.recalculateNetworkIdle();
    }, NETWORK_IDLE_MS);
  }

  private isFrameSubtreeNetworkIdle(frameId: string): boolean {
    const state = this.frameNetworkIdleStates.get(frameId);
    if (!state?.idleReached) {
      return false;
    }
    for (const frame of this.nativeFrames.values()) {
      if (frame.parentId === frameId && !this.isFrameSubtreeNetworkIdle(frame.id)) {
        return false;
      }
    }
    return true;
  }

  private recalculateNetworkIdle(): void {
    const mainFrameId = this.mainFrameId;
    if (!mainFrameId) {
      this.networkIdleReached = this.activeRequests === 0;
      this.flushWaiters();
      return;
    }
    this.networkIdleReached = this.isFrameSubtreeNetworkIdle(mainFrameId);
    this.flushWaiters();
  }

  private emitResponseReceived(
    event: {
      frameId?: string;
      requestId: string;
      response: {
        fromDiskCache?: boolean;
        fromServiceWorker?: boolean;
        fromPrefetchCache?: boolean;
        headers: Record<string, string | number | boolean>;
        mimeType: string;
        status: number;
        statusText: string;
        url: string;
      };
      type?: string;
    },
    headerEntries: Array<{ name: string; value: string }> = mapCdpHeaders(event.response.headers)
  ): void {
    const fulfilledHeaders = this.fulfilledDocumentResponseHeaders.get(event.requestId);
    if (fulfilledHeaders) {
      headerEntries = fulfilledHeaders;
      this.fulfilledDocumentResponseHeaders.delete(event.requestId);
    }
    const responseBodyState = this.ensureResponseBodyState(event.requestId);
    if (event.frameId !== undefined) {
      responseBodyState.frameId = event.frameId;
    }
    const responseUrl = this.continuedRequestUrls.get(event.requestId) ?? event.response.url;
    if (responseUrl !== undefined) {
      responseBodyState.url = responseUrl;
    }
    const contentLengthHeader = headerEntries.find(
      (header) => header.name.toLowerCase() === "content-length"
    );
    const expectedLength =
      contentLengthHeader && Number.isFinite(Number(contentLengthHeader.value))
        ? Number(contentLengthHeader.value)
        : undefined;
    if (expectedLength !== undefined) {
      responseBodyState.expectedLength = expectedLength;
    }
    const request = this.requestMetadata.get(event.requestId);
    const isNavigationRequest = request?.isNavigationRequest ?? false;
    const frameId = event.frameId ?? request?.frameId;
    const response = createPageResponse({
      fromCache: Boolean(event.response.fromDiskCache || event.response.fromPrefetchCache),
      ...(event.response.fromServiceWorker !== undefined
        ? { fromServiceWorker: event.response.fromServiceWorker }
        : {}),
      ...(frameId ? { frameId } : {}),
      headers: headerEntries,
      isNavigationRequest,
      mimeType: event.response.mimeType,
      requestId: event.requestId,
      resourceType: toPlaywrightResourceType(event.type),
      status: event.response.status,
      statusText: event.response.statusText,
      body: () => this.getResponseBodyBuffer(event.requestId),
      text: () => this.getResponseText(event.requestId),
      url: responseUrl
    });

    this.emit("response", response);

    if (isNavigationRequest && frameId) {
      this.captureNavigationResponse(response);
    }
  }

  private emitRedirectResponse(
    event: {
      frameId?: string;
      requestId: string;
      request: {
        method: string;
      };
      timestamp?: number;
      type?: string;
    },
    redirectResponse: {
      fromDiskCache?: boolean;
      fromPrefetchCache?: boolean;
      headers: Record<string, string | number | boolean | Array<string | number | boolean>>;
      mimeType: string;
      status: number;
      statusText: string;
      url: string;
    }
  ): void {
    const previousRequest = this.requestMetadata.get(event.requestId);
    const frameId = event.frameId ?? previousRequest?.frameId;
    const type = event.type ?? previousRequest?.type;
    const url = previousRequest?.url ?? redirectResponse.url;
    const method = previousRequest?.method ?? event.request.method;
    const isNavigationRequest = previousRequest?.isNavigationRequest ?? false;
    this.emit("response", createPageResponse({
      fromCache: Boolean(redirectResponse.fromDiskCache || redirectResponse.fromPrefetchCache),
      ...(frameId ? { frameId } : {}),
      headers: mapCdpHeaders(redirectResponse.headers, "\n"),
      isNavigationRequest,
      mimeType: redirectResponse.mimeType,
      requestId: event.requestId,
      resourceType: toPlaywrightResourceType(type),
      status: redirectResponse.status,
      statusText: redirectResponse.statusText,
      body: async () => Buffer.alloc(0),
      text: async () => "",
      url
    }));

    this.emit("requestfinished", {
      headers: [],
      ...(frameId ? { frameId } : {}),
      isNavigationRequest,
      method,
      requestId: event.requestId,
      resourceType: toPlaywrightResourceType(type),
      url
    });
  }

  private async handleFetchRequestPaused(event: {
    networkId?: string;
    requestId: string;
    request: {
      headers: Record<string, string>;
      method: string;
      postData?: string;
      postDataEntries?: Array<{ bytes?: string }>;
      url: string;
    };
    resourceType: string;
    responseErrorReason?: string;
    redirectedRequestId?: string;
    responseStatusCode?: number;
  }): Promise<void> {
    if (isFaviconRequestUrl(event.request.url)) {
      await this.options.client.Fetch.failRequest({
        requestId: event.requestId,
        errorReason: "Aborted"
      }).catch(() => {});
      return;
    }
    if (isCdpPreflightRequest(event)) {
      await this.options.client.Fetch.fulfillRequest({
        requestId: event.requestId,
        responseCode: 204,
        responseHeaders: cdpPreflightResponseHeaders(event.request.headers),
        responsePhrase: "No Content",
        body: ""
      }).catch(() => {});
      return;
    }
    if (!this.requestInterceptor) {
      await this.options.client.Fetch.continueRequest({
        requestId: event.requestId
      }).catch(() => {});
      return;
    }
    if (event.redirectedRequestId) {
      const networkRequestId = event.networkId ?? event.redirectedRequestId;
      const headers = this.continuedRequestHeaders.get(networkRequestId);
      await this.options.client.Fetch.continueRequest({
        requestId: event.requestId,
        ...(headers ? { headers: applyCdpHeaderOverrides(event.request.headers, headers) } : {})
      }).catch(() => {});
      return;
    }
    if (event.responseErrorReason || event.responseStatusCode) {
      await this.options.client.Fetch.continueRequest({
        requestId: event.requestId
      }).catch(() => {});
      return;
    }

    this.pausedFetchRequestIds.add(event.requestId);
    const bodyBuffer = postDataBufferFromCdpEntries(event.request.postDataEntries) ??
      (event.request.postData
      ? Buffer.from(event.request.postData, "utf8")
      : null);
    try {
      const decision = await this.requestInterceptor({
        id: event.requestId,
        ...(event.networkId ? { requestId: event.networkId } : {}),
        headers: normalizeHeaderRecord(event.request.headers),
        isNavigationRequest: event.resourceType === "Document",
        method: event.request.method,
        ...(event.request.postData !== undefined ? { postData: event.request.postData } : { postData: null }),
        ...(bodyBuffer ? { postDataBufferBase64: bodyBuffer.toString("base64") } : {}),
        resourceType: toPlaywrightResourceType(event.resourceType),
        url: event.request.url
      });

      if (decision.action === "continue") {
        const headers = cdpContinueRequestHeaders(decision.headers);
        if (event.networkId) {
          this.continuedRequestHeaders.set(event.networkId, headers);
          if (decision.url !== event.request.url) {
            this.continuedRequestUrls.set(event.networkId, decision.url);
          } else {
            this.continuedRequestUrls.delete(event.networkId);
          }
          const metadata = this.requestMetadata.get(event.networkId);
          if (metadata) {
            metadata.url = decision.url;
          }
        }
        await this.sendFetchCommandMayFail(() =>
          this.options.client.Fetch.continueRequest({
            requestId: event.requestId,
            ...(decision.url !== event.request.url ? { url: decision.url } : {}),
            ...(decision.method !== event.request.method ? { method: decision.method } : {}),
            ...(decision.postData !== null
              ? {
                  postData: Buffer.from(
                    decision.postDataBufferBase64 ?? Buffer.from(decision.postData, "utf8").toString("base64"),
                    "base64"
                  ).toString("base64")
                }
              : {}),
            headers
          })
        );
        return;
      }

      if (decision.action === "fulfill") {
        const routedRequestId = event.networkId ?? event.requestId;
        const fulfilledBody = Buffer.from(
          decision.bodyBufferBase64 ?? Buffer.from(decision.body, "utf8").toString("base64"),
          "base64"
        );
        const responseBodyState = this.ensureResponseBodyState(routedRequestId);
        responseBodyState.fulfilledBody = fulfilledBody;
        responseBodyState.expectedLength = fulfilledBody.byteLength;
        responseBodyState.url = decision.url;
        this.fulfilledRequestIds.add(routedRequestId);
        this.fulfilledDocumentResponseHeaders.set(
          routedRequestId,
          mapCdpHeaders(decision.headers, "\n")
        );
        await this.sendFetchCommandMayFail(() =>
          this.options.client.Fetch.fulfillRequest({
            requestId: event.requestId,
            body: fulfilledBody.toString("base64"),
            responseCode: decision.status,
            responseHeaders: splitSetCookieHeader(
              Object.entries(decision.headers).map(([name, value]) => ({ name, value }))
            ),
            responsePhrase: decision.statusText
          })
        );
        return;
      }

      await this.sendFetchCommandMayFail(() =>
        this.options.client.Fetch.failRequest({
          requestId: event.requestId,
          errorReason: cdpErrorReasonForRoute(decision.errorCode)
        })
      );
      const failedRequestId = event.networkId ?? event.requestId;
      this.failedRouteErrorTexts.set(
        failedRequestId,
        cdpFailureTextForRoute(decision.errorCode)
      );
    } finally {
      this.pausedFetchRequestIds.delete(event.requestId);
    }
  }

  private async sendFetchCommandMayFail(command: () => Promise<void>): Promise<void> {
    try {
      await command();
    } catch (error) {
      if (error instanceof Error) {
        if (
          error.message.includes("Invalid http status code or phrase") ||
          error.message.includes("Unsafe header")
        ) {
          throw error;
        }
        if (isIgnorableFetchInterceptionError(error)) {
          return;
        }
      }
      return;
    }
  }

  private flushPendingResponseEvent(requestId: string): void {
    const pending = this.pendingResponseEvents.get(requestId);
    if (!pending?.length) {
      this.responseExtraInfoHeaders.delete(requestId);
      return;
    }
    const fallbackTimer = this.pendingResponseFallbackTimers.get(requestId);
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      this.pendingResponseFallbackTimers.delete(requestId);
    }
    this.pendingResponseEvents.delete(requestId);
    for (const entry of pending) {
      const extraInfoHeaders = this.shiftResponseExtraInfoHeaders(requestId);
      this.emitResponseReceived(entry.event, extraInfoHeaders ?? mapCdpHeaders(entry.event.response.headers));
    }
    if (!(this.responseExtraInfoHeaders.get(requestId)?.length)) {
      this.responseExtraInfoHeaders.delete(requestId);
    }
  }

  private shiftResponseExtraInfoHeaders(
    requestId: string
  ): Array<{ name: string; value: string }> | null {
    const queued = this.responseExtraInfoHeaders.get(requestId);
    if (!queued?.length) {
      return null;
    }
    const headers = queued.shift() ?? null;
    if (queued.length === 0) {
      this.responseExtraInfoHeaders.delete(requestId);
    }
    return headers;
  }

  private discardNextResponseExtraInfo(requestId: string): void {
    const queued = this.responseExtraInfoHeaders.get(requestId);
    if (queued?.length) {
      queued.shift();
      if (queued.length === 0) {
        this.responseExtraInfoHeaders.delete(requestId);
      }
      return;
    }
    this.responseExtraInfoDiscardCounts.set(
      requestId,
      (this.responseExtraInfoDiscardCounts.get(requestId) ?? 0) + 1
    );
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
      if (this.isStateSatisfied(waiter.state, waiter.frameId)) {
        waiter.resolve();
      }
    }
  }

  private isMainFrameId(frameId: string): boolean {
    return this.mainFrameId === undefined || this.mainFrameId === frameId;
  }

  private beginNavigationResponseCapture(options: {
    predicate?: (response: PageResponse) => boolean;
  } = {}): NavigationResponseCapture {
    const capture: NavigationResponseCapture = {
      lastResponse: null
    };
    if (options.predicate) {
      capture.predicate = options.predicate;
    }
    this.navigationResponseCaptures.add(capture);
    return capture;
  }

  private endNavigationResponseCapture(capture: NavigationResponseCapture): void {
    this.navigationResponseCaptures.delete(capture);
  }

  private captureNavigationResponse(response: PageResponse): void {
    if (!shouldCaptureNavigationResponseUrl(response.url)) {
      return;
    }
    if (response.frameId && !this.isMainFrameId(response.frameId)) {
      return;
    }
    if (!response.isNavigationRequest && response.resourceType !== "document") {
      return;
    }
    for (const capture of Array.from(this.navigationResponseCaptures)) {
      if (capture.predicate && !capture.predicate(response)) {
        continue;
      }
      capture.lastResponse = response;
      capture.resolve?.(response);
    }
  }

  private beginNavigationFailureCapture(
    targetUrl?: string,
    apiName = "page.goto"
  ): NavigationFailureCapture {
    let reject!: (error: Error) => void;
    let resolveCommittedInterruption!: () => void;
    const failure = new Promise<never>((_resolve, rejectCallback) => {
      reject = rejectCallback;
    });
    const committedInterruption = new Promise<typeof COMMITTED_NAVIGATION_INTERRUPTED>((resolve) => {
      resolveCommittedInterruption = () => {
        resolve(COMMITTED_NAVIGATION_INTERRUPTED);
      };
    });
    const capture: NavigationFailureCapture = {
      apiName,
      resolveCommittedInterruption,
      ...(targetUrl ? { targetUrl } : {}),
      reject
    };
    this.navigationFailureCaptures.add(capture);
    // The promise is consumed through raceNavigationFailure; keep a catch here so
    // cleanup after a successful navigation cannot leave a dangling rejection.
    void failure.catch(() => {});
    (capture as NavigationFailureCapture & { promise: Promise<never> }).promise = failure;
    (capture as NavigationFailureCapture & {
      committedPromise: Promise<typeof COMMITTED_NAVIGATION_INTERRUPTED>;
    }).committedPromise = committedInterruption;
    return capture;
  }

  private endNavigationFailureCapture(capture: NavigationFailureCapture): void {
    this.navigationFailureCaptures.delete(capture);
  }

  private async interruptPendingNavigations(nextUrl: string): Promise<void> {
    if (!this.rejectInterruptedNavigationFailureCaptures(nextUrl)) {
      return;
    }
    await (this.options.client.Page as typeof this.options.client.Page & {
      stopLoading?: () => Promise<unknown>;
    }).stopLoading?.().catch(() => {});
  }

  private rejectInterruptedNavigationFailureCaptures(nextUrl: string): boolean {
    let interrupted = false;
    for (const capture of Array.from(this.navigationFailureCaptures)) {
      if (!capture.targetUrl) {
        continue;
      }
      if (stripHash(capture.targetUrl) === stripHash(nextUrl)) {
        continue;
      }
      interrupted = true;
      if (capture.committed) {
        capture.resolveCommittedInterruption();
        continue;
      }
      capture.reject(new Error(formatInterruptedNavigationMessage(capture, nextUrl)));
    }
    return interrupted;
  }

  private rejectInterruptedNavigationFailureCapturesForCommittedNavigation(
    loaderId?: string,
    committedUrl?: string
  ): void {
    if (!loaderId || !committedUrl) {
      return;
    }
    for (const capture of Array.from(this.navigationFailureCaptures)) {
      if (!capture.targetUrl || !capture.expectedLoaderId) {
        continue;
      }
      if (capture.expectedLoaderId === loaderId) {
        continue;
      }
      if (capture.allowCommittedRedirectTimeout) {
        continue;
      }
      capture.resolveCommittedInterruption();
    }
  }

  private rejectNavigationFailureCaptures(error: Error, failedUrl?: string): void {
    for (const capture of Array.from(this.navigationFailureCaptures)) {
      if (failedUrl && capture.targetUrl && stripHash(capture.targetUrl) !== stripHash(failedUrl)) {
        continue;
      }
      capture.reject(error);
    }
  }

  private async raceNavigationFailure<T>(
    promise: Promise<T>,
    capture: NavigationFailureCapture,
    options: { includeCommittedInterruption?: boolean } = {}
  ): Promise<T | typeof COMMITTED_NAVIGATION_INTERRUPTED> {
    const failure = (capture as NavigationFailureCapture & { promise: Promise<never> }).promise;
    if (options.includeCommittedInterruption === false) {
      return Promise.race([promise, failure]);
    }
    const committedPromise = (capture as NavigationFailureCapture & {
      committedPromise: Promise<typeof COMMITTED_NAVIGATION_INTERRUPTED>;
    }).committedPromise;
    return Promise.race([promise, failure, committedPromise]);
  }

  private ensureResponseBodyState(requestId: string): ResponseBodyState {
    const existing = this.responseBodies.get(requestId);
    if (existing) {
      return existing;
    }

    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const created: ResponseBodyState = {
      markFailed: (error: Error) => {
        created.failure = error;
        created.resolveReady();
      },
      ready,
      resolveReady
    };
    this.responseBodies.set(requestId, created);
    return created;
  }

  private async getResponseBodyBuffer(requestId: string): Promise<Buffer> {
    const state = this.ensureResponseBodyState(requestId);
    if (!state.body) {
      state.body = (async () => {
        await state.ready;
        if (state.failure) {
          throw state.failure;
        }
        if (state.fulfilledBody) {
          return Buffer.from(state.fulfilledBody);
        }
        let body = Buffer.alloc(0);
        let shouldLoadResource = false;
        try {
          const response = await (
            this.options.client.Network as typeof this.options.client.Network & {
              getResponseBody(options: {
                requestId: string;
              }, sessionId?: string): Promise<{ base64Encoded: boolean; body: string }>;
            }
          ).getResponseBody({
            requestId: this.responseBodyRequestIds.get(requestId) ?? requestId
          }, state.sessionId);
          body = response.base64Encoded
            ? Buffer.from(response.body, "base64")
            : Buffer.from(response.body, "utf8");
          shouldLoadResource = !body.byteLength && Boolean(state.expectedLength && state.url);
        } catch (error) {
          if (!state.url || !String(error instanceof Error ? error.message : error).includes("No resource with given identifier found")) {
            throw error;
          }
          shouldLoadResource = true;
        }
        if (!shouldLoadResource) {
          return body;
        }
        const resourceUrl = state.url;
        if (!resourceUrl) {
          return body;
        }
        const resource = await (
          this.options.client.Network as typeof this.options.client.Network & {
            loadNetworkResource(options: {
              frameId?: string;
              options: { disableCache: boolean; includeCredentials: boolean };
              url: string;
            }): Promise<{ resource: { stream?: string } }>;
          }
        ).loadNetworkResource({
          url: resourceUrl,
          ...(state.frameId ? { frameId: state.frameId } : {}),
          options: {
            disableCache: false,
            includeCredentials: true
          }
        });
        if (!resource.resource.stream) {
          return body;
        }
        const chunks: Buffer[] = [];
        while (resource.resource.stream) {
          const chunk = await (
            this.options.client.IO as typeof this.options.client.IO & {
              read(options: {
                handle: string;
              }): Promise<{ base64Encoded?: boolean; data: string; eof?: boolean }>;
            }
          ).read({
            handle: resource.resource.stream
          });
          chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
          if (chunk.eof) {
            await this.options.client.IO.close({
              handle: resource.resource.stream
            });
            break;
          }
        }
        return Buffer.concat(chunks);
      })();
    }
    return state.body;
  }

  private async getResponseText(requestId: string): Promise<string> {
    return (await this.getResponseBodyBuffer(requestId)).toString("utf8");
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of Array.from(this.stateWaiters)) {
      waiter.reject(error);
    }
    this.stateWaiters.clear();
  }

  private createDialogPayload(input: {
    defaultValue: string;
    message: string;
    page?: PageDialog["page"];
    type: "alert" | "beforeunload" | "confirm" | "prompt";
  }): PageDialog {
    let handled = false;
    const respond = async (accept: boolean, promptText?: string): Promise<void> => {
      if (handled) {
        return;
      }
      handled = true;
      await (
        this.options.client.Page as typeof this.options.client.Page & {
          handleJavaScriptDialog(options: { accept: boolean; promptText?: string }): Promise<void>;
        }
      ).handleJavaScriptDialog({
        accept,
        ...(promptText !== undefined ? { promptText } : {})
      });
    };

    const dialog = {
      accept: (promptText?: string) => respond(true, promptText),
      defaultValue: () => input.defaultValue,
      dismiss: () => respond(false),
      message: () => input.message,
      page: () => input.page?.() ?? null,
      type: () => input.type
    };
    if (
      (this.eventListeners.get("dialog")?.size ?? 0) === 0
      && (this.earlyEvents.get("dialog")?.length ?? 0) === 0
    ) {
      void dialog.dismiss().catch(() => {});
    }
    return dialog;
  }

  private createClosedError(): Error {
    return new Error(this.closeReason ?? "Target page, context or browser has been closed");
  }

  private resolveCloseSignal(): void {
    if (this.closePromiseResolved) {
      return;
    }
    this.closePromiseResolved = true;
    this.resolveClosePromise();
  }

  private emit<K extends RawPageEventName>(event: K, payload: RawPageEventMap[K]): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners) {
      this.bufferEarlyEvent(event, payload);
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

  private async handleFileChooserOpened(event: {
    backendNodeId?: number;
    frameId: string;
    mode: "selectSingle" | "selectMultiple";
  }): Promise<void> {
    if (!event.backendNodeId) {
      return;
    }
    const sessionId =
      this.defaultExecutionContextSessionByFrameId.get(event.frameId)
      ?? this.frameSessionIds.get(event.frameId);
    const executionContextId = await this.defaultExecutionContextIdForFrame(event.frameId).catch(() => undefined);
    const domClient = this.options.client as CdpDomClient;
    const resolveNode = async (targetSessionId: string | undefined, targetExecutionContextId: number | undefined) => {
      return domClient.send(
        "DOM.resolveNode",
        {
          backendNodeId: event.backendNodeId!,
          ...(targetExecutionContextId !== undefined ? { executionContextId: targetExecutionContextId } : {})
        },
        targetSessionId
      );
    };
    const resolved =
      await resolveNode(sessionId, executionContextId).catch(async (error) => {
        if (isClosedCdpConnectionError(error) || String(error).includes("No target with given id found")) {
          return resolveNode(undefined, undefined).catch(() => null);
        }
        return null;
      });
    const objectId = resolved?.object.objectId;
    if (!objectId || resolved?.object.subtype === "null") {
      return;
    }
    const handle = new CdpJSHandleAdapter<unknown>(
      this,
      resolved.object,
      this.defaultExecutionContextSessionByFrameId.get(event.frameId) ?? this.frameSessionIds.get(event.frameId),
      event.frameId
    );
    const element = await this.storeRemoteElementHandle(handle, { disposeHandle: false }).catch(() => null);
    if (!element) {
      return;
    }
    for (const listener of Array.from(this.fileChooserOpenedListeners)) {
      await listener({
        element,
        frameId: event.frameId,
        isMultiple: event.mode === "selectMultiple"
      });
    }
  }

  private bufferEarlyEvent<K extends RawPageEventName>(event: K, payload: RawPageEventMap[K]): void {
    if (!isBufferedEarlyEvent(event) || payload === undefined) {
      return;
    }
    const events = this.earlyEvents.get(event) ?? [];
    events.push(
      payload as
        | RawPageEventMap["dialog"]
        | RawPageEventMap["request"]
        | RawPageEventMap["response"]
        | RawPageEventMap["requestfailed"]
    );
    if (events.length > 100) {
      events.shift();
    }
    this.earlyEvents.set(event, events);
  }

  private replayEarlyEvents<K extends RawPageEventName>(event: K, listener: RawPageEventListener<K>): void {
    if (!isBufferedEarlyEvent(event)) {
      return;
    }
    const events = this.earlyEvents.get(event);
    if (!events?.length) {
      return;
    }
    for (const payload of events) {
      (listener as (eventPayload: typeof payload) => void)(payload);
    }
    if (event === "dialog") {
      this.earlyEvents.delete(event);
    }
  }
}

class CdpLocatorAdapter implements ProtocolLocatorAdapter {
  constructor(
    private readonly page: CdpPageAdapter,
    private readonly state: CdpLocatorState
  ) {}

  locator(selector: LocatorSelector): ProtocolLocatorAdapter {
    const chain = this.state.pick
      ? [...this.state.chain, locatorSelectorForPick(this.state.pick), selector]
      : [...this.state.chain, selector];
    return new CdpLocatorAdapter(this.page, {
      chain,
      ...(this.state.protocolFrameId ? { protocolFrameId: this.state.protocolFrameId } : {})
    });
  }

  getByText(text: string | RegExp, options?: GetByTextOptions): ProtocolLocatorAdapter {
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

  getByRole(role: string, options?: GetByRoleOptions): ProtocolLocatorAdapter {
    return this.locator(createRoleLocatorSelector(role, options));
  }

  getByTitle(text: string | RegExp, options?: { exact?: boolean }): ProtocolLocatorAdapter {
    return this.locator(createTitleLocatorSelector(text, options));
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
      ...(this.state.protocolFrameId ? { protocolFrameId: this.state.protocolFrameId } : {}),
      ...(this.state.pick ? { pick: this.state.pick } : {})
    });
  }

  async dispatchEvent(
    type: string,
    eventInit?: unknown,
    options?: DispatchEventOptions
  ): Promise<void> {
    void options;
    await this.page.runLocatorOperation<void>(this.state, {
      operation: "dispatchEvent",
      name: type,
      arg: eventInit
    });
  }

  async evaluate<TResult>(
    expression: string,
    arg?: unknown,
    isFunction?: boolean
  ): Promise<TResult> {
    return this.page.evaluateOnReference(
      {
        chain: this.state.chain,
        ...(this.state.protocolFrameId ? { protocolFrameId: this.state.protocolFrameId } : {}),
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
        ...(this.state.protocolFrameId ? { protocolFrameId: this.state.protocolFrameId } : {}),
        ...(this.state.pick ? { pick: this.state.pick } : {})
      },
      expression,
      arg,
      isFunction
    );
  }

  async evaluateHandle<TResult>(
    expression: string,
    arg?: unknown,
    isFunction = looksLikeFunctionExpression(expression)
  ): Promise<ProtocolJSHandleAdapter<TResult>> {
    const handle = await this.elementHandle();
    return handle.evaluateHandle
      ? handle.evaluateHandle<TResult>(expression, arg, isFunction)
      : this.page.evaluateHandle<TResult>(expression, arg, isFunction);
  }

  async boundingBox(): Promise<Rect | null> {
    return this.page.boundingBoxReference({
      chain: this.state.chain,
      ...(this.state.protocolFrameId ? { protocolFrameId: this.state.protocolFrameId } : {}),
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
      ...(this.state.protocolFrameId ? { protocolFrameId: this.state.protocolFrameId } : {}),
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
      ...(this.state.protocolFrameId ? { protocolFrameId: this.state.protocolFrameId } : {}),
      ...(this.state.pick ? { pick: this.state.pick } : {})
    });
    const handles: ProtocolElementHandleAdapter[] = [];
    for (let index = 0; index < count; index += 1) {
      const reference: ProtocolElementHandleReference = {
        chain: this.state.chain,
        ...(this.state.protocolFrameId ? { protocolFrameId: this.state.protocolFrameId } : {}),
        pick: { kind: "nth", index }
      };
      handles.push(this.page.createHandle(await this.page.createHandleReference(reference)));
    }
    return handles;
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
      ...(this.referenceState.handleId ? { handleId: this.referenceState.handleId } : {}),
      ...(this.referenceState.pick ? { pick: this.referenceState.pick } : {}),
      ...(this.referenceState.protocolFrameId ? { protocolFrameId: this.referenceState.protocolFrameId } : {}),
      ...(this.referenceState.protocolObjectId ? { protocolObjectId: this.referenceState.protocolObjectId } : {}),
      ...(this.referenceState.protocolSessionId ? { protocolSessionId: this.referenceState.protocolSessionId } : {}),
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
    return new CdpElementHandleAdapter(this.page, await this.page.createHandleReference({
      ...reference,
      pick: { kind: "first" }
    }));
  }

  async queryAll(selector: LocatorSelector[]): Promise<ProtocolElementHandleAdapter[]> {
    const reference: ProtocolElementHandleReference = {
      scope: this.reference(),
      chain: selector
    };
    const count = await this.page.countSelector(reference);
    const handles: ProtocolElementHandleAdapter[] = [];
    for (let index = 0; index < count; index += 1) {
      handles.push(new CdpElementHandleAdapter(this.page, await this.page.createHandleReference({
        ...reference,
        pick: { kind: "nth", index }
      })));
    }
    return handles;
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

  async evaluate<TResult>(
    expression: string,
    arg?: unknown,
    isFunction = looksLikeFunctionExpression(expression)
  ): Promise<TResult> {
    const handle = await this.page.resolveElementReferenceAsHandle(this.reference());
    try {
      return await handle.evaluate<TResult>(expression, arg, isFunction);
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  async evaluateHandle<TResult>(
    expression: string,
    arg?: unknown,
    isFunction = looksLikeFunctionExpression(expression)
  ): Promise<ProtocolJSHandleAdapter<TResult>> {
    const handle = await this.page.resolveElementReferenceAsHandle(this.reference());
    return handle.evaluateHandle<TResult>(expression, arg, isFunction);
  }

  async contentFrameId(): Promise<string | null> {
    return this.page.contentFrameIdForReference(this.reference());
  }

  async ownerFrameId(): Promise<string | null> {
    return this.page.ownerFrameIdForReference(this.reference());
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
    await this.page.tapReference(this.reference(), options);
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

class CdpWorkerDelegate implements WorkerDelegate {
  private closed = false;

  constructor(
    private readonly page: CdpPageAdapter,
    private readonly client: CdpClient,
    private readonly sessionId: string,
    private readonly workerUrl: string
  ) {}

  url(): string {
    return this.workerUrl;
  }

  markClosed(): void {
    this.closed = true;
  }

  async evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg?: Arg): Promise<R> {
    const response = await this.evaluateInWorker(pageFunction, arg, true);
    return parseEvaluationResultValue(response.result.value as SerializedValue) as R;
  }

  async evaluateHandle<R, Arg>(pageFunction: PageFunction<Arg, R>, arg?: Arg): Promise<SmartHandle<R>> {
    const expression = serializePageFunctionForWorker(pageFunction);
    const isFunction = typeof pageFunction === "function";
    const remoteHandle = await this.page.evaluateWithArgumentsInSession<R>(
      this.sessionId,
      undefined,
      expression,
      false,
      arg === undefined ? [] : [arg],
      isFunction
    );
    return await createRemoteJSHandle(remoteHandle) as SmartHandle<R>;
  }

  private async evaluateInWorker<R, Arg>(
    pageFunction: PageFunction<Arg, R>,
    arg: Arg | undefined,
    returnByValue: boolean
  ): Promise<{ exceptionDetails?: CdpExceptionDetails; result: CdpRemoteObject }> {
    if (this.closed) {
      throw new Error("Target page, context or browser has been closed");
    }
    const expression = serializePageFunctionForWorker(pageFunction);
    const serializedArg = serializeAsCallArgumentNoHandles(arg);
    const functionDeclaration = `async (serializedArg) => {
      ${PARSE_EVALUATION_RESULT_SOURCE}
      ${SERIALIZE_EVALUATION_RESULT_SOURCE}
      const arg = __roxyParseEvaluationResultValue(serializedArg);
      let result = (0, eval)(${serializeForEvaluation(normalizeEvaluationExpression(expression, typeof pageFunction === "function"))});
      if (${typeof pageFunction === "function" ? "true" : "false"})
        result = result(arg);
      return Promise.resolve(result).then(__roxySerializeEvaluationResult);
    }`;
    const runtimeClient = this.client as CdpRuntimeClient & {
      send(
        method: "Runtime.evaluate",
        params: {
          awaitPromise?: boolean;
          expression: string;
          returnByValue?: boolean;
        },
        sessionId?: string
      ): Promise<{ exceptionDetails?: CdpExceptionDetails; result: CdpRemoteObject }>;
      send(
        method: "Runtime.callFunctionOn",
        params: {
          arguments?: Array<{ value?: unknown }>;
          awaitPromise?: boolean;
          functionDeclaration: string;
          objectId?: string;
          returnByValue?: boolean;
          userGesture?: boolean;
        },
        sessionId?: string
      ): Promise<{ exceptionDetails?: CdpExceptionDetails; result: CdpRemoteObject }>;
      send(method: "Runtime.releaseObject", params: { objectId: string }, sessionId?: string): Promise<unknown>;
    };
    const globalHandle = await runtimeClient.send("Runtime.evaluate", {
      expression: "globalThis",
      awaitPromise: true,
      returnByValue: false
    }, this.sessionId);
    if (globalHandle.exceptionDetails) {
      throw normalizeWorkerEvaluationError(formatCdpEvaluationError(globalHandle));
    }
    const objectId = globalHandle.result.objectId;
    if (!objectId) {
      throw new Error("Worker execution context is not available.");
    }
    try {
      const response = await runtimeClient.send("Runtime.callFunctionOn", {
        functionDeclaration,
        objectId,
        arguments: [{ value: serializedArg }],
        awaitPromise: true,
        returnByValue,
        userGesture: true
      }, this.sessionId);
      if (response.exceptionDetails) {
        throw normalizeWorkerEvaluationError(formatCdpEvaluationError(response));
      }
      return response;
    } finally {
      await runtimeClient.send("Runtime.releaseObject", { objectId }, this.sessionId).catch(() => {});
    }
  }
}

function normalizeWorkerEvaluationError(message: string): Error {
  if (message.includes("Session with given id not found.") || isClosedCdpConnectionError(message)) {
    return new Error("Target page, context or browser has been closed");
  }
  return new Error(message);
}

class CdpJSHandleAdapter<T = unknown> implements ProtocolJSHandleAdapter<T> {
  private disposed = false;

  constructor(
    private readonly page: CdpPageAdapter,
    private readonly remoteObject: CdpRemoteObject,
    private readonly runtimeSessionId?: string,
    private readonly runtimeFrameId?: string
  ) {}

  sessionId(): string | undefined {
    return this.runtimeSessionId;
  }

  frameId(): string | undefined {
    return this.runtimeFrameId;
  }

  async evaluate<TResult>(
    expression: string,
    arg?: unknown,
    isFunction = looksLikeFunctionExpression(expression)
  ): Promise<TResult> {
    return this.page.evaluateWithArgumentsInSession<TResult>(
      this.runtimeSessionId,
      this.runtimeFrameId,
      expression,
      true,
      arg === undefined
        ? [new RoxyJSHandle(undefined, null, undefined, this)]
        : [new RoxyJSHandle(undefined, null, undefined, this), arg],
      isFunction
    );
  }

  async evaluateHandle<TResult>(
    expression: string,
    arg?: unknown,
    isFunction = looksLikeFunctionExpression(expression)
  ): Promise<ProtocolJSHandleAdapter<TResult>> {
    return this.page.evaluateWithArgumentsInSession<TResult>(
      this.runtimeSessionId,
      this.runtimeFrameId,
      expression,
      false,
      arg === undefined
        ? [new RoxyJSHandle(undefined, null, undefined, this)]
        : [new RoxyJSHandle(undefined, null, undefined, this), arg],
      isFunction
    );
  }

  async jsonValue(): Promise<T> {
    if (!this.remoteObject.objectId) {
      return cdpRemoteObjectValue(this.remoteObject) as T;
    }
    return this.page.evaluateWithArgumentsInSession<T>(
      this.runtimeSessionId,
      this.runtimeFrameId,
      "(value) => value",
      true,
      [new RoxyJSHandle(undefined, null, undefined, this)],
      true
    );
  }

  async getProperties(): Promise<Map<string, ProtocolJSHandleAdapter>> {
    if (!this.remoteObject.objectId) {
      return new Map();
    }
    const response = await this.page.sendRuntimeGetProperties({
      objectId: this.remoteObject.objectId,
      ownProperties: true
    }, this.runtimeSessionId);
    const properties = new Map<string, ProtocolJSHandleAdapter>();
    for (const property of response.result) {
      if (!property.enumerable || !property.value) {
        continue;
      }
      properties.set(property.name, new CdpJSHandleAdapter(this.page, property.value, this.runtimeSessionId, this.runtimeFrameId));
    }
    return properties;
  }

  async getProperty(propertyName: string): Promise<ProtocolJSHandleAdapter> {
    if (!this.remoteObject.objectId) {
      if (!this.remoteObject || typeof cdpRemoteObjectValue(this.remoteObject) !== "object") {
        return new CdpJSHandleAdapter(this.page, {
          type: "undefined",
          value: undefined
        }, this.runtimeSessionId, this.runtimeFrameId);
      }
      return new CdpJSHandleAdapter(this.page, serializeLocalValueAsCdpRemoteObject(
        (cdpRemoteObjectValue(this.remoteObject) as Record<string, unknown>)[propertyName]
      ), this.runtimeSessionId, this.runtimeFrameId);
    }

    const response = await this.page.sendRuntimeCallFunctionOn({
      objectId: this.remoteObject.objectId,
      functionDeclaration: "function(name) { const result = { __proto__: null }; result[name] = this[name]; return result; }",
      arguments: [{ value: propertyName }],
      returnByValue: false,
      awaitPromise: true
    }, this.runtimeSessionId).catch((error) => {
      const message = String(error instanceof Error ? error.message : error);
      if (message.includes("Session with given id not found.") || isClosedCdpConnectionError(error)) {
        throw new Error("Target page, context or browser has been closed");
      }
      throw error;
    });

    if (response.exceptionDetails) {
      throw new Error(formatCdpEvaluationError(response));
    }

    const wrapperObject = response.result;
    if (!wrapperObject.objectId) {
      return new CdpJSHandleAdapter(this.page, {
        type: "undefined",
        value: undefined
      }, this.runtimeSessionId, this.runtimeFrameId);
    }

    try {
      const properties = await this.page.sendRuntimeGetProperties({
        objectId: wrapperObject.objectId,
        ownProperties: true
      }, this.runtimeSessionId).catch((error) => {
        const message = String(error instanceof Error ? error.message : error);
        if (message.includes("Session with given id not found.") || isClosedCdpConnectionError(error)) {
          throw new Error("Target page, context or browser has been closed");
        }
        throw error;
      });
      for (const property of properties.result) {
        if (property.name === propertyName && property.enumerable && property.value) {
          return new CdpJSHandleAdapter(
            this.page,
            property.value,
            this.runtimeSessionId,
            this.runtimeFrameId
          );
        }
      }
      return new CdpJSHandleAdapter(this.page, {
        type: "undefined",
        value: undefined
      }, this.runtimeSessionId, this.runtimeFrameId);
    } finally {
      await this.page.sendRuntimeReleaseObject({
        objectId: wrapperObject.objectId
      }, this.runtimeSessionId).catch(() => {});
    }
  }

  preview(): string {
    return cdpRemoteObjectPreview(this.remoteObject);
  }

  rawValue(): T | undefined {
    return cdpRemoteObjectValue(this.remoteObject) as T | undefined;
  }

  serializedValue(): SerializedValue | undefined {
    return cdpSerializedRemoteObjectValue(this.remoteObject);
  }

  remoteObjectId(): string | undefined {
    return this.remoteObject.objectId;
  }

  async asElementReference(): Promise<ProtocolElementHandleReference | null> {
    if (this.remoteObject.subtype !== "node") {
      return null;
    }
    return this.page.storeRemoteElementHandle(this, { disposeHandle: false });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.remoteObject.objectId) {
      await this.page.sendRuntimeReleaseObject({
        objectId: this.remoteObject.objectId
      }, this.runtimeSessionId).catch(() => {});
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
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

function createSessionTargetClient(browserClient: CdpClient, sessionId: string): CdpClient {
  const browserEventClient = browserClient as CdpClient & {
    once(event: string, listener: (...args: unknown[]) => void): CdpClient;
    removeListener(event: string, listener: (...args: unknown[]) => void): CdpClient;
  };
  const sessionClient = Object.create(browserClient) as CdpClient & {
    close(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): CdpClient;
    once(event: string, listener: (...args: unknown[]) => void): CdpClient;
    removeListener(event: string, listener: (...args: unknown[]) => void): CdpClient;
  };
  const browserEventName = (event: string) => {
    if (!event.includes(".") || event === "ready" || event === "error" || event === "connect") {
      return event;
    }
    return event.endsWith(`.${sessionId}`) ? event : `${event}.${sessionId}`;
  };

  sessionClient.send = ((method: string, params?: Record<string, unknown>, explicitSessionId?: string) =>
    sendBrowserCommandInSession(browserClient, method, params ?? {}, explicitSessionId ?? sessionId)) as CdpClient["send"];
  sessionClient.close = async () => {
    await browserClient.Target.detachFromTarget?.({ sessionId }).catch(() => {});
  };
  sessionClient.on = ((event: string, listener: (...args: unknown[]) => void) =>
    event === "disconnect"
      ? browserClient.Target?.detachedFromTarget?.((payload: { sessionId?: string }) => {
          if (payload.sessionId === sessionId) {
            listener();
          }
        }) as unknown as CdpClient
      : browserClient.on(browserEventName(event), listener)) as typeof sessionClient.on;
  sessionClient.once = ((event: string, listener: (...args: unknown[]) => void) =>
    event === "disconnect"
      ? browserEventClient.once(`Target.detachedFromTarget.${sessionId}`, () => listener()) as unknown as CdpClient
      : browserEventClient.once(browserEventName(event), listener)) as typeof sessionClient.once;
  sessionClient.removeListener = ((event: string, listener: (...args: unknown[]) => void) =>
    browserEventClient.removeListener(browserEventName(event), listener)) as typeof sessionClient.removeListener;

  for (const domain of Object.keys(browserClient)) {
    const originalDomain = (browserClient as Record<string, unknown>)[domain];
    if (!originalDomain || typeof originalDomain !== "object") {
      continue;
    }
    (sessionClient as Record<string, unknown>)[domain] = createSessionDomainProxy(browserClient, domain, originalDomain, sessionId);
  }

  return sessionClient as CdpClient;
}

function createSessionDomainProxy(
  browserClient: CdpClient,
  domainName: string,
  originalDomain: object,
  sessionId: string
): object {
  const domain = Object.create(originalDomain) as Record<string, unknown>;
  for (const property of Object.keys(originalDomain)) {
    const originalValue = (originalDomain as Record<string, unknown>)[property];
    if (typeof originalValue !== "function") {
      domain[property] = originalValue;
      continue;
    }
    const metadata = originalValue as { category?: string };
    if (metadata.category === "command") {
      domain[property] = ((params?: Record<string, unknown>, explicitSessionId?: string, callback?: unknown) =>
        (originalValue as (...args: unknown[]) => unknown)(
          params,
          typeof explicitSessionId === "string" ? explicitSessionId : sessionId,
          typeof explicitSessionId === "function" ? explicitSessionId : callback
        )) as typeof originalValue;
      continue;
    }
    if (metadata.category === "event") {
      domain[property] = ((explicitSessionIdOrHandler?: string | ((...args: unknown[]) => void), handler?: (...args: unknown[]) => void) =>
        typeof explicitSessionIdOrHandler === "function"
          ? (originalValue as (...args: unknown[]) => unknown)(sessionId, explicitSessionIdOrHandler)
          : (originalValue as (...args: unknown[]) => unknown)(explicitSessionIdOrHandler ?? sessionId, handler)) as typeof originalValue;
      continue;
    }
    if (property === "on") {
      domain[property] = ((eventName: string, handler: (...args: unknown[]) => void) =>
        (originalValue as (...args: unknown[]) => unknown)(eventName, sessionId, handler)) as typeof originalValue;
      continue;
    }
    domain[property] = originalValue.bind(originalDomain);
  }
  for (const property of Object.keys(browserClient)) {
    if (!property.startsWith(`${domainName}.`)) {
      continue;
    }
    const originalValue = (browserClient as Record<string, unknown>)[property];
    if (typeof originalValue !== "function") {
      continue;
    }
    const shortName = property.slice(domainName.length + 1);
    if (shortName in domain) {
      continue;
    }
    const metadata = originalValue as { category?: string };
    if (metadata.category === "command") {
      domain[shortName] = ((params?: Record<string, unknown>, explicitSessionId?: string, callback?: unknown) =>
        (originalValue as (...args: unknown[]) => unknown)(
          params,
          typeof explicitSessionId === "string" ? explicitSessionId : sessionId,
          typeof explicitSessionId === "function" ? explicitSessionId : callback
        )) as typeof originalValue;
    } else if (metadata.category === "event") {
      domain[shortName] = ((explicitSessionIdOrHandler?: string | ((...args: unknown[]) => void), handler?: (...args: unknown[]) => void) =>
        typeof explicitSessionIdOrHandler === "function"
          ? (originalValue as (...args: unknown[]) => unknown)(sessionId, explicitSessionIdOrHandler)
          : (originalValue as (...args: unknown[]) => unknown)(explicitSessionIdOrHandler ?? sessionId, handler)) as typeof originalValue;
    }
  }
  return domain;
}

function sendBrowserCommandInSession(
  browserClient: CdpClient,
  method: string,
  params: Record<string, unknown>,
  sessionId: string
): Promise<unknown> {
  const client = browserClient as CdpClient & {
    send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  };
  const command = client.send(method, params, sessionId);
  command.catch(() => {});
  return command;
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
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const unregisterTestBrowserProcess = registerTestBrowserProcessForCleanup(
      processRef,
      userDataDir
    );

    try {
      const browserWsEndpoint = await waitForDebuggerEndpoint(processRef, userDataDir, 15_000);
      const connection = buildConnectionFromWsEndpoint(browserWsEndpoint);
      return {
        ...connection,
        spawnedProcess: processRef,
        userDataDir,
        unregisterTestBrowserProcess
      };
    } catch (error) {
      unregisterTestBrowserProcess();
      lastError = error;
      await terminateProcessTree(processRef, { timeoutMs: 500 });
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
  const { spawnedProcess, unregisterTestBrowserProcess, userDataDir } = connection;

  try {
    if (spawnedProcess) {
      await terminateProcessTree(spawnedProcess, { timeoutMs: 3_000 });
    }
  } finally {
    unregisterTestBrowserProcess?.();
  }

  if (userDataDir) {
    await rm(userDataDir, {
      force: true,
      recursive: true
    });
  }
}

export async function waitForDebuggerEndpoint(
  processRef: ChildProcess,
  userDataDir: string,
  timeoutMs: number
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let activePortTimer: ReturnType<typeof setInterval> | undefined;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      if (activePortTimer) {
        clearInterval(activePortTimer);
      }
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

    const activePortPath = join(userDataDir, "DevToolsActivePort");
    activePortTimer = setInterval(() => {
      void readDevToolsActivePort(activePortPath)
        .then((endpoint) => {
          if (endpoint) {
            finish(() => resolve(endpoint));
          }
        })
        .catch(() => {});
    }, 50);

    processRef.stderr?.on("data", onData);
    processRef.stdout?.on("data", onData);
    processRef.once("error", onError);
    processRef.once("exit", onExit);
  });
}

export async function readDevToolsActivePort(filePath: string): Promise<string | null> {
  const content = await readFile(filePath, "utf8").catch(() => null);
  if (!content) {
    return null;
  }

  const [portLine] = content.split(/\r?\n/);
  const port = Number(portLine?.trim());
  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }

  return `ws://127.0.0.1:${port}/devtools/browser`;
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
  platform = currentPlatform(),
  fileExistsFn = fileExists
): string[] {
  if (options.executablePath) {
    return [options.executablePath];
  }

  if (options.channel) {
    return executableCandidatesForChannel(options.channel, platform);
  }

  return filterExistingExecutableCandidates(defaultExecutableCandidates(platform), platform, fileExistsFn);
}

export function buildChromiumLaunchArgs(
  options: Pick<LaunchOptions, "args" | "headless">,
  userDataDir: string
): string[] {
  return [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-popup-blocking",
    "--disable-renderer-backgrounding",
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

function filterExistingExecutableCandidates(
  candidates: string[],
  platform: string,
  fileExistsFn: (path: string) => boolean
): string[] {
  if (platform === "linux") {
    return candidates;
  }
  const existing = candidates.filter(fileExistsFn);
  return existing.length > 0 ? existing : candidates;
}

function fileExists(path: string): boolean {
  try {
    accessSync(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
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

function mapCdpHeaders(
  headers: Record<string, string | number | boolean | Array<string | number | boolean>>,
  separator = ", "
): Array<{
  name: string;
  value: string;
}> {
  const entries: Array<{ name: string; value: string }> = [];
  for (const [name, rawValue] of Object.entries(headers)) {
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) {
        entries.push({
          name,
          value: String(value)
        });
      }
      continue;
    }
    const text = String(rawValue);
    if (separator === "\n" && text.includes("\n")) {
      for (const value of text.split("\n")) {
        entries.push({
          name,
          value
        });
      }
      continue;
    }
    if (separator === "\n" && text.includes("\r\n")) {
      for (const value of text.split("\r\n")) {
        if (!value) {
          continue;
        }
        entries.push({
          name,
          value
        });
      }
      continue;
    }
    if (separator === "\n" && name.toLowerCase() === "set-cookie" && text.includes(", ")) {
      entries.push({
        name,
        value: text
      });
      continue;
    }
    if (text.includes(separator) && separator === "\n") {
      for (const value of text.split(separator)) {
        if (!value) {
          continue;
        }
        entries.push({
          name,
          value
        });
      }
      continue;
    }
    entries.push({
      name,
      value: text
    });
  }
  return entries;
}

function parseCdpHeadersText(headersText: string | undefined): Array<{ name: string; value: string }> | null {
  if (!headersText) {
    return null;
  }
  const entries: Array<{ name: string; value: string }> = [];
  for (const line of headersText.split(/\r?\n/)) {
    if (!line || line.startsWith("HTTP/")) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    entries.push({
      name: line.slice(0, separatorIndex),
      value: line.slice(separatorIndex + 1).trimStart()
    });
  }
  return entries.length ? entries : null;
}

function splitSetCookieHeader(
  headers: Array<{ name: string; value: string }>
): Array<{ name: string; value: string }> {
  const index = headers.findIndex(({ name }) => name.toLowerCase() === "set-cookie");
  if (index === -1) {
    return headers;
  }

  const header = headers[index];
  if (!header) {
    return headers;
  }

  const values = header.value.split("\n");
  if (values.length === 1) {
    return headers;
  }

  const result = headers.slice();
  result.splice(index, 1, ...values.map((value) => ({ name: header.name, value })));
  return result;
}

function applyCdpHeaderOverrides(
  originalHeaders: Record<string, string>,
  overrides: Array<{ name: string; value: string }>
): Array<{ name: string; value: string }> {
  const result = new Map<string, { name: string; value: string }>();
  for (const override of overrides) {
    if (!isForbiddenRequestHeader(override.name, override.value)) {
      result.set(override.name.toLowerCase(), { ...override });
    }
  }
  for (const [name, value] of Object.entries(originalHeaders)) {
    if (isForbiddenRequestHeader(name, value)) {
      result.set(name.toLowerCase(), { name, value });
    }
  }
  return [...result.values()];
}

const FORBIDDEN_REQUEST_HEADER_NAMES = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via"
]);

const FORBIDDEN_REQUEST_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);

function isForbiddenRequestHeader(name: string, value?: string): boolean {
  const lowerName = name.toLowerCase();
  if (FORBIDDEN_REQUEST_HEADER_NAMES.has(lowerName)) {
    return true;
  }
  if (lowerName.startsWith("proxy-") || lowerName.startsWith("sec-")) {
    return true;
  }
  if (
    lowerName === "x-http-method" ||
    lowerName === "x-http-method-override" ||
    lowerName === "x-method-override"
  ) {
    return value !== undefined && FORBIDDEN_REQUEST_METHODS.has(value.toUpperCase());
  }
  return false;
}

function isCdpPreflightRequest(event: {
  request: {
    headers: Record<string, string>;
    method: string;
  };
}): boolean {
  return (
    event.request.method === "OPTIONS" &&
    Boolean(cdpHeaderValue(event.request.headers, "access-control-request-method"))
  );
}

function cdpPreflightResponseHeaders(
  requestHeaders: Record<string, string>
): Array<{ name: string; value: string }> {
  const headers: Array<{ name: string; value: string }> = [
    {
      name: "Access-Control-Allow-Origin",
      value: cdpHeaderValue(requestHeaders, "origin") ?? "*"
    },
    {
      name: "Access-Control-Allow-Methods",
      value: cdpHeaderValue(requestHeaders, "access-control-request-method") ?? "GET, POST, OPTIONS, DELETE"
    },
    {
      name: "Access-Control-Allow-Credentials",
      value: "true"
    }
  ];
  const requestedHeaders = cdpHeaderValue(requestHeaders, "access-control-request-headers");
  if (requestedHeaders) {
    headers.push({
      name: "Access-Control-Allow-Headers",
      value: requestedHeaders
    });
  }
  return headers;
}

function cdpHeaderValue(headers: Record<string, string>, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === normalizedName) {
      return value;
    }
  }
  return undefined;
}

function isNetworkIdleIgnoredRequestUrl(url: string): boolean {
  return url.startsWith("ws://") || url.startsWith("wss://");
}

function normalizeHeaderRecord(
  headers: Record<string, string | number | boolean>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)])
  );
}

function cdpErrorReasonForRoute(errorCode?: string): FetchErrorReason {
  switch ((errorCode ?? "failed").toLowerCase()) {
    case "aborted":
      return "Aborted";
    case "timedout":
      return "TimedOut";
    case "accessdenied":
      return "AccessDenied";
    case "connectionclosed":
      return "ConnectionClosed";
    case "connectionreset":
      return "ConnectionReset";
    case "connectionrefused":
      return "ConnectionRefused";
    case "connectionaborted":
      return "ConnectionAborted";
    case "connectionfailed":
      return "ConnectionFailed";
    case "namenotresolved":
      return "NameNotResolved";
    case "internetdisconnected":
      return "InternetDisconnected";
    case "addressunreachable":
      return "AddressUnreachable";
    case "blockedbyclient":
      return "BlockedByClient";
    case "blockedbyresponse":
      return "BlockedByResponse";
    default:
      return "Failed";
  }
}

function cdpFailureTextForRoute(errorCode?: string): string {
  switch ((errorCode ?? "failed").toLowerCase()) {
    case "aborted":
      return "net::ERR_ABORTED";
    case "timedout":
      return "net::ERR_TIMED_OUT";
    case "accessdenied":
      return "net::ERR_ACCESS_DENIED";
    case "connectionclosed":
      return "net::ERR_CONNECTION_CLOSED";
    case "connectionreset":
      return "net::ERR_CONNECTION_RESET";
    case "connectionrefused":
      return "net::ERR_CONNECTION_REFUSED";
    case "connectionaborted":
      return "net::ERR_CONNECTION_ABORTED";
    case "connectionfailed":
      return "net::ERR_CONNECTION_FAILED";
    case "namenotresolved":
      return "net::ERR_NAME_NOT_RESOLVED";
    case "internetdisconnected":
      return "net::ERR_INTERNET_DISCONNECTED";
    case "addressunreachable":
      return "net::ERR_ADDRESS_UNREACHABLE";
    case "blockedbyclient":
      return "net::ERR_BLOCKED_BY_CLIENT";
    case "blockedbyresponse":
      return "net::ERR_BLOCKED_BY_RESPONSE";
    default:
      return "net::ERR_FAILED";
  }
}

async function safelyCloseClient(client: CdpClient): Promise<void> {
  try {
    await withCloseTimeout(
      Promise.resolve().then(() => client.close()),
      CDP_CLIENT_CLOSE_TIMEOUT_MS
    );
  } catch {}
}

async function withCloseTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function resolveUrl(url: string, baseURL?: string): string {
  const resolved = baseURL ? new URL(url, baseURL).toString() : url;
  if (resolved.startsWith("localhost") || resolved.startsWith("127.0.0.1")) {
    return `http://${resolved}`;
  }
  return resolved;
}

function verifyLifecycle(name: string, waitUntil: WaitUntilState): WaitUntilState {
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

function serializeForEvaluation(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function serializePageFunctionForWorker<R, Arg>(pageFunction: PageFunction<Arg, R>): string {
  return typeof pageFunction === "string" ? pageFunction : pageFunction.toString();
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

function exceptionToError(exceptionDetails: {
  exception?: {
    description?: string;
    preview?: {
      properties?: Array<{ name: string; value?: string }>;
    };
    value?: unknown;
  };
  stackTrace?: {
    callFrames: Array<{
      columnNumber: number;
      functionName?: string;
      lineNumber: number;
      url: string;
    }>;
  };
  text: string;
}): Error {
  const messageWithStack = getCdpExceptionMessage(exceptionDetails);
  const lines = messageWithStack.split("\n");
  const firstStackTraceLine = lines.findIndex((line) => line.startsWith("    at"));
  const messageWithName =
    firstStackTraceLine === -1 ? messageWithStack : lines.slice(0, firstStackTraceLine).join("\n");
  const stack = firstStackTraceLine === -1 ? "" : messageWithStack;
  let normalizedMessageWithName = messageWithName.replace(/^Uncaught\s+/, "");
  const objectMessage = normalizedMessageWithName.match(/^\[object (.*)\]$/);
  if (objectMessage) {
    normalizedMessageWithName = objectMessage[1]!;
  }
  const { name, message } = splitErrorMessage(normalizedMessageWithName);
  const error = new Error(message);
  error.stack = stack;
  const nameOverride = exceptionDetails.exception?.preview?.properties?.find((property) => property.name === "name");
  error.name = nameOverride ? nameOverride.value ?? "Error" : name;
  return error;
}

function getCdpExceptionMessage(exceptionDetails: {
  exception?: {
    className?: string;
    description?: string;
    subtype?: string;
    type?: string;
    value?: unknown;
  };
  stackTrace?: {
    callFrames: Array<{
      columnNumber: number;
      functionName?: string;
      lineNumber: number;
      url: string;
    }>;
  };
  text: string;
}): string {
  if (exceptionDetails.exception) {
    if (
      exceptionDetails.exception.type === "object" &&
      exceptionDetails.exception.className &&
      exceptionDetails.exception.description === `[object ${exceptionDetails.exception.className}]`
    ) {
      return exceptionDetails.exception.className;
    }
    const objectDescription = exceptionDetails.exception.description?.match(/^\[object (.*)\]$/);
    if (exceptionDetails.exception.type === "object" && objectDescription) {
      return objectDescription[1]!;
    }
    return exceptionDetails.exception.description || String(exceptionDetails.exception.value);
  }
  let message = exceptionDetails.text;
  if (exceptionDetails.stackTrace) {
    for (const callFrame of exceptionDetails.stackTrace.callFrames) {
      const location = `${callFrame.url}:${callFrame.lineNumber}:${callFrame.columnNumber}`;
      const functionName = callFrame.functionName || "<anonymous>";
      message += `\n    at ${functionName} (${location})`;
    }
  }
  return message;
}

function splitErrorMessage(message: string): { name: string; message: string } {
  const separationIndex = message.indexOf(":");
  return {
    name: separationIndex !== -1 ? message.slice(0, separationIndex) : "",
    message:
      separationIndex !== -1 && separationIndex + 2 <= message.length
        ? message.substring(separationIndex + 2)
        : message
  };
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

function createCdpConsoleHandle(
  page: CdpPageAdapter,
  arg: {
  className?: string;
  description?: string;
  subtype?: string;
  type?: string;
  objectId?: string;
  unserializableValue?: string;
  value?: unknown;
  },
  runtimeSessionId?: string
) {
  return new RoxyJSHandle(
    cdpRemoteObjectValue(arg),
    null,
    cdpRemoteObjectPreview(arg),
    new CdpJSHandleAdapter(page, arg, runtimeSessionId)
  );
}

function serializeLocalValueAsCdpRemoteObject(value: unknown): CdpRemoteObject {
  if (value === undefined) {
    return { type: "undefined", value: undefined };
  }
  if (value === null) {
    return { type: "object", subtype: "null", value: null };
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return { type: "number", unserializableValue: "NaN" };
    }
    if (value === Infinity) {
      return { type: "number", unserializableValue: "Infinity" };
    }
    if (value === -Infinity) {
      return { type: "number", unserializableValue: "-Infinity" };
    }
    if (Object.is(value, -0)) {
      return { type: "number", unserializableValue: "-0" };
    }
    return { type: "number", value };
  }
  if (typeof value === "bigint") {
    return { type: "bigint", unserializableValue: `${value}n` };
  }
  if (typeof value === "string") {
    return { type: "string", value };
  }
  if (typeof value === "boolean") {
    return { type: "boolean", value };
  }
  return {
    type: "object",
    value
  };
}

async function serializeCdpEvaluationArguments(
  args: unknown[],
  page: CdpPageAdapter,
  temporaryHandles: ProtocolJSHandleAdapter[],
  target: CdpEvaluationTargetContext
): Promise<{
  handles: RoxyJSHandle[];
  values: SerializedValue[];
}> {
  const handles: RoxyJSHandle[] = [];
  const pushHandle = (handle: RoxyJSHandle): number => {
    handles.push(handle);
    return handles.length - 1;
  };
  const values: SerializedValue[] = [];
  for (const arg of args) {
    const elementHandles: Array<{
      handle: RoxyElementHandle;
      marker: { __roxyElementEvaluationHandle: number };
    }> = [];
    const jsHandleMarkers: Array<{
      handle: RoxyJSHandle;
      marker: { __roxyJsEvaluationHandle: number };
    }> = [];
    const serialized = serializeAsCallArgument(arg, (value) => {
      if (value instanceof RoxyElementHandle) {
        const marker = { __roxyElementEvaluationHandle: elementHandles.length };
        elementHandles.push({ handle: value, marker });
        return { fallThrough: marker };
      }
      if (value instanceof RoxyJSHandle && value._remoteObjectId() && !isRoxyHandleInTargetContext(value, target)) {
        const marker = { __roxyJsEvaluationHandle: jsHandleMarkers.length };
        jsHandleMarkers.push({ handle: value, marker });
        return { fallThrough: marker };
      }
      return serializeCdpEvaluationValue(value, pushHandle, target);
    });
    for (const { handle, marker } of jsHandleMarkers) {
      const elementReference = await handle._asElementReference();
      if (!elementReference) {
        throw new Error("JSHandles can be evaluated only in the context they were created!");
      }
      const remoteHandle = await page.adoptElementHandleToContext(elementReference, target);
      temporaryHandles.push(remoteHandle);
      const roxyHandle = new RoxyJSHandle(undefined, null, undefined, remoteHandle);
      replaceJsHandleMarker(serialized, marker, { h: pushHandle(roxyHandle) });
    }
    for (const { handle, marker } of elementHandles) {
      const remoteHandle = await page.adoptElementHandleToContext(handle.reference(), target);
      temporaryHandles.push(remoteHandle);
      const roxyHandle = new RoxyJSHandle(undefined, null, undefined, remoteHandle);
      replaceElementHandleMarker(serialized, marker, { h: pushHandle(roxyHandle) });
    }
    values.push(serialized);
  }
  return { handles, values };
}

function serializeCdpEvaluationValue(
  value: unknown,
  pushHandle: (handle: RoxyJSHandle) => number,
  target: CdpEvaluationTargetContext
) {
    if (value instanceof RoxyJSHandle) {
      const objectId = value._remoteObjectId();
      if (objectId) {
        if (!isRoxyHandleInTargetContext(value, target)) {
          throw new Error("JSHandles can be evaluated only in the context they were created!");
        }
        return { h: pushHandle(value) };
      }
      const serializedValue = value._serializedValue();
      if (serializedValue !== undefined) {
        return { fallThrough: parseEvaluationResultValue(serializedValue) };
      }
      return { fallThrough: value.rawValue() };
    }
    return { fallThrough: value };
}

function isRoxyHandleInTargetContext(
  handle: RoxyJSHandle,
  target: CdpEvaluationTargetContext
): boolean {
  if (!handle._remoteObjectId()) {
    return false;
  }
  const handleFrameId = handle._remoteFrameId();
  if (handleFrameId || target.frameId) {
    return handleFrameId === target.frameId;
  }
  return handle._remoteSessionId() === target.sessionId;
}

function isFrameExecutionContextUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Frame execution context is not available");
}

function isFrameExecutionContextTransitionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("Frame execution context is not available")
    || error.message.includes("Cannot find context with specified id")
    || error.message.includes("Execution context was destroyed");
}

function replaceJsHandleMarker(
  value: SerializedValue,
  marker: { __roxyJsEvaluationHandle: number },
  replacement: { h: number },
  visited = new Set<object>()
): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (visited.has(value)) {
    return false;
  }
  visited.add(value);
  if ("o" in value) {
    if (
      value.o.length === 1 &&
      value.o[0]?.k === "__roxyJsEvaluationHandle" &&
      value.o[0].v === marker.__roxyJsEvaluationHandle
    ) {
      Object.assign(value, replacement);
      delete (value as { o?: unknown }).o;
      delete (value as { id?: unknown }).id;
      return true;
    }
    for (const entry of value.o) {
      if (replaceJsHandleMarker(entry.v, marker, replacement, visited)) {
        return true;
      }
    }
  }
  if ("a" in value) {
    for (const entry of value.a) {
      if (replaceJsHandleMarker(entry, marker, replacement, visited)) {
        return true;
      }
    }
  }
  return false;
}

function replaceElementHandleMarker(
  value: SerializedValue,
  marker: { __roxyElementEvaluationHandle: number },
  replacement: { h: number },
  visited = new Set<object>()
): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (visited.has(value)) {
    return false;
  }
  visited.add(value);
  if ("o" in value) {
    if (
      value.o.length === 1 &&
      value.o[0]?.k === "__roxyElementEvaluationHandle" &&
      value.o[0].v === marker.__roxyElementEvaluationHandle
    ) {
      Object.assign(value, replacement);
      delete (value as { o?: unknown }).o;
      delete (value as { id?: unknown }).id;
      return true;
    }
    for (const entry of value.o) {
      if (replaceElementHandleMarker(entry.v, marker, replacement, visited)) {
        return true;
      }
    }
  }
  if ("a" in value) {
    for (const entry of value.a) {
      if (replaceElementHandleMarker(entry, marker, replacement, visited)) {
        return true;
      }
    }
  }
  return false;
}

function normalizeEvaluationExpression(expression: string, isFunction: boolean | undefined): string {
  let normalized = expression.trim();

  if (isFunction) {
    try {
      new Function(`(${normalized})`);
    } catch {
      if (normalized.startsWith("async ")) {
        normalized = `async function ${normalized.substring("async ".length)}`;
      } else {
        normalized = `function ${normalized}`;
      }
      try {
        new Function(`(${normalized})`);
      } catch {
        throw new Error("Passed function is not well-serializable!");
      }
    }
  }

  if (/^(async\s+)?function(\s|\()/.test(normalized)) {
    normalized = `(${normalized})`;
  }
  return normalized;
}

function cdpSerializedRemoteObjectValue(arg: CdpRemoteObject): SerializedValue | undefined {
  if (arg.unserializableValue) {
    switch (arg.unserializableValue) {
      case "NaN":
        return { v: "NaN" };
      case "Infinity":
        return { v: "Infinity" };
      case "-Infinity":
        return { v: "-Infinity" };
      case "-0":
        return { v: "-0" };
      default:
        return undefined;
    }
  }
  if ("value" in arg) {
    if (arg.value === undefined) {
      return { v: "undefined" };
    }
    if (arg.value === null) {
      return { v: "null" };
    }
    if (
      typeof arg.value === "boolean" ||
      typeof arg.value === "number" ||
      typeof arg.value === "string"
    ) {
      return arg.value;
    }
  }
  if (arg.subtype === "null") {
    return { v: "null" };
  }
  return undefined;
}

function cdpRemoteObjectValue(arg: {
  className?: string;
  description?: string;
  preview?: {
    properties?: Array<{
      name: string;
      type?: string;
      value?: string;
      valuePreview?: { description?: string };
    }>;
    subtype?: string;
  };
  subtype?: string;
  type?: string;
  unserializableValue?: string;
  value?: unknown;
}): unknown {
  if (arg.unserializableValue) {
    switch (arg.unserializableValue) {
      case "NaN":
        return NaN;
      case "Infinity":
        return Infinity;
      case "-Infinity":
        return -Infinity;
      case "-0":
        return -0;
      default:
        return arg.unserializableValue;
    }
  }
  if ("value" in arg) {
    return arg.value;
  }
  if (arg.subtype === "null") {
    return null;
  }
  if (arg.className === "Window") {
    return "ref: <Window>";
  }
  if (arg.className === "Document") {
    return "ref: <Document>";
  }
  if (arg.subtype === "node") {
    return "ref: <Node>";
  }
  if (arg.subtype === "array" && arg.description) {
    return parseCdpArrayPreview(arg.description);
  }
  if (arg.preview?.properties?.length) {
    return Object.fromEntries(
      arg.preview.properties.map((property) => [
        property.name,
        parseCdpPreviewPrimitive(property.value ?? property.valuePreview?.description ?? property.type ?? "")
      ])
    );
  }
  if (arg.type === "object" && arg.description) {
    return parseCdpObjectPreview(arg.description);
  }
  return undefined;
}

function cdpRemoteObjectPreview(arg: {
  className?: string;
  description?: string;
  preview?: {
    properties?: Array<{
      name: string;
      type?: string;
      value?: string;
      valuePreview?: { description?: string };
    }>;
    subtype?: string;
  };
  subtype?: string;
  type?: string;
  unserializableValue?: string;
  value?: unknown;
}): string {
  if (typeof arg.value === "string") {
    return arg.value;
  }
  if (arg.value !== undefined) {
    return String(arg.value);
  }
  if (arg.unserializableValue) {
    return arg.unserializableValue;
  }
  if (arg.className === "Window") {
    return "Window";
  }
  if (arg.className === "Document") {
    return "Document";
  }
  if (arg.subtype === "promise") {
    return arg.className ?? arg.description ?? "Promise";
  }
  if (arg.subtype === "node") {
    if (arg.description && /^[a-z][a-z0-9-]*$/i.test(arg.description)) {
      return `JSHandle@<${arg.description}></${arg.description}>`;
    }
    return arg.description ? `JSHandle@${arg.description}` : "JSHandle@node";
  }
  if (arg.subtype === "array") {
    const preview = cdpArrayRemoteObjectPreview(arg.preview?.properties);
    if (preview) {
      return preview;
    }
    if (arg.description) {
      return arg.description.replace(/^\((\d+)\)\s*/, "");
    }
  }
  if (arg.preview?.properties?.length) {
    const entries = arg.preview.properties.map((property) => {
      const value = property.value ?? property.valuePreview?.description ?? property.type ?? "";
      return `${property.name}: ${value}`;
    });
    return `{${entries.join(", ")}}`;
  }
  if (arg.description) {
    return arg.description;
  }
  return arg.type ?? "";
}

function parseCdpArrayPreview(description: string): unknown[] | undefined {
  const normalized = description.replace(/^\((\d+)\)\s*/, "");
  if (!normalized.startsWith("[") || !normalized.endsWith("]")) {
    return undefined;
  }
  const content = normalized.slice(1, -1).trim();
  if (!content) {
    return [];
  }
  return content.split(",").map((part) => parseCdpPreviewPrimitive(part.trim()));
}

function cdpArrayRemoteObjectPreview(
  properties:
    | Array<{
        name: string;
        type?: string;
        value?: string;
        valuePreview?: { description?: string };
      }>
    | undefined
): string | undefined {
  if (!properties?.length) {
    return undefined;
  }

  const entries = properties
    .filter((property) => /^\d+$/.test(property.name))
    .sort((left, right) => Number(left.name) - Number(right.name))
    .map((property) => property.value ?? property.valuePreview?.description ?? property.type ?? "");

  if (!entries.length) {
    return undefined;
  }

  return `[${entries.join(", ")}]`;
}

function normalizeConsoleTimestamp(timestamp: number | undefined): number {
  if (timestamp === undefined) {
    return Date.now();
  }
  return timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
}

function normalizeLogEntryLevel(
  level: "verbose" | "info" | "warning" | "error"
): RawPageEventMap["console"]["type"] extends () => infer T ? T : never {
  switch (level) {
    case "verbose":
      return "log" as RawPageEventMap["console"]["type"] extends () => infer T ? T : never;
    case "info":
      return "info" as RawPageEventMap["console"]["type"] extends () => infer T ? T : never;
    case "warning":
      return "warning" as RawPageEventMap["console"]["type"] extends () => infer T ? T : never;
    case "error":
      return "error" as RawPageEventMap["console"]["type"] extends () => infer T ? T : never;
  }
}

function consoleStackTraceLocation(
  stackTrace:
    | {
        callFrames?: Array<{
          columnNumber?: number;
          lineNumber?: number;
          url?: string;
        }>;
      }
    | undefined,
  fallbackUrl = ""
): {
  column: number;
  columnNumber: number;
  line: number;
  lineNumber: number;
  url: string;
} {
  const callFrame = stackTrace?.callFrames?.[0];
  const lineNumber = callFrame?.lineNumber ?? 0;
  const columnNumber = callFrame?.columnNumber ?? 0;
  return {
    column: columnNumber,
    columnNumber,
    line: lineNumber,
    lineNumber,
    url: callFrame?.url ?? fallbackUrl
  };
}

function parseCdpObjectPreview(description: string): Record<string, unknown> | undefined {
  if (!description.startsWith("Object")) {
    return undefined;
  }
  const body = description.slice("Object".length).trim();
  if (!body.startsWith("{") || !body.endsWith("}")) {
    return undefined;
  }
  const content = body.slice(1, -1).trim();
  if (!content) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const entry of content.split(",")) {
    const separator = entry.indexOf(":");
    if (separator === -1) {
      return undefined;
    }
    const key = entry.slice(0, separator).trim();
    result[key] = parseCdpPreviewPrimitive(entry.slice(separator + 1).trim());
  }
  return result;
}

function parseCdpPreviewPrimitive(value: string): unknown {
  if (value === "undefined") {
    return undefined;
  }
  if (value === "null") {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value.replace(/^["']|["']$/g, "");
}

function rewriteCdpCookies(cookies: ReadonlyArray<{
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
}>): Array<{
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
}> {
  return cookies.map((cookie) => {
    if ((!cookie.url && (!cookie.domain || !cookie.path)) || (cookie.url && (cookie.domain || cookie.path))) {
      throw new Error("Cookie should have either url or domain/path pair");
    }
    const rewritten = { ...cookie };
    if (rewritten.url) {
      if (rewritten.url === "about:blank") {
        throw new Error(`Blank page can not have cookie "${cookie.name}"`);
      }
      if (rewritten.url.startsWith("data:")) {
        throw new Error(`Data URL page can not have cookie "${cookie.name}"`);
      }
      const parsed = new URL(rewritten.url);
      rewritten.domain = parsed.hostname;
      rewritten.path = parsed.pathname.substring(0, parsed.pathname.lastIndexOf("/") + 1);
      rewritten.secure = parsed.protocol === "https:";
    }
    return rewritten;
  });
}

function filterCdpCookies<T extends {
  domain: string;
  path: string;
  secure: boolean;
}>(cookies: T[], urls: string[]): T[] {
  if (!urls.length) {
    return cookies;
  }
  const parsedUrls = urls.map((url) => new URL(url));
  return cookies.filter((cookie) => {
    return parsedUrls.some((parsedUrl) => {
      let domain = cookie.domain;
      if (!domain.startsWith(".")) {
        domain = "." + domain;
      }
      if (!("." + parsedUrl.hostname).endsWith(domain)) {
        return false;
      }
      if (!parsedUrl.pathname.startsWith(cookie.path)) {
        return false;
      }
      if (parsedUrl.protocol !== "https:" && !isLocalHostname(parsedUrl.hostname) && cookie.secure) {
        return false;
      }
      return true;
    });
  });
}

function matchesCookieFilter(
  cookie: {
    domain: string;
    name: string;
    path: string;
  },
  options: {
    domain?: string | RegExp;
    name?: string | RegExp;
    path?: string | RegExp;
  }
): boolean {
  return matchesStringFilter(cookie.name, options.name)
    && matchesStringFilter(cookie.domain, options.domain)
    && matchesStringFilter(cookie.path, options.path);
}

function matchesStringFilter(value: string, matcher: string | RegExp | undefined): boolean {
  if (matcher === undefined) {
    return true;
  }
  if (typeof matcher === "string") {
    return value === matcher;
  }
  return matcher.test(value);
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function mouseButtonsMask(buttons: Iterable<MouseButton>): number {
  let mask = 0;
  for (const button of buttons) {
    switch (button) {
      case "left":
        mask |= 1;
        break;
      case "right":
        mask |= 2;
        break;
      case "middle":
        mask |= 4;
        break;
    }
  }
  return mask;
}

function convertToDisjointCoverageRanges(
  nestedRanges: CdpCoverageRange[]
): Array<{ start: number; end: number }> {
  const points: Array<{
    offset: number;
    range: CdpCoverageRange;
    type: 0 | 1;
  }> = [];
  for (const range of nestedRanges) {
    points.push({ offset: range.startOffset, type: 0, range });
    points.push({ offset: range.endOffset, type: 1, range });
  }

  points.sort((a, b) => {
    if (a.offset !== b.offset) {
      return a.offset - b.offset;
    }
    if (a.type !== b.type) {
      return b.type - a.type;
    }
    const aLength = a.range.endOffset - a.range.startOffset;
    const bLength = b.range.endOffset - b.range.startOffset;
    if (a.type === 0) {
      return bLength - aLength;
    }
    return aLength - bLength;
  });

  const hitCountStack: number[] = [];
  const results: Array<{ start: number; end: number }> = [];
  let lastOffset = 0;
  for (const point of points) {
    if (
      hitCountStack.length &&
      lastOffset < point.offset &&
      hitCountStack[hitCountStack.length - 1]! > 0
    ) {
      const lastResult = results.length ? results[results.length - 1] : null;
      if (lastResult && lastResult.end === lastOffset) {
        lastResult.end = point.offset;
      } else {
        results.push({ start: lastOffset, end: point.offset });
      }
    }
    lastOffset = point.offset;
    if (point.type === 0) {
      hitCountStack.push(point.range.count);
    } else {
      hitCountStack.pop();
    }
  }
  return results;
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
      if (!isDetachedNavigationSessionError(error) || attempt === attempts - 1) {
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

async function retryOnDetachedNavigationSession<TResult>(
  run: () => Promise<TResult>,
  attempts = 5
): Promise<TResult> {
  return retryOnNotAttachedToActivePage(run, attempts);
}

function isDetachedNavigationSessionError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return (
    isNotAttachedToActivePageError(error)
    || message.includes("Session with given id not found")
    || message.includes("WebSocket is not open")
    || message.includes("Target page, context or browser has been closed")
  );
}

function isIgnorableFetchInterceptionError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return (
    message.includes("Invalid Interception Id") ||
    message.includes("No resource with given identifier found") ||
    message.includes("Session with given id not found") ||
    message.includes("Target closed") ||
    message.includes("Target page, context or browser has been closed") ||
    message.includes("WebSocket connection closed") ||
    message.includes("WebSocket is not open")
  );
}

function isSetContentEvaluationInterruption(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return (
    message.includes("Execution context was destroyed") ||
    message.includes("Cannot find context with specified id") ||
    message.includes("Frame execution context is not available")
  );
}

function shouldRetryActionPointError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.replace(/^Error:\s*/, "") : "";
  return (
    Boolean(message) &&
    (
      message === "No element found." ||
      message === "Element is not visible." ||
      message === "Element is not enabled." ||
      message === "Element does not have an actionable bounding box." ||
      message === "Element intercepts pointer events."
    )
  );
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

function shouldCaptureNavigationResponseUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "file:";
  } catch {
    return false;
  }
}

function stripHash(url: string): string {
  const index = url.indexOf("#");
  return index === -1 ? url : url.slice(0, index);
}

function formatNavigationFailureMessage(message: string, url?: string): string {
  return url && !message.includes(url) ? `${message} at ${url}` : message;
}

function formatInterruptedNavigationMessage(
  capture: NavigationFailureCapture,
  nextUrl: string
): string {
  return `${capture.apiName}: Navigation to "${capture.targetUrl ?? "about:blank"}" is interrupted by another navigation to "${nextUrl}"`;
}

function matchesNavigationResponseUrl(
  url: string,
  matcher: string | RegExp | ((url: URL) => boolean)
): boolean {
  if (typeof matcher === "string") {
    return url === matcher;
  }
  if (matcher instanceof RegExp) {
    return matcher.test(url);
  }
  try {
    return matcher(new URL(url));
  } catch {
    return false;
  }
}

function cdpContinueRequestHeaders(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers)
    .filter(([name]) => name.toLowerCase() !== "content-length")
    .map(([name, value]) => ({ name, value }));
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
        return `${selector.light ? "text:light" : "text"}=${selector.value}`;
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
  if (effectiveTimeout === 0) {
    return promise;
  }

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

function postDataBufferFromCdpEntries(entries?: Array<{ bytes?: string }>): Buffer | null {
  const buffers = entries
    ?.filter((entry) => typeof entry.bytes === "string")
    .map((entry) => Buffer.from(entry.bytes!, "base64"));
  return buffers?.length ? Buffer.concat(buffers) : null;
}

function postDataBufferFieldsFromCdpEntries(entries?: Array<{ bytes?: string }>): {
  postDataBufferBase64?: string;
} {
  const buffer = postDataBufferFromCdpEntries(entries);
  return buffer ? { postDataBufferBase64: buffer.toString("base64") } : {};
}

function delay(timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

function isSelectOptionRetryResult(value: string[] | SelectOptionRetryResult): value is SelectOptionRetryResult {
  return !Array.isArray(value) && value.__needsRetry === true;
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

// Linear tween for protocol-level pointer movement interpolation.
function interpolateMousePoint(start: ActionPoint, end: ActionPoint, progress: number): ActionPoint {
  return {
    x: start.x + (end.x - start.x) * progress,
    y: start.y + (end.y - start.y) * progress
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
        return `${selector.light ? "text:light" : "text"}=${selector.isRegex ? `/${selector.value}/${selector.regexFlags ?? ""}` : selector.value}`;
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
