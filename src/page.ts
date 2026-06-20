import { STATUS_CODES } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { createApiResponse, fetchWithRetries, RoxyAPIRequestContext } from "./apiRequestContext.js";
import {
  RoxyElementHandle,
  type ElementHandleFrameResolver,
  serializeEvaluationArgument
} from "./elementHandle.js";
import { TimeoutError } from "./errors.js";
import { assertMaxArguments, serializePageFunction } from "./evaluation.js";
import { RoxyFrame, type RoxyFrameSnapshot } from "./frame.js";
import { DefaultHumanController } from "./human/controller.js";
import { normalizeExtraHTTPHeaders } from "./httpHeaders.js";
import { setInputFilesOnElement, type InputFiles } from "./inputFiles.js";
import { RoxyJSHandle, createRemoteJSHandle } from "./jsHandle.js";
import { createSmartHandle } from "./jsHandle.js";
import { RoxyLocator } from "./locator.js";
import { RoxyScreencast } from "./screencast.js";
import { preparePageForScreenshot } from "./screenshotPreparation.js";
import { determineScreenshotType, normalizePageScreenshotOptions, validateScreenshotOptions } from "./screenshotOptions.js";
import { isRegExp, isURLPattern, resolveGlobToRegexPattern, type URLMatch, urlMatches } from "./urlMatch.js";
import { RoxyVideo } from "./video.js";
import { RoxyWorker } from "./worker.js";
import { RoxyClock, createUnsupportedClockDelegate } from "./clock.js";
import {
  parseEvaluationResultValue,
  serializeAsCallArgumentNoHandles,
  type SerializedValue
} from "./utilityScriptSerializers.js";
import type { RoxyBrowserContext } from "./browserContext.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";
import type {
  LocatorSelector,
  ProtocolElementHandleAdapter,
  ProtocolElementHandleReference,
  ProtocolLocatorAdapter,
  ProtocolPageAdapter
} from "./protocol/adapter.js";
import { looksLikeFunctionExpression } from "./protocol/evaluate.js";
import type { RoutedRequestCall, RoutedRequestDecision, RoutedResponseData } from "./protocol/routing.js";
import { parseSelectorChain } from "./selectors.js";
import type {
  PageEventListener,
  PageEventMap,
  PageEventName,
  PageEventPredicate,
  ConsoleMessage,
  PageDialog,
  PageRequest,
  PageConsoleMessage,
  PageErrorEntry,
  PageResponse,
  RawPageWebSocketEvent,
  RawPageEventMap,
  RawPageEventListener,
  RawPageEventName
} from "./types/events.js";
import type {
  BindingSource,
  ElementArrayCallback,
  ElementCallback,
  Disposable,
  ElementHandle,
  ElementHandleForTag,
  FileChooser,
  Frame,
  FrameLocator,
  Locator,
  Page,
  Request,
  Response,
  ResolvedAriaRef,
  Route,
  BrowserContext,
  APIRequestContext,
  APIResponse,
  Clock,
  Coverage,
  Dialog,
  Download,
  EvaluationArgument,
  JSHandle,
  Keyboard,
  Mouse,
  PageFunction,
  PageFunctionOn,
  Screencast,
  SmartHandle,
  Touchscreen,
  Video,
  WebSocket,
  WebStorage,
  WebSocketRoute,
  Worker
} from "./types/api.js";
import type {
  AddScriptTagOptions,
  AddStyleTagOptions,
  AddLocatorHandlerOptions,
  AriaSnapshotOptions,
  BrowserContextOptions,
  ClickOptions,
  DragAndDropOptions,
  DispatchEventOptions,
  EmulateMediaOptions,
  FillOptions,
  GetByAltTextOptions,
  GetByLabelOptions,
  GetByPlaceholderOptions,
  GetByRoleOptions,
  GetByTextOptions,
  GetByTitleOptions,
  HoverOptions,
  LoadState,
  PageCloseOptions,
  PageGotoOptions,
  PageSetContentOptions,
  PdfOptions,
  PressOptions,
  SetInputFilesOptions,
  ScreenshotOptions,
  TapOptions,
  ScreenshotType,
  TypeOptions,
  ViewportSize,
  WaitForNavigationOptions,
  WaitForURLOptions,
  WaitForSelectorOptions,
  SelectorStrictOptions
} from "./types/options.js";

type LocatorOptions = {
  has?: Locator;
  hasNot?: Locator;
  hasNotText?: string | RegExp;
  hasText?: string | RegExp;
};
type PageWaitForFunctionOptions = {
  polling?: number | "raf";
  timeout?: number;
};
type PlaywrightFilePayload = { name: string; mimeType: string; buffer: Buffer };
type PlaywrightInputFiles = string | ReadonlyArray<string> | PlaywrightFilePayload | ReadonlyArray<PlaywrightFilePayload>;
type PlaywrightSelectOptionValue = { value?: string; label?: string; index?: number };
type PlaywrightSelectOptionValues =
  | null
  | string
  | ElementHandle
  | ReadonlyArray<string>
  | PlaywrightSelectOptionValue
  | ReadonlyArray<ElementHandle>
  | ReadonlyArray<PlaywrightSelectOptionValue>;

interface ListenerEntry<K extends PageEventName> {
  original: PageEventListener<K>;
  wrapped: PageEventListener<K>;
}

type RemoveAllListenersBehavior = "default" | "wait" | "ignoreErrors";

type InternalWaitForEventOptions<K extends PageEventName> = {
  logLine?: string;
  predicate?: PageEventPredicate<K>;
  timeout?: number;
};

interface PendingFileChooserState {
  chooser: RoxyFileChooser;
  handleId: string;
}

interface FileChooserBridgeEvent {
  frameId: string | null;
  handleId: string;
  isMultiple: boolean;
}

interface LocatorHandlerEntry {
  key: string;
  locator: Locator;
  handler: (locator: Locator) => Promise<any>;
  noWaitAfter: boolean;
  remainingTimes: number | null;
  running: boolean;
}

interface PickLocatorState {
  reject: (error: Error) => void;
  resolve: (locator: Locator) => void;
}

class RoxyFileChooser implements FileChooser {
  constructor(
    private readonly roxyPage: RoxyPage,
    private readonly multiple: boolean,
    private readonly input: ElementHandle
  ) {}

  element(): ElementHandle {
    return this.input;
  }

  isMultiple(): boolean {
    return this.multiple;
  }

  page(): Page {
    return this.roxyPage;
  }

  async setFiles(
    files: InputFiles,
    options?: SetInputFilesOptions
  ): Promise<void> {
    await this.roxyPage.setInputFiles(this.input, files, options);
  }
}

interface PauseControllerState {
  id: string;
  previousPlaywright: unknown;
  resumed: boolean;
}

interface ExposedBindingEntry {
  kind: "binding" | "function";
  callback: Function;
}

interface ExposedBindingCall {
  frameId: string | null;
  id: string;
  name: string;
  serializedArgs: SerializedValue[];
  targetFrame: RoxyFrame | null;
}

type RouteMatcher = URLMatch;

interface RouteHandlerEntry {
  matcher: RouteMatcher;
  handler: (route: Route, request: Request) => Promise<any> | any;
  remainingTimes: number | null;
}

interface WebSocketRouteHandlerEntry {
  matcher: RouteMatcher;
  handler: (websocketroute: WebSocketRoute) => Promise<any> | any;
}

interface RoutedWebSocketOpenCall {
  id: string;
  protocols: string[];
  url: string;
}

interface RoutedWebSocketEventCall {
  code?: number;
  id: string;
  kind: "close" | "message";
  message?: string;
  reason?: string;
}

type RoutedWebSocketOpenDecision =
  | { action: "mock" }
  | { action: "passthrough" };

interface RoutedWebSocketCommand {
  code?: number;
  kind: "close" | "message";
  message?: string;
  reason?: string;
}

interface HostedWebSocketRouteState {
  commands: RoutedWebSocketCommand[];
  originalCloseHandler: ((code: number | undefined, reason: string | undefined) => any) | null;
  id: string;
  originalMessageHandler: ((message: string | Buffer) => any) | null;
  protocols: string[];
  serverCloseHandler: ((code: number | undefined, reason: string | undefined) => any) | null;
  serverConnected: boolean;
  serverMessageHandler: ((message: string | Buffer) => any) | null;
  url: string;
}

type WebSocketEventMap = {
  close: WebSocket;
  framereceived: { payload: string | Buffer };
  framesent: { payload: string | Buffer };
  socketerror: string;
};

class RoxyWebSocket implements WebSocket {
  private closed = false;
  private readonly listeners = new Map<keyof WebSocketEventMap, Set<(payload: any) => any>>();

  constructor(
    private readonly roxyPage: RoxyPage,
    private readonly socketUrl: string
  ) {}

  addListener<K extends keyof WebSocketEventMap>(
    event: K,
    listener: (payload: WebSocketEventMap[K]) => any
  ): this {
    return this.on(event, listener);
  }

  isClosed(): boolean {
    return this.closed;
  }

  off<K extends keyof WebSocketEventMap>(
    event: K,
    listener: (payload: WebSocketEventMap[K]) => any
  ): this {
    return this.removeListener(event, listener);
  }

  on<K extends keyof WebSocketEventMap>(
    event: K,
    listener: (payload: WebSocketEventMap[K]) => any
  ): this {
    const entries = this.listeners.get(event) ?? new Set<(payload: any) => any>();
    entries.add(listener);
    this.listeners.set(event, entries);
    return this;
  }

  once<K extends keyof WebSocketEventMap>(
    event: K,
    listener: (payload: WebSocketEventMap[K]) => any
  ): this {
    const wrapped = ((payload: WebSocketEventMap[K]) => {
      this.removeListener(event, wrapped);
      listener(payload);
    }) as (payload: WebSocketEventMap[K]) => any;
    return this.on(event, wrapped);
  }

  prependListener<K extends keyof WebSocketEventMap>(
    event: K,
    listener: (payload: WebSocketEventMap[K]) => any
  ): this {
    const entries = this.listeners.get(event) ?? new Set<(payload: any) => any>();
    this.listeners.set(event, new Set<(payload: any) => any>([listener, ...entries]));
    return this;
  }

  removeListener<K extends keyof WebSocketEventMap>(
    event: K,
    listener: (payload: WebSocketEventMap[K]) => any
  ): this {
    const entries = this.listeners.get(event);
    entries?.delete(listener);
    if (entries?.size === 0) {
      this.listeners.delete(event);
    }
    return this;
  }

  url(): string {
    return this.socketUrl;
  }

  waitForEvent<K extends keyof WebSocketEventMap>(
    event: K,
    optionsOrPredicate?:
      | ((payload: WebSocketEventMap[K]) => boolean | Promise<boolean>)
      | {
          predicate?: (payload: WebSocketEventMap[K]) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<WebSocketEventMap[K]> {
    const predicate =
      typeof optionsOrPredicate === "function"
        ? optionsOrPredicate
        : optionsOrPredicate?.predicate;
    const timeout =
      typeof optionsOrPredicate === "function"
        ? this.roxyPage.defaultTimeout()
        : optionsOrPredicate?.timeout ?? this.roxyPage.defaultTimeout();

    return new Promise<WebSocketEventMap[K]>((resolve, reject) => {
      let settled = false;
      const timer =
        timeout === 0
          ? null
          : setTimeout(() => {
              cleanup();
              reject(new TimeoutError(`Timeout ${timeout}ms exceeded while waiting for event "${event}"`));
            }, timeout);

      const cleanup = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        this.removeListener(event, listener);
        if (event !== "socketerror") {
          this.removeListener("socketerror", socketErrorListener);
        }
        if (event !== "close") {
          this.removeListener("close", closeListener);
        }
        this.roxyPage.removeListener("close", pageCloseListener);
      };

      const listener = (async (payload: WebSocketEventMap[K]) => {
        try {
          const accepted = predicate ? await predicate(payload) : true;
          if (!accepted) {
            return;
          }
          cleanup();
          resolve(payload);
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }) as (payload: WebSocketEventMap[K]) => any;
      const socketErrorListener = ((message: string) => {
        cleanup();
        reject(new Error(message || "Socket error"));
      }) as (payload: WebSocketEventMap["socketerror"]) => any;
      const closeListener = (() => {
        cleanup();
        reject(new Error("Socket closed"));
      }) as (payload: WebSocketEventMap["close"]) => any;
      const pageCloseListener = (() => {
        cleanup();
        reject(new Error("Target page, context or browser has been closed"));
      }) as PageEventListener<"close">;

      this.on(event, listener);
      if (event !== "socketerror") {
        this.on("socketerror", socketErrorListener);
      }
      if (event !== "close") {
        this.on("close", closeListener);
      }
      this.roxyPage.on("close", pageCloseListener);
    });
  }

  emitClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit("close", this);
  }

  emitFrameReceived(payload: string | Buffer): void {
    this.emit("framereceived", { payload });
  }

  emitFrameSent(payload: string | Buffer): void {
    this.emit("framesent", { payload });
  }

  emitSocketError(message: string): void {
    this.emit("socketerror", message);
  }

  private emit<K extends keyof WebSocketEventMap>(event: K, payload: WebSocketEventMap[K]): void {
    for (const listener of Array.from(this.listeners.get(event) ?? [])) {
      listener(payload);
    }
  }
}

const DEFAULT_CONSOLE_LOCATION = {
  column: 0,
  columnNumber: 0,
  line: 0,
  lineNumber: 0,
  url: ""
} as const;

interface ObservedRequestState {
  failure: { errorText: string } | null;
  frameId: string | null;
  headerEntries: Array<{ name: string; value: string }>;
  headers: Record<string, string>;
  redirectedFrom: ObservedRequestState | null;
  redirectedTo: ObservedRequestState | null;
  requestId: string | null;
  request: Request;
  resourceType: string;
  response: Response | null;
  responsePromise: Promise<Response | null>;
  responsePromiseResolve: (value: Response | null) => void;
  timingStartTime: number;
  url: string;
  method: string;
  isNavigationRequest: boolean;
  postDataBuffer: Buffer | null;
  postDataText: string | null;
}

interface HarRouteEntry {
  matcher?: string | RegExp;
  notFound: "abort" | "fallback";
  entries: Array<{
    method: string;
    requestUrl: string;
    status: number;
    statusText?: string;
    responseHeaders: Record<string, string>;
    responseBody: string;
    responseBodyBufferBase64?: string;
    redirectURL?: string;
  }>;
}

const DEFAULT_EVENT_TIMEOUT_MS = 30_000;
const INTERNAL_RECORDED_EVENTS = [
  "console",
  "domcontentloaded",
  "frameattached",
  "framedetached",
  "framenavigated",
  "load",
  "pageerror",
  "request",
  "requestfailed",
  "requestfinished",
  "response"
] as const satisfies ReadonlyArray<Extract<PageEventName, RawPageEventName>>;

function isAdapterBackedPageEvent(event: PageEventName): event is Extract<PageEventName, RawPageEventName> {
  return event !== "popup" && event !== "filechooser";
}

function installFileChooserBridgeRuntime(frameId?: string | null) {
  if (frameId !== undefined) {
    (globalThis as typeof globalThis & {
      __roxyFileChooserFrameId?: string | null;
    }).__roxyFileChooserFrameId = frameId;
  }
  const resolveBridgeScope = (): (typeof globalThis & Record<string, unknown>) => {
    try {
      return (globalThis.top ?? globalThis) as typeof globalThis & Record<string, unknown>;
    } catch {
      return globalThis as typeof globalThis & Record<string, unknown>;
    }
  };
  const bridgeScope = resolveBridgeScope() as typeof globalThis & {
    __roxyCreateHandleFromElement?: (
      element: Element | null
    ) => { frameId: string | null; handleId: string } | null;
    __roxyFileChooserPatchedWindows?: WeakSet<object>;
    __roxyOnFileChooserOpened?: (payload: FileChooserBridgeEvent) => Promise<void>;
    __roxyHandleStore?: Record<string, Element | undefined>;
    __roxyNextHandleId?: number;
  };

  bridgeScope.__roxyHandleStore ??= {};
  bridgeScope.__roxyNextHandleId ??= 0;
  bridgeScope.__roxyFileChooserPatchedWindows ??= new WeakSet<object>();
  (globalThis as typeof globalThis & {
    __roxyFileChooserRuntimeInstalled?: boolean;
  }).__roxyFileChooserRuntimeInstalled = true;
  bridgeScope.__roxyCreateHandleFromElement = (element) => {
    if (!(element instanceof Element)) {
      return null;
    }
    const handleId = `handle:${++bridgeScope.__roxyNextHandleId!}`;
    bridgeScope.__roxyHandleStore![handleId] = element;
    const frameId = (globalThis as typeof globalThis & {
      __roxyFileChooserFrameId?: string | null;
    }).__roxyFileChooserFrameId
      ?? (globalThis.frameElement as Element | null)?.getAttribute("data-roxy-frame-id")
      ?? null;
    return {
      frameId,
      handleId
    };
  };

  const currentWindow = globalThis as unknown as object;
  if (bridgeScope.__roxyFileChooserPatchedWindows.has(currentWindow)) {
    return;
  }
  bridgeScope.__roxyFileChooserPatchedWindows.add(currentWindow);

  const maybeDispatchFileChooser = (input: HTMLInputElement) => {
    if (input.type !== "file") {
      return;
    }
    const dedupeKey = "__roxyFileChooserDispatchScheduled";
    if ((input as HTMLInputElement & {
      [dedupeKey]?: boolean;
    })[dedupeKey]) {
      return;
    }
    (input as HTMLInputElement & {
      [dedupeKey]?: boolean;
    })[dedupeKey] = true;
    const handle = bridgeScope.__roxyCreateHandleFromElement?.(input);
    if (!handle) {
      delete (input as HTMLInputElement & {
        [dedupeKey]?: boolean;
      })[dedupeKey];
      return;
    }
    setTimeout(() => {
      delete (input as HTMLInputElement & {
        [dedupeKey]?: boolean;
      })[dedupeKey];
      void bridgeScope.__roxyOnFileChooserOpened?.({
        frameId: handle.frameId,
        handleId: handle.handleId,
        isMultiple: input.multiple || input.webkitdirectory
      });
    }, 0);
  };

  const originalClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
    maybeDispatchFileChooser(this);
    return originalClick.call(this);
  };

  globalThis.addEventListener(
    "click",
    (event) => {
      const path = event.composedPath?.() ?? [];
      const target = path.find((entry) => entry instanceof HTMLInputElement);
      if (target instanceof HTMLInputElement) {
        maybeDispatchFileChooser(target);
      }
    },
    { capture: true }
  );
}

function hasFileChooserBridgeRuntimeInstalled() {
  return Boolean((globalThis as typeof globalThis & {
    __roxyFileChooserRuntimeInstalled?: boolean;
  }).__roxyFileChooserRuntimeInstalled);
}

class RoxyKeyboard implements Keyboard {
  constructor(private readonly adapter: ProtocolPageAdapter) {}

  async down(key: string): Promise<void> {
    await this.adapter.keyboardDown(key);
  }

  async insertText(text: string): Promise<void> {
    await this.adapter.keyboardInsertText(text);
  }

  async press(
    key: string,
    options?: {
      delay?: number;
    }
  ): Promise<void> {
    await this.adapter.keyboardPress(key, options);
  }

  async type(
    text: string,
    options?: {
      delay?: number;
    }
  ): Promise<void> {
    await this.adapter.keyboardType(text, options);
  }

  async up(key: string): Promise<void> {
    await this.adapter.keyboardUp(key);
  }
}

class RoxyMouse implements Mouse {
  constructor(private readonly adapter: ProtocolPageAdapter) {}

  async click(
    x: number,
    y: number,
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
      delay?: number;
    }
  ): Promise<void> {
    await this.adapter.mouseClick(x, y, options);
  }

  async dblclick(
    x: number,
    y: number,
    options?: {
      button?: "left" | "right" | "middle";
      delay?: number;
    }
  ): Promise<void> {
    await this.adapter.mouseDblclick(x, y, options);
  }

  async down(
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
    }
  ): Promise<void> {
    await this.adapter.mouseDown(options);
  }

  async move(
    x: number,
    y: number,
    options?: {
      steps?: number;
    }
  ): Promise<void> {
    await this.adapter.mouseMove(x, y, options);
  }

  async up(
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
    }
  ): Promise<void> {
    await this.adapter.mouseUp(options);
  }

  async wheel(deltaX: number, deltaY: number): Promise<void> {
    await this.adapter.mouseWheel(deltaX, deltaY);
  }
}

class RoxyTouchscreen implements Touchscreen {
  constructor(private readonly adapter: ProtocolPageAdapter) {}

  async tap(x: number, y: number): Promise<void> {
    await this.adapter.touchscreenTap(x, y);
  }
}

class RoxyWebStorage implements WebStorage {
  constructor(
    private readonly page: RoxyPage,
    private readonly storageName: "localStorage" | "sessionStorage"
  ) {}

  async clear(): Promise<void> {
    await this.page.evaluate(({ storageName }) => {
      globalThis[storageName].clear();
    }, { storageName: this.storageName });
  }

  async getItem(name: string): Promise<null | string> {
    return this.page.evaluate(({ name: itemName, storageName }) => {
      return globalThis[storageName].getItem(itemName);
    }, { name, storageName: this.storageName });
  }

  async items(): Promise<Array<{ name: string; value: string }>> {
    return this.page.evaluate(({ storageName }) => {
      const storage = globalThis[storageName];
      const entries = [];
      for (let index = 0; index < storage.length; index += 1) {
        const name = storage.key(index);
        if (name !== null) {
          entries.push({
            name,
            value: storage.getItem(name) ?? ""
          });
        }
      }
      return entries;
    }, { storageName: this.storageName });
  }

  async removeItem(name: string): Promise<void> {
    await this.page.evaluate(({ name: itemName, storageName }) => {
      globalThis[storageName].removeItem(itemName);
    }, { name, storageName: this.storageName });
  }

  async setItem(name: string, value: string): Promise<void> {
    await this.page.evaluate(({ name: itemName, storageName, value: itemValue }) => {
      globalThis[storageName].setItem(itemName, itemValue);
    }, { name, storageName: this.storageName, value });
  }
}

class UnsupportedCoverage implements Coverage {
  constructor(private readonly adapter: ProtocolPageAdapter) {}

  async startCSSCoverage(options?: { resetOnNavigation?: boolean }): Promise<void> {
    await this.adapter.startCSSCoverage(options);
  }

  async startJSCoverage(
    options?: {
      reportAnonymousScripts?: boolean;
      resetOnNavigation?: boolean;
    }
  ): Promise<void> {
    await this.adapter.startJSCoverage(options);
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
    return this.adapter.stopCSSCoverage();
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
    return this.adapter.stopJSCoverage();
  }
}

export class RoxyPage implements Page, ElementHandleFrameResolver {
  readonly clock: Clock;
  readonly coverage: Coverage;
  readonly keyboard: Keyboard;
  readonly localStorage: WebStorage;
  readonly mouse: Mouse;
  readonly request: APIRequestContext;
  readonly screencast: Screencast;
  readonly sessionStorage: WebStorage;
  readonly touchscreen: Touchscreen;
  private readonly humanController: DefaultHumanController;
  private readonly listeners = new Map<PageEventName, Set<ListenerEntry<PageEventName>>>();
  private readonly adapterDisposers = new Map<PageEventName, () => void>();
  private readonly pendingHandlers = new Map<PageEventName, Set<Promise<void>>>();
  private rejectionHandler: ((error: Error) => void) | undefined;
  private readonly internalDisposers = new Map<PageEventName, () => void>();
  private closed = false;
  private closeReason: string | undefined;
  private defaultTimeoutMs = DEFAULT_EVENT_TIMEOUT_MS;
  private defaultNavigationTimeoutMs = DEFAULT_EVENT_TIMEOUT_MS;
  private currentViewportSize: ViewportSize | null = null;
  private readonly consoleMessageHistory: PageConsoleMessage[] = [];
  private readonly consoleMessageHistorySinceNavigation: PageConsoleMessage[] = [];
  private readonly pageErrorHistory: PageErrorEntry[] = [];
  private readonly pageErrorHistorySinceNavigation: PageErrorEntry[] = [];
  private readonly requestHistory: Request[] = [];
  private readonly recordedRequests = new WeakSet<Request>();
  private readonly activeRequests = new Map<string, Request[]>();
  private readonly observedRequestsById = new Map<string, ObservedRequestState>();
  private readonly observedRequestsByUrl = new Map<string, ObservedRequestState[]>();
  private readonly pendingRoutedRequestStates = new Map<string, RoutedRequestCall>();
  private readonly redirectTargets = new Map<string, ObservedRequestState[]>();
  private readonly normalizedEventPayloads = new WeakMap<object, unknown>();
  private readonly nativeFrameBindings = new Map<string, string>();
  private readonly frameMap = new Map<string, RoxyFrame>();
  private readonly frameOrder: string[] = ["main"];
  private frameSnapshotRefreshInProgress = false;
  private openerPage: Page | null = null;
  private pauseSequence = 0;
  private readonly pageWorkers: Worker[] = [];
  private pageVideo: Video | null = null;
  private stopPageVideoRecording: (() => Promise<void>) | null = null;
  private rejectPageVideoRecording: ((error: unknown) => void) | null = null;
  private pageVideoFinalizePromise: Promise<void> | null = null;
  private emulatedMedia: EmulateMediaOptions = {};
  private readonly exposedBindings = new Map<string, ExposedBindingEntry>();
  private readonly locatorHandlers: LocatorHandlerEntry[] = [];
  private locatorHandlerRunningCounter = 0;
  private pickLocatorState: PickLocatorState | null = null;
  private bindingPumpStarted = false;
  private fileChooserBridgeInstalled = false;
  private fileChooserInterceptionPromise: Promise<void> | null = null;
  private readonly pendingFileChoosers: PendingFileChooserState[] = [];
  private routeInterceptorsInstalled = false;
  private routePumpStarted = false;
  private readonly routeHandlers: RouteHandlerEntry[] = [];
  private readonly websocketRouteHandlers: WebSocketRouteHandlerEntry[] = [];
  private readonly webSockets = new Map<string, RoxyWebSocket>();
  private readonly hostedWebSocketRoutes = new Map<string, HostedWebSocketRouteState>();
  private readonly harRoutes: HarRouteEntry[] = [];
  private readonly activeRouteDispatches = new Set<Promise<void>>();
  private readonly routeMatcherIds = new WeakMap<object, string>();
  private nextRouteMatcherId = 0;
  private screenshotTaskChain: Promise<unknown> = Promise.resolve();
  private readonly detachedContextFallback: BrowserContext = {
    clock: new RoxyClock(createUnsupportedClockDelegate("page.clock")),
    request: new RoxyAPIRequestContext(),
    newPage: async () => {
      throw new Error("Page is not attached to a browser context.");
    },
    pages: () => [],
    setExtraHTTPHeaders: async () => {
      throw new Error("Page is not attached to a browser context.");
    },
    storageState: async () => ({
      cookies: [],
      origins: []
    }),
    on: () => this.detachedContextFallback,
    once: () => this.detachedContextFallback,
    addListener: () => this.detachedContextFallback,
    removeListener: () => this.detachedContextFallback,
    off: () => this.detachedContextFallback,
    waitForEvent: async () => {
      throw new Error("Page is not attached to a browser context.");
    },
    close: async () => {}
  };

  constructor(
    private readonly adapter: ProtocolPageAdapter,
    private readonly humanDefaults: ResolvedHumanizationOptions,
    private readonly browserContext?: RoxyBrowserContext,
    private readonly contextOptions: BrowserContextOptions = {}
  ) {
    this.humanController = new DefaultHumanController(humanDefaults);
    this.clock = browserContext?.clock ?? new RoxyClock(createUnsupportedClockDelegate("page.clock"));
    this.coverage = new UnsupportedCoverage(adapter);
    this.keyboard = new RoxyKeyboard(adapter);
    this.localStorage = new RoxyWebStorage(this, "localStorage");
    this.mouse = new RoxyMouse(adapter);
    this.request = browserContext?.request ?? new RoxyAPIRequestContext();
    this.screencast = new RoxyScreencast(adapter);
    this.sessionStorage = new RoxyWebStorage(this, "sessionStorage");
    this.touchscreen = new RoxyTouchscreen(adapter);
    this.currentViewportSize = adapter.viewportSize();
    this.frameMap.set(
      "main",
      new RoxyFrame(this, {
        id: "main",
        name: "",
        url: "about:blank",
        parentId: null,
        referenceChain: [],
        ownerElementChain: []
      })
    );
    this.initializeInternalEventRecording();
    const disposeClose = this.adapter.on("close", () => {
      void this.handleAdapterClosed();
    });
    this.internalDisposers.set("close", disposeClose);
  }

  async addInitScript<Arg>(script: PageFunction<Arg, any>|{ path?: string, content?: string }, arg?: Arg): Promise<Disposable>;
  async addInitScript<Arg>(script: PageFunction<Arg, any> | { path?: string; content?: string }, arg?: Arg): Promise<Disposable> {
    const source = await evaluationScript(script, arg as any);
    return this.adapter.addInitScript(source);
  }

  async addLocatorHandler(
    locator: Locator,
    handler: (locator: Locator) => Promise<any>,
    options: AddLocatorHandlerOptions = {}
  ): Promise<void> {
    const key = this.locatorKey(locator);
    this.locatorHandlers.push({
      key,
      locator,
      handler,
      noWaitAfter: options.noWaitAfter ?? false,
      remainingTimes: options.times ?? null,
      running: false
    });
  }

  async exposeBinding(
    name: string,
    playwrightBinding: (source: BindingSource, ...args: any[]) => any
  ): Promise<Disposable> {
    return this.registerExposedBinding(name, {
      kind: "binding",
      callback: playwrightBinding
    }, "page.exposeBinding");
  }

  async exposeFunction(name: string, callback: Function): Promise<Disposable> {
    return this.registerExposedBinding(name, {
      kind: "function",
      callback
    }, "page.exposeFunction");
  }

  async addScriptTag(options?: { content?: string; path?: string; type?: string; url?: string; }): Promise<ElementHandle>;
  async addScriptTag(options: AddScriptTagOptions = {}): Promise<ElementHandle<Node>> {
    return this.mainFrame().addScriptTag(options);
  }

  async addStyleTag(options?: { content?: string; path?: string; url?: string; }): Promise<ElementHandle>;
  async addStyleTag(options: AddStyleTagOptions = {}): Promise<ElementHandle<Node>> {
    return this.mainFrame().addStyleTag(options);
  }

  async goto(url: string, options?: { referer?: string; timeout?: number; waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"; }): Promise<null|Response>;
  async goto(url: string, options?: PageGotoOptions): Promise<Response | null> {
    return withAsyncApiStack(() => this.mainFrame().goto(url, options));
  }

  url(): string {
    return this.adapter.url();
  }

  async goBack(options?: { timeout?: number; waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"; }): Promise<null|Response>;
  async goBack(options?: PageGotoOptions): Promise<Response | null> {
    return this.toPublicResponse(await this.adapter.goBack({
      ...options,
      timeout: options?.timeout ?? this.defaultNavigationTimeoutMs
    }));
  }

  async goForward(options?: { timeout?: number; waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"; }): Promise<null|Response>;
  async goForward(options?: PageGotoOptions): Promise<Response | null> {
    return this.toPublicResponse(await this.adapter.goForward({
      ...options,
      timeout: options?.timeout ?? this.defaultNavigationTimeoutMs
    }));
  }

  async reload(options?: { timeout?: number; waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"; }): Promise<null|Response>;
  async reload(options?: PageGotoOptions): Promise<Response | null> {
    const response = await this.adapter.reload({
      ...options,
      timeout: options?.timeout ?? this.defaultNavigationTimeoutMs
    });
    await this.reinstallExposedBindings();
    await this.refreshFrameSnapshots();
    return this.toPublicResponse(response);
  }

  async title(): Promise<string> {
    return this.mainFrame().title();
  }

  async content(): Promise<string> {
    return this.mainFrame().content();
  }

  async setContent(html: string, options?: { timeout?: number; waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"; }): Promise<void>;
  async setContent(html: string, options?: PageSetContentOptions): Promise<void> {
    return this.mainFrame().setContent(html, options);
  }

  async evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg): Promise<R>;
  async evaluate<R>(pageFunction: PageFunction<void, R>, arg?: any): Promise<R>;
  async evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg?: Arg): Promise<R> {
    assertMaxArguments(arguments.length, 2);
    const functionSource = serializePageFunction(pageFunction as string | ElementCallback<R, Arg>);
    const result = await this.adapter.evaluate<R>(
      functionSource,
      arg,
      typeof pageFunction === "function" || looksLikeFunctionExpression(functionSource)
    );
    if (!this.frameSnapshotRefreshInProgress && this.hasFrameEventObservers()) {
      await this.refreshFrameSnapshots();
    }
    return result;
  }

  async evaluateHandle<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg): Promise<SmartHandle<R>>;
  async evaluateHandle<R>(pageFunction: PageFunction<void, R>, arg?: any): Promise<SmartHandle<R>>;
  async evaluateHandle<R, Arg>(
    pageFunction: PageFunction<Arg, R>,
    arg?: Arg
  ): Promise<SmartHandle<R>> {
    assertMaxArguments(arguments.length, 2);
    const functionSource = serializePageFunction(pageFunction as string | ElementCallback<R, Arg>);
    const isFunction = typeof pageFunction === "function" || looksLikeFunctionExpression(functionSource);
    if (!this.adapter.evaluateHandle) {
      const value = await this.adapter.evaluate<R>(
        functionSource,
        arg,
        isFunction
      );
      return createSmartHandle(value);
    }

    return await createRemoteJSHandle(
      await this.adapter.evaluateHandle<R>(
        functionSource,
        arg,
        isFunction
      ),
      (reference) => this.createElementHandle(this.adapter.createHandle(reference))
    ) as unknown as SmartHandle<R>;
  }

  async waitForFunction<R, Arg>(
    pageFunction: PageFunction<Arg, R>,
    arg: Arg,
    options?: PageWaitForFunctionOptions
  ): Promise<SmartHandle<R>>;
  async waitForFunction<R>(
    pageFunction: PageFunction<void, R>,
    arg?: any,
    options?: PageWaitForFunctionOptions
  ): Promise<SmartHandle<R>>;
  async waitForFunction<R, Arg>(
    pageFunction: PageFunction<Arg, R>,
    arg?: Arg,
    options: PageWaitForFunctionOptions = {}
  ): Promise<SmartHandle<R>> {
    const frame = this.mainFrame() as RoxyFrame;
    return frame.waitForFunction<R, Arg>(pageFunction, arg as Arg, options);
  }

  async waitForTimeout(timeout: number): Promise<void> {
    await this.mainFrame().waitForTimeout(timeout);
  }

  async prepareForPendingFileChooser(): Promise<void> {
    await this.waitForFileChooserInterceptionIfPending();
  }

  async waitForURL(url: string|RegExp|URLPattern|((url: URL) => boolean), options?: { timeout?: number; waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"; }): Promise<void>;
  async waitForURL(
    url: string | RegExp | URLPattern | ((url: URL) => boolean),
    options: WaitForURLOptions = {}
  ): Promise<void> {
    const timeout = options.timeout ?? this.defaultNavigationTimeoutMs;
    const waitUntil = options.waitUntil ?? "load";
    const start = Date.now();

    while (timeout === 0 || Date.now() - start <= timeout) {
      const current = this.tryParseUrl(this.url());
      if (current && this.matchesURL(current, url)) {
        if (waitUntil !== "commit") {
          await this.adapter.waitForLoadState(waitUntil, this.remainingTimeout(start, timeout));
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new TimeoutError(`page.waitForURL: Timeout ${timeout}ms exceeded.`);
  }

  async waitForNavigation(options?: { timeout?: number; url?: string|RegExp|URLPattern|((url: URL) => boolean); waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"; }): Promise<null|Response>;
  async waitForNavigation(options: WaitForNavigationOptions = {}): Promise<Response | null> {
    return this.waitForNavigationInFrame(null, options);
  }

  async waitForNavigationInFrame(
    frame: RoxyFrameSnapshot | null,
    options: WaitForNavigationOptions = {}
  ): Promise<Response | null> {
    const frameObject = frame ? this.frameById(frame.id) : null;
    const initialUrl = frameObject?.url() ?? this.url();
    const timeout = options.timeout ?? this.defaultNavigationTimeoutMs;
    const waitUntil = options.waitUntil ?? "load";
    const navigationTargetDescription = options.url ? ` to "${String(options.url)}"` : "";
    const navigationResponseAbortController = new AbortController();
    const adapterNavigationResponsePromise = this.adapter.waitForNavigationResponse?.({
      initialUrl,
      signal: navigationResponseAbortController.signal,
      ...(options.url
        ? {
            url: (url: URL) => this.matchesURL(url, options.url!)
          }
        : {})
    });
    const start = Date.now();
    const navigationPromise = new Promise<Response | null>((resolve, reject) => {
      let latestNavigationResponse: Response | null = null;
      const timer =
        timeout === 0
          ? null
          : setTimeout(() => {
              reject(
                new TimeoutError(
                  `page.waitForNavigation: Timeout ${timeout}ms exceeded.\n` +
                    `=========================== logs ===========================\n` +
                    `waiting for navigation${navigationTargetDescription} until "${waitUntil}"\n` +
                    `============================================================\n` +
                    `navigated to "${frameObject?.url() ?? this.url()}"`
                )
              );
            }, timeout);
      const interval = setInterval(() => {
        void checkForMatch();
      }, 50);
      let settled = false;
      let resolveNavigationResponse: (() => void) | null = null;
      const navigationResponsePromise = new Promise<void>((resolve) => {
        resolveNavigationResponse = resolve;
      });
      const matchesNavigationUrl = (url: string) => {
        if (!options.url) {
          return false;
        }
        const parsed = this.tryParseUrl(url);
        return parsed ? this.matchesURL(parsed, options.url) : false;
      };
      void adapterNavigationResponsePromise?.then(
        async (response) => {
          if (response) {
            await this.refreshFrameSnapshots().catch(() => {});
            const publicResponse = this.toPublicResponse(response);
            if (
              !frameObject ||
              publicResponse?.frame() === frameObject ||
              (options.url && matchesNavigationUrl(response.url))
            ) {
              latestNavigationResponse = publicResponse;
              resolveNavigationResponse?.();
              void checkForMatch();
            }
          }
        },
        () => {}
      );

      const cleanup = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
        }
        clearInterval(interval);
        navigationResponseAbortController.abort();
        this.removeListener("response", responseListener);
        this.removeListener("close", closeListener);
        this.removeListener("framedetached", frameDetachedListener);
      };

      const closeListener = (() => {
        cleanup();
        reject(new Error("Navigation failed because page was closed!"));
      }) as PageEventListener<"close">;

      const frameDetachedListener = ((detachedFrame: Frame) => {
        if (frameObject && detachedFrame === frameObject) {
          cleanup();
          reject(new Error("Navigating frame was detached!"));
        }
      }) as PageEventListener<"framedetached">;

      const isLikelyNavigationResponse = (response: Response) => {
        if (frameObject && response.frame() !== frameObject && !matchesNavigationUrl(response.url())) {
          return false;
        }
        if (response.request().isNavigationRequest()) {
          return true;
        }
        if (response.request().resourceType() === "document") {
          return true;
        }
        if (response.url() === this.url() && response.url() !== initialUrl) {
          return true;
        }
        if (!latestNavigationResponse && response.url() !== initialUrl) {
          return true;
        }
        return false;
      };

      const matchesUrl = () => {
        const current = this.tryParseUrl(frameObject?.url() ?? this.url());
        if (!current) {
          return false;
        }
        if (!options.url) {
          return latestNavigationResponse !== null || current.toString() !== initialUrl;
        }
        return this.matchesURL(current, options.url);
      };

      const checkForMatch = async () => {
        if (!matchesUrl()) {
          return;
        }
        if (waitUntil !== "commit") {
          await this.adapter.waitForLoadState(waitUntil, this.remainingTimeout(start, timeout));
          if (!latestNavigationResponse) {
            const responseGraceDeadline = Date.now() + Math.min(500, this.remainingTimeout(start, timeout));
            while (!latestNavigationResponse && Date.now() < responseGraceDeadline) {
              await Promise.race([
                navigationResponsePromise,
                new Promise((resolve) => setTimeout(resolve, 25))
              ]);
              matchesUrl();
            }
          }
        }
        cleanup();
        resolve(frameObject && latestNavigationResponse
          ? responseWithFrame(latestNavigationResponse, frameObject)
          : latestNavigationResponse);
      };

      const responseListener = (async (response: Response) => {
        if (isLikelyNavigationResponse(response)) {
          latestNavigationResponse = response;
          resolveNavigationResponse?.();
        }
        if (waitUntil === "commit" && matchesUrl()) {
          cleanup();
          resolve(frameObject && latestNavigationResponse
            ? responseWithFrame(latestNavigationResponse, frameObject)
            : latestNavigationResponse);
        }
      }) as PageEventListener<"response">;

      this.on("response", responseListener);
      this.on("close", closeListener);
      this.on("framedetached", frameDetachedListener);
      void checkForMatch();
    });

    return navigationPromise;
  }

  async waitForRequest(urlOrPredicate: string|RegExp|((request: Request) => boolean|Promise<boolean>), options?: { timeout?: number; }): Promise<Request>;
  async waitForRequest(
    urlOrPredicate:
      | string
      | RegExp
      | ((request: Request) => boolean | Promise<boolean>),
    options: { timeout?: number } = {}
  ): Promise<Request> {
    const predicate = async (request: Request) => {
      if (typeof urlOrPredicate === "string" || isRegExp(urlOrPredicate)) {
        return urlMatches(this.baseURL(), request.url(), urlOrPredicate);
      }
      return urlOrPredicate(request);
    };
    const trimmedUrl = trimUrlForWaitLog(urlOrPredicate);
    const logLine = trimmedUrl ? `waiting for request ${trimmedUrl}` : undefined;
    const waitOptions: InternalWaitForEventOptions<"request"> = {
      timeout: options.timeout ?? this.defaultTimeoutMs,
      predicate,
      ...(logLine ? { logLine } : {})
    };
    return this.waitForEvent("request", waitOptions);
  }

  async waitForResponse(urlOrPredicate: string|RegExp|((response: Response) => boolean|Promise<boolean>), options?: { timeout?: number; }): Promise<Response>;
  async waitForResponse(
    urlOrPredicate:
      | string
      | RegExp
      | ((response: Response) => boolean | Promise<boolean>),
    options: { timeout?: number } = {}
  ): Promise<Response> {
    const predicate = async (response: Response) => {
      if (typeof urlOrPredicate === "string" || isRegExp(urlOrPredicate)) {
        return urlMatches(this.baseURL(), response.url(), urlOrPredicate);
      }
      return urlOrPredicate(response);
    };
    const trimmedUrl = trimUrlForWaitLog(urlOrPredicate);
    const logLine = trimmedUrl ? `waiting for response ${trimmedUrl}` : undefined;
    const waitOptions: InternalWaitForEventOptions<"response"> = {
      timeout: options.timeout ?? this.defaultTimeoutMs,
      predicate,
      ...(logLine ? { logLine } : {})
    };
    return this.waitForEvent("response", waitOptions);
  }

  async waitForLoadState(state?: "load"|"domcontentloaded"|"networkidle", options?: { timeout?: number; }): Promise<void>;
  async waitForLoadState(
    state: LoadState = "load",
    options: { timeout?: number } = {}
  ): Promise<void> {
    if (state !== "load" && state !== "domcontentloaded" && state !== "networkidle") {
      throw new Error("state: expected one of (load|domcontentloaded|networkidle|commit)");
    }
    await this.adapter.waitForLoadState(state, options.timeout ?? this.defaultNavigationTimeoutMs);
    await this.reinstallExposedBindings();
    await this.installRouteInterceptors();
    await this.refreshFrameSnapshots();
  }

  async waitForSelector<K extends keyof HTMLElementTagNameMap>(
    selector: K,
    options?: WaitForSelectorOptions & { state?: "visible" | "attached" }
  ): Promise<ElementHandleForTag<K>>;
  async waitForSelector(
    selector: string,
    options?: WaitForSelectorOptions & { state?: "visible" | "attached" }
  ): Promise<ElementHandle<SVGElement | HTMLElement>>;
  async waitForSelector<K extends keyof HTMLElementTagNameMap>(
    selector: K,
    options: WaitForSelectorOptions
  ): Promise<ElementHandleForTag<K> | null>;
  async waitForSelector(
    selector: string,
    options: WaitForSelectorOptions
  ): Promise<null | ElementHandle<SVGElement | HTMLElement>>;
  async waitForSelector(
    selector: string,
    options: WaitForSelectorOptions = {}
  ): Promise<ElementHandle | null> {
    try {
      return await this.mainFrame().waitForSelector(selector, options);
    } catch (error) {
      if (error instanceof TimeoutError) {
        error.message = error.message.replace(/^Timeout (\d+)ms exceeded\.$/, "page.waitForSelector: Timeout $1ms exceeded.");
      }
      throw error;
    }
  }

  async ariaSnapshot(options?: { boxes?: boolean; depth?: number; mode?: "ai"|"default"; timeout?: number; }): Promise<string>;
  async ariaSnapshot(options?: AriaSnapshotOptions): Promise<string> {
    return this.adapter.ariaSnapshot(options);
  }

  async resolveAriaRef(ref: string): Promise<ResolvedAriaRef> {
    return this.adapter.resolveAriaRef(ref);
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    return this.runScreenshotTask(() => this.screenshotWithoutQueue(options));
  }

  async runScreenshotTask<T>(task: () => Promise<T>): Promise<T> {
    const result = this.screenshotTaskChain.then(task);
    this.screenshotTaskChain = result.catch(() => {});
    return result;
  }

  private async screenshotWithoutQueue(options: ScreenshotOptions = {}): Promise<Buffer> {
    const screenshotOptions: ScreenshotOptions = { ...options };
    if (!screenshotOptions.type) {
      const inferredType = determineScreenshotType(options);
      if (inferredType) {
        screenshotOptions.type = inferredType;
      }
    }
    validateScreenshotOptions(screenshotOptions);
    const normalizedScreenshot = await normalizePageScreenshotOptions(
      screenshotOptions,
      this,
      this.adapter.screenshotClipOrigin?.() ?? "document"
    );
    const normalizedScreenshotOptions = normalizedScreenshot.options;
    const cleanup = await preparePageForScreenshot(this, normalizedScreenshotOptions);
    const restoreBackground = await this.prepareScreenshotBackground(normalizedScreenshotOptions);
    try {
      if ((options as any).__testHookBeforeScreenshot) {
        await (options as any).__testHookBeforeScreenshot();
      }
      const data = await this.adapter.screenshot(normalizedScreenshotOptions);
      if ((options as any).__testHookAfterScreenshot) {
        await (options as any).__testHookAfterScreenshot();
      }

      if (options.path) {
        await mkdir(dirname(options.path), { recursive: true });
        await writeFile(options.path, data);
      }

      return data;
    } finally {
      await Promise.all([
        cleanup(),
        restoreBackground()
      ]);
    }
  }

  context(): BrowserContext {
    if (!this.browserContext) {
      throw new Error("Page is not attached to a browser context.");
    }
    return this.browserContext;
  }

  async consoleMessages(options?: {
    filter?: "all" | "since-navigation";
  }): Promise<Array<PageConsoleMessage>> {
    const source =
      options?.filter === "all"
        ? this.consoleMessageHistory
        : this.consoleMessageHistorySinceNavigation;
    return [...source];
  }

  async clearConsoleMessages(): Promise<void> {
    this.consoleMessageHistory.length = 0;
    this.consoleMessageHistorySinceNavigation.length = 0;
  }

  async clearPageErrors(): Promise<void> {
    this.pageErrorHistory.length = 0;
    this.pageErrorHistorySinceNavigation.length = 0;
  }

  async pageErrors(options?: {
    filter?: "all" | "since-navigation";
  }): Promise<Array<PageErrorEntry>> {
    const source =
      options?.filter === "all"
        ? this.pageErrorHistory
        : this.pageErrorHistorySinceNavigation;
    return [...source];
  }

  async requests(): Promise<Array<Request>> {
    return [...this.requestHistory];
  }

  on(event: 'close', listener: (page: Page) => any): this;
  on(event: 'console', listener: (consoleMessage: ConsoleMessage) => any): this;
  on(event: 'crash', listener: (page: Page) => any): this;
  on(event: 'dialog', listener: (dialog: Dialog) => any): this;
  on(event: 'domcontentloaded', listener: (page: Page) => any): this;
  on(event: 'download', listener: (download: Download) => any): this;
  on(event: 'filechooser', listener: (fileChooser: FileChooser) => any): this;
  on(event: 'frameattached', listener: (frame: Frame) => any): this;
  on(event: 'framedetached', listener: (frame: Frame) => any): this;
  on(event: 'framenavigated', listener: (frame: Frame) => any): this;
  on(event: 'load', listener: (page: Page) => any): this;
  on(event: 'pageerror', listener: (error: Error) => any): this;
  on(event: 'popup', listener: (page: Page) => any): this;
  on(event: 'request', listener: (request: Request) => any): this;
  on(event: 'requestfailed', listener: (request: Request) => any): this;
  on(event: 'requestfinished', listener: (request: Request) => any): this;
  on(event: 'response', listener: (response: Response) => any): this;
  on(event: 'websocket', listener: (webSocket: WebSocket) => any): this;
  on(event: 'worker', listener: (worker: Worker) => any): this;
  on(event: PageEventName, listener: (...args: any[]) => any): this {
    this.maybeStartFileChooserInterception(event);
    const entries = this.ensureListenerSet(event);
    entries.add({
      original: listener as PageEventListener<PageEventName>,
      wrapped: listener as PageEventListener<PageEventName>
    });

    if (isAdapterBackedPageEvent(event) && !this.adapterDisposers.has(event)) {
      const dispose = this.adapter.on(
        event,
        ((payload?: RawPageEventMap[RawPageEventName]) => {
          void this.handleAdapterBackedEvent(event, payload);
        }) as RawPageEventListener<RawPageEventName>
      );
      this.adapterDisposers.set(event, dispose);
    }

    return this;
  }

  addListener(event: 'close', listener: (page: Page) => any): this;
  addListener(event: 'console', listener: (consoleMessage: ConsoleMessage) => any): this;
  addListener(event: 'crash', listener: (page: Page) => any): this;
  addListener(event: 'dialog', listener: (dialog: Dialog) => any): this;
  addListener(event: 'domcontentloaded', listener: (page: Page) => any): this;
  addListener(event: 'download', listener: (download: Download) => any): this;
  addListener(event: 'filechooser', listener: (fileChooser: FileChooser) => any): this;
  addListener(event: 'frameattached', listener: (frame: Frame) => any): this;
  addListener(event: 'framedetached', listener: (frame: Frame) => any): this;
  addListener(event: 'framenavigated', listener: (frame: Frame) => any): this;
  addListener(event: 'load', listener: (page: Page) => any): this;
  addListener(event: 'pageerror', listener: (error: Error) => any): this;
  addListener(event: 'popup', listener: (page: Page) => any): this;
  addListener(event: 'request', listener: (request: Request) => any): this;
  addListener(event: 'requestfailed', listener: (request: Request) => any): this;
  addListener(event: 'requestfinished', listener: (request: Request) => any): this;
  addListener(event: 'response', listener: (response: Response) => any): this;
  addListener(event: 'websocket', listener: (webSocket: WebSocket) => any): this;
  addListener(event: 'worker', listener: (worker: Worker) => any): this;
  addListener(event: PageEventName, listener: (...args: any[]) => any): this {
    return (this.on as (event: PageEventName, listener: (...args: any[]) => any) => this)(event, listener);
  }

  once(event: 'close', listener: (page: Page) => any): this;
  once(event: 'console', listener: (consoleMessage: ConsoleMessage) => any): this;
  once(event: 'crash', listener: (page: Page) => any): this;
  once(event: 'dialog', listener: (dialog: Dialog) => any): this;
  once(event: 'domcontentloaded', listener: (page: Page) => any): this;
  once(event: 'download', listener: (download: Download) => any): this;
  once(event: 'filechooser', listener: (fileChooser: FileChooser) => any): this;
  once(event: 'frameattached', listener: (frame: Frame) => any): this;
  once(event: 'framedetached', listener: (frame: Frame) => any): this;
  once(event: 'framenavigated', listener: (frame: Frame) => any): this;
  once(event: 'load', listener: (page: Page) => any): this;
  once(event: 'pageerror', listener: (error: Error) => any): this;
  once(event: 'popup', listener: (page: Page) => any): this;
  once(event: 'request', listener: (request: Request) => any): this;
  once(event: 'requestfailed', listener: (request: Request) => any): this;
  once(event: 'requestfinished', listener: (request: Request) => any): this;
  once(event: 'response', listener: (response: Response) => any): this;
  once(event: 'websocket', listener: (webSocket: WebSocket) => any): this;
  once(event: 'worker', listener: (worker: Worker) => any): this;
  once(event: PageEventName, listener: (...args: any[]) => any): this {
    this.maybeStartFileChooserInterception(event);
    const wrapped = ((payload?: PageEventMap[PageEventName]) => {
      (this.removeListener as (event: PageEventName, listener: (...args: any[]) => any) => this)(event, listener);
      if (payload === undefined) {
        (listener as () => void)();
        return;
      }

      (listener as (eventPayload: PageEventMap[PageEventName]) => void)(payload);
    }) as PageEventListener<PageEventName>;

    this.ensureListenerSet(event).add({
      original: listener as PageEventListener<PageEventName>,
      wrapped: wrapped as PageEventListener<PageEventName>
    });

    if (isAdapterBackedPageEvent(event) && !this.adapterDisposers.has(event)) {
      const dispose = this.adapter.on(
        event,
        ((payload?: RawPageEventMap[RawPageEventName]) => {
          void this.handleAdapterBackedEvent(event, payload);
        }) as RawPageEventListener<RawPageEventName>
      );
      this.adapterDisposers.set(event, dispose);
    }

    return this;
  }

  removeListener(event: 'close', listener: (page: Page) => any): this;
  removeListener(event: 'console', listener: (consoleMessage: ConsoleMessage) => any): this;
  removeListener(event: 'crash', listener: (page: Page) => any): this;
  removeListener(event: 'dialog', listener: (dialog: Dialog) => any): this;
  removeListener(event: 'domcontentloaded', listener: (page: Page) => any): this;
  removeListener(event: 'download', listener: (download: Download) => any): this;
  removeListener(event: 'filechooser', listener: (fileChooser: FileChooser) => any): this;
  removeListener(event: 'frameattached', listener: (frame: Frame) => any): this;
  removeListener(event: 'framedetached', listener: (frame: Frame) => any): this;
  removeListener(event: 'framenavigated', listener: (frame: Frame) => any): this;
  removeListener(event: 'load', listener: (page: Page) => any): this;
  removeListener(event: 'pageerror', listener: (error: Error) => any): this;
  removeListener(event: 'popup', listener: (page: Page) => any): this;
  removeListener(event: 'request', listener: (request: Request) => any): this;
  removeListener(event: 'requestfailed', listener: (request: Request) => any): this;
  removeListener(event: 'requestfinished', listener: (request: Request) => any): this;
  removeListener(event: 'response', listener: (response: Response) => any): this;
  removeListener(event: 'websocket', listener: (webSocket: WebSocket) => any): this;
  removeListener(event: 'worker', listener: (worker: Worker) => any): this;
  removeListener(event: PageEventName, listener: (...args: any[]) => any): this {
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
      const dispose = this.adapterDisposers.get(event);
      if (dispose) {
        this.adapterDisposers.delete(event);
        dispose();
      }
    }

    return this;
  }

  off(event: 'close', listener: (page: Page) => any): this;
  off(event: 'console', listener: (consoleMessage: ConsoleMessage) => any): this;
  off(event: 'crash', listener: (page: Page) => any): this;
  off(event: 'dialog', listener: (dialog: Dialog) => any): this;
  off(event: 'domcontentloaded', listener: (page: Page) => any): this;
  off(event: 'download', listener: (download: Download) => any): this;
  off(event: 'filechooser', listener: (fileChooser: FileChooser) => any): this;
  off(event: 'frameattached', listener: (frame: Frame) => any): this;
  off(event: 'framedetached', listener: (frame: Frame) => any): this;
  off(event: 'framenavigated', listener: (frame: Frame) => any): this;
  off(event: 'load', listener: (page: Page) => any): this;
  off(event: 'pageerror', listener: (error: Error) => any): this;
  off(event: 'popup', listener: (page: Page) => any): this;
  off(event: 'request', listener: (request: Request) => any): this;
  off(event: 'requestfailed', listener: (request: Request) => any): this;
  off(event: 'requestfinished', listener: (request: Request) => any): this;
  off(event: 'response', listener: (response: Response) => any): this;
  off(event: 'websocket', listener: (webSocket: WebSocket) => any): this;
  off(event: 'worker', listener: (worker: Worker) => any): this;
  off(event: PageEventName, listener: (...args: any[]) => any): this {
    return (this.removeListener as (event: PageEventName, listener: (...args: any[]) => any) => this)(event, listener);
  }

  prependListener(event: 'close', listener: (page: Page) => any): this;
  prependListener(event: 'console', listener: (consoleMessage: ConsoleMessage) => any): this;
  prependListener(event: 'crash', listener: (page: Page) => any): this;
  prependListener(event: 'dialog', listener: (dialog: Dialog) => any): this;
  prependListener(event: 'domcontentloaded', listener: (page: Page) => any): this;
  prependListener(event: 'download', listener: (download: Download) => any): this;
  prependListener(event: 'filechooser', listener: (fileChooser: FileChooser) => any): this;
  prependListener(event: 'frameattached', listener: (frame: Frame) => any): this;
  prependListener(event: 'framedetached', listener: (frame: Frame) => any): this;
  prependListener(event: 'framenavigated', listener: (frame: Frame) => any): this;
  prependListener(event: 'load', listener: (page: Page) => any): this;
  prependListener(event: 'pageerror', listener: (error: Error) => any): this;
  prependListener(event: 'popup', listener: (page: Page) => any): this;
  prependListener(event: 'request', listener: (request: Request) => any): this;
  prependListener(event: 'requestfailed', listener: (request: Request) => any): this;
  prependListener(event: 'requestfinished', listener: (request: Request) => any): this;
  prependListener(event: 'response', listener: (response: Response) => any): this;
  prependListener(event: 'websocket', listener: (webSocket: WebSocket) => any): this;
  prependListener(event: 'worker', listener: (worker: Worker) => any): this;
  prependListener(event: PageEventName, listener: (...args: any[]) => any): this {
    this.maybeStartFileChooserInterception(event);
    const entries = this.ensureListenerSet(event);
    const entry = {
      original: listener as PageEventListener<PageEventName>,
      wrapped: listener as PageEventListener<PageEventName>
    };
    const reordered = new Set<ListenerEntry<PageEventName>>([entry, ...entries]);
    this.listeners.set(event, reordered);

    if (isAdapterBackedPageEvent(event) && !this.adapterDisposers.has(event)) {
      const dispose = this.adapter.on(
        event,
        ((payload?: RawPageEventMap[RawPageEventName]) => {
          void this.handleAdapterBackedEvent(event, payload);
        }) as RawPageEventListener<RawPageEventName>
      );
      this.adapterDisposers.set(event, dispose);
    }

    return this;
  }

  removeAllListeners(type?: string): this;
  removeAllListeners(type: string|undefined, options: { behavior?: 'wait'|'ignoreErrors'|'default' }): Promise<void>;
  removeAllListeners(
    event?: string,
    options?: { behavior?: RemoveAllListenersBehavior }
  ): this | Promise<void> {
    this.removeAllListenersInternal(event as PageEventName | undefined);
    if (!options) {
      return this;
    }

    if (options.behavior === "wait") {
      const errors: Error[] = [];
      this.rejectionHandler = (error) => {
        errors.push(error);
      };
      return this.waitForPendingHandlers(event as PageEventName | undefined).then(() => {
        if (errors.length > 0) {
          throw errors[0];
        }
      });
    }

    if (options.behavior === "ignoreErrors") {
      this.rejectionHandler = () => {};
    }

    return Promise.resolve();
  }

  async waitForEvent(
    event: "console",
    optionsOrPredicate?:
      | ((consoleMessage: PageConsoleMessage) => boolean | Promise<boolean>)
      | {
          predicate?: (consoleMessage: PageConsoleMessage) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<PageConsoleMessage>;
  async waitForEvent<K extends PageEventName>(
    event: "dialog",
    optionsOrPredicate?:
      | ((dialog: Dialog) => boolean | Promise<boolean>)
      | {
          predicate?: (dialog: Dialog) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Dialog>;
  async waitForEvent<K extends PageEventName>(
    event: "crash",
    optionsOrPredicate?:
      | ((page: Page) => boolean | Promise<boolean>)
      | {
          predicate?: (page: Page) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Page>;
  async waitForEvent<K extends PageEventName>(
    event: "close",
    optionsOrPredicate?:
      | ((page: Page) => boolean | Promise<boolean>)
      | {
          predicate?: (page: Page) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Page>;
  async waitForEvent<K extends PageEventName>(
    event: "domcontentloaded",
    optionsOrPredicate?:
      | ((page: Page) => boolean | Promise<boolean>)
      | {
          predicate?: (page: Page) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Page>;
  async waitForEvent(
    event: "download",
    optionsOrPredicate?:
      | ((download: Download) => boolean | Promise<boolean>)
      | {
          predicate?: (download: Download) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Download>;
  async waitForEvent(
    event: "filechooser",
    optionsOrPredicate?:
      | ((fileChooser: FileChooser) => boolean | Promise<boolean>)
      | {
          predicate?: (fileChooser: FileChooser) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<FileChooser>;
  async waitForEvent(
    event: "frameattached",
    optionsOrPredicate?:
      | ((frame: Frame) => boolean | Promise<boolean>)
      | {
          predicate?: (frame: Frame) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Frame>;
  async waitForEvent(
    event: "framedetached",
    optionsOrPredicate?:
      | ((frame: Frame) => boolean | Promise<boolean>)
      | {
          predicate?: (frame: Frame) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Frame>;
  async waitForEvent(
    event: "framenavigated",
    optionsOrPredicate?:
      | ((frame: Frame) => boolean | Promise<boolean>)
      | {
          predicate?: (frame: Frame) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Frame>;
  async waitForEvent<K extends PageEventName>(
    event: "load",
    optionsOrPredicate?:
      | ((page: Page) => boolean | Promise<boolean>)
      | {
          predicate?: (page: Page) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Page>;
  async waitForEvent(
    event: "pageerror",
    optionsOrPredicate?:
      | ((error: PageErrorEntry) => boolean | Promise<boolean>)
      | {
          predicate?: (error: PageErrorEntry) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<PageErrorEntry>;
  async waitForEvent(
    event: "popup",
    optionsOrPredicate?:
      | ((page: Page) => boolean | Promise<boolean>)
      | {
          predicate?: (page: Page) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Page>;
  async waitForEvent<K extends PageEventName>(
    event: "request",
    optionsOrPredicate?:
      | ((request: Request) => boolean | Promise<boolean>)
      | {
          predicate?: (request: Request) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Request>;
  async waitForEvent(
    event: "requestfinished",
    optionsOrPredicate?:
      | ((request: Request) => boolean | Promise<boolean>)
      | {
          predicate?: (request: Request) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Request>;
  async waitForEvent(
    event: "requestfailed",
    optionsOrPredicate?:
      | ((request: Request) => boolean | Promise<boolean>)
      | {
          predicate?: (request: Request) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Request>;
  async waitForEvent(
    event: "response",
    optionsOrPredicate?:
      | ((response: Response) => boolean | Promise<boolean>)
      | {
          predicate?: (response: Response) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Response>;
  async waitForEvent(
    event: "websocket",
    optionsOrPredicate?:
      | ((webSocket: WebSocket) => boolean | Promise<boolean>)
      | {
          predicate?: (webSocket: WebSocket) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<WebSocket>;
  async waitForEvent(
    event: "worker",
    optionsOrPredicate?:
      | ((worker: Worker) => boolean | Promise<boolean>)
      | {
          predicate?: (worker: Worker) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Worker>;
  async waitForEvent<K extends PageEventName>(
    event: K,
    optionsOrPredicate?:
      | PageEventPredicate<K>
      | InternalWaitForEventOptions<K>
  ): Promise<PageEventMap[K]>;
  async waitForEvent(
    event: PageEventName,
    optionsOrPredicate?:
      | ((payload: any) => boolean | Promise<boolean>)
      | InternalWaitForEventOptions<PageEventName>
  ): Promise<any> {
    if (this.isClosed() && event !== "close") {
      throw this.createClosedError();
    }
    const interceptionPromise =
      event === "filechooser" ? this.ensureFileChooserInterception() : null;
    const predicate =
      typeof optionsOrPredicate === "function"
        ? optionsOrPredicate
        : optionsOrPredicate?.predicate;
    const logLine =
      typeof optionsOrPredicate === "function" ? undefined : optionsOrPredicate?.logLine;
    const timeout =
      typeof optionsOrPredicate === "function"
        ? this.defaultTimeoutMs
        : optionsOrPredicate?.timeout ?? this.defaultTimeoutMs;

    return new Promise<PageEventMap[PageEventName]>((resolve, reject) => {
      const timer =
        timeout === 0
          ? null
          : setTimeout(() => {
              cleanup();
              reject(createWaitForEventTimeoutError(String(event), timeout, logLine));
            }, timeout);

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
        }
        (this.removeListener as (event: PageEventName, listener: (...args: any[]) => any) => this)(event, listener);
        if (event !== "close") {
          this.removeListener("close", closeListener as PageEventListener<"close">);
        }
      };

      const closeListener = (() => {
        cleanup();
        reject(this.createClosedError());
      }) as PageEventListener<"close">;

      const listener = (async (payload?: PageEventMap[PageEventName]) => {
        try {
          const eventPayload = payload as PageEventMap[PageEventName];
          const accepted = predicate ? await predicate(eventPayload) : true;
          if (!accepted) {
            return;
          }

          cleanup();
          resolve(eventPayload);
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }) as PageEventListener<PageEventName>;

      if (event !== "close") {
        this.on("close", closeListener as PageEventListener<PageEventName>);
      }
      (this.on as (event: PageEventName, listener: (...args: any[]) => any) => this)(event, listener);
      interceptionPromise?.catch((error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async $<K extends keyof HTMLElementTagNameMap>(selector: K, options?: { strict: boolean }): Promise<ElementHandleForTag<K> | null>;
  async $(selector: string, options?: { strict: boolean }): Promise<ElementHandle<SVGElement | HTMLElement> | null>;
  async $(selector: string, options?: { strict?: boolean }): Promise<ElementHandle | null> {
    return (this.mainFrame() as RoxyFrame).$(selector, options as { strict: boolean } | undefined);
  }

  async $$<K extends keyof HTMLElementTagNameMap>(selector: K): Promise<ElementHandleForTag<K>[]>;
  async $$(selector: string): Promise<ElementHandle<SVGElement | HTMLElement>[]>;
  async $$(selector: string): Promise<ElementHandle[]> {
    return this.mainFrame().$$(selector);
  }

  async $eval<K extends keyof HTMLElementTagNameMap, R, Arg>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K], Arg, R>, arg: Arg): Promise<R>;
  async $eval<R, Arg, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E, Arg, R>, arg: Arg): Promise<R>;
  async $eval<K extends keyof HTMLElementTagNameMap, R>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K], void, R>, arg?: any): Promise<R>;
  async $eval<R, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E, void, R>, arg?: any): Promise<R>;
  async $eval<TResult, TArg = unknown>(
    selector: string,
    pageFunction: string | ElementCallback<TResult, TArg>,
    arg?: TArg
  ): Promise<TResult> {
    assertMaxArguments(arguments.length, 3);
    const frame = this.mainFrame() as RoxyFrame;
    return await frame.evalOnSelectorForPage(selector, pageFunction, arg);
  }

  async $$eval<K extends keyof HTMLElementTagNameMap, R, Arg>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K][], Arg, R>, arg: Arg): Promise<R>;
  async $$eval<R, Arg, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E[], Arg, R>, arg: Arg): Promise<R>;
  async $$eval<K extends keyof HTMLElementTagNameMap, R>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K][], void, R>, arg?: any): Promise<R>;
  async $$eval<R, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E[], void, R>, arg?: any): Promise<R>;
  async $$eval<TResult, TArg = unknown>(
    selector: string,
    pageFunction: string | ElementArrayCallback<TResult, TArg>,
    arg?: TArg
  ): Promise<TResult> {
    assertMaxArguments(arguments.length, 3);
    const frame = this.mainFrame() as RoxyFrame;
    return await frame.evalOnSelectorAllForPage(selector, pageFunction, arg);
  }

  frameLocator(selector: string): FrameLocator {
    return this.mainFrame().frameLocator(selector);
  }

  frame(frameSelector: string|{ name?: string; url?: string|RegExp|URLPattern|((url: URL) => boolean); }): null|Frame;
  frame(
    frameSelector:
      | {
          name?: string | RegExp;
          url?: string | RegExp | URLPattern | ((url: URL) => boolean);
        }
      | string
  ): Frame | null {
    const frames = this.frames();
    if (typeof frameSelector === "string") {
      return frames.find(
        (frame) => frame.name() === frameSelector || frame.url() === frameSelector
      ) ?? null;
    }

    return (
      frames.find((frame) => {
        const nameMatched =
          frameSelector.name === undefined
            ? true
            : typeof frameSelector.name === "string"
              ? frame.name() === frameSelector.name
              : frameSelector.name.test(frame.name());
        const urlMatched =
          frameSelector.url === undefined
            ? true
            : urlMatches(this.baseURL(), frame.url(), frameSelector.url);
        return nameMatched && urlMatched;
      }) ?? null
    );
  }

  frames(): Array<Frame> {
    return this.frameOrder
      .map((id) => this.frameMap.get(id))
      .filter((frame): frame is RoxyFrame => Boolean(frame));
  }

  mainFrame(): Frame {
    return this.frameMap.get("main")!;
  }

  locator(selector: string, options?: LocatorOptions): Locator {
    return this.mainFrame().locator(selector, options);
  }

  getByText(text: string|RegExp, options?: { exact?: boolean; }): Locator;
  getByText(text: string | RegExp, options?: GetByTextOptions): Locator {
    return this.mainFrame().getByText(text, options);
  }

  getByAltText(text: string|RegExp, options?: { exact?: boolean; }): Locator;
  getByAltText(text: string | RegExp, options?: GetByAltTextOptions): Locator {
    return this.mainFrame().getByAltText(text, options);
  }

  getByLabel(text: string|RegExp, options?: { exact?: boolean; }): Locator;
  getByLabel(text: string | RegExp, options?: GetByLabelOptions): Locator {
    return this.mainFrame().getByLabel(text, options);
  }

  getByPlaceholder(text: string|RegExp, options?: { exact?: boolean; }): Locator;
  getByPlaceholder(text: string | RegExp, options?: GetByPlaceholderOptions): Locator {
    return this.mainFrame().getByPlaceholder(text, options);
  }

  getByTestId(testId: string | RegExp): Locator {
    return this.mainFrame().getByTestId(testId);
  }

  getByRole(role: "alert"|"alertdialog"|"application"|"article"|"banner"|"blockquote"|"button"|"caption"|"cell"|"checkbox"|"code"|"columnheader"|"combobox"|"complementary"|"contentinfo"|"definition"|"deletion"|"dialog"|"directory"|"document"|"emphasis"|"feed"|"figure"|"form"|"generic"|"grid"|"gridcell"|"group"|"heading"|"img"|"insertion"|"link"|"list"|"listbox"|"listitem"|"log"|"main"|"marquee"|"math"|"meter"|"menu"|"menubar"|"menuitem"|"menuitemcheckbox"|"menuitemradio"|"navigation"|"none"|"note"|"option"|"paragraph"|"presentation"|"progressbar"|"radio"|"radiogroup"|"region"|"row"|"rowgroup"|"rowheader"|"scrollbar"|"search"|"searchbox"|"separator"|"slider"|"spinbutton"|"status"|"strong"|"subscript"|"superscript"|"switch"|"tab"|"table"|"tablist"|"tabpanel"|"term"|"textbox"|"time"|"timer"|"toolbar"|"tooltip"|"tree"|"treegrid"|"treeitem", options?: { checked?: boolean; description?: string|RegExp; disabled?: boolean; exact?: boolean; expanded?: boolean; includeHidden?: boolean; level?: number; name?: string|RegExp; pressed?: boolean; selected?: boolean; }): Locator;
  getByRole(role: string, options?: GetByRoleOptions): Locator {
    return this.mainFrame().getByRole(role, options);
  }

  getByTitle(text: string|RegExp, options?: { exact?: boolean; }): Locator;
  getByTitle(text: string | RegExp, options?: GetByTitleOptions): Locator {
    return this.mainFrame().getByTitle(text, options);
  }

  async cancelPickLocator(): Promise<void> {
    const current = this.pickLocatorState;
    this.pickLocatorState = null;
    if (current) {
      current.reject(new Error("Locator picking was cancelled"));
    }
  }

  async hideHighlight(): Promise<void> {
    await this.evaluate(() => {
      document.querySelectorAll("[data-roxy-highlight-overlay]").forEach((node) => node.remove());
      document
        .querySelectorAll("[data-roxy-highlight-target]")
        .forEach((node) => node.removeAttribute("data-roxy-highlight-target"));
    });
  }

  async opener(): Promise<Page | null> {
    if (this.openerPage && this.openerPage.isClosed()) {
      this.openerPage = null;
    }
    return this.openerPage;
  }

  async pause(_options?: { __testHookKeepTestTimeout?: boolean }): Promise<void> {
    if (this.isClosed()) {
      return;
    }

    const pauseId = `pause-${++this.pauseSequence}`;
    const defaultNavigationTimeout = this.defaultNavigationTimeoutMs;
    const defaultTimeout = this.defaultTimeoutMs;
    this.setDefaultNavigationTimeout(0);
    this.setDefaultTimeout(0);

    try {
      await this.evaluate(installPauseController, pauseId);

      while (!this.isClosed()) {
        const resumed = await this.evaluate<boolean, string>(isPauseControllerResumed, pauseId).catch(
          () => false
        );
        if (resumed) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      await this.evaluate(cleanupPauseController, pauseId).catch(() => {});
      this.setDefaultNavigationTimeout(defaultNavigationTimeout);
      this.setDefaultTimeout(defaultTimeout);
    }
  }

  async pdf(options?: { displayHeaderFooter?: boolean; footerTemplate?: string; format?: string; headerTemplate?: string; height?: string|number; landscape?: boolean; margin?: { top?: string|number; right?: string|number; bottom?: string|number; left?: string|number; }; outline?: boolean; pageRanges?: string; path?: string; preferCSSPageSize?: boolean; printBackground?: boolean; scale?: number; tagged?: boolean; width?: string|number; }): Promise<Buffer>;
  async pdf(options: PdfOptions = {}): Promise<Buffer> {
    const transportOptions: PdfOptions = { ...options };
    if (transportOptions.margin) {
      transportOptions.margin = { ...transportOptions.margin };
    }
    if (typeof options.width === "number") {
      transportOptions.width = `${options.width}px`;
    }
    if (typeof options.height === "number") {
      transportOptions.height = `${options.height}px`;
    }
    for (const margin of ["top", "right", "bottom", "left"] as const) {
      if (options.margin && typeof options.margin[margin] === "number") {
        transportOptions.margin ??= {};
        transportOptions.margin[margin] = `${options.margin[margin]}px`;
      }
    }

    const payload = await this.adapter.pdf(transportOptions);
    if (options.path) {
      await mkdir(dirname(options.path), { recursive: true });
      await writeFile(options.path, payload);
    }
    return payload;
  }

  video(): Video | null {
    return this.pageVideo;
  }

  async pickLocator(): Promise<Locator> {
    const previous = this.pickLocatorState;
    this.pickLocatorState = null;
    previous?.reject(new Error("Locator picking was cancelled"));
    return new Promise<Locator>((resolve, reject) => {
      this.pickLocatorState = {
        resolve,
        reject
      };
    });
  }

  async removeLocatorHandler(locator: Locator): Promise<void> {
    const key = this.locatorKey(locator);
    for (let index = this.locatorHandlers.length - 1; index >= 0; index -= 1) {
      if (this.locatorHandlers[index]?.key === key) {
        this.locatorHandlers.splice(index, 1);
      }
    }
  }

  async route(
    url: string | RegExp | URLPattern | ((url: URL) => boolean),
    handler: (route: Route, request: Request) => Promise<any> | any,
    options: { times?: number } = {}
  ): Promise<Disposable> {
    if (typeof url === "string") {
      resolveGlobToRegexPattern(this.baseURL(), url);
    }
    const entry: RouteHandlerEntry = {
      matcher: url,
      handler,
      remainingTimes: options.times ?? null
    };
    this.routeHandlers.push(entry);
    await this.installRouteInterceptors();
    return {
      dispose: async () => {
        const index = this.routeHandlers.indexOf(entry);
        if (index >= 0) {
          this.routeHandlers.splice(index, 1);
        }
        await this.syncRouteInterception();
      }
    };
  }

  async routeFromHAR(
    har: string,
    options: {
      notFound?: "abort" | "fallback";
      update?: boolean;
      updateContent?: "embed" | "attach";
      updateMode?: "full" | "minimal";
      url?: string | RegExp;
    } = {}
  ): Promise<void> {
    const source = JSON.parse(await readFile(har, "utf8")) as {
      log?: {
        entries?: Array<{
          request?: { method?: string; url?: string };
          response?: {
            status?: number;
            statusText?: string;
            headers?: Array<{ name: string; value: string }>;
            redirectURL?: string;
            content?: { encoding?: string; text?: string };
          };
        }>;
      };
    };
    this.harRoutes.push({
      ...(options.url !== undefined ? { matcher: options.url } : {}),
      notFound: options.notFound ?? "abort",
      entries:
        source.log?.entries?.map((entry) => ({
          method: entry.request?.method ?? "GET",
          requestUrl: entry.request?.url ?? "",
          status: entry.response?.status ?? 200,
          ...(entry.response?.statusText ? { statusText: entry.response.statusText } : {}),
          responseHeaders: Object.fromEntries(
            (entry.response?.headers ?? []).map((header) => [header.name.toLowerCase(), header.value])
          ),
          responseBody: entry.response?.content?.text ?? "",
          ...(entry.response?.content?.encoding === "base64" && entry.response.content.text
            ? { responseBodyBufferBase64: entry.response.content.text }
            : {}),
          ...(entry.response?.redirectURL ? { redirectURL: entry.response.redirectURL } : {})
        })) ?? []
    });
    await this.installRouteInterceptors();
  }

  async routeWebSocket(
    url: string | RegExp | URLPattern | ((url: URL) => boolean),
    handler: (websocketroute: WebSocketRoute) => Promise<any> | any
  ): Promise<void> {
    if (typeof url === "string") {
      resolveGlobToRegexPattern(this.baseURL(), url, true);
    }
    this.websocketRouteHandlers.push({
      matcher: url,
      handler
    });
    await this.installRouteInterceptors();
  }

  async unroute(
    url: string | RegExp | URLPattern | ((url: URL) => boolean),
    handler?: (route: Route, request: Request) => Promise<any> | any
  ): Promise<void> {
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
      this.routeHandlers.splice(index, 1);
    }
    await this.syncRouteInterception();
  }

  async unrouteAll(_options?: {
    behavior?: "wait" | "ignoreErrors" | "default";
  }): Promise<void> {
    this.routeHandlers.length = 0;
    this.harRoutes.length = 0;
    await this.syncRouteInterception();
  }

  workers(): Array<Worker> {
    return [...this.pageWorkers];
  }

  async textContent(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<null|string>;
  async textContent(selector: string, options?: SelectorStrictOptions): Promise<string | null> {
    return this.mainFrame().textContent(selector, options);
  }

  async innerText(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<string>;
  async innerText(selector: string, options?: SelectorStrictOptions): Promise<string> {
    return this.mainFrame().innerText(selector, options);
  }

  async innerHTML(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<string>;
  async innerHTML(selector: string, options?: SelectorStrictOptions): Promise<string> {
    return this.mainFrame().innerHTML(selector, options);
  }

  async getAttribute(selector: string, name: string, options?: { strict?: boolean; timeout?: number; }): Promise<null|string>;
  async getAttribute(selector: string, name: string, options?: SelectorStrictOptions): Promise<string | null> {
    return this.mainFrame().getAttribute(selector, name, options);
  }

  async inputValue(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<string>;
  async inputValue(selector: string, options?: SelectorStrictOptions): Promise<string> {
    return this.mainFrame().inputValue(selector, options);
  }

  async isChecked(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  async isChecked(selector: string, options?: SelectorStrictOptions): Promise<boolean> {
    return this.mainFrame().isChecked(selector, options);
  }

  async isDisabled(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  async isDisabled(selector: string, options?: SelectorStrictOptions): Promise<boolean> {
    return this.mainFrame().isDisabled(selector, options);
  }

  async isEditable(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  async isEditable(selector: string, options?: SelectorStrictOptions): Promise<boolean> {
    return this.mainFrame().isEditable(selector, options);
  }

  async isEnabled(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  async isEnabled(selector: string, options?: SelectorStrictOptions): Promise<boolean> {
    return this.mainFrame().isEnabled(selector, options);
  }

  async isHidden(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  async isHidden(selector: string, options?: SelectorStrictOptions): Promise<boolean> {
    return this.mainFrame().isHidden(selector, options);
  }

  async isVisible(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  async isVisible(selector: string, options?: SelectorStrictOptions): Promise<boolean> {
    return this.mainFrame().isVisible(selector, options);
  }

  async focus(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<void>;
  async focus(selector: string, options?: SelectorStrictOptions): Promise<void> {
    await this.mainFrame().focus(selector, options);
  }

  async check(selector: string, options?: { force?: boolean; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  async check(selector: string, options?: ClickOptions): Promise<void> {
    await this.mainFrame().check(selector, options);
  }

  async uncheck(selector: string, options?: { force?: boolean; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  async uncheck(selector: string, options?: ClickOptions): Promise<void> {
    await this.mainFrame().uncheck(selector, options);
  }

  async dragAndDrop(source: string, target: string, options?: { force?: boolean; noWaitAfter?: boolean; sourcePosition?: { x: number; y: number; }; steps?: number; strict?: boolean; targetPosition?: { x: number; y: number; }; timeout?: number; trial?: boolean; }): Promise<void>;
  async dragAndDrop(source: string, target: string, options: DragAndDropOptions = {}): Promise<void> {
    await this.mainFrame().dragAndDrop(source, target, options);
  }

  async emulateMedia(options?: { colorScheme?: null|"light"|"dark"|"no-preference"; contrast?: null|"no-preference"|"more"; forcedColors?: null|"active"|"none"; media?: null|"screen"|"print"; reducedMotion?: null|"reduce"|"no-preference"; }): Promise<void>;
  async emulateMedia(options: EmulateMediaOptions = {}): Promise<void> {
    this.emulatedMedia = {
      ...this.emulatedMedia,
      ...options
    };
    await this.applyEmulatedMedia();
  }

  async setChecked(selector: string, checked: boolean, options?: { force?: boolean; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  async setChecked(selector: string, checked: boolean, options?: ClickOptions): Promise<void> {
    await this.mainFrame().setChecked(selector, checked, options);
  }

  async setExtraHTTPHeaders(headers: { [key: string]: string; }): Promise<void> {
    await this.adapter.setExtraHTTPHeaders(normalizeExtraHTTPHeaders(headers));
  }

  async setInputFiles(
    selector: string,
    files: PlaywrightInputFiles,
    options?: { noWaitAfter?: boolean; strict?: boolean; timeout?: number; }
  ): Promise<void>;
  async setInputFiles(
    selector: ElementHandle,
    files: InputFiles,
    options?: SetInputFilesOptions
  ): Promise<void>;
  async setInputFiles(
    selector: string | ElementHandle,
    files: PlaywrightInputFiles | InputFiles,
    options?: SetInputFilesOptions
  ): Promise<void> {
    if (typeof selector === "string") {
      await this.mainFrame().setInputFiles(selector, files as InputFiles, options);
      return;
    }
    await setInputFilesOnElement(selector, files as InputFiles);
  }

  async dispatchEvent(selector: string, type: string, eventInit?: EvaluationArgument, options?: { strict?: boolean; timeout?: number; }): Promise<void>;
  async dispatchEvent(selector: string, type: string, eventInit?: EvaluationArgument, options?: DispatchEventOptions): Promise<void> {
    await (this.mainFrame() as RoxyFrame).dispatchEvent(selector, type, eventInit, options);
  }

  async requestGC(): Promise<void> {
    await this.adapter.requestGC();
  }

  async selectOption(
    selector: string,
    values: PlaywrightSelectOptionValues,
    options?: { force?: boolean; noWaitAfter?: boolean; strict?: boolean; timeout?: number; }
  ): Promise<Array<string>>;
  async selectOption(
    selector: string,
    values: PlaywrightSelectOptionValues,
    options?: SelectorStrictOptions & { force?: boolean; noWaitAfter?: boolean; }
  ): Promise<string[]> {
    return this.mainFrame().selectOption(selector, values, options);
  }

  async bringToFront(): Promise<void> {
    await this.adapter.bringToFront();
  }

  isClosed(): boolean {
    return this.closed || this.adapter.isClosed();
  }

  setDefaultNavigationTimeout(timeout: number): void {
    this.defaultNavigationTimeoutMs = timeout;
  }

  setDefaultTimeout(timeout: number): void {
    this.defaultTimeoutMs = timeout;
  }

  async setViewportSize(viewportSize: { width: number; height: number; }): Promise<void>;
  async setViewportSize(viewportSize: ViewportSize): Promise<void> {
    await this.adapter.setViewportSize(viewportSize);
    this.currentViewportSize = viewportSize;
  }

  viewportSize(): ViewportSize | null {
    return this.currentViewportSize;
  }

  async dblclick(selector: string, options?: { button?: "left"|"right"|"middle"; delay?: number; force?: boolean; modifiers?: Array<"Alt"|"Control"|"ControlOrMeta"|"Meta"|"Shift">; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  async dblclick(selector: string, options?: ClickOptions): Promise<void> {
    await this.mainFrame().dblclick(selector, options);
  }

  async click(selector: string, options?: { button?: "left"|"right"|"middle"; clickCount?: number; delay?: number; force?: boolean; modifiers?: Array<"Alt"|"Control"|"ControlOrMeta"|"Meta"|"Shift">; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  async click(selector: string, options?: ClickOptions): Promise<void> {
    await this.mainFrame().click(selector, options);
  }

  async hover(selector: string, options?: { force?: boolean; modifiers?: Array<"Alt"|"Control"|"ControlOrMeta"|"Meta"|"Shift">; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  async hover(selector: string, options?: HoverOptions): Promise<void> {
    await this.mainFrame().hover(selector, options);
  }

  async fill(selector: string, value: string, options?: { force?: boolean; noWaitAfter?: boolean; strict?: boolean; timeout?: number; }): Promise<void>;
  async fill(selector: string, value: string, options?: FillOptions): Promise<void> {
    await this.mainFrame().fill(selector, value, options);
  }

  async type(selector: string, text: string, options?: { delay?: number; noWaitAfter?: boolean; strict?: boolean; timeout?: number; }): Promise<void>;
  async type(selector: string, value: string, options?: TypeOptions): Promise<void> {
    await this.mainFrame().type(selector, value, options);
  }

  async press(selector: string, key: string, options?: { delay?: number; noWaitAfter?: boolean; strict?: boolean; timeout?: number; }): Promise<void>;
  async press(selector: string, key: string, options?: PressOptions): Promise<void> {
    await this.mainFrame().press(selector, key, options);
  }

  async tap(selector: string, options?: { force?: boolean; modifiers?: Array<"Alt"|"Control"|"ControlOrMeta"|"Meta"|"Shift">; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  async tap(selector: string, options?: TapOptions): Promise<void> {
    await this.mainFrame().tap(selector, options);
  }

  async close(options?: { reason?: string; runBeforeUnload?: boolean; }): Promise<void>;
  async close(options: PageCloseOptions = {}): Promise<void> {
    if (options.runBeforeUnload) {
      await this.adapter.close(options);
      return;
    }

    this.closeReason = options.reason;
    const currentPick = this.pickLocatorState;
    this.pickLocatorState = null;
    currentPick?.reject(this.createClosedError());
    this.closed = true;
    try {
      await this.finalizeVideoRecording();
      await this.adapter.close(options);
      this.emit("close", this as unknown as PageEventMap["close"]);
    } finally {
      for (const dispose of this.internalDisposers.values()) {
        dispose();
      }
      this.internalDisposers.clear();
      this.browserContext?.detachPage(this);
    }
  }

  defaultTimeout(): number {
    return this.defaultTimeoutMs;
  }

  strictSelectors(): boolean {
    return Boolean(this.contextOptions.strictSelectors);
  }

  defaultNavigationTimeout(): number {
    return this.defaultNavigationTimeoutMs;
  }

  baseURLForMatching(): string | undefined {
    return this.baseURL();
  }

  setOpener(page: Page | null): void {
    this.openerPage = page;
  }

  emitPopup(popup: Page): void {
    this.emit("popup", popup);
  }

  setVideoPath(videoPath: string | null): void {
    this.setVideo(videoPath ? new RoxyVideo(videoPath) : null);
  }

  setVideo(
    video: Video | null,
    stopRecording?: () => Promise<void>,
    rejectRecording?: (error: unknown) => void
  ): void {
    this.pageVideo = video;
    this.stopPageVideoRecording = stopRecording ?? null;
    this.rejectPageVideoRecording = rejectRecording ?? null;
  }

  async startVideoRecording(options: {
    path: string;
    size?: {
      width: number;
      height: number;
    };
    quality?: number;
    showActions?: {
      duration?: number;
      position?: "top-left" | "top" | "top-right" | "bottom-left" | "bottom" | "bottom-right";
      fontSize?: number;
    };
  }): Promise<Disposable> {
    return (this.screencast as RoxyScreencast).startBackgroundRecording(options);
  }

  attachWorker(worker: Worker = new RoxyWorker()): Worker {
    this.pageWorkers.push(worker);
    worker.once("close", () => {
      const index = this.pageWorkers.indexOf(worker);
      if (index !== -1) {
        this.pageWorkers.splice(index, 1);
      }
    });
    this.emit("worker", worker);
    return worker;
  }

  private async finalizeVideoRecording(): Promise<void> {
    if (this.pageVideoFinalizePromise) {
      await this.pageVideoFinalizePromise;
      return;
    }
    if (!this.stopPageVideoRecording) {
      return;
    }

    const stopRecording = this.stopPageVideoRecording;
    this.stopPageVideoRecording = null;
    const rejectRecording = this.rejectPageVideoRecording;
    this.rejectPageVideoRecording = null;
    this.pageVideoFinalizePromise = (async () => {
      try {
        await stopRecording();
      } catch (error) {
        rejectRecording?.(error);
        throw error;
      }
    })();
    try {
      await this.pageVideoFinalizePromise;
    } finally {
      this.pageVideoFinalizePromise = null;
    }
  }

  private async handleAdapterClosed(): Promise<void> {
    if (this.closed) {
      return;
    }
    const currentPick = this.pickLocatorState;
    this.pickLocatorState = null;
    currentPick?.reject(this.createClosedError());
    this.closed = true;

    const stopRecording = this.stopPageVideoRecording;
    this.stopPageVideoRecording = null;
    const rejectRecording = this.rejectPageVideoRecording;
    this.rejectPageVideoRecording = null;
    if (rejectRecording) {
      rejectRecording(this.createClosedError());
    }
    if (stopRecording) {
      void stopRecording().catch(() => {});
    }
    this.browserContext?.detachPage(this);
  }

  async maybeRunLocatorHandlers(
    locator: Locator,
    options?: { force?: boolean; timeout?: number; __roxyBeforeActionRetry?: () => Promise<boolean | void> }
  ): Promise<boolean> {
    if (this.locatorHandlers.length === 0) {
      delete options?.__roxyBeforeActionRetry;
      await this.maybeResolvePickLocator(locator);
      return false;
    }
    if (options?.force || this.locatorHandlerRunningCounter > 0) {
      if (this.locatorHandlerRunningCounter > 0) {
        delete options?.__roxyBeforeActionRetry;
      }
      return false;
    }

    let didRunHandler = false;
    for (const entry of [...this.locatorHandlers]) {
      if (entry.running) {
        continue;
      }
      if (!entry.remainingTimes && entry.remainingTimes !== null) {
        continue;
      }

      const visible = await entry.locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      didRunHandler = didRunHandler || !entry.noWaitAfter;
      entry.running = true;
      const timeout = options?.timeout ?? this.defaultTimeoutMs;
      let timedOut = false;
      let shouldRemove = false;
      const handlerPromise = Promise.resolve().then(() => entry.handler(entry.locator));
      if (entry.remainingTimes !== null) {
        entry.remainingTimes -= 1;
        shouldRemove = entry.remainingTimes <= 0;
      }
      try {
        this.locatorHandlerRunningCounter++;
        await runWithTimeout(handlerPromise, timeout, () => {
          timedOut = true;
        });
        if (shouldRemove) {
          await this.removeLocatorHandler(entry.locator);
        }
        if (!entry.noWaitAfter) {
          await this.waitForLocatorToHide(entry.locator, timeout);
        }
      } finally {
        this.locatorHandlerRunningCounter--;
        if (timedOut) {
          void handlerPromise
            .catch(() => {})
            .then(async () => {
              if (shouldRemove) {
                await this.removeLocatorHandler(entry.locator).catch(() => {});
              }
            })
            .finally(() => {
              entry.running = false;
            });
        } else {
          entry.running = false;
        }
      }
    }

    await this.maybeResolvePickLocator(locator);
    return didRunHandler;
  }

  frameById(id: string): RoxyFrame | null {
    return this.frameMap.get(id) ?? null;
  }

  createElementHandle(adapter: ProtocolElementHandleAdapter): RoxyElementHandle {
    return new RoxyElementHandle(adapter, this.humanDefaults, this);
  }

  createElementHandleFromReference(reference: ProtocolElementHandleReference): ElementHandle {
    return this.createElementHandle(this.adapter.createHandle(reference));
  }

  async frameElementForFrame(frame: RoxyFrameSnapshot): Promise<ElementHandle | null> {
    if (frame.ownerElementReference) {
      return this.createElementHandleFromReference(frame.ownerElementReference);
    }
    if (frame.nativeFrameId && this.adapter.frameElementReference) {
      const reference = await this.adapter.frameElementReference(frame.nativeFrameId).catch(() => null);
      if (reference) {
        return this.createElementHandleFromReference(reference);
      }
    }
    if (frame.ownerElementChain.length) {
      return this.createElementHandleFromReference({
        chain: frame.ownerElementChain,
        pick: { kind: "first" }
      });
    }
    if (frame.name) {
      const escapedName = cssStringEscape(frame.name);
      const escapedId = cssIdentifierEscape(frame.name);
      const handle = await this.adapter.query([
        {
          strategy: "css",
          value: `iframe[name="${escapedName}"],frame[name="${escapedName}"],iframe#${escapedId},frame#${escapedId}`
        }
      ]).catch(() => null);
      if (handle) {
        return this.createElementHandle(handle);
      }
    }
    if (frame.parentId) {
      const siblings = this.frames()
        .filter((candidate): candidate is RoxyFrame => candidate instanceof RoxyFrame)
        .filter((candidate) => candidate.snapshotState().parentId === frame.parentId);
      const index = siblings.findIndex((candidate) => {
        const candidateSnapshot = candidate.snapshotState();
        return candidateSnapshot.id === frame.id ||
          Boolean(frame.nativeFrameId && candidateSnapshot.nativeFrameId === frame.nativeFrameId);
      });
      if (index !== -1) {
        const handles = await this.adapter.queryAll([
          { strategy: "css", value: "iframe,frame" }
        ]).catch(() => []);
        const handle = handles[index];
        if (handle) {
          return this.createElementHandle(handle);
        }
      }
    }
    return null;
  }

  async contentFrameForElement(handle: RoxyElementHandle): Promise<Frame | null> {
    await this.refreshFrameSnapshots().catch(() => {});
    const nativeFrameId = await handle.protocolContentFrameId().catch(() => null);
    if (nativeFrameId) {
      const frame = this.frameByNativeId(nativeFrameId);
      if (frame && frame.parentFrame() !== null) {
        return frame;
      }
      if (!frame) {
        return this.ensureContentFrame(nativeFrameId, handle);
      }
      const matchedFrame = await this.matchContentFrameByOwnerElement(handle);
      if (matchedFrame) {
        return matchedFrame;
      }
    }
    for (const frame of this.frames()) {
      const snapshot = (frame as RoxyFrame).snapshotState();
      if (!snapshot.ownerElementChain.length) {
        continue;
      }
      if (await this.referencesSameNode(handle.reference(), {
        chain: snapshot.ownerElementChain,
        pick: { kind: "first" }
      })) {
        return frame;
      }
    }
    return null;
  }

  private async matchContentFrameByOwnerElement(handle: RoxyElementHandle): Promise<Frame | null> {
    const ownerInfo = await handle.evaluate((element) => {
      if (!(element instanceof HTMLIFrameElement) && !(element instanceof HTMLFrameElement)) {
        return null;
      }
      return {
        id: element.id,
        name: element.getAttribute("name") ?? element.id ?? "",
        index: Array.from(element.ownerDocument.querySelectorAll("iframe,frame")).indexOf(element),
        src: element.src || "about:blank"
      };
    }).catch(() => null);
    if (!ownerInfo) {
      return null;
    }
    await this.refreshFrameSnapshots().catch(() => {});
    const byName = this.frames().find((frame) => {
      if (frame.parentFrame() === null) {
        return false;
      }
      return Boolean(ownerInfo.id && (frame as RoxyFrame).snapshotState().name === ownerInfo.id) ||
        Boolean(ownerInfo.name && frame.name() === ownerInfo.name);
    });
    if (byName) {
      return byName;
    }
    const siblings = this.frames().filter((frame) => frame.parentFrame() !== null);
    if (ownerInfo.index >= 0 && siblings[ownerInfo.index]) {
      return siblings[ownerInfo.index]!;
    }
    return this.frames().find((frame) =>
      frame.parentFrame() !== null &&
      Boolean(ownerInfo.src !== "about:blank" && frame.url() === ownerInfo.src)
    ) ?? null;
  }

  private async ensureContentFrame(nativeFrameId: string, owner: RoxyElementHandle): Promise<Frame> {
    const existing = this.frameByNativeId(nativeFrameId);
    if (existing) {
      return existing;
    }
    await this.refreshFrameSnapshots().catch(() => {});
    const refreshed = this.frameByNativeId(nativeFrameId);
    if (refreshed) {
      this.nativeFrameBindings.set(nativeFrameId, (refreshed as RoxyFrame).snapshotState().id);
      return refreshed;
    }

    const ownerReference = owner.reference();
    const ownerElementChain = ownerReference.chain.length ? ownerReference.chain : [];
    const referenceChain = ownerElementChain.length
      ? [
          ...ownerElementChain,
          { strategy: "control" as const, value: "enter-frame" }
        ]
      : [];
    const id = nativeFrameId;
    const snapshot: RoxyFrameSnapshot = {
      id,
      name: await owner.evaluate((element) =>
        element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement
          ? element.getAttribute("name") ?? element.id ?? ""
          : ""
      ).catch(() => ""),
      nativeFrameId,
      ownerElementReference: ownerReference,
      ownerElementChain,
      parentId: "main",
      referenceChain,
      url: await owner.evaluate((element) =>
        element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement
          ? element.src || "about:blank"
          : "about:blank"
      ).catch(() => "about:blank")
    };
    const frame = new RoxyFrame(this, snapshot);
    this.frameMap.set(id, frame);
    this.nativeFrameBindings.set(nativeFrameId, id);
    this.frameOrder.push(id);
    this.emit("frameattached", frame);
    this.emit("framenavigated", frame);
    return frame;
  }

  async ownerFrameForElement(handle: RoxyElementHandle): Promise<Frame | null> {
    await this.refreshFrameSnapshots().catch(() => {});
    const nativeFrameId = await handle.protocolOwnerFrameId().catch(() => null);
    if (nativeFrameId) {
      const frame = this.frameByNativeId(nativeFrameId);
      if (frame) {
        return frame;
      }
      for (const page of this.browserContext?.pages() ?? []) {
        if (page === this || !(page instanceof RoxyPage)) {
          continue;
        }
        await page.refreshFrameSnapshots().catch(() => {});
        const frame = page.frameByNativeId(nativeFrameId);
        if (frame) {
          return frame;
        }
      }
    }
    for (const frame of this.frames()) {
      const snapshot = (frame as RoxyFrame).snapshotState();
      if (await this.evaluateOwnerFrameMatch(snapshot, handle)) {
        return frame;
      }
    }
    return null;
  }

  private frameByNativeId(nativeFrameId: string): Frame | null {
    const boundFrameId = this.nativeFrameBindings.get(nativeFrameId);
    if (boundFrameId) {
      const boundFrame = this.frameById(boundFrameId);
      if (boundFrame) {
        return boundFrame;
      }
      this.nativeFrameBindings.delete(nativeFrameId);
    }
    for (const frame of this.frames()) {
      const snapshot = (frame as RoxyFrame).snapshotState();
      if (snapshot.nativeFrameId === nativeFrameId || snapshot.id === nativeFrameId) {
        this.nativeFrameBindings.set(nativeFrameId, snapshot.id);
        return frame;
      }
    }
    return null;
  }

  private async referencesSameNode(
    left: ProtocolElementHandleReference,
    right: ProtocolElementHandleReference
  ): Promise<boolean> {
    return this.adapter.evaluate<boolean>(
      `(payload) => {
        const resolveBridgeScope = () => {
          try {
            return globalThis.top ?? globalThis;
          } catch {
            return globalThis;
          }
        };
        const globalState = resolveBridgeScope();
        const isElementNode = node => !!node && typeof node === "object" && "nodeType" in node && node.nodeType === 1;
        const queryAll = (root, selector) => Array.from(root.querySelectorAll(selector.value));
        const applyPick = (nodes, pick) => {
          if (!pick)
            return nodes;
          if (pick.kind === "first")
            return nodes.slice(0, 1);
          if (pick.kind === "last")
            return nodes.slice(-1);
          return nodes[pick.index] ? [nodes[pick.index]] : [];
        };
        const resolve = reference => {
          if (reference.handleId) {
            const node = globalState.__roxyHandleStore?.[reference.handleId] ?? null;
            return node ? [node] : [];
          }
          let current = [document];
          for (const selector of reference.chain) {
            if (selector.strategy === "control" && selector.value === "enter-frame") {
              current = current
                .filter(node => isElementNode(node) && (node.tagName === "IFRAME" || node.tagName === "FRAME"))
                .map(frame => frame.contentDocument)
                .filter(Boolean);
              continue;
            }
            if (selector.strategy !== "css")
              return [];
            current = current.flatMap(root => queryAll(root, selector));
          }
          return applyPick(current, reference.pick);
        };
        return resolve(payload.left)[0] === resolve(payload.right)[0];
      }`,
      { left, right },
      true
    );
  }

  private async evaluateOwnerFrameMatch(
    frame: RoxyFrameSnapshot,
    handle: RoxyElementHandle
  ): Promise<boolean> {
    return this.adapter.evaluate<boolean>(
      `(payload) => {
        const resolveBridgeScope = () => {
          try {
            return globalThis.top ?? globalThis;
          } catch {
            return globalThis;
          }
        };
        const globalState = resolveBridgeScope();
        const isElementNode = node => !!node && typeof node === "object" && "nodeType" in node && node.nodeType === 1;
        const resolve = reference => {
          if (reference.handleId) {
            const node = globalState.__roxyHandleStore?.[reference.handleId] ?? null;
            return node ? [node] : [];
          }
          let current = [document];
          for (const selector of reference.chain) {
            if (selector.strategy === "control" && selector.value === "enter-frame") {
              current = current
                .filter(node => isElementNode(node) && (node.tagName === "IFRAME" || node.tagName === "FRAME"))
                .map(frame => frame.contentDocument)
                .filter(Boolean);
              continue;
            }
            if (selector.strategy !== "css")
              return [];
            current = current.flatMap(root => Array.from(root.querySelectorAll(selector.value)));
          }
          return current;
        };
        const node = resolve(payload.handle)[0] ?? null;
        const frameRoots = payload.frameReference.length
          ? resolve({ chain: payload.frameReference })
          : [document];
        const frameDocument = frameRoots[0] ?? null;
        return !!node && !!frameDocument && node.ownerDocument === frameDocument;
      }`,
      {
        frameReference: frame.referenceChain,
        handle: handle.reference()
      },
      true
    );
  }

  async evaluateInFrame<R, Arg>(
    frame: RoxyFrameSnapshot,
    pageFunction: PageFunction<Arg, R>,
    arg?: Arg
  ): Promise<R> {
    return this.evaluateInFrameWithFunctionFlag(frame, pageFunction, arg, typeof pageFunction === "function");
  }

  async evaluateInFrameWithFunctionFlag<R, Arg>(
    frame: RoxyFrameSnapshot,
    pageFunction: PageFunction<Arg, R>,
    arg: Arg | undefined,
    isFunction: boolean
  ): Promise<R> {
    if (frame.nativeFrameId && this.adapter.evaluateInFrame) {
      try {
        return await this.adapter.evaluateInFrame<R>(
          frame.nativeFrameId,
          serializePageFunction(pageFunction as string | ElementCallback<R, Arg>),
          arg,
          isFunction
        );
      } catch (error) {
        if (!this.shouldFallbackToOwnerElementFrameEvaluation(error, frame)) {
          throw error;
        }
      }
    }

    const owner = frame.ownerElementChain.length ? await this.ownerElementAdapterForFrame(frame) : null;
    if (!owner) {
      return this.evaluate(pageFunction, arg as Arg);
    }

    return this.createElementHandle(owner).evaluate(
      `(iframe, payload) => {
        const targetWindow = iframe.contentWindow;
        const targetDocument = iframe.contentDocument;
        if (!targetWindow || !targetDocument) {
          throw new Error("Frame is not available.");
        }

        if (!payload.isFunction) {
          return targetWindow.eval(payload.expression);
        }

        const callback = targetWindow.eval("(" + payload.expression + ")");
        return callback(payload.arg);
      }`,
      {
        arg: serializeEvaluationArgument(arg),
        expression: serializePageFunction(pageFunction as string | ElementCallback<R, Arg>),
        isFunction
      }
    );
  }

  async evaluateHandleInFrame<R, Arg>(
    frame: RoxyFrameSnapshot,
    pageFunction: PageFunction<Arg, R>,
    arg?: Arg
  ): Promise<SmartHandle<R>> {
    if (frame.nativeFrameId && this.adapter.evaluateHandleInFrame) {
      try {
        return await createRemoteJSHandle(
          await this.adapter.evaluateHandleInFrame<R>(
            frame.nativeFrameId,
            serializePageFunction(pageFunction as string | ElementCallback<R, Arg>),
            arg,
            typeof pageFunction === "function"
          ),
          (reference) => this.createElementHandle(this.adapter.createHandle(reference))
        ) as unknown as SmartHandle<R>;
      } catch (error) {
        if (!this.shouldFallbackToOwnerElementFrameEvaluation(error, frame)) {
          throw error;
        }
        await this.refreshFrameSnapshots().catch(() => {});
        if (!frame.ownerElementChain.length) {
          throw error;
        }
      }
    }

    const owner = frame.ownerElementChain.length ? await this.ownerElementAdapterForFrame(frame) : null;
    if (!owner) {
      return this.evaluateHandle(pageFunction, arg as Arg);
    }

    const expression = `(iframe, payload) => {
      const targetWindow = iframe.contentWindow;
      const targetDocument = iframe.contentDocument;
      if (!targetWindow || !targetDocument) {
        throw new Error("Frame is not available.");
      }

      if (!payload.isFunction) {
        return targetWindow.eval(payload.expression);
      }

      const callback = targetWindow.eval("(" + payload.expression + ")");
      return callback(payload.arg);
    }`;
    const payload = {
      arg: serializeEvaluationArgument(arg),
      expression: serializePageFunction(pageFunction as string | ElementCallback<R, Arg>),
      isFunction:
        typeof pageFunction !== "string" ||
        /^\s*(async\s+function|function|\(?\s*[A-Za-z_$\)]).*/s.test(String(pageFunction).trim())
    };

    if (!this.adapter.evaluateHandle) {
      const value = await this.createElementHandle(owner).evaluate<R>(expression, payload);
      return createSmartHandle(value);
    }

    const handle = await this.createElementHandle(owner).evaluateHandle<R>(expression, payload);
    const element = handle.asElement();
    if (element && frame.nativeFrameId) {
      const reference = (element as unknown as RoxyElementHandle).reference();
      reference.protocolFrameId ??= frame.nativeFrameId;
    }
    return handle;
  }

  private shouldFallbackToOwnerElementFrameEvaluation(error: unknown, frame: RoxyFrameSnapshot): boolean {
    if (!frame.ownerElementReference && !frame.ownerElementChain.length) {
      return false;
    }
    return error instanceof Error && error.message.includes("Frame execution context is not available");
  }

  private async ownerElementAdapterForFrame(frame: RoxyFrameSnapshot): Promise<ProtocolElementHandleAdapter | null> {
    if (frame.ownerElementReference) {
      return this.adapter.createHandle(frame.ownerElementReference);
    }
    if (!frame.ownerElementChain.length) {
      return null;
    }
    return this.adapter.query(frame.ownerElementChain);
  }

  async queryInFrame(
    frame: RoxyFrameSnapshot,
    selector: string,
    options?: { strict?: boolean }
  ): Promise<ElementHandle | null> {
    const missingMessage = `Failed to find element matching selector "${selector}"`;
    const handle = await this.adapter.createHandleReference(
      this.referenceForFrame(
        frame,
        parseSelectorChain(selector),
        options?.strict ? undefined : { kind: "first" }
      ),
      missingMessage
    ).then(
      (reference) => this.adapter.createHandle(reference),
      (error) => {
        if (error instanceof Error && error.message.includes(missingMessage)) {
          return null;
        }
        throw error;
      }
    );
    return handle ? this.createElementHandle(handle) : null;
  }

  async queryAllInFrame(frame: RoxyFrameSnapshot, selector: string): Promise<ElementHandle[]> {
    return (await this.locatorInFrame(frame, selector).elementHandles()) as ElementHandle[];
  }

  async refreshFramesForExternalMutation(): Promise<void> {
    await this.refreshFrameSnapshots();
  }

  async gotoInFrame(frame: RoxyFrameSnapshot, url: string, options: PageGotoOptions = {}): Promise<Response | null> {
    await this.refreshFrameSnapshots().catch(() => {});
    const currentFrame = this.frameById(frame.id);
    const currentSnapshot = currentFrame?.snapshotState() ?? frame;
    if (currentSnapshot.parentId === null) {
      const previousUrl = this.mainFrame().url();
      const response = await this.adapter.goto(url, {
        ...options,
        timeout: options.timeout ?? this.defaultNavigationTimeoutMs
      });
      await this.reinstallExposedBindings();
      await this.refreshFrameSnapshots();
      const currentUrl = this.adapter.url();
      const mainFrame = this.mainFrame();
      if (currentUrl !== previousUrl && mainFrame instanceof RoxyFrame && mainFrame.url() !== currentUrl) {
        mainFrame.setSnapshot({
          ...mainFrame.snapshotState(),
          url: currentUrl
        });
        this.emit("framenavigated", mainFrame);
      }
      return this.toPublicResponse(response);
    }

    if (!currentFrame) {
      throw new Error("Navigating frame was detached!");
    }
    const navigationPromise = currentFrame.waitForNavigation({
      url,
      ...options
    });
    await this.evaluateInFrame(currentSnapshot, (targetUrl) => {
      window.location.href = targetUrl;
    }, url);
    return navigationPromise;
  }

  async titleInFrame(frame: RoxyFrameSnapshot): Promise<string> {
    if (frame.parentId === null) {
      return this.adapter.title();
    }
    return this.evaluateInFrame(frame, () => document.title);
  }

  async contentInFrame(frame: RoxyFrameSnapshot): Promise<string> {
    if (frame.parentId === null) {
      return this.adapter.content();
    }
    return this.evaluateInFrame(frame, () => {
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
      return doctype + (documentElement as Element).outerHTML;
    });
  }

  async setContentInFrame(
    frame: RoxyFrameSnapshot,
    html: string,
    options?: PageSetContentOptions
  ): Promise<void> {
    if (frame.parentId === null) {
      await this.adapter.setContent(html, {
        ...options,
        timeout: options?.timeout ?? this.defaultNavigationTimeoutMs
      });
      await this.reinstallExposedBindings();
      await this.refreshFrameSnapshots();
      return;
    }

    await this.evaluateInFrame(frame, (content) => {
      document.open();
      document.write(content);
      document.close();
    }, html);
    if (options?.waitUntil !== "commit") {
      await this.waitForLoadState(
        options?.waitUntil,
        options?.timeout === undefined ? {} : { timeout: options.timeout }
      );
    }
    await this.refreshFramesForExternalMutation();
  }

  async evalOnSelectorInFrame<TResult, TArg = unknown>(
    frame: RoxyFrameSnapshot,
    selector: string,
    pageFunction: string | ElementCallback<TResult, TArg>,
    arg?: TArg
  ): Promise<TResult> {
    return this.adapter.evaluateOnReference(
      this.referenceForFrame(frame, parseSelectorChain(selector), { kind: "first" }),
      serializePageFunction(pageFunction),
      serializeEvaluationArgument(arg),
      `Failed to find element matching selector "${selector}"`,
      typeof pageFunction === "function" ? true : undefined
    );
  }

  async evalOnSelectorAllInFrame<TResult, TArg = unknown>(
    frame: RoxyFrameSnapshot,
    selector: string,
    pageFunction: string | ElementArrayCallback<TResult, TArg>,
    arg?: TArg
  ): Promise<TResult> {
    return this.adapter.evaluateOnReferenceAll(
      this.referenceForFrame(frame, parseSelectorChain(selector)),
      serializePageFunction(pageFunction),
      serializeEvaluationArgument(arg),
      typeof pageFunction === "function" ? true : undefined
    );
  }

  async addScriptTagInFrame(
    frame: RoxyFrameSnapshot,
    options: AddScriptTagOptions = {}
  ): Promise<ElementHandle> {
    const adapterOptions = await this.normalizeScriptTagOptions(options);
    if (frame.parentId === null) {
      return this.createElementHandle(await this.adapter.addScriptTag(adapterOptions));
    }

    await this.evaluateInFrame(
      frame,
      ({ content, type, url }) => {
        const script = document.createElement("script");
        if (type !== undefined) script.type = type;
        if (url !== undefined) script.src = url;
        if (content !== undefined) script.appendChild(document.createTextNode(content));
        document.head.appendChild(script);
      },
      adapterOptions
    );
    const handle = await this.queryInFrame(frame, "script:last-of-type");
    if (!handle) {
      throw new Error("Failed to add script tag");
    }
    return handle;
  }

  async addStyleTagInFrame(
    frame: RoxyFrameSnapshot,
    options: AddStyleTagOptions = {}
  ): Promise<ElementHandle> {
    const adapterOptions = await this.normalizeStyleTagOptions(options);
    if (frame.parentId === null) {
      return this.createElementHandle(await this.adapter.addStyleTag(adapterOptions));
    }

    await this.evaluateInFrame(
      frame,
      ({ content, url }) => {
        const element = url === undefined
          ? document.createElement("style")
          : document.createElement("link");
        if (url !== undefined) {
          (element as HTMLLinkElement).rel = "stylesheet";
          (element as HTMLLinkElement).href = url;
        } else if (content !== undefined) {
          element.textContent = content;
        }
        document.head.appendChild(element);
      },
      adapterOptions
    );
    const handle = await this.queryInFrame(frame, "head > style:last-of-type, head > link[rel=\"stylesheet\"]:last-of-type");
    if (!handle) {
      throw new Error("Failed to add style tag");
    }
    return handle;
  }

  locatorInFrame(frame: RoxyFrameSnapshot, selector: string): Locator {
    const chain = parseSelectorChain(selector);
    if (frame.nativeFrameId && this.adapter.locatorInFrame) {
      return this.createLocatorFromAdapterChain(
        this.adapter.locatorInFrame(frame.nativeFrameId, chain[0]!),
        chain,
        frame.id
      );
    }
    return this.createLocatorFromChain(this.chainForFrame(frame, chain), frame.id);
  }

  getByTextInFrame(
    frame: RoxyFrameSnapshot,
    text: string | RegExp,
    options?: GetByTextOptions
  ): Locator {
    return this.rootLocatorForFrame(frame).getByText(text, options);
  }

  getByAltTextInFrame(
    frame: RoxyFrameSnapshot,
    text: string | RegExp,
    options?: GetByAltTextOptions
  ): Locator {
    return this.rootLocatorForFrame(frame).getByAltText(text, options);
  }

  getByLabelInFrame(
    frame: RoxyFrameSnapshot,
    text: string | RegExp,
    options?: GetByLabelOptions
  ): Locator {
    return this.rootLocatorForFrame(frame).getByLabel(text, options);
  }

  getByPlaceholderInFrame(
    frame: RoxyFrameSnapshot,
    text: string | RegExp,
    options?: GetByPlaceholderOptions
  ): Locator {
    return this.rootLocatorForFrame(frame).getByPlaceholder(text, options);
  }

  getByTestIdInFrame(frame: RoxyFrameSnapshot, testId: string | RegExp): Locator {
    return this.rootLocatorForFrame(frame).getByTestId(testId);
  }

  getByRoleInFrame(
    frame: RoxyFrameSnapshot,
    role: string,
    options?: GetByRoleOptions
  ): Locator {
    return this.rootLocatorForFrame(frame).getByRole(role, options);
  }

  getByTitleInFrame(
    frame: RoxyFrameSnapshot,
    text: string | RegExp,
    options?: GetByTitleOptions
  ): Locator {
    return this.rootLocatorForFrame(frame).getByTitle(text, options);
  }

  private async normalizeScriptTagOptions(options: AddScriptTagOptions): Promise<AddScriptTagOptions> {
    if (!options.url && !options.path && !options.content) {
      throw new Error("Provide an object with a `url`, `path` or `content` property");
    }
    const content = options.path
      ? addSourceUrlToScript(await readFile(options.path, "utf8"), options.path)
      : options.content;
    return {
      ...options,
      ...(content !== undefined ? { content } : {})
    };
  }

  private async normalizeStyleTagOptions(options: AddStyleTagOptions): Promise<AddStyleTagOptions> {
    if (!options.url && !options.path && !options.content) {
      throw new Error("Provide an object with a `url`, `path` or `content` property");
    }
    const content = options.path
      ? `${await readFile(options.path, "utf8")}/*# sourceURL=${options.path.replace(/\n/g, "")}*/`
      : options.content;
    return {
      ...options,
      ...(content !== undefined ? { content } : {})
    };
  }

  private matchesURL(
    current: URL,
    matcher: string | RegExp | URLPattern | ((url: URL) => boolean)
  ): boolean {
    return urlMatches(this.baseURL(), current.toString(), matcher);
  }

  private matchesEventURLPredicate<TPayload>(
    url: string,
    matcher:
      | string
      | RegExp
      | ((url: string) => boolean)
      | ((payload: TPayload) => boolean | Promise<boolean>),
    payload: TPayload
  ): boolean | Promise<boolean> {
    if (typeof matcher === "string") {
      return urlMatches(this.baseURL(), url, matcher);
    }
    if (matcher instanceof RegExp) {
      return urlMatches(this.baseURL(), url, matcher);
    }
    try {
      return (matcher as (payload: TPayload) => boolean | Promise<boolean>)(payload);
    } catch {
      return (matcher as (url: string) => boolean)(url);
    }
  }

  private ensureListenerSet<K extends PageEventName>(
    event: K
  ): Set<ListenerEntry<PageEventName>> {
    const existing = this.listeners.get(event);
    if (existing) {
      return existing;
    }

    const created = new Set<ListenerEntry<PageEventName>>();
    this.listeners.set(event, created);
    return created;
  }

  private emit<K extends PageEventName>(event: K, payload: PageEventMap[K]): void {
    const normalizedPayload = this.normalizePublicEventPayload(event, payload);
    if (event === "console" && normalizedPayload && typeof normalizedPayload === "object") {
      const worker = (normalizedPayload as PageConsoleMessage).worker?.();
      if (worker instanceof RoxyWorker) {
        worker.emitConsole(normalizedPayload as PageConsoleMessage);
      }
    }
    this.recordEvent(event, normalizedPayload as PageEventMap[K]);

    const entries = this.listeners.get(event);
    if (!entries) {
      if (event === "dialog" && normalizedPayload && typeof normalizedPayload === "object") {
        void (normalizedPayload as Dialog).dismiss().catch(() => {});
      }
      return;
    }

    for (const entry of Array.from(entries)) {
      const wrapped = entry.wrapped as PageEventListener<K>;
      const result =
        normalizedPayload === undefined
          ? (wrapped as () => void)()
          : (wrapped as (eventPayload: PageEventMap[K]) => void)(normalizedPayload as PageEventMap[K]);
      this.trackPendingHandler(event, result);
    }
  }

  private removeAllListenersInternal(event?: PageEventName): void {
    const events = event ? [event] : Array.from(this.listeners.keys());
    for (const eventName of events) {
      this.listeners.delete(eventName);
      const dispose = this.adapterDisposers.get(eventName);
      if (dispose) {
        this.adapterDisposers.delete(eventName);
        dispose();
      }
    }
  }

  private hasFrameEventObservers(): boolean {
    return (
      (this.listeners.get("frameattached")?.size ?? 0) > 0 ||
      (this.listeners.get("framedetached")?.size ?? 0) > 0 ||
      (this.listeners.get("framenavigated")?.size ?? 0) > 0
    );
  }

  private trackPendingHandler(event: PageEventName, value: unknown): void {
    if (!(value instanceof Promise)) {
      return;
    }

    let pending = this.pendingHandlers.get(event);
    if (!pending) {
      pending = new Set<Promise<void>>();
      this.pendingHandlers.set(event, pending);
    }

    const tracked = Promise.resolve(value).catch((error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (this.rejectionHandler) {
        this.rejectionHandler(normalized);
        return;
      }
      throw normalized;
    }).finally(() => {
      pending!.delete(tracked);
      if (pending!.size === 0) {
        this.pendingHandlers.delete(event);
      }
    });

    pending.add(tracked);
  }

  private async waitForPendingHandlers(event?: PageEventName): Promise<void> {
    const pending =
      event === undefined
        ? Array.from(this.pendingHandlers.values()).flatMap((entries) => Array.from(entries))
        : Array.from(this.pendingHandlers.get(event) ?? []);
    await Promise.all(pending);
  }

  private recordEvent<K extends PageEventName>(event: K, payload: PageEventMap[K]): void {
    if (event === "console" && payload) {
      this.consoleMessageHistory.push(payload as PageConsoleMessage);
      this.consoleMessageHistorySinceNavigation.push(payload as PageConsoleMessage);
      if (this.consoleMessageHistory.length > 200) {
        this.consoleMessageHistory.shift();
      }
      if (this.consoleMessageHistorySinceNavigation.length > 200) {
        this.consoleMessageHistorySinceNavigation.shift();
      }
      return;
    }

    if (event === "pageerror" && payload) {
      this.pageErrorHistory.push(payload as PageErrorEntry);
      this.pageErrorHistorySinceNavigation.push(payload as PageErrorEntry);
      if (this.pageErrorHistory.length > 200) {
        this.pageErrorHistory.shift();
      }
      if (this.pageErrorHistorySinceNavigation.length > 200) {
        this.pageErrorHistorySinceNavigation.shift();
      }
      return;
    }

    if (event === "request" && payload) {
      const request = payload as unknown as Request;
      if (this.recordedRequests.has(request)) {
        return;
      }
      this.recordedRequests.add(request);
      const key = `${request.method()}:${request.url()}`;
      const queue = this.activeRequests.get(key) ?? [];
      queue.push(request);
      this.activeRequests.set(key, queue);
      this.requestHistory.push(request);
      if (this.requestHistory.length > 100) {
        this.requestHistory.shift();
      }
      return;
    }

    if (event === "requestfinished" && payload) {
      const request = payload as unknown as Request;
      const key = `${request.method()}:${request.url()}`;
      const queue = this.activeRequests.get(key);
      queue?.shift();
      if (queue?.length === 0) {
        this.activeRequests.delete(key);
      }
      return;
    }

    if (event === "requestfailed" && payload) {
      const request = payload as unknown as Request;
      const key = `${request.method()}:${request.url()}`;
      const queue = this.activeRequests.get(key);
      queue?.shift();
      if (queue?.length === 0) {
        this.activeRequests.delete(key);
      }
      return;
    }

  }

  private resetHistorySinceNavigation(): void {
    this.consoleMessageHistorySinceNavigation.length = 0;
    this.pageErrorHistorySinceNavigation.length = 0;
  }

  private initializeInternalEventRecording(): void {
    for (const event of INTERNAL_RECORDED_EVENTS) {
      const dispose = this.adapter.on(
        event,
        (async (payload?: RawPageEventMap[typeof event]) => {
          if (event === "framenavigated" && this.isRawMainFrameNavigation(payload)) {
            this.resetHistorySinceNavigation();
          }
          if (event === "frameattached" || event === "framedetached" || event === "framenavigated") {
            await this.refreshFrameSnapshots().catch(() => {});
            return;
          }
          const normalizedPayload = this.normalizePublicEventPayload(event, payload);
          this.recordEvent(event, normalizedPayload as PageEventMap[typeof event]);
        }) as RawPageEventListener<typeof event>
      );
      this.internalDisposers.set(event, dispose);
    }
  }

  private async handleAdapterBackedEvent(
    event: Extract<PageEventName, RawPageEventName>,
    payload?: RawPageEventMap[RawPageEventName]
  ): Promise<void> {
    if (event === "worker" && payload) {
      this.attachWorker(payload as Worker);
      return;
    }
    if (event === "framenavigated" && this.isRawMainFrameNavigation(payload)) {
      this.resetHistorySinceNavigation();
    }
    if (event === "frameattached" || event === "framedetached" || event === "framenavigated") {
      await this.refreshFrameSnapshots().catch(() => {});
      return;
    }
    if (event === "websocket" && payload && (payload as RawPageWebSocketEvent).kind !== "created") {
      this.handleRawWebSocketEvent(payload as RawPageWebSocketEvent);
      return;
    }
    this.emit(event, payload as never);
  }

  private normalizePublicEventPayload<K extends PageEventName>(
    event: K,
    payload: unknown
  ): PageEventMap[K] | undefined {
    if (event === "close" || event === "crash" || event === "domcontentloaded" || event === "load") {
      return this as unknown as PageEventMap[K];
    }
    if (!payload) {
      return payload as undefined;
    }
    if (typeof payload === "object") {
      const cached = this.normalizedEventPayloads.get(payload as object);
      if (cached !== undefined) {
        return cached as PageEventMap[K];
      }
    }

    let normalized: unknown = payload;
    if (event === "console") {
      normalized = this.createPublicConsoleMessage(payload as PageConsoleMessage);
    } else if (event === "dialog") {
      normalized = this.createPublicDialog(payload as PageDialog);
    } else if (event === "request") {
      normalized = this.observeAdapterRequest(payload as unknown as PageRequest);
    } else if (event === "response") {
      normalized = this.observeAdapterResponse(payload as unknown as PageResponse);
    } else if (event === "requestfinished") {
      normalized = this.observeRequestCompletion(payload as unknown as PageRequest);
    } else if (event === "requestfailed") {
      normalized = this.observeRequestFailure(
        payload as unknown as { errorText: string; method: string; url: string }
      );
    } else if (event === "websocket") {
      normalized = this.handleRawWebSocketEvent(payload as RawPageWebSocketEvent);
    }
    if (typeof payload === "object") {
      this.normalizedEventPayloads.set(payload as object, normalized);
    }
    return normalized as unknown as PageEventMap[K];
  }

  private handleRawWebSocketEvent(payload: RawPageWebSocketEvent): WebSocket | undefined {
    if (payload.kind === "created") {
      const webSocket = new RoxyWebSocket(this, payload.url);
      this.webSockets.set(payload.requestId, webSocket);
      return webSocket;
    }

    const webSocket = this.webSockets.get(payload.requestId);
    if (!webSocket) {
      return undefined;
    }

    if (payload.kind === "frameReceived") {
      webSocket.emitFrameReceived(deserializeWebSocketFrame(payload.opcode, payload.data));
    } else if (payload.kind === "frameSent") {
      webSocket.emitFrameSent(deserializeWebSocketFrame(payload.opcode, payload.data));
    } else if (payload.kind === "socketError") {
      webSocket.emitSocketError(payload.errorMessage);
    } else if (payload.kind === "closed") {
      webSocket.emitClose();
      this.webSockets.delete(payload.requestId);
    }
    return webSocket;
  }

  private createPublicDialog(payload: PageDialog): Dialog {
    return {
      accept: (promptText?: string) => payload.accept(promptText),
      defaultValue: () => payload.defaultValue(),
      dismiss: () => payload.dismiss(),
      message: () => payload.message(),
      page: () => payload.page?.() ?? this,
      type: () => payload.type()
    };
  }

  private createPublicConsoleMessage(payload: PageConsoleMessage): PageConsoleMessage {
    const location = payload.location?.() ?? DEFAULT_CONSOLE_LOCATION;
    const rawArgs = payload.args?.() ?? [];
    return {
      args: () => rawArgs,
      location: () => ({
        column: location.column,
        columnNumber: location.columnNumber,
        line: location.line,
        lineNumber: location.lineNumber,
        url: location.url
      }),
      page: () => this,
      text: () => payload.text(),
      timestamp: () => payload.timestamp?.() ?? Date.now(),
      type: () => payload.type(),
      worker: () => payload.worker?.() ?? null
    };
  }

  private observeAdapterRequest(payload: PageRequest): Request {
    const headerEntries = payload.headers.map((header) => ({
      name: header.name,
      value: header.value
    }));
    const headers = aggregateHeaders(headerEntries);
    const postData = deserializeSerializedPostData(
      payload.postData ?? null,
      payload.postDataBufferBase64 ?? null
    );
    let responsePromiseResolve!: (value: Response | null) => void;
    const responsePromise = new Promise<Response | null>((resolve) => {
      responsePromiseResolve = resolve;
    });

    const state: ObservedRequestState = {
      failure: null,
      frameId: payload.frameId ?? null,
      headerEntries,
      headers,
      isNavigationRequest: payload.isNavigationRequest ?? false,
      method: payload.method,
      requestId: payload.requestId ?? null,
      redirectedFrom: this.findRedirectSourceForRequest(payload),
      redirectedTo: null,
      request: undefined as unknown as Request,
      resourceType: payload.resourceType ?? "other",
      response: null,
      responsePromise,
      responsePromiseResolve,
      timingStartTime: Date.now(),
      postDataBuffer: postData.buffer,
      postDataText: postData.text,
      url: payload.url
    };
    if (this.isMainFrameNavigationRequest(state)) {
      this.resetHistorySinceNavigation();
    }
    const request = this.createObservedRequest(state);
    state.request = request;
    if (state.redirectedFrom) {
      state.redirectedFrom.redirectedTo = state;
    }

    const queue = this.observedRequestsByUrl.get(payload.url) ?? [];
    queue.push(state);
    this.observedRequestsByUrl.set(payload.url, queue);
    if (state.requestId) {
      this.observedRequestsById.set(state.requestId, state);
    }
    const pendingRouted = this.consumePendingRoutedRequestState(payload);
    if (pendingRouted) {
      this.applyRoutedRequestStateToObservedRequestState(state, pendingRouted);
    }
    return request;
  }

  private observeAdapterResponse(payload: PageResponse): Response {
    const state = this.findObservedRequestForResponse(payload);
    const response = this.createObservedResponse(payload, state?.request ?? null);
    if (state && !state.response && state.url === payload.url) {
      state.response = response;
      state.responsePromiseResolve(response);
      const location = response.headers()["location"];
      if (response.status() >= 300 && response.status() < 400 && location) {
        const redirectTarget = resolveRedirectUrl(state.url, location);
        const queue = this.redirectTargets.get(redirectTarget) ?? [];
        queue.push(state);
        this.redirectTargets.set(redirectTarget, queue);
      }
    }
    return response;
  }

  private observeRequestCompletion(payload: PageRequest): Request {
    const state = this.findObservedRequestState(payload.url, payload.method, payload.requestId);
    return state?.request ?? this.observeAdapterRequest(payload);
  }

  private observeRequestFailure(payload: {
    errorText: string;
    requestId?: string;
    method: string;
    url: string;
  }): Request {
    const state =
      this.findObservedRequestState(payload.url, payload.method, payload.requestId ?? null) ??
      this.observeSyntheticObservedRequest(payload.url, payload.method, payload.requestId ?? null);
    state.failure = { errorText: payload.errorText };
    state.responsePromiseResolve(null);
    return state.request;
  }

  private createObservedRequest(state: ObservedRequestState): Request {
    return {
      allHeaders: async () => ({ ...state.headers }),
      existingResponse: () => state.response,
      failure: () => state.failure,
      frame: () => {
        if (state.isNavigationRequest && !state.frameId) {
          throw new Error("Frame for this navigation request is not available");
        }
        return this.resolveObservedRequestFrame(state);
      },
      headers: () => ({ ...state.headers }),
      headersArray: async () => state.headerEntries.map((header) => ({ ...header })),
      headerValue: async (name: string) => joinHeaderValues(state.headerEntries, name),
      isNavigationRequest: () => state.isNavigationRequest,
      method: () => state.method,
      postData: () => state.postDataText,
      postDataBuffer: () =>
        state.postDataBuffer ? Buffer.from(state.postDataBuffer) : null,
      postDataJSON: () => parseObservedRequestPostData(state.postDataText, state.headers),
      redirectedFrom: () => state.redirectedFrom?.request ?? null,
      redirectedTo: () => state.redirectedTo?.request ?? null,
      resourceType: () => state.resourceType,
      response: async () => state.responsePromise,
      serviceWorker: () => null,
      sizes: async () => observedRequestSizes(state),
      timing: () => ({
        startTime: state.timingStartTime,
        domainLookupStart: -1,
        domainLookupEnd: -1,
        connectStart: -1,
        secureConnectionStart: -1,
        connectEnd: -1,
        requestStart: 0,
        responseStart: state.response ? 0 : -1,
        responseEnd: state.response ? 0 : -1
      }),
      url: () => state.url
    };
  }

  private createObservedResponse(
    payload: PageResponse,
    linkedRequest: Request | null
  ): Response {
    const headerEntries = payload.headers.map((header) => ({
      name: header.name,
      value: header.value
    }));
    const headers = aggregateHeaders(headerEntries);
    const request = linkedRequest ?? this.createObservedRequestForResponseOnly(
      payload.url,
      payload.frameId ?? null,
      payload.isNavigationRequest ?? false,
      payload.resourceType
    );
    const responseUrl = linkedRequest ? linkedRequest.url() : payload.url;
    const readBodyBuffer = createResponseBodyReader(
      payload.status,
      headerEntries,
      payload.body
        ? () => payload.body!()
        : async () => Buffer.from(await payload.text(), "utf8")
    );
    const readBodyText = createResponseTextReader(
      payload.status,
      headerEntries,
      async () => (await readBodyBuffer()).toString("utf8")
    );
    return {
      allHeaders: async () => ({ ...headers }),
      body: async () => readBodyBuffer(),
      finished: async () => waitForResponseCompletion(readBodyText),
      frame: () => request.frame(),
      fromServiceWorker: () => payload.fromServiceWorker ?? false,
      headers: () => ({ ...headers }),
      headersArray: async () => headerEntries.map((header) => ({ ...header })),
      headerValue: async (name: string) => joinHeaderValues(headerEntries, name),
      headerValues: async (name: string) => collectHeaderValues(headerEntries, name),
      httpVersion: async () => "HTTP/1.1",
      json: async () => JSON.parse(await readBodyText()),
      ok: () => payload.status === 0 || (payload.status >= 200 && payload.status < 300),
      request: () => request,
      securityDetails: async () => null,
      serverAddr: async () => null,
      status: () => payload.status,
      statusText: () => payload.statusText,
      text: () => readBodyText(),
      url: () => responseUrl
    };
  }

  private createObservedRequestForResponseOnly(
    url: string,
    frameId: string | null,
    isNavigationRequest: boolean,
    resourceType?: string
  ): Request {
    return this.observeSyntheticObservedRequest(
      url,
      "GET",
      {
        frameId,
        isNavigationRequest,
        resourceType: resourceType ?? (isNavigationRequest ? "document" : "other")
      }
    ).request;
  }

  private toPublicResponse(response: PageResponse | null): Response | null {
    if (!response) {
      return null;
    }
    if (response.requestId) {
      const state = this.observedRequestsById.get(response.requestId);
      if (state?.response) {
        return state.response;
      }
    }
    return this.normalizePublicEventPayload("response", response) as unknown as Response;
  }

  private resolveObservedRequestFrame(state: ObservedRequestState): Frame {
    if (!state.frameId) {
      return this.mainFrame();
    }

    const nativeFrame = this.frameByNativeId(state.frameId);
    if (nativeFrame) {
      return nativeFrame;
    }

    const boundFrameId = this.nativeFrameBindings.get(state.frameId);
    if (boundFrameId) {
      const boundFrame = this.frameById(boundFrameId);
      if (boundFrame) {
        return boundFrame;
      }
      this.nativeFrameBindings.delete(state.frameId);
    }

    const resolvedFrame = this.matchFrameForObservedRequest(state);
    if (resolvedFrame) {
      this.nativeFrameBindings.set(state.frameId, resolvedFrame.snapshotState().id);
      return resolvedFrame;
    }

    return this.mainFrame();
  }

  private matchFrameForObservedRequest(state: ObservedRequestState): RoxyFrame | null {
    const frames = this.frames().filter((frame): frame is RoxyFrame => frame instanceof RoxyFrame);
    if (!frames.length) {
      return null;
    }

    if (state.frameId) {
      const exactSynthetic = this.frameById(state.frameId);
      if (exactSynthetic) {
        return exactSynthetic;
      }
    }

    const urlMatches = frames.filter((frame) => frame.url() === state.url);
    if (urlMatches.length === 1) {
      return urlMatches[0] ?? null;
    }

    const nonMainUrlMatches = urlMatches.filter((frame) => frame !== this.mainFrame());
    if (nonMainUrlMatches.length === 1) {
      return nonMainUrlMatches[0] ?? null;
    }

    if (state.resourceType === "document" || state.isNavigationRequest) {
      if (frames.length === 2) {
        const childFrame = frames.find((frame) => frame !== this.mainFrame());
        if (childFrame && childFrame.url() === state.url) {
          return childFrame;
        }
      }
      if (this.mainFrame().url() === state.url) {
        return this.mainFrame() as RoxyFrame;
      }
    }

    return null;
  }

  private isMainFrameNavigationRequest(state: ObservedRequestState): boolean {
    if (!state.isNavigationRequest) {
      return false;
    }
    if (!state.frameId) {
      return true;
    }
    const mainFrame = this.mainFrame();
    if (mainFrame instanceof RoxyFrame) {
      const snapshot = mainFrame.snapshotState();
      return state.frameId === snapshot.id || state.frameId === snapshot.nativeFrameId;
    }
    return false;
  }

  private isRawMainFrameNavigation(payload: unknown): boolean {
    if (!payload || typeof payload !== "object") {
      return true;
    }
    const navigation = payload as { frameId?: string; parentFrameId?: string | null };
    if (navigation.parentFrameId !== undefined) {
      return navigation.parentFrameId === null;
    }
    if (!navigation.frameId) {
      return true;
    }
    const mainFrame = this.mainFrame();
    if (mainFrame instanceof RoxyFrame) {
      const snapshot = mainFrame.snapshotState();
      return navigation.frameId === snapshot.id || navigation.frameId === snapshot.nativeFrameId;
    }
    return false;
  }

  private observeSyntheticObservedRequest(
    url: string,
    method: string,
    requestIdOrOptions: string | null | {
      frameId?: string | null;
      isNavigationRequest?: boolean;
      requestId?: string | null;
      resourceType?: string;
    }
  ): ObservedRequestState {
    const options = typeof requestIdOrOptions === "object" && requestIdOrOptions !== null
      ? requestIdOrOptions
      : { requestId: requestIdOrOptions };
    this.observeAdapterRequest({
      ...(options.frameId !== undefined ? { frameId: options.frameId } : {}),
      headers: [],
      ...(options.isNavigationRequest !== undefined
        ? { isNavigationRequest: options.isNavigationRequest }
        : {}),
      method,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.resourceType ? { resourceType: options.resourceType } : {}),
      url
    });
    return this.findObservedRequestState(url, method, options.requestId)!;
  }

  private findObservedRequestForResponse(payload: PageResponse): ObservedRequestState | null {
    if (payload.requestId) {
      const state = this.observedRequestsById.get(payload.requestId) ?? null;
      if (state && !state.response && state.url === payload.url) {
        return state;
      }
      const byUrl = this.observedRequestsByUrl.get(payload.url)?.find((entry) => entry.response === null) ?? null;
      return byUrl;
    }
    return this.observedRequestsByUrl.get(payload.url)?.find((entry) => entry.response === null) ?? null;
  }

  private findObservedRequestState(
    url: string,
    method: string,
    requestId?: string | null
  ): ObservedRequestState | null {
    if (requestId) {
      return this.observedRequestsById.get(requestId) ?? null;
    }
    const queue = this.observedRequestsByUrl.get(url);
    if (!queue?.length) {
      return null;
    }
    return queue.find((entry) => entry.method === method) ?? queue[0] ?? null;
  }

  private removeObservedRequestFromUrlIndex(url: string, state: ObservedRequestState): void {
    const queue = this.observedRequestsByUrl.get(url);
    if (!queue) {
      return;
    }
    const index = queue.indexOf(state);
    if (index !== -1) {
      queue.splice(index, 1);
    }
    if (queue.length === 0) {
      this.observedRequestsByUrl.delete(url);
    }
  }

  private consumeRedirectSource(url: string): ObservedRequestState | null {
    const queue = this.redirectTargets.get(url);
    if (!queue?.length) {
      return null;
    }
    const state = queue.shift() ?? null;
    if (queue.length === 0) {
      this.redirectTargets.delete(url);
    }
    return state;
  }

  private findRedirectSourceForRequest(payload: PageRequest): ObservedRequestState | null {
    const redirectedFromTarget = this.consumeRedirectSource(payload.url);
    if (redirectedFromTarget) {
      return redirectedFromTarget;
    }
    if (!payload.requestId) {
      return null;
    }
    const previous = this.observedRequestsById.get(payload.requestId);
    if (!previous?.response || previous.redirectedTo) {
      return null;
    }
    const status = previous.response.status();
    return status >= 300 && status < 400 ? previous : null;
  }

  private createLocatorFromChain(chain: LocatorSelector[], frameIdentity?: string): Locator {
    const [first, ...rest] = chain;
    if (!first) {
      throw new Error("Selector must not be empty.");
    }
    let adapter = this.adapter.locator(first);
    for (const part of rest) {
      adapter = adapter.locator(part);
    }
    return new RoxyLocator(
      adapter,
      this.humanController,
      chain,
      async (locator, options) => {
        return await this.maybeRunLocatorHandlers(locator, options);
      },
      this.humanDefaults,
      this,
      this,
      frameIdentity
    );
  }

  private createLocatorFromAdapterChain(
    adapter: ProtocolLocatorAdapter,
    chain: LocatorSelector[],
    frameIdentity?: string
  ): Locator {
    const [first, ...rest] = chain;
    if (!first) {
      throw new Error("Selector must not be empty.");
    }
    let current = adapter;
    for (const part of rest) {
      current = current.locator(part);
    }
    return new RoxyLocator(
      current,
      this.humanController,
      chain,
      async (locator, options) => {
        return await this.maybeRunLocatorHandlers(locator, options);
      },
      this.humanDefaults,
      this,
      this,
      frameIdentity
    );
  }

  private rootLocatorForFrame(frame: RoxyFrameSnapshot): RoxyLocator {
    if (!frame.referenceChain.length) {
      return new RoxyLocator(this.adapter.locator({ strategy: "css", value: ":root" }), this.humanController, null, undefined, this.humanDefaults, this, this, frame.id);
    }
    return this.createLocatorFromChain(frame.referenceChain, frame.id) as RoxyLocator;
  }

  private chainForFrame(frame: RoxyFrameSnapshot, chain: LocatorSelector[]): LocatorSelector[] {
    return [...frame.referenceChain, ...chain];
  }

  private referenceForFrame(
    frame: RoxyFrameSnapshot,
    chain: LocatorSelector[],
    pick?: ProtocolElementHandleReference["pick"]
  ): ProtocolElementHandleReference {
    const scopedChain = frame.nativeFrameId && this.adapter.locatorInFrame
      ? chain
      : this.chainForFrame(frame, chain);
    return {
      chain: scopedChain,
      ...(frame.nativeFrameId && this.adapter.locatorInFrame ? { protocolFrameId: frame.nativeFrameId } : {}),
      ...(pick ? { pick } : {})
    };
  }

  private async elementHandleForSelector(
    selector: string,
    options?: { strict?: boolean }
  ): Promise<ElementHandle | null> {
    const strict = typeof options?.strict === "boolean"
      ? options.strict
      : Boolean(this.contextOptions.strictSelectors);
    const reference = {
      chain: parseSelectorChain(selector),
      ...(strict ? {} : { pick: { kind: "first" } as const })
    };
    const handle = await this.adapter.createHandleReference(reference).then(
      (resolved) => this.adapter.createHandle(resolved),
      (error) => {
        if (error instanceof Error && error.message.includes("No element found")) {
          return null;
        }
        throw error;
      }
    );
    return handle ? this.createElementHandle(handle) : null;
  }

  private async requiredElementHandleForSelector(
    selector: string,
    apiName: string,
    options?: { strict?: boolean }
  ): Promise<ElementHandle> {
    const handle = await this.elementHandleForSelector(selector, options);
    if (!handle) {
      throw new Error(`${apiName}: Failed to find element matching selector "${selector}"`);
    }
    return handle;
  }

  private async refreshFrameSnapshots(): Promise<void> {
    const previousSnapshots = new Map<string, RoxyFrameSnapshot>();
    for (const [id, frame] of this.frameMap.entries()) {
      previousSnapshots.set(id, frame.snapshotState());
    }

    this.frameSnapshotRefreshInProgress = true;
    let snapshots: Array<RoxyFrameSnapshot> | unknown;
    try {
      snapshots = this.adapter.frameSnapshots
        ? await this.adapter.frameSnapshots()
        : await this.evaluate<Array<RoxyFrameSnapshot> | unknown>(() => {
        const snapshots: Array<RoxyFrameSnapshot> = [
          {
            id: "main",
            name: "",
            ownerElementChain: [],
            parentId: null,
            referenceChain: [],
            url: String(globalThis.location?.href || "")
          }
        ];

        const escapeCss = (value: string): string => {
          if ("CSS" in globalThis && typeof CSS.escape === "function") {
            return CSS.escape(value);
          }
          return value.replace(/["\\]/g, "\\$&");
        };

        const cssPath = (element: Element): string => {
          if (element.id) {
            return `#${escapeCss(element.id)}`;
          }

          const segments: string[] = [];
          let current: Element | null = element;
          while (current && current.parentElement) {
            const tag = current.tagName.toLowerCase();
            const siblings = Array.from(current.parentElement.children).filter(
              (child) => child.tagName === current!.tagName
            );
            const index = siblings.indexOf(current) + 1;
            segments.unshift(`${tag}:nth-of-type(${index})`);
            current = current.parentElement;
          }

          return segments.join(" > ");
        };

        const visit = (
          documentRoot: Document,
          parentId: string,
          chain: Array<LocatorSelector>
        ) => {
          const frames: Array<HTMLIFrameElement | HTMLFrameElement> = [];
          const collectFrames = (root: Document | ShadowRoot) => {
            frames.push(...Array.from(root.querySelectorAll("iframe,frame")) as Array<HTMLIFrameElement | HTMLFrameElement>);
            for (const element of Array.from(root.querySelectorAll("*"))) {
              if (element.shadowRoot) {
                collectFrames(element.shadowRoot);
              }
            }
          };
          collectFrames(documentRoot);
          frames.forEach((frameElement, index) => {
            const iframe = frameElement as HTMLIFrameElement | HTMLFrameElement;
            const contentDocument = iframe.contentDocument;
            if (!contentDocument) {
              return;
            }

            const selector = cssPath(iframe);
            const frameId = `${parentId}.${index + 1}`;
            const ownerElementChain = [
              ...chain,
              { strategy: "css" as const, value: selector }
            ];
            const referenceChain = [
              ...ownerElementChain,
              { strategy: "control" as const, value: "enter-frame" }
            ];
            snapshots.push({
              id: frameId,
              name: iframe.getAttribute("name") ?? iframe.id ?? "",
              ownerElementChain,
              parentId,
              referenceChain,
              url: String(iframe.contentWindow?.location?.href || iframe.src || "about:blank")
            });
            visit(contentDocument, frameId, referenceChain);
          });
        };

        visit(document, "main", []);
        return snapshots;
      });
    } finally {
      this.frameSnapshotRefreshInProgress = false;
    }

    const normalizedSnapshots = Array.isArray(snapshots)
      ? (snapshots as Array<RoxyFrameSnapshot>)
      : [
          {
            id: "main",
            name: "",
            ownerElementChain: [],
            parentId: null,
            referenceChain: [],
            url: await this.url()
          } satisfies RoxyFrameSnapshot
        ];
    const currentIds = new Set(normalizedSnapshots.map((snapshot) => snapshot.id));
    const attachedFrames: RoxyFrame[] = [];
    const navigatedFrames: RoxyFrame[] = [];
    const detachedFrames: RoxyFrame[] = [];

    this.frameOrder.length = 0;
    for (const snapshot of normalizedSnapshots) {
      this.frameOrder.push(snapshot.id);
      let existing = this.frameMap.get(snapshot.id);
      let previous = previousSnapshots.get(snapshot.id);
      if (!existing && snapshot.nativeFrameId) {
        for (const [id, frame] of this.frameMap.entries()) {
          const existingSnapshot = frame.snapshotState();
          if (existingSnapshot.nativeFrameId !== snapshot.nativeFrameId && existingSnapshot.id !== snapshot.nativeFrameId) {
            continue;
          }
          existing = frame;
          previous = previousSnapshots.get(id);
          if (id !== snapshot.id) {
            this.frameMap.delete(id);
            this.frameMap.set(snapshot.id, frame);
            this.nativeFrameBindings.set(snapshot.nativeFrameId, snapshot.id);
          }
          break;
        }
      }
      if (existing) {
        existing.setDetached(false);
        const existingSnapshot = existing.snapshotState();
        if (!snapshot.ownerElementReference && existingSnapshot.ownerElementReference) {
          snapshot.ownerElementReference = existingSnapshot.ownerElementReference;
        }
        if (!snapshot.ownerElementReference && previous?.ownerElementReference) {
          snapshot.ownerElementReference = previous.ownerElementReference;
        }
        existing.setSnapshot(snapshot);
        if (previous && previous.url !== snapshot.url) {
          navigatedFrames.push(existing);
        }
      } else {
        const frame = new RoxyFrame(this, snapshot);
        this.frameMap.set(snapshot.id, frame);
        if (snapshot.id !== "main") {
          attachedFrames.push(frame);
        }
        navigatedFrames.push(frame);
      }
    }

    for (const id of Array.from(this.frameMap.keys())) {
      if (!currentIds.has(id)) {
        const frame = this.frameMap.get(id);
        if (frame) {
          frame.setDetached(true);
          detachedFrames.push(frame);
        }
        this.frameMap.delete(id);
      }
    }

    for (const frame of attachedFrames) {
      this.emit("frameattached", frame);
    }
    for (const frame of navigatedFrames) {
      this.emit("framenavigated", frame);
    }
    for (const frame of detachedFrames) {
      this.emit("framedetached", frame);
    }

    for (const state of this.observedRequestsById.values()) {
      if (!state.frameId || this.nativeFrameBindings.has(state.frameId)) {
        continue;
      }
      const resolvedFrame = this.matchFrameForObservedRequest(state);
      if (resolvedFrame) {
        this.nativeFrameBindings.set(state.frameId, resolvedFrame.snapshotState().id);
      }
    }
  }

  private async applyEmulatedMedia(): Promise<void> {
    const state = { ...this.emulatedMedia };
    const install = (payload: EmulateMediaOptions) => {
      const globalState = (globalThis as typeof globalThis & {
        __roxyEmulatedMediaState?: EmulateMediaOptions;
        __roxyOriginalMatchMedia?: typeof globalThis.matchMedia;
      });
      globalState.__roxyEmulatedMediaState = payload;
      if (!globalState.__roxyOriginalMatchMedia) {
        globalState.__roxyOriginalMatchMedia = globalThis.matchMedia.bind(globalThis);
      }

      globalThis.matchMedia = ((query: string) => {
        const original = globalState.__roxyOriginalMatchMedia!(query);
        const normalized = query.replace(/\s+/g, "").toLowerCase();
        const emulated = globalState.__roxyEmulatedMediaState ?? {};
        const hasOverride = (key: keyof EmulateMediaOptions) =>
          emulated[key] !== undefined && emulated[key] !== null;
        const featureValue = () => normalized.replace(/[()]/g, "").split(":").pop() ?? "";
        const matchesOverride = (() => {
          if (hasOverride("media") && (normalized === "screen" || normalized === "print")) {
            return emulated.media === normalized;
          }
          if (normalized.startsWith("(prefers-color-scheme:") && hasOverride("colorScheme")) {
            return featureValue() === String(emulated.colorScheme);
          }
          if (normalized.startsWith("(prefers-reduced-motion:") && hasOverride("reducedMotion")) {
            return featureValue() === String(emulated.reducedMotion);
          }
          if (normalized.startsWith("(prefers-contrast:") && hasOverride("contrast")) {
            return featureValue() === String(emulated.contrast);
          }
          if (normalized.startsWith("(forced-colors:") && hasOverride("forcedColors")) {
            return featureValue() === String(emulated.forcedColors);
          }
          return original.matches;
        })();

        return {
          ...original,
          matches: matchesOverride
        };
      }) as typeof globalThis.matchMedia;
    };

    await this.addInitScript(install, state);
    await this.evaluate(install, state);
  }

  private async registerExposedBinding(
    name: string,
    entry: ExposedBindingEntry,
    methodName: "page.exposeBinding" | "page.exposeFunction"
  ): Promise<Disposable> {
    if (this.exposedBindings.has(name)) {
      throw new Error(`${methodName}: Function "${name}" has been already registered`);
    }

    this.exposedBindings.set(name, entry);
    await this.installExposedBinding(name);
    this.startBindingPump();

    return {
      dispose: async () => {
        this.exposedBindings.delete(name);
        await this.removeExposedBinding(name);
      }
    };
  }

  private startBindingPump(): void {
    if (this.bindingPumpStarted) {
      return;
    }
    this.bindingPumpStarted = true;

    void (async () => {
      while (!this.isClosed()) {
        try {
          await this.drainBindingCalls();
        } catch {
          // Ignore transient navigation/close failures.
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
  }

  private async drainBindingCalls(): Promise<void> {
    await this.refreshFrameSnapshots().catch(() => {});
    const calls: ExposedBindingCall[] = [];
    const drain = async (targetFrame: RoxyFrame | null): Promise<void> => {
      const drainPendingCalls = () => {
        const store = (globalThis as typeof globalThis & {
          __roxyBindingCalls?: Array<{
            id: string;
            name: string;
            serializedArgs: SerializedValue[];
            frameId: string | null;
          }>;
        });
        const pending = [...(store.__roxyBindingCalls ?? [])];
        store.__roxyBindingCalls = [];
        return pending;
      };
      const pending = (targetFrame
        ? await this.evaluateInFrame(targetFrame.snapshotState(), drainPendingCalls)
        : await this.evaluate(drainPendingCalls)) as Array<{
          id: string;
          name: string;
          serializedArgs: SerializedValue[];
          frameId: string | null;
        }>;
      for (const call of pending) {
        calls.push({
          ...call,
          frameId: targetFrame ? targetFrame.snapshotState().id : call.frameId,
          targetFrame
        });
      }
    };

    await drain(null);
    await Promise.all(
      this.frames()
        .filter((frame): frame is RoxyFrame => frame instanceof RoxyFrame && frame !== this.mainFrame())
        .map((frame) => drain(frame).catch(() => {}))
    );

    for (const call of calls) {
      const entry = this.exposedBindings.get(call.name);
      if (!entry) {
        await this.resolveBindingCall(call.targetFrame, call.id, {
          ok: false,
          error: {
            message: `${call.name} is not a function`,
            value: `${call.name} is not a function`
          }
        });
        continue;
      }

      try {
        const result =
          entry.kind === "binding"
            ? await entry.callback(
                this.createBindingSource(call.frameId),
                ...call.serializedArgs.map((arg) => parseEvaluationResultValue(arg))
              )
            : await entry.callback(...call.serializedArgs.map((arg) => parseEvaluationResultValue(arg)));
        await this.resolveBindingCall(call.targetFrame, call.id, {
          ok: true,
          value: serializeAsCallArgumentNoHandles(result)
        });
      } catch (error) {
        await this.resolveBindingCall(call.targetFrame, call.id, {
          ok: false,
          error: serializeBindingError(error)
        });
      }
    }
  }

  private createBindingSource(frameId: string | null): BindingSource {
    return {
      context: this.browserContext ?? this.detachedContextFallback,
      page: this,
      frame: frameId ? (this.frameById(frameId) ?? this.mainFrame()) : this.mainFrame()
    };
  }

  private async resolveBindingCall(
    targetFrame: RoxyFrame | null,
    id: string,
    result:
      | { ok: true; value: unknown }
      | {
          ok: false;
          error: {
            value: unknown;
            message?: string;
            stack?: string;
            isNull?: boolean;
          };
        }
  ): Promise<void> {
    const resolveCall = ({ callId, payload }: {
      callId: string;
      payload: typeof result;
    }) => {
      const store = (globalThis as typeof globalThis & {
        __roxyBindingResults?: Record<string, unknown>;
      });
      store.__roxyBindingResults ??= {};
      store.__roxyBindingResults[callId] = payload;
    };
    const payload = {
        callId: id,
        payload: result
    };
    if (targetFrame) {
      await this.evaluateInFrame(targetFrame.snapshotState(), resolveCall, payload);
    } else {
      await this.evaluate(resolveCall, payload);
    }
  }

  private async reinstallExposedBindings(): Promise<void> {
    for (const name of this.exposedBindings.keys()) {
      await this.installExposedBinding(name);
    }
  }

  private maybeStartFileChooserInterception(event: PageEventName): void {
    if (event !== "filechooser") {
      return;
    }
    void this.ensureFileChooserInterception().catch(() => {});
  }

  private async ensureFileChooserInterception(): Promise<void> {
    if (!this.fileChooserInterceptionPromise) {
      this.fileChooserInterceptionPromise = (async () => {
        if (!this.fileChooserBridgeInstalled) {
          await this.installFileChooserHandleFactory();
          await this.installFileChooserBridge();
        }
        await this.installFileChooserRuntimeIntoCurrentFrames();
      })().finally(() => {
        this.fileChooserInterceptionPromise = null;
      });
    }
    await this.fileChooserInterceptionPromise;
  }

  private async installFileChooserRuntimeIntoCurrentFrames(): Promise<void> {
    await this.refreshFrameSnapshots().catch(() => {});
    await this.adapter.evaluate<void>(
      installFileChooserBridgeRuntime.toString(),
      null,
      true
    ).catch(() => {});
    for (const frame of this.frames()) {
      if (frame === this.mainFrame()) {
        continue;
      }
      const frameSnapshot = (frame as RoxyFrame).snapshotState();
      await this.evaluateInFrame<void, string | null>(
        frameSnapshot,
        installFileChooserBridgeRuntime,
        frameSnapshot.id
      ).catch(
        () => {}
      );
    }
  }

  private async waitForFileChooserInterceptionIfPending(): Promise<void> {
    if (!this.fileChooserInterceptionPromise && !this.fileChooserBridgeInstalled) {
      return;
    }
    await this.ensureFileChooserInterception();
  }

  private async installFileChooserBridge(): Promise<void> {
    if (this.fileChooserBridgeInstalled) {
      return;
    }
    await this.exposeBinding("__roxyOnFileChooserOpened", async (_source, payload: FileChooserBridgeEvent) => {
      await this.handleFileChooserOpened(payload);
    }).catch((error) => {
      if (!(error instanceof Error) || !error.message.includes("has been already registered")) {
        throw error;
      }
    });

    await this.addInitScript(installFileChooserBridgeRuntime);
    this.fileChooserBridgeInstalled = true;
  }

  private async handleFileChooserOpened(payload: FileChooserBridgeEvent): Promise<void> {
    const existing = this.pendingFileChoosers.find((entry) => entry.handleId === payload.handleId);
    if (existing) {
      this.emit("filechooser", existing.chooser);
      return;
    }

    const frameSnapshot = payload.frameId
      ? (this.frameById(payload.frameId) as RoxyFrame | null)?.snapshotState()
      : null;
    const element = this.createElementHandle(
      this.adapter.createHandle({
        chain: [],
        ...(frameSnapshot?.nativeFrameId
          ? { protocolFrameId: frameSnapshot.nativeFrameId }
          : frameSnapshot
          ? {
              scope: {
                chain: frameSnapshot.ownerElementChain,
                pick: { kind: "first" as const }
              }
            }
          : {}),
        handleId: payload.handleId
      })
    );
    const chooser = new RoxyFileChooser(this, payload.isMultiple, element);
    this.pendingFileChoosers.push({
      chooser,
      handleId: payload.handleId
    });
    this.emit("filechooser", chooser);
  }

  private async installFileChooserHandleFactory(): Promise<void> {
    await this.addInitScript(installFileChooserBridgeRuntime);
  }

  private async installExposedBinding(name: string): Promise<void> {
    const install = (bindingName: string) => {
      const typedArrayConstructors = {
        i8: Int8Array,
        ui8: Uint8Array,
        ui8c: Uint8ClampedArray,
        i16: Int16Array,
        ui16: Uint16Array,
        i32: Int32Array,
        ui32: Uint32Array,
        f32: Float32Array,
        f64: Float64Array,
        bi64: BigInt64Array,
        bui64: BigUint64Array
      };
      const typedArrayToBase64 = (array: any) => {
        if ("toBase64" in array) {
          return array.toBase64();
        }
        const binary = Array.from(new Uint8Array(array.buffer, array.byteOffset, array.byteLength))
          .map((b) => String.fromCharCode(b))
          .join("");
        return btoa(binary);
      };
      const base64ToTypedArray = (base64: string, TypedArrayConstructor: any) => {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        return new TypedArrayConstructor(bytes.buffer);
      };
      const serializeBindingArgument = (value: any, visitorInfo = { visited: new Map<object, number>(), lastId: 0 }): any => {
        if (value && typeof value === "object") {
          if (typeof globalThis.Window === "function" && value instanceof globalThis.Window) {
            return "ref: <Window>";
          }
          if (typeof globalThis.Document === "function" && value instanceof globalThis.Document) {
            return "ref: <Document>";
          }
          if (typeof globalThis.Node === "function" && value instanceof globalThis.Node) {
            return "ref: <Node>";
          }
        }
        if (typeof value === "symbol" || Object.is(value, undefined)) {
          return { v: "undefined" };
        }
        if (Object.is(value, null)) {
          return { v: "null" };
        }
        if (Object.is(value, NaN)) {
          return { v: "NaN" };
        }
        if (Object.is(value, Infinity)) {
          return { v: "Infinity" };
        }
        if (Object.is(value, -Infinity)) {
          return { v: "-Infinity" };
        }
        if (Object.is(value, -0)) {
          return { v: "-0" };
        }
        if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
          return value;
        }
        if (typeof value === "bigint") {
          return { bi: value.toString() };
        }
        if (value instanceof Error || (value && Object.getPrototypeOf(value)?.name === "Error")) {
          const stack = value.stack?.startsWith(value.name + ": " + value.message)
            ? value.stack
            : `${value.name}: ${value.message}\n${value.stack}`;
          return { e: { n: value.name, m: value.message, s: stack } };
        }
        if (value instanceof Date || Object.prototype.toString.call(value) === "[object Date]") {
          return { d: value.toJSON() };
        }
        if (value instanceof URL || Object.prototype.toString.call(value) === "[object URL]") {
          return { u: value.toJSON() };
        }
        if (value instanceof RegExp || Object.prototype.toString.call(value) === "[object RegExp]") {
          return { r: { p: value.source, f: value.flags } };
        }
        for (const [k, ctor] of Object.entries(typedArrayConstructors)) {
          if (value instanceof ctor || Object.prototype.toString.call(value) === `[object ${ctor.name}]`) {
            return { ta: { b: typedArrayToBase64(value), k } };
          }
        }
        if (value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
          return { ab: { b: typedArrayToBase64(new Uint8Array(value)) } };
        }
        const existingId = visitorInfo.visited.get(value);
        if (existingId) {
          return { ref: existingId };
        }
        if (Array.isArray(value)) {
          const id = ++visitorInfo.lastId;
          visitorInfo.visited.set(value, id);
          return { a: value.map((entry) => serializeBindingArgument(entry, visitorInfo)), id };
        }
        if (typeof value === "object") {
          const id = ++visitorInfo.lastId;
          visitorInfo.visited.set(value, id);
          const o: Array<{ k: string; v: unknown }> = [];
          for (const key of Object.keys(value)) {
            let item;
            try {
              item = value[key];
            } catch {
              continue;
            }
            if (key === "toJSON" && typeof item === "function") {
              o.push({ k: key, v: { o: [], id: 0 } });
            } else {
              o.push({ k: key, v: serializeBindingArgument(item, visitorInfo) });
            }
          }
          let jsonWrapper;
          try {
            if (o.length === 0 && value.toJSON && typeof value.toJSON === "function") {
              jsonWrapper = { value: value.toJSON() };
            }
          } catch {}
          if (jsonWrapper) {
            return serializeBindingArgument(jsonWrapper.value, visitorInfo);
          }
          return { o, id };
        }
        return { v: "undefined" };
      };
      const parseBindingResult = (value: any, refs = new Map<number, object>()): any => {
        if (Object.is(value, undefined)) {
          return undefined;
        }
        if (typeof value === "object" && value) {
          if ("ref" in value) {
            return refs.get(value.ref);
          }
          if ("v" in value) {
            if (value.v === "undefined") {
              return undefined;
            }
            if (value.v === "null") {
              return null;
            }
            if (value.v === "NaN") {
              return NaN;
            }
            if (value.v === "Infinity") {
              return Infinity;
            }
            if (value.v === "-Infinity") {
              return -Infinity;
            }
            if (value.v === "-0") {
              return -0;
            }
          }
          if ("d" in value) {
            return new Date(value.d);
          }
          if ("u" in value) {
            return new URL(value.u);
          }
          if ("bi" in value) {
            return BigInt(value.bi);
          }
          if ("e" in value) {
            const error = new Error(value.e.m);
            error.name = value.e.n;
            error.stack = value.e.s;
            return error;
          }
          if ("r" in value) {
            return new RegExp(value.r.p, value.r.f);
          }
          if ("a" in value) {
            const result: any[] = [];
            refs.set(value.id, result);
            for (const item of value.a) {
              result.push(parseBindingResult(item, refs));
            }
            return result;
          }
          if ("o" in value) {
            const result: Record<string, unknown> = {};
            refs.set(value.id, result);
            for (const { k, v } of value.o) {
              if (k !== "__proto__") {
                result[k] = parseBindingResult(v, refs);
              }
            }
            return result;
          }
          if ("ta" in value) {
            return base64ToTypedArray(value.ta.b, typedArrayConstructors[value.ta.k as keyof typeof typedArrayConstructors]);
          }
          if ("ab" in value) {
            return base64ToTypedArray(value.ab.b, Uint8Array).buffer;
          }
        }
        return value;
      };
      const store = (globalThis as typeof globalThis & {
        __roxyBindingCalls?: Array<{
          id: string;
          name: string;
          serializedArgs: unknown[];
          frameId: string | null;
        }>;
        __roxyBindingResults?: Record<string, unknown>;
        __roxyBindingNextId?: number;
      });
      store.__roxyBindingCalls ??= [];
      store.__roxyBindingResults ??= {};
      store.__roxyBindingNextId ??= 0;

      (globalThis as typeof globalThis & Record<string, unknown>)[bindingName] = async (...args: unknown[]) => {
        const callId = `${bindingName}:${++store.__roxyBindingNextId!}`;
        store.__roxyBindingCalls!.push({
          id: callId,
          name: bindingName,
          serializedArgs: args.map((arg) => serializeBindingArgument(arg)),
          frameId:
            (globalThis.frameElement as Element | null)?.getAttribute("data-roxy-frame-id") ?? null
        });

        for (;;) {
          if (callId in store.__roxyBindingResults!) {
            const payload = store.__roxyBindingResults![callId] as
              | { ok: true; value: unknown }
              | {
                  ok: false;
                  error: { value: unknown; message?: string; stack?: string; isNull?: boolean };
            };
            delete store.__roxyBindingResults![callId];
            if (payload.ok) {
              return parseBindingResult(payload.value);
            }
            if (payload.error.isNull) {
              throw null;
            }
            const error = new Error(
              payload.error.message ??
                (typeof payload.error.value === "string"
                  ? payload.error.value
                  : String(payload.error.value))
            );
            if (payload.error.stack) {
              error.stack = payload.error.stack;
            }
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      };
    };

    await this.addInitScript(install, name);
    await this.evaluate(install, name);
    await this.refreshFrameSnapshots().catch(() => {});
    await Promise.all(
      this.frames()
        .filter((frame): frame is RoxyFrame => frame instanceof RoxyFrame && frame !== this.mainFrame())
        .map((frame) => this.evaluateInFrame(frame.snapshotState(), install, name).catch(() => {}))
    );
  }

  private async removeExposedBinding(name: string): Promise<void> {
    await this.evaluate((bindingName) => {
      delete (globalThis as typeof globalThis & Record<string, unknown>)[bindingName];
    }, name);
  }

  private async installRouteInterceptors(): Promise<void> {
    if (!this.routeInterceptorsInstalled) {
      if (!this.adapter.setRequestInterceptor) {
        await this.addInitScript(installRouteBridge);
        await this.evaluate(installRouteBridge);
        await Promise.all(this.frames().map((frame) => frame.evaluate(installRouteBridge).catch(() => {})));
      }
      this.routeInterceptorsInstalled = true;
    }

    await this.syncRouteInterception();
    if (!this.adapter.setRequestInterceptor) {
      this.startRoutePump();
    }
  }

  private async syncRouteInterception(): Promise<void> {
    if (!this.adapter.setRequestInterceptor) {
      return;
    }
    const needsInterception = this.routeHandlers.length > 0 || this.harRoutes.length > 0;
    await this.adapter.setRequestInterceptor(
      needsInterception ? (call) => this.dispatchRoutedRequest(call) : null
    );
  }

  private startRoutePump(): void {
    if (this.routePumpStarted) {
      return;
    }
    this.routePumpStarted = true;

    void (async () => {
      while (!this.isClosed()) {
        try {
          await this.drainRouteCalls();
        } catch {
          // Ignore transient navigation/close failures while the page is changing documents.
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
  }

  private async drainRouteCalls(): Promise<void> {
    const calls = await this.evaluate<{
      requests: RoutedRequestCall[];
      websocketEvents: RoutedWebSocketEventCall[];
      websocketOpens: RoutedWebSocketOpenCall[];
    }>(() => {
      const globalState = globalThis as typeof globalThis & {
        __roxyRouteBridge?: {
          requestCalls: RoutedRequestCall[];
          websocketCommands: Record<string, RoutedWebSocketCommand[] | undefined>;
          websocketEventCalls: RoutedWebSocketEventCall[];
          websocketOpenCalls: RoutedWebSocketOpenCall[];
        };
      };
      const bridge = globalState.__roxyRouteBridge;
      if (!bridge) {
        return {
          requests: [],
          websocketEvents: [],
          websocketOpens: []
        };
      }
      const requests = [...bridge.requestCalls];
      const websocketOpens = [...bridge.websocketOpenCalls];
      const websocketEvents = [...bridge.websocketEventCalls];
      bridge.requestCalls = [];
      bridge.websocketOpenCalls = [];
      bridge.websocketEventCalls = [];
      return { requests, websocketEvents, websocketOpens };
    });

    for (const call of calls.requests) {
      const dispatch = this.dispatchRoutedRequest(call)
        .then((decision) => this.resolveRoutedRequest(call.id, decision))
        .catch(async (error) => {
          await this.resolveRoutedRequest(call.id, {
            action: "abort",
            errorCode:
              error instanceof Error && error.message
                ? error.message
                : "route handler failed"
          });
        });
      this.trackRouteDispatch(dispatch);
    }

    for (const call of calls.websocketOpens) {
      const dispatch = this.dispatchWebSocketOpen(call)
        .then((decision) => this.resolveWebSocketOpen(call.id, decision))
        .catch(async () => {
          await this.resolveWebSocketOpen(call.id, { action: "passthrough" });
        });
      this.trackRouteDispatch(dispatch);
    }

    for (const call of calls.websocketEvents) {
      const dispatch = this.dispatchWebSocketEvent(call);
      this.trackRouteDispatch(dispatch);
    }
  }

  private trackRouteDispatch(dispatch: Promise<void>): void {
    this.activeRouteDispatches.add(dispatch);
    void dispatch.finally(() => {
      this.activeRouteDispatches.delete(dispatch);
    });
  }

  private async dispatchRoutedRequest(call: RoutedRequestCall): Promise<RoutedRequestDecision> {
    if (new URL(call.url).pathname === "/favicon.ico") {
      return {
        action: "abort",
        errorCode: "aborted"
      };
    }

    let requestState: RoutedRequestCall = {
      ...call,
      headers: normalizeHeaderRecord(call.headers)
    };
    let routedResponse: Response | null = null;
    let routedFailure: { errorText: string } | null = null;

    const observedRouteRequest =
      this.findObservedRequestState(call.url, call.method, call.requestId ?? call.id);
    const request = this.createRouteRequest(
      () => requestState,
      () => routedResponse,
      () => routedFailure,
      () =>
        observedRouteRequest ??
        this.findObservedRequestState(call.url, call.method, call.requestId ?? call.id)
    );
    const handlers = [...this.routeHandlers];

    for (let index = handlers.length - 1; index >= 0; index -= 1) {
      const entry = handlers[index];
      if (!entry || !this.matchesRouteMatcher(requestState.url, entry.matcher)) {
        continue;
      }
      const liveIndex = this.routeHandlers.indexOf(entry);
      if (liveIndex === -1) {
        continue;
      }
      if (entry.remainingTimes !== null && entry.remainingTimes <= 1) {
        this.routeHandlers.splice(liveIndex, 1);
      } else if (entry.remainingTimes !== null) {
        entry.remainingTimes -= 1;
      }

      let routeOutcome:
        | { kind: "fallback" }
        | { kind: "finish"; decision: RoutedRequestDecision }
        | null = null;
      let routeHandled = false;
      let resolveRouteHandled!: (
        value:
          | { kind: "fallback" }
          | { kind: "finish"; decision: RoutedRequestDecision }
      ) => void;
      const routeHandledPromise = new Promise<
        | { kind: "fallback" }
        | { kind: "finish"; decision: RoutedRequestDecision }
      >((resolve) => {
        resolveRouteHandled = resolve;
      });

      const ensureRouteIsUnhandled = () => {
        if (routeHandled) {
          throw new Error("Route is already handled!");
        }
      };

      const reportRouteHandled = (
        outcome:
          | { kind: "fallback" }
          | { kind: "finish"; decision: RoutedRequestDecision }
      ) => {
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
          requestState = applyRouteOverrides(requestState, options);
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
          requestState = applyRouteOverrides(requestState, options);
          reportRouteHandled({ kind: "fallback" });
        },
        fetch: async (options) => {
          ensureRouteIsUnhandled();
          const fetchedRequest = applyRouteOverrides(requestState, options);
          const response = await this.fetchRouteRequest(fetchedRequest, options);
          routedResponse = createRoutedResponse(await responseDataFromResponse(response), request);
          return response;
        },
        fulfill: async (options = {}) => {
          ensureRouteIsUnhandled();
          const decision = await this.buildFulfillDecision(requestState, options);
          routeHandled = true;
          routedResponse = createRoutedResponse(
            {
              body: decision.body,
              ...(decision.bodyBufferBase64 !== undefined
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

      await Promise.all([
        routeHandledPromise,
        entry.handler(route, request)
      ]);

      const resolvedOutcome = routeOutcome!;
      if (resolvedOutcome.kind === "fallback") {
        continue;
      }

      if (resolvedOutcome.decision.action === "continue") {
        this.applyRoutedRequestStateToObservedRequest(call, requestState);
      }
      return resolvedOutcome.decision;
    }

    const harDecision = await this.dispatchHarRoute(requestState);
    if (harDecision) {
      if (harDecision.action === "fulfill") {
        routedResponse = createRoutedResponse(
          {
            body: harDecision.body,
            ...(harDecision.bodyBufferBase64 !== undefined
              ? { bodyBufferBase64: harDecision.bodyBufferBase64 }
              : {}),
            headers: { ...harDecision.headers },
            status: harDecision.status,
            statusText: harDecision.statusText,
            url: harDecision.url
          },
          request
        );
      } else {
        routedFailure = { errorText: harDecision.errorCode ?? "notinhar" };
      }
      return harDecision;
    }

    this.applyRoutedRequestStateToObservedRequest(call, requestState);
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

  private applyRoutedRequestStateToObservedRequest(
    original: RoutedRequestCall,
    routed: RoutedRequestCall
  ): void {
    const observed = this.findObservedRequestState(
      original.url,
      original.method,
      original.requestId ?? original.id
    );
    if (!observed) {
      this.pendingRoutedRequestStates.set(original.requestId ?? original.id, routed);
      return;
    }
    this.applyRoutedRequestStateToObservedRequestState(observed, routed);
  }

  private applyRoutedRequestStateToObservedRequestState(
    observed: ObservedRequestState,
    routed: RoutedRequestCall
  ): void {
    this.removeObservedRequestFromUrlIndex(observed.url, observed);
    observed.url = routed.url;
    observed.method = routed.method;
    observed.headers = { ...routed.headers };
    observed.headerEntries = Object.entries(routed.headers).map(([name, value]) => ({
      name,
      value
    }));
    observed.postDataText = routed.postData;
    observed.postDataBuffer = deserializeSerializedPostData(
      routed.postData,
      routed.postDataBufferBase64 ?? null
    ).buffer;

    const queue = this.observedRequestsByUrl.get(routed.url) ?? [];
    if (!queue.includes(observed)) {
      queue.push(observed);
    }
    this.observedRequestsByUrl.set(routed.url, queue);
  }

  private consumePendingRoutedRequestState(payload: PageRequest): RoutedRequestCall | null {
    const key = payload.requestId ?? payload.url;
    const routed = this.pendingRoutedRequestStates.get(key);
    if (!routed) {
      return null;
    }
    this.pendingRoutedRequestStates.delete(key);
    return routed;
  }

  private async dispatchHarRoute(
    call: RoutedRequestCall
  ): Promise<Extract<RoutedRequestDecision, { action: "fulfill" | "abort" }> | null> {
    for (let index = this.harRoutes.length - 1; index >= 0; index -= 1) {
      const route = this.harRoutes[index];
      if (!route) {
        continue;
      }
      if (route.matcher && !this.matchesHarRouteMatcher(call.url, route.matcher)) {
        continue;
      }

      const matchedEntry = this.findHarRouteEntry(route, call.url, call.method);
      if (matchedEntry) {
        return {
          action: "fulfill",
          body: matchedEntry.responseBody,
          ...(matchedEntry.responseBodyBufferBase64 !== undefined
            ? { bodyBufferBase64: matchedEntry.responseBodyBufferBase64 }
            : {}),
          headers: { ...matchedEntry.responseHeaders },
          status: matchedEntry.status,
          statusText: matchedEntry.statusText ?? statusTextForCode(matchedEntry.status),
          url: call.url
        };
      }

      if (route.notFound === "abort") {
        return {
          action: "abort",
          errorCode: "notinhar"
        };
      }
    }

    return null;
  }

  private findHarRouteEntry(
    route: HarRouteEntry,
    initialUrl: string,
    initialMethod: string
  ): HarRouteEntry["entries"][number] | null {
    const visited = new Set<HarRouteEntry["entries"][number]>();
    let url = initialUrl;
    let method = initialMethod;

    for (;;) {
      const entry = route.entries.find(
        (entry) => entry.method === method && entry.requestUrl === url
      );
      if (!entry) {
        return null;
      }
      if (visited.has(entry)) {
        throw new Error(`Found redirect cycle for ${url}`);
      }
      visited.add(entry);

      const redirectURL =
        entry.redirectURL ||
        entry.responseHeaders.location ||
        entry.responseHeaders.Location;
      if (!redirectURL || !isHarRedirectStatus(entry.status)) {
        return entry;
      }

      url = new URL(redirectURL, url).toString();
      if (
        ((entry.status === 301 || entry.status === 302) && method === "POST") ||
        (entry.status === 303 && method !== "GET" && method !== "HEAD")
      ) {
        method = "GET";
      }
    }
  }

  private async fetchRouteRequest(
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
  ): Promise<APIResponse> {
    const fetchRequest = applyRouteOverrides(request, options);
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
    const timeout = options?.timeout ?? DEFAULT_EVENT_TIMEOUT_MS;
    const timeoutHandle =
      timeout > 0
        ? setTimeout(() => controller.abort(new TimeoutError(`route.fetch: Timeout ${timeout}ms exceeded`)), timeout)
        : null;

    try {
      const response = await fetchWithRetries(fetchRequest.url, {
        allowGetOrHeadBody: true,
        ...(
          !requestBody
            ? {}
            : { body: requestBody }
        ),
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

  private async buildFulfillDecision(
    request: RoutedRequestCall,
    options: {
      body?: string | Buffer;
      contentType?: string;
      headers?: { [key: string]: string };
      json?: unknown;
      path?: string;
      response?: APIResponse | Response | PageResponse;
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
    this.maybeAddCorsHeaders(request, headers);

    const inheritedStatus = options.response
      ? getResponseStatus(options.response)
      : undefined;
    const inheritedStatusText = options.response
      ? getResponseStatusText(options.response)
      : undefined;
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

  private maybeAddCorsHeaders(request: RoutedRequestCall, headers: Record<string, string>): void {
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

  private createRouteRequest(
    current: () => RoutedRequestCall,
    currentResponse: () => Response | null,
    currentFailure: () => { errorText: string } | null,
    currentObserved: () => ObservedRequestState | null
  ): Request {
    return {
      allHeaders: async () => ({ ...current().headers }),
      existingResponse: () => currentResponse() ?? currentObserved()?.request.existingResponse() ?? null,
      failure: () => currentFailure() ?? currentObserved()?.request.failure() ?? null,
      frame: () => currentObserved()?.request.frame() ?? this.mainFrame(),
      headers: () => ({ ...current().headers }),
      headersArray: async () =>
        Object.entries(current().headers).map(([name, value]) => ({
          name,
          value
        })),
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
      postDataJSON: () =>
        parsePostData(
          deserializeSerializedPostData(current().postData, current().postDataBufferBase64 ?? null)
            .text
        ),
      redirectedFrom: () => currentObserved()?.request.redirectedFrom() ?? null,
      redirectedTo: () => currentObserved()?.request.redirectedTo() ?? null,
      resourceType: () => current().resourceType ?? "fetch",
      response: async () => currentResponse() ?? (await currentObserved()?.request.response()) ?? null,
      serviceWorker: () => null,
      sizes: async () => {
        const failure = currentFailure() ?? currentObserved()?.request.failure() ?? null;
        if (failure) {
          throw new Error("Unable to fetch sizes for failed request");
        }
        const response = currentResponse();
        const observed = currentObserved();
        if (!response && observed) {
          return observed.request.sizes();
        }
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
      timing: () =>
        currentObserved()?.request.timing() ?? {
          startTime: Date.now(),
          domainLookupStart: -1,
          domainLookupEnd: -1,
          connectStart: -1,
          secureConnectionStart: -1,
          connectEnd: -1,
          requestStart: 0,
          responseStart: -1,
          responseEnd: -1
        },
      url: () => current().url
    };
  }

  private consumeRouteHandler(entry: RouteHandlerEntry): void {
    if (entry.remainingTimes === null) {
      return;
    }

    entry.remainingTimes -= 1;
    if (entry.remainingTimes <= 0) {
      const index = this.routeHandlers.indexOf(entry);
      if (index >= 0) {
        this.routeHandlers.splice(index, 1);
      }
    }
  }

  private async resolveRoutedRequest(
    id: string,
    decision: RoutedRequestDecision
  ): Promise<void> {
    await this.evaluate(
      ({ requestId, value }) => {
        const globalState = globalThis as typeof globalThis & {
          __roxyRouteBridge?: {
            requestResults: Record<string, RoutedRequestDecision>;
          };
        };
        const bridge = globalState.__roxyRouteBridge;
        if (!bridge) {
          return;
        }
        bridge.requestResults[requestId] = value;
      },
      {
        requestId: id,
        value: decision
      }
    );
  }

  private async dispatchWebSocketOpen(
    call: RoutedWebSocketOpenCall
  ): Promise<RoutedWebSocketOpenDecision> {
    for (let index = this.websocketRouteHandlers.length - 1; index >= 0; index -= 1) {
      const entry = this.websocketRouteHandlers[index];
      if (!entry || !this.matchesRouteMatcher(call.url, entry.matcher)) {
        continue;
      }

      const state: HostedWebSocketRouteState = {
        commands: [],
        originalCloseHandler: null,
        id: call.id,
        originalMessageHandler: null,
        protocols: [...call.protocols],
        serverCloseHandler: null,
        serverConnected: false,
        serverMessageHandler: null,
        url: call.url
      };
      this.hostedWebSocketRoutes.set(call.id, state);
      await entry.handler(this.createHostedWebSocketRoute(state, "original"));
      return { action: "mock" };
    }

    return { action: "passthrough" };
  }

  private createHostedWebSocketRoute(
    state: HostedWebSocketRouteState,
    side: "original" | "server"
  ): WebSocketRoute {
    return {
      onMessage: (handler) => {
        if (side === "original") {
          state.originalMessageHandler = handler;
          return;
        }
        state.serverMessageHandler = handler;
      },
      onClose: (handler) => {
        if (side === "original") {
          state.originalCloseHandler = handler;
          return;
        }
        state.serverCloseHandler = handler;
      },
      close: async (options = {}) => {
        state.commands.push({
          kind: "close",
          ...(options.code !== undefined ? { code: options.code } : {}),
          ...(options.reason !== undefined ? { reason: options.reason } : {})
        });
        await this.flushWebSocketCommands(state.id);
      },
      connectToServer: () => {
        state.serverConnected = true;
        return this.createHostedWebSocketRoute(state, "server");
      },
      protocols: () => [...state.protocols],
      send: (message) => {
        state.commands.push({
          kind: "message",
          message: serializeWebSocketMessage(message)
        });
        void this.flushWebSocketCommands(state.id);
      },
      url: () => state.url,
      [Symbol.asyncDispose]: async () => {
        state.commands.push({ kind: "close" });
        await this.flushWebSocketCommands(state.id);
      }
    };
  }

  private async dispatchWebSocketEvent(call: RoutedWebSocketEventCall): Promise<void> {
    const state = this.hostedWebSocketRoutes.get(call.id);
    if (!state) {
      return;
    }

    if (call.kind === "message") {
      const message = deserializeWebSocketMessage(call.message ?? "");
      if (state.originalMessageHandler) {
        await state.originalMessageHandler(message);
        return;
      }
      if (state.serverConnected && state.serverMessageHandler) {
        await state.serverMessageHandler(message);
      }
      return;
    }

    if (state.originalCloseHandler) {
      await state.originalCloseHandler(call.code, call.reason);
    } else if (state.serverConnected && state.serverCloseHandler) {
      await state.serverCloseHandler(call.code, call.reason);
    }
    this.hostedWebSocketRoutes.delete(call.id);
  }

  private async resolveWebSocketOpen(
    id: string,
    decision: RoutedWebSocketOpenDecision
  ): Promise<void> {
    await this.evaluate(
      ({ socketId, value }) => {
        const globalState = globalThis as typeof globalThis & {
          __roxyRouteBridge?: {
            websocketOpenResults: Record<string, RoutedWebSocketOpenDecision | undefined>;
          };
        };
        const bridge = globalState.__roxyRouteBridge;
        if (!bridge) {
          return;
        }
        bridge.websocketOpenResults[socketId] = value;
      },
      {
        socketId: id,
        value: decision
      }
    );
  }

  private async flushWebSocketCommands(socketId: string): Promise<void> {
    const state = this.hostedWebSocketRoutes.get(socketId);
    if (!state || state.commands.length === 0) {
      return;
    }

    const commands = [...state.commands];
    state.commands.length = 0;
    await this.evaluate(
      ({ socketId: id, value }) => {
        const globalState = globalThis as typeof globalThis & {
          __roxyRouteBridge?: {
            websocketCommands: Record<string, RoutedWebSocketCommand[] | undefined>;
          };
        };
        const bridge = globalState.__roxyRouteBridge;
        if (!bridge) {
          return;
        }
        bridge.websocketCommands[id] ??= [];
        bridge.websocketCommands[id]!.push(...value);
      },
      {
        socketId,
        value: commands
      }
    );
  }

  private matchesRouteMatcher(url: string, matcher: RouteMatcher): boolean {
    if (url.startsWith("data:")) {
      return false;
    }
    return urlMatches(this.baseURL(), url, matcher);
  }

  private matchesHarRouteMatcher(url: string, matcher: string | RegExp): boolean {
    return urlMatches(this.baseURL(), url, matcher);
  }

  private tryParseUrl(url: string): URL | null {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }

  private baseURL(): string | undefined {
    return (this.browserContext as (RoxyBrowserContext & { _options?: { baseURL?: string } }) | undefined)
      ?._options?.baseURL;
  }

  private remainingTimeout(startTime: number, timeout: number): number {
    if (timeout === 0) {
      return 0;
    }
    return Math.max(0, timeout - (Date.now() - startTime));
  }

  private createClosedError(): Error {
    return new Error(this.closeReason ?? "Target page, context or browser has been closed");
  }

  private locatorKey(locator: Locator): string {
    const chain = locator._roxySelectorChain?.();
    if (!chain) {
      return "unknown";
    }
    return JSON.stringify(chain);
  }

  private async waitForLocatorToHide(locator: Locator, timeout: number): Promise<void> {
    const start = Date.now();
    while (timeout === 0 || Date.now() - start <= timeout) {
      if (await locator.isHidden().catch(() => true)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new TimeoutError(
      `Timeout ${timeout}ms exceeded.\n` +
      `locator handler has finished, waiting for ${formatLocatorForMessage(locator)} to be hidden`
    );
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

  private async maybeResolvePickLocator(locator: Locator): Promise<void> {
    if (!this.pickLocatorState) {
      return;
    }

    const current = this.pickLocatorState;
    this.pickLocatorState = null;
    await this.showHighlight(locator);
    current.resolve(locator);
  }

  private async showHighlight(locator: Locator): Promise<void> {
    const selectorChain = locator._roxySelectorChain?.();
    if (!selectorChain?.length) {
      return;
    }

    const handle = await this.adapter.query(selectorChain);
    if (!handle) {
      return;
    }

    await this.createElementHandle(handle).evaluate((element) => {
      const existing = document.querySelector("[data-roxy-highlight-overlay]");
      existing?.remove();
      const target = element as Element;
      const rect = target.getBoundingClientRect();
      const overlay = document.createElement("div");
      overlay.setAttribute("data-roxy-highlight-overlay", "true");
      Object.assign(overlay.style, {
        position: "fixed",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        border: "2px solid rgb(0, 120, 255)",
        background: "rgba(0, 120, 255, 0.12)",
        pointerEvents: "none",
        zIndex: "2147483647"
      });
      document.body.appendChild(overlay);
      target.setAttribute("data-roxy-highlight-target", "true");
    });
  }

  private async prepareScreenshotBackground(options: ScreenshotOptions): Promise<() => Promise<void>> {
    if (!options.omitBackground || (options.type ?? "png") !== "png" || !this.adapter.setScreenshotBackgroundColor) {
      return async () => {};
    }
    await this.adapter.setScreenshotBackgroundColor({ r: 0, g: 0, b: 0, a: 0 });
    return async () => {
      await this.adapter.setScreenshotBackgroundColor?.().catch(() => {});
    };
  }
}

function inferMimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  switch (extension) {
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

function bufferToText(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

function applyRouteOverrides(
  request: RoutedRequestCall,
  options?: {
    headers?: { [key: string]: string | undefined };
    method?: string;
    postData?: string | Buffer | unknown;
    url?: string;
  }
): RoutedRequestCall {
  if (!options) {
    return request;
  }

  if (options.url !== undefined) {
    const originalUrl = new URL(request.url);
    const nextUrl = new URL(options.url);
    if (originalUrl.protocol !== nextUrl.protocol) {
      throw new Error("New URL must have same protocol as overridden URL");
    }
  }

  const normalizedPostData =
    options.postData !== undefined ? normalizeSerializedPostData(options.postData) : null;
  const nextHeaders = options.headers
    ? applyHeaderOverrides(request.headers, options.headers)
    : { ...request.headers };
  const nextMethod = options.method !== undefined ? options.method : request.method;
  const nextUrl = options.url !== undefined ? options.url : request.url;
  const nextBody =
    normalizedPostData !== null
      ? serializePostDataFields(normalizedPostData.text, normalizedPostData.buffer)
      : serializePostDataFields(request.postData, deserializeSerializedPostData(
          request.postData,
          request.postDataBufferBase64 ?? null
        ).buffer);
  const nextRequest: RoutedRequestCall = {
    ...request,
    headers: nextHeaders,
    method: nextMethod,
    ...nextBody,
    url: nextUrl
  };
  return withUpdatedContentLength(nextRequest);
}

function normalizeHeaderRecord(
  headers: Record<string, string | undefined>
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    normalized[name.toLowerCase()] = String(value);
  }
  return normalized;
}

const FORBIDDEN_HEADER_NAMES = new Set([
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

const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);

function isForbiddenHeader(name: string, value?: string): boolean {
  const lowerName = name.toLowerCase();
  if (FORBIDDEN_HEADER_NAMES.has(lowerName)) {
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
    return value !== undefined && FORBIDDEN_METHODS.has(value.toUpperCase());
  }
  return false;
}

function applyHeaderOverrides(
  original: Record<string, string>,
  overrides: Record<string, string | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined || isForbiddenHeader(name, value)) {
      continue;
    }
    result[name.toLowerCase()] = String(value);
  }

  for (const [name, value] of Object.entries(original)) {
    if (!isForbiddenHeader(name, value)) {
      continue;
    }
    result[name.toLowerCase()] = value;
  }

  return result;
}

function withUpdatedContentLength(request: RoutedRequestCall): RoutedRequestCall {
  const nextHeaders = { ...request.headers };
  delete nextHeaders["content-length"];

  const body = deserializeSerializedPostData(
    request.postData,
    request.postDataBufferBase64 ?? null
  ).buffer;
  if (body && body.byteLength > 0) {
    nextHeaders["content-length"] = String(body.byteLength);
  }

  return {
    ...request,
    headers: nextHeaders
  };
}

function aggregateHeaders(
  headers: Array<{ name: string; value: string }>
): Record<string, string> {
  const normalized: Record<string, string[]> = {};
  for (const header of headers) {
    const name = header.name.toLowerCase();
    normalized[name] ??= [];
    normalized[name]!.push(header.value);
  }
  return Object.fromEntries(
    Object.entries(normalized).map(([name, values]) => [
      name,
      values.join(name === "set-cookie" ? "\n" : ", ")
    ])
  );
}

function collectHeaderValues(
  headers: Array<{ name: string; value: string }>,
  name: string
): string[] {
  const normalizedName = name.toLowerCase();
  return headers
    .filter((header) => header.name.toLowerCase() === normalizedName)
    .map((header) => header.value);
}

function joinHeaderValues(
  headers: Array<{ name: string; value: string }>,
  name: string
): string | null {
  const values = collectHeaderValues(headers, name);
  if (!values.length) {
    return null;
  }
  return values.join(name.toLowerCase() === "set-cookie" ? "\n" : ", ");
}

function hasExplicitHeader(
  headers: Record<string, string> | undefined,
  name: string
): boolean {
  if (!headers) {
    return false;
  }
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === normalizedName);
}

function statusTextForCode(status: number): string {
  return STATUS_CODES[status] ?? "Unknown";
}

function isHarRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function createRoutedResponse(data: RoutedResponseData, request: Request): Response {
  const normalizedHeaders = normalizeHeaderRecord(data.headers);
  const headerEntries = Object.entries(normalizedHeaders).map(([name, value]) => ({ name, value }));
  const readBodyText = createResponseTextReader(
    data.status,
    headerEntries,
    async () => decodeSerializedBody(data.body, data.bodyBufferBase64 ?? null).toString("utf8")
  );
  return {
    allHeaders: async () => ({ ...normalizedHeaders }),
    body: async () => Buffer.from(decodeSerializedBody(data.body, data.bodyBufferBase64 ?? null)),
    finished: async () => waitForResponseCompletion(readBodyText),
    frame: () => request.frame(),
    fromServiceWorker: () => false,
    headers: () => ({ ...normalizedHeaders }),
    headersArray: async () =>
      Object.entries(normalizedHeaders).map(([name, value]) => ({
        name,
        value
      })),
    headerValue: async (name: string) => normalizedHeaders[name.toLowerCase()] ?? null,
    headerValues: async (name: string) => {
      const value = normalizedHeaders[name.toLowerCase()];
      return value === undefined ? [] : [value];
    },
    httpVersion: async () => "HTTP/1.1",
    json: async () => JSON.parse(await readBodyText()),
    ok: () => data.status === 0 || (data.status >= 200 && data.status < 300),
    request: () => request,
    securityDetails: async () => null,
    serverAddr: async () => null,
    status: () => data.status,
    statusText: () => data.statusText,
    text: async () => readBodyText(),
    url: () => data.url
  };
}

function responseWithFrame(response: Response, frame: Frame): Response {
  const request = response.request();
  const framedRequest: Request = {
    ...request,
    frame: () => frame
  };
  return {
    ...response,
    frame: () => frame,
    request: () => framedRequest
  };
}

async function responseDataFromResponse(response: Response | APIResponse): Promise<RoutedResponseData> {
  const bodyBuffer = await response.body();
  return {
    body: bodyBuffer.toString("utf8"),
    ...(bodyBuffer.byteLength > 0
      ? { bodyBufferBase64: bodyBuffer.toString("base64") }
      : {}),
    headers: response.headers(),
    status: response.status(),
    statusText: response.statusText(),
    url: response.url()
  };
}

async function responseHeadersRecord(
  response: APIResponse | Response | PageResponse
): Promise<Record<string, string>> {
  if (isRouteApiResponse(response)) {
    return aggregateHeaders(response.headersArray());
  }
  if (isProtocolOrObservedResponse(response)) {
    return response.allHeaders();
  }
  return Object.fromEntries(response.headers.map((header) => [header.name, header.value]));
}

function getResponseStatus(response: APIResponse | Response | PageResponse): number {
  return isProtocolOrObservedResponse(response) ? response.status() : response.status;
}

function getResponseStatusText(response: APIResponse | Response | PageResponse): string {
  return isProtocolOrObservedResponse(response) ? response.statusText() : response.statusText;
}

function isRouteApiResponse(response: APIResponse | Response | PageResponse): response is APIResponse {
  return typeof (response as APIResponse).dispose === "function";
}

function isProtocolOrObservedResponse(
  response: APIResponse | Response | PageResponse
): response is APIResponse | Response {
  return typeof (response as Response).status === "function";
}

async function withAsyncApiStack<T>(callback: () => Promise<T>): Promise<T> {
  const apiStack = new Error().stack;
  try {
    return await callback();
  } catch (error) {
    appendAsyncApiStack(error, apiStack);
    throw error;
  }
}

function appendAsyncApiStack(error: unknown, apiStack: string | undefined): void {
  if (!(error instanceof Error) || !apiStack) {
    return;
  }
  const userStack = apiStack
    .split("\n")
    .slice(2)
    .filter((line) => !line.includes("/src/page.ts:"))
    .join("\n");
  if (!userStack) {
    return;
  }
  const currentStack = error.stack || `${error.name}: ${error.message}`;
  if (currentStack.includes(userStack)) {
    return;
  }
  error.stack = `${currentStack}\n${userStack}`;
}

async function observedRequestSizes(state: ObservedRequestState): Promise<{
  requestBodySize: number;
  requestHeadersSize: number;
  responseBodySize: number;
  responseHeadersSize: number;
}> {
  if (state.failure) {
    throw new Error("Unable to fetch sizes for failed request");
  }

  return {
    requestBodySize: state.postDataBuffer?.byteLength ?? 0,
    requestHeadersSize: headerSize(state.headers),
    responseBodySize: state.response ? await measureResponseBodySize(state.response) : 0,
    responseHeadersSize: state.response ? headerSize(await state.response.allHeaders()) : 0
  };
}

function parsePostData(postData: string | null): unknown {
  if (postData === null) {
    return null;
  }
  try {
    return JSON.parse(postData);
  } catch (error) {
    throw new Error(`POST data is not a valid JSON object: ${postData}`);
  }
}

function parseObservedRequestPostData(
  postData: string | null,
  headers: Record<string, string>
): unknown {
  if (postData === null) {
    return null;
  }

  const contentType = headers["content-type"]?.toLowerCase() ?? "";
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(postData).entries());
  }

  return parsePostData(postData);
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

function decodeSerializedBody(body: string, bodyBufferBase64: string | null): Buffer {
  if (bodyBufferBase64 !== null) {
    return Buffer.from(bodyBufferBase64, "base64");
  }
  return Buffer.from(body, "utf8");
}

function createResponseTextReader(
  status: number,
  headers: Array<{ name: string; value: string }>,
  readBody: () => Promise<string>
): () => Promise<string> {
  const redirect = isRedirectResponse(status, headers);
  let textPromise: Promise<string> | null = null;
  return () => {
    if (redirect) {
      return Promise.reject(new Error("Response body is unavailable for redirect responses"));
    }
    textPromise ??= readBody();
    return textPromise;
  };
}

function createResponseBodyReader(
  status: number,
  headers: Array<{ name: string; value: string }>,
  readBody: () => Promise<Buffer>
): () => Promise<Buffer> {
  const redirect = isRedirectResponse(status, headers);
  let bodyPromise: Promise<Buffer> | null = null;
  return () => {
    if (redirect) {
      return Promise.reject(new Error("Response body is unavailable for redirect responses"));
    }
    bodyPromise ??= readBody();
    return bodyPromise;
  };
}

async function waitForResponseCompletion(
  readBodyText: () => Promise<string>
): Promise<null | Error> {
  try {
    await readBodyText();
    return null;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Response body is unavailable for redirect responses")
    ) {
      return null;
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function measureResponseBodySize(response: Response): Promise<number> {
  try {
    return Buffer.byteLength(await response.text(), "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Response body is unavailable for redirect responses")
    ) {
      return 0;
    }
    throw error;
  }
}

function isRedirectResponse(
  status: number,
  headers: Array<{ name: string; value: string }>
): boolean {
  return status >= 300 && status < 400 && headers.some((header) => header.name.toLowerCase() === "location");
}

async function responseBodyBuffer(
  response: APIResponse | Response | PageResponse
): Promise<Buffer> {
  if (isRouteApiResponse(response) || isProtocolOrObservedResponse(response)) {
    return response.body();
  }
  return Buffer.from(await response.text(), "utf8");
}

function headerSize(headers: Record<string, string>): number {
  return Object.entries(headers).reduce(
    (total, [name, value]) => total + Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 4,
    2
  );
}

function resolveRedirectUrl(baseUrl: string, location: string): string {
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    return location;
  }
}

function normalizeWebSocketProtocols(protocols?: string | string[]): string[] {
  if (protocols === undefined) {
    return [];
  }
  return Array.isArray(protocols) ? [...protocols] : [protocols];
}

function serializeWebSocketMessage(message: string | Buffer): string {
  return typeof message === "string" ? message : message.toString("utf8");
}

function deserializeWebSocketMessage(message: string): string | Buffer {
  return message;
}

function deserializeWebSocketFrame(opcode: number, data: string): string | Buffer {
  return opcode === 2 ? Buffer.from(data, "base64") : data;
}

function serializePageWebSocketData(
  data: string | ArrayBufferLike | Blob | ArrayBufferView
): string {
  if (typeof data === "string") {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  return String(data);
}

function uint8ArrayToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToUint8Array(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function installRouteBridge(): void {
  const globalState = globalThis as typeof globalThis & {
    __roxyRouteBridgeLocal?: {
      installed?: boolean;
      originalFetch?: typeof globalThis.fetch;
      originalWebSocket?: typeof globalThis.WebSocket;
    };
  };
  const resolveBridgeHost = () => {
    const currentWindow = globalThis as typeof globalThis & {
      __roxyRouteBridge?: {
        requestCalls: RoutedRequestCall[];
        requestNextId: number;
        requestResults: Record<string, RoutedRequestDecision>;
        websocketCommands: Record<string, RoutedWebSocketCommand[] | undefined>;
        websocketEventCalls: RoutedWebSocketEventCall[];
        websocketOpenCalls: RoutedWebSocketOpenCall[];
        websocketOpenNextId: number;
        websocketOpenResults: Record<string, RoutedWebSocketOpenDecision | undefined>;
      };
    };
    try {
      const topWindow = currentWindow.top;
      if (
        topWindow &&
        topWindow !== (currentWindow as unknown as Window) &&
        topWindow.location.origin === currentWindow.location.origin
      ) {
        return topWindow as unknown as typeof currentWindow;
      }
    } catch {}
    return currentWindow;
  };
  const bridgeHost = resolveBridgeHost();
  const bridge = bridgeHost.__roxyRouteBridge ?? (bridgeHost.__roxyRouteBridge = {
    requestCalls: [],
    requestNextId: 0,
    requestResults: {},
    websocketCommands: {},
    websocketEventCalls: [],
    websocketOpenCalls: [],
    websocketOpenNextId: 0,
    websocketOpenResults: {}
  });
  const localState = globalState.__roxyRouteBridgeLocal ?? (globalState.__roxyRouteBridgeLocal = {});
  if (localState.installed) {
    return;
  }

  localState.installed = true;
  localState.originalFetch ??= globalThis.fetch.bind(globalThis);
  localState.originalWebSocket ??= globalThis.WebSocket;

  const headersToObject = (headers: Headers): Record<string, string> => {
    const normalized: Record<string, string> = {};
    headers.forEach((value, name) => {
      normalized[name.toLowerCase()] = value;
    });
    return normalized;
  };

  const waitForDecision = async (requestId: string): Promise<RoutedRequestDecision> => {
    for (;;) {
      const result = bridge.requestResults[requestId];
      if (result) {
        delete bridge.requestResults[requestId];
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = request.url;
    if (url.startsWith("data:")) {
      return localState.originalFetch!(input, init);
    }

    const method = request.method.toUpperCase();
    const postDataBufferBase64 =
      method === "GET" || method === "HEAD"
        ? null
        : await request.clone().arrayBuffer().then((buffer) => uint8ArrayToBase64(new Uint8Array(buffer))).catch(() => null);
    const postData =
      postDataBufferBase64 === null ? null : new TextDecoder().decode(base64ToUint8Array(postDataBufferBase64));
    const requestId = `request:${++bridge.requestNextId}`;
    bridge.requestCalls.push({
      id: requestId,
      url,
      method,
      headers: headersToObject(request.headers),
      postData,
      ...(postDataBufferBase64 !== null ? { postDataBufferBase64 } : {}),
      isNavigationRequest: false,
      resourceType: "fetch"
    });

    const decision = await waitForDecision(requestId);
    if (decision.action === "abort") {
      throw new Error(decision.errorCode ?? "Request aborted");
    }
    if (decision.action === "fulfill") {
      return new Response(decision.body, {
        headers: decision.headers,
        status: decision.status,
        statusText: decision.statusText
      });
    }

    const continuedMethod = decision.method.toUpperCase();
    const continuedBodyBytes = decision.postDataBufferBase64
      ? base64ToUint8Array(decision.postDataBufferBase64)
      : null;
    const continuedBodyBuffer = continuedBodyBytes
      ? (() => {
          const buffer = new Uint8Array(continuedBodyBytes.byteLength);
          buffer.set(continuedBodyBytes);
          return buffer.buffer;
        })()
      : null;
    const continuedBody =
      continuedMethod === "GET" || continuedMethod === "HEAD"
        ? undefined
        : continuedBodyBuffer
          ? new Blob([continuedBodyBuffer])
          : decision.postData ?? undefined;
    return localState.originalFetch!(decision.url, {
      ...(continuedBody !== undefined ? { body: continuedBody } : {}),
      cache: "no-store",
      credentials: request.credentials,
      headers: decision.headers,
      integrity: request.integrity,
      keepalive: request.keepalive,
      method: continuedMethod,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      signal: request.signal
    });
  }) as typeof globalThis.fetch;

  class RoxyInterceptedWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    binaryType: BinaryType = "blob";
    bufferedAmount = 0;
    extensions = "";
    onclose: ((this: globalThis.WebSocket, event: CloseEvent) => any) | null = null;
    onerror: ((this: globalThis.WebSocket, event: Event) => any) | null = null;
    onmessage: ((this: globalThis.WebSocket, event: MessageEvent) => any) | null = null;
    onopen: ((this: globalThis.WebSocket, event: Event) => any) | null = null;
    protocol = "";
    readyState = RoxyInterceptedWebSocket.CONNECTING;
    readonly url: string;
    private readonly _socketId: string;
    private readonly _protocolsArg: string | string[] | undefined;
    private _nativeSocket: globalThis.WebSocket | null = null;

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      this.url = String(url);
      this._protocolsArg = protocols;
      this._socketId = `websocket:${++bridge.websocketOpenNextId}`;
      void this._initialize(normalizeWebSocketProtocols(protocols));
    }

    close(code?: number, reason?: string): void {
      if (this._nativeSocket) {
        this._nativeSocket.close(code, reason);
        return;
      }
      if (this.readyState === RoxyInterceptedWebSocket.CLOSED) {
        return;
      }
      this.readyState = RoxyInterceptedWebSocket.CLOSING;
      bridge.websocketEventCalls.push({
        id: this._socketId,
        kind: "close",
        ...(code !== undefined ? { code } : {}),
        ...(reason !== undefined ? { reason } : {})
      });
      this._applyCommand({
        kind: "close",
        ...(code !== undefined ? { code } : {}),
        ...(reason !== undefined ? { reason } : {})
      });
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this._nativeSocket) {
        this._nativeSocket.send(data as string | Blob | BufferSource);
        return;
      }
      if (this.readyState !== RoxyInterceptedWebSocket.OPEN) {
        throw new Error("WebSocket is not open");
      }
      bridge.websocketEventCalls.push({
        id: this._socketId,
        kind: "message",
        message: serializePageWebSocketData(data)
      });
    }

    private async _initialize(protocols: string[]): Promise<void> {
      bridge.websocketOpenCalls.push({
        id: this._socketId,
        protocols,
        url: this.url
      });
      const decision = await waitForWebSocketOpenDecision(this._socketId);
      if (decision.action === "passthrough") {
        this._attachNativeSocket(protocols);
        return;
      }
      this.readyState = RoxyInterceptedWebSocket.OPEN;
      this._emit("open", new Event("open"));
      this._pollCommands();
    }

    private _attachNativeSocket(protocols: string[]): void {
      const nativeSocket = this._protocolsArg !== undefined
        ? new localState.originalWebSocket!(this.url, this._protocolsArg)
        : protocols.length
          ? new localState.originalWebSocket!(this.url, protocols)
          : new localState.originalWebSocket!(this.url);
      this._nativeSocket = nativeSocket;
      this.protocol = nativeSocket.protocol;
      nativeSocket.binaryType = this.binaryType;
      nativeSocket.addEventListener("open", (event) => {
        this.readyState = nativeSocket.readyState;
        this.protocol = nativeSocket.protocol;
        this._emit("open", event);
      });
      nativeSocket.addEventListener("message", (event) => {
        this._emit("message", event);
      });
      nativeSocket.addEventListener("close", (event) => {
        this.readyState = nativeSocket.readyState;
        this._emit("close", event);
      });
      nativeSocket.addEventListener("error", (event) => {
        this._emit("error", event);
      });
    }

    private _applyCommand(command: RoutedWebSocketCommand): void {
      if (command.kind === "message") {
        this._emit("message", new MessageEvent("message", { data: command.message ?? "" }));
        return;
      }

      this.readyState = RoxyInterceptedWebSocket.CLOSED;
      this._emit(
        "close",
        new CloseEvent("close", {
          ...(command.code !== undefined ? { code: command.code } : {}),
          ...(command.reason !== undefined ? { reason: command.reason } : {})
        })
      );
    }

    private _emit(type: "close" | "error" | "message" | "open", event: Event): void {
      this.dispatchEvent(event);
      if (type === "open") {
        this.onopen?.call(this as unknown as globalThis.WebSocket, event);
      } else if (type === "message") {
        this.onmessage?.call(this as unknown as globalThis.WebSocket, event as MessageEvent);
      } else if (type === "close") {
        this.onclose?.call(this as unknown as globalThis.WebSocket, event as CloseEvent);
      } else {
        this.onerror?.call(this as unknown as globalThis.WebSocket, event);
      }
    }

    private async _pollCommands(): Promise<void> {
      while (this.readyState === RoxyInterceptedWebSocket.OPEN) {
        const commands = bridge.websocketCommands[this._socketId] ?? [];
        if (commands.length) {
          bridge.websocketCommands[this._socketId] = [];
          for (const command of commands) {
            this._applyCommand(command);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  const waitForWebSocketOpenDecision = async (
    socketId: string
  ): Promise<RoutedWebSocketOpenDecision> => {
    for (;;) {
      const result = bridge.websocketOpenResults[socketId];
      if (result) {
        delete bridge.websocketOpenResults[socketId];
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  globalThis.WebSocket = RoxyInterceptedWebSocket as unknown as typeof globalThis.WebSocket;
}

function serializeBindingError(error: unknown): {
  value: unknown;
  message?: string;
  stack?: string;
  isNull?: boolean;
} {
  if (error === null) {
    return {
      value: null,
      isNull: true
    };
  }

  if (error instanceof Error) {
    return {
      value: error.message,
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {})
    };
  }

  return {
    value: error
  };
}

function installPauseController(pauseId: string): void {
  const globalState = globalThis as typeof globalThis & {
    __roxyPauseController?: PauseControllerState;
    playwright?: { resume?: () => boolean } & Record<string, unknown>;
  };
  const previousPlaywright = globalState.playwright;
  const normalizeText = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();
  const matchesText = (value: string, matcher: string | RegExp): boolean => {
    if (matcher instanceof RegExp) {
      return matcher.test(value);
    }
    return value.toLowerCase().includes(matcher.toLowerCase());
  };
  const isVisible = (element: Element): boolean => {
    const htmlElement = element as HTMLElement;
    if (htmlElement.hidden) {
      return false;
    }
    const style = globalThis.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    const rect = htmlElement.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const uniqueElements = (elements: Element[]): Element[] => {
    const seen = new Set<Element>();
    const result: Element[] = [];
    for (const element of elements) {
      if (seen.has(element)) {
        continue;
      }
      seen.add(element);
      result.push(element);
    }
    return result;
  };
  const createCssSelector = (node: unknown): string | null => {
    if (!(node instanceof Element)) {
      return null;
    }
    if (node === document.documentElement) {
      return "html";
    }
    if (node === document.body) {
      return "body";
    }
    if (node.id) {
      return `#${globalThis.CSS.escape(node.id)}`;
    }
    const parts: string[] = [];
    let current: Element | null = node;
    while (current && current !== document.documentElement) {
      const tagName = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      if (!parent) {
        parts.unshift(tagName);
        break;
      }
      const sameTagSiblings = Array.from(parent.children).filter(
        (child: Element) => child.tagName === current!.tagName
      );
      if (sameTagSiblings.length === 1) {
        parts.unshift(tagName);
      } else {
        const siblingIndex = sameTagSiblings.indexOf(current) + 1;
        parts.unshift(`${tagName}:nth-of-type(${siblingIndex})`);
      }
      current = parent;
      if (current === document.body) {
        parts.unshift("body");
        break;
      }
    }
    return parts.join(" > ");
  };
  const queryAllByText = (root: ParentNode, matcher: string | RegExp): Element[] =>
    uniqueElements(
      Array.from(root.querySelectorAll("*")).filter((element) => {
        if (!matchesText(normalizeText(element.textContent), matcher)) {
          return false;
        }
        return !Array.from(element.children).some((child: Element) =>
          matchesText(normalizeText(child.textContent), matcher)
        );
      })
    );
  type LocatorFilterOptions = {
    hasText?: string | RegExp;
    hasNotText?: string | RegExp;
    has?: unknown;
    hasNot?: unknown;
    visible?: boolean;
  };
  type PauseLocator = {
    __resolveElements: () => Element[];
    readonly element: Element | null;
    readonly elements: Element[];
    locator: (selector: string, options?: LocatorFilterOptions) => PauseLocator;
    filter: (options: LocatorFilterOptions) => PauseLocator;
    first: () => PauseLocator;
    last: () => PauseLocator;
    nth: (index: number) => PauseLocator;
    and: (other: unknown) => PauseLocator;
    or: (other: unknown) => PauseLocator;
  };
  const matchesAttribute = (
    element: Element,
    attributeName: string,
    matcher: string | RegExp
  ): boolean => {
    const value = element.getAttribute(attributeName);
    return value !== null && matchesText(value, matcher);
  };
  const getElementLabel = (element: Element): string => {
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) {
      return normalizeText(ariaLabel);
    }
    const htmlElement = element as HTMLElement & {
      labels?: NodeListOf<HTMLLabelElement>;
    };
    const labels = htmlElement.labels ? Array.from(htmlElement.labels) : [];
    if (labels.length > 0) {
      return normalizeText(labels.map((label) => label.textContent ?? "").join(" "));
    }
    if (element instanceof HTMLLabelElement) {
      return normalizeText(element.textContent);
    }
    return "";
  };
  const getAccessibleName = (element: Element): string => {
    return normalizeText(
      element.getAttribute("aria-label") ||
        getElementLabel(element) ||
        element.getAttribute("title") ||
        element.getAttribute("alt") ||
        element.textContent
    );
  };
  const getImplicitRole = (element: Element): string | null => {
    const explicitRole = element.getAttribute("role");
    if (explicitRole) {
      return explicitRole;
    }
    const tagName = element.tagName.toLowerCase();
    if (tagName === "button") {
      return "button";
    }
    if (tagName === "a" && element.hasAttribute("href")) {
      return "link";
    }
    if (tagName === "img") {
      return "img";
    }
    if (tagName === "input") {
      const input = element as HTMLInputElement;
      if (input.type === "checkbox") {
        return "checkbox";
      }
      if (input.type === "radio") {
        return "radio";
      }
      if (["button", "submit", "reset"].includes(input.type)) {
        return "button";
      }
      return "textbox";
    }
    if (tagName === "textarea") {
      return "textbox";
    }
    if (tagName === "select") {
      return "combobox";
    }
    return null;
  };
  const queryAllByRole = (
    role: string,
    options?: {
      name?: string | RegExp;
      exact?: boolean;
    }
  ): Element[] =>
    uniqueElements(
      Array.from(document.querySelectorAll("*")).filter((element) => {
        if (getImplicitRole(element) !== role) {
          return false;
        }
        if (options?.name === undefined) {
          return true;
        }
        const name = getAccessibleName(element);
        if (options.exact && typeof options.name === "string") {
          return name === options.name;
        }
        return matchesText(name, options.name);
      })
    );
  const resolveLocatorElements = (value: unknown): Element[] => {
    if (!value || typeof value !== "object") {
      return [];
    }
    const resolver = (value as { __resolveElements?: () => Element[] }).__resolveElements;
    if (typeof resolver !== "function") {
      return [];
    }
    return uniqueElements(resolver());
  };
  const queryAll = (selector: string, scope?: ParentNode): Element[] => {
    const root = scope ?? document;
    if (selector.startsWith("text=")) {
      return queryAllByText(root, selector.slice("text=".length));
    }
    return uniqueElements(Array.from(root.querySelectorAll(selector)));
  };
  const filterElements = (
    elements: Element[],
    options?: LocatorFilterOptions
  ): Element[] => {
    if (!options) {
      return uniqueElements(elements);
    }
    return uniqueElements(
      elements.filter((element) => {
        if (options.hasText !== undefined && !matchesText(normalizeText(element.textContent), options.hasText)) {
          return false;
        }
        if (options.hasNotText !== undefined && matchesText(normalizeText(element.textContent), options.hasNotText)) {
          return false;
        }
        if (options.visible !== undefined && isVisible(element) !== options.visible) {
          return false;
        }
        if (options.has !== undefined) {
          const matches = resolveLocatorElements(options.has).some((candidate) => element.contains(candidate));
          if (!matches) {
            return false;
          }
        }
        if (options.hasNot !== undefined) {
          const matches = resolveLocatorElements(options.hasNot).some((candidate) => element.contains(candidate));
          if (matches) {
            return false;
          }
        }
        return true;
      })
    );
  };
  const createLocator = (resolve: () => Element[]): PauseLocator => {
    const locator: PauseLocator = {
      __resolveElements: () => uniqueElements(resolve()),
      get element(): Element | null {
        return locator.__resolveElements()[0] ?? null;
      },
      get elements(): Element[] {
        return locator.__resolveElements();
      },
      locator(selector: string, options?: LocatorFilterOptions) {
        return createLocator(() =>
          filterElements(
            uniqueElements(
              locator
                .__resolveElements()
                .flatMap((element) => queryAll(selector, element))
            ),
            options
          )
        );
      },
      filter(options: LocatorFilterOptions) {
        return createLocator(() => filterElements(locator.__resolveElements(), options));
      },
      first() {
        return createLocator(() => locator.__resolveElements().slice(0, 1));
      },
      last() {
        return createLocator(() => {
          const elements = locator.__resolveElements();
          const lastElement = elements.at(-1);
          return lastElement ? [lastElement] : [];
        });
      },
      nth(index: number) {
        return createLocator(() => {
          const element = locator.__resolveElements()[index];
          return element ? [element] : [];
        });
      },
      and(other: unknown) {
        return createLocator(() => {
          const otherElements = new Set(resolveLocatorElements(other));
          return locator.__resolveElements().filter((element) => otherElements.has(element));
        });
      },
      or(other: unknown) {
        return createLocator(() =>
          uniqueElements([...locator.__resolveElements(), ...resolveLocatorElements(other)])
        );
      }
    };
    return locator;
  };
  const rootLocator = (
    selector: string,
    options?: LocatorFilterOptions
  ) => createLocator(() => filterElements(queryAll(selector), options));
  globalState.__roxyPauseController = {
    id: pauseId,
    previousPlaywright,
    resumed: false
  };
  globalState.playwright = {
    $: (selector: string) => document.querySelector(selector),
    $$: (selector: string) => Array.from(document.querySelectorAll(selector)),
    inspect: (selectorOrNode: string | Node) =>
      typeof selectorOrNode === "string" ? document.querySelector(selectorOrNode) : selectorOrNode,
    selector: (node: unknown) => createCssSelector(node),
    generateLocator: (node: unknown) => createCssSelector(node),
    ariaSnapshot: (node?: unknown) => {
      const element = node instanceof Element ? node : document.body;
      return JSON.stringify(
        {
          role: getImplicitRole(element),
          name: getAccessibleName(element)
        },
        null,
        2
      );
    },
    resume: () => {
      const state = globalState.__roxyPauseController;
      if (!state || state.id !== pauseId || state.resumed) {
        return false;
      }
      state.resumed = true;
      return true;
    },
    locator: (
      selector: string,
      options?: LocatorFilterOptions
    ) => rootLocator(selector, options),
    getByTestId: (testId: string | RegExp) =>
      createLocator(() =>
        uniqueElements(
          Array.from(document.querySelectorAll("[data-testid]")).filter((element) =>
            matchesAttribute(element, "data-testid", testId)
          )
        )
      ),
    getByAltText: (text: string | RegExp) =>
      createLocator(() =>
        uniqueElements(
          Array.from(document.querySelectorAll("[alt]")).filter((element) =>
            matchesAttribute(element, "alt", text)
          )
        )
      ),
    getByLabel: (text: string | RegExp) =>
      createLocator(() =>
        uniqueElements(
          Array.from(document.querySelectorAll("input, textarea, select, button")).filter((element) =>
            matchesText(getElementLabel(element), text)
          )
        )
      ),
    getByPlaceholder: (text: string | RegExp) =>
      createLocator(() =>
        uniqueElements(
          Array.from(document.querySelectorAll("[placeholder]")).filter((element) =>
            matchesAttribute(element, "placeholder", text)
          )
        )
      ),
    getByText: (text: string | RegExp) => createLocator(() => queryAllByText(document, text)),
    getByTitle: (text: string | RegExp) =>
      createLocator(() =>
        uniqueElements(
          Array.from(document.querySelectorAll("[title]")).filter((element) =>
            matchesAttribute(element, "title", text)
          )
        )
      ),
    getByRole: (
      role: string,
      options?: {
        name?: string | RegExp;
        exact?: boolean;
      }
    ) => createLocator(() => queryAllByRole(role, options))
  };
}

function isPauseControllerResumed(pauseId: string): boolean {
  const globalState = globalThis as typeof globalThis & {
    __roxyPauseController?: PauseControllerState;
  };
  return globalState.__roxyPauseController?.id === pauseId && globalState.__roxyPauseController.resumed;
}

function cleanupPauseController(pauseId: string): void {
  const globalState = globalThis as typeof globalThis & {
    __roxyPauseController?: PauseControllerState;
    playwright?: unknown;
  };
  const state = globalState.__roxyPauseController;
  if (!state || state.id !== pauseId) {
    return;
  }

  if (state.previousPlaywright === undefined) {
    delete globalState.playwright;
  } else {
    globalState.playwright = state.previousPlaywright;
  }
  delete globalState.__roxyPauseController;
}

function trimString(input: string, cap: number, suffix = ""): string {
  if (input.length <= cap) {
    return input;
  }
  const chars = [...input];
  if (chars.length > cap) {
    return chars.slice(0, cap - suffix.length).join("") + suffix;
  }
  return chars.join("");
}

function trimStringWithEllipsis(input: string, cap: number): string {
  return trimString(input, cap, "\u2026");
}

function trimUrlForWaitLog(param: unknown): string | undefined {
  if (isRegExp(param)) {
    return `/${trimStringWithEllipsis(param.source, 50)}/${param.flags}`;
  }
  if (typeof param === "string") {
    return `"${trimStringWithEllipsis(param, 50)}"`;
  }
  return undefined;
}

async function runWithTimeout<T>(
  promise: Promise<T>,
  timeout: number,
  onTimeout?: () => void
): Promise<T> {
  if (timeout === 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new TimeoutError(`Timeout ${timeout}ms exceeded.`));
        }, timeout);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function formatLocatorForMessage(locator: Locator): string {
  const chain = locator._roxySelectorChain?.();
  if (!chain?.length) {
    return "locator";
  }
  return chain.map(formatLocatorSelectorForMessage).join(".");
}

function formatLocatorSelectorForMessage(selector: LocatorSelector): string {
  if (selector.strategy === "role") {
    const options: string[] = [];
    if (selector.name !== undefined) {
      options.push(`name: ${JSON.stringify(selector.name)}`);
    }
    return options.length
      ? `getByRole('${selector.value}', { ${options.join(", ")} })`
      : `getByRole('${selector.value}')`;
  }
  if (selector.strategy === "text") {
    return `getByText(${JSON.stringify(selector.value)})`;
  }
  if (selector.strategy === "css") {
    return `locator(${JSON.stringify(selector.value)})`;
  }
  if (selector.strategy === "control") {
    return `internal:control=${selector.value}`;
  }
  return `${selector.strategy}=${selector.value}`;
}

async function evaluationScript<Arg>(
  script: string | ((arg: Arg) => unknown) | { path?: string; content?: string },
  arg?: Arg
): Promise<string> {
  if (typeof script === "function") {
    const source = serializePageFunction(script as unknown as ElementCallback<unknown, Arg>);
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
    return addSourceUrlToScript(source, script.path);
  }
  throw new Error("Either path or content property must be present");
}

function addSourceUrlToScript(source: string, path: string): string {
  return `${source}\n//# sourceURL=${path.replace(/\n/g, "")}`;
}

function cssStringEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function cssIdentifierEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function createWaitForEventTimeoutError(
  event: string,
  timeout: number,
  logLine?: string
): TimeoutError {
  const message = [`Timeout ${timeout}ms exceeded while waiting for event "${event}"`];
  if (logLine) {
    message.push(logLine);
  }
  return new TimeoutError(message.join("\n"));
}
