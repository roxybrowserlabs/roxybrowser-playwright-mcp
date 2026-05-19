import { NotImplementedInProtocolError } from "../../errors.js";
import type { BrowserContextOptions, LaunchOptions, PageGotoOptions } from "../../types/options.js";
import type {
  LocatorSelector,
  ProtocolBrowserAdapter,
  ProtocolBrowserAdapterFactory,
  ProtocolBrowserContextAdapter,
  ProtocolBrowserSession,
  ProtocolLocatorAdapter,
  ProtocolPageAdapter
} from "../adapter.js";
import type { ProtocolCapabilities } from "../capabilities.js";

const WEBDRIVER_CAPABILITIES: ProtocolCapabilities = {
  protocol: "webdriver",
  supportsMultipleContexts: false,
  supportsIsolatedWorlds: false,
  supportsLocatorChaining: true,
  supportsInputDispatch: true,
  supportsDownloads: false,
  supportsTracing: false
};

export class WebDriverBrowserAdapterFactory implements ProtocolBrowserAdapterFactory {
  create(options: LaunchOptions): ProtocolBrowserAdapter {
    return new WebDriverBrowserAdapter(options);
  }
}

class WebDriverBrowserAdapter implements ProtocolBrowserAdapter {
  readonly protocol = "webdriver" as const;
  readonly capabilities = WEBDRIVER_CAPABILITIES;

  constructor(private readonly options: LaunchOptions) {}

  async connect(): Promise<void> {
    void this.options;
  }

  async browser(): Promise<ProtocolBrowserSession> {
    return new WebDriverBrowserSession();
  }

  async close(): Promise<void> {}
}

class WebDriverBrowserSession implements ProtocolBrowserSession {
  async version(): Promise<string> {
    return "webdriver-pending";
  }

  async newContext(
    _options?: BrowserContextOptions
  ): Promise<ProtocolBrowserContextAdapter> {
    return new WebDriverBrowserContextAdapter();
  }

  async close(): Promise<void> {}
}

class WebDriverBrowserContextAdapter implements ProtocolBrowserContextAdapter {
  async newPage(): Promise<ProtocolPageAdapter> {
    return new WebDriverPageAdapter();
  }

  async close(): Promise<void> {}
}

class WebDriverPageAdapter implements ProtocolPageAdapter {
  async goto(_url: string, _options?: PageGotoOptions): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.goto");
  }

  async title(): Promise<string> {
    throw new NotImplementedInProtocolError("webdriver", "page.title");
  }

  async content(): Promise<string> {
    throw new NotImplementedInProtocolError("webdriver", "page.content");
  }

  async setContent(_html: string): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.setContent");
  }

  async evaluate<TResult>(_expression: string, _arg?: unknown): Promise<TResult> {
    throw new NotImplementedInProtocolError("webdriver", "page.evaluate");
  }

  async waitForLoadState(_state?: PageGotoOptions["waitUntil"]): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.waitForLoadState");
  }

  locator(selector: LocatorSelector): ProtocolLocatorAdapter {
    return new WebDriverLocatorAdapter(selector);
  }

  getByText(text: string | RegExp): ProtocolLocatorAdapter {
    return new WebDriverLocatorAdapter({
      strategy: "text",
      value: text instanceof RegExp ? text.source : text
    });
  }

  getByRole(role: string): ProtocolLocatorAdapter {
    return new WebDriverLocatorAdapter({
      strategy: "role",
      value: role
    });
  }

  async close(): Promise<void> {}
}

class WebDriverLocatorAdapter implements ProtocolLocatorAdapter {
  constructor(private readonly selector: LocatorSelector) {}

  locator(selector: LocatorSelector): ProtocolLocatorAdapter {
    void this.selector;
    return new WebDriverLocatorAdapter(selector);
  }

  first(): ProtocolLocatorAdapter {
    return this;
  }

  last(): ProtocolLocatorAdapter {
    return this;
  }

  nth(_index: number): ProtocolLocatorAdapter {
    return this;
  }

  async click(): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "locator.click");
  }

  async hover(): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "locator.hover");
  }

  async fill(_value: string): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "locator.fill");
  }

  async type(_value: string): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "locator.type");
  }

  async press(_key: string): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "locator.press");
  }

  async textContent(): Promise<string | null> {
    throw new NotImplementedInProtocolError("webdriver", "locator.textContent");
  }

  async isVisible(): Promise<boolean> {
    throw new NotImplementedInProtocolError("webdriver", "locator.isVisible");
  }
}
