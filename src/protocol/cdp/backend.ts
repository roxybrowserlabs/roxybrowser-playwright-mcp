import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
import { RoxyJSHandle, createJSHandle } from "../../jsHandle.js";
import { RoxyWorker, type WorkerDelegate } from "../../worker.js";
import { createPageResponse } from "../../pageResponse.js";
import {
  PARSE_EVALUATION_RESULT_SOURCE,
  SERIALIZE_EVALUATION_RESULT_SOURCE,
  parseSerializedEvaluationResult,
  wrapWithSerializedEvaluationResult
} from "../evaluationSerializer.js";
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

const DEFAULT_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_MS = 500;
const REQUEST_EXTRA_INFO_FALLBACK_MS = 250;

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

function isBufferedNetworkEvent(event: RawPageEventName): event is "request" | "response" | "requestfinished" | "requestfailed" {
  return event === "request" || event === "response" || event === "requestfinished" || event === "requestfailed";
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
    params: { backendNodeId: number; executionContextId?: number }
  ): Promise<{
    object: CdpRemoteObject;
  }>;
}

interface CdpPageFramePayload {
  id: string;
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
  protocolFrameId?: string;
}

interface ActionPoint {
  x: number;
  y: number;
}

interface StateWaiter {
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
  targetUrl?: string;
  reject: (error: Error) => void;
}

interface CdpCoverageRange {
  count: number;
  endOffset: number;
  startOffset: number;
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

interface LocatorPayload {
  operation:
    | "actionPoint"
    | "checkedState"
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
  private readonly pages = new Map<string, ProtocolPageAdapter>();
  private readonly pendingPages = new Map<string, Promise<ProtocolPageAdapter>>();
  private readonly manuallyCreatedTargetIds = new Set<string>();
  private readonly creatingPageTargetIds = new Set<string>();
  private pendingManualPageCreations = 0;
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

    const autoAttached = this.pendingPages.get(response.targetId);
    if (autoAttached) {
      return autoAttached;
    }
    return this.getOrCreatePage(response.targetId);
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

  async close(): Promise<void> {
    if (this.closing) {
      return;
    }

    this.closing = true;
    if (this.targetPollTimer) {
      clearInterval(this.targetPollTimer);
      this.targetPollTimer = null;
    }
    await this.targetDiscoveryReady.catch(() => {});

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

  private async initializeTargetDiscovery(): Promise<void> {
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
        void this.handleTargetDetached(event.targetId);
      }
    });

    await this.state.browserClient.Target.setAutoAttach?.({
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true
    }).catch(() => {});
    await this.state.browserClient.Target.setDiscoverTargets?.({
      discover: true
    });
    this.targetPollTimer = setInterval(() => {
      void this.discoverTargets().catch(() => {});
    }, 100);
    await this.discoverTargets();
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
      await this.state.browserClient.Target.detachFromTarget?.({ sessionId: event.sessionId }).catch(() => {});
      return;
    }
    if (targetInfo.type !== "page") {
      if (!this.matchesBrowserContextTarget(targetInfo)) {
        await this.state.browserClient.Target.detachFromTarget?.({ sessionId: event.sessionId }).catch(() => {});
        return;
      }
      await sendBrowserCommandInSession(this.state.browserClient, "Runtime.enable", {}, event.sessionId).catch(() => {});
      await sendBrowserCommandInSession(this.state.browserClient, "Runtime.runIfWaitingForDebugger", {}, event.sessionId).catch(() => {});
      return;
    }
    if (!this.matchesTargetInfo(targetInfo)) {
      await this.state.browserClient.Target.detachFromTarget?.({ sessionId: event.sessionId }).catch(() => {});
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

    const pagePromise = this.getOrCreatePage(targetInfo.targetId, {
      client: createSessionTargetClient(this.state.browserClient, event.sessionId),
      fallbackUrl: targetInfo.url ?? "about:blank",
      hasWindowOpener: targetInfo.canAccessOpener ?? true,
      openerTargetId: targetInfo.openerId ?? null,
      emitPage: !this.manuallyCreatedTargetIds.has(targetInfo.targetId),
      sessionId: event.sessionId
    });
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

    for (const targetInfo of result.targetInfos) {
      await this.handleTargetCreated(targetInfo);
    }
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
    if (this.manuallyCreatedTargetIds.has(targetInfo.targetId)) {
      return;
    }
    if (this.pages.has(targetInfo.targetId) || this.pendingPages.has(targetInfo.targetId)) {
      return;
    }

    const pagePromise = this.getOrCreatePage(targetInfo.targetId, {
      fallbackUrl: targetInfo.url ?? "about:blank",
      hasWindowOpener: targetInfo.canAccessOpener ?? true,
      openerTargetId: targetInfo.openerId ?? null,
      emitPage: true
    });
    this.pendingPages.set(targetInfo.targetId, pagePromise);
    void pagePromise.catch(() => {});
    void pagePromise.finally(() => {
      if (this.pendingPages.get(targetInfo.targetId) === pagePromise) {
        this.pendingPages.delete(targetInfo.targetId);
      }
    });
  }

  private async handleTargetDetached(targetId: string): Promise<void> {
    const existing = this.pages.get(targetId);
    if (existing) {
      (existing as ProtocolPageAdapter & { didClose?: () => void }).didClose?.();
      return;
    }

    const pending = this.pendingPages.get(targetId);
    if (!pending) {
      return;
    }
    const page = await pending.catch(() => null);
    (page as (ProtocolPageAdapter & { didClose?: () => void }) | null)?.didClose?.();
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
    return !this.browserContextId && !targetInfo.browserContextId;
  }

  private matchesBrowserContextTarget(targetInfo: {
    browserContextId?: string;
  }): boolean {
    if (targetInfo.browserContextId === this.browserContextId) {
      return true;
    }
    return !this.browserContextId && !targetInfo.browserContextId;
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
        const client = options.client ?? await connectToTarget(this.state.connection, targetId);
        page = await CdpPageAdapter.create({
          browserClient: this.state.browserClient,
          client,
          targetId,
          contextOptions: this.options,
          initialNavigationFrameUnavailable: Boolean(options.openerTargetId),
          ...(options.sessionId
            ? {
                resumeOnInitialized: async () => {
                  await sendBrowserCommandInSession(this.state.browserClient, "Runtime.runIfWaitingForDebugger", {}, options.sessionId!).catch(() => {});
                }
              }
            : {}),
          onClosed: (closedTargetId) => {
            this.pages.delete(closedTargetId);
            this.pendingPages.delete(closedTargetId);
            this.manuallyCreatedTargetIds.delete(closedTargetId);
            this.creatingPageTargetIds.delete(closedTargetId);
          }
        });
      } catch (error) {
        if (!options.emitPage || options.client) {
          throw error;
        }
        page = createTransientClosedPageAdapter(options.fallbackUrl ?? "about:blank");
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
    const existing = this.pages.get(targetId);
    if (existing) {
      return existing;
    }

    const pending = this.pendingPages.get(targetId);
    if (!pending) {
      return null;
    }

    try {
      return await pending;
    } catch {
      return null;
    }
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

class CdpPageAdapter implements ProtocolPageAdapter {
  private mainFrameId: string | undefined;
  private readonly defaultExecutionContextByFrameId = new Map<string, number>();
  private readonly defaultExecutionContextSessionByFrameId = new Map<string, string | undefined>();
  private readonly workersByTargetId = new Map<string, { sessionId: string; worker: RoxyWorker }>();
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
  private pointerActionQueue = Promise.resolve();
  private readonly pressedKeyboardModifiers = new Set<string>();
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
  private readonly earlyNetworkEvents = new Map<
    "request" | "response" | "requestfinished" | "requestfailed",
    Array<RawPageEventMap["request"] | RawPageEventMap["response"] | RawPageEventMap["requestfailed"]>
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
  private readonly ignoredRequestIds = new Set<string>();
  private readonly continuedRequestHeaders = new Map<string, Array<{ name: string; value: string }>>();
  private readonly responseBodies = new Map<string, ResponseBodyState>();
  private readonly navigationResponseCaptures = new Set<NavigationResponseCapture>();
  private readonly navigationFailureCaptures = new Set<NavigationFailureCapture>();
  private pageExtraHTTPHeaders: Record<string, string> | undefined;
  private requestInterceptor: ((call: RoutedRequestCall) => Promise<RoutedRequestDecision>) | null = null;
  private requestInterceptionEnabled = false;

  static async create(options: {
    browserClient: CdpClient;
    client: CdpClient;
    targetId: string;
    contextOptions: BrowserContextOptions;
    initialNavigationFrameUnavailable?: boolean;
    resumeOnInitialized?: () => Promise<void>;
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
      initialNavigationFrameUnavailable?: boolean;
      resumeOnInitialized?: () => Promise<void>;
      onClosed: (targetId: string) => void;
    }
  ) {
    this.options.client.on("disconnect", () => {
      this.didClose();
    });
  }

  didClose(): void {
    if (this.closed) {
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
      this.flushWaiters();
      this.emit("domcontentloaded", undefined);
      void this.syncCurrentUrlFromDocument();
      void this.renderScreencastActions();
      void this.renderScreencastOverlays();
    });

    client.Page.navigatedWithinDocument((event) => {
      this.currentUrl = event.url ?? this.currentUrl;
      void this.syncCurrentUrlFromDocument();
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
          type: event.type
        })
      );
    });

    client.Page.frameNavigated((event) => {
      this.upsertNativeFrame(event.frame);
      if (!event.frame.parentId) {
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

    client.Page.frameDetached?.((event: { frameId: string; reason?: "remove" | "swap" }) => {
      if (event.reason === "swap") {
        return;
      }
      this.settleRequestsForDetachedFrame(event.frameId);
      this.frameSessionIds.delete(event.frameId);
      this.removeNativeFrame(event.frameId);
      this.emit("framedetached", undefined);
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
        const worker = new RoxyWorker(
          event.targetInfo.url ?? "",
          new CdpWorkerDelegate(this.options.client, event.sessionId, event.targetInfo.url ?? "")
        );
        this.workersByTargetId.set(event.targetInfo.targetId, {
          sessionId: event.sessionId,
          worker
        });
        this.emit("worker", worker);
        (this.options.browserClient as CdpClient & {
          on(event: string, listener: (params: unknown) => void): unknown;
        }).on?.(`Runtime.consoleAPICalled.${event.sessionId}`, (params: unknown) => {
          const consoleEvent = params as {
            args: CdpRemoteObject[];
            timestamp?: number;
            type: RawPageEventMap["console"]["type"] extends () => infer T ? T : string;
          };
          const args = consoleEvent.args.map((arg) => createCdpConsoleHandle(arg));
          const message: RawPageEventMap["console"] = {
            args: () => args,
            location: () => ({
              column: 0,
              columnNumber: 0,
              line: 0,
              lineNumber: 0,
              url: event.targetInfo.url ?? ""
            }),
            page: () => null,
            text: () => args.map((arg) => String(arg)).join(" "),
            timestamp: () => consoleEvent.timestamp ? consoleEvent.timestamp * 1000 : Date.now(),
            type: () => consoleEvent.type,
            worker: () => worker
          };
          this.emit("console", message);
        });
        const sessionClient = this.options.client as typeof this.options.client & {
          send(method: string, params?: Record<string, never>, sessionId?: string): Promise<unknown>;
        };
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
      const worker = this.workersByTargetId.get(targetId);
      if (!worker) {
        return;
      }
      if (worker.sessionId !== event.sessionId) {
        return;
      }
      this.workersByTargetId.delete(targetId);
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

    client.Runtime.executionContextsCleared?.(() => {
      this.defaultExecutionContextByFrameId.clear();
      this.defaultExecutionContextSessionByFrameId.clear();
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
      const args = event.args.map((arg) => createCdpConsoleHandle(arg));
      this.emit("console", {
        args: () => args,
        location: () => ({
          column: 0,
          columnNumber: 0,
          line: 0,
          lineNumber: 0,
          url: ""
        }),
        page: () => null,
        text: () => args.map((arg) => String(arg)).join(" "),
        timestamp: () => Date.now(),
        type: () => event.type,
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
        this.flushPendingRequestEvent(requestId);
        this.requestExtraInfoHeaders.delete(requestId);
        this.responseExtraInfoDiscardCounts.delete(requestId);
        this.requestMetadata.delete(requestId);
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
      if (this.runAfterPendingRequestEvent(event.requestId, () => {
        this.handleNetworkResponseReceived(responseEvent, fromCache);
      })) {
        return;
      }
      this.handleNetworkResponseReceived(responseEvent, fromCache);
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
      if (request?.isPreflight || request?.isFavicon) {
        this.ensureResponseBodyState(event.requestId).resolveReady();
        onRequestSettled(event.requestId);
        return;
      }
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
            new Error(formatNavigationFailureMessage(event.errorText || "Navigation failed.", request.url))
          );
          this.rejectNavigationFailureCaptures(
            new Error(formatNavigationFailureMessage(event.errorText || "Navigation failed.", request.url)),
            request.url
          );
          onRequestSettled(event.requestId);
          this.emit("requestfailed", {
            errorText: event.errorText,
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
        new Error(formatNavigationFailureMessage(event.errorText || "Network loading failed.", request?.url))
      );
      if (request?.type === "Document" && request.frameId && this.isMainFrameId(request.frameId)) {
        this.rejectNavigationFailureCaptures(
          new Error(formatNavigationFailureMessage(event.errorText || "Navigation failed.", request.url)),
          request.url
        );
      }
      onRequestSettled(event.requestId);
      this.emit("requestfailed", {
        errorText: event.errorText,
        ...(request?.frameId ? { frameId: request.frameId } : {}),
        isNavigationRequest: request?.isNavigationRequest ?? false,
        method: request?.method ?? "UNKNOWN",
        requestId: event.requestId,
        resourceType: toPlaywrightResourceType(request?.type),
        url: request?.url ?? "unknown://request"
      });
    });

    await Promise.all([
      initializeCommand(client.Page.enable()),
      initializeCommand(client.Page.getFrameTree?.().then((response) => {
        this.syncNativeFrameTree(response.frameTree);
        this.mainFrameId = response.frameTree.frame.id;
        this.currentUrl = response.frameTree.frame.url ?? this.currentUrl;
      }).catch(() => {})),
      initializeCommand(client.Page.setLifecycleEventsEnabled({ enabled: true }).catch(() => {})),
      initializeCommand(client.Runtime.enable()),
      initializeCommand(client.DOM.enable({})),
      initializeCommand(client.Network.enable({})),
      initializeCommand(client.Target?.setAutoAttach?.({
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true
      }).catch(() => {})),
      initializeCommand(this.options.resumeOnInitialized?.())
    ]);
    await this.applyContextOptions();
    await this.syncLifecycleStateFromDocument();
    this.maybeArmNetworkIdleTimer();
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
    const capture = this.beginNavigationResponseCapture();
    const failureCapture = this.beginNavigationFailureCapture(targetUrl);
    this.resetNavigationState();

    try {
      await this.raceNavigationFailure(
        withTimeout(
          this.options.client.Page.navigate({
            url: targetUrl,
            ...(referer !== undefined
              ? {
                  referrer: referer,
                  referrerPolicy: "unsafeUrl"
                }
              : {})
          }),
          options.timeout,
          `page.goto: Timeout ${options.timeout}ms exceeded.\n${targetUrl}`
        ),
        failureCapture
      );
      this.currentUrl = targetUrl;

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
    const failureCapture = this.beginNavigationFailureCapture(this.currentUrl);
    this.resetNavigationState();

    try {
      await this.raceNavigationFailure(
        withTimeout(
          (this.options.client.Page as typeof this.options.client.Page & {
            reload(): Promise<void>;
          }).reload(),
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
    initialUrl?: string;
    signal?: AbortSignal;
    timeout?: number;
    url?: string | RegExp | ((url: URL) => boolean);
  } = {}): Promise<PageResponse | null> {
    const capture = this.beginNavigationResponseCapture({
      predicate: (response) => {
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

    await this.evaluateFunction<void>(
      `(payload) => {
        document.open();
        document.write(payload.html);
        document.close();
      }`,
      { html }
    );

    if (waitUntil !== "commit") {
      await this.waitForLoadState(waitUntil, options.timeout);
    }
  }

  async addInitScript(source: string, _arg?: unknown): Promise<Disposable> {
    const result = await this.options.client.Page.addScriptToEvaluateOnNewDocument({
      source
    });
    const identifier = (result as { identifier?: string }).identifier;
    return {
      dispose: async () => {
        if (!identifier) {
          return;
        }
        await this.options.client.Page.removeScriptToEvaluateOnNewDocument?.({
          identifier
        }).catch(() => {});
      }
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
    ownerElementChain: LocatorSelector[];
    parentId: string | null;
    referenceChain: LocatorSelector[];
    url: string;
  }>> {
    const domSnapshots = await this.collectDomFrameSnapshots().catch(() => []);
    const domById = new Map(domSnapshots.map((snapshot) => [snapshot.id, snapshot]));
    const frameTree = await (this.options.client as CdpPageFrameClient).send("Page.getFrameTree");
    this.syncNativeFrameTree(frameTree.frameTree);

    const snapshots: Array<{
      id: string;
      name: string;
      nativeFrameId?: string;
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

    const visit = (frame: CdpNativeFrameState, parentId: string | null, syntheticId: string) => {
      const domSnapshot = takeDomSnapshot(frame, parentId, syntheticId);
      snapshots.push({
        id: syntheticId,
        name: frame.name || domSnapshot?.name || "",
        nativeFrameId: frame.id,
        ownerElementChain: domSnapshot?.ownerElementChain ?? [],
        parentId,
        referenceChain: domSnapshot?.referenceChain ?? [],
        url: frame.url || domSnapshot?.url || "about:blank"
      });
      childrenByParent.get(frame.id)?.forEach((child, index) => {
        visit(child, syntheticId, `${syntheticId}.${index + 1}`);
      });
    };
    const rootFrame = this.mainFrameId ? this.nativeFrames.get(this.mainFrameId) : undefined;
    if (rootFrame) {
      visit(rootFrame, null, "main");
    } else {
      visit({
        id: frameTree.frameTree.frame.id,
        name: frameTree.frameTree.frame.name ?? "",
        parentId: null,
        url: frameTree.frameTree.frame.url ?? "about:blank"
      }, null, "main");
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
        const frames = Array.from(documentRoot.querySelectorAll("iframe,frame"));
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
    timeout = DEFAULT_TIMEOUT_MS
  ): Promise<void> {
    const targetState = verifyLifecycle("state", state ?? "load");
    if (targetState === "commit" || this.isStateSatisfied(targetState)) {
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

  async tap(selector: LocatorSelector[], options?: TapOptions): Promise<void> {
    await this.clickLocator({ chain: selector }, options);
  }

  on<K extends RawPageEventName>(event: K, listener: RawPageEventListener<K>): () => void {
    const listeners =
      this.eventListeners.get(event) ?? new Set<RawPageEventListener<RawPageEventName>>();
    listeners.add(listener as RawPageEventListener<RawPageEventName>);
    this.eventListeners.set(event, listeners);
    this.replayEarlyNetworkEvents(event, listener);

    return () => {
      const registeredListeners = this.eventListeners.get(event);
      registeredListeners?.delete(listener as RawPageEventListener<RawPageEventName>);
      if (registeredListeners?.size === 0) {
        this.eventListeners.delete(event);
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
    await this.options.client.Network.setCacheDisabled({ cacheDisabled: shouldEnable }).catch(() => {});
    if (shouldEnable) {
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
    await this.options.client.Fetch.disable().catch(() => {});
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
    const normalizedKey = normalizeShortcutKey(key);
    const keyDefinition = resolveKeyDefinition(normalizedKey);
    const nextModifiers = new Set(this.pressedKeyboardModifiers);
    if (isKeyboardModifier(normalizedKey)) {
      nextModifiers.add(normalizedKey);
    }
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
      nativeVirtualKeyCode: keyDefinition.keyCode,
      modifiers: keyboardModifierMask(nextModifiers)
    });
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
    const parsed = parseKeyboardShortcut(key);
    const temporaryModifiers: string[] = [];

    for (const modifier of parsed.modifiers) {
      if (!this.pressedKeyboardModifiers.has(modifier)) {
        await this.keyboardDown(modifier);
        temporaryModifiers.push(modifier);
      }
    }

    await this.keyboardDown(parsed.key);
    if (options?.delay) {
      await delay(options.delay);
    }
    await this.keyboardUp(parsed.key);

    for (const modifier of temporaryModifiers.reverse()) {
      await this.keyboardUp(modifier);
    }
  }

  async keyboardType(
    text: string,
    options?: {
      delay?: number;
    }
  ): Promise<void> {
    await this.bringToFront();
    for (const character of text) {
      await this.options.client.Input.dispatchKeyEvent({
        type: "char",
        text: character
      });
      await delay(options?.delay ?? 0);
    }
  }

  async keyboardUp(key: string): Promise<void> {
    await this.bringToFront();
    const normalizedKey = normalizeShortcutKey(key);
    const keyDefinition = resolveKeyDefinition(normalizedKey);
    await this.options.client.Input.dispatchKeyEvent({
      type: "keyUp",
      key: keyDefinition.key,
      code: keyDefinition.code,
      windowsVirtualKeyCode: keyDefinition.keyCode,
      nativeVirtualKeyCode: keyDefinition.keyCode,
      modifiers: keyboardModifierMask(this.pressedKeyboardModifiers)
    });
    if (isKeyboardModifier(normalizedKey)) {
      this.pressedKeyboardModifiers.delete(normalizedKey);
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
      const steps = Math.max(options?.steps ?? 1, 1);
      const start = this.currentMousePosition;
      for (let index = 1; index <= steps; index += 1) {
        await this.moveMouseInternal({
          x: start.x + ((x - start.x) * index) / steps,
          y: start.y + ((y - start.y) * index) / steps
        });
      }
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
      await this.options.client.Input.dispatchMouseEvent({
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
    await this.mouseClick(x, y);
  }

  async close(options: PageCloseOptions = {}): Promise<void> {
    if (options.runBeforeUnload) {
      await (this.options.client.Page as typeof this.options.client.Page & {
        close(): Promise<void>;
      }).close();
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

    try {
      await this.options.browserClient.Target.closeTarget({
        targetId: this.options.targetId
      });
    } finally {
      await safelyCloseClient(this.options.client);
      this.options.onClosed(this.options.targetId);
    }
  }

  async bringToFront(): Promise<void> {
    await this.options.client.Page.bringToFront();
  }

  isClosed(): boolean {
    return this.closed;
  }

  async clickLocator(locator: CdpLocatorState, options?: ClickOptions): Promise<void> {
    await this.enqueuePointerAction(async () => {
      await this.bringToFront();
      const actionPoint = await this.resolveActionPoint(locator, options, true);
      const button = options?.button ?? "left";
      const clickCount = options?.clickCount ?? 1;

      await this.withPointerActionModifiers(options?.modifiers, async () => {
        await this.dispatchMouseMove(actionPoint);
        await this.resolveActionPoint(locator, options, true);
        void this.showScreencastAction("click", actionPoint).catch(() => {});
        for (let index = 0; index < clickCount; index += 1) {
          await this.dispatchMouseDown(actionPoint, button, index + 1);
          await delay(options?.delay ?? 0);
          await this.dispatchMouseUp(actionPoint, button, index + 1);
        }
      });
    });
  }

  async hoverLocator(locator: CdpLocatorState, options?: HoverOptions): Promise<void> {
    await this.enqueuePointerAction(async () => {
      await this.bringToFront();
      const actionPoint = await this.resolveActionPoint(locator, options);
      await this.withPointerActionModifiers(options?.modifiers, async () => {
        await this.dispatchMouseMove(actionPoint);
      });
    });
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
      operation: "focus",
      resetSelectionIfNotFocused: true
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
    await this.runLocatorOperation<boolean>(locator, {
      operation: "check",
      checked
    });
    if (await this.checkedStateLocator(locator) === checked) {
      return;
    }
    if (options?.trial) {
      return;
    }
    await this.clickLocator(locator, options);
    if (await this.checkedStateLocator(locator) !== checked) {
      throw new Error(`Clicking the checkbox did not change its state`);
    }
  }

  private async checkedStateLocator(locator: CdpLocatorState): Promise<boolean> {
    return this.runLocatorOperation<boolean>(locator, {
      operation: "checkedState"
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
    await this.options.client.Input.dispatchMouseEvent({
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: this.lastMouseButton,
      buttons: mouseButtonsMask(this.pressedMouseButtons),
      modifiers: keyboardModifierMask(this.activePointerModifiers())
    });
  }

  private async moveMouseInternal(point: ActionPoint): Promise<void> {
    await this.dispatchMouseMove(point);
    this.currentMousePosition = point;
  }

  private async dispatchMouseDown(
    point: ActionPoint,
    button: MouseButton,
    clickCount: number
  ): Promise<void> {
    this.lastMouseButton = button;
    this.pressedMouseButtons.add(button);
    await this.options.client.Input.dispatchMouseEvent({
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button,
      buttons: mouseButtonsMask(this.pressedMouseButtons),
      clickCount,
      modifiers: keyboardModifierMask(this.activePointerModifiers())
    });
  }

  private async dispatchMouseUp(
    point: ActionPoint,
    button: MouseButton,
    clickCount: number
  ): Promise<void> {
    this.lastMouseButton = "none";
    this.pressedMouseButtons.delete(button);
    await this.options.client.Input.dispatchMouseEvent({
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button,
      buttons: mouseButtonsMask(this.pressedMouseButtons),
      clickCount,
      modifiers: keyboardModifierMask(this.activePointerModifiers())
    });
  }

  private activePointerModifiers(): Iterable<string> {
    return this.pointerActionModifiers ?? this.pressedKeyboardModifiers;
  }

  private async withPointerActionModifiers<TResult>(
    modifiers: KeyboardModifier[] | undefined,
    action: () => Promise<TResult>
  ): Promise<TResult> {
    const previous = this.pointerActionModifiers;
    const actionModifiers = new Set(this.pressedKeyboardModifiers);
    for (const modifier of modifiers ?? []) {
      const normalized = normalizeShortcutKey(modifier);
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
    const run = this.pointerActionQueue.then(action, action);
    this.pointerActionQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
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
    await this.enqueuePointerAction(async () => {
      await this.bringToFront();
      const actionPoint = await this.resolveActionPointReference(reference, options, true);
      const button = options?.button ?? "left";
      const clickCount = options?.clickCount ?? 1;

      await this.withPointerActionModifiers(options?.modifiers, async () => {
        await this.dispatchMouseMove(actionPoint);
        await this.resolveActionPointReference(reference, options, true);
        void this.showScreencastAction("click", actionPoint).catch(() => {});
        for (let index = 0; index < clickCount; index += 1) {
          await this.dispatchMouseDown(actionPoint, button, index + 1);
          await delay(options?.delay ?? 0);
          await this.dispatchMouseUp(actionPoint, button, index + 1);
        }
      });
    });
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
      throw new Error(`Clicking the checkbox did not change its state`);
    }
  }

  private async checkedStateReference(reference: ProtocolElementHandleReference): Promise<boolean> {
    return this.runSelectorOperation<boolean>({
      operation: "checkedState",
      reference
    });
  }

  async hoverReference(reference: ProtocolElementHandleReference, options?: HoverOptions): Promise<void> {
    await this.enqueuePointerAction(async () => {
      await this.bringToFront();
      const actionPoint = await this.resolveActionPointReference(reference, options);
      await this.withPointerActionModifiers(options?.modifiers, async () => {
        await this.dispatchMouseMove(actionPoint);
      });
    });
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
      reference,
      resetSelectionIfNotFocused: true
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
    const response = await (this.options.client as CdpRuntimeClient).send("Runtime.evaluate", {
      expression: wrapWithSerializedEvaluationResult(expression),
      returnByValue: true,
      awaitPromise: true
    });

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
  ): Promise<TResult | ProtocolJSHandleAdapter<TResult>> {
    const executionContextId = await this.defaultExecutionContextIdForFrame(frameId);
    const sessionId = this.defaultExecutionContextSessionByFrameId.get(frameId) ?? this.frameSessionIds.get(frameId);
    return this.evaluateWithArgumentsInContext<TResult>(
      executionContextId,
      sessionId,
      expression,
      returnByValue,
      args,
      isFunction,
      frameId
    );
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
    const { values, handles } = await serializeCdpEvaluationArguments(args, this, temporaryHandles);
    const globalHandle = executionContextId === undefined
      ? await this.rawEvaluateHandle("globalThis", sessionId)
      : null;
    const wrappedExpression = `(...argsAndHandles) => {
      ${PARSE_EVALUATION_RESULT_SOURCE}
      ${returnByValue ? SERIALIZE_EVALUATION_RESULT_SOURCE : ""}
      const argCount = argsAndHandles[0];
      const serializedArgs = argsAndHandles.slice(1, argCount + 1);
      const handles = argsAndHandles.slice(argCount + 1);
      const parameters = serializedArgs.map(value => __roxyParseEvaluationResultValue(value, handles));
      let result = (0, eval)(${serializeForEvaluation(normalizeEvaluationExpression(expression, isFunction))});
      if (${isFunction ? "true" : "false"})
        result = result(...parameters);
      return ${returnByValue ? "Promise.resolve(result).then(__roxySerializeEvaluationResult)" : "result"};
    }`;
    try {
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
        callParameters.objectId = globalHandle.remoteObjectId()!;
      } else if (executionContextId !== undefined) {
        callParameters.executionContextId = executionContextId;
      }
      const response = await this.sendRuntimeCallFunctionOn(callParameters, sessionId);
      if (response.exceptionDetails) {
        throw new Error(formatCdpEvaluationError(response));
      }
      return returnByValue
        ? parseEvaluationResultValue(response.result.value as SerializedValue)
        : new CdpJSHandleAdapter<TResult>(this, response.result, sessionId, frameId);
    } finally {
      await globalHandle?.dispose();
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
    return (this.options.client as CdpRuntimeClient & {
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
    }).send("Runtime.callFunctionOn", params, sessionId);
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
    return (this.options.client as CdpRuntimeClient & {
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
    }).send("Runtime.getProperties", params, sessionId);
  }

  async sendRuntimeReleaseObject(
    params: { objectId: string },
    sessionId?: string
  ): Promise<unknown> {
    return (this.options.client as CdpRuntimeClient & {
      send(
        method: "Runtime.releaseObject",
        params: { objectId: string },
        sessionId?: string
      ): Promise<unknown>;
    }).send("Runtime.releaseObject", params, sessionId);
  }

  async rawEvaluateHandle<T = unknown>(expression: string, sessionId?: string): Promise<CdpJSHandleAdapter<T>> {
    const response = await (this.options.client as CdpRuntimeClient & {
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
    }).send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: false
    }, sessionId);
    if (response.exceptionDetails) {
      throw new Error(formatCdpEvaluationError(response));
    }
    return new CdpJSHandleAdapter<T>(this, response.result, sessionId);
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
      if (readyState === "interactive" || readyState === "complete") {
        this.domContentLoaded = true;
      }
      if (readyState === "complete") {
        this.loadFired = true;
      }
      this.flushWaiters();
    } catch {
      // Lifecycle events will update the state once a document is available.
    }
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
    this.maybeArmNetworkIdleTimer();
  }

  private async navigateHistory(
    delta: -1 | 1,
    options: PageGotoOptions
  ): Promise<PageResponse | null> {
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

    const waitUntil = verifyLifecycle("waitUntil", options.waitUntil ?? "load");
    const capture = this.beginNavigationResponseCapture();
    const failureCapture = this.beginNavigationFailureCapture(nextEntry.url);
    this.resetNavigationState();
    this.allowSameDocumentNavigationToResolveWaiters = true;
    try {
      await this.raceNavigationFailure(
        withTimeout(
          retryOnNotAttachedToActivePage(() => {
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
        return capture.lastResponse;
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
    if (event.response.url !== undefined) {
      responseBodyState.url = event.response.url;
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

    const response = createPageResponse({
      fromCache: Boolean(event.response.fromDiskCache || event.response.fromPrefetchCache),
      ...(event.response.fromServiceWorker !== undefined
        ? { fromServiceWorker: event.response.fromServiceWorker }
        : {}),
      ...(event.frameId ? { frameId: event.frameId } : {}),
      headers: headerEntries,
      isNavigationRequest,
      mimeType: event.response.mimeType,
      requestId: event.requestId,
      resourceType: toPlaywrightResourceType(event.type),
      status: event.response.status,
      statusText: event.response.statusText,
      body: () => this.getResponseBodyBuffer(event.requestId),
      text: () => this.getResponseText(event.requestId),
      url: event.response.url
    });

    this.emit("response", response);

    if (isNavigationRequest && event.frameId && this.isMainFrameId(event.frameId)) {
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

    const bodyBuffer = postDataBufferFromCdpEntries(event.request.postDataEntries) ??
      (event.request.postData
      ? Buffer.from(event.request.postData, "utf8")
      : null);
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
        return;
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
      if (this.isStateSatisfied(waiter.state)) {
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
    for (const capture of Array.from(this.navigationResponseCaptures)) {
      if (capture.predicate && !capture.predicate(response)) {
        continue;
      }
      capture.lastResponse = response;
      capture.resolve?.(response);
    }
  }

  private beginNavigationFailureCapture(targetUrl?: string): NavigationFailureCapture {
    let reject!: (error: Error) => void;
    const failure = new Promise<never>((_resolve, rejectCallback) => {
      reject = rejectCallback;
    });
    const capture: NavigationFailureCapture = {
      ...(targetUrl ? { targetUrl } : {}),
      reject
    };
    this.navigationFailureCaptures.add(capture);
    // The promise is consumed through raceNavigationFailure; keep a catch here so
    // cleanup after a successful navigation cannot leave a dangling rejection.
    void failure.catch(() => {});
    (capture as NavigationFailureCapture & { promise: Promise<never> }).promise = failure;
    return capture;
  }

  private endNavigationFailureCapture(capture: NavigationFailureCapture): void {
    this.navigationFailureCaptures.delete(capture);
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
    capture: NavigationFailureCapture
  ): Promise<T> {
    const failure = (capture as NavigationFailureCapture & { promise: Promise<never> }).promise;
    return Promise.race([promise, failure]);
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
        const response = await (
          this.options.client.Network as typeof this.options.client.Network & {
            getResponseBody(options: {
              requestId: string;
            }): Promise<{ base64Encoded: boolean; body: string }>;
          }
        ).getResponseBody({
          requestId
        });
        const body = response.base64Encoded
          ? Buffer.from(response.body, "base64")
          : Buffer.from(response.body, "utf8");
        if (body.byteLength || !state.expectedLength || !state.url) {
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
          url: state.url,
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
      type: () => input.type
    };
    if ((this.eventListeners.get("dialog")?.size ?? 0) === 0) {
      void dialog.dismiss().catch(() => {});
    }
    return dialog;
  }

  private createClosedError(): Error {
    return new Error(this.closeReason ?? "Target page, context or browser has been closed");
  }

  private emit<K extends RawPageEventName>(event: K, payload: RawPageEventMap[K]): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners) {
      this.bufferEarlyNetworkEvent(event, payload);
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

  private bufferEarlyNetworkEvent<K extends RawPageEventName>(event: K, payload: RawPageEventMap[K]): void {
    if (!isBufferedNetworkEvent(event) || payload === undefined) {
      return;
    }
    const events = this.earlyNetworkEvents.get(event) ?? [];
    events.push(payload as RawPageEventMap["request"] | RawPageEventMap["response"] | RawPageEventMap["requestfailed"]);
    if (events.length > 100) {
      events.shift();
    }
    this.earlyNetworkEvents.set(event, events);
  }

  private replayEarlyNetworkEvents<K extends RawPageEventName>(event: K, listener: RawPageEventListener<K>): void {
    if (!isBufferedNetworkEvent(event)) {
      return;
    }
    const events = this.earlyNetworkEvents.get(event);
    if (!events?.length) {
      return;
    }
    for (const payload of events) {
      (listener as (eventPayload: typeof payload) => void)(payload);
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
      chain: [...this.state.chain, selector],
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
    await this.page.clickLocator(this.state, options);
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

  async evaluate<TResult>(expression: string, arg?: unknown): Promise<TResult> {
    return this.page.evaluateOnReference(this.reference(), expression, arg, "No element found.");
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

class CdpWorkerDelegate implements WorkerDelegate {
  constructor(
    private readonly client: CdpClient,
    private readonly sessionId: string,
    private readonly workerUrl: string
  ) {}

  url(): string {
    return this.workerUrl;
  }

  async evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg?: Arg): Promise<R> {
    const response = await this.evaluateInWorker(pageFunction, arg, true);
    return parseEvaluationResultValue(response.result.value as SerializedValue) as R;
  }

  async evaluateHandle<R, Arg>(pageFunction: PageFunction<Arg, R>, arg?: Arg): Promise<SmartHandle<R>> {
    const response = await this.evaluateInWorker(pageFunction, arg, true);
    return createJSHandle(parseEvaluationResultValue(response.result.value as SerializedValue) as R) as SmartHandle<R>;
  }

  private async evaluateInWorker<R, Arg>(
    pageFunction: PageFunction<Arg, R>,
    arg: Arg | undefined,
    returnByValue: boolean
  ): Promise<{ exceptionDetails?: CdpExceptionDetails; result: CdpRemoteObject }> {
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
      throw new Error(formatCdpEvaluationError(globalHandle));
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
        throw new Error(formatCdpEvaluationError(response));
      }
      return response;
    } finally {
      await runtimeClient.send("Runtime.releaseObject", { objectId }, this.sessionId).catch(() => {});
    }
  }
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
    return (await this.getProperties()).get(propertyName) ?? new CdpJSHandleAdapter(this.page, {
      type: "undefined",
      value: undefined
    }, this.runtimeSessionId, this.runtimeFrameId);
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
    if (!event.includes(".") || event === "disconnect" || event === "ready" || event === "error" || event === "connect") {
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
    browserClient.on(browserEventName(event), listener)) as typeof sessionClient.on;
  sessionClient.once = ((event: string, listener: (...args: unknown[]) => void) =>
    browserEventClient.once(browserEventName(event), listener)) as typeof sessionClient.once;
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
  return client.send(method, params, sessionId);
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

async function safelyCloseClient(client: CdpClient): Promise<void> {
  try {
    await client.close();
  } catch {}
}

function resolveUrl(url: string, baseURL?: string): string {
  if (/\s/.test(url)) {
    throw new Error(`Cannot navigate to invalid URL: ${url}`);
  }
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

function createCdpConsoleHandle(arg: {
  className?: string;
  description?: string;
  subtype?: string;
  type?: string;
  unserializableValue?: string;
  value?: unknown;
}) {
  const preview = cdpRemoteObjectPreview(arg);
  return createJSHandle(cdpRemoteObjectValue(arg), preview);
}

async function serializeCdpEvaluationArguments(
  args: unknown[],
  page: CdpPageAdapter,
  temporaryHandles: ProtocolJSHandleAdapter[]
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
    const serialized = serializeAsCallArgument(arg, (value) => {
      if (value instanceof RoxyElementHandle) {
        const marker = { __roxyElementEvaluationHandle: elementHandles.length };
        elementHandles.push({ handle: value, marker });
        return { fallThrough: marker };
      }
      return serializeCdpEvaluationValue(value, pushHandle);
    });
    for (const { handle, marker } of elementHandles) {
      const remoteHandle =
        page.maybeCreateRemoteHandleFromReference(handle.reference()) ??
        await page.resolveElementReferenceAsHandle(handle.reference());
      if (!handle.reference().protocolObjectId) {
        temporaryHandles.push(remoteHandle);
      }
      const roxyHandle = new RoxyJSHandle(undefined, null, undefined, remoteHandle);
      replaceElementHandleMarker(serialized, marker, { h: pushHandle(roxyHandle) });
    }
    values.push(serialized);
  }
  return { handles, values };
}

function serializeCdpEvaluationValue(
  value: unknown,
  pushHandle: (handle: RoxyJSHandle) => number
) {
    if (value instanceof RoxyJSHandle) {
      const objectId = value._remoteObjectId();
      if (objectId) {
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
  if (arg.subtype === "node") {
    return "Node";
  }
  if (arg.subtype === "array" && arg.description) {
    return arg.description.replace(/^\((\d+)\)\s*/, "");
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

function resolveKeyDefinition(key: string): {
  code: string;
  key: string;
  keyCode: number;
  text?: string;
} {
  const definitions: Record<string, { code: string; key: string; keyCode: number; text?: string }> =
    {
      Alt: { code: "AltLeft", key: "Alt", keyCode: 18 },
      Control: { code: "ControlLeft", key: "Control", keyCode: 17 },
      Meta: { code: "MetaLeft", key: "Meta", keyCode: 91 },
      Shift: { code: "ShiftLeft", key: "Shift", keyCode: 16 },
      ShiftLeft: { code: "ShiftLeft", key: "Shift", keyCode: 16 },
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

function parseKeyboardShortcut(shortcut: string): {
  modifiers: string[];
  key: string;
} {
  if (!shortcut.includes("+")) {
    return {
      modifiers: [],
      key: normalizeShortcutKey(shortcut)
    };
  }

  const segments = shortcut.split("+");
  let key = segments.pop() ?? "";
  if (key === "") {
    key = "+";
  }

  return {
    modifiers: segments.filter(Boolean).map(normalizeShortcutKey).filter(isKeyboardModifier),
    key: normalizeShortcutKey(key)
  };
}

function normalizeShortcutKey(key: string): string {
  if (key === "ControlOrMeta") {
    return process.platform === "darwin" ? "Meta" : "Control";
  }
  return key;
}

function isKeyboardModifier(key: string): key is "Alt" | "Control" | "Meta" | "Shift" {
  return key === "Alt" || key === "Control" || key === "Meta" || key === "Shift";
}

function keyboardModifierMask(modifiers: Iterable<string>): number {
  let mask = 0;
  for (const modifier of modifiers) {
    switch (modifier) {
      case "Alt":
        mask |= 1;
        break;
      case "Control":
        mask |= 2;
        break;
      case "Meta":
        mask |= 4;
        break;
      case "Shift":
        mask |= 8;
        break;
    }
  }
  return mask;
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
