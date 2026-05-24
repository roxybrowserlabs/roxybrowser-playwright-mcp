export { chromium, firefox } from "./browserType.js";

export type {
  Browser,
  BrowserContext,
  BrowserType,
  Locator,
  Page
} from "./types/api.js";

export type {
  PageEventListener,
  PageEventMap,
  PageEventName,
  PageRequest,
  PageRequestFailure,
  PageResponse
} from "./types/events.js";

export type {
  BrowserContextOptions,
  ClickOptions,
  ConnectOverCDPOptions,
  ChromiumChannel,
  FillOptions,
  HeadersArray,
  HoverOptions,
  HumanizationOptions,
  LaunchOptions,
  PageGotoOptions,
  PressOptions,
  Progress,
  ScreenshotOptions,
  ScreenshotType,
  TypeOptions
} from "./types/options.js";
