import type {
  BrowserContextOptions,
  ClickOptions,
  ConnectOverCDPOptions,
  FillOptions,
  GetByRoleOptions,
  GetByTextOptions,
  HoverOptions,
  LaunchOptions,
  PageGotoOptions,
  PressOptions,
  TypeOptions
} from "./options.js";

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

export interface Page {
  goto(url: string, options?: PageGotoOptions): Promise<void>;
  title(): Promise<string>;
  content(): Promise<string>;
  setContent(html: string): Promise<void>;
  evaluate<TResult>(expression: string, arg?: unknown): Promise<TResult>;
  waitForLoadState(state?: PageGotoOptions["waitUntil"]): Promise<void>;
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
