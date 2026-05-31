export type SupportedProtocol = "cdp" | "bidi" | "webdriver";
export type BrowserName = "chromium" | "firefox";
export type ChromiumChannel =
  | "chromium"
  | "chrome"
  | "chrome-beta"
  | "chrome-dev"
  | "chrome-canary"
  | "msedge"
  | "msedge-beta"
  | "msedge-dev"
  | "msedge-canary";
export type WaitUntilState = "load" | "domcontentloaded" | "networkidle" | "commit";
export type MouseButton = "left" | "right" | "middle";
export type HumanProfileName = "cautious" | "balanced" | "fast";

export interface Header {
  name: string;
  value: string;
}

export type HeadersArray = Header[];

export interface Progress {
  log?(message: string): void | Promise<void>;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface HumanizationOptions {
  enabled?: boolean;
  profile?: HumanProfileName;
  moveJitterMs?: number;
  clickHoldMs?: number;
  scrollStepPx?: number;
  typingDelayMs?: number;
  typingVarianceMs?: number;
  hoverBeforeClickMs?: number;
}

export interface LaunchOptions {
  browserName?: BrowserName;
  protocol?: SupportedProtocol;
  headless?: boolean;
  channel?: ChromiumChannel;
  executablePath?: string;
  args?: string[];
  wsEndpoint?: string;
  sessionId?: string;
  host?: string;
  port?: number;
  human?: HumanizationOptions;
}

export interface ConnectOverCDPOptions {
  slowMo?: number;
  headers?: HeadersArray;
  isLocal?: boolean;
  noDefaults?: boolean;
}

export interface BrowserConnectOptions extends LaunchOptions, ConnectOverCDPOptions {}

export interface BrowserContextOptions {
  viewport?: ViewportSize;
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  baseURL?: string;
  reuseDefaultUserContext?: boolean;
  human?: HumanizationOptions;
}

export interface TimeoutOptions {
  timeout?: number;
}

export interface PageGotoOptions extends TimeoutOptions {
  waitUntil?: WaitUntilState;
}

export type WaitForSelectorState = "attached" | "detached" | "hidden" | "visible";

export interface WaitForSelectorOptions extends TimeoutOptions {
  state?: WaitForSelectorState;
  waitFor?: WaitForSelectorState;
}

export interface HoverOptions extends TimeoutOptions {
  force?: boolean;
  trial?: boolean;
  position?: Point;
}

export interface ClickOptions extends HoverOptions {
  button?: MouseButton;
  clickCount?: number;
  delay?: number;
  noWaitAfter?: boolean;
}

export interface FillOptions extends TimeoutOptions {
  force?: boolean;
}

export interface TypeOptions extends TimeoutOptions {
  delay?: number;
}

export interface PressOptions extends TimeoutOptions {
  delay?: number;
  noWaitAfter?: boolean;
}

export interface GetByTextOptions {
  exact?: boolean;
}

export interface GetByRoleOptions {
  exact?: boolean;
  name?: string | RegExp;
}

export type ScreenshotType = "jpeg" | "png";

export interface ScreenshotOptions {
  fullPage?: boolean;
  path?: string;
  quality?: number;
  type?: ScreenshotType;
}

export interface AriaSnapshotOptions {
  boxes?: boolean;
  depth?: number;
  mode?: "ai" | "default";
  timeout?: number;
}
