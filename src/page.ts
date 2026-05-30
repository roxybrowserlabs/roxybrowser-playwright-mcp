import { writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { TimeoutError } from "./errors.js";
import { DefaultHumanController } from "./human/controller.js";
import { RoxyLocator } from "./locator.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";
import type { ProtocolPageAdapter } from "./protocol/adapter.js";
import { parseSelectorChain } from "./selectors.js";
import type {
  PageEventListener,
  PageEventMap,
  PageEventName,
  PageEventPredicate,
  PageResponse
} from "./types/events.js";
import type { Locator, Page, PageNavigationResult, ResolvedAriaRef } from "./types/api.js";
import type {
  AriaSnapshotOptions,
  ClickOptions,
  FillOptions,
  GetByRoleOptions,
  GetByTextOptions,
  HoverOptions,
  PageGotoOptions,
  PressOptions,
  ScreenshotOptions,
  ScreenshotType,
  TypeOptions,
  WaitForSelectorOptions
} from "./types/options.js";

interface ListenerEntry<K extends PageEventName> {
  original: PageEventListener<K>;
  wrapped: PageEventListener<K>;
}

const DEFAULT_EVENT_TIMEOUT_MS = 30_000;

export class RoxyPage implements Page {
  private readonly humanController: DefaultHumanController;
  private readonly listeners = new Map<PageEventName, Set<ListenerEntry<PageEventName>>>();
  private readonly adapterDisposers = new Map<PageEventName, () => void>();

  constructor(
    private readonly adapter: ProtocolPageAdapter,
    humanDefaults: ResolvedHumanizationOptions
  ) {
    this.humanController = new DefaultHumanController(humanDefaults);
  }

  async goto(url: string, options?: PageGotoOptions): Promise<PageResponse | null> {
    return this.adapter.goto(url, options);
  }

  async url(): Promise<string> {
    return this.adapter.url();
  }

  async goBack(options?: PageGotoOptions): Promise<PageNavigationResult | null> {
    return this.adapter.goBack(options);
  }

  async goForward(options?: PageGotoOptions): Promise<PageNavigationResult | null> {
    return this.adapter.goForward(options);
  }

  async reload(options?: PageGotoOptions): Promise<PageResponse | null> {
    return this.adapter.reload(options);
  }

  async title(): Promise<string> {
    return this.adapter.title();
  }

  async content(): Promise<string> {
    return this.adapter.content();
  }

  async setContent(html: string): Promise<void> {
    await this.adapter.setContent(html);
  }

  async evaluate<TResult>(expression: string, arg?: unknown): Promise<TResult> {
    return this.adapter.evaluate<TResult>(expression, arg);
  }

  async waitForLoadState(state?: PageGotoOptions["waitUntil"]): Promise<void> {
    await this.adapter.waitForLoadState(state);
  }

  async waitForSelector(
    selector: string,
    options: WaitForSelectorOptions = {}
  ): Promise<Locator | null> {
    if ("waitFor" in options && options.waitFor !== undefined) {
      if (options.waitFor !== "visible") {
        throw new Error("options.waitFor is not supported, did you mean options.state?");
      }
    }

    const state = options.state ?? options.waitFor ?? "visible";
    const locator = this.locator(selector);
    const timeout = options.timeout ?? DEFAULT_EVENT_TIMEOUT_MS;
    const startTime = Date.now();

    while (Date.now() - startTime <= timeout) {
      const textContent = await locator.textContent();
      const exists = textContent !== null;
      const visible = exists ? await locator.isVisible() : false;

      if (state === "attached" && exists) {
        return locator;
      }
      if (state === "visible" && visible) {
        return locator;
      }
      if (state === "hidden" && !visible) {
        return null;
      }
      if (state === "detached" && !exists) {
        return null;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new TimeoutError(`Timeout ${timeout}ms exceeded.`);
  }

  async ariaSnapshot(options?: AriaSnapshotOptions): Promise<string> {
    return this.adapter.ariaSnapshot(options);
  }

  async resolveAriaRef(ref: string): Promise<ResolvedAriaRef> {
    return this.adapter.resolveAriaRef(ref);
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const screenshotOptions: ScreenshotOptions = options.type
      ? options
      : {
          ...options,
          type: inferScreenshotType(options.path)
        };
    const data = await this.adapter.screenshot(screenshotOptions);

    if (options.path) {
      await writeFile(options.path, data);
    }

    return data;
  }

  on<K extends PageEventName>(event: K, listener: PageEventListener<K>): this {
    const entries = this.ensureListenerSet(event);
    entries.add({
      original: listener as PageEventListener<PageEventName>,
      wrapped: listener as PageEventListener<PageEventName>
    });

    if (!this.adapterDisposers.has(event)) {
      const dispose = this.adapter.on(
        event,
        ((payload?: PageEventMap[K]) => {
          this.emit(event, payload as PageEventMap[K]);
        }) as PageEventListener<K>
      );
      this.adapterDisposers.set(event, dispose);
    }

    return this;
  }

  once<K extends PageEventName>(event: K, listener: PageEventListener<K>): this {
    const wrapped = ((payload?: PageEventMap[K]) => {
      this.removeListener(event, listener);
      if (payload === undefined) {
        (listener as () => void)();
        return;
      }

      (listener as (eventPayload: PageEventMap[K]) => void)(payload);
    }) as PageEventListener<K>;

    this.ensureListenerSet(event).add({
      original: listener as PageEventListener<PageEventName>,
      wrapped: wrapped as PageEventListener<PageEventName>
    });

    if (!this.adapterDisposers.has(event)) {
      const dispose = this.adapter.on(
        event,
        ((payload?: PageEventMap[K]) => {
          this.emit(event, payload as PageEventMap[K]);
        }) as PageEventListener<K>
      );
      this.adapterDisposers.set(event, dispose);
    }

    return this;
  }

  removeListener<K extends PageEventName>(event: K, listener: PageEventListener<K>): this {
    const entries = this.listeners.get(event);
    if (!entries) {
      return this;
    }

    for (const entry of Array.from(entries)) {
      if (entry.original === listener) {
        entries.delete(entry);
      }
    }

    if (entries.size === 0) {
      this.listeners.delete(event);
      const dispose = this.adapterDisposers.get(event);
      if (dispose) {
        this.adapterDisposers.delete(event);
        dispose();
      }
    }

    return this;
  }

  async waitForEvent<K extends PageEventName>(
    event: K,
    predicate?: PageEventPredicate<K>
  ): Promise<PageEventMap[K]> {
    return new Promise<PageEventMap[K]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener(event, listener);
        reject(new TimeoutError(`Timed out waiting for event "${String(event)}".`));
      }, DEFAULT_EVENT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener(event, listener);
      };

      const listener = (async (payload?: PageEventMap[K]) => {
        try {
          const eventPayload = payload as PageEventMap[K];
          const accepted = predicate ? await predicate(eventPayload) : true;
          if (!accepted) {
            return;
          }

          cleanup();
          resolve(eventPayload);
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }) as PageEventListener<K>;

      this.on(event, listener);
    });
  }

  locator(selector: string): Locator {
    const chain = parseSelectorChain(selector);
    const [first, ...rest] = chain;
    if (!first) {
      throw new Error("Selector must not be empty.");
    }
    let adapter = this.adapter.locator(first);
    for (const part of rest) {
      adapter = adapter.locator(part);
    }
    return new RoxyLocator(adapter, this.humanController);
  }

  getByText(text: string | RegExp, options?: GetByTextOptions): Locator {
    return new RoxyLocator(this.adapter.getByText(text, options), this.humanController);
  }

  getByRole(role: string, options?: GetByRoleOptions): Locator {
    return new RoxyLocator(this.adapter.getByRole(role, options), this.humanController);
  }

  async click(selector: string, options?: ClickOptions): Promise<void> {
    await this.locator(selector).click(options);
  }

  async hover(selector: string, options?: HoverOptions): Promise<void> {
    await this.locator(selector).hover(options);
  }

  async fill(selector: string, value: string, options?: FillOptions): Promise<void> {
    await this.locator(selector).fill(value, options);
  }

  async type(selector: string, value: string, options?: TypeOptions): Promise<void> {
    await this.locator(selector).type(value, options);
  }

  async press(selector: string, key: string, options?: PressOptions): Promise<void> {
    await this.locator(selector).press(key, options);
  }

  async close(): Promise<void> {
    await this.adapter.close();
  }

  private ensureListenerSet<K extends PageEventName>(
    event: K
  ): Set<ListenerEntry<PageEventName>> {
    const existing = this.listeners.get(event);
    if (existing) {
      return existing;
    }

    const created = new Set<ListenerEntry<PageEventName>>();
    this.listeners.set(event, created);
    return created;
  }

  private emit<K extends PageEventName>(event: K, payload: PageEventMap[K]): void {
    const entries = this.listeners.get(event);
    if (!entries) {
      return;
    }

    for (const entry of Array.from(entries)) {
      const wrapped = entry.wrapped as PageEventListener<K>;
      if (payload === undefined) {
        (wrapped as () => void)();
        continue;
      }

      (wrapped as (eventPayload: PageEventMap[K]) => void)(payload);
    }
  }
}

function inferScreenshotType(path?: string): ScreenshotType {
  if (!path) {
    return "png";
  }

  const extension = extname(path).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") {
    return "jpeg";
  }

  return "png";
}
