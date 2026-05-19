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

const BIDI_CAPABILITIES: ProtocolCapabilities = {
  protocol: "bidi",
  supportsMultipleContexts: true,
  supportsIsolatedWorlds: true,
  supportsLocatorChaining: true,
  supportsInputDispatch: true,
  supportsDownloads: false,
  supportsTracing: false
};

export class BidiBrowserAdapterFactory implements ProtocolBrowserAdapterFactory {
  create(options: LaunchOptions): ProtocolBrowserAdapter {
    return new BidiBrowserAdapter(options);
  }
}

class BidiBrowserAdapter implements ProtocolBrowserAdapter {
  readonly protocol = "bidi" as const;
  readonly capabilities = BIDI_CAPABILITIES;

  constructor(private readonly options: LaunchOptions) {}

  async connect(): Promise<void> {
    void this.options;
  }

  async browser(): Promise<ProtocolBrowserSession> {
    return new BidiBrowserSession();
  }

  async close(): Promise<void> {}
}

class BidiBrowserSession implements ProtocolBrowserSession {
  async version(): Promise<string> {
    return "bidi-pending";
  }

  async newContext(
    _options?: BrowserContextOptions
  ): Promise<ProtocolBrowserContextAdapter> {
    return new BidiBrowserContextAdapter();
  }

  async close(): Promise<void> {}
}

class BidiBrowserContextAdapter implements ProtocolBrowserContextAdapter {
  async newPage(): Promise<ProtocolPageAdapter> {
    return new BidiPageAdapter();
  }

  async close(): Promise<void> {}
}

class BidiPageAdapter implements ProtocolPageAdapter {
  async goto(_url: string, _options?: PageGotoOptions): Promise<void> {
    throw new NotImplementedInProtocolError("bidi", "page.goto");
  }

  async title(): Promise<string> {
    throw new NotImplementedInProtocolError("bidi", "page.title");
  }

  async content(): Promise<string> {
    throw new NotImplementedInProtocolError("bidi", "page.content");
  }

  async setContent(_html: string): Promise<void> {
    throw new NotImplementedInProtocolError("bidi", "page.setContent");
  }

  async evaluate<TResult>(_expression: string, _arg?: unknown): Promise<TResult> {
    throw new NotImplementedInProtocolError("bidi", "page.evaluate");
  }

  async waitForLoadState(_state?: PageGotoOptions["waitUntil"]): Promise<void> {
    throw new NotImplementedInProtocolError("bidi", "page.waitForLoadState");
  }

  locator(selector: LocatorSelector): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter(selector);
  }

  getByText(text: string | RegExp): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter({
      strategy: "text",
      value: text instanceof RegExp ? text.source : text
    });
  }

  getByRole(role: string): ProtocolLocatorAdapter {
    return new BidiLocatorAdapter({
      strategy: "role",
      value: role
    });
  }

  async close(): Promise<void> {}
}

class BidiLocatorAdapter implements ProtocolLocatorAdapter {
  constructor(private readonly selector: LocatorSelector) {}

  locator(selector: LocatorSelector): ProtocolLocatorAdapter {
    void this.selector;
    return new BidiLocatorAdapter(selector);
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
    throw new NotImplementedInProtocolError("bidi", "locator.click");
  }

  async hover(): Promise<void> {
    throw new NotImplementedInProtocolError("bidi", "locator.hover");
  }

  async fill(_value: string): Promise<void> {
    throw new NotImplementedInProtocolError("bidi", "locator.fill");
  }

  async type(_value: string): Promise<void> {
    throw new NotImplementedInProtocolError("bidi", "locator.type");
  }

  async press(_key: string): Promise<void> {
    throw new NotImplementedInProtocolError("bidi", "locator.press");
  }

  async textContent(): Promise<string | null> {
    throw new NotImplementedInProtocolError("bidi", "locator.textContent");
  }

  async isVisible(): Promise<boolean> {
    throw new NotImplementedInProtocolError("bidi", "locator.isVisible");
  }
}

