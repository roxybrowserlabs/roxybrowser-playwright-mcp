import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import type { BrowserContextFactory } from 'playwright/lib/mcp/browser/browserContextFactory';
import type { Config } from 'playwright/lib/mcp/browser/config';

/** 与 src/browserContextFactory.ts 中 DynamicCdpContextFactory 行为一致：支持 reconnectToCDP，后续 createContext 连到该 CDP */
export class DynamicCdpContextFactory implements BrowserContextFactory {
  readonly config: Config;
  _currentCdpEndpoint: string | undefined;
  _browserPromise: Promise<Browser> | undefined;

  constructor(config: Config, initialCdpEndpoint: string | undefined = undefined) {
    this.config = config;
    this._currentCdpEndpoint = initialCdpEndpoint;
    this._browserPromise = undefined;
  }

  reconnectToCDP(cdpEndpoint: string) {
    if (this._currentCdpEndpoint === cdpEndpoint && this._browserPromise) return;
    this._currentCdpEndpoint = cdpEndpoint;
    this._browserPromise = undefined;
  }

  async createContext(
    clientInfo: unknown,
    _abortSignal?: AbortSignal,
    options: Record<string, unknown> = {}
  ): Promise<{ browserContext: BrowserContext; close: () => Promise<void> }> {
    void clientInfo;
    void options;
    const endpoint = this._currentCdpEndpoint;
    if (!endpoint) {
      throw new Error(
        'No CDP endpoint set. Use the browser_connect_roxy tool to connect to RoxyBrowser first. ' +
          'Example: {"name": "browser_connect_roxy", "arguments": {"cdpEndpoint": "ws://127.0.0.1:PORT/devtools/browser/ID"}}'
      );
    }
    if (!this._browserPromise) {
      this._browserPromise = chromium.connectOverCDP(endpoint, { timeout: 30000 });
      this._browserPromise.catch(() => {
        this._browserPromise = undefined;
      });
    }
    const browser = await this._browserPromise;
    const browserContext = this.config.browser?.isolated
      ? await browser.newContext()
      : (browser.contexts().length ? browser.contexts()[0] : await browser.newContext());

    const close = async () => {
      await browserContext.close().catch(() => {});
      if (browser.contexts().length === 0) await browser.close().catch(() => {});
    };
    return { browserContext, close };
  }
}
