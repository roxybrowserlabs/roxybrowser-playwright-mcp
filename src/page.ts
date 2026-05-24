import { writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { DefaultHumanController } from "./human/controller.js";
import { RoxyLocator } from "./locator.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";
import type { ProtocolPageAdapter } from "./protocol/adapter.js";
import type {
  PageEventListener,
  PageEventMap,
  PageEventName
} from "./types/events.js";
import type { Locator, Page } from "./types/api.js";
import type {
  ClickOptions,
  FillOptions,
  GetByRoleOptions,
  GetByTextOptions,
  HoverOptions,
  PageGotoOptions,
  PressOptions,
  ScreenshotOptions,
  ScreenshotType,
  TypeOptions
} from "./types/options.js";

interface ListenerEntry<K extends PageEventName> {
  original: PageEventListener<K>;
  wrapped: PageEventListener<K>;
}

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

  async goto(url: string, options?: PageGotoOptions): Promise<void> {
    await this.adapter.goto(url, options);
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

  locator(selector: string): Locator {
    return new RoxyLocator(
      this.adapter.locator({
        strategy: "css",
        value: selector
      }),
      this.humanController
    );
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
