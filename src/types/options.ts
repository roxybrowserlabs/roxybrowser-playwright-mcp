export type SupportedProtocol = "cdp" | "bidi" | "webdriver";
export type WaitUntilState = "load" | "domcontentloaded" | "networkidle" | "commit";
export type MouseButton = "left" | "right" | "middle";
export type HumanProfileName = "cautious" | "balanced" | "fast";

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
  protocol?: SupportedProtocol;
  headless?: boolean;
  executablePath?: string;
  args?: string[];
  wsEndpoint?: string;
  host?: string;
  port?: number;
  human?: HumanizationOptions;
}

export interface BrowserContextOptions {
  viewport?: ViewportSize;
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  baseURL?: string;
  human?: HumanizationOptions;
}

export interface TimeoutOptions {
  timeout?: number;
}

export interface PageGotoOptions extends TimeoutOptions {
  waitUntil?: WaitUntilState;
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

