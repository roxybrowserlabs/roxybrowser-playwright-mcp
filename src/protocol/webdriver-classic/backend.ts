import { NotImplementedInProtocolError } from "../../errors.js";
import {
  createAltTextLocatorSelector,
  createLabelLocatorSelector,
  createPlaceholderLocatorSelector,
  createRoleLocatorSelector,
  createTestIdLocatorSelector,
  createTextLocatorSelector,
  createTitleLocatorSelector
} from "../../locatorSelectors.js";
import type { Disposable, ResolvedAriaRef } from "../../types/api.js";
import type { PageResponse } from "../../types/events.js";
import type {
  AddScriptTagOptions,
  AddStyleTagOptions,
  AriaSnapshotOptions,
  BrowserConnectOptions,
  BrowserContextOptions,
  DispatchEventOptions,
  PageCloseOptions,
  PageGotoOptions,
  PdfOptions,
  ScreenshotOptions,
  TapOptions
} from "../../types/options.js";
import type { RawPageEventListener, RawPageEventName } from "../../types/events.js";
import type {
  LocatorSelector,
  ProtocolBrowserAdapter,
  ProtocolBrowserAdapterFactory,
  ProtocolBrowserContextAdapter,
  ProtocolElementHandleReference,
  ProtocolBrowserSession,
  ProtocolElementHandleAdapter,
  ProtocolLocatorAdapter,
  ProtocolPageAdapter
} from "../adapter.js";
import type { ProtocolCapabilities } from "../capabilities.js";
import type { ViewportSize } from "../../types/options.js";

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

  async close(_options?: PageCloseOptions): Promise<void> {}
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

  async setExtraHTTPHeaders(_headers: { [key: string]: string }): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "browserContext.setExtraHTTPHeaders");
  }

  async close(): Promise<void> {}
}

class ClassicWebDriverPageAdapter implements ProtocolPageAdapter {
  private currentViewportSize: ViewportSize | null = null;
  async goto(_url: string, _options?: PageGotoOptions): Promise<PageResponse | null> {
    throw new NotImplementedInProtocolError("webdriver", "page.goto");
  }

  url(): string {
    throw new NotImplementedInProtocolError("webdriver", "page.url");
  }

  async goBack(_options?: PageGotoOptions): Promise<PageResponse | null> {
    throw new NotImplementedInProtocolError("webdriver", "page.goBack");
  }

  async goForward(_options?: PageGotoOptions): Promise<PageResponse | null> {
    throw new NotImplementedInProtocolError("webdriver", "page.goForward");
  }

  async reload(_options?: PageGotoOptions): Promise<PageResponse | null> {
    throw new NotImplementedInProtocolError("webdriver", "page.reload");
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

  async addInitScript(_source: string, _arg?: unknown): Promise<Disposable> {
    throw new NotImplementedInProtocolError("webdriver", "page.addInitScript");
  }

  async evaluate<TResult>(_expression: string, _arg?: unknown): Promise<TResult> {
    throw new NotImplementedInProtocolError("webdriver", "page.evaluate");
  }

  async addScriptTag(_options?: AddScriptTagOptions): Promise<ProtocolElementHandleAdapter> {
    throw new NotImplementedInProtocolError("webdriver", "page.addScriptTag");
  }

  async addStyleTag(_options?: AddStyleTagOptions): Promise<ProtocolElementHandleAdapter> {
    throw new NotImplementedInProtocolError("webdriver", "page.addStyleTag");
  }

  async waitForLoadState(
    _state?: "load" | "domcontentloaded" | "networkidle" | "commit",
    _timeout?: number
  ): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.waitForLoadState");
  }

  async ariaSnapshot(_options?: AriaSnapshotOptions): Promise<string> {
    throw new NotImplementedInProtocolError("webdriver", "page.ariaSnapshot");
  }

  async resolveAriaRef(_ref: string): Promise<ResolvedAriaRef> {
    throw new NotImplementedInProtocolError("webdriver", "page.resolveAriaRef");
  }

  async setExtraHTTPHeaders(_headers: { [key: string]: string }): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.setExtraHTTPHeaders");
  }

  async screenshot(_options?: ScreenshotOptions): Promise<Buffer> {
    throw new NotImplementedInProtocolError("webdriver", "page.screenshot");
  }

  async pdf(_options: PdfOptions = {}): Promise<Buffer> {
    throw new Error("PDF generation is only supported for Headless Chromium");
  }

  viewportSize(): ViewportSize | null {
    return this.currentViewportSize;
  }

  async setViewportSize(viewportSize: ViewportSize): Promise<void> {
    this.currentViewportSize = viewportSize;
  }

  async dispatchEvent(
    _selector: LocatorSelector[],
    _type: string,
    _eventInit?: unknown,
    _options?: DispatchEventOptions
  ): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.dispatchEvent");
  }

  async requestGC(): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.requestGC");
  }

  async textContent(_selector: LocatorSelector[]): Promise<string | null> {
    throw new NotImplementedInProtocolError("webdriver", "page.textContent");
  }

  async innerText(_selector: LocatorSelector[]): Promise<string> {
    throw new NotImplementedInProtocolError("webdriver", "page.innerText");
  }

  async innerHTML(_selector: LocatorSelector[]): Promise<string> {
    throw new NotImplementedInProtocolError("webdriver", "page.innerHTML");
  }

  async getAttribute(_selector: LocatorSelector[], _name: string): Promise<string | null> {
    throw new NotImplementedInProtocolError("webdriver", "page.getAttribute");
  }

  async inputValue(_selector: LocatorSelector[]): Promise<string> {
    throw new NotImplementedInProtocolError("webdriver", "page.inputValue");
  }

  async isChecked(_selector: LocatorSelector[]): Promise<boolean> {
    throw new NotImplementedInProtocolError("webdriver", "page.isChecked");
  }

  async isDisabled(_selector: LocatorSelector[]): Promise<boolean> {
    throw new NotImplementedInProtocolError("webdriver", "page.isDisabled");
  }

  async isEditable(_selector: LocatorSelector[]): Promise<boolean> {
    throw new NotImplementedInProtocolError("webdriver", "page.isEditable");
  }

  async isEnabled(_selector: LocatorSelector[]): Promise<boolean> {
    throw new NotImplementedInProtocolError("webdriver", "page.isEnabled");
  }

  async focus(_selector: LocatorSelector[]): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.focus");
  }

  async setChecked(_selector: LocatorSelector[], _checked: boolean): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.setChecked");
  }

  async selectOption(
    _selector: LocatorSelector[],
    _values: string | { value?: string; label?: string; index?: number } | Array<string | { value?: string; label?: string; index?: number }>
  ): Promise<string[]> {
    throw new NotImplementedInProtocolError("webdriver", "page.selectOption");
  }

  async startCSSCoverage(_options?: { resetOnNavigation?: boolean }): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.coverage.startCSSCoverage");
  }

  async startJSCoverage(
    _options?: {
      reportAnonymousScripts?: boolean;
      resetOnNavigation?: boolean;
    }
  ): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.coverage.startJSCoverage");
  }

  async stopCSSCoverage(): Promise<
    Array<{
      url: string;
      text?: string;
      ranges: Array<{
        start: number;
        end: number;
      }>;
    }>
  > {
    throw new NotImplementedInProtocolError("webdriver", "page.coverage.stopCSSCoverage");
  }

  async stopJSCoverage(): Promise<
    Array<{
      url: string;
      scriptId: string;
      source?: string;
      functions: Array<{
        functionName: string;
        isBlockCoverage: boolean;
        ranges: Array<{
          count: number;
          startOffset: number;
          endOffset: number;
        }>;
      }>;
    }>
  > {
    throw new NotImplementedInProtocolError("webdriver", "page.coverage.stopJSCoverage");
  }

  async screencastStart(): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.screencast.start");
  }

  async screencastStop(): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.screencast.stop");
  }

  async screencastShowActions(): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.screencast.showActions");
  }

  async screencastHideActions(): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.screencast.hideActions");
  }

  async screencastShowOverlay(): Promise<{ id: string }> {
    throw new NotImplementedInProtocolError("webdriver", "page.screencast.showOverlay");
  }

  async screencastRemoveOverlay(): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.screencast.removeOverlay");
  }

  async screencastChapter(): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.screencast.showChapter");
  }

  async screencastSetOverlayVisible(): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.screencast.setOverlayVisible");
  }

  async keyboardDown(_key: string): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.keyboard.down");
  }

  async keyboardInsertText(_text: string): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.keyboard.insertText");
  }

  async keyboardPress(
    _key: string,
    _options?: {
      delay?: number;
    }
  ): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.keyboard.press");
  }

  async keyboardType(
    _text: string,
    _options?: {
      delay?: number;
    }
  ): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.keyboard.type");
  }

  async keyboardUp(_key: string): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.keyboard.up");
  }

  async mouseClick(
    _x: number,
    _y: number,
    _options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
      delay?: number;
    }
  ): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.mouse.click");
  }

  async mouseDblclick(
    _x: number,
    _y: number,
    _options?: {
      button?: "left" | "right" | "middle";
      delay?: number;
    }
  ): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.mouse.dblclick");
  }

  async mouseDown(
    _options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
    }
  ): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.mouse.down");
  }

  async mouseMove(
    _x: number,
    _y: number,
    _options?: {
      steps?: number;
    }
  ): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.mouse.move");
  }

  async mouseUp(
    _options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
    }
  ): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.mouse.up");
  }

  async mouseWheel(_deltaX: number, _deltaY: number): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.mouse.wheel");
  }

  async touchscreenTap(_x: number, _y: number): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.touchscreen.tap");
  }

  async tap(_selector: LocatorSelector[], _options?: TapOptions): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.tap");
  }

  async bringToFront(): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "page.bringToFront");
  }

  isClosed(): boolean {
    return false;
  }

  on<K extends RawPageEventName>(_event: K, _listener: RawPageEventListener<K>): () => void {
    throw new NotImplementedInProtocolError("webdriver", `page.on(${String(_event)})`);
  }

  createHandle(reference: ProtocolElementHandleReference): ProtocolElementHandleAdapter {
    return createClassicWebDriverElementHandleAdapter(reference);
  }

  async createHandleReference(
    reference: ProtocolElementHandleReference
  ): Promise<ProtocolElementHandleReference> {
    return reference;
  }

  async query(_selector: LocatorSelector[]): Promise<ProtocolElementHandleAdapter | null> {
    throw new NotImplementedInProtocolError("webdriver", "page.$");
  }

  async queryAll(_selector: LocatorSelector[]): Promise<ProtocolElementHandleAdapter[]> {
    throw new NotImplementedInProtocolError("webdriver", "page.$$");
  }

  async evalOnSelector<TResult>(
    _selector: LocatorSelector[],
    _expression: string,
    _isFunction?: boolean,
    _arg?: unknown
  ): Promise<TResult> {
    throw new NotImplementedInProtocolError("webdriver", "page.$eval");
  }

  async evalOnSelectorAll<TResult>(
    _selector: LocatorSelector[],
    _expression: string,
    _isFunction?: boolean,
    _arg?: unknown
  ): Promise<TResult> {
    throw new NotImplementedInProtocolError("webdriver", "page.$$eval");
  }

  locator(selector: LocatorSelector): ProtocolLocatorAdapter {
    return new ClassicWebDriverLocatorAdapter(selector);
  }

  getByText(text: string | RegExp): ProtocolLocatorAdapter {
    return new ClassicWebDriverLocatorAdapter(createTextLocatorSelector(text));
  }

  getByAltText(text: string | RegExp): ProtocolLocatorAdapter {
    return new ClassicWebDriverLocatorAdapter(createAltTextLocatorSelector(text));
  }

  getByLabel(text: string | RegExp): ProtocolLocatorAdapter {
    return new ClassicWebDriverLocatorAdapter(createLabelLocatorSelector(text));
  }

  getByPlaceholder(text: string | RegExp): ProtocolLocatorAdapter {
    return new ClassicWebDriverLocatorAdapter(createPlaceholderLocatorSelector(text));
  }

  getByTestId(testId: string | RegExp): ProtocolLocatorAdapter {
    return new ClassicWebDriverLocatorAdapter(createTestIdLocatorSelector(testId));
  }

  getByRole(role: string): ProtocolLocatorAdapter {
    return new ClassicWebDriverLocatorAdapter(createRoleLocatorSelector(role));
  }

  getByTitle(text: string | RegExp): ProtocolLocatorAdapter {
    return new ClassicWebDriverLocatorAdapter(createTitleLocatorSelector(text));
  }

  async close(): Promise<void> {}
}

function createClassicWebDriverElementHandleAdapter(
  reference: ProtocolElementHandleReference
): ProtocolElementHandleAdapter {
  const notImplemented = (method: string): never => {
    throw new NotImplementedInProtocolError("webdriver", method);
  };

  return {
    reference: () => reference,
    query: async () => notImplemented("elementHandle.$"),
    queryAll: async () => notImplemented("elementHandle.$$"),
    evalOnSelector: async () => notImplemented("elementHandle.$eval"),
    evalOnSelectorAll: async () => notImplemented("elementHandle.$$eval"),
    evaluate: async () => notImplemented("elementHandle.evaluate"),
    boundingBox: async () => notImplemented("elementHandle.boundingBox"),
    click: async () => notImplemented("elementHandle.click"),
    dblclick: async () => notImplemented("elementHandle.dblclick"),
    check: async () => notImplemented("elementHandle.check"),
    hover: async () => notImplemented("elementHandle.hover"),
    fill: async () => notImplemented("elementHandle.fill"),
    type: async () => notImplemented("elementHandle.type"),
    press: async () => notImplemented("elementHandle.press"),
    textContent: async () => notImplemented("elementHandle.textContent"),
    innerText: async () => notImplemented("elementHandle.innerText"),
    innerHTML: async () => notImplemented("elementHandle.innerHTML"),
    getAttribute: async () => notImplemented("elementHandle.getAttribute"),
    inputValue: async () => notImplemented("elementHandle.inputValue"),
    isChecked: async () => notImplemented("elementHandle.isChecked"),
    isDisabled: async () => notImplemented("elementHandle.isDisabled"),
    isEditable: async () => notImplemented("elementHandle.isEditable"),
    isEnabled: async () => notImplemented("elementHandle.isEnabled"),
    isHidden: async () => notImplemented("elementHandle.isHidden"),
    isVisible: async () => notImplemented("elementHandle.isVisible"),
    focus: async () => notImplemented("elementHandle.focus"),
    uncheck: async () => notImplemented("elementHandle.uncheck"),
    selectOption: async () => notImplemented("elementHandle.selectOption")
  };
}

class ClassicWebDriverLocatorAdapter implements ProtocolLocatorAdapter {
  constructor(private readonly selector: LocatorSelector) {}

  locator(selector: LocatorSelector): ProtocolLocatorAdapter {
    void this.selector;
    return new ClassicWebDriverLocatorAdapter(selector);
  }

  getByText(text: string | RegExp): ProtocolLocatorAdapter {
    void this.selector;
    return new ClassicWebDriverLocatorAdapter(createTextLocatorSelector(text));
  }

  getByAltText(text: string | RegExp): ProtocolLocatorAdapter {
    void this.selector;
    return new ClassicWebDriverLocatorAdapter(createAltTextLocatorSelector(text));
  }

  getByLabel(text: string | RegExp): ProtocolLocatorAdapter {
    void this.selector;
    return new ClassicWebDriverLocatorAdapter(createLabelLocatorSelector(text));
  }

  getByPlaceholder(text: string | RegExp): ProtocolLocatorAdapter {
    void this.selector;
    return new ClassicWebDriverLocatorAdapter(createPlaceholderLocatorSelector(text));
  }

  getByTestId(testId: string | RegExp): ProtocolLocatorAdapter {
    void this.selector;
    return new ClassicWebDriverLocatorAdapter(createTestIdLocatorSelector(testId));
  }

  getByRole(role: string): ProtocolLocatorAdapter {
    void this.selector;
    return new ClassicWebDriverLocatorAdapter(createRoleLocatorSelector(role));
  }

  getByTitle(text: string | RegExp): ProtocolLocatorAdapter {
    void this.selector;
    return new ClassicWebDriverLocatorAdapter(createTitleLocatorSelector(text));
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

  async dblclick(): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "locator.dblclick");
  }

  async check(): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "locator.check");
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

  async focus(): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "locator.focus");
  }

  async getAttribute(_name: string): Promise<string | null> {
    throw new NotImplementedInProtocolError("webdriver", "locator.getAttribute");
  }

  async innerHTML(): Promise<string> {
    throw new NotImplementedInProtocolError("webdriver", "locator.innerHTML");
  }

  async innerText(): Promise<string> {
    throw new NotImplementedInProtocolError("webdriver", "locator.innerText");
  }

  async inputValue(): Promise<string> {
    throw new NotImplementedInProtocolError("webdriver", "locator.inputValue");
  }

  async isChecked(): Promise<boolean> {
    throw new NotImplementedInProtocolError("webdriver", "locator.isChecked");
  }

  async isDisabled(): Promise<boolean> {
    throw new NotImplementedInProtocolError("webdriver", "locator.isDisabled");
  }

  async isEditable(): Promise<boolean> {
    throw new NotImplementedInProtocolError("webdriver", "locator.isEditable");
  }

  async isEnabled(): Promise<boolean> {
    throw new NotImplementedInProtocolError("webdriver", "locator.isEnabled");
  }

  async isHidden(): Promise<boolean> {
    throw new NotImplementedInProtocolError("webdriver", "locator.isHidden");
  }

  async textContent(): Promise<string | null> {
    throw new NotImplementedInProtocolError("webdriver", "locator.textContent");
  }

  async uncheck(): Promise<void> {
    throw new NotImplementedInProtocolError("webdriver", "locator.uncheck");
  }

  async selectOption(): Promise<string[]> {
    throw new NotImplementedInProtocolError("webdriver", "locator.selectOption");
  }

  async isVisible(): Promise<boolean> {
    throw new NotImplementedInProtocolError("webdriver", "locator.isVisible");
  }

  async elementHandle(): Promise<ProtocolElementHandleAdapter> {
    throw new NotImplementedInProtocolError("webdriver", "locator.elementHandle");
  }

  async elementHandles(): Promise<ProtocolElementHandleAdapter[]> {
    throw new NotImplementedInProtocolError("webdriver", "locator.elementHandles");
  }
}
