import { RoxyBrowser } from "./browser.js";
import { resolveHumanizationOptions } from "./human/profile.js";
import { BidiBrowserAdapterFactory } from "./protocol/bidi/backend.js";
import { CdpBrowserAdapterFactory } from "./protocol/cdp/backend.js";
import { WebDriverBrowserAdapterFactory } from "./protocol/webdriver/backend.js";
import type { ProtocolBrowserAdapterFactory } from "./protocol/adapter.js";
import type { Browser, BrowserType } from "./types/api.js";
import type { LaunchOptions, SupportedProtocol } from "./types/options.js";

export class RoxyBrowserType implements BrowserType {
  constructor(
    private readonly adapterFactories: Record<SupportedProtocol, ProtocolBrowserAdapterFactory>
  ) {}

  async launch(options: LaunchOptions = {}): Promise<Browser> {
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

export const chromium: BrowserType = new RoxyBrowserType({
  cdp: new CdpBrowserAdapterFactory(),
  bidi: new BidiBrowserAdapterFactory(),
  webdriver: new WebDriverBrowserAdapterFactory()
});
