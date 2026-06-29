import { vi } from "vitest";
import { createPageResponse } from "../../src/pageResponse.js";
import { RoxyBrowser } from "../../src/browser.js";
import type { BrowserType } from "../../src/types/api.js";
import type {
  ProtocolBrowserAdapter,
  ProtocolBrowserContextAdapter,
  ProtocolBrowserSession,
  ProtocolElementHandleAdapter,
  ProtocolLocatorAdapter,
  ProtocolPageAdapter
} from "../../src/protocol/adapter.js";
import type { ProtocolCapabilities } from "../../src/protocol/capabilities.js";
import type { ResolvedHumanizationOptions } from "../../src/human/types.js";
import type {
  RawPageEventListener,
  RawPageEventMap,
  RawPageEventName
} from "../../src/types/events.js";

const capabilities: ProtocolCapabilities = {
  protocol: "cdp",
  supportsMultipleContexts: true,
  supportsIsolatedWorlds: true,
  supportsLocatorChaining: true,
  supportsInputDispatch: true,
  supportsDownloads: true,
  supportsTracing: true
};

export function createBrowserAdapterStub(): ProtocolBrowserAdapter {
  return {
    protocol: "cdp",
    capabilities,
    connect: vi.fn(async () => {}),
    browser: vi.fn(),
    close: vi.fn(async () => {})
  };
}

export function createBrowserSessionStub(): ProtocolBrowserSession {
  return {
    version: vi.fn(async () => "Chrome/123.0.0.0"),
    newContext: vi.fn(async () => createBrowserContextAdapterStub()),
    close: vi.fn(async () => {})
  };
}

export const DEFAULT_HUMAN_OPTIONS: ResolvedHumanizationOptions = {
  profile: "balanced",
  moveJitterMs: 140,
  clickHoldMs: 180,
  scrollStepPx: 180,
  typingDelayMs: 140,
  typingVarianceMs: 55,
  hoverBeforeClickMs: 380
};

interface CreateBrowserOptions {
  session?: ProtocolBrowserSession;
  adapter?: ProtocolBrowserAdapter;
  humanDefaults?: ResolvedHumanizationOptions;
  browserName?: "chromium" | "firefox";
  browserType?: BrowserType;
  version?: string;
}

export function createBrowser(options: CreateBrowserOptions = {}): RoxyBrowser {
  return new RoxyBrowser(
    options.session ?? createBrowserSessionStub(),
    options.adapter ?? createBrowserAdapterStub(),
    options.humanDefaults ?? DEFAULT_HUMAN_OPTIONS,
    options.browserName ?? "chromium",
    options.browserType ?? ({} as BrowserType),
    options.version ?? "Chrome/123.0.0.0"
  );
}

export function createBrowserContextAdapterStub(): ProtocolBrowserContextAdapter & {
  emitPage(page: ProtocolPageAdapter, opener?: ProtocolPageAdapter | null): Promise<void>;
} {
  const pageListeners = new Set<
    (page: ProtocolPageAdapter, opener?: ProtocolPageAdapter | null) => void | Promise<void>
  >();
  const initScriptDisposable = {
    dispose: vi.fn(async () => {})
  };

  return {
    newPage: vi.fn(),
    addInitScript: vi.fn(async () => initScriptDisposable),
    onPage: vi.fn((listener) => {
      pageListeners.add(listener);
      return () => {
        pageListeners.delete(listener);
      };
    }),
    setExtraHTTPHeaders: vi.fn(async () => {}),
    close: vi.fn(async (_options) => {}),
    emitPage: async (page: ProtocolPageAdapter, opener?: ProtocolPageAdapter | null) => {
      for (const listener of Array.from(pageListeners)) {
        await listener(page, opener);
      }
    }
  };
}

export function createLocatorAdapterStub(): ProtocolLocatorAdapter {
  const adapter: ProtocolLocatorAdapter = {
    locator: vi.fn(() => adapter),
    getByText: vi.fn(() => adapter),
    getByAltText: vi.fn(() => adapter),
    getByLabel: vi.fn(() => adapter),
    getByPlaceholder: vi.fn(() => adapter),
    getByTestId: vi.fn(() => adapter),
    getByRole: vi.fn(() => adapter),
    getByTitle: vi.fn(() => adapter),
    first: vi.fn(() => adapter),
    last: vi.fn(() => adapter),
    nth: vi.fn(() => adapter),
    dblclick: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
    tap: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    focus: vi.fn(async () => {}),
    blur: vi.fn(async () => {}),
    count: vi.fn(async () => 1),
    dispatchEvent: vi.fn(async () => {}),
    getAttribute: vi.fn(async () => "attr-value"),
    innerHTML: vi.fn(async () => "<span>html-value</span>"),
    innerText: vi.fn(async () => "inner-text-value"),
    inputValue: vi.fn(async () => "input-value"),
    isChecked: vi.fn(async () => true),
    isDisabled: vi.fn(async () => false),
    isEditable: vi.fn(async () => true),
    isEnabled: vi.fn(async () => true),
    isHidden: vi.fn(async () => false),
    selectOption: vi.fn(async () => ["selected-value"]),
    textContent: vi.fn(async () => "text-value"),
    uncheck: vi.fn(async () => {}),
    isVisible: vi.fn(async () => true),
    elementHandle: vi.fn(async () => createElementHandleAdapterStub()),
    elementHandles: vi.fn(async () => [createElementHandleAdapterStub()])
  };

  return adapter;
}

export function createElementHandleAdapterStub(): ProtocolElementHandleAdapter {
  const adapter: ProtocolElementHandleAdapter = {
    reference: vi.fn(() => ({
      chain: [{ strategy: "css", value: ".handle" }],
      pick: { kind: "first" }
    })),
    query: vi.fn(async () => adapter),
    queryAll: vi.fn(async () => [adapter]),
    evalOnSelector: vi.fn(async <TResult>() => "selector-value" as TResult),
    evalOnSelectorAll: vi.fn(async <TResult>() => ["selector-value"] as TResult),
    evaluate: vi.fn(async <TResult>() => "handle-value" as TResult),
    boundingBox: vi.fn(async () => ({ x: 1, y: 2, width: 3, height: 4 })),
    dispatchEvent: vi.fn(async () => {}),
    dblclick: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
    tap: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    focus: vi.fn(async () => {}),
    getAttribute: vi.fn(async () => "handle-attr"),
    innerHTML: vi.fn(async () => "<div>handle-html</div>"),
    innerText: vi.fn(async () => "handle-inner-text"),
    inputValue: vi.fn(async () => "handle-input"),
    isChecked: vi.fn(async () => true),
    isDisabled: vi.fn(async () => false),
    isEditable: vi.fn(async () => true),
    isEnabled: vi.fn(async () => true),
    isHidden: vi.fn(async () => false),
    selectOption: vi.fn(async () => ["handle-selected"]),
    textContent: vi.fn(async () => "handle-text"),
    uncheck: vi.fn(async () => {}),
    isVisible: vi.fn(async () => true)
  };

  return adapter;
}

export function createPageAdapterStub(): ProtocolPageAdapter & {
  emit<K extends RawPageEventName>(event: K, payload: RawPageEventMap[K]): void;
  emitFileChooserOpened(payload: {
    element: {
      chain: [];
      handleId: string;
    };
    frameId: string | null;
    isMultiple: boolean;
  }): Promise<void>;
  initScriptDisposables: Array<{ dispose: ReturnType<typeof vi.fn> }>;
} {
  const locatorAdapter = createLocatorAdapterStub();
  const elementHandleAdapter = createElementHandleAdapterStub();
  const listeners = new Map<RawPageEventName, Set<RawPageEventListener<RawPageEventName>>>();
  const fileChooserOpenedListeners = new Set<
    NonNullable<ProtocolPageAdapter["onFileChooserOpened"]> extends (listener: infer T) => () => void ? T : never
  >();
  const initScriptDisposables: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];

  return {
    goto: vi.fn(
      async () =>
        createPageResponse({
          fromCache: false,
          headers: [],
          mimeType: "text/html",
          status: 200,
          statusText: "OK",
          text: async () => "<html>example</html>",
          url: "https://example.com"
        })
    ),
    url: vi.fn(() => "https://example.com"),
    goBack: vi.fn(
      async () =>
        createPageResponse({
          fromCache: false,
          headers: [],
          mimeType: "text/html",
          status: 200,
          statusText: "OK",
          text: async () => "<html>back</html>",
          url: "https://example.com/back"
        })
    ),
    goForward: vi.fn(
      async () =>
        createPageResponse({
          fromCache: false,
          headers: [],
          mimeType: "text/html",
          status: 200,
          statusText: "OK",
          text: async () => "<html>forward</html>",
          url: "https://example.com/forward"
        })
    ),
    reload: vi.fn(
      async () =>
        createPageResponse({
          fromCache: false,
          headers: [],
          mimeType: "text/html",
          status: 200,
          statusText: "OK",
          text: async () => "<html>reloaded</html>",
          url: "https://example.com/reload"
        })
    ),
    title: vi.fn(async () => "Example title"),
    content: vi.fn(async () => "<html></html>"),
    setContent: vi.fn(async () => {}),
    addInitScript: vi.fn(async () => {
      const disposable = {
        dispose: vi.fn(async () => {})
      };
      initScriptDisposables.push(disposable);
      return disposable;
    }),
    evaluate: vi.fn(async <TResult>() => ({ ok: true } as TResult)),
    addScriptTag: vi.fn(async () => elementHandleAdapter),
    addStyleTag: vi.fn(async () => elementHandleAdapter),
    waitForLoadState: vi.fn(async () => {}),
    onFileChooserOpened: vi.fn((listener) => {
      fileChooserOpenedListeners.add(listener);
      return () => {
        fileChooserOpenedListeners.delete(listener);
      };
    }),
    ariaSnapshot: vi.fn(async () => '- document\n  - button "Example"'),
    resolveAriaRef: vi.fn(async (ref: string) => ({
      ref,
      selector: "#example",
      xpath: '//*[@id="example"]',
      querySelector: 'document.querySelector("#example")',
      querySelectorChain: 'document.querySelector("#example")',
      framePath: [],
      inShadowTree: false
    })),
    setExtraHTTPHeaders: vi.fn(async () => {}),
    setScreenshotBackgroundColor: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from("fake-screenshot")),
    pdf: vi.fn(async () => Buffer.from("%PDF-fake")),
    viewportSize: vi.fn(() => ({ width: 1280, height: 720 })),
    setViewportSize: vi.fn(async () => {}),
    emulateMedia: vi.fn(async () => {}),
    dispatchEvent: vi.fn(async () => {}),
    requestGC: vi.fn(async () => {}),
    textContent: vi.fn(async () => "page-text-content"),
    innerText: vi.fn(async () => "page-inner-text"),
    innerHTML: vi.fn(async () => "<main>page-inner-html</main>"),
    getAttribute: vi.fn(async () => "page-attr"),
    inputValue: vi.fn(async () => "page-input"),
    isChecked: vi.fn(async () => true),
    isDisabled: vi.fn(async () => false),
    isEditable: vi.fn(async () => true),
    isEnabled: vi.fn(async () => true),
    focus: vi.fn(async () => {}),
    setChecked: vi.fn(async () => {}),
    selectOption: vi.fn(async () => ["page-selected"]),
    bringToFront: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
    on: vi.fn(<K extends RawPageEventName>(event: K, listener: RawPageEventListener<K>) => {
      const eventListeners =
        listeners.get(event) ?? new Set<RawPageEventListener<RawPageEventName>>();
      eventListeners.add(listener as RawPageEventListener<RawPageEventName>);
      listeners.set(event, eventListeners);

      return () => {
        const registeredListeners = listeners.get(event);
        registeredListeners?.delete(listener as RawPageEventListener<RawPageEventName>);
        if (registeredListeners?.size === 0) {
          listeners.delete(event);
        }
      };
    }),
    createHandle: vi.fn(() => elementHandleAdapter),
    createHandleReference: vi.fn(async (reference) => reference),
    evaluateOnReference: vi.fn(async <TResult>() => "page-selector-value" as TResult),
    evaluateOnReferenceAll: vi.fn(async <TResult>() => ["page-selector-value"] as TResult),
    query: vi.fn(async () => elementHandleAdapter),
    queryAll: vi.fn(async () => [elementHandleAdapter]),
    evalOnSelector: vi.fn(async <TResult>() => "page-selector-value" as TResult),
    evalOnSelectorAll: vi.fn(async <TResult>() => ["page-selector-value"] as TResult),
    locator: vi.fn(() => locatorAdapter),
    getByText: vi.fn(() => locatorAdapter),
    getByAltText: vi.fn(() => locatorAdapter),
    getByLabel: vi.fn(() => locatorAdapter),
    getByPlaceholder: vi.fn(() => locatorAdapter),
    getByTestId: vi.fn(() => locatorAdapter),
    getByRole: vi.fn(() => locatorAdapter),
    getByTitle: vi.fn(() => locatorAdapter),
    startCSSCoverage: vi.fn(async () => {}),
    startJSCoverage: vi.fn(async () => {}),
    stopCSSCoverage: vi.fn(async () => []),
    stopJSCoverage: vi.fn(async () => []),
    screencastStart: vi.fn(async () => {}),
    screencastStop: vi.fn(async () => {}),
    screencastShowActions: vi.fn(async () => {}),
    screencastHideActions: vi.fn(async () => {}),
    screencastShowOverlay: vi.fn(async () => ({ id: "overlay-1" })),
    screencastRemoveOverlay: vi.fn(async () => {}),
    screencastChapter: vi.fn(async () => {}),
    screencastSetOverlayVisible: vi.fn(async () => {}),
    keyboardDown: vi.fn(async () => {}),
    keyboardInsertText: vi.fn(async () => {}),
    keyboardPress: vi.fn(async () => {}),
    keyboardType: vi.fn(async () => {}),
    keyboardUp: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
    mouseDblclick: vi.fn(async () => {}),
    mouseDown: vi.fn(async () => {}),
    mouseMove: vi.fn(async () => {}),
    mouseUp: vi.fn(async () => {}),
    mouseWheel: vi.fn(async () => {}),
    touchscreenTap: vi.fn(async () => {}),
    tap: vi.fn(async () => {}),
    close: vi.fn(async (_options) => {}),
    emit: <K extends RawPageEventName>(event: K, payload: RawPageEventMap[K]) => {
      const eventListeners = listeners.get(event);
      if (!eventListeners) {
        return;
      }

      for (const listener of Array.from(eventListeners)) {
        if (payload === undefined) {
          (listener as () => void)();
          continue;
        }

        (listener as (eventPayload: RawPageEventMap[K]) => void)(payload);
      }
    },
    emitFileChooserOpened: async (payload) => {
      for (const listener of Array.from(fileChooserOpenedListeners)) {
        await listener(payload);
      }
    },
    initScriptDisposables
  };
}
