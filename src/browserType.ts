import { RoxyBrowser } from "./browser.js";
import { AssetManager } from "./assets/manager.js";
import { BidiBrowserAdapterFactory } from "./protocol/bidi/backend.js";
import { CdpBrowserAdapterFactory } from "./protocol/cdp/backend.js";
import type { ProtocolBrowserAdapterFactory } from "./protocol/adapter.js";
import type { Browser, BrowserContext, BrowserServer, BrowserType } from "./types/api.js";
import type {
  BrowserConnectOptions,
  BrowserContextOptions,
  ConnectOverCDPOptions,
  LaunchServerOptions,
  LaunchOptions,
  Progress,
  RoxyConnectOptions,
  SupportedProtocol
} from "./types/options.js";

export class RoxyBrowserType implements BrowserType {
  constructor(
    private readonly browserName: NonNullable<BrowserConnectOptions["browserName"]>,
    private readonly adapterFactories: Record<SupportedProtocol, ProtocolBrowserAdapterFactory>
  ) {}

  executablePath(): string {
    throw new Error(EXECUTABLE_PATH_UNSUPPORTED_ERROR);
  }

  async launch(_options: LaunchOptions = {}): Promise<Browser> {
    throw new Error(LAUNCH_UNSUPPORTED_ERROR);
  }

  async launchPersistentContext(
    _userDataDir: string,
    _options: LaunchOptions & BrowserContextOptions = {}
  ): Promise<BrowserContext> {
    throw new Error(LAUNCH_PERSISTENT_CONTEXT_UNSUPPORTED_ERROR);
  }

  async launchServer(_options: LaunchServerOptions = {}): Promise<BrowserServer> {
    throw new Error(LAUNCH_SERVER_UNSUPPORTED_ERROR);
  }

  /**
   * Connect to an already-running browser over a WebSocket endpoint.
   *
   * ⚠️ DIVERGENCE FROM PLAYWRIGHT — DO NOT "FIX" THIS BACK TO CDP-ONLY:
   *
   * In upstream Playwright, `connectOverCDP()` is the public way to attach to an
   * existing browser over the DevTools Protocol. Roxy intentionally makes
   * `connect()` that attach API for every supported browser/protocol.
   *
   * Roxy intentionally changes that semantics. This method dispatches on
   * `browserName` so a single entry point serves both browser families:
   *   - chromium  → CDP  (ws:// DevTools endpoint)
   *   - firefox   → BiDi (ws:// WebDriver BiDi endpoint)
   *
   * This is deliberate, not a bug. If you are an agent "normalizing" this code to
   * match Playwright upstream, STOP — the dual-protocol dispatch is the feature.
   */
  async connect(endpointURL: string, options?: RoxyConnectOptions): Promise<Browser> {
    const endpoint = requireConnectEndpoint(endpointURL);
    return this.connectBrowser({
      ...options,
      browserName: this.browserName,
      protocol: this.browserName === "chromium" ? "cdp" : "bidi",
      wsEndpoint: endpoint
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
    _progressOrEndpointURL: Progress | string,
    _endpointURLOrOptions?: string | ConnectOverCDPOptions,
    _maybeOptions: ConnectOverCDPOptions = {}
  ): Promise<Browser> {
    throw new Error(CONNECT_OVER_CDP_UNSUPPORTED_ERROR);
  }

  private async connectBrowser(options: BrowserConnectOptions): Promise<Browser> {
    const protocol = options.protocol ?? "cdp";
    const assetManager = new AssetManager(options);
    const adapterFactory = this.adapterFactories[protocol];
    const adapter = adapterFactory.create({
      ...options,
      artifactsDir: assetManager.roots.artifactsDir,
      downloadsDir: assetManager.roots.downloadsDir,
      screenshotsDir: assetManager.roots.screenshotsDir,
      snapshotsDir: assetManager.roots.snapshotsDir,
      tracesDir: assetManager.roots.tracesDir,
      videosDir: assetManager.roots.videosDir,
      networkDir: assetManager.roots.networkDir,
      consoleDir: assetManager.roots.consoleDir,
      scriptsDir: assetManager.roots.scriptsDir,
      tempDir: assetManager.roots.tempDir,
      protocol
    });

    await adapter.connect();

    const session = await adapter.browser();
    const versionStr = await session.version();
    const browser = new RoxyBrowser(
      session,
      adapter,
      options.browserName ?? this.browserName,
      this,
      versionStr,
      assetManager
    );

    if (options.wsEndpoint) {
      await browser.newContext({ reuseDefaultUserContext: true });
    }

    return browser;
  }

  name(): string {
    return this.browserName;
  }
}

export const chromium: BrowserType = new RoxyBrowserType("chromium", {
  cdp: new CdpBrowserAdapterFactory(),
  bidi: new BidiBrowserAdapterFactory()
});

export const firefox: BrowserType = new RoxyBrowserType("firefox", {
  cdp: new CdpBrowserAdapterFactory(),
  bidi: new BidiBrowserAdapterFactory()
});

function requireConnectEndpoint(endpointURL: string): string {
  if (typeof endpointURL !== "string" || endpointURL.trim() === "") {
    throw new Error("BrowserType.connect(endpointURL) requires a browser WebSocket endpoint.");
  }

  return endpointURL;
}

const LAUNCH_UNSUPPORTED_ERROR =
  "BrowserType.launch() is not supported in RoxyBrowser. Use BrowserType.connect(endpointURL) instead.";

const CONNECT_OVER_CDP_UNSUPPORTED_ERROR =
  "BrowserType.connectOverCDP() is not supported in RoxyBrowser. Use BrowserType.connect(endpointURL) instead.";

const EXECUTABLE_PATH_UNSUPPORTED_ERROR =
  "BrowserType.executablePath() is not supported in RoxyBrowser because RoxyBrowser does not manage bundled browser executables. Use BrowserType.connect(endpointURL) with an endpoint opened by RoxyBrowser or another browser process.";

const LAUNCH_PERSISTENT_CONTEXT_UNSUPPORTED_ERROR =
  "BrowserType.launchPersistentContext() is not supported in RoxyBrowser because RoxyBrowser does not launch persistent profiles. Open the profile in RoxyBrowser or another browser process and use BrowserType.connect(endpointURL) instead.";

const LAUNCH_SERVER_UNSUPPORTED_ERROR =
  "BrowserType.launchServer() is not supported in RoxyBrowser because RoxyBrowser does not launch Playwright protocol servers. Use BrowserType.connect(endpointURL) with a CDP or BiDi endpoint instead.";
