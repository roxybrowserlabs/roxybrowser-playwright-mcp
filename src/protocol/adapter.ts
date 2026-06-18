import type {
  AddScriptTagOptions,
  AddStyleTagOptions,
  AriaSnapshotOptions,
  BrowserConnectOptions,
  BrowserContextOptions,
  ClickOptions,
  DispatchEventOptions,
  FillOptions,
  GetByAltTextOptions,
  GetByLabelOptions,
  GetByPlaceholderOptions,
  GetByRoleOptions,
  GetByTextOptions,
  GetByTitleOptions,
  HoverOptions,
  LoadState,
  LaunchOptions,
  PageCloseOptions,
  PageGotoOptions,
  PageSetContentOptions,
  PdfOptions,
  PressOptions,
  Rect,
  SelectOptionValue,
  ScreenshotOptions,
  TapOptions,
  TypeOptions,
  ViewportSize,
  WaitForSelectorOptions
} from "../types/options.js";
import type {
  RawPageEventListener,
  RawPageEventName,
  PageResponse
} from "../types/events.js";
import type { Disposable, ResolvedAriaRef } from "../types/api.js";
import type { ProtocolCapabilities } from "./capabilities.js";
import type { RoutedRequestCall, RoutedRequestDecision } from "./routing.js";
import type { SerializedValue } from "../utilityScriptSerializers.js";

export type LocatorStrategy = "control" | "css" | "text" | "role" | "xpath";
export type ScreenshotClipOrigin = "document" | "viewport";

export interface LocatorSelector {
  strategy: LocatorStrategy;
  value: string;
  capture?: boolean;
  exact?: boolean;
  name?: string;
  label?: string;
  isRegex?: boolean;
  regexFlags?: string;
  nameIsRegex?: boolean;
  nameRegexFlags?: string;
  labelIsRegex?: boolean;
  labelRegexFlags?: string;
}

export type LocatorPick =
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "nth"; index: number };

export interface ProtocolElementHandleReference {
  chain: LocatorSelector[];
  handleId?: string;
  pick?: LocatorPick;
  protocolFrameId?: string;
  protocolObjectId?: string;
  protocolSessionId?: string;
  scope?: ProtocolElementHandleReference;
}

export interface ProtocolBrowserAdapterFactory {
  create(options: BrowserConnectOptions): ProtocolBrowserAdapter;
}

export interface ProtocolBrowserAdapter {
  readonly protocol: BrowserConnectOptions["protocol"];
  readonly capabilities: ProtocolCapabilities;
  connect(): Promise<void>;
  browser(): Promise<ProtocolBrowserSession>;
  close(): Promise<void>;
}

export interface ProtocolBrowserSession {
  version(): Promise<string>;
  newContext(options?: BrowserContextOptions): Promise<ProtocolBrowserContextAdapter>;
  close(): Promise<void>;
}

export interface ProtocolBrowserContextAdapter {
  newPage(): Promise<ProtocolPageAdapter>;
  onPage?(
    listener: (
      page: ProtocolPageAdapter,
      opener?: ProtocolPageAdapter | null,
      hasWindowOpener?: boolean
    ) => void | Promise<void>
  ): () => void;
  setExtraHTTPHeaders(headers: { [key: string]: string }): Promise<void>;
  close(): Promise<void>;
}

export interface ProtocolPageAdapter {
  goto(url: string, options?: PageGotoOptions): Promise<PageResponse | null>;
  url(): string;
  goBack(options?: PageGotoOptions): Promise<PageResponse | null>;
  goForward(options?: PageGotoOptions): Promise<PageResponse | null>;
  reload(options?: PageGotoOptions): Promise<PageResponse | null>;
  title(): Promise<string>;
  content(): Promise<string>;
  setContent(html: string, options?: PageSetContentOptions): Promise<void>;
  addInitScript(source: string, arg?: unknown): Promise<Disposable>;
  evaluate<TResult>(expression: string, arg?: unknown, isFunction?: boolean): Promise<TResult>;
  evaluateHandle?<TResult>(
    expression: string,
    arg?: unknown,
    isFunction?: boolean
  ): Promise<ProtocolJSHandleAdapter<TResult>>;
  evaluateInFrame?<TResult>(
    frameId: string,
    expression: string,
    arg?: unknown,
    isFunction?: boolean
  ): Promise<TResult>;
  evaluateHandleInFrame?<TResult>(
    frameId: string,
    expression: string,
    arg?: unknown,
    isFunction?: boolean
  ): Promise<ProtocolJSHandleAdapter<TResult>>;
  frameSnapshots?(): Promise<Array<{
    id: string;
    name: string;
    nativeFrameId?: string;
    ownerElementChain: LocatorSelector[];
    parentId: string | null;
    referenceChain: LocatorSelector[];
    url: string;
  }>>;
  addScriptTag(options?: AddScriptTagOptions): Promise<ProtocolElementHandleAdapter>;
  addStyleTag(options?: AddStyleTagOptions): Promise<ProtocolElementHandleAdapter>;
  waitForLoadState(state?: LoadState | "commit", timeout?: number): Promise<void>;
  waitForNavigationResponse?(options?: {
    initialUrl?: string;
    signal?: AbortSignal;
    timeout?: number;
    url?: string | RegExp | ((url: URL) => boolean);
  }): Promise<PageResponse | null>;
  ariaSnapshot(options?: AriaSnapshotOptions): Promise<string>;
  resolveAriaRef(ref: string): Promise<ResolvedAriaRef>;
  setExtraHTTPHeaders(headers: { [key: string]: string }): Promise<void>;
  setScreenshotBackgroundColor?(color?: { a: number; b: number; g: number; r: number }): Promise<void>;
  screenshotClipOrigin?(): ScreenshotClipOrigin;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  pdf(options?: PdfOptions): Promise<Buffer>;
  viewportSize(): ViewportSize | null;
  setViewportSize(viewportSize: ViewportSize): Promise<void>;
  dispatchEvent(selector: LocatorSelector[], type: string, eventInit?: unknown, options?: DispatchEventOptions): Promise<void>;
  requestGC(): Promise<void>;
  textContent(selector: LocatorSelector[]): Promise<string | null>;
  innerText(selector: LocatorSelector[]): Promise<string>;
  innerHTML(selector: LocatorSelector[]): Promise<string>;
  getAttribute(selector: LocatorSelector[], name: string): Promise<string | null>;
  inputValue(selector: LocatorSelector[]): Promise<string>;
  isChecked(selector: LocatorSelector[]): Promise<boolean>;
  isDisabled(selector: LocatorSelector[]): Promise<boolean>;
  isEditable(selector: LocatorSelector[]): Promise<boolean>;
  isEnabled(selector: LocatorSelector[]): Promise<boolean>;
  focus(selector: LocatorSelector[]): Promise<void>;
  setChecked(selector: LocatorSelector[], checked: boolean, options?: ClickOptions): Promise<void>;
  selectOption(
    selector: LocatorSelector[],
    values: string | SelectOptionValue | Array<string | SelectOptionValue>
  ): Promise<string[]>;
  bringToFront(): Promise<void>;
  isClosed(): boolean;
  on<K extends RawPageEventName>(event: K, listener: RawPageEventListener<K>): () => void;
  setRequestInterceptor?(
    handler: ((call: RoutedRequestCall) => Promise<RoutedRequestDecision>) | null
  ): Promise<void>;
  createHandle(reference: ProtocolElementHandleReference): ProtocolElementHandleAdapter;
  createHandleReference(
    reference: ProtocolElementHandleReference,
    missingMessage?: string
  ): Promise<ProtocolElementHandleReference>;
  evaluateOnReference<TResult>(
    reference: ProtocolElementHandleReference,
    expression: string,
    arg?: unknown,
    missingMessage?: string,
    isFunction?: boolean
  ): Promise<TResult>;
  evaluateOnReferenceAll<TResult>(
    reference: ProtocolElementHandleReference,
    expression: string,
    arg?: unknown,
    isFunction?: boolean
  ): Promise<TResult>;
  query(selector: LocatorSelector[]): Promise<ProtocolElementHandleAdapter | null>;
  queryAll(selector: LocatorSelector[]): Promise<ProtocolElementHandleAdapter[]>;
  evalOnSelector<TResult>(
    selector: LocatorSelector[],
    expression: string,
    isFunction?: boolean,
    arg?: unknown
  ): Promise<TResult>;
  evalOnSelectorAll<TResult>(
    selector: LocatorSelector[],
    expression: string,
    isFunction?: boolean,
    arg?: unknown
  ): Promise<TResult>;
  locator(selector: LocatorSelector): ProtocolLocatorAdapter;
  locatorInFrame?(frameId: string, selector: LocatorSelector): ProtocolLocatorAdapter;
  getByText(text: string | RegExp, options?: GetByTextOptions): ProtocolLocatorAdapter;
  getByAltText(text: string | RegExp, options?: GetByAltTextOptions): ProtocolLocatorAdapter;
  getByLabel(text: string | RegExp, options?: GetByLabelOptions): ProtocolLocatorAdapter;
  getByPlaceholder(
    text: string | RegExp,
    options?: GetByPlaceholderOptions
  ): ProtocolLocatorAdapter;
  getByTestId(testId: string | RegExp): ProtocolLocatorAdapter;
  getByRole(role: string, options?: GetByRoleOptions): ProtocolLocatorAdapter;
  getByTitle(text: string | RegExp, options?: GetByTitleOptions): ProtocolLocatorAdapter;
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
  screencastStart(options?: {
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
  }): Promise<void>;
  screencastStop(): Promise<void>;
  screencastShowActions(options?: {
    duration?: number;
    position?: "top-left" | "top" | "top-right" | "bottom-left" | "bottom" | "bottom-right";
    fontSize?: number;
    cursor?: "none" | "pointer";
  }): Promise<void>;
  screencastHideActions(): Promise<void>;
  screencastShowOverlay(options: {
    html: string;
    duration?: number;
  }): Promise<{ id: string }>;
  screencastRemoveOverlay(id: string): Promise<void>;
  screencastChapter(options: {
    title: string;
    description?: string;
    duration?: number;
  }): Promise<void>;
  screencastSetOverlayVisible(visible: boolean): Promise<void>;
  keyboardDown(key: string): Promise<void>;
  keyboardInsertText(text: string): Promise<void>;
  keyboardPress(
    key: string,
    options?: {
      delay?: number;
    }
  ): Promise<void>;
  keyboardType(
    text: string,
    options?: {
      delay?: number;
    }
  ): Promise<void>;
  keyboardUp(key: string): Promise<void>;
  mouseClick(
    x: number,
    y: number,
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
      delay?: number;
    }
  ): Promise<void>;
  mouseDblclick(
    x: number,
    y: number,
    options?: {
      button?: "left" | "right" | "middle";
      delay?: number;
    }
  ): Promise<void>;
  mouseDown(
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
    }
  ): Promise<void>;
  mouseMove(
    x: number,
    y: number,
    options?: {
      steps?: number;
    }
  ): Promise<void>;
  mouseUp(
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
    }
  ): Promise<void>;
  mouseWheel(deltaX: number, deltaY: number): Promise<void>;
  touchscreenTap(x: number, y: number): Promise<void>;
  tap(selector: LocatorSelector[], options?: TapOptions): Promise<void>;
  close(options?: PageCloseOptions): Promise<void>;
}

export interface ProtocolJSHandleAdapter<T = unknown> extends Disposable {
  evaluate<TResult>(expression: string, arg?: unknown, isFunction?: boolean): Promise<TResult>;
  evaluateHandle?<TResult>(
    expression: string,
    arg?: unknown,
    isFunction?: boolean
  ): Promise<ProtocolJSHandleAdapter<TResult>>;
  jsonValue(): Promise<T>;
  getProperties(): Promise<Map<string, ProtocolJSHandleAdapter>>;
  getProperty(propertyName: string): Promise<ProtocolJSHandleAdapter>;
  preview(): string;
  rawValue(): T | undefined;
  serializedValue(): SerializedValue | undefined;
  remoteObjectId(): string | undefined;
  asElementReference?(): Promise<ProtocolElementHandleReference | null>;
}

export interface ProtocolElementHandleAdapter {
  reference(): ProtocolElementHandleReference;
  query(selector: LocatorSelector[]): Promise<ProtocolElementHandleAdapter | null>;
  queryAll(selector: LocatorSelector[]): Promise<ProtocolElementHandleAdapter[]>;
  evalOnSelector<TResult>(
    selector: LocatorSelector[],
    expression: string,
    isFunction?: boolean,
    arg?: unknown
  ): Promise<TResult>;
  evalOnSelectorAll<TResult>(
    selector: LocatorSelector[],
    expression: string,
    isFunction?: boolean,
    arg?: unknown
  ): Promise<TResult>;
  evaluate<TResult>(expression: string, arg?: unknown): Promise<TResult>;
  evaluateHandle?<TResult>(
    expression: string,
    arg?: unknown,
    isFunction?: boolean
  ): Promise<ProtocolJSHandleAdapter<TResult>>;
  contentFrameId?(): Promise<string | null>;
  ownerFrameId?(): Promise<string | null>;
  boundingBox(): Promise<Rect | null>;
  dispatchEvent(type: string, eventInit?: unknown): Promise<void>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  scrollIntoViewIfNeeded(): Promise<void>;
  selectText(): Promise<void>;
  tap(options?: TapOptions): Promise<void>;
  click(options?: ClickOptions): Promise<void>;
  dblclick(options?: ClickOptions): Promise<void>;
  check(options?: ClickOptions): Promise<void>;
  hover(options?: HoverOptions): Promise<void>;
  fill(value: string, options?: FillOptions): Promise<void>;
  type(value: string, options?: TypeOptions): Promise<void>;
  press(key: string, options?: PressOptions): Promise<void>;
  textContent(): Promise<string | null>;
  innerText(): Promise<string>;
  innerHTML(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  inputValue(): Promise<string>;
  isChecked(): Promise<boolean>;
  isDisabled(): Promise<boolean>;
  isEditable(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  isHidden(): Promise<boolean>;
  isVisible(): Promise<boolean>;
  focus(): Promise<void>;
  uncheck(options?: ClickOptions): Promise<void>;
  selectOption(values: string | SelectOptionValue | Array<string | SelectOptionValue>): Promise<string[]>;
}

export interface ProtocolLocatorAdapter {
  locator(selector: LocatorSelector): ProtocolLocatorAdapter;
  getByText(text: string | RegExp, options?: GetByTextOptions): ProtocolLocatorAdapter;
  getByAltText(text: string | RegExp, options?: GetByAltTextOptions): ProtocolLocatorAdapter;
  getByLabel(text: string | RegExp, options?: GetByLabelOptions): ProtocolLocatorAdapter;
  getByPlaceholder(
    text: string | RegExp,
    options?: GetByPlaceholderOptions
  ): ProtocolLocatorAdapter;
  getByTestId(testId: string | RegExp): ProtocolLocatorAdapter;
  getByRole(role: string, options?: GetByRoleOptions): ProtocolLocatorAdapter;
  getByTitle(text: string | RegExp, options?: GetByTitleOptions): ProtocolLocatorAdapter;
  first(): ProtocolLocatorAdapter;
  last(): ProtocolLocatorAdapter;
  nth(index: number): ProtocolLocatorAdapter;
  dblclick(options?: ClickOptions): Promise<void>;
  check(options?: ClickOptions): Promise<void>;
  click(options?: ClickOptions): Promise<void>;
  hover(options?: HoverOptions): Promise<void>;
  fill(value: string, options?: FillOptions): Promise<void>;
  type(value: string, options?: TypeOptions): Promise<void>;
  press(key: string, options?: PressOptions): Promise<void>;
  focus(): Promise<void>;
  blur(): Promise<void>;
  count(): Promise<number>;
  dispatchEvent(type: string, eventInit?: unknown, options?: DispatchEventOptions): Promise<void>;
  evaluate<TResult>(expression: string, arg?: unknown, isFunction?: boolean): Promise<TResult>;
  evaluateAll<TResult>(expression: string, arg?: unknown, isFunction?: boolean): Promise<TResult>;
  evaluateHandle?<TResult>(
    expression: string,
    arg?: unknown,
    isFunction?: boolean
  ): Promise<ProtocolJSHandleAdapter<TResult>>;
  boundingBox(): Promise<Rect | null>;
  getAttribute(name: string): Promise<string | null>;
  innerHTML(): Promise<string>;
  innerText(): Promise<string>;
  inputValue(): Promise<string>;
  isChecked(): Promise<boolean>;
  isDisabled(): Promise<boolean>;
  isEditable(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  isHidden(): Promise<boolean>;
  selectOption(values: string | SelectOptionValue | Array<string | SelectOptionValue>): Promise<string[]>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  scrollIntoViewIfNeeded(): Promise<void>;
  selectText(): Promise<void>;
  tap(options?: TapOptions): Promise<void>;
  textContent(): Promise<string | null>;
  uncheck(options?: ClickOptions): Promise<void>;
  isVisible(): Promise<boolean>;
  elementHandle(): Promise<ProtocolElementHandleAdapter>;
  elementHandles(): Promise<ProtocolElementHandleAdapter[]>;
}
