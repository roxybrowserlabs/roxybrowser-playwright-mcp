import type { Locator } from "./api.js";

export type SupportedProtocol = "cdp" | "bidi";
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
export type LoadState = Exclude<WaitUntilState, "commit">;
export type MouseButton = "left" | "right" | "middle";
export type KeyboardModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";
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

export interface Rect extends Point {
  width: number;
  height: number;
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

export interface HumanizedOption {
  human?: HumanizationOptions;
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

export interface RecordVideoOptions {
  dir?: string;
  size?: ViewportSize;
  showActions?: {
    duration?: number;
    position?: "top-left" | "top" | "top-right" | "bottom-left" | "bottom" | "bottom-right";
    fontSize?: number;
  };
}

export interface BrowserContextOptions {
  viewport?: ViewportSize | null;
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  baseURL?: string;
  extraHTTPHeaders?: { [key: string]: string };
  recordVideo?: RecordVideoOptions;
  reuseDefaultUserContext?: boolean;
  strictSelectors?: boolean;
  human?: HumanizationOptions;
}

export interface TimeoutOptions {
  timeout?: number;
}

export interface SelectTextOptions extends TimeoutOptions {
  force?: boolean;
}

export interface SelectorStrictOptions extends TimeoutOptions {
  strict?: boolean;
}

export interface PageGotoOptions extends TimeoutOptions {
  referer?: string;
  waitUntil?: WaitUntilState;
}

export interface PageSetContentOptions extends TimeoutOptions {
  waitUntil?: WaitUntilState;
}

export interface WaitForFunctionOptions extends TimeoutOptions {
  polling?: number | "raf";
}

export interface PageCloseOptions {
  runBeforeUnload?: boolean;
  reason?: string;
}

export interface WaitForURLOptions extends TimeoutOptions {
  waitUntil?: WaitUntilState;
}

export interface WaitForNavigationOptions extends WaitForURLOptions {
  url?: string | RegExp | URLPattern | ((url: URL) => boolean);
}

export type WaitForSelectorState = "attached" | "detached" | "hidden" | "visible";

export interface WaitForSelectorOptions extends TimeoutOptions {
  state?: WaitForSelectorState;
  strict?: boolean;
  waitFor?: WaitForSelectorState;
}

export interface HoverOptions extends SelectorStrictOptions, HumanizedOption {
  force?: boolean;
  modifiers?: KeyboardModifier[];
  trial?: boolean;
  position?: Point;
}

export interface ClickOptions extends HoverOptions {
  button?: MouseButton;
  clickCount?: number;
  delay?: number;
  noWaitAfter?: boolean;
}

export interface FillOptions extends SelectorStrictOptions, HumanizedOption {
  force?: boolean;
  noWaitAfter?: boolean;
  timeout?: number;
}

export interface SelectOption {
  value?: string;
  label?: string;
  index?: number;
}

export type SelectOptionValue = string | SelectOption;

export interface TypeOptions extends SelectorStrictOptions, HumanizedOption {
  delay?: number;
}

export interface PressOptions extends SelectorStrictOptions, HumanizedOption {
  delay?: number;
  noWaitAfter?: boolean;
}

export interface DispatchEventOptions extends TimeoutOptions {
  strict?: boolean;
}

export interface FilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface AddLocatorHandlerOptions {
  noWaitAfter?: boolean;
  times?: number;
}

export interface DragAndDropOptions extends TimeoutOptions {
  force?: boolean;
  noWaitAfter?: boolean;
  sourcePosition?: Point;
  steps?: number;
  strict?: boolean;
  targetPosition?: Point;
  trial?: boolean;
}

export interface EmulateMediaOptions {
  colorScheme?: null | "light" | "dark" | "no-preference";
  contrast?: null | "no-preference" | "more";
  forcedColors?: null | "active" | "none";
  media?: null | "screen" | "print";
  reducedMotion?: null | "reduce" | "no-preference";
}

export interface PdfOptions {
  displayHeaderFooter?: boolean;
  footerTemplate?: string;
  format?: string;
  headerTemplate?: string;
  height?: string | number;
  landscape?: boolean;
  margin?: {
    top?: string | number;
    right?: string | number;
    bottom?: string | number;
    left?: string | number;
  };
  outline?: boolean;
  pageRanges?: string;
  path?: string;
  preferCSSPageSize?: boolean;
  printBackground?: boolean;
  scale?: number;
  tagged?: boolean;
  width?: string | number;
}

export interface SetInputFilesOptions extends SelectorStrictOptions {
  noWaitAfter?: boolean;
}

export interface TapOptions extends HoverOptions {
  noWaitAfter?: boolean;
}

export interface GetByTextOptions {
  exact?: boolean;
}

export interface ExactTextLocatorOptions {
  exact?: boolean;
}

export interface GetByAltTextOptions extends ExactTextLocatorOptions {}

export interface GetByLabelOptions extends ExactTextLocatorOptions {}

export interface GetByPlaceholderOptions extends ExactTextLocatorOptions {}

export interface GetByRoleOptions {
  exact?: boolean;
  name?: string | RegExp;
}

export interface GetByTitleOptions extends ExactTextLocatorOptions {}

export type ScreenshotType = "jpeg" | "png";

export interface ScreenshotOptions {
  animations?: "disabled" | "allow";
  caret?: "hide" | "initial";
  clip?: Rect;
  fullPage?: boolean;
  mask?: Locator[];
  maskColor?: string;
  omitBackground?: boolean;
  path?: string;
  quality?: number;
  scale?: "css" | "device";
  style?: string;
  timeout?: number;
  type?: ScreenshotType;
}

export type PageScreenshotOptions = ScreenshotOptions;

export interface AddScriptTagOptions {
  content?: string;
  path?: string;
  type?: string;
  url?: string;
}

export interface AddStyleTagOptions {
  content?: string;
  path?: string;
  url?: string;
}

export interface AriaSnapshotOptions {
  boxes?: boolean;
  depth?: number;
  mode?: "ai" | "default";
  timeout?: number;
}
