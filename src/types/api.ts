import type { ReadStream } from "node:fs";
import type {
  AddLocatorHandlerOptions,
  AddScriptTagOptions,
  AddStyleTagOptions,
  AriaSnapshotOptions,
  BrowserContextOptions,
  BrowserConnectOptions,
  ClickOptions,
  DragAndDropOptions,
  ConnectOverCDPOptions,
  DispatchEventOptions,
  EmulateMediaOptions,
  FilePayload,
  FillOptions,
  GetByAltTextOptions,
  GetByLabelOptions,
  GetByPlaceholderOptions,
  Header,
  GetByRoleOptions,
  GetByTextOptions,
  GetByTitleOptions,
  HoverOptions,
  LaunchOptions,
  PageCloseOptions,
  PageGotoOptions,
  PageScreenshotOptions,
  PageSetContentOptions,
  PressOptions,
  Rect,
  SelectOptionValue,
  ScreenshotOptions,
  SetInputFilesOptions,
  TapOptions,
  TypeOptions,
  ViewportSize,
  WaitForNavigationOptions,
  WaitForURLOptions,
  WaitForSelectorOptions,
  TimeoutOptions,
  SelectorStrictOptions
} from "./options.js";
import type { BrowserContextEventListener, BrowserContextEventName, BrowserContextEventPredicate, ConsoleMessage, PageConsoleMessage } from "./events.js";
import type {
  PageEventListener,
  PageEventMap,
  PageEventName,
  PageEventPredicate,
  PageResponse
} from "./events.js";
import type { LocatorSelector } from "../protocol/adapter.js";

export interface Disposable {
  dispose(): Promise<void> | void;
}

/**
 * Can be converted to JSON
 */
export type Serializable = any;
/**
 * Can be converted to JSON, but may also contain JSHandles.
 */
export type EvaluationArgument = {};

export type NoHandles<Arg> = Arg extends JSHandle ? never : (Arg extends object ? { [Key in keyof Arg]: NoHandles<Arg[Key]> } : Arg);
export type Unboxed<Arg> =
  Arg extends ElementHandle<infer T> ? T :
  Arg extends JSHandle<infer T> ? T :
  Arg extends NoHandles<Arg> ? Arg :
  Arg extends [infer A0] ? [Unboxed<A0>] :
  Arg extends [infer A0, infer A1] ? [Unboxed<A0>, Unboxed<A1>] :
  Arg extends [infer A0, infer A1, infer A2] ? [Unboxed<A0>, Unboxed<A1>, Unboxed<A2>] :
  Arg extends [infer A0, infer A1, infer A2, infer A3] ? [Unboxed<A0>, Unboxed<A1>, Unboxed<A2>, Unboxed<A3>] :
  Arg extends Array<infer T> ? Array<Unboxed<T>> :
  Arg extends object ? { [Key in keyof Arg]: Unboxed<Arg[Key]> } :
  Arg;
export type PageFunction<Arg, R> = string | ((arg: Unboxed<Arg>) => R | Promise<R>);
export type PageFunctionOn<On, Arg2, R> = string | ((on: On, arg2: Unboxed<Arg2>) => R | Promise<R>);
export type SmartHandle<T> = [T] extends [Node] ? ElementHandle<T> : JSHandle<T>;
export type ElementHandleForTag<K extends keyof HTMLElementTagNameMap> = ElementHandle<HTMLElementTagNameMap[K]>;

type PageWaitForSelectorOptionsNotHidden = WaitForSelectorOptions & {
  state?: "visible" | "attached";
};
type PageWaitForSelectorOptions = WaitForSelectorOptions;
type PageWaitForFunctionOptions = {
  polling?: number | "raf";
  timeout?: number;
};
type ElementHandleWaitForSelectorOptionsNotHidden = WaitForSelectorOptions & {
  state?: "visible" | "attached";
};
type ElementHandleWaitForSelectorOptions = WaitForSelectorOptions;
type LocatorOptions = {
  has?: Locator;
  hasNot?: Locator;
  hasNotText?: string | RegExp;
  hasText?: string | RegExp;
};

export type ElementCallback<TResult, TArg = unknown> = (
  element: unknown,
  arg: TArg
) => TResult | Promise<TResult>;

export type ElementArrayCallback<TResult, TArg = unknown> = (
  elements: unknown[],
  arg: TArg
) => TResult | Promise<TResult>;

export interface BrowserType {
  launch(options?: LaunchOptions): Promise<Browser>;
  connect(options: BrowserConnectOptions): Promise<Browser>;
  connectOverCDP(
    endpointURL: string,
    options?: ConnectOverCDPOptions
  ): Promise<Browser>;
}

export interface Browser {
  newContext(options?: BrowserContextOptions): Promise<BrowserContext>;
  version(): Promise<string>;
  close(): Promise<void>;
}

export interface APIRequestContext {
  delete(
    url: string,
    options?: APIRequestOptions
  ): Promise<APIResponse>;
  dispose(options?: { reason?: string }): Promise<void>;
  fetch(
    urlOrRequest: string | Request,
    options?: APIRequestFetchOptions
  ): Promise<APIResponse>;
  get(
    url: string,
    options?: APIRequestOptions
  ): Promise<APIResponse>;
  head(
    url: string,
    options?: APIRequestOptions
  ): Promise<APIResponse>;
  patch(
    url: string,
    options?: APIRequestOptions
  ): Promise<APIResponse>;
  post(
    url: string,
    options?: APIRequestOptions
  ): Promise<APIResponse>;
  put(
    url: string,
    options?: APIRequestOptions
  ): Promise<APIResponse>;
  storageState(options?: { indexedDB?: boolean; path?: string }): Promise<{
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
  }>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface APIRequestOptions {
  data?: string | Buffer | unknown;
  failOnStatusCode?: boolean;
  form?: { [key: string]: string | number | boolean } | FormData;
  headers?: { [key: string]: string };
  ignoreHTTPSErrors?: boolean;
  maxRedirects?: number;
  maxRetries?: number;
  multipart?:
    | FormData
    | {
        [key: string]:
          | string
          | number
          | boolean
          | ReadStream
          | FilePayload;
      };
  params?: { [key: string]: string | number | boolean } | URLSearchParams | string;
  timeout?: number;
}

export interface APIRequestFetchOptions extends APIRequestOptions {
  method?: string;
}

export interface BrowserContext {
  clock: Clock;
  request: APIRequestContext;
  newPage(): Promise<Page>;
  pages(): Page[];
  setExtraHTTPHeaders(headers: { [key: string]: string }): Promise<void>;
  storageState(options?: {
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
  }>;
  on<K extends BrowserContextEventName>(event: K, listener: BrowserContextEventListener<K>): this;
  once<K extends BrowserContextEventName>(event: K, listener: BrowserContextEventListener<K>): this;
  addListener<K extends BrowserContextEventName>(event: K, listener: BrowserContextEventListener<K>): this;
  removeListener<K extends BrowserContextEventName>(event: K, listener: BrowserContextEventListener<K>): this;
  off<K extends BrowserContextEventName>(event: K, listener: BrowserContextEventListener<K>): this;
  waitForEvent<K extends BrowserContextEventName>(
    event: K,
    optionsOrPredicate?:
      | BrowserContextEventPredicate<K>
      | {
          predicate?: BrowserContextEventPredicate<K>;
          timeout?: number;
        }
  ): Promise<import("./events.js").BrowserContextEventMap[K]>;
  close(): Promise<void>;
}

export interface Video {
  delete(): Promise<void>;
  path(): Promise<string>;
  saveAs(path: string): Promise<void>;
}

export interface FileChooser {
  element(): ElementHandle;
  isMultiple(): boolean;
  page(): Page;
  setFiles(
    files: string | FilePayload | string[] | FilePayload[],
    options?: SetInputFilesOptions
  ): Promise<void>;
}

export interface Clock {
  fastForward(ticks: number | string): Promise<void>;
  install(options?: {
    time?: number | string | Date;
  }): Promise<void>;
  pauseAt(time: number | string | Date): Promise<void>;
  resume(): Promise<void>;
  runFor(ticks: number | string): Promise<void>;
  setFixedTime(time: number | string | Date): Promise<void>;
  setSystemTime(time: number | string | Date): Promise<void>;
}

export interface Coverage {
  startCSSCoverage(options?: {
    resetOnNavigation?: boolean;
  }): Promise<void>;
  startJSCoverage(options?: {
    reportAnonymousScripts?: boolean;
    resetOnNavigation?: boolean;
  }): Promise<void>;
  stopCSSCoverage(): Promise<
    Array<{
      url: string;
      text?: string;
      ranges: Array<{
        start: number;
        end: number;
      }>;
    }>
  >;
  stopJSCoverage(): Promise<
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
  >;
}

export interface Keyboard {
  down(key: string): Promise<void>;
  insertText(text: string): Promise<void>;
  press(
    key: string,
    options?: {
      delay?: number;
    }
  ): Promise<void>;
  type(
    text: string,
    options?: {
      delay?: number;
    }
  ): Promise<void>;
  up(key: string): Promise<void>;
}

export interface Mouse {
  click(
    x: number,
    y: number,
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
      delay?: number;
    }
  ): Promise<void>;
  dblclick(
    x: number,
    y: number,
    options?: {
      button?: "left" | "right" | "middle";
      delay?: number;
    }
  ): Promise<void>;
  down(
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
    }
  ): Promise<void>;
  move(
    x: number,
    y: number,
    options?: {
      steps?: number;
    }
  ): Promise<void>;
  up(
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
    }
  ): Promise<void>;
  wheel(deltaX: number, deltaY: number): Promise<void>;
}

export interface Screencast {
  start(options?: {
    onFrame?: (frame: {
      data: Buffer;
      timestamp: number;
      viewportWidth: number;
      viewportHeight: number;
    }) => Promise<any> | any;
    path?: string;
    size?: {
      width: number;
      height: number;
    };
    quality?: number;
    annotate?: {
      duration?: number;
      position?:
        | "top-left"
        | "top"
        | "top-right"
        | "bottom-left"
        | "bottom"
        | "bottom-right";
      fontSize?: number;
    };
  }): Promise<Disposable>;
  hideActions(): Promise<void>;
  hideOverlays(): Promise<void>;
  showActions(options?: {
    cursor?: "none" | "pointer";
    duration?: number;
    fontSize?: number;
    position?:
      | "top-left"
      | "top"
      | "top-right"
      | "bottom-left"
      | "bottom"
      | "bottom-right";
  }): Promise<Disposable>;
  showChapter(
    title: string,
    options?: {
      description?: string;
      duration?: number;
    }
  ): Promise<void>;
  showOverlay(
    html: string,
    options?: {
      duration?: number;
    }
  ): Promise<Disposable>;
  showOverlays(): Promise<void>;
  stop(): Promise<void>;
}

export interface Touchscreen {
  tap(x: number, y: number): Promise<void>;
}

export interface WebStorage {
  clear(): Promise<void>;
  getItem(name: string): Promise<null | string>;
  items(): Promise<
    Array<{
      name: string;
      value: string;
    }>
  >;
  removeItem(name: string): Promise<void>;
  setItem(name: string, value: string): Promise<void>;
}

export interface Worker {
  evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg): Promise<R>;
  evaluate<R>(pageFunction: PageFunction<void, R>, arg?: any): Promise<R>;
  evaluateHandle<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg): Promise<SmartHandle<R>>;
  evaluateHandle<R>(pageFunction: PageFunction<void, R>, arg?: any): Promise<SmartHandle<R>>;
  on(event: "close", listener: (worker: Worker) => any): this;
  on(event: "console", listener: (consoleMessage: PageConsoleMessage) => any): this;
  once(event: "close", listener: (worker: Worker) => any): this;
  once(event: "console", listener: (consoleMessage: PageConsoleMessage) => any): this;
  addListener(event: "close", listener: (worker: Worker) => any): this;
  addListener(event: "console", listener: (consoleMessage: PageConsoleMessage) => any): this;
  removeListener(event: "close", listener: (worker: Worker) => any): this;
  removeListener(event: "console", listener: (consoleMessage: PageConsoleMessage) => any): this;
  off(event: "close", listener: (worker: Worker) => any): this;
  off(event: "console", listener: (consoleMessage: PageConsoleMessage) => any): this;
  prependListener(event: "close", listener: (worker: Worker) => any): this;
  prependListener(event: "console", listener: (consoleMessage: PageConsoleMessage) => any): this;
  url(): string;
  waitForEvent(
    event: "close",
    optionsOrPredicate?:
      | ((worker: Worker) => boolean | Promise<boolean>)
      | {
          predicate?: (worker: Worker) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Worker>;
  waitForEvent(
    event: "console",
    optionsOrPredicate?:
      | ((consoleMessage: PageConsoleMessage) => boolean | Promise<boolean>)
      | {
          predicate?: (consoleMessage: PageConsoleMessage) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<PageConsoleMessage>;
}

export interface BindingSource {
  context: BrowserContext;
  page: Page;
  frame: Frame;
}

export interface Dialog {
  accept(promptText?: string): Promise<void>;
  defaultValue(): string;
  dismiss(): Promise<void>;
  message(): string;
  page(): Page | null;
  type(): string;
}

export interface Download {
  cancel(): Promise<void>;
  createReadStream(): Promise<ReadStream | null>;
  delete(): Promise<void>;
  failure(): Promise<string | null>;
  page(): Page;
  path(): Promise<string>;
  saveAs(path: string): Promise<void>;
  suggestedFilename(): string;
  url(): string;
}

export interface Response {
  allHeaders(): Promise<{ [key: string]: string }>;
  body(): Promise<Buffer>;
  finished(): Promise<null | Error>;
  frame(): Frame;
  fromServiceWorker(): boolean;
  headers(): { [key: string]: string };
  headersArray(): Promise<Array<{ name: string; value: string }>>;
  headerValue(name: string): Promise<null | string>;
  headerValues(name: string): Promise<Array<string>>;
  httpVersion(): Promise<string>;
  json(): Promise<unknown>;
  ok(): boolean;
  request(): Request;
  securityDetails(): Promise<null | {
    issuer?: string;
    protocol?: string;
    subjectName?: string;
    validFrom?: number;
    validTo?: number;
  }>;
  serverAddr(): Promise<null | { ipAddress: string; port: number }>;
  status(): number;
  statusText(): string;
  text(): Promise<string>;
  url(): string;
}

export interface APIResponse {
  body(): Promise<Buffer>;
  dispose(): Promise<void>;
  headers(): { [key: string]: string };
  headersArray(): Array<{ name: string; value: string }>;
  json(): Promise<unknown>;
  ok(): boolean;
  securityDetails(): Promise<null | {
    issuer?: string;
    protocol?: string;
    subjectName?: string;
    validFrom?: number;
    validTo?: number;
  }>;
  serverAddr(): Promise<null | { ipAddress: string; port: number }>;
  status(): number;
  statusText(): string;
  text(): Promise<string>;
  url(): string;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface Request {
  allHeaders(): Promise<{ [key: string]: string }>;
  existingResponse(): Response | null;
  failure(): { errorText: string } | null;
  frame(): Frame;
  headers(): { [key: string]: string };
  headersArray(): Promise<Array<{ name: string; value: string }>>;
  headerValue(name: string): Promise<string | null>;
  isNavigationRequest(): boolean;
  method(): string;
  postData(): string | null;
  postDataBuffer(): Buffer | null;
  postDataJSON(): unknown;
  redirectedFrom(): Request | null;
  redirectedTo(): Request | null;
  resourceType(): string;
  response(): Promise<Response | null>;
  serviceWorker(): Worker | null;
  sizes(): Promise<{
    requestBodySize: number;
    requestHeadersSize: number;
    responseBodySize: number;
    responseHeadersSize: number;
  }>;
  timing(): {
    startTime: number;
    domainLookupStart: number;
    domainLookupEnd: number;
    connectStart: number;
    secureConnectionStart: number;
    connectEnd: number;
    requestStart: number;
    responseStart: number;
    responseEnd: number;
  };
  url(): string;
}

export interface Route {
  abort(errorCode?: string): Promise<void>;
  continue(options?: {
    headers?: { [key: string]: string };
    method?: string;
    postData?: string | Buffer | unknown;
    url?: string;
  }): Promise<void>;
  fallback(options?: {
    headers?: { [key: string]: string };
    method?: string;
    postData?: string | Buffer | unknown;
    url?: string;
  }): Promise<void>;
  fetch(options?: {
    headers?: { [key: string]: string };
    maxRedirects?: number;
    maxRetries?: number;
    method?: string;
    postData?: string | Buffer | unknown;
    timeout?: number;
    url?: string;
  }): Promise<APIResponse>;
  fulfill(options?: {
    body?: string | Buffer;
    contentType?: string;
    headers?: { [key: string]: string };
    json?: unknown;
    path?: string;
    response?: APIResponse | Response | PageResponse;
    status?: number;
  }): Promise<void>;
  request(): Request;
}

export interface WebSocketRoute {
  onMessage(handler: (message: string | Buffer) => any): void;
  onClose(handler: (code: number | undefined, reason: string | undefined) => any): void;
  close(options?: { code?: number; reason?: string }): Promise<void>;
  connectToServer(): WebSocketRoute;
  protocols(): Array<string>;
  send(message: string | Buffer): void;
  url(): string;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface WebSocket {
  addListener(event: "close", listener: (webSocket: WebSocket) => any): this;
  addListener(event: "framereceived", listener: (data: { payload: string | Buffer }) => any): this;
  addListener(event: "framesent", listener: (data: { payload: string | Buffer }) => any): this;
  addListener(event: "socketerror", listener: (error: string) => any): this;
  isClosed(): boolean;
  off(event: "close", listener: (webSocket: WebSocket) => any): this;
  off(event: "framereceived", listener: (data: { payload: string | Buffer }) => any): this;
  off(event: "framesent", listener: (data: { payload: string | Buffer }) => any): this;
  off(event: "socketerror", listener: (error: string) => any): this;
  on(event: "close", listener: (webSocket: WebSocket) => any): this;
  on(event: "framereceived", listener: (data: { payload: string | Buffer }) => any): this;
  on(event: "framesent", listener: (data: { payload: string | Buffer }) => any): this;
  on(event: "socketerror", listener: (error: string) => any): this;
  once(event: "close", listener: (webSocket: WebSocket) => any): this;
  once(event: "framereceived", listener: (data: { payload: string | Buffer }) => any): this;
  once(event: "framesent", listener: (data: { payload: string | Buffer }) => any): this;
  once(event: "socketerror", listener: (error: string) => any): this;
  prependListener(event: "close", listener: (webSocket: WebSocket) => any): this;
  prependListener(event: "framereceived", listener: (data: { payload: string | Buffer }) => any): this;
  prependListener(event: "framesent", listener: (data: { payload: string | Buffer }) => any): this;
  prependListener(event: "socketerror", listener: (error: string) => any): this;
  removeListener(event: "close", listener: (webSocket: WebSocket) => any): this;
  removeListener(event: "framereceived", listener: (data: { payload: string | Buffer }) => any): this;
  removeListener(event: "framesent", listener: (data: { payload: string | Buffer }) => any): this;
  removeListener(event: "socketerror", listener: (error: string) => any): this;
  url(): string;
  waitForEvent(
    event: "close",
    optionsOrPredicate?:
      | ((webSocket: WebSocket) => boolean | Promise<boolean>)
      | {
          predicate?: (webSocket: WebSocket) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<WebSocket>;
  waitForEvent(
    event: "framereceived" | "framesent",
    optionsOrPredicate?:
      | ((data: { payload: string | Buffer }) => boolean | Promise<boolean>)
      | {
          predicate?: (data: { payload: string | Buffer }) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<{ payload: string | Buffer }>;
  waitForEvent(
    event: "socketerror",
    optionsOrPredicate?:
      | ((error: string) => boolean | Promise<boolean>)
      | {
          predicate?: (error: string) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<string>;
}

export interface PageNavigationResult {
  ok(): boolean;
  url(): string;
  status(): number | null;
  statusText(): string | null;
  headers(): Header[];
}

export interface AriaRefFrameLocator {
  selector: string | null;
  xpath: string | null;
}

export interface ResolvedAriaRef {
  ref: string;
  selector: string | null;
  xpath: string | null;
  querySelector: string | null;
  querySelectorChain: string | null;
  framePath: AriaRefFrameLocator[];
  inShadowTree: boolean;
}

export interface Page {
  clock: Clock;
  coverage: Coverage;
  keyboard: Keyboard;
  localStorage: WebStorage;
  mouse: Mouse;
  request: APIRequestContext;
  screencast: Screencast;
  sessionStorage: WebStorage;
  touchscreen: Touchscreen;
  addInitScript<Arg>(script: PageFunction<Arg, any>|{ path?: string, content?: string }, arg?: Arg): Promise<Disposable>;
  addLocatorHandler(locator: Locator, handler: ((locator: Locator) => Promise<any>), options?: { noWaitAfter?: boolean; times?: number; }): Promise<void>;
  exposeBinding(name: string, playwrightBinding: (source: BindingSource, ...args: any[]) => any): Promise<Disposable>;
  exposeFunction(name: string, callback: Function): Promise<Disposable>;
  addScriptTag(options?: { content?: string; path?: string; type?: string; url?: string; }): Promise<ElementHandle>;
  addStyleTag(options?: { content?: string; path?: string; url?: string; }): Promise<ElementHandle>;
  goto(url: string, options?: { referer?: string; timeout?: number; waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"; }): Promise<null|Response>;
  url(): string;
  goBack(options?: { timeout?: number; waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"; }): Promise<null|Response>;
  goForward(options?: { timeout?: number; waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"; }): Promise<null|Response>;
  reload(options?: { timeout?: number; waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"; }): Promise<null|Response>;
  title(): Promise<string>;
  content(): Promise<string>;
  setContent(html: string, options?: { timeout?: number; waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"; }): Promise<void>;
  evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg): Promise<R>;
  evaluate<R>(pageFunction: PageFunction<void, R>, arg?: any): Promise<R>;
  evaluateHandle<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg): Promise<SmartHandle<R>>;
  evaluateHandle<R>(pageFunction: PageFunction<void, R>, arg?: any): Promise<SmartHandle<R>>;
  waitForTimeout(timeout: number): Promise<void>;
  waitForURL(url: string|RegExp|URLPattern|((url: URL) => boolean), options?: { timeout?: number; waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"; }): Promise<void>;
  waitForNavigation(options?: { timeout?: number; url?: string|RegExp|URLPattern|((url: URL) => boolean); waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"; }): Promise<null|Response>;
  waitForRequest(urlOrPredicate: string|RegExp|((request: Request) => boolean|Promise<boolean>), options?: { timeout?: number; }): Promise<Request>;
  waitForResponse(urlOrPredicate: string|RegExp|((response: Response) => boolean|Promise<boolean>), options?: { timeout?: number; }): Promise<Response>;
  waitForFunction<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg, options?: PageWaitForFunctionOptions): Promise<SmartHandle<R>>;
  waitForFunction<R>(pageFunction: PageFunction<void, R>, arg?: any, options?: PageWaitForFunctionOptions): Promise<SmartHandle<R>>;
  waitForLoadState(state?: "load"|"domcontentloaded"|"networkidle", options?: { timeout?: number; }): Promise<void>;
  waitForSelector<K extends keyof HTMLElementTagNameMap>(selector: K, options?: PageWaitForSelectorOptionsNotHidden): Promise<ElementHandleForTag<K>>;
  waitForSelector(selector: string, options?: PageWaitForSelectorOptionsNotHidden): Promise<ElementHandle<SVGElement | HTMLElement>>;
  waitForSelector<K extends keyof HTMLElementTagNameMap>(selector: K, options: PageWaitForSelectorOptions): Promise<ElementHandleForTag<K> | null>;
  waitForSelector(selector: string, options: PageWaitForSelectorOptions): Promise<null|ElementHandle<SVGElement | HTMLElement>>;
  ariaSnapshot(options?: { boxes?: boolean; depth?: number; mode?: "ai"|"default"; timeout?: number; }): Promise<string>;
  screenshot(options?: PageScreenshotOptions): Promise<Buffer>;
  context(): BrowserContext;
  consoleMessages(options?: { filter?: "all"|"since-navigation"; }): Promise<Array<ConsoleMessage>>;
  clearConsoleMessages(): Promise<void>;
  clearPageErrors(): Promise<void>;
  pageErrors(options?: { filter?: "all"|"since-navigation"; }): Promise<Array<Error>>;
  requests(): Promise<Array<Request>>;
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
  removeAllListeners(type?: string): this;
  removeAllListeners(type: string|undefined, options: { behavior?: 'wait'|'ignoreErrors'|'default' }): Promise<void>;
  waitForEvent(event: 'close', optionsOrPredicate?: { predicate?: (page: Page) => boolean | Promise<boolean>, timeout?: number } | ((page: Page) => boolean | Promise<boolean>)): Promise<Page>;
  waitForEvent(event: 'console', optionsOrPredicate?: { predicate?: (consoleMessage: ConsoleMessage) => boolean | Promise<boolean>, timeout?: number } | ((consoleMessage: ConsoleMessage) => boolean | Promise<boolean>)): Promise<ConsoleMessage>;
  waitForEvent(event: 'crash', optionsOrPredicate?: { predicate?: (page: Page) => boolean | Promise<boolean>, timeout?: number } | ((page: Page) => boolean | Promise<boolean>)): Promise<Page>;
  waitForEvent(event: 'dialog', optionsOrPredicate?: { predicate?: (dialog: Dialog) => boolean | Promise<boolean>, timeout?: number } | ((dialog: Dialog) => boolean | Promise<boolean>)): Promise<Dialog>;
  waitForEvent(event: 'domcontentloaded', optionsOrPredicate?: { predicate?: (page: Page) => boolean | Promise<boolean>, timeout?: number } | ((page: Page) => boolean | Promise<boolean>)): Promise<Page>;
  waitForEvent(event: 'download', optionsOrPredicate?: { predicate?: (download: Download) => boolean | Promise<boolean>, timeout?: number } | ((download: Download) => boolean | Promise<boolean>)): Promise<Download>;
  waitForEvent(event: 'filechooser', optionsOrPredicate?: { predicate?: (fileChooser: FileChooser) => boolean | Promise<boolean>, timeout?: number } | ((fileChooser: FileChooser) => boolean | Promise<boolean>)): Promise<FileChooser>;
  waitForEvent(event: 'frameattached', optionsOrPredicate?: { predicate?: (frame: Frame) => boolean | Promise<boolean>, timeout?: number } | ((frame: Frame) => boolean | Promise<boolean>)): Promise<Frame>;
  waitForEvent(event: 'framedetached', optionsOrPredicate?: { predicate?: (frame: Frame) => boolean | Promise<boolean>, timeout?: number } | ((frame: Frame) => boolean | Promise<boolean>)): Promise<Frame>;
  waitForEvent(event: 'framenavigated', optionsOrPredicate?: { predicate?: (frame: Frame) => boolean | Promise<boolean>, timeout?: number } | ((frame: Frame) => boolean | Promise<boolean>)): Promise<Frame>;
  waitForEvent(event: 'load', optionsOrPredicate?: { predicate?: (page: Page) => boolean | Promise<boolean>, timeout?: number } | ((page: Page) => boolean | Promise<boolean>)): Promise<Page>;
  waitForEvent(event: 'pageerror', optionsOrPredicate?: { predicate?: (error: Error) => boolean | Promise<boolean>, timeout?: number } | ((error: Error) => boolean | Promise<boolean>)): Promise<Error>;
  waitForEvent(event: 'popup', optionsOrPredicate?: { predicate?: (page: Page) => boolean | Promise<boolean>, timeout?: number } | ((page: Page) => boolean | Promise<boolean>)): Promise<Page>;
  waitForEvent(event: 'request', optionsOrPredicate?: { predicate?: (request: Request) => boolean | Promise<boolean>, timeout?: number } | ((request: Request) => boolean | Promise<boolean>)): Promise<Request>;
  waitForEvent(event: 'requestfailed', optionsOrPredicate?: { predicate?: (request: Request) => boolean | Promise<boolean>, timeout?: number } | ((request: Request) => boolean | Promise<boolean>)): Promise<Request>;
  waitForEvent(event: 'requestfinished', optionsOrPredicate?: { predicate?: (request: Request) => boolean | Promise<boolean>, timeout?: number } | ((request: Request) => boolean | Promise<boolean>)): Promise<Request>;
  waitForEvent(event: 'response', optionsOrPredicate?: { predicate?: (response: Response) => boolean | Promise<boolean>, timeout?: number } | ((response: Response) => boolean | Promise<boolean>)): Promise<Response>;
  waitForEvent(event: 'websocket', optionsOrPredicate?: { predicate?: (webSocket: WebSocket) => boolean | Promise<boolean>, timeout?: number } | ((webSocket: WebSocket) => boolean | Promise<boolean>)): Promise<WebSocket>;
  waitForEvent(event: 'worker', optionsOrPredicate?: { predicate?: (worker: Worker) => boolean | Promise<boolean>, timeout?: number } | ((worker: Worker) => boolean | Promise<boolean>)): Promise<Worker>;
  $<K extends keyof HTMLElementTagNameMap>(selector: K, options?: { strict: boolean }): Promise<ElementHandleForTag<K> | null>;
  $(selector: string, options?: { strict: boolean }): Promise<ElementHandle<SVGElement | HTMLElement> | null>;
  $$<K extends keyof HTMLElementTagNameMap>(selector: K): Promise<ElementHandleForTag<K>[]>;
  $$(selector: string): Promise<ElementHandle<SVGElement | HTMLElement>[]>;
  $eval<K extends keyof HTMLElementTagNameMap, R, Arg>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K], Arg, R>, arg: Arg): Promise<R>;
  $eval<R, Arg, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E, Arg, R>, arg: Arg): Promise<R>;
  $eval<K extends keyof HTMLElementTagNameMap, R>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K], void, R>, arg?: any): Promise<R>;
  $eval<R, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E, void, R>, arg?: any): Promise<R>;
  $$eval<K extends keyof HTMLElementTagNameMap, R, Arg>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K][], Arg, R>, arg: Arg): Promise<R>;
  $$eval<R, Arg, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E[], Arg, R>, arg: Arg): Promise<R>;
  $$eval<K extends keyof HTMLElementTagNameMap, R>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K][], void, R>, arg?: any): Promise<R>;
  $$eval<R, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E[], void, R>, arg?: any): Promise<R>;
  frameLocator(selector: string): FrameLocator;
  frame(frameSelector: string|{ name?: string; url?: string|RegExp|URLPattern|((url: URL) => boolean); }): null|Frame;
  frames(): Array<Frame>;
  mainFrame(): Frame;
  locator(selector: string, options?: {
    has?: Locator;
    hasNot?: Locator;
    hasNotText?: string|RegExp;
    hasText?: string|RegExp;
  }): Locator;
  getByText(text: string|RegExp, options?: { exact?: boolean; }): Locator;
  getByAltText(text: string|RegExp, options?: { exact?: boolean; }): Locator;
  getByLabel(text: string|RegExp, options?: { exact?: boolean; }): Locator;
  getByPlaceholder(text: string|RegExp, options?: { exact?: boolean; }): Locator;
  getByTestId(testId: string | RegExp): Locator;
  getByRole(role: "alert"|"alertdialog"|"application"|"article"|"banner"|"blockquote"|"button"|"caption"|"cell"|"checkbox"|"code"|"columnheader"|"combobox"|"complementary"|"contentinfo"|"definition"|"deletion"|"dialog"|"directory"|"document"|"emphasis"|"feed"|"figure"|"form"|"generic"|"grid"|"gridcell"|"group"|"heading"|"img"|"insertion"|"link"|"list"|"listbox"|"listitem"|"log"|"main"|"marquee"|"math"|"meter"|"menu"|"menubar"|"menuitem"|"menuitemcheckbox"|"menuitemradio"|"navigation"|"none"|"note"|"option"|"paragraph"|"presentation"|"progressbar"|"radio"|"radiogroup"|"region"|"row"|"rowgroup"|"rowheader"|"scrollbar"|"search"|"searchbox"|"separator"|"slider"|"spinbutton"|"status"|"strong"|"subscript"|"superscript"|"switch"|"tab"|"table"|"tablist"|"tabpanel"|"term"|"textbox"|"time"|"timer"|"toolbar"|"tooltip"|"tree"|"treegrid"|"treeitem", options?: { checked?: boolean; description?: string|RegExp; disabled?: boolean; exact?: boolean; expanded?: boolean; includeHidden?: boolean; level?: number; name?: string|RegExp; pressed?: boolean; selected?: boolean; }): Locator;
  getByTitle(text: string|RegExp, options?: { exact?: boolean; }): Locator;
  cancelPickLocator(): Promise<void>;
  hideHighlight(): Promise<void>;
  opener(): Promise<null|Page>;
  pause(): Promise<void>;
  pdf(options?: { displayHeaderFooter?: boolean; footerTemplate?: string; format?: string; headerTemplate?: string; height?: string|number; landscape?: boolean; margin?: { top?: string|number; right?: string|number; bottom?: string|number; left?: string|number; }; outline?: boolean; pageRanges?: string; path?: string; preferCSSPageSize?: boolean; printBackground?: boolean; scale?: number; tagged?: boolean; width?: string|number; }): Promise<Buffer>;
  pickLocator(): Promise<Locator>;
  removeLocatorHandler(locator: Locator): Promise<void>;
  route(url: string|RegExp|URLPattern|((url: URL) => boolean), handler: ((route: Route, request: Request) => Promise<any>|any), options?: { times?: number; }): Promise<Disposable>;
  routeFromHAR(har: string, options?: { notFound?: "abort"|"fallback"; update?: boolean; updateContent?: "embed"|"attach"; updateMode?: "full"|"minimal"; url?: string|RegExp; }): Promise<void>;
  routeWebSocket(url: string|RegExp|URLPattern|((url: URL) => boolean), handler: ((websocketroute: WebSocketRoute) => Promise<any>|any)): Promise<void>;
  unroute(url: string|RegExp|URLPattern|((url: URL) => boolean), handler?: ((route: Route, request: Request) => Promise<any>|any)): Promise<void>;
  unrouteAll(options?: {
    behavior?: "wait" | "ignoreErrors" | "default";
  }): Promise<void>;
  video(): null|Video;
  workers(): Array<Worker>;
  textContent(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<null|string>;
  innerText(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<string>;
  innerHTML(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<string>;
  getAttribute(selector: string, name: string, options?: { strict?: boolean; timeout?: number; }): Promise<null|string>;
  inputValue(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<string>;
  isChecked(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  isDisabled(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  isEditable(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  isEnabled(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  isHidden(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  isVisible(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  focus(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<void>;
  check(selector: string, options?: { force?: boolean; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  uncheck(selector: string, options?: { force?: boolean; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  dragAndDrop(source: string, target: string, options?: { force?: boolean; noWaitAfter?: boolean; sourcePosition?: { x: number; y: number; }; steps?: number; strict?: boolean; targetPosition?: { x: number; y: number; }; timeout?: number; trial?: boolean; }): Promise<void>;
  emulateMedia(options?: { colorScheme?: null|"light"|"dark"|"no-preference"; contrast?: null|"no-preference"|"more"; forcedColors?: null|"active"|"none"; media?: null|"screen"|"print"; reducedMotion?: null|"reduce"|"no-preference"; }): Promise<void>;
  setChecked(selector: string, checked: boolean, options?: { force?: boolean; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  setExtraHTTPHeaders(headers: { [key: string]: string; }): Promise<void>;
  setInputFiles(selector: string, files: string|ReadonlyArray<string>|{ name: string; mimeType: string; buffer: Buffer; }|ReadonlyArray<{ name: string; mimeType: string; buffer: Buffer; }>, options?: { noWaitAfter?: boolean; strict?: boolean; timeout?: number; }): Promise<void>;
  selectOption(selector: string, values: null|string|ElementHandle|ReadonlyArray<string>|{ value?: string; label?: string; index?: number; }|ReadonlyArray<ElementHandle>|ReadonlyArray<{ value?: string; label?: string; index?: number; }>, options?: { force?: boolean; noWaitAfter?: boolean; strict?: boolean; timeout?: number; }): Promise<Array<string>>;
  bringToFront(): Promise<void>;
  isClosed(): boolean;
  dispatchEvent(selector: string, type: string, eventInit?: EvaluationArgument, options?: { strict?: boolean; timeout?: number; }): Promise<void>;
  requestGC(): Promise<void>;
  setDefaultNavigationTimeout(timeout: number): void;
  setDefaultTimeout(timeout: number): void;
  setViewportSize(viewportSize: { width: number; height: number; }): Promise<void>;
  viewportSize(): null|{ width: number; height: number; };
  tap(selector: string, options?: { force?: boolean; modifiers?: Array<"Alt"|"Control"|"ControlOrMeta"|"Meta"|"Shift">; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  dblclick(selector: string, options?: { button?: "left"|"right"|"middle"; delay?: number; force?: boolean; modifiers?: Array<"Alt"|"Control"|"ControlOrMeta"|"Meta"|"Shift">; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  click(selector: string, options?: { button?: "left"|"right"|"middle"; clickCount?: number; delay?: number; force?: boolean; modifiers?: Array<"Alt"|"Control"|"ControlOrMeta"|"Meta"|"Shift">; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  hover(selector: string, options?: { force?: boolean; modifiers?: Array<"Alt"|"Control"|"ControlOrMeta"|"Meta"|"Shift">; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  fill(selector: string, value: string, options?: { force?: boolean; noWaitAfter?: boolean; strict?: boolean; timeout?: number; }): Promise<void>;
  type(selector: string, text: string, options?: { delay?: number; noWaitAfter?: boolean; strict?: boolean; timeout?: number; }): Promise<void>;
  press(selector: string, key: string, options?: { delay?: number; noWaitAfter?: boolean; strict?: boolean; timeout?: number; }): Promise<void>;
  close(options?: { reason?: string; runBeforeUnload?: boolean; }): Promise<void>;
}

export interface ElementHandle<T = Node> extends JSHandle<T> {
  $<K extends keyof HTMLElementTagNameMap>(selector: K, options?: { strict: boolean }): Promise<ElementHandleForTag<K> | null>;
  $(selector: string, options?: { strict: boolean }): Promise<ElementHandle<SVGElement | HTMLElement> | null>;
  $$<K extends keyof HTMLElementTagNameMap>(selector: K): Promise<ElementHandleForTag<K>[]>;
  $$(selector: string): Promise<ElementHandle<SVGElement | HTMLElement>[]>;
  $eval<K extends keyof HTMLElementTagNameMap, R, Arg>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K], Arg, R>, arg: Arg): Promise<R>;
  $eval<R, Arg, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E, Arg, R>, arg: Arg): Promise<R>;
  $eval<K extends keyof HTMLElementTagNameMap, R>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K], void, R>, arg?: any): Promise<R>;
  $eval<R, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E, void, R>, arg?: any): Promise<R>;
  $$eval<K extends keyof HTMLElementTagNameMap, R, Arg>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K][], Arg, R>, arg: Arg): Promise<R>;
  $$eval<R, Arg, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E[], Arg, R>, arg: Arg): Promise<R>;
  $$eval<K extends keyof HTMLElementTagNameMap, R>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K][], void, R>, arg?: any): Promise<R>;
  $$eval<R, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E[], void, R>, arg?: any): Promise<R>;
  waitForSelector<K extends keyof HTMLElementTagNameMap>(selector: K, options?: ElementHandleWaitForSelectorOptionsNotHidden): Promise<ElementHandleForTag<K>>;
  waitForSelector(selector: string, options?: ElementHandleWaitForSelectorOptionsNotHidden): Promise<ElementHandle<SVGElement | HTMLElement>>;
  waitForSelector<K extends keyof HTMLElementTagNameMap>(selector: K, options: ElementHandleWaitForSelectorOptions): Promise<ElementHandleForTag<K> | null>;
  waitForSelector(selector: string, options: ElementHandleWaitForSelectorOptions): Promise<null|ElementHandle<SVGElement | HTMLElement>>;
  contentFrame(): Promise<null|Frame>;
  ownerFrame(): Promise<null|Frame>;
  boundingBox(): Promise<null|{ x: number; y: number; width: number; height: number; }>;
  dispatchEvent(type: string, eventInit?: unknown): Promise<void>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  scrollIntoViewIfNeeded(options?: { timeout?: number; }): Promise<void>;
  selectText(options?: { force?: boolean; timeout?: number; }): Promise<void>;
  tap(options?: TapOptions): Promise<void>;
  waitForElementState(state: "visible"|"hidden"|"stable"|"enabled"|"disabled"|"editable", options?: { timeout?: number; }): Promise<void>;
  click(options?: ClickOptions): Promise<void>;
  hover(options?: HoverOptions): Promise<void>;
  fill(value: string, options?: FillOptions): Promise<void>;
  type(value: string, options?: TypeOptions): Promise<void>;
  press(key: string, options?: PressOptions): Promise<void>;
  textContent(): Promise<null|string>;
  innerText(): Promise<string>;
  innerHTML(): Promise<string>;
  getAttribute(name: string): Promise<null|string>;
  inputValue(options?: { timeout?: number; }): Promise<string>;
  isChecked(): Promise<boolean>;
  isDisabled(): Promise<boolean>;
  isEditable(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  isHidden(): Promise<boolean>;
  isVisible(): Promise<boolean>;
  focus(): Promise<void>;
  check(options?: ClickOptions): Promise<void>;
  setChecked(checked: boolean, options?: ClickOptions): Promise<void>;
  uncheck(options?: ClickOptions): Promise<void>;
  selectOption(
    values:
      | null
      | string
      | ElementHandle
      | ReadonlyArray<string>
      | SelectOptionValue
      | ReadonlyArray<ElementHandle>
      | ReadonlyArray<SelectOptionValue>,
    options?: { force?: boolean; noWaitAfter?: boolean; timeout?: number }
  ): Promise<Array<string>>;
  setInputFiles(
    files: string | FilePayload | string[] | FilePayload[],
    options?: SetInputFilesOptions
  ): Promise<void>;
  dblclick(options?: ClickOptions): Promise<void>;
}

export interface JSHandle<T = unknown> extends Disposable {
  evaluate<R, Arg, O extends T = T>(pageFunction: PageFunctionOn<O, Arg, R>, arg: Arg): Promise<R>;
  evaluate<R, O extends T = T>(pageFunction: PageFunctionOn<O, void, R>, arg?: any): Promise<R>;
  evaluateHandle<R, Arg, O extends T = T>(pageFunction: PageFunctionOn<O, Arg, R>, arg: Arg): Promise<SmartHandle<R>>;
  evaluateHandle<R, O extends T = T>(pageFunction: PageFunctionOn<O, void, R>, arg?: any): Promise<SmartHandle<R>>;
  jsonValue(): Promise<T>;
  asElement(): T extends Node ? ElementHandle<T> : null;
  dispose(): Promise<void>;
  getProperties(): Promise<Map<string, JSHandle>>;
  getProperty(propertyName: string): Promise<JSHandle>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface Locator {
  _roxySelectorChain?(): LocatorSelector[] | null;
  page(): Page;
  locator(selectorOrLocator: string|Locator, options?: {
    has?: Locator;
    hasNot?: Locator;
    hasNotText?: string|RegExp;
    hasText?: string|RegExp;
  }): Locator;
  frameLocator(selector: string): FrameLocator;
  contentFrame(): FrameLocator;
  getByText(text: string | RegExp, options?: GetByTextOptions): Locator;
  getByAltText(text: string | RegExp, options?: GetByAltTextOptions): Locator;
  getByLabel(text: string | RegExp, options?: GetByLabelOptions): Locator;
  getByPlaceholder(text: string | RegExp, options?: GetByPlaceholderOptions): Locator;
  getByTestId(testId: string | RegExp): Locator;
  getByRole(role: string, options?: GetByRoleOptions): Locator;
  getByTitle(text: string | RegExp, options?: GetByTitleOptions): Locator;
  filter(options?: {
    has?: Locator;
    hasNot?: Locator;
    hasNotText?: string | RegExp;
    hasText?: string | RegExp;
    visible?: boolean;
  }): Locator;
  and(locator: Locator): Locator;
  or(locator: Locator): Locator;
  describe(description: string): Locator;
  description(): string | null;
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
  all(): Promise<Locator[]>;
  allInnerTexts(): Promise<string[]>;
  allTextContents(): Promise<string[]>;
  count(): Promise<number>;
  evaluate<R, Arg>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, Arg, R>,
    arg: Arg,
    options?: TimeoutOptions
  ): Promise<R>;
  evaluate<R>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, void, R>,
    options?: TimeoutOptions
  ): Promise<R>;
  evaluateAll<R, Arg>(
    pageFunction: PageFunctionOn<Element[], Arg, R>,
    arg: Arg
  ): Promise<R>;
  evaluateAll<R>(
    pageFunction: PageFunctionOn<Element[], void, R>
  ): Promise<R>;
  evaluateHandle<R, Arg>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, Arg, R>,
    arg: Arg,
    options?: TimeoutOptions
  ): Promise<SmartHandle<R>>;
  evaluateHandle<R>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, void, R>,
    options?: TimeoutOptions
  ): Promise<SmartHandle<R>>;
  boundingBox(options?: TimeoutOptions): Promise<Rect | null>;
  dblclick(options?: ClickOptions): Promise<void>;
  check(options?: ClickOptions): Promise<void>;
  clear(options?: FillOptions): Promise<void>;
  click(options?: ClickOptions): Promise<void>;
  dispatchEvent(type: string, eventInit?: unknown, options?: DispatchEventOptions): Promise<void>;
  dragTo(target: Locator, options?: DragAndDropOptions): Promise<void>;
  drop(payload: unknown, options?: TimeoutOptions): Promise<void>;
  hover(options?: HoverOptions): Promise<void>;
  fill(value: string, options?: FillOptions): Promise<void>;
  type(value: string, options?: TypeOptions): Promise<void>;
  pressSequentially(text: string, options?: TypeOptions): Promise<void>;
  press(key: string, options?: PressOptions): Promise<void>;
  focus(options?: TimeoutOptions): Promise<void>;
  blur(options?: TimeoutOptions): Promise<void>;
  getAttribute(name: string, options?: TimeoutOptions): Promise<string | null>;
  highlight(options?: { style?: string | Record<string, string | number> }): Promise<Disposable>;
  hideHighlight(): Promise<void>;
  innerHTML(options?: TimeoutOptions): Promise<string>;
  innerText(options?: TimeoutOptions): Promise<string>;
  inputValue(options?: TimeoutOptions): Promise<string>;
  isChecked(options?: TimeoutOptions): Promise<boolean>;
  isDisabled(options?: TimeoutOptions): Promise<boolean>;
  isEditable(options?: TimeoutOptions): Promise<boolean>;
  isEnabled(options?: TimeoutOptions): Promise<boolean>;
  isHidden(options?: TimeoutOptions): Promise<boolean>;
  ariaSnapshot(options?: AriaSnapshotOptions): Promise<string>;
  normalize(): Promise<Locator>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  scrollIntoViewIfNeeded(options?: { timeout?: number; }): Promise<void>;
  selectOption(
    values:
      | null
      | string
      | ElementHandle
      | ReadonlyArray<string>
      | SelectOptionValue
      | ReadonlyArray<ElementHandle>
      | ReadonlyArray<SelectOptionValue>,
    options?: { force?: boolean; noWaitAfter?: boolean; timeout?: number }
  ): Promise<Array<string>>;
  selectText(options?: { force?: boolean; timeout?: number; }): Promise<void>;
  setChecked(checked: boolean, options?: ClickOptions): Promise<void>;
  setInputFiles(
    files: string | FilePayload | string[] | FilePayload[],
    options?: SetInputFilesOptions
  ): Promise<void>;
  tap(options?: TapOptions): Promise<void>;
  textContent(options?: TimeoutOptions): Promise<string | null>;
  uncheck(options?: ClickOptions): Promise<void>;
  isVisible(options?: TimeoutOptions): Promise<boolean>;
  waitFor(options?: WaitForSelectorOptions): Promise<void>;
  elementHandle(options?: { timeout?: number }): Promise<ElementHandle | null>;
  elementHandles(): Promise<ElementHandle[]>;
  toString(): string;
}

export interface FrameLocator {
  first(): FrameLocator;
  last(): FrameLocator;
  nth(index: number): FrameLocator;
  frameLocator(selector: string): FrameLocator;
  locator(selectorOrLocator: string|Locator, options?: {
    has?: Locator;
    hasNot?: Locator;
    hasNotText?: string|RegExp;
    hasText?: string|RegExp;
  }): Locator;
  getByText(text: string | RegExp, options?: GetByTextOptions): Locator;
  getByAltText(text: string | RegExp, options?: GetByAltTextOptions): Locator;
  getByLabel(text: string | RegExp, options?: GetByLabelOptions): Locator;
  getByPlaceholder(text: string | RegExp, options?: GetByPlaceholderOptions): Locator;
  getByTestId(testId: string | RegExp): Locator;
  getByRole(role: string, options?: GetByRoleOptions): Locator;
  getByTitle(text: string | RegExp, options?: GetByTitleOptions): Locator;
  owner(): Locator;
}

export interface Frame {
  page(): Page;
  parentFrame(): null|Frame;
  childFrames(): Array<Frame>;
  isDetached(): boolean;
  url(): string;
  name(): string;
  goto(url: string, options?: PageGotoOptions): Promise<Response | null>;
  setContent(html: string, options?: PageSetContentOptions): Promise<void>;
  title(): Promise<string>;
  evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg): Promise<R>;
  evaluate<R>(pageFunction: PageFunction<void, R>, arg?: any): Promise<R>;
  evaluateHandle<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg): Promise<SmartHandle<R>>;
  evaluateHandle<R>(pageFunction: PageFunction<void, R>, arg?: any): Promise<SmartHandle<R>>;
  waitForFunction<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg, options?: PageWaitForFunctionOptions): Promise<SmartHandle<R>>;
  waitForFunction<R>(pageFunction: PageFunction<void, R>, arg?: any, options?: PageWaitForFunctionOptions): Promise<SmartHandle<R>>;
  waitForURL(
    url: string | RegExp | URLPattern | ((url: URL) => boolean),
    options?: WaitForURLOptions
  ): Promise<void>;
  waitForNavigation(options?: WaitForNavigationOptions): Promise<Response | null>;
  waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number }
  ): Promise<void>;
  waitForTimeout(timeout: number): Promise<void>;
  waitForSelector<K extends keyof HTMLElementTagNameMap>(selector: K, options?: PageWaitForSelectorOptionsNotHidden): Promise<ElementHandleForTag<K>>;
  waitForSelector(selector: string, options?: PageWaitForSelectorOptionsNotHidden): Promise<ElementHandle<SVGElement | HTMLElement>>;
  waitForSelector<K extends keyof HTMLElementTagNameMap>(selector: K, options: PageWaitForSelectorOptions): Promise<ElementHandleForTag<K> | null>;
  waitForSelector(selector: string, options: PageWaitForSelectorOptions): Promise<null|ElementHandle<SVGElement | HTMLElement>>;
  $<K extends keyof HTMLElementTagNameMap>(selector: K, options?: { strict: boolean }): Promise<ElementHandleForTag<K> | null>;
  $(selector: string, options?: { strict: boolean }): Promise<ElementHandle<SVGElement | HTMLElement> | null>;
  $$<K extends keyof HTMLElementTagNameMap>(selector: K): Promise<ElementHandleForTag<K>[]>;
  $$(selector: string): Promise<ElementHandle<SVGElement | HTMLElement>[]>;
  $eval<K extends keyof HTMLElementTagNameMap, R, Arg>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K], Arg, R>, arg: Arg): Promise<R>;
  $eval<R, Arg, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E, Arg, R>, arg: Arg): Promise<R>;
  $eval<K extends keyof HTMLElementTagNameMap, R>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K], void, R>, arg?: any): Promise<R>;
  $eval<R, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E, void, R>, arg?: any): Promise<R>;
  $$eval<K extends keyof HTMLElementTagNameMap, R, Arg>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K][], Arg, R>, arg: Arg): Promise<R>;
  $$eval<R, Arg, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E[], Arg, R>, arg: Arg): Promise<R>;
  $$eval<K extends keyof HTMLElementTagNameMap, R>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K][], void, R>, arg?: any): Promise<R>;
  $$eval<R, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E[], void, R>, arg?: any): Promise<R>;
  locator(selector: string, options?: {
    has?: Locator;
    hasNot?: Locator;
    hasNotText?: string|RegExp;
    hasText?: string|RegExp;
  }): Locator;
  frameLocator(selector: string): FrameLocator;
  getByText(text: string | RegExp, options?: GetByTextOptions): Locator;
  getByAltText(text: string | RegExp, options?: GetByAltTextOptions): Locator;
  getByLabel(text: string | RegExp, options?: GetByLabelOptions): Locator;
  getByPlaceholder(text: string | RegExp, options?: GetByPlaceholderOptions): Locator;
  getByTestId(testId: string | RegExp): Locator;
  getByRole(role: string, options?: GetByRoleOptions): Locator;
  getByTitle(text: string | RegExp, options?: GetByTitleOptions): Locator;
  content(): Promise<string>;
  addScriptTag(options?: { content?: string; path?: string; type?: string; url?: string; }): Promise<ElementHandle>;
  addStyleTag(options?: { content?: string; path?: string; url?: string; }): Promise<ElementHandle>;
  dispatchEvent(selector: string, type: string, eventInit?: EvaluationArgument, options?: { strict?: boolean; timeout?: number; }): Promise<void>;
  dragAndDrop(source: string, target: string, options?: { force?: boolean; noWaitAfter?: boolean; sourcePosition?: { x: number; y: number; }; steps?: number; strict?: boolean; targetPosition?: { x: number; y: number; }; timeout?: number; trial?: boolean; }): Promise<void>;
  textContent(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<null|string>;
  innerText(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<string>;
  innerHTML(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<string>;
  getAttribute(selector: string, name: string, options?: { strict?: boolean; timeout?: number; }): Promise<null|string>;
  inputValue(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<string>;
  isChecked(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  isDisabled(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  isEditable(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  isEnabled(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  isHidden(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  isVisible(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<boolean>;
  focus(selector: string, options?: { strict?: boolean; timeout?: number; }): Promise<void>;
  check(selector: string, options?: { force?: boolean; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  click(selector: string, options?: { button?: "left"|"right"|"middle"; clickCount?: number; delay?: number; force?: boolean; modifiers?: Array<"Alt"|"Control"|"ControlOrMeta"|"Meta"|"Shift">; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  dblclick(selector: string, options?: { button?: "left"|"right"|"middle"; delay?: number; force?: boolean; modifiers?: Array<"Alt"|"Control"|"ControlOrMeta"|"Meta"|"Shift">; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  fill(selector: string, value: string, options?: { force?: boolean; noWaitAfter?: boolean; strict?: boolean; timeout?: number; }): Promise<void>;
  hover(selector: string, options?: { force?: boolean; modifiers?: Array<"Alt"|"Control"|"ControlOrMeta"|"Meta"|"Shift">; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  press(selector: string, key: string, options?: { delay?: number; noWaitAfter?: boolean; strict?: boolean; timeout?: number; }): Promise<void>;
  selectOption(selector: string, values: null|string|ElementHandle|ReadonlyArray<string>|{ value?: string; label?: string; index?: number; }|ReadonlyArray<ElementHandle>|ReadonlyArray<{ value?: string; label?: string; index?: number; }>, options?: { force?: boolean; noWaitAfter?: boolean; strict?: boolean; timeout?: number; }): Promise<Array<string>>;
  setInputFiles(selector: string, files: string|ReadonlyArray<string>|{ name: string; mimeType: string; buffer: Buffer; }|ReadonlyArray<{ name: string; mimeType: string; buffer: Buffer; }>, options?: { noWaitAfter?: boolean; strict?: boolean; timeout?: number; }): Promise<void>;
  setChecked(selector: string, checked: boolean, options?: { force?: boolean; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  tap(selector: string, options?: { force?: boolean; modifiers?: Array<"Alt"|"Control"|"ControlOrMeta"|"Meta"|"Shift">; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
  type(selector: string, text: string, options?: { delay?: number; noWaitAfter?: boolean; strict?: boolean; timeout?: number; }): Promise<void>;
  uncheck(selector: string, options?: { force?: boolean; noWaitAfter?: boolean; position?: { x: number; y: number; }; strict?: boolean; timeout?: number; trial?: boolean; }): Promise<void>;
}
