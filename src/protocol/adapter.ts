import type {
  BrowserConnectOptions,
  BrowserContextOptions,
  ClickOptions,
  FillOptions,
  GetByRoleOptions,
  GetByTextOptions,
  HoverOptions,
  LaunchOptions,
  PageGotoOptions,
  PressOptions,
  TypeOptions
} from "../types/options.js";
import type { ProtocolCapabilities } from "./capabilities.js";

export type LocatorStrategy = "css" | "text" | "role";

export interface LocatorSelector {
  strategy: LocatorStrategy;
  value: string;
  exact?: boolean;
  name?: string;
  isRegex?: boolean;
  regexFlags?: string;
  nameIsRegex?: boolean;
  nameRegexFlags?: string;
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
  close(): Promise<void>;
}

export interface ProtocolPageAdapter {
  goto(url: string, options?: PageGotoOptions): Promise<void>;
  title(): Promise<string>;
  content(): Promise<string>;
  setContent(html: string): Promise<void>;
  evaluate<TResult>(expression: string, arg?: unknown): Promise<TResult>;
  waitForLoadState(state?: PageGotoOptions["waitUntil"]): Promise<void>;
  locator(selector: LocatorSelector): ProtocolLocatorAdapter;
  getByText(text: string | RegExp, options?: GetByTextOptions): ProtocolLocatorAdapter;
  getByRole(role: string, options?: GetByRoleOptions): ProtocolLocatorAdapter;
  close(): Promise<void>;
}

export interface ProtocolLocatorAdapter {
  locator(selector: LocatorSelector): ProtocolLocatorAdapter;
  first(): ProtocolLocatorAdapter;
  last(): ProtocolLocatorAdapter;
  nth(index: number): ProtocolLocatorAdapter;
  click(options?: ClickOptions): Promise<void>;
  hover(options?: HoverOptions): Promise<void>;
  fill(value: string, options?: FillOptions): Promise<void>;
  type(value: string, options?: TypeOptions): Promise<void>;
  press(key: string, options?: PressOptions): Promise<void>;
  textContent(): Promise<string | null>;
  isVisible(): Promise<boolean>;
}
