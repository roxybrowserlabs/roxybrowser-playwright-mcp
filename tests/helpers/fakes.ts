import { vi } from "vitest";
import type {
  ProtocolBrowserAdapter,
  ProtocolBrowserContextAdapter,
  ProtocolBrowserSession,
  ProtocolLocatorAdapter,
  ProtocolPageAdapter
} from "../../src/protocol/adapter.js";
import type { ProtocolCapabilities } from "../../src/protocol/capabilities.js";
import type { PageEventListener, PageEventMap, PageEventName } from "../../src/types/events.js";

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
    newContext: vi.fn(),
    close: vi.fn(async () => {})
  };
}

export function createBrowserContextAdapterStub(): ProtocolBrowserContextAdapter {
  return {
    newPage: vi.fn(),
    close: vi.fn(async () => {})
  };
}

export function createLocatorAdapterStub(): ProtocolLocatorAdapter {
  const adapter: ProtocolLocatorAdapter = {
    locator: vi.fn(() => adapter),
    first: vi.fn(() => adapter),
    last: vi.fn(() => adapter),
    nth: vi.fn(() => adapter),
    click: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    textContent: vi.fn(async () => "text-value"),
    isVisible: vi.fn(async () => true)
  };

  return adapter;
}

export function createPageAdapterStub(): ProtocolPageAdapter & {
  emit<K extends PageEventName>(event: K, payload: PageEventMap[K]): void;
} {
  const locatorAdapter = createLocatorAdapterStub();
  const listeners = new Map<PageEventName, Set<PageEventListener<PageEventName>>>();

  return {
    goto: vi.fn(async () => {}),
    title: vi.fn(async () => "Example title"),
    content: vi.fn(async () => "<html></html>"),
    setContent: vi.fn(async () => {}),
    evaluate: vi.fn(async <TResult>() => ({ ok: true } as TResult)),
    waitForLoadState: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from("fake-screenshot")),
    on: vi.fn(<K extends PageEventName>(event: K, listener: PageEventListener<K>) => {
      const eventListeners =
        listeners.get(event) ?? new Set<PageEventListener<PageEventName>>();
      eventListeners.add(listener as PageEventListener<PageEventName>);
      listeners.set(event, eventListeners);

      return () => {
        const registeredListeners = listeners.get(event);
        registeredListeners?.delete(listener as PageEventListener<PageEventName>);
        if (registeredListeners?.size === 0) {
          listeners.delete(event);
        }
      };
    }),
    locator: vi.fn(() => locatorAdapter),
    getByText: vi.fn(() => locatorAdapter),
    getByRole: vi.fn(() => locatorAdapter),
    close: vi.fn(async () => {}),
    emit: <K extends PageEventName>(event: K, payload: PageEventMap[K]) => {
      const eventListeners = listeners.get(event);
      if (!eventListeners) {
        return;
      }

      for (const listener of Array.from(eventListeners)) {
        if (payload === undefined) {
          (listener as () => void)();
          continue;
        }

        (listener as (eventPayload: PageEventMap[K]) => void)(payload);
      }
    }
  };
}
