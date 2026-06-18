import { createSmartHandle } from "./jsHandle.js";
import type { RoxyPage } from "./page.js";
import { TimeoutError } from "./errors.js";
import type { LocatorSelector } from "./protocol/adapter.js";
import type {
  ElementArrayCallback,
  ElementCallback,
  ElementHandle,
  Frame,
  FrameLocator,
  Locator,
  PageFunction,
  SmartHandle
} from "./types/api.js";
import type {
  ClickOptions,
  FillOptions,
  PageSetContentOptions,
  PressOptions,
  TypeOptions,
  WaitForSelectorOptions
} from "./types/options.js";

export interface RoxyFrameSnapshot {
  id: string;
  name: string;
  nativeFrameId?: string;
  url: string;
  parentId: string | null;
  ownerElementChain: LocatorSelector[];
  referenceChain: LocatorSelector[];
}

export class RoxyFrame implements Frame {
  private detached = false;

  constructor(
    private readonly roxyPage: RoxyPage,
    private snapshot: RoxyFrameSnapshot
  ) {}

  setSnapshot(snapshot: RoxyFrameSnapshot): void {
    this.snapshot = snapshot;
  }

  snapshotState(): RoxyFrameSnapshot {
    return this.snapshot;
  }

  setDetached(detached: boolean): void {
    this.detached = detached;
  }

  page(): RoxyPage {
    return this.roxyPage;
  }

  isDetached(): boolean {
    return this.detached;
  }

  parentFrame(): Frame | null {
    return this.snapshot.parentId ? this.roxyPage.frameById(this.snapshot.parentId) : null;
  }

  childFrames(): Array<Frame> {
    return this.roxyPage.frames().filter((frame) => frame.parentFrame() === this);
  }

  url(): string {
    return this.snapshot.url;
  }

  name(): string {
    return this.snapshot.name;
  }

  async setContent(html: string, options?: PageSetContentOptions): Promise<void> {
    await this.evaluate((content) => {
      document.open();
      document.write(content);
      document.close();
    }, html);
    if (options?.waitUntil !== "commit") {
      await this.roxyPage.waitForLoadState(
        options?.waitUntil,
        options?.timeout === undefined ? {} : { timeout: options.timeout }
      );
    }
    await this.roxyPage.refreshFramesForExternalMutation();
  }

  async evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg): Promise<R>;
  async evaluate<R>(pageFunction: PageFunction<void, R>, arg?: any): Promise<R>;
  async evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg?: Arg): Promise<R> {
    await this.roxyPage.prepareForPendingFileChooser();
    return this.roxyPage.evaluateInFrame(this.snapshot, pageFunction, arg);
  }

  async evaluateHandle<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg): Promise<SmartHandle<R>>;
  async evaluateHandle<R>(pageFunction: PageFunction<void, R>, arg?: any): Promise<SmartHandle<R>>;
  async evaluateHandle<R, Arg>(
    pageFunction: PageFunction<Arg, R>,
    arg?: Arg
  ): Promise<SmartHandle<R>> {
    return this.roxyPage.evaluateHandleInFrame(this.snapshot, pageFunction, arg);
  }

  async waitForFunction<R, Arg>(
    pageFunction: PageFunction<Arg, R>,
    arg: Arg,
    options?: { timeout?: number; polling?: number | "raf" }
  ): Promise<SmartHandle<R>>;
  async waitForFunction<R>(
    pageFunction: PageFunction<void, R>,
    arg?: any,
    options?: { timeout?: number; polling?: number | "raf" }
  ): Promise<SmartHandle<R>>;
  async waitForFunction<R, Arg>(
    pageFunction: PageFunction<Arg, R>,
    arg?: Arg,
    options: { timeout?: number; polling?: number | "raf" } = {}
  ): Promise<SmartHandle<R>> {
    const timeout = options.timeout ?? this.roxyPage.defaultTimeout();
    const polling = options.polling ?? "raf";
    if (polling !== "raf" && typeof polling !== "number") {
      throw new Error(`Unknown polling option: ${String(polling)}`);
    }
    if (typeof polling === "number" && polling <= 0) {
      throw new Error("Cannot poll with non-positive interval");
    }

    const start = Date.now();
    while (timeout === 0 || Date.now() - start <= timeout) {
      const result = await this.roxyPage.evaluateInFrame(this.snapshot, pageFunction, arg);
      if (result) {
        return createSmartHandle(result);
      }
      await new Promise((resolve) => setTimeout(resolve, polling === "raf" ? 16 : polling));
    }

    throw new TimeoutError(`frame.waitForFunction: Timeout ${timeout}ms exceeded.`);
  }

  async waitForSelector(
    selector: string,
    options: WaitForSelectorOptions = {}
  ): Promise<ElementHandle | null> {
    const timeout = options.timeout ?? this.roxyPage.defaultTimeout();
    const state = options.state ?? options.waitFor ?? "visible";
    const startTime = Date.now();

    while (Date.now() - startTime <= timeout) {
      const handle = await this.$(selector);
      const visible = handle ? await handle.isVisible() : false;

      if (state === "attached" && handle) {
        return handle;
      }
      if (state === "visible" && visible && handle) {
        return handle;
      }
      if (state === "hidden" && !visible) {
        return null;
      }
      if (state === "detached" && !handle) {
        return null;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new TimeoutError(`Timeout ${timeout}ms exceeded.`);
  }

  async $(selector: string): Promise<ElementHandle | null> {
    return this.roxyPage.queryInFrame(this.snapshot, selector);
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    return this.roxyPage.queryAllInFrame(this.snapshot, selector);
  }

  async $eval<TResult, TArg = unknown>(
    selector: string,
    pageFunction: string | ElementCallback<TResult, TArg>,
    arg?: TArg
  ): Promise<TResult> {
    return this.roxyPage.evalOnSelectorInFrame(
      this.snapshot,
      selector,
      pageFunction,
      arg
    );
  }

  async $$eval<TResult, TArg = unknown>(
    selector: string,
    pageFunction: string | ElementArrayCallback<TResult, TArg>,
    arg?: TArg
  ): Promise<TResult> {
    return this.roxyPage.evalOnSelectorAllInFrame(
      this.snapshot,
      selector,
      pageFunction,
      arg
    );
  }

  locator(selector: string): Locator {
    return this.roxyPage.locatorInFrame(this.snapshot, selector);
  }

  frameLocator(selector: string): FrameLocator {
    return this.locator(selector).contentFrame();
  }

  getByText(text: string | RegExp, options?: Parameters<RoxyPage["getByText"]>[1]): Locator {
    return this.roxyPage.getByTextInFrame(this.snapshot, text, options);
  }

  getByAltText(text: string | RegExp, options?: Parameters<RoxyPage["getByAltText"]>[1]): Locator {
    return this.roxyPage.getByAltTextInFrame(this.snapshot, text, options);
  }

  getByLabel(text: string | RegExp, options?: Parameters<RoxyPage["getByLabel"]>[1]): Locator {
    return this.roxyPage.getByLabelInFrame(this.snapshot, text, options);
  }

  getByPlaceholder(
    text: string | RegExp,
    options?: Parameters<RoxyPage["getByPlaceholder"]>[1]
  ): Locator {
    return this.roxyPage.getByPlaceholderInFrame(this.snapshot, text, options);
  }

  getByTestId(testId: string | RegExp): Locator {
    return this.roxyPage.getByTestIdInFrame(this.snapshot, testId);
  }

  getByRole(role: string, options?: Parameters<RoxyPage["getByRole"]>[1]): Locator {
    return this.roxyPage.getByRoleInFrame(this.snapshot, role, options);
  }

  getByTitle(text: string | RegExp, options?: Parameters<RoxyPage["getByTitle"]>[1]): Locator {
    return this.roxyPage.getByTitleInFrame(this.snapshot, text, options);
  }

  async content(): Promise<string> {
    return this.evaluate(() => {
      const doctype = document.doctype
        ? new XMLSerializer().serializeToString(document.doctype)
        : "";
      return doctype + document.documentElement.outerHTML;
    });
  }

  async click(selector: string, options?: ClickOptions): Promise<void> {
    await this.roxyPage.prepareForPendingFileChooser();
    await this.locator(selector).click(options);
  }

  async dblclick(selector: string, options?: ClickOptions): Promise<void> {
    await this.locator(selector).dblclick(options);
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
}
