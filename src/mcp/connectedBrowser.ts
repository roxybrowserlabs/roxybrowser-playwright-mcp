import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import * as cdpModule from "chrome-remote-interface";
import mime from "mime";
import {
  normalizeAriaSnapshotOptions,
  retryUntilReady,
  type AriaSnapshotResult
} from "../ariaSnapshot.js";
import {
  applyResolvedInputFilesToInputElement,
  convertInputFiles,
  resolveLocalInputFilePaths,
  type ResolvedInputFiles
} from "../inputFiles.js";
import { PLAYWRIGHT_ARIA_SNAPSHOT_EVALUATE_SOURCE as ARIA_SNAPSHOT_EVALUATE_SOURCE } from "../vendor/playwright/ariaSnapshotEvaluate.js";
import type { BidiProtocolClient } from "../protocol/bidi/client.js";
import { getBidiClientFactory } from "../protocol/bidi/client.js";
import {
  parseSerializedEvaluationResult,
  wrapWithSerializedEvaluationResult
} from "../protocol/evaluationSerializer.js";
import {
  isKeyboardModifier,
  isUsKeyboardLayoutKey,
  keypadLocation,
  keyDescriptionForString,
  keyboardModifierMask,
  resolveSmartModifierString,
  splitKeyboardShortcut
} from "../protocol/keyboardInput.js";
import { CURSOR_VISUALIZATION_INSTALL_SOURCE } from "../human/bubbleCursor.js";
import { buildTypingDelays } from "../human/typing.js";
import { defaultRng } from "../human/random.js";
import { McpToolError } from "./errors.js";
import { ACTION_POINT_EVALUATE_SOURCE, ACTION_POINT_BY_SELECTOR_SOURCE } from "./snapshot.js";
import { configuredTempDir } from "./output.js";
import type {
  BrowserConsoleEntry,
  BrowserNetworkRequest,
  BrowserSnapshot,
  BrowserSnapshotRequest,
  BrowserTab,
  ClickTarget,
  ConnectedBrowserSession,
  RoxyBrowserConnectArgs,
  SessionClickOptions,
  SessionDragOptions,
  SessionDropOptions,
  SessionFormField,
  SessionHoverOptions,
  SessionScrollOptions,
  SessionScreenshotOptions,
  SessionTypeOptions
} from "./types.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withBiDiTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const chromeRemoteInterface = ("default" in cdpModule
  ? cdpModule.default
  : cdpModule) as unknown as {
  Version(options: { host: string; port: number }): Promise<{ Browser: string; webSocketDebuggerUrl: string }>;
  (options: {
    host?: string;
    port?: number;
    target?: string;
    local?: boolean;
  }): Promise<CdpClient>;
};

type CdpTargetInfo = {
  targetId: string;
  type: string;
  title: string;
  url: string;
};

type CdpFrameTree = {
  frame: {
    id: string;
    parentId?: string;
    url: string;
  };
  childFrames?: CdpFrameTree[];
};

type PendingFileChooserTarget = {
  backendNodeId: number;
};

type CdpClient = {
  close(): Promise<void>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  Page: {
    enable(): Promise<void>;
    setInterceptFileChooserDialog?(options: { enabled: boolean }): Promise<void>;
    fileChooserOpened?(
      listener: (event: {
        backendNodeId?: number;
        frameId: string;
        mode: "selectSingle" | "selectMultiple";
      }) => void
    ): void;
    createIsolatedWorld(options: {
      frameId: string;
      worldName?: string;
      grantUniveralAccess?: boolean;
      grantUniversalAccess?: boolean;
    }): Promise<{ executionContextId: number }>;
    getFrameTree(): Promise<{ frameTree: CdpFrameTree }>;
    navigate(options: { url: string }): Promise<{ frameId: string; errorText?: string }>;
    getNavigationHistory(): Promise<{
      currentIndex: number;
      entries: Array<{ id: number; url: string }>;
    }>;
    navigateToHistoryEntry(options: { entryId: number }): Promise<void>;
    captureScreenshot(options?: {
      format?: "jpeg" | "png";
      clip?: { x: number; y: number; width: number; height: number; scale: number };
    }): Promise<{ data: string }>;
    handleJavaScriptDialog(options: { accept: boolean; promptText?: string }): Promise<void>;
    javascriptDialogOpening(
      listener: (event: {
        url?: string;
        message: string;
        type: "alert" | "confirm" | "prompt" | "beforeunload";
        defaultPrompt?: string;
      }) => void
    ): void;
    frameStoppedLoading?(listener: (event: { frameId: string }) => void): void;
    loadEventFired?(listener: (event: { timestamp?: number }) => void): void;
  };
  Runtime: {
    enable(): Promise<void>;
    callFunctionOn(options: {
      functionDeclaration: string;
      objectId?: string;
      arguments?: Array<{
        objectId?: string;
        unserializableValue?: string;
        value?: unknown;
      }>;
      returnByValue?: boolean;
      awaitPromise?: boolean;
      executionContextId?: number;
    }): Promise<{
      result: { value?: unknown; objectId?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } };
    }>;
    consoleAPICalled(
      listener: (event: {
        type: string;
        executionContextId?: number;
        args: Array<{
          description?: string;
          type?: string;
          unserializableValue?: string;
          value?: unknown;
        }>;
        timestamp?: number;
        stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number }> };
      }) => void
    ): void;
    exceptionThrown(
      listener: (event: {
        timestamp?: number;
        exceptionDetails?: {
          text?: string;
          url?: string;
          lineNumber?: number;
          exception?: { description?: string; value?: unknown };
        };
      }) => void
    ): void;
    evaluate(options: {
      expression: string;
      returnByValue: boolean;
      awaitPromise: boolean;
      contextId?: number;
    }): Promise<{
      result: { value?: unknown; objectId?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } };
    }>;
  };
  Network?: {
    enable(options?: {}): Promise<void>;
    requestWillBeSent(
      listener: (event: {
        requestId: string;
        loaderId?: string;
        frameId?: string;
        timestamp?: number;
        redirectHasExtraInfo?: boolean;
        type?: string;
        redirectResponse?: {
          url: string;
          status: number;
          statusText: string;
          headers?: Record<string, string>;
          mimeType?: string;
          fromDiskCache?: boolean;
          fromPrefetchCache?: boolean;
        };
        request: {
          url: string;
          method: string;
          headers?: Record<string, string>;
          postData?: string;
        };
      }) => void
    ): void;
    requestWillBeSentExtraInfo?(
      listener: (event: {
        requestId: string;
        headers: Record<string, string>;
      }) => void
    ): void;
    responseReceived(
      listener: (event: {
        requestId: string;
        timestamp?: number;
        type?: string;
        hasExtraInfo?: boolean;
        response: {
          url: string;
          status: number;
          statusText: string;
          headers?: Record<string, string>;
          mimeType?: string;
        };
      }) => void
    ): void;
    responseReceivedExtraInfo?(
      listener: (event: {
        requestId: string;
        headers: Record<string, string>;
        headersText?: string;
        statusCode?: number;
      }) => void
    ): void;
    requestServedFromCache?(
      listener: (event: {
        requestId: string;
      }) => void
    ): void;
    loadingFinished(listener: (event: { requestId: string; timestamp?: number }) => void): void;
    loadingFailed(listener: (event: { requestId: string; timestamp?: number; errorText?: string }) => void): void;
    getResponseBody(options: { requestId: string }): Promise<{ body: string; base64Encoded: boolean }>;
  };
  Emulation?: {
    setDeviceMetricsOverride(options: {
      mobile: boolean;
      width: number;
      height: number;
      deviceScaleFactor: number;
      screenWidth: number;
      screenHeight: number;
    }): Promise<void>;
  };
  Log?: {
    enable(): Promise<void>;
    entryAdded(
      listener: (event: {
        entry: {
          args?: Array<{ objectId?: string }>;
          level?: string;
          text?: string;
          source?: string;
          timestamp?: number;
          url?: string;
          lineNumber?: number;
        };
      }) => void
    ): void;
  };
  DOM: {
    enable(options: {}): Promise<void>;
    getDocument(): Promise<{ root: { nodeId: number } }>;
    querySelector(options: { nodeId: number; selector: string }): Promise<{ nodeId: number }>;
    resolveNode(options: { objectId?: string; backendNodeId?: number }): Promise<{ object: { objectId?: string } }>;
    setFileInputFiles(options: { nodeId?: number; objectId?: string; files: string[] }): Promise<void>;
    getBoxModel(options: { nodeId?: number; objectId?: string }): Promise<{
      model: { content: number[]; border: number[]; padding: number[] };
    }>;
  };
  Input: {
    dispatchMouseEvent(options: {
      type: "mouseMoved" | "mousePressed" | "mouseReleased";
      x: number;
      y: number;
      button: "none" | "left" | "middle" | "right";
      clickCount?: number;
      modifiers?: number;
    }): Promise<void>;
    dispatchKeyEvent(options: {
      type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
      key?: string;
      code?: string;
      windowsVirtualKeyCode?: number;
      nativeVirtualKeyCode?: number;
      text?: string;
      unmodifiedText?: string;
      autoRepeat?: boolean;
      location?: number;
      isKeypad?: boolean;
      modifiers?: number;
    }): Promise<void>;
    insertText(options: { text: string }): Promise<void>;
    synthesizeScrollGesture(options: {
      x: number;
      y: number;
      xDistance?: number;
      yDistance?: number;
    }): Promise<void>;
  };
  Target: {
    getTargets(): Promise<{ targetInfos: CdpTargetInfo[] }>;
    createTarget(options: { url: string }): Promise<{ targetId: string }>;
    activateTarget(options: { targetId: string }): Promise<void>;
    closeTarget(options: { targetId: string }): Promise<void>;
  };
};

interface CdpConnectionDetails {
  browserWsEndpoint: string;
  host: string;
  port: number;
}

interface BrowserConsoleMessage {
  type: string;
  timestamp: number;
  text: string;
  locationUrl: string;
  lineNumber: number;
  formattedText: string;
}

interface BrowserConsoleState {
  messages: BrowserConsoleMessage[];
  nextMessageIndex: number;
  logStartTime: number;
  logLine: number;
  logFile?: string;
}

interface RequestLifecycleWaiter {
  promise: Promise<void>;
  resolve: () => void;
  reject?: (error: Error) => void;
}

interface RequestLifecycleState {
  loadingDone?: RequestLifecycleWaiter;
  loadingDoneSettled?: boolean;
}

interface TrackedBrowserNetworkResponse {
  available?: RequestLifecycleWaiter;
  availableSettled?: boolean;
  finished?: RequestLifecycleWaiter;
  finishedSettled?: boolean;
  status?: number | undefined;
  statusText?: string | undefined;
  headers?: Record<string, string> | undefined;
  rawHeaders?: Record<string, string> | undefined;
  headersSize?: number | undefined;
  mimeType?: string | undefined;
  body?: string | undefined;
}

interface TrackedRequestObject {
  request: TrackedBrowserNetworkRequest;
  hasFailure(): boolean;
  hasResponseBody(): boolean;
  hasResponse(): boolean;
  hasRawRequestHeadersMissing(): boolean;
  hasRawResponseHeadersProvisional(): boolean;
  setFailureText(failureText: string): void;
  markResponseFailure(failureText: string): void;
  setRawRequestHeaders(rawHeaders: Record<string, string> | undefined): void;
  isLoadingDoneSettled(): boolean;
  loadingDoneEntry(): RequestLifecycleWaiter;
  markLoadingDone(success: boolean): void;
}

interface TrackedResponseObject {
  response: TrackedBrowserNetworkResponse;
  request: TrackedRequestObject;
  isAvailableSettled(): boolean;
  isFinishedSettled(): boolean;
  responseAvailableEntry(): RequestLifecycleWaiter;
  requestFinishedEntry(): RequestLifecycleWaiter;
  markAvailable(): void;
  markFinished(): void;
  setBody(body: string): void;
  setMetadata(response: {
    status: number;
    statusText: string;
    headers?: Record<string, string> | undefined;
    mimeType?: string | undefined;
  }): void;
  setRawMetadata(rawHeaders: Record<string, string> | undefined, headersSize: number | undefined): void;
  setStatus(status: number): void;
}

type TrackedBrowserNetworkRequest = BrowserNetworkRequest & {
  __lifecycle?: RequestLifecycleState;
  __response?: TrackedBrowserNetworkResponse;
  __requestObject?: TrackedRequestObject;
  __responseObject?: TrackedResponseObject;
};

interface BrowserNetworkState {
  requests: TrackedBrowserNetworkRequest[];
  byRequestId: Map<string, TrackedBrowserNetworkRequest>;
  byRequestKey: Map<string, TrackedBrowserNetworkRequest>;
  requestsByRequestId: Map<string, TrackedBrowserNetworkRequest[]>;
  requestSequenceByRequestId: Map<string, number>;
  requestExtraInfoHeaders: Map<string, Array<Record<string, string>>>;
  responseExtraInfoHeaders: Map<string, Array<{ headers: Record<string, string>; headersSize?: number }>>;
  servedFromCacheRequestIds: Set<string>;
  startedAt: Map<string, number>;
  hydratedPerformanceResources: boolean;
  bodyRead: Set<string>;
}

interface CompletionRequestCollector {
  requests: BrowserNetworkRequest[];
  requestKeys: string[];
  liveRequests: TrackedRequestObject[];
}

interface BrowserDialogState {
  message: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  defaultPrompt?: string | undefined;
  url?: string | undefined;
}

interface DialogWaiter {
  resolve(): void;
  reject?(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

function createBrowserNetworkState(): BrowserNetworkState {
  return {
    requests: [],
    byRequestId: new Map(),
    byRequestKey: new Map(),
    requestsByRequestId: new Map(),
    requestSequenceByRequestId: new Map(),
    requestExtraInfoHeaders: new Map(),
    responseExtraInfoHeaders: new Map(),
    servedFromCacheRequestIds: new Set(),
    startedAt: new Map(),
    hydratedPerformanceResources: false,
    bodyRead: new Set()
  };
}

function buildConnectionFromWsEndpoint(browserWsEndpoint: string): CdpConnectionDetails {
  const parsed = new URL(browserWsEndpoint);
  return {
    browserWsEndpoint,
    host: parsed.hostname,
    port: Number(parsed.port)
  };
}

async function resolveCdpConnection(endpoint: string): Promise<CdpConnectionDetails> {
  const parsed = new URL(endpoint);
  if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
    return buildConnectionFromWsEndpoint(endpoint);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new McpToolError(
      "unsupported_protocol_input",
      `CDP endpoint must use http(s) discovery or ws(s) browser websocket. Received "${parsed.protocol}".`
    );
  }

  const versionUrl = parsed.pathname.endsWith("/json/version")
    ? parsed
    : new URL("/json/version", parsed);
  const response = await fetch(versionUrl);
  if (!response.ok) {
    throw new Error(`Unable to resolve CDP discovery endpoint: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!payload.webSocketDebuggerUrl) {
    throw new Error("CDP discovery response did not include webSocketDebuggerUrl.");
  }

  return buildConnectionFromWsEndpoint(payload.webSocketDebuggerUrl);
}

async function evaluateCdp<TResult>(
  client: CdpClient,
  functionSource: string,
  arg?: unknown,
  contextId?: number
): Promise<TResult> {
  const expression =
    arg === undefined
      ? `(${functionSource})()`
      : `(${functionSource})(${JSON.stringify(arg)})`;
  const response = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: true,
    ...(contextId !== undefined ? { contextId } : {})
  });

  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description;
    const value = response.exceptionDetails.exception?.value;
    throw new Error(
      description
        || (value !== undefined ? String(value) : undefined)
        || response.exceptionDetails.text
        || "CDP runtime evaluation failed."
    );
  }

  return response.result.value as TResult;
}

async function evaluateCdpRef(
  client: CdpClient,
  functionSource: string,
  arg?: unknown,
  contextId?: number
): Promise<{ objectId?: string }> {
  const expression =
    arg === undefined
      ? `(${functionSource})()`
      : `(${functionSource})(${JSON.stringify(arg)})`;
  const response = await client.Runtime.evaluate({
    expression,
    returnByValue: false,
    awaitPromise: true,
    ...(contextId !== undefined ? { contextId } : {})
  });

  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description;
    const value = response.exceptionDetails.exception?.value;
    throw new Error(
      description
        || (value !== undefined ? String(value) : undefined)
        || response.exceptionDetails.text
        || "CDP runtime evaluation failed."
    );
  }

  const objectId = response.result.objectId;
  return objectId !== undefined ? { objectId } : {};
}

function isBackendNodeTarget(target: ClickTarget): target is { backendNodeId: number } {
  return "backendNodeId" in target;
}

const FOCUS_AND_GET_ELEMENT_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  const el = payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : document.querySelector(payload.selector);
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  el.focus();
  return el;
}`;

const CLEAR_ELEMENT_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  const el = payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : document.querySelector(payload.selector);
  if (!el || !el.isConnected) return { ok: false, reason: 'not_found' };
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  el.focus();
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, '');
    else el.value = '';
  } else if (el.isContentEditable) {
    el.textContent = '';
  } else {
    return { ok: false, reason: 'not_input' };
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}`;

const TYPE_INTO_ELEMENT_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  const el = payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : document.querySelector(payload.selector);
  if (!el || !el.isConnected) return { ok: false, reason: 'not_found' };
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  el.focus();
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, payload.text);
    else el.value = payload.text;
  } else if (el.isContentEditable) {
    el.textContent = payload.text;
  } else {
    return { ok: false, reason: 'not_input' };
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (payload.submit) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
    if (el.form && typeof el.form.submit === 'function') el.form.submit();
    else if (el.form) {
      el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  }
  return { ok: true };
}`;

const SELECT_OPTION_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  const el = payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : document.querySelector(payload.selector);
  if (!el || !el.isConnected) return { ok: false, reason: 'not_found', selected: [] };
  if (el.tagName.toLowerCase() !== 'select') return { ok: false, reason: 'not_select', selected: [] };
  const selectEl = el;
  const values = payload.values;
  let matched = false;
  for (const option of selectEl.options) {
    const shouldSelect = values.includes(option.value) || values.includes(option.text);
    if (shouldSelect) {
      option.selected = true;
      matched = true;
    } else if (!selectEl.multiple) {
      option.selected = false;
    }
  }
  if (!matched) {
    // Try partial match
    for (const option of selectEl.options) {
      const shouldSelect = values.some(v => option.value.includes(v) || option.text.includes(v));
      if (shouldSelect) { option.selected = true; matched = true; }
    }
  }
  selectEl.dispatchEvent(new Event('input', { bubbles: true }));
  selectEl.dispatchEvent(new Event('change', { bubbles: true }));
  const selected = Array.from(selectEl.selectedOptions).map(o => o.value);
  return { ok: matched, selected };
}`;

const CHECK_ELEMENT_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  const el = payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : document.querySelector(payload.selector);
  if (!el || !el.isConnected) return { ok: false, reason: 'not_found' };
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type')?.toLowerCase();
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
    if (el.checked !== payload.checked) {
      el.click();
    }
    return { ok: true };
  }
  const role = el.getAttribute('role');
  if (role === 'checkbox' || role === 'switch') {
    const current = el.getAttribute('aria-checked') === 'true';
    if (current !== payload.checked) {
      el.click();
    }
    return { ok: true };
  }
  return { ok: false, reason: 'not_checkable' };
}`;

const IS_FILE_INPUT_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  const element = payload.nodeToken
    ? state?.elements?.get(payload.nodeToken)
    : document.querySelector(payload.selector);
  return !!element
    && element instanceof HTMLInputElement
    && element.type === 'file';
}`;

const SCROLL_ELEMENT_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  const el = payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : payload.selector ? document.querySelector(payload.selector) : null;
  const target = el ?? document.documentElement;
  target.scrollBy({ left: payload.deltaX, top: payload.deltaY, behavior: 'instant' });
  return { ok: true };
}`;

const ENSURE_BUBBLE_CURSOR_SOURCE = CURSOR_VISUALIZATION_INSTALL_SOURCE;

const GET_ELEMENT_OBJECT_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  return payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : document.querySelector(payload.selector);
}`;

// Retained for non-native/legacy upload paths; the CDP primary path now uses DOM.setFileInputFiles.
async function setResolvedInputFilesByObjectId(
  client: CdpClient,
  objectId: string,
  inputFiles: ResolvedInputFiles,
  debug?: {
    eventDispatchCalls: number;
    eventDispatchSuccesses: number;
    lastEventDispatchError: string;
  }
): Promise<void> {
  if (debug) {
    debug.eventDispatchCalls += 1;
  }
  const response = await client.Runtime.callFunctionOn({
    objectId,
    functionDeclaration: `function(inputFiles) {
      return (${applyResolvedInputFilesToInputElement.toString()})(this, inputFiles);
    }`,
    arguments: [{ value: inputFiles }],
    returnByValue: true,
    awaitPromise: true
  });

  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description;
    const value = response.exceptionDetails.exception?.value;
    if (debug) {
      debug.lastEventDispatchError =
        description
        || (value !== undefined ? String(value) : undefined)
        || response.exceptionDetails.text
        || "CDP runtime callFunctionOn failed.";
    }
    throw new Error(
      description
        || (value !== undefined ? String(value) : undefined)
        || response.exceptionDetails.text
        || "CDP runtime callFunctionOn failed."
    );
  }
  if (debug) {
    debug.eventDispatchSuccesses += 1;
    debug.lastEventDispatchError = "";
  }
}

async function setNativeInputFilePathsByObjectId(
  client: CdpClient,
  objectId: string,
  filePaths: string[]
): Promise<void> {
  await client.DOM.setFileInputFiles({
    objectId,
    files: filePaths
  });
}

const SET_FORM_FIELD_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  const el = payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : document.querySelector(payload.selector);
  if (!el || !el.isConnected) return { ok: false, reason: 'not_found' };
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type')?.toLowerCase();
  if (payload.fieldType === 'value') {
    if (tag !== 'input') return { ok: false, reason: 'not_input' };
    const directValueTypes = new Set(['color', 'date', 'time', 'datetime-local', 'month', 'range', 'week']);
    if (!directValueTypes.has(type ?? '')) return { ok: false, reason: 'not_direct_value_input' };
    let value = String(payload.value).trim();
    if (type === 'color') value = value.toLowerCase();
    el.focus();
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    if (el.value !== value) return { ok: false, reason: 'malformed_value' };
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  if (payload.fieldType === 'textbox' || payload.fieldType === 'slider') {
    if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) return { ok: false, reason: 'not_input' };
    el.focus();
    if (el.isContentEditable) el.textContent = payload.value;
    else {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, payload.value);
      else el.value = payload.value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  if (payload.fieldType === 'checkbox' || payload.fieldType === 'radio') {
    if (tag !== 'input' || (type !== 'checkbox' && type !== 'radio')) return { ok: false, reason: 'not_checkable' };
    const checked = payload.value === 'true';
    if (el.checked !== checked) el.click();
    return { ok: true };
  }
  if (payload.fieldType === 'combobox') {
    if (tag !== 'select') return { ok: false, reason: 'not_select' };
    let matched = false;
    for (const option of el.options) {
      const shouldSelect = option.value === payload.value || option.text === payload.value;
      option.selected = shouldSelect;
      matched ||= shouldSelect;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: matched, reason: matched ? undefined : 'not_found' };
  }
  return { ok: false, reason: 'unsupported' };
}`;

const FORM_FIELD_METADATA_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  const el = payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : document.querySelector(payload.selector);
  if (!el || !el.isConnected) return { ok: false, reason: 'not_found' };
  return {
    ok: true,
    tagName: el.tagName.toLowerCase(),
    inputType: el instanceof HTMLInputElement ? el.type.toLowerCase() : undefined,
    isContentEditable: Boolean(el.isContentEditable)
  };
}`;

const DROP_ON_ELEMENT_SOURCE = String.raw`async (payload) => {
  const state = globalThis.__roxyMcpState;
  const el = payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : document.querySelector(payload.selector);
  if (!el || !el.isConnected) return { ok: false, reason: 'not_found' };
  const dataTransfer = new DataTransfer();
  for (const file of payload.files || []) {
    const bytes = Uint8Array.from(atob(file.buffer), c => c.charCodeAt(0));
    dataTransfer.items.add(new File([bytes], file.name, {
      type: file.mimeType || 'application/octet-stream',
      lastModified: file.lastModifiedMs
    }));
  }
  for (const [type, value] of Object.entries(payload.data || {}))
    dataTransfer.setData(type, value);
  const rect = el.getBoundingClientRect();
  const makeEvent = (type) => new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    dataTransfer,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2
  });
  el.dispatchEvent(makeEvent('dragenter'));
  const dragover = makeEvent('dragover');
  el.dispatchEvent(dragover);
  if (!dragover.defaultPrevented) {
    el.dispatchEvent(makeEvent('dragleave'));
    return { ok: false, reason: 'not_accepted' };
  }
  el.dispatchEvent(makeEvent('drop'));
  return { ok: true };
}`;

const ELEMENT_BOX_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  const el = payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : document.querySelector(payload.selector);
  if (!el || !el.isConnected || !(el instanceof Element) || el.getClientRects().length === 0)
    return { ok: false };
  const rect = el.getBoundingClientRect();
  return {
    ok: true,
    x: rect.x,
    y: rect.y,
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height)
  };
}`;

const DOCUMENT_BOX_SOURCE = String.raw`() => {
  const body = document.body;
  const documentElement = document.documentElement;
  const width = Math.max(
    body?.scrollWidth ?? 0,
    body?.offsetWidth ?? 0,
    documentElement?.clientWidth ?? 0,
    documentElement?.scrollWidth ?? 0,
    documentElement?.offsetWidth ?? 0
  );
  const height = Math.max(
    body?.scrollHeight ?? 0,
    body?.offsetHeight ?? 0,
    documentElement?.clientHeight ?? 0,
    documentElement?.scrollHeight ?? 0,
    documentElement?.offsetHeight ?? 0
  );
  return { x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) };
}`;

const VIEWPORT_BOX_SOURCE = String.raw`() => ({
  x: 0,
  y: 0,
  width: Math.max(1, globalThis.innerWidth || document.documentElement?.clientWidth || 1),
  height: Math.max(1, globalThis.innerHeight || document.documentElement?.clientHeight || 1)
})`;

const CDP_KEY_MAP: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter:      { key: "Enter",     code: "Enter",       keyCode: 13, text: "\r" },
  Return:     { key: "Enter",     code: "Enter",       keyCode: 13, text: "\r" },
  Escape:     { key: "Escape",    code: "Escape",      keyCode: 27 },
  Tab:        { key: "Tab",       code: "Tab",         keyCode: 9 },
  Backspace:  { key: "Backspace", code: "Backspace",   keyCode: 8 },
  Delete:     { key: "Delete",    code: "Delete",      keyCode: 46 },
  ArrowLeft:  { key: "ArrowLeft", code: "ArrowLeft",   keyCode: 37 },
  ArrowRight: { key: "ArrowRight",code: "ArrowRight",  keyCode: 39 },
  ArrowUp:    { key: "ArrowUp",   code: "ArrowUp",     keyCode: 38 },
  ArrowDown:  { key: "ArrowDown", code: "ArrowDown",   keyCode: 40 },
  Home:       { key: "Home",      code: "Home",        keyCode: 36 },
  End:        { key: "End",       code: "End",         keyCode: 35 },
  PageUp:     { key: "PageUp",    code: "PageUp",      keyCode: 33 },
  PageDown:   { key: "PageDown",  code: "PageDown",    keyCode: 34 },
  Insert:     { key: "Insert",    code: "Insert",      keyCode: 45 },
  Space:      { key: " ",         code: "Space",       keyCode: 32, text: " " },
  F1:  { key: "F1",  code: "F1",  keyCode: 112 },
  F2:  { key: "F2",  code: "F2",  keyCode: 113 },
  F3:  { key: "F3",  code: "F3",  keyCode: 114 },
  F4:  { key: "F4",  code: "F4",  keyCode: 115 },
  F5:  { key: "F5",  code: "F5",  keyCode: 116 },
  F6:  { key: "F6",  code: "F6",  keyCode: 117 },
  F7:  { key: "F7",  code: "F7",  keyCode: 118 },
  F8:  { key: "F8",  code: "F8",  keyCode: 119 },
  F9:  { key: "F9",  code: "F9",  keyCode: 120 },
  F10: { key: "F10", code: "F10", keyCode: 121 },
  F11: { key: "F11", code: "F11", keyCode: 122 },
  F12: { key: "F12", code: "F12", keyCode: 123 },
};

function humanMousePath(
  start: { x: number; y: number },
  end: { x: number; y: number },
  moveDelayMs = 140
): Array<{ x: number; y: number; pauseMs: number }> {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const steps = Math.max(Math.ceil(distance / 18), 1);
  const perStepBase = Math.max(24, Math.round(moveDelayMs / 2.4));
  const points: Array<{ x: number; y: number; pauseMs: number }> = [];
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps;
    const easedProgress = 1 - Math.pow(1 - progress, 2);
    const drift = Math.sin(progress * Math.PI) * Math.min(18, distance * 0.08);
    points.push({
      x: start.x + ((end.x - start.x) * easedProgress) + drift * ((end.y - start.y) / Math.max(distance, 1)),
      y: start.y + ((end.y - start.y) * easedProgress) - drift * ((end.x - start.x) / Math.max(distance, 1)),
      pauseMs: index < steps ? perStepBase + Math.round((1 - progress) * Math.max(18, moveDelayMs * 0.35)) : 0
    });
  }
  return points;
}

async function evaluateBiDi<TResult>(
  client: BidiProtocolClient,
  contextId: string,
  functionSource: string,
  arg?: unknown
): Promise<TResult> {
  const expression =
    arg === undefined
      ? `(${functionSource})()`
      : `(${functionSource})(${JSON.stringify(arg)})`;
  const response = (await client.scriptEvaluate({
    expression: wrapWithSerializedEvaluationResult(expression),
    target: {
      context: contextId
    },
    awaitPromise: true,
    resultOwnership: "none"
  })) as {
    type: string;
    result?: BidiRemoteValue;
    exceptionDetails?: { text?: string };
  };

  if (response.type === "exception") {
    throw new Error(response.exceptionDetails?.text || "BiDi runtime evaluation failed.");
  }

  return parseSerializedEvaluationResult<TResult>(extractBiDiValue(response.result));
}

async function evaluateBiDiRef(
  client: BidiProtocolClient,
  contextId: string,
  functionSource: string,
  arg?: unknown
): Promise<{ sharedId?: string; handle?: string }> {
  const expression =
    arg === undefined
      ? `(${functionSource})()`
      : `(${functionSource})(${JSON.stringify(arg)})`;
  const response = (await client.scriptEvaluate({
    expression,
    target: {
      context: contextId
    },
    awaitPromise: true,
    resultOwnership: "root",
    serializationOptions: {
      maxObjectDepth: 0,
      maxDomDepth: 0
    }
  })) as {
    type: string;
    result?: { sharedId?: string; handle?: string; value?: { sharedId?: string; handle?: string } };
    exceptionDetails?: { text?: string };
  };

  if (response.type === "exception") {
    throw new Error(response.exceptionDetails?.text || "BiDi runtime evaluation failed.");
  }

  return {
    ...(response.result?.sharedId !== undefined ? { sharedId: response.result.sharedId } : {}),
    ...(response.result?.handle !== undefined ? { handle: response.result.handle } : {}),
    ...(response.result?.value?.sharedId !== undefined ? { sharedId: response.result.value.sharedId } : {}),
    ...(response.result?.value?.handle !== undefined ? { handle: response.result.value.handle } : {})
  };
}

async function splitScrollDeltas(
  deltaX: number,
  deltaY: number,
  stepPx: number
): Promise<Array<{ deltaX: number; deltaY: number }>> {
  const dominantDistance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
  if (dominantDistance === 0) {
    return [];
  }
  const steps = Math.max(1, Math.ceil(dominantDistance / Math.max(1, stepPx)));
  const chunks: Array<{ deltaX: number; deltaY: number }> = [];
  let appliedX = 0;
  let appliedY = 0;
  for (let index = 0; index < steps; index += 1) {
    const nextAppliedX = Math.round((deltaX * (index + 1)) / steps);
    const nextAppliedY = Math.round((deltaY * (index + 1)) / steps);
    chunks.push({
      deltaX: nextAppliedX - appliedX,
      deltaY: nextAppliedY - appliedY
    });
    appliedX = nextAppliedX;
    appliedY = nextAppliedY;
  }
  return chunks.filter((chunk) => chunk.deltaX !== 0 || chunk.deltaY !== 0);
}

function maybeReverseScrollChunk(
  chunk: { deltaX: number; deltaY: number },
  index: number,
  total: number
): { deltaX: number; deltaY: number } | null {
  if (total < 3 || index === 0 || index === total - 1) {
    return null;
  }
  if (Math.random() > 0.18) {
    return null;
  }
  return {
    deltaX: -Math.round(chunk.deltaX * (0.18 + Math.random() * 0.18)),
    deltaY: -Math.round(chunk.deltaY * (0.18 + Math.random() * 0.18))
  };
}

function shouldPauseToObserve(index: number, total: number): boolean {
  if (index === total - 1) {
    return false;
  }
  return total > 2 && Math.random() < 0.22;
}

type BidiRemoteValue = {
  type: string;
  value?: unknown;
};

function extractBiDiValue<TResult>(value: BidiRemoteValue | undefined): TResult {
  if (!value) {
    return undefined as TResult;
  }

  if (value.type === "array" && Array.isArray(value.value)) {
    return value.value.map((entry) => extractBiDiValue(entry as BidiRemoteValue)) as TResult;
  }

  if (value.type === "object" && Array.isArray(value.value)) {
    const obj: Record<string, unknown> = {};
    for (const [key, val] of value.value as Array<[string, BidiRemoteValue]>) {
      obj[key] = extractBiDiValue(val);
    }
    return obj as TResult;
  }

  return value.value as TResult;
}

function toAriaSnapshotPayload(request: BrowserSnapshotRequest = {}): {
  options: ReturnType<typeof normalizeAriaSnapshotOptions>;
  target?: BrowserSnapshotRequest["target"];
} {
  return {
    options: normalizeAriaSnapshotOptions({
      mode: "ai",
      ...(request.depth !== undefined ? { depth: request.depth } : {}),
      ...(request.boxes !== undefined ? { boxes: request.boxes } : {})
    }),
    ...(request.target ? { target: request.target } : {})
  };
}

function toBrowserSnapshot(
  result: AriaSnapshotResult,
  request: BrowserSnapshotRequest,
  extras: Pick<BrowserSnapshot, "console" | "consoleLink"> = {}
): BrowserSnapshot {
  if (result.error) {
    const targetLabel = request.target?.raw ?? "target";
    const detailedMessage = result.error.message;
    if (result.error.code === "stale") {
      throw new McpToolError(
        "stale_ref",
        detailedMessage || `Target "${targetLabel}" is no longer valid. Call "browser_snapshot" again.`
      );
    }

    if (result.error.code === "invalid_selector" || result.error.code === "strict") {
      throw new McpToolError(
        "invalid_target",
        detailedMessage || `Target "${targetLabel}" is not a valid selector.`
      );
    }

    throw new McpToolError(
      "invalid_target",
      detailedMessage || `Target "${targetLabel}" could not be found in the active tab.`
    );
  }

  return {
    refs: result.refs,
    text: result.text,
    title: result.title,
    url: result.url,
    ...(extras.console ? { console: extras.console } : {}),
    ...(extras.consoleLink ? { consoleLink: extras.consoleLink } : {})
  };
}

function chooseInitialTab(tabs: Array<{ id: string; url: string }>): string | undefined {
  return tabs.find((tab) => tab.url && tab.url !== "about:blank")?.id ?? tabs[0]?.id;
}

export class CdpConnectedBrowserSession implements ConnectedBrowserSession {
  readonly protocol = "cdp" as const;
  readonly browserName = "chromium" as const;

  private readonly pageClients = new Map<string, CdpClient>();
  private readonly pageConsoleStates = new Map<string, BrowserConsoleState>();
  private readonly pageNetworkStates = new Map<string, BrowserNetworkState>();
  private readonly completionCollectorsByTabId = new Map<string, Set<CompletionRequestCollector>>();
  private readonly pageDialogStates = new Map<string, BrowserDialogState>();
  private readonly dialogWaiters = new Map<string, Set<DialogWaiter>>();
  private activeTabId: string | undefined;
  private versionString = "Chromium/unknown";
  private readonly tempDir: string;
  private currentMousePosition = { x: 0, y: 0 };
  private hasMouseEnteredViewport = false;
  private readonly fileChooserInterceptEnabledByTabId = new Set<string>();
  private readonly pendingFileChooserTargetByTabId = new Map<string, PendingFileChooserTarget>();
  private fileChooserDebug = {
    prepareCalls: 0,
    chooserEvents: 0,
    capturedTargets: 0,
    eventDispatchCalls: 0,
    eventDispatchSuccesses: 0,
    lastEventDispatchError: ""
  };
  private readonly pressedKeyboardModifiers = new Set<string>();
  private readonly pressedKeyboardCodes = new Set<string>();

  private constructor(
    private readonly browserClient: CdpClient,
    private readonly connection: CdpConnectionDetails,
    tempDir?: string
  ) {
    this.tempDir = configuredTempDir({
      ...(tempDir !== undefined ? { tempDir } : {})
    });
  }

  static async connect(args: RoxyBrowserConnectArgs): Promise<CdpConnectedBrowserSession> {
    if (args.browser && args.browser !== "chromium") {
      throw new McpToolError(
        "unsupported_protocol_input",
        'CDP attach only supports browser "chromium".'
      );
    }

    const connection = await resolveCdpConnection(args.endpoint);
    const version = await chromeRemoteInterface.Version({
      host: connection.host,
      port: connection.port
    });
    const browserClient = await chromeRemoteInterface({
      target: connection.browserWsEndpoint
    });

    const session = new CdpConnectedBrowserSession(browserClient, connection, args.tempDir);
    session.versionString = version.Browser;
    await session.refreshTabs();
    await session.getActivePageClient().catch(() => undefined);
    return session;
  }

  async version(): Promise<string> {
    return this.versionString;
  }

  async listTabs(): Promise<BrowserTab[]> {
    return this.refreshTabs();
  }

  async newTab(url = "about:blank"): Promise<BrowserTab[]> {
    const response = await this.browserClient.Target.createTarget({ url });
    this.activeTabId = response.targetId;
    await this.browserClient.Target.activateTarget({
      targetId: response.targetId
    });
    return this.refreshTabs();
  }

  async selectTab(tabId: string): Promise<BrowserTab[]> {
    this.activeTabId = tabId;
    await this.browserClient.Target.activateTarget({
      targetId: tabId
    });
    return this.refreshTabs();
  }

  async closeTab(tabId: string): Promise<BrowserTab[]> {
    const tabsBeforeClose = await this.refreshTabs();
    const index = tabsBeforeClose.findIndex((tab) => tab.id === tabId);
    await this.browserClient.Target.closeTarget({
      targetId: tabId
    });

    const pageClient = this.pageClients.get(tabId);
    if (pageClient) {
      this.pageClients.delete(tabId);
      this.pageConsoleStates.delete(tabId);
      const networkState = this.pageNetworkStates.get(tabId);
      if (networkState) {
        settleOutstandingNetworkWaits(networkState);
        this.pageNetworkStates.delete(tabId);
      }
      this.pageDialogStates.delete(tabId);
      this.completionCollectorsByTabId.delete(tabId);
      await pageClient.close().catch(() => {});
    }

    const tabsAfterClose = await this.refreshTabs();
    if (tabsAfterClose.length === 0) {
      this.activeTabId = undefined;
      return tabsAfterClose;
    }

    const fallbackIndex = index >= 0 ? Math.min(index, tabsAfterClose.length - 1) : 0;
    this.activeTabId = tabsAfterClose[fallbackIndex]?.id;
    if (this.activeTabId) {
      await this.browserClient.Target.activateTarget({
        targetId: this.activeTabId
      });
    }
    return this.refreshTabs();
  }

  async snapshot(request: BrowserSnapshotRequest = {}): Promise<BrowserSnapshot> {
    const activeTabId = await this.getActiveTabId();
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    const result = await retryUntilReady(() =>
      evaluateCdp<AriaSnapshotResult>(
        pageClient,
        ARIA_SNAPSHOT_EVALUATE_SOURCE,
        toAriaSnapshotPayload(request),
        contextId
      )
    );
    return toBrowserSnapshot(result, request, {
      console: this.consoleSummary(activeTabId),
      consoleLink: await this.takeConsoleLink(activeTabId)
    });
  }

  async click(target: ClickTarget, options: SessionClickOptions): Promise<void> {
    if (isBackendNodeTarget(target)) {
      throw new Error("Internal backendNodeId targets are only valid for file upload resolution.");
    }
    const tabId = await this.getActiveTabId();
    await this.bringTabToFront(tabId);
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    await evaluateCdp<boolean>(pageClient, ENSURE_BUBBLE_CURSOR_SOURCE, undefined, contextId).catch(() => false);
    const source = "nodeToken" in target ? ACTION_POINT_EVALUATE_SOURCE : ACTION_POINT_BY_SELECTOR_SOURCE;
    const arg = "nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector };
    const point = await evaluateCdp<{ ok: boolean; reason?: string; x?: number; y?: number }>(
      pageClient,
      source,
      arg,
      contextId
    );
    if (!point.ok || point.x === undefined || point.y === undefined) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        isSelector
          ? `Element "${target.selector}" could not be found or is not visible.`
          : 'The referenced element is no longer valid. Call "browser_snapshot" again.'
      );
    }

    const MODIFIER_BITS: Record<string, number> = {
      Alt: 1, Control: 2, ControlOrMeta: 2, Meta: 4, Shift: 8
    };
    const modifiersMask = (options.modifiers ?? []).reduce(
      (acc, m) => acc | (MODIFIER_BITS[m] ?? 0), 0
    );
    const cdpButton = (options.button ?? "left") as "left" | "middle" | "right";
    const clickCount = options.doubleClick ? 2 : 1;
    const cycles = options.doubleClick ? 2 : 1;

    await this.moveMouseAlongHumanPath(
      pageClient,
      { x: point.x, y: point.y },
      modifiersMask,
      "none",
      options.moveDelayMs
    );

    for (let i = 0; i < cycles; i++) {
      await pageClient.Input.dispatchMouseEvent({
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: cdpButton,
        clickCount,
        modifiers: modifiersMask
      });
      await delay(options.clickHoldMs);
      const releasePromise = pageClient.Input.dispatchMouseEvent({
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: cdpButton,
        clickCount,
        modifiers: modifiersMask
      });
      await Promise.race([
        releasePromise,
        this.waitForDialog(tabId, options.clickHoldMs + 1000)
      ]);
    }
  }

  async drag(start: ClickTarget, end: ClickTarget, options: SessionDragOptions): Promise<void> {
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    await evaluateCdp<boolean>(pageClient, ENSURE_BUBBLE_CURSOR_SOURCE, undefined, contextId).catch(() => false);
    const startPoint = await this.actionPoint(pageClient, contextId, start);
    const endPoint = await this.actionPoint(pageClient, contextId, end);
    await this.moveMouseAlongHumanPath(pageClient, startPoint, 0, "none", options.moveDelayMs);
    await delay(options.moveDelayMs);
    await pageClient.Input.dispatchMouseEvent({
      type: "mousePressed",
      x: startPoint.x,
      y: startPoint.y,
      button: "left",
      clickCount: 1
    });
    await delay(options.holdDelayMs);
    await this.moveMouseAlongHumanPath(pageClient, endPoint, 0, "left", options.moveDelayMs);
    await delay(options.moveDelayMs);
    await pageClient.Input.dispatchMouseEvent({
      type: "mouseReleased",
      x: endPoint.x,
      y: endPoint.y,
      button: "left",
      clickCount: 1
    });
  }

  async drop(target: ClickTarget, payload: SessionDropOptions): Promise<void> {
    const files = await prepareDropFiles(payload.paths);
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    const result = await evaluateCdp<{ ok: boolean; reason?: string }>(
      pageClient,
      DROP_ON_ELEMENT_SOURCE,
      { ...this.targetArg(target), data: payload.data ?? {}, files },
      contextId
    );
    if (!result.ok) {
      throw new McpToolError(
        result.reason === "not_accepted" ? "action_failed" : "invalid_target",
        result.reason === "not_accepted"
          ? "Drop target did not accept the drop; its dragover handler did not call preventDefault()."
          : "Drop target could not be found."
      );
    }
  }

  async hover(target: ClickTarget, options?: SessionHoverOptions): Promise<void> {
    if (isBackendNodeTarget(target)) {
      throw new Error("Internal backendNodeId targets are only valid for file upload resolution.");
    }
    const tabId = await this.getActiveTabId();
    await this.bringTabToFront(tabId);
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    await evaluateCdp<boolean>(pageClient, ENSURE_BUBBLE_CURSOR_SOURCE, undefined, contextId).catch(() => false);
    const source = "nodeToken" in target ? ACTION_POINT_EVALUATE_SOURCE : ACTION_POINT_BY_SELECTOR_SOURCE;
    const arg = "nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector };
    const point = await evaluateCdp<{ ok: boolean; reason?: string; x?: number; y?: number }>(
      pageClient,
      source,
      arg,
      contextId
    );
    if (!point.ok || point.x === undefined || point.y === undefined) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        isSelector
          ? `Element "${target.selector}" could not be found or is not visible.`
          : 'The referenced element is no longer valid. Call "browser_snapshot" again.'
      );
    }

    await this.moveMouseAlongHumanPath(pageClient, { x: point.x, y: point.y }, 0, "none", options?.moveDelayMs);
  }

  async focus(target: ClickTarget): Promise<void> {
    const tabId = await this.getActiveTabId();
    await this.bringTabToFront(tabId);
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    const result = await evaluateCdpRef(pageClient, FOCUS_AND_GET_ELEMENT_SOURCE, this.targetArg(target), contextId);
    if (!result.objectId) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        isSelector ? `Element "${target.selector}" could not be found.` : "The referenced element is no longer valid."
      );
    }
  }

  async clear(target: ClickTarget): Promise<void> {
    const tabId = await this.getActiveTabId();
    await this.bringTabToFront(tabId);
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    const result = await evaluateCdp<{ ok: boolean; reason?: string }>(
      pageClient,
      CLEAR_ELEMENT_SOURCE,
      this.targetArg(target),
      contextId
    );
    if (!result.ok) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : "The referenced element is no longer valid.")
          : "Element is not a typeable input."
      );
    }
  }

  private async moveMouseAlongHumanPath(
    pageClient: CdpClient,
    destination: { x: number; y: number },
    modifiers = 0,
    button: "none" | "left" | "middle" | "right" = "none",
    moveDelayMs = 140
  ): Promise<void> {
    if (!this.hasMouseEnteredViewport) {
      await this.seedMouseEntryPosition(pageClient, moveDelayMs, modifiers, button);
    }
    const points = humanMousePath(this.currentMousePosition, destination, moveDelayMs);
    for (const point of points) {
      await pageClient.Input.dispatchMouseEvent({
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button,
        modifiers
      });
      if (point.pauseMs > 0) {
        await delay(point.pauseMs);
      }
    }
    this.currentMousePosition = { x: destination.x, y: destination.y };
  }

  private async seedMouseEntryPosition(
    pageClient: CdpClient,
    moveDelayMs: number,
    modifiers: number,
    button: "none" | "left" | "middle" | "right"
  ): Promise<void> {
    const contextId = await this.getActiveUtilityContextId(pageClient);
    const viewport = await evaluateCdp<{ x: number; y: number; width: number; height: number }>(
      pageClient,
      VIEWPORT_BOX_SOURCE,
      undefined,
      contextId
    ).catch(() => ({ x: 0, y: 0, width: 1280, height: 720 }));
    const padding = Math.max(12, Math.round(Math.min(viewport.width, viewport.height) * 0.03));
    const horizontal = viewport.x + padding + Math.random() * Math.max(1, viewport.width - padding * 2);
    const vertical = viewport.y + padding + Math.random() * Math.max(1, viewport.height - padding * 2);
    const edge = Math.floor(Math.random() * 4);
    const entry =
      edge === 0 ? { x: horizontal, y: viewport.y + 1 } :
      edge === 1 ? { x: viewport.x + viewport.width - 1, y: vertical } :
      edge === 2 ? { x: horizontal, y: viewport.y + viewport.height - 1 } :
      { x: viewport.x + 1, y: vertical };

    this.currentMousePosition = entry;
    this.hasMouseEnteredViewport = true;
    await pageClient.Input.dispatchMouseEvent({
      type: "mouseMoved",
      x: entry.x,
      y: entry.y,
      button,
      modifiers
    });
    await delay(Math.max(60, Math.round(moveDelayMs * 0.8)));
  }

  async close(): Promise<void> {
    for (const [tabId, state] of this.pageNetworkStates) {
      settleOutstandingNetworkWaits(state);
      this.completionCollectorsByTabId.delete(tabId);
    }
    this.pageNetworkStates.clear();
    this.pageConsoleStates.clear();
    this.pageDialogStates.clear();
    await Promise.all(
      Array.from(this.pageClients.values()).map(async (client) => {
        await client.close().catch(() => {});
      })
    );
    this.pageClients.clear();
    await this.browserClient.close().catch(() => {});
  }

  async navigate(url: string): Promise<void> {
    const pageClient = await this.getActivePageClient();
    const tabId = await this.getActiveTabId();
    this.resetConsole(tabId);
    await pageClient.Page.navigate({ url });
    await waitForCdpDocumentReady(pageClient, 5_000);
  }

  async type(target: ClickTarget, text: string, options?: SessionTypeOptions): Promise<void> {
    const tabId = await this.getActiveTabId();
    await this.bringTabToFront(tabId);
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    const arg = this.targetArg(target);
    if (options?.slowly || options?.delayMs) {
      const refResult = await evaluateCdpRef(pageClient, FOCUS_AND_GET_ELEMENT_SOURCE, arg, contextId);
      if (!refResult.objectId) {
        const isSelector = "selector" in target;
        throw new McpToolError(
          isSelector ? "invalid_target" : "stale_ref",
          isSelector ? `Element "${target.selector}" could not be found.` : "The referenced element is no longer valid."
        );
      }
      const chars = [...text];
      // Humanized per-keystroke dwell: jitter each character around the base delay when a
      // variance is supplied (mirrors the library keyboardType path). Falls back to the flat
      // delay when no variance is set.
      const delays =
        options.varianceMs !== undefined && options.varianceMs > 0
          ? buildTypingDelays(text, { delayMs: options.delayMs ?? 0, varianceMs: options.varianceMs }, defaultRng)
          : undefined;
      for (let index = 0; index < chars.length; index += 1) {
        await pageClient.Input.insertText({ text: chars[index]! });
        const charDelay = delays ? delays[index] : options.delayMs;
        if (charDelay) {
          await delay(charDelay);
        }
      }
      if (options.submit) {
        await this.pressKey("Enter");
      }
      return;
    }
    const result = await evaluateCdp<{ ok: boolean; reason?: string }>(
      pageClient,
      TYPE_INTO_ELEMENT_SOURCE,
      { ...arg, text, submit: options?.submit ?? false },
      contextId
    );
    if (!result.ok) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : 'The referenced element is no longer valid. Call "browser_snapshot" again.')
          : `Element is not a typeable input.`
      );
    }
  }

  async pressKey(
    key: string,
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">
  ): Promise<void> {
    const tabId = await this.getActiveTabId();
    await this.bringTabToFront(tabId);
    const pageClient = await this.getActivePageClient();
    const shortcut = [...(modifiers ?? []).map((modifier) => resolveSmartModifierString(modifier)), key].join("+");
    const tokens = splitKeyboardShortcut(shortcut);
    const keyName = tokens[tokens.length - 1] ?? "";
    for (let index = 0; index < tokens.length - 1; index += 1) {
      await this.keyboardDown(pageClient, tokens[index] ?? "");
    }
    try {
      if (isUsKeyboardLayoutKey(keyName) || keyDescriptionForString(keyName, this.pressedKeyboardModifiers)) {
        await this.keyboardDown(pageClient, keyName);
        await this.keyboardUp(pageClient, keyName);
      } else {
        await pageClient.Input.insertText({ text: keyName });
      }
    } catch {
      if (tokens.length === 1) {
        await pageClient.Input.insertText({ text: keyName });
      } else {
        throw new Error(`Unknown key: "${keyName}"`);
      }
    } finally {
      for (let index = tokens.length - 2; index >= 0; index -= 1) {
        await this.keyboardUp(pageClient, tokens[index] ?? "");
      }
    }
  }

  private async keyboardDown(pageClient: CdpClient, key: string): Promise<void> {
    const keyDefinition = keyDescriptionForString(key, this.pressedKeyboardModifiers);
    const autoRepeat = this.pressedKeyboardCodes.has(keyDefinition.code);
    const nextModifiers = new Set(this.pressedKeyboardModifiers);
    if (isKeyboardModifier(keyDefinition.key)) {
      nextModifiers.add(keyDefinition.key);
    }
    this.pressedKeyboardCodes.add(keyDefinition.code);
    await pageClient.Input.dispatchKeyEvent({
      type: keyDefinition.text ? "keyDown" : "rawKeyDown",
      key: keyDefinition.key,
      code: keyDefinition.code,
      text: keyDefinition.text,
      unmodifiedText: keyDefinition.text,
      autoRepeat,
      windowsVirtualKeyCode: keyDefinition.keyCodeWithoutLocation,
      nativeVirtualKeyCode: keyDefinition.keyCode,
      modifiers: keyboardModifierMask(nextModifiers),
      location: keyDefinition.location,
      isKeypad: keyDefinition.location === keypadLocation
    });
    this.pressedKeyboardModifiers.clear();
    for (const modifier of nextModifiers) {
      this.pressedKeyboardModifiers.add(modifier);
    }
  }

  private async keyboardUp(pageClient: CdpClient, key: string): Promise<void> {
    const keyDefinition = keyDescriptionForString(key, this.pressedKeyboardModifiers);
    const nextModifiers = new Set(this.pressedKeyboardModifiers);
    if (isKeyboardModifier(keyDefinition.key)) {
      nextModifiers.delete(keyDefinition.key);
    }
    this.pressedKeyboardCodes.delete(keyDefinition.code);
    await pageClient.Input.dispatchKeyEvent({
      type: "keyUp",
      key: keyDefinition.key,
      code: keyDefinition.code,
      windowsVirtualKeyCode: keyDefinition.keyCodeWithoutLocation,
      nativeVirtualKeyCode: keyDefinition.keyCode,
      modifiers: keyboardModifierMask(nextModifiers),
      location: keyDefinition.location
    });
    this.pressedKeyboardModifiers.clear();
    for (const modifier of nextModifiers) {
      this.pressedKeyboardModifiers.add(modifier);
    }
  }

  private async bringTabToFront(tabId: string): Promise<void> {
    await this.browserClient.Target.activateTarget({
      targetId: tabId
    }).catch(() => {});
  }

  async selectOption(target: ClickTarget, values: string[]): Promise<string[]> {
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    const arg = this.targetArg(target);
    const result = await evaluateCdp<{ ok: boolean; reason?: string; selected: string[] }>(
      pageClient,
      SELECT_OPTION_SOURCE,
      { ...arg, values },
      contextId
    );
    if (!result.ok) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : 'The referenced element is no longer valid.')
          : `Element is not a <select> element.`
      );
    }
    return result.selected;
  }

  async check(target: ClickTarget, checked: boolean): Promise<void> {
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    const arg = this.targetArg(target);
    const result = await evaluateCdp<{ ok: boolean; reason?: string }>(
      pageClient,
      CHECK_ELEMENT_SOURCE,
      { ...arg, checked },
      contextId
    );
    if (!result.ok) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : 'The referenced element is no longer valid.')
          : `Element is not a checkbox or radio button.`
      );
    }
  }

  async goBack(): Promise<void> {
    const pageClient = await this.getActivePageClient();
    await this.navigateHistory(pageClient, -1).catch(() => {});
  }

  async goForward(): Promise<void> {
    const pageClient = await this.getActivePageClient();
    await this.navigateHistory(pageClient, 1).catch(() => {});
  }

  private async navigateHistory(pageClient: CdpClient, delta: -1 | 1): Promise<void> {
    const history = await pageClient.Page.getNavigationHistory();
    const nextEntry = history.entries[history.currentIndex + delta];
    if (!nextEntry) {
      return;
    }
    await pageClient.Page.navigateToHistoryEntry({ entryId: nextEntry.id });
  }

  async resize(width: number, height: number): Promise<void> {
    const pageClient = await this.getActivePageClient();
    await pageClient.Emulation?.setDeviceMetricsOverride({
      mobile: false,
      width,
      height,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: 1
    });
  }

  async scroll(
    target: ClickTarget | null,
    deltaX: number,
    deltaY: number,
    options?: SessionScrollOptions
  ): Promise<void> {
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    const arg = target ? this.targetArg(target) : {};
    await evaluateCdp<boolean>(pageClient, ENSURE_BUBBLE_CURSOR_SOURCE, undefined, contextId).catch(() => false);
    const chunks = await splitScrollDeltas(deltaX, deltaY, options?.stepPx ?? Math.max(Math.abs(deltaX), Math.abs(deltaY), 1));
    for (const [index, chunk] of chunks.entries()) {
      await evaluateCdp<{ ok: boolean }>(
        pageClient,
        SCROLL_ELEMENT_SOURCE,
        { ...arg, deltaX: chunk.deltaX, deltaY: chunk.deltaY },
        contextId
      );
      const reverseChunk = maybeReverseScrollChunk(chunk, index, chunks.length);
      if (reverseChunk) {
        await delay(60 + Math.round(Math.random() * 120));
        await evaluateCdp<{ ok: boolean }>(
          pageClient,
          SCROLL_ELEMENT_SOURCE,
          { ...arg, deltaX: reverseChunk.deltaX, deltaY: reverseChunk.deltaY },
          contextId
        );
      }
      if (shouldPauseToObserve(index, chunks.length)) {
        await delay(220 + Math.round(Math.random() * 520));
      }
      if ((options?.stepDelayMs ?? 0) > 0) {
        await delay(options!.stepDelayMs);
      }
    }
  }

  async screenshot(options: SessionScreenshotOptions = {}): Promise<{ data: string; mimeType: "image/png" | "image/jpeg" }> {
    const pageClient = await this.getActivePageClient();
    const format = options.type ?? "png";
    const screenshotOptions: {
      format: "jpeg" | "png";
      clip?: { x: number; y: number; width: number; height: number; scale: number };
    } = { format };
    if (options.target) {
      const refResult = await evaluateCdpRef(pageClient, GET_ELEMENT_OBJECT_SOURCE, this.targetArg(options.target), await this.getActiveUtilityContextId(pageClient));
      if (!refResult.objectId) {
        throw new McpToolError("invalid_target", "Screenshot target could not be found.");
      }
      const model = await pageClient.DOM.getBoxModel({ objectId: refResult.objectId });
      const border = model.model.border;
      const xs = [border[0], border[2], border[4], border[6]].filter((value): value is number => value !== undefined);
      const ys = [border[1], border[3], border[5], border[7]].filter((value): value is number => value !== undefined);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      screenshotOptions.clip = {
        x,
        y,
        width: Math.max(1, Math.max(...xs) - x),
        height: Math.max(1, Math.max(...ys) - y),
        scale: 1
      };
    } else if (options.fullPage) {
      const metrics = await pageClient.send("Page.getLayoutMetrics") as {
        cssContentSize?: { x: number; y: number; width: number; height: number };
        contentSize?: { x: number; y: number; width: number; height: number };
      };
      const contentSize = metrics.cssContentSize ?? metrics.contentSize;
      if (contentSize) {
        screenshotOptions.clip = {
          x: contentSize.x,
          y: contentSize.y,
          width: contentSize.width,
          height: contentSize.height,
          scale: 1
        };
      }
    }
    const result = await pageClient.Page.captureScreenshot(screenshotOptions);
    return { data: result.data, mimeType: format === "png" ? "image/png" : "image/jpeg" };
  }

  async uploadFile(target: ClickTarget, filePaths: string[]): Promise<void> {
    const pageClient = await this.getActivePageClient();
    const resolvedLocalPaths = await resolveLocalInputFilePaths(filePaths);
    if (isBackendNodeTarget(target)) {
      const resolved = await pageClient.DOM.resolveNode({ backendNodeId: target.backendNodeId }).catch(() => undefined);
      const objectId = resolved?.object?.objectId;
      if (!objectId) {
        throw new McpToolError("stale_ref", "The referenced element is no longer valid.");
      }
      await setNativeInputFilePathsByObjectId(pageClient, objectId, resolvedLocalPaths);
      return;
    }
    const contextId = await this.getActiveUtilityContextId(pageClient);
    const arg = this.targetArg(target);
    const refResult = await evaluateCdpRef(pageClient, GET_ELEMENT_OBJECT_SOURCE, arg, contextId);
    if (!refResult.objectId) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        isSelector ? `Element "${target.selector}" could not be found.` : 'The referenced element is no longer valid.'
      );
    }
    await setNativeInputFilePathsByObjectId(pageClient, refResult.objectId, resolvedLocalPaths);
  }

  async finishFileUpload(_target: ClickTarget): Promise<void> {
    const tabId = await this.getActiveTabId().catch(() => undefined);
    if (!tabId || !this.fileChooserInterceptEnabledByTabId.has(tabId)) {
      return;
    }
    const pageClient = await this.getActivePageClient().catch(() => undefined);
    await pageClient?.Page.setInterceptFileChooserDialog?.({ enabled: false }).catch(() => {});
    this.fileChooserInterceptEnabledByTabId.delete(tabId);
    this.pendingFileChooserTargetByTabId.delete(tabId);
  }

  async formFieldMetadata(target: ClickTarget): Promise<{ tagName: string; inputType?: string; isContentEditable?: boolean }> {
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    const result = await evaluateCdp<{
      ok: boolean;
      reason?: string;
      tagName?: string;
      inputType?: string;
      isContentEditable?: boolean;
    }>(
      pageClient,
      FORM_FIELD_METADATA_SOURCE,
      this.targetArg(target),
      contextId
    );
    if (!result.ok || !result.tagName) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : "The referenced element is no longer valid.")
          : `Unable to inspect form field: ${result.reason ?? "unknown error"}.`
      );
    }
    return {
      tagName: result.tagName,
      ...(result.inputType !== undefined ? { inputType: result.inputType } : {}),
      ...(result.isContentEditable !== undefined ? { isContentEditable: result.isContentEditable } : {})
    };
  }

  async fillForm(fields: SessionFormField[]): Promise<void> {
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    for (const field of fields) {
      const result = await evaluateCdp<{ ok: boolean; reason?: string }>(
        pageClient,
        SET_FORM_FIELD_SOURCE,
        {
          ...this.targetArg(field.target),
          fieldType: field.type,
          value: field.value
        },
        contextId
      );
      if (!result.ok) {
        throw new McpToolError("invalid_target", `Unable to fill form field: ${result.reason ?? "unknown error"}.`);
      }
    }
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    const tabId = this.dialogTabId();
    if (!this.pageDialogStates.has(tabId)) {
      throw new McpToolError("no_dialog", "No dialog visible.");
    }
    const pageClient = this.pageClients.get(tabId) ?? await this.getActivePageClient();
    this.pageDialogStates.delete(tabId);
    await pageClient.Page.handleJavaScriptDialog({
      accept,
      ...(promptText !== undefined ? { promptText } : {})
    });
  }

  async hasDialog(): Promise<boolean> {
    return this.pageDialogStates.size > 0;
  }

  private waitForDialog(tabId: string, timeoutMs: number): Promise<void> {
    if (this.pageDialogStates.has(tabId)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiter: DialogWaiter = {
        resolve: () => {
          if (waiter.timer) {
            clearTimeout(waiter.timer);
          }
          this.removeDialogWaiter(tabId, waiter);
          resolve();
        }
      };
      waiter.timer = setTimeout(() => waiter.resolve(), timeoutMs);
      const waiters = this.dialogWaiters.get(tabId) ?? new Set<DialogWaiter>();
      waiters.add(waiter);
      this.dialogWaiters.set(tabId, waiters);
    });
  }

  private resolveDialogWaiters(tabId: string): void {
    const waiters = this.dialogWaiters.get(tabId);
    if (!waiters) {
      return;
    }
    this.dialogWaiters.delete(tabId);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private removeDialogWaiter(tabId: string, waiter: DialogWaiter): void {
    const waiters = this.dialogWaiters.get(tabId);
    if (!waiters) {
      return;
    }
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.dialogWaiters.delete(tabId);
    }
  }

  async networkRequests(): Promise<BrowserNetworkRequest[]> {
    const tabId = await this.getActiveTabId();
    await this.hydratePerformanceResourceRequests(tabId);
    return this.ensureNetworkState(tabId).requests.map(cloneNetworkRequest);
  }

  async beginRequestCollection(): Promise<unknown> {
    const tabId = await this.getActiveTabId();
    const collector: CompletionRequestCollector = { requests: [], requestKeys: [], liveRequests: [] };
    const collectors = this.completionCollectorsByTabId.get(tabId) ?? new Set<CompletionRequestCollector>();
    collectors.add(collector);
    this.completionCollectorsByTabId.set(tabId, collectors);
    return { tabId, collector };
  }

  async endRequestCollection(state?: unknown): Promise<BrowserNetworkRequest[]> {
    const completionState = state as { tabId?: string; collector?: CompletionRequestCollector } | undefined;
    const tabId = completionState?.tabId ?? await this.getActiveTabId();
    const collector = completionState?.collector;
    if (!collector) {
      return [];
    }
    const collectors = this.completionCollectorsByTabId.get(tabId);
    collectors?.delete(collector);
    if (collectors && collectors.size === 0) {
      this.completionCollectorsByTabId.delete(tabId);
    }
    const stateForTab = this.ensureNetworkState(tabId);
    const requestsFromLiveObjects = Array.from(new Set(collector.liveRequests)).map(({ request }) => cloneNetworkRequest(request));
    const uniqueKeys = Array.from(new Set(collector.requestKeys));
    const requests = requestsFromLiveObjects.length
      ? requestsFromLiveObjects
      : uniqueKeys
          .map((requestKey) => stateForTab.byRequestKey.get(requestKey))
          .filter((request): request is BrowserNetworkRequest => !!request)
          .map(cloneNetworkRequest);
    return requests.length ? requests : collector.requests.map(cloneNetworkRequest);
  }

  async networkRequest(index: number): Promise<BrowserNetworkRequest | undefined> {
    const tabId = await this.getActiveTabId();
    await this.hydratePerformanceResourceRequests(tabId);
    const request = this.ensureNetworkState(tabId).requests[index - 1];
    return request ? cloneNetworkRequest(request) : undefined;
  }

  async fetchResponseBody(index: number): Promise<string | undefined> {
    const tabId = await this.getActiveTabId();
    const state = this.ensureNetworkState(tabId);
    const request = state.requests[index - 1];
    if (!request || !request.requestId) {
      return request?.responseBody;
    }
    if (!canReadResponseBody(request)) {
      return undefined;
    }
    if (hasTrackedResponseBody(request)) {
      return request.responseBody;
    }
    const waitKey = requestWaitKey(request);
    await waitForLoadingDone(state, waitKey, 5_000).catch(() => undefined);
    if (hasTrackedResponseBody(request)) {
      return request.responseBody;
    }
    if (state.bodyRead.has(waitKey)) {
      return undefined;
    }
    state.bodyRead.add(waitKey);
    const pageClient = this.pageClients.get(tabId) ?? await this.getActivePageClient();
    const clientNetwork = pageClient.Network;
    if (!clientNetwork) {
      return undefined;
    }
    const body = await clientNetwork.getResponseBody({ requestId: request.requestId }).catch(() => undefined);
    if (body) {
      setTrackedResponseBody(
        request,
        body.base64Encoded
          ? Buffer.from(body.body, "base64").toString("utf8")
          : body.body
      );
    }
    return request.responseBody;
  }

  async waitForPageTimeout(timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) {
      return;
    }
    const pageClient = await this.getActivePageClient().catch(() => undefined);
    if (!pageClient) {
      await delay(timeoutMs);
      return;
    }
    const contextId = await this.getActiveUtilityContextId(pageClient).catch(() => undefined);
    if (contextId === undefined) {
      await delay(timeoutMs);
      return;
    }
    await evaluateCdp(
      pageClient,
      String.raw`(ms) => new Promise((resolve) => setTimeout(resolve, ms))`,
      timeoutMs,
      contextId
    ).catch(async () => {
      await delay(timeoutMs);
    });
  }

  async waitForMainFrameLoad(timeoutMs: number): Promise<void> {
    const tabId = await this.getActiveTabId();
    const pageClient = this.pageClients.get(tabId) ?? await this.getActivePageClient();
    const { frameTree } = await pageClient.Page.getFrameTree().catch(() => ({ frameTree: { frame: { id: "" } } }));
    const mainFrameId = frameTree.frame.id;
    const readyState = await evaluateCdp<string>(
      pageClient,
      String.raw`() => document.readyState`,
      undefined,
      await this.getActiveUtilityContextId(pageClient)
    ).catch(() => "loading");
    if (readyState === "complete") {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      pageClient.Page.loadEventFired?.(() => finish());
      pageClient.Page.frameStoppedLoading?.((event) => {
        if (event.frameId === mainFrameId) {
          finish();
        }
      });
    });
  }

  async waitForRequestFinished(requestId: string, timeoutMs: number): Promise<void> {
    const tabId = await this.getActiveTabId();
    const state = this.ensureNetworkState(tabId);
    await waitForRequestFinishedSignal(state, requestId, timeoutMs).catch(() => undefined);
  }

  async waitForRequestResponse(requestId: string, timeoutMs: number): Promise<void> {
    const tabId = await this.getActiveTabId();
    const state = this.ensureNetworkState(tabId);
    await waitForResponseAvailable(state, requestId, timeoutMs).catch(() => undefined);
  }

  async runCodeUnsafe(code: string): Promise<unknown> {
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    return evaluateCdp<unknown>(
      pageClient,
      String.raw`async (payload) => {
        const fn = eval('(' + payload.code + ')');
        if (typeof fn !== 'function') throw new Error('Code must evaluate to a function.');
        const page = {
          evaluate: async (expression, arg) => {
            const value = typeof expression === 'function' ? expression : eval('(' + expression + ')');
            return typeof value === 'function' ? await value(arg) : value;
          },
          title: () => document.title,
          url: () => location.href,
          goto: (url) => { location.href = url; },
          locator: (selector) => ({
            click: () => document.querySelector(selector)?.click(),
            fill: (value) => {
              const el = document.querySelector(selector);
              if (!el) throw new Error('Element not found: ' + selector);
              el.value = value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            },
            textContent: () => document.querySelector(selector)?.textContent ?? null
          })
        };
        return await fn(page);
      }`,
      { code },
      contextId
    );
  }

  private targetArg(target: ClickTarget): { nodeToken?: string; selector?: string } {
    if (isBackendNodeTarget(target)) {
      throw new Error("Internal backendNodeId targets cannot be converted into snapshot selector arguments.");
    }
    return "nodeToken" in target
      ? { nodeToken: target.nodeToken }
      : { selector: target.selector };
  }

  private async actionPoint(client: CdpClient, contextId: number, target: ClickTarget): Promise<{ x: number; y: number }> {
    const source = "nodeToken" in target ? ACTION_POINT_EVALUATE_SOURCE : ACTION_POINT_BY_SELECTOR_SOURCE;
    const point = await evaluateCdp<{ ok: boolean; reason?: string; x?: number; y?: number }>(
      client,
      source,
      this.targetArg(target),
      contextId
    );
    if (!point.ok || point.x === undefined || point.y === undefined) {
      throw new McpToolError("invalid_target", "Element could not be found or is not visible.");
    }
    return { x: point.x, y: point.y };
  }

  private async refreshTabs(): Promise<BrowserTab[]> {
    const response = await this.browserClient.Target.getTargets();
    const tabs = response.targetInfos
      .filter((targetInfo) => {
        return targetInfo.type === "page" && !targetInfo.url.startsWith("devtools://");
      })
      .map((targetInfo) => ({
        id: targetInfo.targetId,
        title: targetInfo.title,
        url: targetInfo.url
      }));

    if (!this.activeTabId) {
      this.activeTabId = chooseInitialTab(tabs);
    }

    return tabs.map((tab) => ({
      ...tab,
      active: tab.id === this.activeTabId
    }));
  }

  private async getActiveTabId(): Promise<string> {
    const tabs = await this.refreshTabs();
    const activeTab = tabs.find((tab) => tab.active);
    if (!activeTab) {
      throw new McpToolError("no_active_tab", "No active tab is available.");
    }
    return activeTab.id;
  }

  private dialogTabId(): string {
    if (this.activeTabId && this.pageDialogStates.has(this.activeTabId)) {
      return this.activeTabId;
    }
    const tabId = this.pageDialogStates.keys().next().value as string | undefined;
    if (!tabId) {
      throw new McpToolError("no_dialog", "No dialog visible.");
    }
    return tabId;
  }

  private async getActivePageClient(): Promise<CdpClient> {
    const tabs = await this.refreshTabs();
    const activeTab = tabs.find((tab) => tab.active);
    if (!activeTab) {
      throw new McpToolError("no_active_tab", "No active tab is available.");
    }

    const existing = this.pageClients.get(activeTab.id);
    if (existing) {
      return existing;
    }

    const client = await chromeRemoteInterface({
      host: this.connection.host,
      port: this.connection.port,
      target: activeTab.id
    });
    this.installConsoleCollection(activeTab.id, client);
    this.installFileChooserCollection(activeTab.id, client);
    await Promise.all([
      client.Page.enable(),
      client.Runtime.enable(),
      client.DOM.enable({}),
      client.Network?.enable({}).catch(() => undefined),
      client.Log?.enable().catch(() => undefined)
    ]);
    this.pageClients.set(activeTab.id, client);
    return client;
  }

  private installFileChooserCollection(tabId: string, client: CdpClient): void {
    client.Page.fileChooserOpened?.((event: {
      backendNodeId?: number;
      frameId: string;
      mode: "selectSingle" | "selectMultiple";
    }) => {
      this.fileChooserDebug.chooserEvents += 1;
      if (!event.backendNodeId || !this.fileChooserInterceptEnabledByTabId.has(tabId)) {
        return;
      }
      void this.captureFileChooserTarget(tabId, client, event.backendNodeId);
    });
  }

  private async captureFileChooserTarget(tabId: string, client: CdpClient, backendNodeId: number): Promise<void> {
    try {
      this.fileChooserDebug.capturedTargets += 1;
      this.pendingFileChooserTargetByTabId.set(tabId, { backendNodeId });
    } catch {
      // Ignore chooser capture failures and let runtime fall back to legacy behavior.
    }
  }

  private async getActiveUtilityContextId(client: CdpClient): Promise<number> {
    const { frameTree } = await client.Page.getFrameTree();
    const response = await client.Page.createIsolatedWorld({
      frameId: frameTree.frame.id,
      worldName: "__roxy_playwright_utility_world__",
      grantUniversalAccess: true
    });
    return response.executionContextId;
  }

  private installConsoleCollection(tabId: string, client: CdpClient): void {
    this.ensureConsoleState(tabId);
    client.Runtime.consoleAPICalled((event) => {
      if (event.executionContextId === 0) {
        return;
      }
      const frame = event.stackTrace?.callFrames?.[0];
      const text = formatConsoleText(event.args);
      const locationUrl = frame?.url ?? "";
      const lineNumber = frame?.lineNumber ?? 0;
      this.addConsoleMessage(tabId, {
        type: event.type,
        timestamp: normalizeConsoleTimestamp(event.timestamp),
        text,
        locationUrl,
        lineNumber,
        formattedText: formatConsoleMessage(event.type, text, locationUrl, lineNumber)
      });
    });
    client.Runtime.exceptionThrown((event) => {
      const details = event.exceptionDetails;
      const text = details?.exception?.description
        || (details?.exception?.value !== undefined ? String(details.exception.value) : undefined)
        || details?.text
        || "Uncaught exception";
      this.addConsoleMessage(tabId, {
        type: "error",
        timestamp: Date.now(),
        text,
        locationUrl: details?.url ?? "",
        lineNumber: details?.lineNumber ?? 0,
        formattedText: text
      });
    });
    client.Log?.entryAdded((event) => {
      const entry = event.entry;
      if (entry.source === "worker") {
        return;
      }
      const type = entry.level ?? "log";
      const text = entry.text ?? "";
      const locationUrl = entry.url ?? "";
      const lineNumber = entry.lineNumber ?? 0;
      this.addConsoleMessage(tabId, {
        type,
        timestamp: normalizeConsoleTimestamp(entry.timestamp),
        text,
        locationUrl,
        lineNumber,
        formattedText: formatConsoleMessage(type, text, locationUrl, lineNumber)
      });
    });
    client.Page.javascriptDialogOpening((event) => {
      this.pageDialogStates.set(tabId, {
        message: event.message,
        type: event.type,
        ...(event.defaultPrompt !== undefined ? { defaultPrompt: event.defaultPrompt } : {}),
        ...(event.url !== undefined ? { url: event.url } : {})
      });
      this.resolveDialogWaiters(tabId);
    });
    this.installNetworkCollection(tabId, client);
  }

  private installNetworkCollection(tabId: string, client: CdpClient): void {
    if (!client.Network) {
      return;
    }
    const state = this.ensureNetworkState(tabId);
    client.Network.requestServedFromCache?.((event) => {
      state.servedFromCacheRequestIds.add(event.requestId);
    });
    client.Network.requestWillBeSentExtraInfo?.((event) => {
      const queued = state.requestExtraInfoHeaders.get(event.requestId) ?? [];
      queued.push(normalizeHeaders(event.headers ?? {}));
      state.requestExtraInfoHeaders.set(event.requestId, queued);
      if (state.servedFromCacheRequestIds.has(event.requestId)) {
        return;
      }
      const request = firstRequestMissingRawRequestHeaders(state, event.requestId);
      if (request && request.rawRequestHeaders === undefined) {
        const next = queued.shift();
        if (queued.length === 0) {
          state.requestExtraInfoHeaders.delete(event.requestId);
        }
        if (next) {
          setTrackedRawRequestHeaders(request, next);
        }
      }
    });
    client.Network.responseReceivedExtraInfo?.((event) => {
      const queued = state.responseExtraInfoHeaders.get(event.requestId) ?? [];
      queued.push({
        headers: parseCdpHeadersText(event.headersText) ?? normalizeHeaders(event.headers ?? {}),
        ...(event.headersText !== undefined ? { headersSize: event.headersText.length } : {})
      });
      state.responseExtraInfoHeaders.set(event.requestId, queued);
      if (state.servedFromCacheRequestIds.has(event.requestId)) {
        return;
      }
      const request = firstRequestMissingRawResponseHeaders(state, event.requestId);
      if (request && request.rawResponseHeaders === request.responseHeaders) {
        const next = queued.shift();
        if (queued.length === 0) {
          state.responseExtraInfoHeaders.delete(event.requestId);
        }
        if (next) {
          setTrackedRawResponseMetadata(request, next.headers, next.headersSize);
          if (event.statusCode !== undefined) {
            setTrackedResponseStatus(request, event.statusCode);
          }
        }
      }
    });
    client.Network.requestWillBeSent((event) => {
      const existing = state.byRequestId.get(event.requestId);
      const isRedirectHop = !!existing && !existing.__response?.finishedSettled;
      if (existing && event.redirectResponse) {
        applyResponseMetadataToRequest(state, existing, event.redirectResponse, event.redirectHasExtraInfo);
        const startedAt = state.startedAt.get(event.requestId);
        if (startedAt !== undefined && event.timestamp !== undefined) {
          existing.durationMs = Math.round(event.timestamp * 1000 - startedAt);
        }
      }
      if (isRedirectHop) {
        resolveRequestFinished(state, requestWaitKey(existing));
        resolveLoadingDone(state, requestWaitKey(existing), true);
      }
      const sequence = (state.requestSequenceByRequestId.get(event.requestId) ?? 0) + 1;
      state.requestSequenceByRequestId.set(event.requestId, sequence);
      const request: TrackedBrowserNetworkRequest = !isRedirectHop && existing ? existing : {
        index: state.requests.length + 1,
        requestId: event.requestId,
        requestKey: `${event.requestId}#${sequence}`,
        method: event.request.method,
        url: event.request.url,
        resourceType: normalizeResourceType(event.type),
        isNavigationRequest: isCdpNavigationRequest(event),
        requestHeaders: {},
      };
      request.requestKey ??= `${event.requestId}#${sequence}`;
      request.method = event.request.method;
      request.url = event.request.url;
      request.resourceType = normalizeResourceType(event.type);
      request.isNavigationRequest = isCdpNavigationRequest(event);
      request.requestHeaders = normalizeHeaders(event.request.headers ?? {});
      if (request.rawRequestHeaders === undefined && !state.servedFromCacheRequestIds.has(event.requestId)) {
        const queuedRequestHeaders = state.requestExtraInfoHeaders.get(event.requestId);
        const nextRequestHeaders = queuedRequestHeaders?.shift();
        if (queuedRequestHeaders && queuedRequestHeaders.length === 0) {
          state.requestExtraInfoHeaders.delete(event.requestId);
        }
        if (nextRequestHeaders) {
          setTrackedRawRequestHeaders(request, nextRequestHeaders);
        }
      }
      if (event.request.postData !== undefined) {
        request.requestBody = event.request.postData;
      }
      if (!existing || isRedirectHop) {
        state.requests.push(request);
        state.byRequestId.set(event.requestId, request);
        state.byRequestKey.set(requestWaitKey(request), request);
        const requestsForId = state.requestsByRequestId.get(event.requestId) ?? [];
        requestsForId.push(request);
        state.requestsByRequestId.set(event.requestId, requestsForId);
        if (isRedirectHop && existing) {
          updateRedirectChain(state, existing, request);
        } else {
          request.finalRequestKey ??= requestWaitKey(request);
        }
      }
      const collectors = this.completionCollectorsByTabId.get(tabId);
      if (collectors?.size) {
        for (const collector of collectors) {
          collector.requestKeys.push(requestWaitKey(request));
          collector.liveRequests.push(ensureTrackedRequestObject(request));
        }
      }
      if (event.timestamp !== undefined) {
        state.startedAt.set(event.requestId, event.timestamp * 1000);
      }
    });
    client.Network.responseReceived((event) => {
      const request = state.byRequestId.get(event.requestId);
      if (!request) {
        return;
      }
      request.resourceType = normalizeResourceType(event.type) || request.resourceType;
      applyResponseMetadataToRequest(state, request, event.response, event.hasExtraInfo);
    });
    client.Network.loadingFinished(async (event) => {
      const request = state.byRequestId.get(event.requestId);
      if (!request) {
        resolveRequestFinished(state, event.requestId);
        resolveLoadingDone(state, event.requestId, true);
        return;
      }
      const startedAt = state.startedAt.get(event.requestId);
      if (startedAt !== undefined && event.timestamp !== undefined) {
        request.durationMs = Math.round(event.timestamp * 1000 - startedAt);
      }
      const waitKey = requestWaitKey(request);
      if (!isTrackedResponseAvailable(request) && !hasTrackedFailure(request)) {
        resolveLoadingDone(state, waitKey, false);
        return;
      }
      if (canReadResponseBody(request) && !state.bodyRead.has(waitKey)) {
        state.bodyRead.add(waitKey);
        const clientNetwork = client.Network;
        const getResponseBody = clientNetwork?.getResponseBody?.bind(clientNetwork);
        const body = getResponseBody
          ? await getResponseBody({ requestId: event.requestId }).catch(() => undefined)
          : undefined;
        if (body) {
          setTrackedResponseBody(
            request,
            body.base64Encoded
              ? Buffer.from(body.body, "base64").toString("utf8")
              : body.body
          );
        }
      }
      resolveRequestFinished(state, waitKey);
      resolveLoadingDone(state, waitKey, true);
    });
    client.Network.loadingFailed((event) => {
      const request = state.byRequestId.get(event.requestId);
      if (!request) {
        resolveResponseAvailable(state, event.requestId);
        resolveRequestFinished(state, event.requestId);
        resolveLoadingDone(state, event.requestId, false);
        return;
      }
      setTrackedFailureText(request, event.errorText ?? "Unknown error");
      if (!isTrackedResponseAvailable(request) && isTrackedRawRequestHeadersMissing(request)) {
        setTrackedRawRequestHeaders(request, request.requestHeaders);
      }
      const startedAt = state.startedAt.get(event.requestId);
      if (startedAt !== undefined && event.timestamp !== undefined) {
        request.durationMs = Math.round(event.timestamp * 1000 - startedAt);
      }
      const waitKey = requestWaitKey(request);
      resolveResponseAvailable(state, waitKey);
      resolveRequestFinished(state, waitKey);
      resolveLoadingDone(state, waitKey, false);
    });
  }

  private ensureConsoleState(tabId: string): BrowserConsoleState {
    let state = this.pageConsoleStates.get(tabId);
    if (!state) {
      state = {
        messages: [],
        nextMessageIndex: 0,
        logStartTime: Date.now(),
        logLine: 0
      };
      this.pageConsoleStates.set(tabId, state);
    }
    return state;
  }

  private ensureNetworkState(tabId: string): BrowserNetworkState {
    let state = this.pageNetworkStates.get(tabId);
    if (!state) {
      state = createBrowserNetworkState();
      this.pageNetworkStates.set(tabId, state);
    }
    return state;
  }

  private resetConsole(tabId: string): void {
    const previousNetworkState = this.pageNetworkStates.get(tabId);
    if (previousNetworkState) {
      settleOutstandingNetworkWaits(previousNetworkState);
    }
    this.pageConsoleStates.set(tabId, {
      messages: [],
      nextMessageIndex: 0,
      logStartTime: Date.now(),
      logLine: 0
    });
    this.pageNetworkStates.set(tabId, createBrowserNetworkState());
    this.pageDialogStates.delete(tabId);
  }

  private async hydratePerformanceResourceRequests(tabId: string): Promise<void> {
    const state = this.ensureNetworkState(tabId);
    if (state.hydratedPerformanceResources) {
      return;
    }
    state.hydratedPerformanceResources = true;

    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    const documentRequest = await evaluateCdp<{
      url: string;
      duration?: number;
    }>(
      pageClient,
      String.raw`() => {
        const navigation = performance.getEntriesByType("navigation")[0];
        return {
          url: String(location.href || ""),
          duration: navigation ? Math.round(Number(navigation.duration || 0)) : undefined
        };
      }`,
      undefined,
      contextId
    ).catch(() => undefined);
    if (documentRequest?.url && !Array.from(state.byRequestId.values()).some((request) => request.url === documentRequest.url)) {
      const requestId = `performance:navigation:${documentRequest.url}`;
      const request: BrowserNetworkRequest = {
        index: state.requests.length + 1,
        requestId,
        requestKey: requestId,
        method: "GET",
        url: documentRequest.url,
        resourceType: "document",
        requestHeaders: {},
        status: 200,
        statusText: "OK",
        ...(documentRequest.duration !== undefined ? { durationMs: documentRequest.duration } : {})
      };
      state.requests.push(request);
      state.byRequestId.set(requestId, request);
      state.byRequestKey.set(requestId, request);
      state.requestsByRequestId.set(requestId, [request]);
    }

    const resources = await evaluateCdp<Array<{
      name: string;
      initiatorType: string;
      duration?: number;
      responseStatus?: number;
    }>>(
      pageClient,
      String.raw`() => performance.getEntriesByType("resource").map((entry) => ({
        name: String(entry.name || ""),
        initiatorType: String(entry.initiatorType || "other"),
        duration: Math.round(Number(entry.duration || 0)),
        responseStatus: typeof entry.responseStatus === "number" ? entry.responseStatus : undefined
      }))`,
      undefined,
      contextId
    ).catch(() => []);

    for (const resource of resources) {
      if (!resource.name || Array.from(state.byRequestId.values()).some((request) => request.url === resource.name)) {
        continue;
      }

      const status = resource.responseStatus && resource.responseStatus > 0
        ? resource.responseStatus
        : await this.probeResourceStatus(pageClient, contextId, resource.name);
      const requestId = `performance:${resource.name}`;
      const request: BrowserNetworkRequest = {
        index: state.requests.length + 1,
        requestId,
        requestKey: requestId,
        method: "GET",
        url: resource.name,
        resourceType: normalizeResourceType(resource.initiatorType),
        requestHeaders: {},
        ...(status !== undefined ? { status, statusText: statusTextForStatus(status) } : {}),
        ...(resource.duration !== undefined ? { durationMs: resource.duration } : {})
      };
      state.requests.push(request);
      state.byRequestId.set(requestId, request);
      state.byRequestKey.set(requestId, request);
      state.requestsByRequestId.set(requestId, [request]);
    }
  }

  private async probeResourceStatus(
    pageClient: CdpClient,
    contextId: number,
    url: string
  ): Promise<number | undefined> {
    return evaluateCdp<number | undefined>(
      pageClient,
      String.raw`async (url) => {
        try {
          const response = await fetch(url, { method: "HEAD", cache: "no-store" });
          return response.status;
        } catch {
          return undefined;
        }
      }`,
      url,
      contextId
    ).catch(() => undefined);
  }

  private addConsoleMessage(tabId: string, message: BrowserConsoleMessage): void {
    const state = this.ensureConsoleState(tabId);
    if (!shouldIncludeConsoleMessage(message.type)) {
      return;
    }
    state.messages.push(message);
  }

  async consoleMessages(level: "error" | "warning" | "info" | "debug" = "info", all = false): Promise<BrowserConsoleEntry[]> {
    const activeTabId = await this.getActiveTabId();
    const state = this.ensureConsoleState(activeTabId);
    const startIndex = all ? 0 : state.nextMessageIndex;
    return state.messages
      .slice(startIndex)
      .filter((message) => consoleLevelForMessageType(message.type) <= consoleLevelForMessageType(level))
      .map((message) => ({
        type: message.type,
        text: message.text,
        timestamp: message.timestamp,
        locationUrl: message.locationUrl,
        lineNumber: message.lineNumber,
        formattedText: message.formattedText
      }));
  }

  async evaluate(expression: string, target?: ClickTarget): Promise<unknown> {
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    if (target && isBackendNodeTarget(target)) {
      throw new Error("Internal backendNodeId targets are not valid for browser_evaluate.");
    }
    const source = target
      ? String.raw`async (payload) => {
          const state = globalThis.__roxyMcpState;
          const element = payload.nodeToken
            ? (state?.elements?.get(payload.nodeToken) ?? null)
            : payload.selector
              ? document.querySelector(payload.selector)
              : null;
          if (!element) throw new Error('Element not found');
          const value = eval('(' + payload.expression + ')');
          return typeof value === 'function' ? await value(element) : value;
        }`
      : String.raw`async (payload) => {
          const value = eval('(' + payload.expression + ')');
          return typeof value === 'function' ? await value() : value;
        }`;
    const payload = target ? { ...this.targetArg(target), expression } : { expression };
    return evaluateCdp<unknown>(pageClient, source, payload, contextId);
  }

  async isFileInput(target: ClickTarget): Promise<boolean> {
    const pageClient = await this.getActivePageClient();
    const contextId = await this.getActiveUtilityContextId(pageClient);
    return evaluateCdp<boolean>(
      pageClient,
      IS_FILE_INPUT_SOURCE,
      this.targetArg(target),
      contextId
    ).catch(() => false);
  }

  async prepareForFileUpload(_target: ClickTarget): Promise<void> {
    this.fileChooserDebug.prepareCalls += 1;
    const tabId = await this.getActiveTabId();
    if (this.fileChooserInterceptEnabledByTabId.has(tabId)) {
      return;
    }
    const pageClient = await this.getActivePageClient();
    await pageClient.Page.setInterceptFileChooserDialog?.({ enabled: true }).catch(() => {});
    this.fileChooserInterceptEnabledByTabId.add(tabId);
  }

  async consumePendingFileChooserTarget(options?: { timeoutMs?: number }): Promise<ClickTarget | undefined> {
    const tabId = await this.getActiveTabId().catch(() => undefined);
    if (!tabId) {
      return undefined;
    }
    const deadline = Date.now() + Math.max(0, options?.timeoutMs ?? 0);
    while (true) {
      const target = this.pendingFileChooserTargetByTabId.get(tabId);
      if (target) {
        this.pendingFileChooserTargetByTabId.delete(tabId);
        return { backendNodeId: target.backendNodeId };
      }
      if (Date.now() >= deadline) {
        return undefined;
      }
      await delay(25);
    }
  }

  debugFileChooserState(): {
    prepareCalls: number;
    chooserEvents: number;
    capturedTargets: number;
    eventDispatchCalls: number;
    eventDispatchSuccesses: number;
    lastEventDispatchError: string;
    interceptEnabledTabCount: number;
    pendingTargetCount: number;
  } {
    return {
      ...this.fileChooserDebug,
      interceptEnabledTabCount: this.fileChooserInterceptEnabledByTabId.size,
      pendingTargetCount: this.pendingFileChooserTargetByTabId.size
    };
  }

  private consoleSummary(tabId: string): { total: number; errors: number; warnings: number } {
    const messages = this.ensureConsoleState(tabId).messages;
    let errors = 0;
    let warnings = 0;
    for (const message of messages) {
      if (message.type === "error" || message.type === "assert") {
        errors++;
      } else if (message.type === "warning") {
        warnings++;
      }
    }
    return { total: messages.length, errors, warnings };
  }

  private async takeConsoleLink(tabId: string): Promise<string | undefined> {
    const state = this.ensureConsoleState(tabId);
    const messages = state.messages.slice(state.nextMessageIndex);
    if (messages.length === 0) {
      return undefined;
    }

    state.logFile ??= path.join(
      this.tempDir,
      `console-${new Date(state.logStartTime).toISOString().replace(/[:.]/g, "-")}.log`
    );
    await mkdir(path.dirname(state.logFile), { recursive: true });

    const fromLine = state.logLine + 1;
    for (const message of messages) {
      const relativeTime = Math.round(message.timestamp - state.logStartTime);
      const logLine = `[${String(relativeTime).padStart(8, " ")}ms] ${message.formattedText}\n`;
      await appendFile(state.logFile, logLine);
      state.logLine += logLine.split("\n").length - 1;
    }
    state.nextMessageIndex = state.messages.length;

    const lineRange = fromLine === state.logLine ? `#L${fromLine}` : `#L${fromLine}-L${state.logLine}`;
    return `${state.logFile}${lineRange}`;
  }
}

async function waitForCdpDocumentReady(client: CdpClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const readyState = await evaluateCdp<string>(
      client,
      String.raw`() => document.readyState`
    ).catch(() => "loading");
    if (readyState === "complete") {
      return;
    }
    await delay(100);
  }
}

function normalizeConsoleTimestamp(timestamp: number | undefined): number {
  if (timestamp === undefined) {
    return Date.now();
  }
  return timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
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

function formatConsoleMessage(type: string, text: string, locationUrl: string, lineNumber: number): string {
  return `[${type.toUpperCase()}] ${text} @ ${locationUrl}:${lineNumber}`;
}

function shouldIncludeConsoleMessage(type: string): boolean {
  return consoleLevelForMessageType(type) <= consoleLevelForMessageType("info");
}

function consoleLevelForMessageType(type: string): number {
  switch (type) {
    case "assert":
    case "error":
      return 0;
    case "warning":
      return 1;
    case "count":
    case "dir":
    case "dirxml":
    case "info":
    case "log":
    case "table":
    case "time":
    case "timeEnd":
      return 2;
    case "clear":
    case "debug":
    case "endGroup":
    case "profile":
    case "profileEnd":
    case "startGroup":
    case "startGroupCollapsed":
    case "trace":
      return 3;
    default:
      return 2;
  }
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = String(value);
  }
  return result;
}

function parseCdpHeadersText(headersText: string | undefined): Record<string, string> | undefined {
  if (!headersText) {
    return undefined;
  }
  const entries: Record<string, string> = {};
  for (const line of headersText.split(/\r?\n/)) {
    if (!line || line.startsWith("HTTP/")) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    entries[line.slice(0, separatorIndex).toLowerCase()] = line.slice(separatorIndex + 1).trimStart();
  }
  return Object.keys(entries).length ? entries : undefined;
}

function normalizeResourceType(type: string | undefined): string {
  return (type ?? "other").toLowerCase();
}

function isCdpNavigationRequest(event: {
  requestId: string;
  loaderId?: string;
  type?: string;
}): boolean {
  return event.requestId === event.loaderId && event.type === "Document";
}

function canReadResponseBody(request: BrowserNetworkRequest): boolean {
  const status = request.status;
  if (hasTrackedFailure(request) || status === undefined) {
    return false;
  }
  return status !== 204 && status !== 304 && !(status >= 100 && status < 200);
}

function requestWaitKey(request: Pick<BrowserNetworkRequest, "requestId" | "requestKey">): string {
  return request.requestKey ?? request.requestId;
}

function firstRequestMissingRawRequestHeaders(state: BrowserNetworkState, requestId: string): BrowserNetworkRequest | undefined {
  return (state.requestsByRequestId.get(requestId) ?? []).find((request) => isTrackedRawRequestHeadersMissing(request));
}

function firstRequestMissingRawResponseHeaders(state: BrowserNetworkState, requestId: string): BrowserNetworkRequest | undefined {
  return (state.requestsByRequestId.get(requestId) ?? []).find((request) => isTrackedRawResponseHeadersProvisional(request));
}

function applyProvisionalHeadersAsRaw(request: BrowserNetworkRequest): void {
  if ("__response" in request || "__requestObject" in request || "__responseObject" in request) {
    setTrackedRawRequestHeaders(request as TrackedBrowserNetworkRequest, request.requestHeaders);
    applyProvisionalHeadersAsTrackedRaw(request as TrackedBrowserNetworkRequest);
  } else {
    request.rawRequestHeaders = request.requestHeaders;
    request.rawResponseHeaders = request.responseHeaders;
    request.responseHeadersSize = undefined;
  }
}

function updateRedirectChain(
  state: BrowserNetworkState,
  previous: TrackedBrowserNetworkRequest,
  next: TrackedBrowserNetworkRequest
): void {
  previous.redirectedToRequestKey = requestWaitKey(next);
  next.redirectedFromRequestKey = requestWaitKey(previous);
  const finalRequestKey = requestWaitKey(next);
  next.finalRequestKey = finalRequestKey;

  let current: TrackedBrowserNetworkRequest | undefined = previous;
  while (current) {
    current.finalRequestKey = finalRequestKey;
    const redirectedFromKey: string | undefined = current.redirectedFromRequestKey;
    current = redirectedFromKey ? state.byRequestKey.get(redirectedFromKey) : undefined;
  }
}

function applyResponseMetadataToRequest(
  state: BrowserNetworkState,
  request: TrackedBrowserNetworkRequest,
  response: {
    status: number;
    statusText: string;
    headers?: Record<string, string>;
    mimeType?: string;
  },
  hasExtraInfo?: boolean
): void {
  setTrackedResponseMetadata(request, response);
  resolveResponseAvailable(state, requestWaitKey(request));
  if (state.servedFromCacheRequestIds.has(request.requestId)) {
    request.rawRequestHeaders = undefined;
    setTrackedRawResponseMetadata(request, undefined, undefined);
    return;
  }
  if (hasExtraInfo === false) {
    applyProvisionalHeadersAsRaw(request);
    setTrackedRawResponseMetadata(request, request.rawResponseHeaders, request.responseHeadersSize);
    return;
  }
  const queuedResponseHeaders = state.responseExtraInfoHeaders.get(request.requestId);
  const nextResponseHeaders = queuedResponseHeaders?.shift();
  if (queuedResponseHeaders && queuedResponseHeaders.length === 0) {
    state.responseExtraInfoHeaders.delete(request.requestId);
  }
  if (nextResponseHeaders) {
    setTrackedRawResponseMetadata(request, nextResponseHeaders.headers, nextResponseHeaders.headersSize);
  }
  setTrackedRawResponseMetadata(request, request.rawResponseHeaders, request.responseHeadersSize);
}

function settleOutstandingNetworkWaits(state: BrowserNetworkState): void {
  for (const request of state.requests) {
    const waitKey = requestWaitKey(request);
    resolveResponseAvailable(state, waitKey);
    resolveRequestFinished(state, waitKey);
    resolveLoadingDone(state, waitKey, false);
  }
}

function ensureRequestLifecycle(request: TrackedBrowserNetworkRequest): RequestLifecycleState {
  request.__lifecycle ??= {};
  return request.__lifecycle;
}

function createLifecycleWaiter(withReject = false): RequestLifecycleWaiter {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return withReject ? { promise, resolve, reject } : { promise, resolve };
}

function ensureTrackedRequestObject(request: TrackedBrowserNetworkRequest): TrackedRequestObject {
  request.__requestObject ??= {
    request,
    hasFailure: () => !!request.failureText,
    hasResponseBody: () => request.responseBody !== undefined,
    hasResponse: () => request.status !== undefined,
    hasRawRequestHeadersMissing: () => request.rawRequestHeaders === undefined,
    hasRawResponseHeadersProvisional: () => request.responseHeaders !== undefined && request.rawResponseHeaders === request.responseHeaders,
    setFailureText: (failureText: string) => {
      request.failureText = failureText;
      ensureTrackedResponseObject(request);
    },
    markResponseFailure: (failureText: string) => {
      request.failureText = failureText;
      ensureTrackedResponseObject(request).markAvailable();
    },
    setRawRequestHeaders: (rawHeaders: Record<string, string> | undefined) => {
      request.rawRequestHeaders = rawHeaders;
    },
    isLoadingDoneSettled: () => !!ensureRequestLifecycle(request).loadingDoneSettled,
    loadingDoneEntry: () => {
      const lifecycle = ensureRequestLifecycle(request);
      if (!lifecycle.loadingDone) {
        lifecycle.loadingDone = createLifecycleWaiter(true);
      }
      return lifecycle.loadingDone;
    },
    markLoadingDone: (success: boolean) => {
      const lifecycle = ensureRequestLifecycle(request);
      if (lifecycle.loadingDoneSettled) {
        return;
      }
      lifecycle.loadingDoneSettled = true;
      const entry = lifecycle.loadingDone;
      if (!entry) {
        return;
      }
      if (success) {
        entry.resolve();
      } else {
        entry.reject?.(new Error("Request failed before the response body was available."));
      }
    }
  };
  return request.__requestObject;
}

function ensureTrackedResponse(request: TrackedBrowserNetworkRequest): TrackedBrowserNetworkResponse {
  request.__response ??= {};
  return request.__response;
}

function ensureTrackedResponseObject(request: TrackedBrowserNetworkRequest): TrackedResponseObject {
  const requestObject = ensureTrackedRequestObject(request);
  const response = ensureTrackedResponse(request);
  request.__responseObject ??= {
    request: requestObject,
    response,
    isAvailableSettled: () => !!response.availableSettled,
    isFinishedSettled: () => !!response.finishedSettled,
    responseAvailableEntry: () => {
      if (!response.available) {
        response.available = createLifecycleWaiter();
      }
      return response.available;
    },
    requestFinishedEntry: () => {
      if (!response.finished) {
        response.finished = createLifecycleWaiter();
      }
      return response.finished;
    },
    markAvailable: () => {
      if (response.availableSettled) {
        return;
      }
      response.availableSettled = true;
      response.available?.resolve();
    },
    markFinished: () => {
      if (response.finishedSettled) {
        return;
      }
      response.finishedSettled = true;
      response.finished?.resolve();
    },
    setBody: (body: string) => {
      request.responseBody = body;
      response.body = body;
    },
    setMetadata: (nextResponse) => {
      request.status = nextResponse.status;
      request.statusText = nextResponse.statusText;
      request.responseHeaders = normalizeHeaders(nextResponse.headers ?? {});
      request.mimeType = nextResponse.mimeType;
      response.status = request.status;
      response.statusText = request.statusText;
      response.headers = request.responseHeaders;
      response.mimeType = request.mimeType;
    },
    setRawMetadata: (rawHeaders, headersSize) => {
      request.rawResponseHeaders = rawHeaders;
      request.responseHeadersSize = headersSize;
      response.rawHeaders = rawHeaders;
      response.headersSize = headersSize;
    },
    setStatus: (status: number) => {
      request.status = status;
      response.status = status;
    }
  };
  return request.__responseObject;
}

function setTrackedResponseBody(request: TrackedBrowserNetworkRequest, body: string): void {
  ensureTrackedResponseObject(request).setBody(body);
}

function setTrackedFailureText(request: TrackedBrowserNetworkRequest, failureText: string): void {
  ensureTrackedRequestObject(request).setFailureText(failureText);
}

function markTrackedResponseFailure(request: TrackedBrowserNetworkRequest, failureText: string): void {
  ensureTrackedRequestObject(request).markResponseFailure(failureText);
}

function setTrackedResponseMetadata(
  request: TrackedBrowserNetworkRequest,
  response: {
    status: number;
    statusText: string;
    headers?: Record<string, string> | undefined;
    mimeType?: string | undefined;
  }
): void {
  ensureTrackedResponseObject(request).setMetadata(response);
}

function setTrackedRawResponseMetadata(
  request: TrackedBrowserNetworkRequest,
  rawHeaders: Record<string, string> | undefined,
  headersSize: number | undefined
): void {
  ensureTrackedResponseObject(request).setRawMetadata(rawHeaders, headersSize);
}

function setTrackedResponseStatus(
  request: TrackedBrowserNetworkRequest,
  status: number
): void {
  ensureTrackedResponseObject(request).setStatus(status);
}

function applyProvisionalHeadersAsTrackedRaw(request: TrackedBrowserNetworkRequest): void {
  setTrackedRawResponseMetadata(request, request.responseHeaders, undefined);
}

function setTrackedRawRequestHeaders(
  request: TrackedBrowserNetworkRequest,
  rawHeaders: Record<string, string> | undefined
): void {
  ensureTrackedRequestObject(request).setRawRequestHeaders(rawHeaders);
}

function isTrackedRequestObject(value: unknown): value is TrackedRequestObject {
  return !!value
    && typeof value === "object"
    && "request" in value
    && "hasFailure" in value
    && "hasResponseBody" in value
    && "hasResponse" in value
    && "hasRawRequestHeadersMissing" in value
    && "hasRawResponseHeadersProvisional" in value;
}

function hasTrackedFailure(request: BrowserNetworkRequest): boolean {
  return isTrackedRequestObject(request)
    ? request.hasFailure()
    : !!request.failureText;
}

function hasTrackedResponseBody(request: BrowserNetworkRequest): boolean {
  return isTrackedRequestObject(request)
    ? request.hasResponseBody()
    : request.responseBody !== undefined;
}

function isTrackedResponseAvailable(request: BrowserNetworkRequest): boolean {
  return isTrackedRequestObject(request)
    ? request.hasResponse()
    : request.status !== undefined;
}

function isTrackedRawRequestHeadersMissing(request: BrowserNetworkRequest): boolean {
  return isTrackedRequestObject(request)
    ? request.hasRawRequestHeadersMissing()
    : request.rawRequestHeaders === undefined;
}

function isTrackedRawResponseHeadersProvisional(request: BrowserNetworkRequest): boolean {
  return isTrackedRequestObject(request)
    ? request.hasRawResponseHeadersProvisional()
    : request.responseHeaders !== undefined && request.rawResponseHeaders === request.responseHeaders;
}

function trackedRequestObjectForWaitKey(
  state: BrowserNetworkState,
  requestId: string
): TrackedRequestObject | undefined {
  const request = state.byRequestKey.get(requestId);
  return request ? ensureTrackedRequestObject(request) : undefined;
}

function trackedResponseObjectForWaitKey(
  state: BrowserNetworkState,
  requestId: string
): TrackedResponseObject | undefined {
  const request = state.byRequestKey.get(requestId);
  return request ? ensureTrackedResponseObject(request) : undefined;
}

function trackedWaitObjectsForKey(
  state: BrowserNetworkState,
  requestId: string
): { requestObject?: TrackedRequestObject; responseObject?: TrackedResponseObject } {
  const request = state.byRequestKey.get(requestId);
  if (!request) {
    return {};
  }
  return {
    requestObject: ensureTrackedRequestObject(request),
    responseObject: ensureTrackedResponseObject(request)
  };
}

function responseAvailableEntry(state: BrowserNetworkState, requestId: string): RequestLifecycleWaiter {
  const responseObject = trackedResponseObjectForWaitKey(state, requestId);
  if (!responseObject) {
    return createLifecycleWaiter();
  }
  return responseObject.responseAvailableEntry();
}

function resolveResponseAvailable(state: BrowserNetworkState, requestId: string): void {
  const responseObject = trackedResponseObjectForWaitKey(state, requestId);
  if (!responseObject) {
    return;
  }
  responseObject.markAvailable();
}

async function waitForResponseAvailable(state: BrowserNetworkState, requestId: string, timeoutMs: number): Promise<void> {
  const { responseObject } = trackedWaitObjectsForKey(state, requestId);
  if (responseObject?.isAvailableSettled()) {
    return;
  }
  const entry = responseAvailableEntry(state, requestId);
  await Promise.race([
    entry.promise,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

function requestFinishedEntry(state: BrowserNetworkState, requestId: string): RequestLifecycleWaiter {
  const responseObject = trackedResponseObjectForWaitKey(state, requestId);
  if (!responseObject) {
    return createLifecycleWaiter();
  }
  return responseObject.requestFinishedEntry();
}

function resolveRequestFinished(state: BrowserNetworkState, requestId: string): void {
  const responseObject = trackedResponseObjectForWaitKey(state, requestId);
  if (!responseObject) {
    return;
  }
  responseObject.markFinished();
}

async function waitForRequestFinishedSignal(state: BrowserNetworkState, requestId: string, timeoutMs: number): Promise<void> {
  const { responseObject } = trackedWaitObjectsForKey(state, requestId);
  if (responseObject?.isFinishedSettled()) {
    return;
  }
  const entry = requestFinishedEntry(state, requestId);
  await Promise.race([
    entry.promise,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

function loadingDoneEntry(state: BrowserNetworkState, requestId: string): RequestLifecycleWaiter {
  const requestObject = trackedRequestObjectForWaitKey(state, requestId);
  if (!requestObject) {
    return createLifecycleWaiter(true);
  }
  return requestObject.loadingDoneEntry();
}

function resolveLoadingDone(state: BrowserNetworkState, requestId: string, success: boolean): void {
  const requestObject = trackedRequestObjectForWaitKey(state, requestId);
  if (!requestObject) {
    return;
  }
  requestObject.markLoadingDone(success);
}

async function waitForLoadingDone(state: BrowserNetworkState, requestId: string, timeoutMs: number): Promise<void> {
  const { requestObject } = trackedWaitObjectsForKey(state, requestId);
  if (requestObject?.isLoadingDoneSettled()) {
    return;
  }
  const entry = loadingDoneEntry(state, requestId);
  await Promise.race([
    entry.promise,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

function statusTextForStatus(status: number): string {
  if (status === 200) return "OK";
  if (status === 204) return "No Content";
  if (status === 304) return "Not Modified";
  if (status === 400) return "Bad Request";
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not Found";
  if (status === 500) return "Internal Server Error";
  return "";
}

function cloneNetworkRequest(request: BrowserNetworkRequest): BrowserNetworkRequest {
  return {
    ...request,
    requestHeaders: { ...request.requestHeaders },
    ...(request.responseHeaders ? { responseHeaders: { ...request.responseHeaders } } : {})
  };
}

type DropFilePayload = {
  buffer: string;
  lastModifiedMs: number;
  mimeType: string;
  name: string;
};

async function prepareDropFiles(paths: string[] | undefined): Promise<DropFilePayload[]> {
  if (!paths?.length) {
    return [];
  }
  return Promise.all(paths.map(async (filePath) => {
    const [fileStat, buffer] = await Promise.all([
      stat(filePath),
      readFile(filePath)
    ]);
    if (!fileStat.isFile()) {
      throw new McpToolError("invalid_input", `Drop path is not a file: ${filePath}`);
    }
    return {
      name: path.basename(filePath),
      mimeType: mime.getType(filePath) || "application/octet-stream",
      buffer: buffer.toString("base64"),
      lastModifiedMs: fileStat.mtimeMs
    };
  }));
}

type BidiBytesValue = {
  type: "base64" | "string";
  value: string;
};

type BidiHeader = {
  name: string;
  value: BidiBytesValue | string | { value?: string; type?: string };
};

type BidiNetworkEvent = {
  context: string;
  errorText?: string;
  redirectCount?: number;
  request: {
    bodySize?: number;
    destination?: string;
    headers?: BidiHeader[];
    method: string;
    request: string;
    url: string;
  };
  response?: {
    headers?: BidiHeader[];
    headersSize?: number;
    mimeType?: string;
    status: number;
    statusText?: string;
  };
  timestamp?: number;
};

function bidiBytesValueToString(value: BidiBytesValue | string | { value?: string; type?: string }): string {
  if (typeof value === "string") {
    return value;
  }
  if (value.type === "base64" && value.value !== undefined) {
    return Buffer.from(value.value, "base64").toString("utf8");
  }
  return value.value ?? "";
}

function bidiHeadersToRecord(headers: BidiHeader[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of headers ?? []) {
    result[header.name] = bidiBytesValueToString(header.value);
  }
  return result;
}

function parseBidiNetworkEvent(payload: unknown): BidiNetworkEvent | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const event = payload as Partial<BidiNetworkEvent>;
  if (!event.context || !event.request?.request || !event.request.method || !event.request.url) {
    return undefined;
  }
  return {
    context: event.context,
    request: event.request,
    ...(event.redirectCount !== undefined ? { redirectCount: event.redirectCount } : {}),
    ...(event.errorText !== undefined ? { errorText: event.errorText } : {}),
    ...(event.response !== undefined ? { response: event.response } : {}),
    ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {})
  };
}

function bidiLogContext(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || !("source" in payload)) {
    return undefined;
  }
  const context = (payload as { source?: { context?: string | null } }).source?.context;
  return context ?? undefined;
}

export class BidiConnectedBrowserSession implements ConnectedBrowserSession {
  readonly protocol = "bidi" as const;
  readonly browserName = "firefox" as const;

  private readonly pageConsoleStates = new Map<string, BrowserConsoleState>();
  private readonly pageNetworkStates = new Map<string, BrowserNetworkState>();
  private readonly completionCollectorsByTabId = new Map<string, Set<CompletionRequestCollector>>();
  private readonly pageDialogStates = new Map<string, BrowserDialogState>();
  private readonly dialogWaiters = new Map<string, Set<DialogWaiter>>();
  private readonly pageLoadStates = new Map<string, { loaded: boolean }>();
  private readonly bidiListeners = new Map<string, (payload: unknown) => void>();
  private responseDataCollector: string | undefined;
  private activeTabId: string | undefined;
  private ownsSession = false;
  private readonly tempDir: string;

  private constructor(
    private readonly client: BidiProtocolClient,
    tempDir?: string
  ) {
    this.tempDir = configuredTempDir({
      ...(tempDir !== undefined ? { tempDir } : {})
    });
  }

  static async connect(args: RoxyBrowserConnectArgs): Promise<BidiConnectedBrowserSession> {
    if (args.browser && args.browser !== "firefox") {
      throw new McpToolError(
        "unsupported_protocol_input",
        'BiDi attach only supports browser "firefox" in v1.'
      );
    }

    const parsed = new URL(args.endpoint);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new McpToolError(
        "unsupported_protocol_input",
        `BiDi endpoint must be a ws(s) URL. Received "${parsed.protocol}".`
      );
    }

    const client = await getBidiClientFactory()({
      browserName: "firefox",
      webSocketUrl: normalizeFirefoxBidiEndpoint(args.endpoint, args.sessionId)
    });

    const session = new BidiConnectedBrowserSession(client, args.tempDir);
    session.ownsSession = await ensureMcpBiDiSession(client, args.endpoint, args.sessionId);
    await session.initialize();
    await session.refreshTabs();
    return session;
  }

  async version(): Promise<string> {
    return `${this.browserName}/unknown`;
  }

  async listTabs(): Promise<BrowserTab[]> {
    return this.refreshTabs();
  }

  async newTab(url = "about:blank"): Promise<BrowserTab[]> {
    const response = await this.client.browsingContextCreate({
      type: "tab"
    });
    this.activeTabId = response.context;
    await this.client.browsingContextActivate({
      context: response.context
    });
    if (url && url !== "about:blank") {
      await this.client.browsingContextNavigate({
        context: response.context,
        url,
        wait: "complete"
      });
    }
    return this.refreshTabs();
  }

  async selectTab(tabId: string): Promise<BrowserTab[]> {
    this.activeTabId = tabId;
    await this.client.browsingContextActivate({
      context: tabId
    });
    return this.refreshTabs();
  }

  async closeTab(tabId: string): Promise<BrowserTab[]> {
    const tabsBeforeClose = await this.refreshTabs();
    const index = tabsBeforeClose.findIndex((tab) => tab.id === tabId);
    await this.client.browsingContextClose({
      context: tabId
    });
    const tabsAfterClose = await this.refreshTabs();
    if (tabsAfterClose.length === 0) {
      this.activeTabId = undefined;
      this.pageConsoleStates.delete(tabId);
      const networkState = this.pageNetworkStates.get(tabId);
      if (networkState) {
        settleOutstandingNetworkWaits(networkState);
        this.pageNetworkStates.delete(tabId);
      }
      this.pageDialogStates.delete(tabId);
      this.pageLoadStates.delete(tabId);
      this.completionCollectorsByTabId.delete(tabId);
      return tabsAfterClose;
    }
    const fallbackIndex = index >= 0 ? Math.min(index, tabsAfterClose.length - 1) : 0;
    this.activeTabId = tabsAfterClose[fallbackIndex]?.id;
    if (this.activeTabId) {
      await this.client.browsingContextActivate({
        context: this.activeTabId
      });
    }
    return this.refreshTabs();
  }

  async snapshot(request: BrowserSnapshotRequest = {}): Promise<BrowserSnapshot> {
    const tabId = await this.getActiveTabId();
    const result = await retryUntilReady(() =>
      evaluateBiDi<AriaSnapshotResult>(
        this.client,
        tabId,
        ARIA_SNAPSHOT_EVALUATE_SOURCE,
        toAriaSnapshotPayload(request)
      )
    );
    const snapshot = toBrowserSnapshot(result, request, {
      console: this.consoleSummary(tabId),
      consoleLink: await this.takeConsoleLink(tabId)
    });
    return {
      ...snapshot,
      retryable: true
    };
  }

  async consoleMessages(level: "error" | "warning" | "info" | "debug" = "info", all = false): Promise<BrowserConsoleEntry[]> {
    const activeTabId = await this.getActiveTabId();
    const state = this.ensureConsoleState(activeTabId);
    const startIndex = all ? 0 : state.nextMessageIndex;
    return state.messages
      .slice(startIndex)
      .filter((message) => consoleLevelForMessageType(message.type) <= consoleLevelForMessageType(level))
      .map((message) => ({
        type: message.type,
        text: message.text,
        timestamp: message.timestamp,
        locationUrl: message.locationUrl,
        lineNumber: message.lineNumber,
        formattedText: message.formattedText
      }));
  }

  async evaluate(expression: string, target?: ClickTarget): Promise<unknown> {
    const tabId = await this.getActiveTabId();
    if (target && isBackendNodeTarget(target)) {
      throw new Error("Internal backendNodeId targets are not valid for browser_evaluate.");
    }
    const source = target
      ? String.raw`async (payload) => {
          const state = globalThis.__roxyMcpState;
          const element = payload.nodeToken
            ? (state?.elements?.get(payload.nodeToken) ?? null)
            : document.querySelector(payload.selector);
          if (!element) throw new Error('Element not found');
          const value = eval('(' + payload.expression + ')');
          return typeof value === 'function' ? await value(element) : value;
        }`
      : String.raw`async (payload) => {
          const value = eval('(' + payload.expression + ')');
          return typeof value === 'function' ? await value() : value;
        }`;
    const payload = target ? { ...this.targetArg(target), expression } : { expression };
    return evaluateBiDi<unknown>(this.client, tabId, source, payload);
  }

  async isFileInput(target: ClickTarget): Promise<boolean> {
    const tabId = await this.getActiveTabId();
    return evaluateBiDi<boolean>(
      this.client,
      tabId,
      IS_FILE_INPUT_SOURCE,
      this.targetArg(target)
    ).catch(() => false);
  }

  async prepareForFileUpload(_target: ClickTarget): Promise<void> {}

  async click(target: ClickTarget, options: SessionClickOptions): Promise<void> {
    if (isBackendNodeTarget(target)) {
      throw new Error("Internal backendNodeId targets are only valid for file upload resolution.");
    }
    const tabId = await this.getActiveTabId();
    const source = "nodeToken" in target ? ACTION_POINT_EVALUATE_SOURCE : ACTION_POINT_BY_SELECTOR_SOURCE;
    const arg = "nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector };
    const point = await evaluateBiDi<{ ok: boolean; reason?: string; x?: number; y?: number }>(
      this.client,
      tabId,
      source,
      arg
    );
    if (!point.ok || point.x === undefined || point.y === undefined) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        isSelector
          ? `Element "${target.selector}" could not be found or is not visible.`
          : 'The referenced element is no longer valid. Call "browser_snapshot" again.'
      );
    }

    const BIDI_BUTTON: Record<string, number> = { left: 0, middle: 1, right: 2 };
    const buttonCode = BIDI_BUTTON[options.button ?? "left"] ?? 0;
    const cycles = options.doubleClick ? 2 : 1;

    const modifierKeys = (options.modifiers ?? []).map((m) => {
      const KEY_MAP: Record<string, string> = {
        Alt: "",
        Control: "",
        ControlOrMeta: "",
        Meta: "",
        Shift: ""
      };
      return KEY_MAP[m] ?? m;
    });

    const keyDownActions = modifierKeys.map((value) => ({ type: "keyDown" as const, value }));
    const keyUpActions = modifierKeys.map((value) => ({ type: "keyUp" as const, value }));

    const pointerActions: unknown[] = [
      {
        type: "pointerMove",
        x: Math.round(point.x),
        y: Math.round(point.y),
        origin: "viewport"
      }
    ];
    for (let i = 0; i < cycles; i++) {
      pointerActions.push({ type: "pointerDown", button: buttonCode });
      pointerActions.push({ type: "pause", duration: options.clickHoldMs });
      pointerActions.push({ type: "pointerUp", button: buttonCode });
    }

    const actions: unknown[] = [];
    if (modifierKeys.length > 0) {
      actions.push({ type: "key", id: "kbd", actions: [...keyDownActions, ...keyUpActions] });
    }
    actions.push({
      type: "pointer",
      id: "mouse",
      parameters: { pointerType: "mouse" },
      actions: pointerActions
    });

    // TODO(bidi): A synchronous alert()/confirm()/prompt() opened by the click
    // blocks the page's main thread, and in Firefox that also wedges the BiDi
    // transport: inputPerformActions never resolves while the modal is open.
    // Unlike CDP (where only the mouse-release call blocks), BiDi dispatches
    // the whole pointer sequence as one atomic command, so we cannot split it.
    // Mitigation (NOT a full fix): race the action against the dialog waiter so
    // a dialog-opening click resolves instead of hanging forever. The residual
    // performPromise is intentionally left dangling; it resolves later once the
    // dialog is dismissed.
    //
    // KNOWN-UNRESOLVED: even with this race,后续的 BiDi 命令在模态框打开期间仍可能
    // 整体卡死（见 handleDialog 的 TODO）。Firefox/geckodriver 在 alert 模态下会
    // 阻塞几乎所有 BiDi 命令，这是浏览器/驱动层的限制，本适配器无法绕过。
    const performPromise = this.client.inputPerformActions({
      context: tabId,
      actions
    });
    await Promise.race([
      performPromise,
      this.waitForDialog(tabId, options.clickHoldMs + 5000)
    ]);
    performPromise.catch(() => {});
    await this.client.inputReleaseActions({ context: tabId }).catch(() => {});
  }

  async drag(start: ClickTarget, end: ClickTarget, options: SessionDragOptions): Promise<void> {
    const tabId = await this.getActiveTabId();
    const startPoint = await this.actionPoint(tabId, start);
    const endPoint = await this.actionPoint(tabId, end);
    await this.client.inputPerformActions({
      context: tabId,
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              x: Math.round(startPoint.x),
              y: Math.round(startPoint.y),
              origin: "viewport"
            },
            { type: "pause", duration: options.moveDelayMs },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: options.holdDelayMs },
            {
              type: "pointerMove",
              x: Math.round(endPoint.x),
              y: Math.round(endPoint.y),
              origin: "viewport"
            },
            { type: "pause", duration: options.moveDelayMs },
            { type: "pointerUp", button: 0 }
          ]
        }
      ]
    });
    await this.client.inputReleaseActions({ context: tabId }).catch(() => {});
  }

  async drop(target: ClickTarget, payload: SessionDropOptions): Promise<void> {
    const files = await prepareDropFiles(payload.paths);
    const tabId = await this.getActiveTabId();
    const result = await evaluateBiDi<{ ok: boolean; reason?: string }>(
      this.client,
      tabId,
      DROP_ON_ELEMENT_SOURCE,
      { ...this.targetArg(target), data: payload.data ?? {}, files }
    );
    if (!result.ok) {
      throw new McpToolError(
        result.reason === "not_accepted" ? "action_failed" : "invalid_target",
        result.reason === "not_accepted"
          ? "Drop target did not accept the drop; its dragover handler did not call preventDefault()."
          : "Drop target could not be found."
      );
    }
  }

  async hover(target: ClickTarget): Promise<void> {
    if (isBackendNodeTarget(target)) {
      throw new Error("Internal backendNodeId targets are only valid for file upload resolution.");
    }
    const tabId = await this.getActiveTabId();
    const source = "nodeToken" in target ? ACTION_POINT_EVALUATE_SOURCE : ACTION_POINT_BY_SELECTOR_SOURCE;
    const arg = "nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector };
    const point = await evaluateBiDi<{ ok: boolean; reason?: string; x?: number; y?: number }>(
      this.client,
      tabId,
      source,
      arg
    );
    if (!point.ok || point.x === undefined || point.y === undefined) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        isSelector
          ? `Element "${target.selector}" could not be found or is not visible.`
          : 'The referenced element is no longer valid. Call "browser_snapshot" again.'
      );
    }

    await this.client.inputPerformActions({
      context: tabId,
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
    await this.client.inputReleaseActions({ context: tabId }).catch(() => {});
  }

  async focus(target: ClickTarget): Promise<void> {
    const tabId = await this.getActiveTabId();
    const result = await evaluateBiDiRef(this.client, tabId, FOCUS_AND_GET_ELEMENT_SOURCE, this.targetArg(target));
    if (!result.sharedId && !result.handle) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        isSelector ? `Element "${target.selector}" could not be found.` : "The referenced element is no longer valid."
      );
    }
  }

  async clear(target: ClickTarget): Promise<void> {
    const tabId = await this.getActiveTabId();
    const result = await evaluateBiDi<{ ok: boolean; reason?: string }>(
      this.client,
      tabId,
      CLEAR_ELEMENT_SOURCE,
      this.targetArg(target)
    );
    if (!result.ok) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : "The referenced element is no longer valid.")
          : "Element is not a typeable input."
      );
    }
  }

  async close(): Promise<void> {
    for (const [tabId, state] of this.pageNetworkStates) {
      settleOutstandingNetworkWaits(state);
      this.completionCollectorsByTabId.delete(tabId);
    }
    this.pageNetworkStates.clear();
    this.pageConsoleStates.clear();
    this.pageDialogStates.clear();
    for (const [event, listener] of this.bidiListeners) {
      this.client.removeListener(event, listener);
    }
    this.bidiListeners.clear();
    if (this.responseDataCollector) {
      await this.client.networkRemoveDataCollector({ collector: this.responseDataCollector }).catch(() => {});
      this.responseDataCollector = undefined;
    }
    if (this.ownsSession) {
      await this.client.sessionEnd({}).catch(() => {});
    }
    this.client.close();
  }

  async navigate(url: string): Promise<void> {
    const tabId = await this.getActiveTabId();
    this.resetConsole(tabId);
    await this.client.browsingContextNavigate({ context: tabId, url, wait: "complete" });
  }

  async type(target: ClickTarget, text: string, options?: SessionTypeOptions): Promise<void> {
    if (isBackendNodeTarget(target)) {
      throw new Error("Internal backendNodeId targets are only valid for file upload resolution.");
    }
    const tabId = await this.getActiveTabId();
    const arg = "nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector };
    // ⚠️ CDP↔BiDi PARITY GAP: the CDP session.type has a real per-keystroke insertText loop that
    // honors slowly/delayMs/varianceMs (humanized cadence). The BiDi MCP path sets the value via
    // a single DOM operation (TYPE_INTO_ELEMENT_SOURCE) and does not emit per-character keystrokes,
    // so humanized typing timing does not apply here. Root cause: this path never had a keystroke
    // loop; matching CDP requires reworking it onto BiDi input actions (tracked as follow-up).
    const result = await evaluateBiDi<{ ok: boolean; reason?: string }>(
      this.client,
      tabId,
      TYPE_INTO_ELEMENT_SOURCE,
      { ...arg, text, submit: options?.submit ?? false }
    );
    if (!result.ok) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : 'The referenced element is no longer valid.')
          : `Element is not a typeable input.`
      );
    }
  }

  async pressKey(
    key: string,
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">
  ): Promise<void> {
    const tabId = await this.getActiveTabId();

    // WebDriver BiDi uses Unicode Private Use Area for special keys
    const BIDI_SPECIAL_KEY: Record<string, string> = {
      Enter: "", Return: "", Escape: "",
      Tab: "", Backspace: "", Delete: "",
      ArrowLeft: "", ArrowRight: "", ArrowUp: "", ArrowDown: "",
      Home: "", End: "", PageUp: "", PageDown: "",
      Insert: "", Space: " ",
      F1: "", F2: "", F3: "", F4: "",
      F5: "", F6: "", F7: "", F8: "",
      F9: "", F10: "", F11: "", F12: "",
    };
    const BIDI_MODIFIER_KEY: Record<string, string> = {
      Alt: "", Control: "",
      Meta: "", Shift: ""
    };

    const keyValue = BIDI_SPECIAL_KEY[key] ?? key;
    const modifierKeys = (modifiers ?? [])
      .map((modifier) => resolveSmartModifierString(modifier))
      .map((m) => BIDI_MODIFIER_KEY[m] ?? m);

    const keyDownActions = modifierKeys.map((value) => ({ type: "keyDown" as const, value }));
    const keyUpActions = [...modifierKeys].reverse().map((value) => ({ type: "keyUp" as const, value }));

    await this.client.inputPerformActions({
      context: tabId,
      actions: [
        {
          type: "key",
          id: "kbd",
          actions: [
            ...keyDownActions,
            { type: "keyDown" as const, value: keyValue },
            { type: "keyUp" as const, value: keyValue },
            ...keyUpActions
          ]
        }
      ]
    } as Parameters<typeof this.client.inputPerformActions>[0]);
    await this.client.inputReleaseActions({ context: tabId }).catch(() => {});
  }

  async selectOption(target: ClickTarget, values: string[]): Promise<string[]> {
    if (isBackendNodeTarget(target)) {
      throw new Error("Internal backendNodeId targets are only valid for file upload resolution.");
    }
    const tabId = await this.getActiveTabId();
    const arg = "nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector };
    const result = await evaluateBiDi<{ ok: boolean; reason?: string; selected: string[] }>(
      this.client, tabId, SELECT_OPTION_SOURCE, { ...arg, values }
    );
    if (!result.ok) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : 'The referenced element is no longer valid.')
          : `Element is not a <select> element.`
      );
    }
    return result.selected;
  }

  async check(target: ClickTarget, checked: boolean): Promise<void> {
    if (isBackendNodeTarget(target)) {
      throw new Error("Internal backendNodeId targets are only valid for file upload resolution.");
    }
    const tabId = await this.getActiveTabId();
    const arg = "nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector };
    const result = await evaluateBiDi<{ ok: boolean; reason?: string }>(
      this.client, tabId, CHECK_ELEMENT_SOURCE, { ...arg, checked }
    );
    if (!result.ok) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : 'The referenced element is no longer valid.')
          : `Element is not a checkbox or radio button.`
      );
    }
  }

  async goBack(): Promise<void> {
    const tabId = await this.getActiveTabId();
    await this.client.browsingContextTraverseHistory({ context: tabId, delta: -1 }).catch(() => {});
  }

  async goForward(): Promise<void> {
    const tabId = await this.getActiveTabId();
    await this.client.browsingContextTraverseHistory({ context: tabId, delta: 1 }).catch(() => {});
  }

  async resize(width: number, height: number): Promise<void> {
    const tabId = await this.getActiveTabId();
    await this.client.browsingContextSetViewport({
      context: tabId,
      viewport: { width, height }
    });
  }

  async scroll(
    target: ClickTarget | null,
    deltaX: number,
    deltaY: number,
    options?: SessionScrollOptions
  ): Promise<void> {
    if (target && isBackendNodeTarget(target)) {
      throw new Error("Internal backendNodeId targets are only valid for file upload resolution.");
    }
    const tabId = await this.getActiveTabId();
    const arg = target ? ("nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector }) : {};
    await evaluateBiDi<boolean>(this.client, tabId, ENSURE_BUBBLE_CURSOR_SOURCE).catch(() => false);
    const chunks = await splitScrollDeltas(deltaX, deltaY, options?.stepPx ?? Math.max(Math.abs(deltaX), Math.abs(deltaY), 1));
    for (const [index, chunk] of chunks.entries()) {
      await evaluateBiDi<{ ok: boolean }>(this.client, tabId, SCROLL_ELEMENT_SOURCE, {
        ...arg,
        deltaX: chunk.deltaX,
        deltaY: chunk.deltaY
      });
      const reverseChunk = maybeReverseScrollChunk(chunk, index, chunks.length);
      if (reverseChunk) {
        await delay(60 + Math.round(Math.random() * 120));
        await evaluateBiDi<{ ok: boolean }>(this.client, tabId, SCROLL_ELEMENT_SOURCE, {
          ...arg,
          deltaX: reverseChunk.deltaX,
          deltaY: reverseChunk.deltaY
        });
      }
      if (shouldPauseToObserve(index, chunks.length)) {
        await delay(220 + Math.round(Math.random() * 520));
      }
      if ((options?.stepDelayMs ?? 0) > 0) {
        await delay(options!.stepDelayMs);
      }
    }
  }

  async screenshot(options: SessionScreenshotOptions = {}): Promise<{ data: string; mimeType: "image/png" | "image/jpeg" }> {
    const tabId = await this.getActiveTabId();
    const format = options.type ?? "png";
    const screenshotOptions: {
      context: string;
      format: { type: "image/jpeg" | "image/png" };
      origin?: "document" | "viewport";
      clip?: { type: "box"; x: number; y: number; width: number; height: number };
    } = {
      context: tabId,
      format: { type: format === "png" ? "image/png" : "image/jpeg" }
    };
    if (options.target) {
      const box = await evaluateBiDi<{ ok: boolean; x?: number; y?: number; width?: number; height?: number }>(
        this.client,
        tabId,
        ELEMENT_BOX_SOURCE,
        this.targetArg(options.target)
      );
      if (!box.ok || box.x === undefined || box.y === undefined || box.width === undefined || box.height === undefined) {
        throw new McpToolError("invalid_target", "Screenshot target could not be found.");
      }
      screenshotOptions.origin = "viewport";
      screenshotOptions.clip = {
        type: "box",
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height
      };
    } else if (options.fullPage) {
      const box = await evaluateBiDi<{ x: number; y: number; width: number; height: number }>(
        this.client,
        tabId,
        DOCUMENT_BOX_SOURCE
      );
      screenshotOptions.origin = "document";
      screenshotOptions.clip = {
        type: "box",
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height
      };
    }
    const result = await this.client.browsingContextCaptureScreenshot(screenshotOptions);
    return {
      data: (result as unknown as { data: string }).data,
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png"
    };
  }

  async uploadFile(target: ClickTarget, filePaths: string[]): Promise<void> {
    const tabId = await this.getActiveTabId();
    const element = await this.sharedElementReference(tabId, target);
    await this.client.inputSetFiles({
      context: tabId,
      element,
      files: filePaths
    });
  }

  async finishFileUpload(_target: ClickTarget): Promise<void> {}

  async formFieldMetadata(target: ClickTarget): Promise<{ tagName: string; inputType?: string; isContentEditable?: boolean }> {
    const tabId = await this.getActiveTabId();
    const result = await evaluateBiDi<{
      ok: boolean;
      reason?: string;
      tagName?: string;
      inputType?: string;
      isContentEditable?: boolean;
    }>(
      this.client,
      tabId,
      FORM_FIELD_METADATA_SOURCE,
      this.targetArg(target)
    );
    if (!result.ok || !result.tagName) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : "The referenced element is no longer valid.")
          : `Unable to inspect form field: ${result.reason ?? "unknown error"}.`
      );
    }
    return {
      tagName: result.tagName,
      ...(result.inputType !== undefined ? { inputType: result.inputType } : {}),
      ...(result.isContentEditable !== undefined ? { isContentEditable: result.isContentEditable } : {})
    };
  }

  async fillForm(fields: SessionFormField[]): Promise<void> {
    const tabId = await this.getActiveTabId();
    for (const field of fields) {
      const result = await evaluateBiDi<{ ok: boolean; reason?: string }>(
        this.client,
        tabId,
        SET_FORM_FIELD_SOURCE,
        {
          ...this.targetArg(field.target),
          fieldType: field.type,
          value: field.value
        }
      );
      if (!result.ok) {
        throw new McpToolError("invalid_target", `Unable to fill form field: ${result.reason ?? "unknown error"}.`);
      }
    }
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    const tabId = this.dialogTabId();
    if (!this.pageDialogStates.has(tabId)) {
      throw new McpToolError("no_dialog", "No dialog visible.");
    }
    this.pageDialogStates.delete(tabId);
    // TODO(bidi): Firefox's browsingContext.handleUserPrompt can stall while a
    // modal is open — 实测在 alert/confirm 模态下 geckodriver 对该命令的响应会
    // 长时间不返回（实测 60s+ 不返回，最终靠 MCP 客户端超时才解脱）。这里用
    // withBiDiTimeout 兜底：最多等 5s 后强制 reject，避免工具调用无限挂起。
    // 这只是“快速失败”的缓解，并未真正解决“模态框打开时几乎所有 BiDi 命令都
    // 被卡死”的底层问题。CDP 下这一路径是可靠的，BiDi 暂只能参考 CDP 思路。
    // KNOWN-UNRESOLVED: 若在模态框打开期间调用本命令，前序的 refreshTabs
    // (browsingContextGetTree) 等也可能先一步卡死，导致整个 tool 调用超时。
    await withBiDiTimeout(
      this.client.browsingContextHandleUserPrompt({
        context: tabId,
        accept,
        ...(promptText !== undefined ? { userText: promptText } : {})
      }),
      5_000
    );
  }

  async hasDialog(): Promise<boolean> {
    return this.pageDialogStates.size > 0;
  }

  async networkRequests(): Promise<BrowserNetworkRequest[]> {
    const tabId = await this.getActiveTabId();
    return this.ensureNetworkState(tabId).requests.map(cloneNetworkRequest);
  }

  async beginRequestCollection(): Promise<unknown> {
    const tabId = await this.getActiveTabId();
    const collector: CompletionRequestCollector = { requests: [], requestKeys: [], liveRequests: [] };
    const collectors = this.completionCollectorsByTabId.get(tabId) ?? new Set<CompletionRequestCollector>();
    collectors.add(collector);
    this.completionCollectorsByTabId.set(tabId, collectors);
    return { tabId, collector };
  }

  async endRequestCollection(state?: unknown): Promise<BrowserNetworkRequest[]> {
    const completionState = state as { tabId?: string; collector?: CompletionRequestCollector } | undefined;
    const tabId = completionState?.tabId ?? await this.getActiveTabId();
    const collector = completionState?.collector;
    if (!collector) {
      return [];
    }
    const collectors = this.completionCollectorsByTabId.get(tabId);
    collectors?.delete(collector);
    if (collectors && collectors.size === 0) {
      this.completionCollectorsByTabId.delete(tabId);
    }
    const stateForTab = this.ensureNetworkState(tabId);
    const requestsFromLiveObjects = Array.from(new Set(collector.liveRequests)).map(({ request }) => cloneNetworkRequest(request));
    const uniqueKeys = Array.from(new Set(collector.requestKeys));
    const requests = requestsFromLiveObjects.length
      ? requestsFromLiveObjects
      : uniqueKeys
          .map((requestKey) => stateForTab.byRequestKey.get(requestKey))
          .filter((request): request is BrowserNetworkRequest => !!request)
          .map(cloneNetworkRequest);
    return requests.length ? requests : collector.requests.map(cloneNetworkRequest);
  }

  async waitForPageTimeout(timeoutMs: number): Promise<void> {
    const quietMs = 500;
    if (timeoutMs > 0) {
      await evaluateBiDi(
        this.client,
        await this.getActiveTabId(),
        String.raw`(ms) => new Promise((resolve) => setTimeout(resolve, ms))`,
        timeoutMs
      ).catch(async () => {
        await delay(timeoutMs);
      });
    }
  }

  async waitForMainFrameLoad(timeoutMs: number): Promise<void> {
    const tabId = await this.getActiveTabId();
    const readyState = await evaluateBiDi<string>(
      this.client,
      tabId,
      String.raw`() => document.readyState`
    ).catch(() => "loading");
    if (readyState === "complete") {
      const state = this.ensurePageLoadState(tabId);
      state.loaded = true;
      return;
    }

    const currentState = this.ensurePageLoadState(tabId);
    if (currentState.loaded) {
      return;
    }

    await withBiDiTimeout(new Promise<void>((resolve) => {
      const eventName = "browsingContext.load";
      const listener = (payload: unknown) => {
        if (!payload || typeof payload !== "object" || !("context" in payload)) {
          return;
        }
        const event = payload as { context?: string };
        if (event.context !== tabId) {
          return;
        }
        this.client.removeListener(eventName, listener);
        this.ensurePageLoadState(tabId).loaded = true;
        resolve();
      };
      this.client.on(eventName, listener);
    }), timeoutMs).catch(() => undefined);
  }

  async waitForRequestFinished(requestId: string, timeoutMs: number): Promise<void> {
    const tabId = await this.getActiveTabId();
    const state = this.ensureNetworkState(tabId);
    await waitForRequestFinishedSignal(state, requestId, timeoutMs).catch(() => undefined);
  }

  async waitForRequestResponse(requestId: string, timeoutMs: number): Promise<void> {
    const tabId = await this.getActiveTabId();
    const state = this.ensureNetworkState(tabId);
    await waitForResponseAvailable(state, requestId, timeoutMs).catch(() => undefined);
  }

  async networkRequest(index: number): Promise<BrowserNetworkRequest | undefined> {
    const tabId = await this.getActiveTabId();
    const request = this.ensureNetworkState(tabId).requests[index - 1];
    return request ? cloneNetworkRequest(request) : undefined;
  }

  async fetchResponseBody(index: number): Promise<string | undefined> {
    const tabId = await this.getActiveTabId();
    const request = this.ensureNetworkState(tabId).requests[index - 1];
    if (!request || !request.requestId) {
      return request?.responseBody;
    }
    if (request.responseBody !== undefined) {
      return request.responseBody;
    }
    const body = await this.getResponseBody(request.requestId).catch(() => undefined);
    if (body !== undefined) {
      request.responseBody = body;
    }
    return request.responseBody;
  }

  async runCodeUnsafe(code: string): Promise<unknown> {
    return this.evaluate(`async () => {
      const fn = eval(${JSON.stringify(`(${code})`)});
      if (typeof fn !== 'function') throw new Error('Code must evaluate to a function.');
      return await fn({
        evaluate: async expression => {
          const value = typeof expression === 'function' ? expression : eval('(' + expression + ')');
          return typeof value === 'function' ? await value() : value;
        },
        title: () => document.title,
        url: () => location.href
      });
    }`);
  }

  private async initialize(): Promise<void> {
    // 顺序很关键：必须先 attachBiDiListeners()，再 sessionSubscribe()。
    // 实测 Firefox：sessionSubscribe 返回后事件会立即开始涌入；若此刻监听器
    // 还没注册，最早的一批 network.beforeRequestSent（页面导航/资源请求）会落进
    // “no registered listener” 分支被静默丢弃，导致 network 列表里缺首页请求。
    // 调试时观察到 [DEBUG bidi client no-listener] network.beforeRequestSent 连续
    // 出现几十次，正是此问题。先注册监听器即可避免丢事件。
    // TODO(bidi): 即便修了顺序，BiDi 网络捕获仍有状态时序问题，见
    // handleResponseCompleted / networkRequests 的 TODO。
    this.attachBiDiListeners();
    await this.client.sessionSubscribe({
      events: [
        "browsingContext.navigationStarted",
        "browsingContext.load",
        "browsingContext.userPromptOpened",
        "log.entryAdded",
        "network.beforeRequestSent",
        "network.responseCompleted",
        "network.fetchError",
        "network.responseStarted"
      ]
    }).catch(() => undefined);
    const collectorResult = await this.client.networkAddDataCollector({
      dataTypes: ["response"],
      maxEncodedDataSize: 10_000_000
    }).catch(() => undefined);
    this.responseDataCollector = (collectorResult as { collector?: string } | undefined)?.collector;
  }

  private attachBiDiListeners(): void {
    this.attachBiDiListener("log.entryAdded", (payload) => this.handleLogEntry(payload));
    this.attachBiDiListener("browsingContext.userPromptOpened", (payload) => this.handleUserPromptOpened(payload));
    this.attachBiDiListener("browsingContext.navigationStarted", (payload) => this.handleNavigationStarted(payload));
    this.attachBiDiListener("browsingContext.load", (payload) => this.handleBrowsingContextLoad(payload));
    this.attachBiDiListener("network.beforeRequestSent", (payload) => this.handleBeforeRequestSent(payload));
    this.attachBiDiListener("network.responseStarted", (payload) => this.handleResponseStarted(payload));
    this.attachBiDiListener("network.responseCompleted", (payload) => void this.handleResponseCompleted(payload));
    this.attachBiDiListener("network.fetchError", (payload) => this.handleFetchError(payload));
  }

  private attachBiDiListener(event: string, listener: (payload: unknown) => void): void {
    this.bidiListeners.set(event, listener);
    this.client.on(event, listener);
  }

  private async refreshTabs(): Promise<BrowserTab[]> {
    const response = await this.client.browsingContextGetTree({});
    const tabs = await Promise.all(
      response.contexts
        .filter((context) => context.parent === undefined || context.parent === null)
        .map(async (context) => ({
          id: context.context,
          title: await this.titleForContext(context.context),
          url: context.url
        }))
    );

    if (!this.activeTabId) {
      this.activeTabId = chooseInitialTab(tabs);
    }

    return tabs.map((tab) => ({
      ...tab,
      active: tab.id === this.activeTabId
    }));
  }

  private async getActiveTabId(): Promise<string> {
    const tabs = await this.refreshTabs();
    const activeTab = tabs.find((tab) => tab.active);
    if (!activeTab) {
      throw new McpToolError("no_active_tab", "No active tab is available.");
    }
    return activeTab.id;
  }

  private targetArg(target: ClickTarget): { nodeToken: string } | { selector: string } {
    if (isBackendNodeTarget(target)) {
      throw new Error("Internal backendNodeId targets cannot be converted into page selector arguments.");
    }
    return "nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector };
  }

  private dialogTabId(): string {
    if (this.activeTabId && this.pageDialogStates.has(this.activeTabId)) {
      return this.activeTabId;
    }
    const tabId = this.pageDialogStates.keys().next().value as string | undefined;
    if (!tabId) {
      throw new McpToolError("no_dialog", "No dialog visible.");
    }
    return tabId;
  }

  private waitForDialog(tabId: string, timeoutMs: number): Promise<void> {
    if (this.pageDialogStates.has(tabId)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: DialogWaiter = {
        resolve: () => {
          if (waiter.timer) {
            clearTimeout(waiter.timer);
          }
          this.removeDialogWaiter(tabId, waiter);
          resolve();
        },
        reject: (error: Error) => {
          if (waiter.timer) {
            clearTimeout(waiter.timer);
          }
          this.removeDialogWaiter(tabId, waiter);
          reject(error);
        }
      };
      waiter.timer = setTimeout(() => waiter.reject?.(new Error("Timed out waiting for dialog.")), timeoutMs);
      const waiters = this.dialogWaiters.get(tabId) ?? new Set<DialogWaiter>();
      waiters.add(waiter);
      this.dialogWaiters.set(tabId, waiters);
    });
  }

  private resolveDialogWaiters(tabId: string): void {
    const waiters = this.dialogWaiters.get(tabId);
    if (!waiters) {
      return;
    }
    this.dialogWaiters.delete(tabId);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private removeDialogWaiter(tabId: string, waiter: DialogWaiter): void {
    const waiters = this.dialogWaiters.get(tabId);
    if (!waiters) {
      return;
    }
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.dialogWaiters.delete(tabId);
    }
  }

  private async actionPoint(tabId: string, target: ClickTarget): Promise<{ x: number; y: number }> {
    const source = "nodeToken" in target ? ACTION_POINT_EVALUATE_SOURCE : ACTION_POINT_BY_SELECTOR_SOURCE;
    const point = await evaluateBiDi<{ ok: boolean; reason?: string; x?: number; y?: number }>(
      this.client,
      tabId,
      source,
      this.targetArg(target)
    );
    if (!point.ok || point.x === undefined || point.y === undefined) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        isSelector
          ? `Element "${target.selector}" could not be found or is not visible.`
          : 'The referenced element is no longer valid. Call "browser_snapshot" again.'
      );
    }
    return { x: point.x, y: point.y };
  }

  private async sharedElementReference(
    tabId: string,
    target: ClickTarget
  ): Promise<{ sharedId: string; handle?: string }> {
    const reference = await evaluateBiDiRef(this.client, tabId, GET_ELEMENT_OBJECT_SOURCE, this.targetArg(target));
    if (!reference.sharedId) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        isSelector ? `Element "${target.selector}" could not be found.` : 'The referenced element is no longer valid.'
      );
    }
    return {
      sharedId: reference.sharedId,
      ...(reference.handle !== undefined ? { handle: reference.handle } : {})
    };
  }

  private async titleForContext(contextId: string): Promise<string> {
    try {
      return await evaluateBiDi<string>(
        this.client,
        contextId,
        String.raw`() => document.title || ""`
      );
    } catch {
      return "";
    }
  }

  private handleLogEntry(payload: unknown): void {
    const context = bidiLogContext(payload);
    if (!context) {
      return;
    }
    const log = payload as {
      args?: Array<{ value?: unknown; type?: string; unserializableValue?: string }>;
      level?: string;
      method?: string;
      source?: { realm?: string; context?: string | null };
      stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number }> };
      text?: string | null;
      timestamp?: number;
      type?: string;
    };
    const frame = log.stackTrace?.callFrames?.[0];
    const text = log.text ?? (log.args ? formatConsoleText(log.args) : "");
    const type = log.method ?? log.level ?? log.type ?? "log";
    const locationUrl = frame?.url ?? "";
    const lineNumber = frame?.lineNumber ?? 0;
    this.addConsoleMessage(context, {
      type,
      timestamp: normalizeConsoleTimestamp(log.timestamp),
      text,
      locationUrl,
      lineNumber,
      formattedText: formatConsoleMessage(type, text, locationUrl, lineNumber)
    });
  }

  private handleUserPromptOpened(payload: unknown): void {
    if (!payload || typeof payload !== "object" || !("context" in payload)) {
      return;
    }
    const event = payload as {
      context: string;
      defaultValue?: string;
      message?: string;
      type?: BrowserDialogState["type"];
    };
    this.pageDialogStates.set(event.context, {
      message: event.message ?? "",
      type: event.type ?? "alert",
      ...(event.defaultValue !== undefined ? { defaultPrompt: event.defaultValue } : {})
    });
    // 这里必须 resolve 对话框等待器：BiDi 的 click 会 race inputPerformActions
    // 与 waitForDialog（见 click 注释）。若不在此 resolve，alert() 触发后
    // waitForDialog 会一直 pending，click 永久挂起。CDP 侧的
    // javascriptDialogOpening 处理也调用了 resolveDialogWaiters，两侧需对齐。
    this.resolveDialogWaiters(event.context);
  }

  private handleNavigationStarted(payload: unknown): void {
    if (!payload || typeof payload !== "object" || !("context" in payload)) {
      return;
    }
    const event = payload as { context?: string };
    if (!event.context) {
      return;
    }
    this.ensurePageLoadState(event.context).loaded = false;
  }

  private handleBrowsingContextLoad(payload: unknown): void {
    if (!payload || typeof payload !== "object" || !("context" in payload)) {
      return;
    }
    const event = payload as { context?: string };
    if (!event.context) {
      return;
    }
    this.ensurePageLoadState(event.context).loaded = true;
  }

  private handleBeforeRequestSent(payload: unknown): void {
    const event = parseBidiNetworkEvent(payload);
    if (!event) {
      return;
    }
    const state = this.ensureNetworkState(event.context);
    const existing = state.byRequestId.get(event.request.request);
    const isRedirectHop = Boolean(event.redirectCount) && !!existing;
    const sequence = (state.requestSequenceByRequestId.get(event.request.request) ?? 0) + 1;
    state.requestSequenceByRequestId.set(event.request.request, sequence);
    const request: TrackedBrowserNetworkRequest = !isRedirectHop && existing ? existing : {
      index: state.requests.length + 1,
      requestId: event.request.request,
      requestKey: `${event.request.request}#${sequence}`,
      method: event.request.method,
      url: event.request.url,
      resourceType: normalizeResourceType(event.request.destination),
      requestHeaders: {},
    };
    request.requestKey ??= `${event.request.request}#${sequence}`;
    request.method = event.request.method;
    request.url = event.request.url;
    request.resourceType = normalizeResourceType(event.request.destination);
    request.requestHeaders = normalizeHeaders(bidiHeadersToRecord(event.request.headers));
    request.rawRequestHeaders = request.requestHeaders;
    // TODO(bidi): BiDi 的 network.beforeRequestSent 只给 bodySize，不内联 POST
    // body。这里只置了个空串占位（requestBody ??= ""），真实 POST 体从未填充，
    // 因此 browser_network_request 的 part="request-body" 在 BiDi 下只能拿到空串。
    // CDP 侧通过 Network.requestWillBeSent 的 request.postData 直接拿到 body。
    // BiDi 若要拿到 body 需另发 network.getRequestPostData 请求（Firefox 支持不稳），
    // 暂未实现 —— 这是已知缺口，等 geckodriver 稳定后再补。
    if (event.request.bodySize !== undefined && event.request.bodySize > 0) {
      request.requestBody ??= "";
    }
    if (!existing || isRedirectHop) {
      state.requests.push(request);
      state.byRequestId.set(event.request.request, request);
      state.byRequestKey.set(requestWaitKey(request), request);
      const requestsForId = state.requestsByRequestId.get(event.request.request) ?? [];
      requestsForId.push(request);
      state.requestsByRequestId.set(event.request.request, requestsForId);
      if (isRedirectHop && existing) {
        updateRedirectChain(state, existing, request);
      } else {
        request.finalRequestKey ??= requestWaitKey(request);
      }
    }
      const collectors = this.completionCollectorsByTabId.get(event.context);
      if (collectors?.size) {
        for (const collector of collectors) {
          collector.requestKeys.push(requestWaitKey(request));
          collector.liveRequests.push(ensureTrackedRequestObject(request));
        }
      }
    if (event.timestamp !== undefined) {
      state.startedAt.set(event.request.request, event.timestamp);
    }
  }

  private handleResponseStarted(payload: unknown): void {
    const event = parseBidiNetworkEvent(payload);
    if (!event?.response) {
      return;
    }
    const request = this.ensureNetworkRequest(event);
    setTrackedResponseMetadata(request, {
      status: event.response.status,
      statusText: event.response.statusText ?? "",
      headers: bidiHeadersToRecord(event.response.headers),
      mimeType: event.response.mimeType
    });
    setTrackedRawResponseMetadata(request, request.responseHeaders, event.response.headersSize);
    resolveResponseAvailable(this.ensureNetworkState(event.context), requestWaitKey(request));
  }

  private async handleResponseCompleted(payload: unknown): Promise<void> {
    const event = parseBidiNetworkEvent(payload);
    if (!event?.response) {
      return;
    }
    const request = this.ensureNetworkRequest(event);
    setTrackedResponseMetadata(request, {
      status: event.response.status,
      statusText: event.response.statusText ?? "",
      headers: bidiHeadersToRecord(event.response.headers),
      mimeType: event.response.mimeType
    });
    const startedAt = this.ensureNetworkState(event.context).startedAt.get(event.request.request);
    if (startedAt !== undefined && event.timestamp !== undefined) {
      request.durationMs = Math.round(event.timestamp - startedAt);
    }
    // TODO(bidi): BiDi 网络事件是乱序/延迟到达的，且 status 与 body 的可用时机
    // 不可靠。实测 Firefox：
    //   - beforeRequestSent 与 responseCompleted 之间存在竞态，waitForNetworkRequest
    //     在 body/status 尚未就绪时就可能匹配到请求并返回；
    //   - 随后再次 browser_network_requests 时，同一个 POST /api 请求有时会从列表
    //     里“消失”（疑似 responseCompleted 到达途中 ensureNetworkRequest 重建了条目
    //     或上下文切换所致，未完全定位）。
    // 这导致 BiDi 下无法像 CDP 那样做强一致的网络契约断言（=> [status] OK 全匹配）。
    // 这里仅在 responseCompleted 时尽力补 body；status 缺失的窗口由调用方容忍。
    // KNOWN-UNRESOLVED: BiDi 网络捕获的一致性问题，需等 Firefox/geckodriver 事件
    // 时序稳定后再追，或改用 network.getDataCollector 统一采集。
    if (canReadResponseBody(request)) {
      const body = await this.getResponseBody(event.request.request).catch(() => undefined);
      if (body !== undefined) {
        setTrackedResponseBody(request, body);
      }
    }
    const state = this.ensureNetworkState(event.context);
    resolveRequestFinished(state, requestWaitKey(request));
    resolveLoadingDone(state, requestWaitKey(request), true);
  }

  private handleFetchError(payload: unknown): void {
    const event = parseBidiNetworkEvent(payload);
    if (!event) {
      return;
    }
    const request = this.ensureNetworkRequest(event);
    setTrackedFailureText(request, event.errorText ?? "Unknown error");
    if (!isTrackedResponseAvailable(request) && isTrackedRawRequestHeadersMissing(request)) {
      setTrackedRawRequestHeaders(request, request.requestHeaders);
    }
    const startedAt = this.ensureNetworkState(event.context).startedAt.get(event.request.request);
    if (startedAt !== undefined && event.timestamp !== undefined) {
      request.durationMs = Math.round(event.timestamp - startedAt);
    } else if (request.status !== undefined) {
      request.durationMs = -1;
    }
    const state = this.ensureNetworkState(event.context);
    resolveResponseAvailable(state, requestWaitKey(request));
    resolveRequestFinished(state, requestWaitKey(request));
    resolveLoadingDone(state, requestWaitKey(request), false);
  }

  private ensureNetworkRequest(event: BidiNetworkEvent): BrowserNetworkRequest {
    const state = this.ensureNetworkState(event.context);
    let request = state.byRequestId.get(event.request.request);
    if (!request) {
      request = {
        index: state.requests.length + 1,
        requestId: event.request.request,
        requestKey: `${event.request.request}#${(state.requestSequenceByRequestId.get(event.request.request) ?? 0) + 1}`,
        method: event.request.method,
        url: event.request.url,
        resourceType: normalizeResourceType(event.request.destination),
        isNavigationRequest: normalizeResourceType(event.request.destination) === "document",
        requestHeaders: normalizeHeaders(bidiHeadersToRecord(event.request.headers)),
      };
      state.requests.push(request);
      state.byRequestId.set(event.request.request, request);
      state.byRequestKey.set(requestWaitKey(request), request);
      const requestsForId = state.requestsByRequestId.get(event.request.request) ?? [];
      requestsForId.push(request);
      state.requestsByRequestId.set(event.request.request, requestsForId);
    }
    return request;
  }

  private ensurePageLoadState(tabId: string): { loaded: boolean } {
    let state = this.pageLoadStates.get(tabId);
    if (!state) {
      state = { loaded: false };
      this.pageLoadStates.set(tabId, state);
    }
    return state;
  }

  private async getResponseBody(requestId: string): Promise<string | undefined> {
    if (!this.responseDataCollector) {
      return undefined;
    }
    const response = await this.client.networkGetData({
      collector: this.responseDataCollector,
      dataType: "response",
      request: requestId
    }) as { bytes?: BidiBytesValue };
    return response.bytes ? bidiBytesValueToString(response.bytes) : undefined;
  }

  private ensureConsoleState(tabId: string): BrowserConsoleState {
    let state = this.pageConsoleStates.get(tabId);
    if (!state) {
      state = {
        messages: [],
        nextMessageIndex: 0,
        logStartTime: Date.now(),
        logLine: 0
      };
      this.pageConsoleStates.set(tabId, state);
    }
    return state;
  }

  private ensureNetworkState(tabId: string): BrowserNetworkState {
    let state = this.pageNetworkStates.get(tabId);
    if (!state) {
      state = createBrowserNetworkState();
      this.pageNetworkStates.set(tabId, state);
    }
    return state;
  }

  private resetConsole(tabId: string): void {
    const previousNetworkState = this.pageNetworkStates.get(tabId);
    if (previousNetworkState) {
      settleOutstandingNetworkWaits(previousNetworkState);
    }
    this.pageConsoleStates.set(tabId, {
      messages: [],
      nextMessageIndex: 0,
      logStartTime: Date.now(),
      logLine: 0
    });
    this.pageNetworkStates.set(tabId, createBrowserNetworkState());
    this.pageDialogStates.delete(tabId);
  }

  private addConsoleMessage(tabId: string, message: BrowserConsoleMessage): void {
    const state = this.ensureConsoleState(tabId);
    if (!shouldIncludeConsoleMessage(message.type)) {
      return;
    }
    state.messages.push(message);
  }

  private consoleSummary(tabId: string): { total: number; errors: number; warnings: number } {
    const messages = this.ensureConsoleState(tabId).messages;
    let errors = 0;
    let warnings = 0;
    for (const message of messages) {
      if (message.type === "error" || message.type === "assert") {
        errors++;
      } else if (message.type === "warning") {
        warnings++;
      }
    }
    return { total: messages.length, errors, warnings };
  }

  private async takeConsoleLink(tabId: string): Promise<string | undefined> {
    const state = this.ensureConsoleState(tabId);
    const messages = state.messages.slice(state.nextMessageIndex);
    if (messages.length === 0) {
      return undefined;
    }

    state.logFile ??= path.join(
      this.tempDir,
      `console-${new Date(state.logStartTime).toISOString().replace(/[:.]/g, "-")}.log`
    );
    await mkdir(path.dirname(state.logFile), { recursive: true });

    const fromLine = state.logLine + 1;
    for (const message of messages) {
      const relativeTime = Math.round(message.timestamp - state.logStartTime);
      const logLine = `[${String(relativeTime).padStart(8, " ")}ms] ${message.formattedText}\n`;
      await appendFile(state.logFile, logLine);
      state.logLine += logLine.split("\n").length - 1;
    }
    state.nextMessageIndex = state.messages.length;

    const lineRange = fromLine === state.logLine ? `#L${fromLine}` : `#L${fromLine}-L${state.logLine}`;
    return `${state.logFile}${lineRange}`;
  }
}

function normalizeFirefoxBidiEndpoint(endpoint: string, sessionId?: string): string {
  const url = new URL(endpoint);
  if (sessionId) {
    url.pathname = `/session/${sessionId}`;
    return url.toString();
  }
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/session";
  }
  return url.toString();
}

async function ensureMcpBiDiSession(
  client: BidiProtocolClient,
  endpoint: string,
  sessionId?: string
): Promise<boolean> {
  await client.sessionStatus({});

  if (sessionId || isSessionSpecificFirefoxBidiEndpoint(endpoint)) {
    return false;
  }

  try {
    await client.browsingContextGetTree({});
    return false;
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (
      !message.includes("session does not exist")
      && !message.includes("invalid session id")
      && !message.includes("not active")
    ) {
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

function isSessionSpecificFirefoxBidiEndpoint(endpoint: string): boolean {
  return /^\/session\/[^/]+$/.test(new URL(endpoint).pathname);
}

export async function connectBrowserSession(
  args: RoxyBrowserConnectArgs
): Promise<ConnectedBrowserSession> {
  if (args.protocol === "cdp") {
    return CdpConnectedBrowserSession.connect(args);
  }

  return BidiConnectedBrowserSession.connect(args);
}
