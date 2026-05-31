import { RoxyBrowser } from "./browser.js";
import { resolveHumanizationOptions } from "./human/profile.js";
import { BidiBrowserAdapterFactory } from "./protocol/bidi/backend.js";
import { CdpBrowserAdapterFactory } from "./protocol/cdp/backend.js";
import { ClassicWebDriverBrowserAdapterFactory } from "./protocol/webdriver-classic/backend.js";
import type { ProtocolBrowserAdapterFactory } from "./protocol/adapter.js";
import type { Browser, BrowserType } from "./types/api.js";
import type {
  BrowserConnectOptions,
  ConnectOverCDPOptions,
  LaunchOptions,
  Progress,
  SupportedProtocol
} from "./types/options.js";

export class RoxyBrowserType implements BrowserType {
  constructor(
    private readonly browserName: NonNullable<BrowserConnectOptions["browserName"]>,
    private readonly adapterFactories: Record<SupportedProtocol, ProtocolBrowserAdapterFactory>
  ) {}

  async launch(options: LaunchOptions = {}): Promise<Browser> {
    return this.connectBrowser({
      ...options,
      browserName: this.browserName,
      protocol: options.protocol ?? (this.browserName === "firefox" ? "bidi" : "cdp")
    });
  }

  async connect(options: BrowserConnectOptions): Promise<Browser> {
    return this.connectBrowser({
      ...options,
      browserName: options.browserName ?? this.browserName,
      protocol: options.protocol ?? (this.browserName === "firefox" ? "bidi" : "cdp")
    });
  }

  async connectOverCDP(
    endpointURL: string,
    options?: ConnectOverCDPOptions
  ): Promise<Browser>;
  async connectOverCDP(
    progress: Progress,
    endpointURL: string,
    options?: ConnectOverCDPOptions
  ): Promise<Browser>;
  async connectOverCDP(
    progressOrEndpointURL: Progress | string,
    endpointURLOrOptions?: string | ConnectOverCDPOptions,
    maybeOptions: ConnectOverCDPOptions = {}
  ): Promise<Browser> {
    const [progress, endpointURL, options] =
      typeof progressOrEndpointURL === "string"
        ? [undefined, progressOrEndpointURL, (endpointURLOrOptions ?? {}) as ConnectOverCDPOptions]
        : [progressOrEndpointURL, endpointURLOrOptions as string, maybeOptions];

    const endpoint = new URL(endpointURL);
    if (!["ws:", "wss:"].includes(endpoint.protocol)) {
      throw new Error(
        `Only ws:// and wss:// CDP endpoints are currently supported. Received "${endpoint.protocol}".`
      );
    }

    if (options.headers?.length) {
      throw new Error("Custom headers are not supported for WebSocket CDP endpoints yet.");
    }

    if (this.browserName !== "chromium") {
      throw new Error('connectOverCDP() is only supported for the "chromium" browser type.');
    }

    await progress?.log?.(`Connecting over CDP to ${endpoint.origin}.`);

    return this.connectBrowser({
      browserName: this.browserName,
      protocol: "cdp",
      wsEndpoint: endpointURL,
      ...options
    });
  }

  private async connectBrowser(options: BrowserConnectOptions): Promise<Browser> {
    const protocol = options.protocol ?? "cdp";
    const adapterFactory = this.adapterFactories[protocol];
    const adapter = adapterFactory.create({
      ...options,
      protocol
    });

    await adapter.connect();

    const session = await adapter.browser();
    return new RoxyBrowser(session, adapter, resolveHumanizationOptions(options.human));
  }
}

export const chromium: BrowserType = new RoxyBrowserType("chromium", {
  cdp: new CdpBrowserAdapterFactory(),
  bidi: new BidiBrowserAdapterFactory(),
  webdriver: new ClassicWebDriverBrowserAdapterFactory()
});

export const firefox: BrowserType = new RoxyBrowserType("firefox", {
  cdp: new CdpBrowserAdapterFactory(),
  bidi: new BidiBrowserAdapterFactory(),
  webdriver: new ClassicWebDriverBrowserAdapterFactory()
});
