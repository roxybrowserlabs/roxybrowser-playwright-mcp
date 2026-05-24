import { NotImplementedInProtocolError } from "../../errors.js";
import type { ResolvedAriaRef } from "../../types/api.js";
import type {
  AriaSnapshotOptions,
  BrowserConnectOptions,
  BrowserContextOptions,
  PageGotoOptions,
  ScreenshotOptions
} from "../../types/options.js";
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
import type { PageEventListener, PageEventName } from "../../types/events.js";

const WEBDRIVER_CAPABILITIES: ProtocolCapabilities = {
  protocol: "webdriver",
  supportsMultipleContexts: false,
  supportsIsolatedWorlds: false,
  supportsLocatorChaining: true,
  supportsInputDispatch: true,
  supportsDownloads: false,
  supportsTracing: false
};

export class ClassicWebDriverBrowserAdapterFactory implements ProtocolBrowserAdapterFactory {
  create(options: BrowserConnectOptions): ProtocolBrowserAdapter {
    return new ClassicWebDriverBrowserAdapter(options);
  }
}

class ClassicWebDriverBrowserAdapter implements ProtocolBrowserAdapter {
  readonly protocol = "webdriver" as const;
  readonly capabilities = WEBDRIVER_CAPABILITIES;

  constructor(private readonly options: BrowserConnectOptions) {}

  async connect(): Promise<void> {
    void this.options;
  }

  async browser(): Promise<ProtocolBrowserSession> {
    return new ClassicWebDriverBrowserSession();
  }

  async close(): Promise<void> {}
}

class ClassicWebDriverBrowserSession implements ProtocolBrowserSession {
  async version(): Promise<string> {
    return "webdriver-pending";
  }

  async newContext(
    _options?: BrowserContextOptions
  ): Promise<ProtocolBrowserContextAdapter> {
    return new ClassicWebDriverBrowserContextAdapter();
  }

  async close(): Promise<void> {}
}

class ClassicWebDriverBrowserContextAdapter implements ProtocolBrowserContextAdapter {
  async newPage(): Promise<ProtocolPageAdapter> {
    return new ClassicWebDriverPageAdapter();
  }

  async close(): Promise<void> {}
}

class ClassicWebDriverPageAdapter implements ProtocolPageAdapter {
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

  async ariaSnapshot(_options?: AriaSnapshotOptions): Promise<string> {
    throw new NotImplementedInProtocolError("webdriver", "page.ariaSnapshot");
  }

  async resolveAriaRef(_ref: string): Promise<ResolvedAriaRef> {
    throw new NotImplementedInProtocolError("webdriver", "page.resolveAriaRef");
  }

  async screenshot(_options?: ScreenshotOptions): Promise<Buffer> {
    throw new NotImplementedInProtocolError("webdriver", "page.screenshot");
  }

  on<K extends PageEventName>(_event: K, _listener: PageEventListener<K>): () => void {
    throw new NotImplementedInProtocolError("webdriver", `page.on(${String(_event)})`);
  }

  locator(selector: LocatorSelector): ProtocolLocatorAdapter {
    return new ClassicWebDriverLocatorAdapter(selector);
  }

  getByText(text: string | RegExp): ProtocolLocatorAdapter {
    return new ClassicWebDriverLocatorAdapter({
      strategy: "text",
      value: text instanceof RegExp ? text.source : text
    });
  }

  getByRole(role: string): ProtocolLocatorAdapter {
    return new ClassicWebDriverLocatorAdapter({
      strategy: "role",
      value: role
    });
  }

  async close(): Promise<void> {}
}

class ClassicWebDriverLocatorAdapter implements ProtocolLocatorAdapter {
  constructor(private readonly selector: LocatorSelector) {}

  locator(selector: LocatorSelector): ProtocolLocatorAdapter {
    void this.selector;
    return new ClassicWebDriverLocatorAdapter(selector);
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
