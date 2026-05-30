import type {
  AriaSnapshotOptions,
  BrowserContextOptions,
  ClickOptions,
  ConnectOverCDPOptions,
  FillOptions,
  Header,
  GetByRoleOptions,
  GetByTextOptions,
  HoverOptions,
  LaunchOptions,
  PageGotoOptions,
  PressOptions,
  ScreenshotOptions,
  TypeOptions,
  WaitForSelectorOptions
} from "./options.js";
import type {
  PageEventListener,
  PageEventMap,
  PageEventName,
  PageEventPredicate,
  PageResponse
} from "./events.js";

export interface BrowserType {
  launch(options?: LaunchOptions): Promise<Browser>;
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

export interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
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
  goto(url: string, options?: PageGotoOptions): Promise<PageResponse | null>;
  url(): Promise<string>;
  goBack(options?: PageGotoOptions): Promise<PageNavigationResult | null>;
  goForward(options?: PageGotoOptions): Promise<PageNavigationResult | null>;
  reload(options?: PageGotoOptions): Promise<PageResponse | null>;
  title(): Promise<string>;
  content(): Promise<string>;
  setContent(html: string): Promise<void>;
  evaluate<TResult>(expression: string, arg?: unknown): Promise<TResult>;
  waitForLoadState(state?: PageGotoOptions["waitUntil"]): Promise<void>;
  waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<Locator | null>;
  ariaSnapshot(options?: AriaSnapshotOptions): Promise<string>;
  resolveAriaRef(ref: string): Promise<ResolvedAriaRef>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  on<K extends PageEventName>(event: K, listener: PageEventListener<K>): this;
  once<K extends PageEventName>(event: K, listener: PageEventListener<K>): this;
  removeListener<K extends PageEventName>(event: K, listener: PageEventListener<K>): this;
  waitForEvent<K extends PageEventName>(
    event: K,
    predicate?: PageEventPredicate<K>
  ): Promise<PageEventMap[K]>;
  locator(selector: string): Locator;
  getByText(text: string | RegExp, options?: GetByTextOptions): Locator;
  getByRole(role: string, options?: GetByRoleOptions): Locator;
  click(selector: string, options?: ClickOptions): Promise<void>;
  hover(selector: string, options?: HoverOptions): Promise<void>;
  fill(selector: string, value: string, options?: FillOptions): Promise<void>;
  type(selector: string, value: string, options?: TypeOptions): Promise<void>;
  press(selector: string, key: string, options?: PressOptions): Promise<void>;
  close(): Promise<void>;
}

export interface Locator {
  locator(selector: string): Locator;
  getByText(text: string | RegExp, options?: GetByTextOptions): Locator;
  getByRole(role: string, options?: GetByRoleOptions): Locator;
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
  click(options?: ClickOptions): Promise<void>;
  hover(options?: HoverOptions): Promise<void>;
  fill(value: string, options?: FillOptions): Promise<void>;
  type(value: string, options?: TypeOptions): Promise<void>;
  press(key: string, options?: PressOptions): Promise<void>;
  textContent(): Promise<string | null>;
  isVisible(): Promise<boolean>;
}
