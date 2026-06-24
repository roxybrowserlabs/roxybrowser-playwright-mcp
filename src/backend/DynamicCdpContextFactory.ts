import { chromium, firefox } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import type { BrowserContextFactory } from 'playwright/lib/mcp/browser/browserContextFactory';
import type { Config } from 'playwright/lib/mcp/browser/config';

export type BrowserName = 'Chrome' | 'Firefox';

/** 支持连接远程浏览器：Chrome（CDP）或 Firefox（BiDi） */
export class DynamicCdpContextFactory implements BrowserContextFactory {
  readonly config: Config;
  readonly browserName: BrowserName;
  _currentCdpEndpoint: string | undefined;
  _browserPromise: Promise<Browser> | undefined;

  constructor(config: Config, initialCdpEndpoint: string | undefined = undefined, browserName: BrowserName = 'Chrome') {
    this.config = config;
    this.browserName = browserName;
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
        'No endpoint set. Use the browser_connect_roxy tool to connect first. ' +
          `Example: {"name": "browser_connect_roxy", "arguments": {"endpoint": "ws://127.0.0.1:PORT/...", "browserCore": "${this.browserName}"}}`
      );
    }
    if (!this._browserPromise) {
      // connect() 由 patch 增强了端点自动检测（见 patches/playwright-core@1.58.2.patch）：
      //   - CDP 端点（/devtools/browser/）         → connectOverCDP
      //   - Firefox BiDi（ws://host:port[/session]）→ auto-append /session → connectOverCDP → BiDi
      //   - 其他 URL 回退到原始 Playwright Server 协议
      const browserType = this.browserName === 'Firefox' ? firefox : chromium;
      this._browserPromise = browserType.connect(endpoint, { timeout: 30000 });
      this._browserPromise.catch(() => {
        this._browserPromise = undefined;
      });
    }
    const browser = await this._browserPromise;
    if (!browser) {
      throw new Error(
        `Failed to connect to ${this.browserName} at ${endpoint}. ` +
        'The browser connection was lost or the endpoint is invalid.'
      );
    }
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
